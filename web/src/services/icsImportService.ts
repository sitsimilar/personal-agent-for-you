/**
 * .ics 导入落库服务（日历互通 P0-1 下半的**唯一落库入口**）。
 *
 * 分工：
 * - `lib/ics-parse.ts`：文本 → 结构化条目（纯函数，含时区/循环展开）；
 * - `lib/ics-map.ts`：条目 → 记录草稿（纯函数，含优先级/分类/UID 规则）；
 * - **本文件**：查重 + 分批写入 + 结果统计（唯一会碰 `cloud` 的地方）。
 *
 * 三条不可退让的约束：
 * 1. **查重先于写入**：`external_uid` 是同一份日历的稳定标识，重复导入必须跳过而不是再插一份；
 * 2. **缺列时立刻失败**：迁移未执行（42703）时查重结果恒为空，此时插入必然重复，
 *    因此宁可整次报错并给出 SQL 路径，也绝不"降级继续导入"；
 * 3. **单条失败不整体回滚**：一份日历里可能有 1 条脏数据，不能因此让另外 99 条都进不来；
 *    冲突（23505，并发重复导入）计为"跳过"，其它错误才抛。
 *
 * v2.14 P0-2 增补：写入完成后再做一次「父级回填」——把 `RELATED-TO` 的 UID 解析成
 * `records.parent_id`（父子同批导入时只能落库后反查，见 `linkParents`）。
 */

import { cloud } from '@/lib/cloud'
import { parseIcs, type IcsParseResult } from '@/lib/ics-parse'
import { buildDrafts, type IcsImportDraft } from '@/lib/ics-map'
import { recordService, isRecordsSchemaMissingError } from '@/services/recordService'
import { friendlyError } from '@/lib/unwrap'

/* ============================== 对外契约 ============================== */

/** 导入预览（用户确认前展示；不做任何写操作）。 */
export interface IcsImportPreview {
  /** `X-WR-CALNAME`，无则 null。 */
  calendarName: string | null
  drafts: IcsImportDraft[]
  /** 解析期的非致命提示（截断 / 缺 DTSTART / 覆盖实例未匹配……）。 */
  warnings: string[]
  /** `total` 含笔记；`cancelled` 单列（它们也会落库，只是进回收站）。 */
  counts: { total: number; event: number; todo: number; journal: number; cancelled: number }
}

/** 导入结果。 */
export interface IcsImportResult {
  /** 实际写入条数。 */
  created: number
  /** 跳过的条数（「已存在」+「插入冲突」）。 */
  skipped: number
  /** 其中被标记为取消（进回收站）的条数。 */
  cancelled: number
  /** 本次文件里的条目总数（含跳过）。 */
  total: number
}

/** 导入选项。 */
export interface IcsImportOptions {
  /** 注入当前时刻（ISO），用于展开时间窗与 `importedAt` / `deleted_at`；不传则读本机时钟。 */
  nowIso?: string
}

/* ============================== 内部常量 ============================== */

/** 单次 insert 的条数上限（行宽较大，20 条一批既有吞吐又不至于超请求体限制）。 */
const INSERT_BATCH_SIZE = 20

/** 迁移未执行的修复指引（`friendlyError` 会脱敏带 `/` 的文案，故由 UI 原样展示）。 */
const MIGRATION_HINT = '云库缺少 external_uid 字段，请先执行 docs/v2.14/migration.sql 后再导入'

/** 本服务抛出的错误统一带此前缀的 code，UI 据此决定「原样展示 message」。 */
const ERROR_CODE_PREFIX = 'ICS_IMPORT_'

/**
 * 构造带稳定 code 的导入错误。
 *
 * @param codeSuffix 语义后缀（如 `'EMPTY'` / `'INSERT_FAILED'`）
 * @param message 面向用户的中文文案
 */
function importError(codeSuffix: string, message: string): Error & { code: string } {
  const error = new Error(message) as Error & { code: string }
  error.name = 'IcsImportError'
  error.code = `${ERROR_CODE_PREFIX}${codeSuffix}`
  return error
}

/** 是否是本服务抛出的错误（含「迁移未执行」），UI 可原样展示 `message`。 */
export function isIcsImportError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' && code.startsWith(ERROR_CODE_PREFIX)
}

/**
 * 导入链路的错误文案统一出口（UI 只调这一个）。
 *
 * 为什么不能一律用 `friendlyError()`：它会把带 `/`、`"`、`{}` 的长文案脱敏成
 * "操作失败，请稍后重试"，而「请先执行 docs/v2.14/migration.sql」这条文案必须原样到达用户，
 * 否则用户永远不知道该做什么。安全边界没有放松——这里放行的都是本服务**自己写的**固定文案。
 *
 * @param error 任意错误
 */
export function describeIcsImportError(error: unknown): string {
  if (isRecordsSchemaMissingError(error) || isIcsImportError(error)) {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.trim()) return message
  }
  return friendlyError(error)
}

