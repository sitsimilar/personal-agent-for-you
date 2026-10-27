/**
 * GTD 周回顾向导纯函数（v2.13 R5）。
 *
 * 全部判定都在前端本地完成（收件箱、等待中、14 天健康），AI 只负责「摘要 + 建议」，
 * 且允许整步失败。本文件**不碰网络/DOM、不读 `Date.now()`**（`nowMs` 由调用方注入），
 * 因此所有规则都可重放单测。
 *
 * 时间口径照抄 `lib/todo-segments.ts` / `lib/recurrence.ts`：
 * 库里一律 UTC ISO，本地日判定用「注入 `tzOffsetMinutes` + 平移轴」写法，
 * 等待中的「逾期」与待办三段视图共用 `localDayStartMs`，避免两套日期语义。
 */

import type {
  InfoRecord,
  ReviewWizardInboxItem,
  ReviewWizardNextAction,
  ReviewWizardProgress,
  ReviewWizardStep,
  ReviewWizardWaitingItem,
} from '@shared/types/domain'
import { bucketTodo, localDayStartMs, localTzOffsetMinutes } from '@/lib/todo-segments'

/** 第 5 步「下周三件事」的条数。 */
export const FOCUS_COUNT = 3
/** 第 4 步「项目健康」的搁置阈值（天）。 */
export const STALE_DAYS = 14
/** 进度有效期（24 小时）：超过则提示「上次回顾已过期」。 */
export const PROGRESS_TTL_MS = 24 * 60 * 60 * 1000
/** 一天的毫秒数（中国无 DST，本地日平移不需要额外校正）。 */
const MS_PER_DAY = 86_400_000

/** 两位补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * 本周一的本地日 `'YYYY-MM-DD'`（周一为一周起点）。
 *
 * @param nowMs 当前时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function isoWeekStart(nowMs: number, tzOffsetMinutes?: number): string {
  const tz = typeof tzOffsetMinutes === 'number' ? tzOffsetMinutes : localTzOffsetMinutes()
  const wall = new Date(nowMs + tz * 60_000)
  const dow = (wall.getUTCDay() + 6) % 7 // 周一 = 0
  const mondayShifted = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate()) - dow * MS_PER_DAY
  const monday = new Date(mondayShifted)
  return `${monday.getUTCFullYear()}-${pad2(monday.getUTCMonth() + 1)}-${pad2(monday.getUTCDate())}`
}

/**
 * 新建一份空进度（第 1 步）。
 *
 * @param nowMs 当前时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function emptyProgress(nowMs: number, tzOffsetMinutes?: number): ReviewWizardProgress {
  const iso = new Date(nowMs).toISOString()
  return {
    version: 1,
    step: 1,
    weekStart: isoWeekStart(nowMs, tzOffsetMinutes),
    startedAt: iso,
    updatedAt: iso,
    completedAt: null,
    completedRecordId: null,
    inbox: [],
    nextActions: [],
    waiting: [],
    health: [],
    focus: Array.from({ length: FOCUS_COUNT }, () => ''),
    aiFailed: false,
  }
}

/** 步骤号归一（1..5，非法回落到 1）。 */
function normalizeStep(value: unknown): ReviewWizardStep {
  const n = typeof value === 'number' ? Math.floor(value) : Number.NaN
  if (n === 2 || n === 3 || n === 4 || n === 5) return n
  return 1
}

/** 合法的本地日字符串。 */
function isDayKey(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value.trim())
}

/** 非空字符串或 null。 */
function asIso(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null
  return Number.isNaN(Date.parse(value)) ? null : value
}

/** 收件箱条目归一。 */
function normalizeInbox(raw: unknown): ReviewWizardInboxItem[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewWizardInboxItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as { recordId?: unknown; decision?: unknown; category?: unknown }
    const recordId = Number(obj.recordId)
    if (!Number.isInteger(recordId) || recordId <= 0) continue
    const decision = obj.decision === 'assign' || obj.decision === 'archive' ? obj.decision : 'skip'
    const category = typeof obj.category === 'string' && obj.category.trim() ? obj.category.trim() : null
    out.push({ recordId, decision, category })
  }
  return out
}

