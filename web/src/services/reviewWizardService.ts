/**
 * 周回顾向导服务（v2.13 R5）。
 *
 * 分工：
 * - 判定规则全在 `lib/review-wizard.ts`（纯函数）；
 * - 本文件只做 IO：读进度、存进度、收集各步数据、AI 建议、完成落库。
 *
 * 硬约束（设计 §8-7）：`settings` 只有一条写入口 —— 必须走
 * `profileService.getSettings()` / `profileService.save(id, patch)`（与 `float_position` 同路径），
 * **禁止**在这里 `cloud.database.from('settings')` 直连（会绕过「有 id 则 update、无则 insert」逻辑，
 * 撞 owner_id 唯一约束 23505）。
 */

import { recordService } from '@/services/recordService'
import { aiService } from '@/services/aiService'
import { profileService } from '@/services/profileService'
import type { InfoRecord, ReviewWizardProgress } from '@shared/types/domain'
import {
  FOCUS_COUNT,
  buildReviewNoteBody,
  emptyProgress,
  normalizeProgress,
  pickCategories,
  pickInbox,
  pickStaleCategories,
  pickWaiting,
  reviewNoteTitle,
} from '@/lib/review-wizard'

/** 第 4 步取数窗口：最近 90 天更新过的记录（足够覆盖 14 天阈值）。 */
const HEALTH_WINDOW_DAYS = 90
/** 待办拉取上限（与 TodoPage 分页一致）。 */
const TODO_PAGE_SIZE = 200

/** 5 步所需的数据快照。 */
export interface WizardStepData {
  inbox: InfoRecord[]
  categories: string[]
  waiting: InfoRecord[]
  staleCategories: string[]
  weekRecords: InfoRecord[]
}

/** 完成落库的统计入参。 */
export interface WizardFinishStats {
  inbox: number
  waiting: number
  stale: string[]
  aiSummary: string | null
  aiFailed: boolean
}

/** 把 'YYYY-MM-DD' 本地日转成当天 00:00 的 Date（本地时区）。 */
function dayKeyToLocalDate(dayKey: string): Date {
  const [y, m, d] = dayKey.split('-').map((n) => Number.parseInt(n, 10))
  return new Date(y, (m ?? 1) - 1, d ?? 1, 0, 0, 0, 0)
}

/** 把整份进度写回 `settings.review_wizard`（settings 唯一写入口见文件头）。 */
async function persistProgress(
  progress: ReviewWizardProgress,
  settingsId: number | null,
): Promise<number | null> {
  return profileService.save(settingsId, { review_wizard: progress })
}

/**
 * 尽力回写进度：失败不抛（回顾记录已经落库，不能因为 settings 写失败就让用户以为整轮失败）。
 * `settingsId` 为空时跳过——避免在「无 settings 行」时插一条空行（23505 风险，见文件头）。
 */
async function saveQuietly(progress: ReviewWizardProgress, settingsId: number | null): Promise<void> {
  if (settingsId == null) return
  try {
    await persistProgress({ ...progress }, settingsId)
  } catch {
    /* 忽略回写失败 */
  }
}

/**
 * **两级完成标记（`finish()` 幂等的唯一依据，跨会话成立、不依赖内存状态）**
 *
 * - `progress.completedRecordId != null` → **回顾记录已建**；此时 `completedAt == null`
 *   表示「回顾已建但焦点待办没走完」，重试时**只补待办、不重铸回顾**；
 * - `progress.completedAt != null` → **整轮走完**，真空操作直接返回既有 id。
 * - 因此「有此字段即零写入」只对 `completedAt` 成立，对 `completedRecordId` **不成立**
 *   ——这不是矛盾，是两级语义。
 */

/**
 * 按第 5 步焦点创建高优先级待办（最多 `FOCUS_COUNT` 条，跳过空白）。
 *
 * ⚠️ 重试语义是「整体重补」：若上一次只建了其中一部分，重试会把剩下的一起再建一遍，
 * 可能出现同名重复待办（最多 3 条，用户可见可删）。这样换的是「回顾记录绝不重复」。
 *
 * @param progress 进度
 */
async function createFocusTodos(progress: ReviewWizardProgress): Promise<void> {
  const focus = progress.focus.map((f) => f.trim()).filter(Boolean).slice(0, FOCUS_COUNT)
  for (const text of focus) {
    await recordService.createRecord({
      type: 'todo',
      title: text,
      content: '',
      priority: 'high',
      todoStatus: 'pending',
    })
  }
}