/* ============================== 内部工具 ============================== */

/** 从错误对象读错误码（兼容 `code` 与嵌套 `error.code`）。 */
function readErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const e = error as { code?: unknown; error?: { code?: unknown } }
  const code = e.code ?? e.error?.code
  return typeof code === 'string' ? code : typeof code === 'number' ? String(code) : ''
}

/**
 * 把非冲突类的数据库错误翻成中文。
 *
 * 只覆盖导入链路真会遇到的几种；其余一律兜底，避免把后端堆栈漏给用户。
 *
 * @param error 原始错误
 */
function describeWriteFailure(error: unknown): string {
  const code = readErrorCode(error)
  if (code === '42501') return '无权限写入记录，请确认登录状态后重试'
  if (code === '42P01') return '数据表不存在，请联系管理员'
  if (code === 'PGRST301' || code === '401') return '登录已失效，请重新登录'
  const cls = friendlyError(error)
  return cls === '操作失败，请稍后重试' ? '导入失败，请稍后重试' : cls
}

/** 统计草稿分布（`cancelled` 与 `total` 不互斥：取消的条目也算总数）。 */
function countDrafts(drafts: IcsImportDraft[]): IcsImportPreview['counts'] {
  const counts = { total: drafts.length, event: 0, todo: 0, journal: 0, cancelled: 0 }
  for (const draft of drafts) {
    if (draft.icsKind === 'event') counts.event += 1
    else if (draft.icsKind === 'todo') counts.todo += 1
    else counts.journal += 1
    if (draft.deleted) counts.cancelled += 1
  }
  return counts
}

/**
 * 草稿 → `records` 插入行（snake_case）。
 *
 * `deleted_at` 与 `recordMeta.importedAt` 都用注入的 `nowIso`：
 * 一次导入的所有行共享同一时刻，排查"这批是第几次导入"时可以直接按值分组。
 *
 * @param draft 草稿
 * @param nowIso 导入时刻
 */
function toInsertRow(draft: IcsImportDraft, nowIso: string): Record<string, unknown> {
  return {
    type: draft.type,
    title: draft.title,
    content: draft.content,
    todo_status: draft.todoStatus,
    priority: draft.priority,
    remind_at: draft.remindAt,
    tags: draft.tags,
    category: draft.category,
    external_uid: draft.externalUid,
    record_meta: { ...draft.recordMeta, importedAt: nowIso },
    is_deleted: draft.deleted,
    deleted_at: draft.deleted ? nowIso : null,
  }
}

/**
 * 写入一批行；成功返回 null，失败返回 SDK 的错误对象（不抛）。
 *
 * @param rows snake_case 插入行
 */
async function insertRows(rows: Record<string, unknown> | Record<string, unknown>[]): Promise<unknown> {
  const { error } = await cloud.database.from('records').insert(rows).select()
  return error ?? null
}

/**
 * 回填父级关系（v2.14 P0-2）：把草稿里的 `parentUid` 解析成 `records.parent_id`。
 *
 * 为什么要放在**全部写入之后**：父子可能在同一份文件里（父在前或子在前都可能），
 * 插入时父记录还没有 id，只能先落库再用 UID 反查。
 *
 * 失败口径：
 * - 迁移未执行（缺 `external_uid`）→ 抛 `MIGRATION_REQUIRED`（与查重同一口径，此时本来就不该继续）；
 * - 其它错误 / 父级不在库里 → **静默跳过**：导入本身已经成功，父级关系是附加信息，
 *   不该因为"引用了别的日历的父任务"把整次导入判失败。
 *
 * @param drafts 本次全部草稿（含被跳过的，父级可能早就存在）
 */
async function linkParents(drafts: IcsImportDraft[]): Promise<void> {
  const children = drafts.filter((draft) => draft.parentUid !== null)
  if (children.length === 0) return

  const uids: string[] = []
  for (const draft of children) {
    if (draft.parentUid && !uids.includes(draft.parentUid)) uids.push(draft.parentUid)
    if (!uids.includes(draft.externalUid)) uids.push(draft.externalUid)
  }

  let idByUid: Map<string, number>
  try {
    idByUid = await recordService.mapIdByExternalUids(uids)
  } catch (error) {
    if (isRecordsSchemaMissingError(error)) throw importError('MIGRATION_REQUIRED', MIGRATION_HINT)
    return
  }

  // 按父级分组，一组一次 update（几十条子任务也只发一次请求）
  const groups = new Map<number, number[]>()
  for (const draft of children) {
    const parentId = draft.parentUid ? idByUid.get(draft.parentUid) : undefined
    const childId = idByUid.get(draft.externalUid)
    if (parentId === undefined || childId === undefined) continue
    if (parentId === childId) continue
    const bucket = groups.get(parentId)
    if (bucket) bucket.push(childId)
    else groups.set(parentId, [childId])
  }

  for (const [parentId, childIds] of groups) {
    try {
      await recordService.setParentIds(childIds, parentId)
    } catch {
      /* best-effort：父级回填失败不改变导入结果 */
    }
  }
}