/** 下一步行动归一。 */
function normalizeNextActions(raw: unknown): ReviewWizardNextAction[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewWizardNextAction[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as { category?: unknown; text?: unknown }
    const category = typeof obj.category === 'string' ? obj.category.trim() : ''
    const text = typeof obj.text === 'string' ? obj.text.trim() : ''
    if (!text) continue
    out.push({ category, text })
  }
  return out
}

/** 等待中条目归一。 */
function normalizeWaiting(raw: unknown): ReviewWizardWaitingItem[] {
  if (!Array.isArray(raw)) return []
  const out: ReviewWizardWaitingItem[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as { recordId?: unknown; decision?: unknown }
    const recordId = Number(obj.recordId)
    if (!Number.isInteger(recordId) || recordId <= 0) continue
    const decision = obj.decision === 'keep' || obj.decision === 'delete' ? obj.decision : 'skip'
    out.push({ recordId, decision })
  }
  return out
}

/** 健康检查条目归一。 */
function normalizeHealth(raw: unknown): Array<{ category: string; acknowledged: boolean }> {
  if (!Array.isArray(raw)) return []
  const out: Array<{ category: string; acknowledged: boolean }> = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const obj = item as { category?: unknown; acknowledged?: unknown }
    const category = typeof obj.category === 'string' ? obj.category.trim() : ''
    if (!category) continue
    out.push({ category, acknowledged: obj.acknowledged === true })
  }
  return out
}

/** 焦点归一：固定 3 条（不足补空串，多余的丢弃）。 */
function normalizeFocus(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : []
  const out: string[] = []
  for (let i = 0; i < FOCUS_COUNT; i++) {
    const value = list[i]
    out.push(typeof value === 'string' ? value.trim() : '')
  }
  return out
}

/**
 * 归一化 `settings.review_wizard` 的脏数据（JSONB 可能是对象、JSON 字符串或任意脏值）。
 *
 * @param raw 原始值
 * @returns 合法进度；核心字段（weekStart / updatedAt）不合法时返回 null（视为无进度）
 */
export function normalizeProgress(raw: unknown): ReviewWizardProgress | null {
  let value: unknown = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (!value || typeof value !== 'object') return null
  const obj = value as Record<string, unknown>
  const weekStart = isDayKey(obj.weekStart) ? obj.weekStart.trim() : null
  const updatedAt = asIso(obj.updatedAt)
  if (!weekStart || !updatedAt) return null
  const startedAt = asIso(obj.startedAt) ?? updatedAt
  const completedAt = asIso(obj.completedAt)
  const recordIdRaw = Number(obj.completedRecordId)
  const completedRecordId =
    Number.isInteger(recordIdRaw) && recordIdRaw > 0 ? recordIdRaw : null
  return {
    version: 1,
    step: normalizeStep(obj.step),
    weekStart,
    startedAt,
    updatedAt,
    completedAt,
    completedRecordId,
    inbox: normalizeInbox(obj.inbox),
    nextActions: normalizeNextActions(obj.nextActions),
    waiting: normalizeWaiting(obj.waiting),
    health: normalizeHealth(obj.health),
    focus: normalizeFocus(obj.focus),
    aiFailed: obj.aiFailed === true,
  }
}

/**
 * 进度是否已过期：超过 24 小时，或跨周（`weekStart` 不是本周一）。
 *
 * @param progress 进度
 * @param nowMs 当前时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function isProgressExpired(
  progress: ReviewWizardProgress,
  nowMs: number,
  tzOffsetMinutes?: number,
): boolean {
  const updated = Date.parse(progress.updatedAt)
  if (Number.isNaN(updated)) return true
  if (nowMs - updated > PROGRESS_TTL_MS) return true
  return progress.weekStart !== isoWeekStart(nowMs, tzOffsetMinutes)
}

/**
 * 第 1 步：本周期新增且「无分类、无标签」的记录（收件箱）。
 *
 * @param records 本周期记录
 */