export const reviewWizardService = {
  /**
   * 读取进行中的向导进度。
   *
   * @returns 进度（脏数据/无进度时 null）与 settings 行 id（无行时 null）
   */
  async load(): Promise<{ progress: ReviewWizardProgress | null; settingsId: number | null }> {
    const row = await profileService.getSettings()
    if (!row) return { progress: null, settingsId: null }
    return { progress: normalizeProgress(row.review_wizard), settingsId: row.id ?? null }
  },

  /**
   * 保存进度（每次「下一步 / 暂时离开」都写整份 progress）。
   *
   * @returns settings 行 id（后续 save/clear 复用）
   */
  async save(progress: ReviewWizardProgress, settingsId: number | null): Promise<number | null> {
    return persistProgress(progress, settingsId)
  },

  /** 清空进度（完成后 / 用户放弃）。 */
  async clear(settingsId: number | null): Promise<void> {
    if (!settingsId) return
    await profileService.save(settingsId, { review_wizard: null })
  },

  /**
   * 收集 5 步所需的数据。
   *
   * - 第 1/2 步：本周期（本周一 → 现在）新增记录，与回顾页 `listByRange` 同口径；
   * - 第 3 步：全部未完成待办（某天 ∪ 逾期）；
   * - 第 4 步：最近 90 天更新过的记录，取「分类内最晚更新」超 14 天者。
   *
   * @param progress 当前进度（用其 `weekStart` 作为本周期起点）
   * @param nowMs 当前时刻（epoch ms），默认取运行时
   */
  async collect(progress: ReviewWizardProgress, nowMs: number = Date.now()): Promise<WizardStepData> {
    const weekStartDate = dayKeyToLocalDate(progress.weekStart)
    const nowIso = new Date(nowMs).toISOString()
    const healthSince = new Date(nowMs - HEALTH_WINDOW_DAYS * 86_400_000).toISOString()

    const [weekRecords, todoResult, recentRecords] = await Promise.all([
      recordService.listByRange(weekStartDate.toISOString(), nowIso),
      recordService.listRecords({ type: 'todo', isDeleted: false, page: 1, pageSize: TODO_PAGE_SIZE }),
      recordService.listByUpdatedSince(healthSince),
    ])

    const pendingTodos = todoResult.records.filter((r) => r.todoStatus !== 'done')

    return {
      inbox: pickInbox(weekRecords),
      categories: pickCategories(weekRecords),
      waiting: pickWaiting(pendingTodos, nowMs),
      staleCategories: pickStaleCategories(recentRecords, nowMs),
      weekRecords,
    }
  },

  /**
   * AI 建议（可整步失败，调用方据此降级为纯本地流程）。
   *
   * @param weekRecords 本周期记录
   * @returns 摘要（失败时 null）与是否失败
   */
  async suggest(weekRecords: InfoRecord[]): Promise<{ summary: string | null; failed: boolean }> {
    if (weekRecords.length === 0) return { summary: null, failed: false }
    try {
      const result = await aiService.generateReview(weekRecords)
      const summary = (result.summary ?? '').trim()
      return { summary: summary || null, failed: false }
    } catch {
      // 只降级不阻断（设计 §8-5）：向导仍可走完、记录照常落库
      return { summary: null, failed: true }
    }
  },

  /**
   * 完成向导：落 1 条回顾记录 + 按第 5 步焦点创建待办。
   *
   * - 回顾记录用 `type='idea'`（`records.type` 的 CHECK 只允许 idea/material/todo，
   *   不新增 enum 值，见 DESIGN §0-D4 与 §9-9）；
   * - 第 2 步的 next_action **只写正文**，不创建待办（只有第 5 步有副作用）；
   * - **幂等（v2.13 修订）**：入口校验 `completedRecordId`；回顾记录落库后**立即**把
   *   `completedRecordId` / `completedAt` 写回**传入的 progress 对象**并落 settings，
   *   再创建焦点待办；出口再校验一次（设计 §1.5「前后各校验一次」）。
   *   于是「回顾已建、焦点待办创建失败 → 用户重试」只会补待办，不会重复落第二条回顾记录。
   *
   * @param progress 进度（**会被就地打上完成标记**，调用方无需自行回写）
   * @param stats 各步统计
   * @param settingsId settings 行 id（回写用；不传则只回写内存中的 progress）
   * @returns 回顾记录 id
   */
  async finish(
    progress: ReviewWizardProgress,
    stats: WizardFinishStats,
    settingsId: number | null = null,
  ): Promise<number> {
    // 入口校验（一）：回顾记录已建
    if (progress.completedRecordId != null) {
      const doneId = progress.completedRecordId
      // 整轮已走完 → 真正的空操作（重复点击 / 跨会话重放都不会再落库）
      if (progress.completedAt) return doneId
      // 上次卡在建焦点待办（回顾记录已建、completedAt 为空）→ 只补待办
      await createFocusTodos(progress)
      progress.completedAt = new Date().toISOString()
      await saveQuietly(progress, settingsId)
      return doneId
    }

    const body = buildReviewNoteBody(progress, stats)
    const created = await recordService.createRecord({
      type: 'idea',
      title: reviewNoteTitle(progress.weekStart),
      content: body,
    })

    // 先落「回顾记录已建」，再建焦点待办：后面任一步失败，重试都能被入口校验认出来
    progress.completedRecordId = created.id
    await saveQuietly(progress, settingsId)

    // 第 5 步：把焦点写成高优先级待办（改动会影响待办总数，完成提示里已说明）
    await createFocusTodos(progress)

    // 最后落「整轮走完」；出口再校验一次（设计 §1.5「前后各校验一次」）
    progress.completedAt = new Date().toISOString()
    await saveQuietly(progress, settingsId)
    return progress.completedRecordId ?? created.id
  },

  /** 新建一份空进度（供页面在无进度时开始向导）。 */
  start(nowMs: number = Date.now()): ReviewWizardProgress {
    return emptyProgress(nowMs)
  },
}