/* ============================== 预览 ============================== */

/**
 * 解析 + 映射 + 统计（**纯同步、无网络**，供弹窗预览与测试使用）。
 *
 * 与 `importIcs` 共用同一条解析路径，保证"看到的"与"导进去的"是同一批数据。
 *
 * @param text `.ics` 全文
 * @param opts `nowIso` 注入当前时刻；`maxOccurrences` 透传给解析层
 */
export function previewIcs(
  text: string,
  opts: { nowIso?: string; maxOccurrences?: number } = {},
): IcsImportPreview {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const result: IcsParseResult = parseIcs(text, {
    nowIso,
    ...(opts.maxOccurrences !== undefined ? { maxOccurrences: opts.maxOccurrences } : {}),
  })
  const drafts = buildDrafts(result).map((draft) => ({
    ...draft,
    // 纯映射层不读时钟，导入时刻在这里统一盖章（预览与落库共用同一个值）
    recordMeta: { ...draft.recordMeta, importedAt: nowIso },
  }))
  return {
    calendarName: result.calendarName,
    drafts,
    warnings: result.warnings,
    counts: countDrafts(drafts),
  }
}

/* ============================== 落库 ============================== */

/**
 * 把一份 `.ics` 导入到记录库（跳过已存在的 `external_uid`）。
 *
 * 流程：预览 → 查重（42703 立刻抛）→ 过滤已存在 → 20 条一批 insert。
 *
 * @param text `.ics` 全文
 * @param opts `nowIso` 注入当前时刻
 * @returns 写入 / 跳过 / 取消 / 总数
 * @throws 可导入条目为空、迁移未执行、无权限等（文案见 `describeIcsImportError`）
 */
export async function importIcs(text: string, opts: IcsImportOptions = {}): Promise<IcsImportResult> {
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const preview = previewIcs(text, { nowIso })
  const { drafts, counts, warnings } = preview

  if (drafts.length === 0) {
    // 空文件也要说清原因：把解析层的前 2 条 warning 拼进消息，用户才知道是"文件格式不对"
    // 还是"日历确实是空的"
    const detail = warnings.slice(0, 2).join('；')
    throw importError('EMPTY', detail ? `没有可导入的日历条目：${detail}` : '没有可导入的日历条目')
  }

  // 1) 查重：只查 external_uid，避免把整表拉下来
  let existing: string[] = []
  try {
    existing = await recordService.listExternalUids(drafts.map((draft) => draft.externalUid))
  } catch (error) {
    if (isRecordsSchemaMissingError(error)) {
      // 换成本服务的 code，UI 只需一个判定入口
      throw importError('MIGRATION_REQUIRED', MIGRATION_HINT)
    }
    throw importError('LOOKUP_FAILED', `查重失败：${describeWriteFailure(error)}`)
  }
  const existingSet = new Set(existing)
  const pending = drafts.filter((draft) => !existingSet.has(draft.externalUid))
  let skipped = drafts.length - pending.length
  let created = 0

  // 2) 分批写入
  for (let index = 0; index < pending.length; index += INSERT_BATCH_SIZE) {
    const batch = pending.slice(index, index + INSERT_BATCH_SIZE)
    const rows = batch.map((draft) => toInsertRow(draft, nowIso))
    const batchError = await insertRows(rows)
    if (!batchError) {
      created += batch.length
      continue
    }
    // 缺列：整次中止（继续写只会产生重复数据）
    if (readErrorCode(batchError) === '42703') {
      throw importError('MIGRATION_REQUIRED', MIGRATION_HINT)
    }

    // 整批失败：逐条重试，把"一条坏数据"与"整批失败"区分开
    for (const [offset, draft] of batch.entries()) {
      const rowError = await insertRows(rows[offset])
      if (!rowError) {
        created += 1
        continue
      }
      if (readErrorCode(rowError) === '42703') {
        throw importError('MIGRATION_REQUIRED', MIGRATION_HINT)
      }
      // 23505 = 唯一索引冲突：另一个标签页刚好导入了同一条，算「已存在」
      if (readErrorCode(rowError) === '23505') {
        skipped += 1
        continue
      }
      throw importError('INSERT_FAILED', `导入「${draft.title}」失败：${describeWriteFailure(rowError)}`)
    }
  }

  // 3) 父级回填（RELATED-TO → parent_id）：放在写入之后，父子同批时才能反查到 id
  await linkParents(drafts)

  return { created, skipped, cancelled: counts.cancelled, total: counts.total }
}

/** service 单例（与项目其它 service 风格一致）。 */
export const icsImportService = { previewIcs, importIcs }