export function pickInbox(records: InfoRecord[]): InfoRecord[] {
  return records.filter((r) => !r.isDeleted && !r.category && (r.tags?.length ?? 0) === 0)
}

/**
 * 第 2 步：本周期涉及的分类清单（按出现次数降序，次数相同按名称升序）。
 *
 * @param records 本周期记录
 */
export function pickCategories(records: InfoRecord[]): string[] {
  const counts = new Map<string, number>()
  for (const record of records) {
    const category = record.category?.trim()
    if (!category) continue
    counts.set(category, (counts.get(category) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0], 'zh-CN')))
    .map(([category]) => category)
}

/**
 * 第 3 步：等待中 / 搁置 = 「某天」待办 ∪ 逾期未完成待办。
 *
 * - 「某天」直接复用 `bucketTodo()` 的 someday 判定（与待办三段视图同一口径）；
 * - 「逾期」= `remind_at` 早于**本地今日 00:00**（与 `localDayStartMs` 同一本地日范式）。
 *   注意不能直接用 `bucketTodo() === 'today'`：三段视图里「今天」含当日到期，
 *   而回顾要揪的是**已经过期**的那批，两者语义不同。
 *
 * @param todos 未完成待办集合（已排除 isDeleted）
 * @param nowMs 当前时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function pickWaiting(todos: InfoRecord[], nowMs: number, tzOffsetMinutes?: number): InfoRecord[] {
  const todayStart = localDayStartMs(nowMs, tzOffsetMinutes)
  const seen = new Set<number>()
  const out: InfoRecord[] = []
  for (const todo of todos) {
    if (todo.isDeleted || todo.todoStatus === 'done') continue
    const isSomeday = bucketTodo(todo, nowMs, tzOffsetMinutes) === 'someday'
    const remindMs = todo.remindAt ? Date.parse(todo.remindAt) : Number.NaN
    const isOverdue = !Number.isNaN(remindMs) && remindMs < todayStart
    if (!isSomeday && !isOverdue) continue
    if (seen.has(todo.id)) continue
    seen.add(todo.id)
    out.push(todo)
  }
  return out
}

/**
 * 第 4 步：长时间（默认 14 天）没有更新的分类。
 *
 * 判定用「分类内 `max(updatedAt)`」，避免一条新记录把整个分类刷成健康。
 *
 * @param records 最近若干天更新过的记录
 * @param nowMs 当前时刻（epoch ms）
 * @param days 搁置阈值（天），默认 `STALE_DAYS`
 */
export function pickStaleCategories(
  records: Array<Pick<InfoRecord, 'category' | 'updatedAt'>>,
  nowMs: number,
  days: number = STALE_DAYS,
): string[] {
  const latest = new Map<string, number>()
  for (const record of records) {
    const category = record.category?.trim()
    if (!category) continue
    const ms = Date.parse(record.updatedAt)
    if (Number.isNaN(ms)) continue
    const prev = latest.get(category)
    if (prev === undefined || ms > prev) latest.set(category, ms)
  }
  const threshold = nowMs - Math.max(1, Math.floor(days)) * MS_PER_DAY
  return [...latest.entries()]
    .filter(([, ms]) => ms < threshold)
    .sort((a, b) => a[1] - b[1])
    .map(([category]) => category)
}

/** 回顾正文的五个二级标题（顺序即 PRD 验收口径）。 */
export const REVIEW_NOTE_SECTIONS = [
  '清空收件箱',
  '下一步行动',
  '等待中',
  '项目健康',
  '下周焦点',
] as const

/** 回顾正文统计入参。 */
export interface ReviewNoteStats {
  inbox: number
  waiting: number
  stale: string[]
  aiSummary?: string | null
  aiFailed?: boolean
}

/**
 * 构造回顾记录正文（Markdown），含固定 5 个二级标题。
 *
 * 只写 `progress` 里已有的文本与传入的统计量，不做任何 IO。
 *
 * @param progress 已完成/临近完成的进度
 * @param stats 各步统计（收件箱条数、等待中条数、搁置分类、AI 建议）
 */
export function buildReviewNoteBody(progress: ReviewWizardProgress, stats: ReviewNoteStats): string {
  const assigned = progress.inbox.filter((i) => i.decision === 'assign')
  const archived = progress.inbox.filter((i) => i.decision === 'archive')
  const skipped = progress.inbox.filter((i) => i.decision === 'skip')

  const kept = progress.waiting.filter((w) => w.decision === 'keep')
  const deleted = progress.waiting.filter((w) => w.decision === 'delete')

  const lines: string[] = []

  lines.push(`## ${REVIEW_NOTE_SECTIONS[0]}`)
  lines.push(`本周期待清理 ${stats.inbox} 条。`)
  if (assigned.length > 0) {
    lines.push(`- 已归入分类 ${assigned.length} 条：${assigned.map((i) => i.category || '（未命名）').join('、')}`)
  }
  if (archived.length > 0) lines.push(`- 已归档（保持无分类）${archived.length} 条`)
  if (skipped.length > 0) lines.push(`- 暂不处理 ${skipped.length} 条`)
  if (stats.inbox === 0) lines.push('本周期没有待清理的收件箱记录。')

  lines.push('')
  lines.push(`## ${REVIEW_NOTE_SECTIONS[1]}`)
  if (progress.nextActions.length === 0) {
    lines.push('本次未填写下一步行动。')
  } else {
    for (const action of progress.nextActions) {
      const prefix = action.category ? `【${action.category}】` : ''
      lines.push(`- ${prefix}${action.text}`)
    }
  }

  lines.push('')
  lines.push(`## ${REVIEW_NOTE_SECTIONS[2]}`)
  lines.push(`待观察 ${stats.waiting} 条，其中保留 ${kept.length} 条、删除 ${deleted.length} 条。`)
  if (stats.waiting === 0) lines.push('本周没有搁置或逾期的待办。')

  lines.push('')
  lines.push(`## ${REVIEW_NOTE_SECTIONS[3]}`)
  if (stats.stale.length === 0) {
    lines.push(`本周没有超过 ${STALE_DAYS} 天未更新的分类。`)
  } else {
    for (const category of stats.stale) {
      const ack = progress.health.find((h) => h.category === category)?.acknowledged === true
      lines.push(`- ${category}：超过 ${STALE_DAYS} 天未更新（${ack ? '已确认' : '待确认'}）`)
    }
  }

  lines.push('')
  lines.push(`## ${REVIEW_NOTE_SECTIONS[4]}`)
  const focus = progress.focus.map((f) => f.trim()).filter(Boolean)
  if (focus.length === 0) {
    lines.push('本次未填写下周焦点。')
  } else {
    focus.forEach((f, i) => lines.push(`${i + 1}. ${f}`))
  }

  if (stats.aiFailed) {
    lines.push('')
    lines.push('## AI 建议')
    lines.push('本次未能生成建议。')
  } else if (stats.aiSummary && stats.aiSummary.trim()) {
    lines.push('')
    lines.push('## AI 建议')
    lines.push(stats.aiSummary.trim())
  }

  return lines.join('\n')
}

/**
 * 回顾记录标题：`2026-10-26 周回顾`（`weekStart` 为本周一）。
 *
 * @param weekStart 'YYYY-MM-DD'
 */
export function reviewNoteTitle(weekStart: string): string {
  return `${weekStart} 周回顾`
}
