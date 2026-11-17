import { cloud } from '@/lib/cloud'
import { unwrap } from '@/lib/unwrap'
import type { RecordsRow } from '@/lib/database.types'
import { normalizeRecurrenceRule } from '@/lib/recurrence'
import { buildKeywordOrFilter, buildTsQuery, mergeRowsById } from '@/lib/search'
import type {
  InfoRecord,
  LinkMeta,
  RecordCreateInput,
  RecordListFilter,
  RecordListResult,
  RecordMeta,
  RecordType,
  RecurrenceRule,
  RelateResultItem,
  TodoStatus,
} from '@shared/types/domain'

/**
 * 「云库缺列」（PostgreSQL `42703`）的专用错误（v2.14 .ics 导入）。
 *
 * 为什么单独造一个类型而不是直接抛原错误：这条错误必须**原样展示**给用户
 * （告诉他去执行 `docs/v2.14/migration.sql`），而 `friendlyError()` 会把带 `/` 的
 * 长文案统一脱敏成"操作失败，请稍后重试"——用户就再也看不到修复路径了。
 * 用带 `code` 的标记错误让 UI 有据可依，同时不改变 `friendlyError` 的现有行为。
 */
export class RecordsSchemaMissingError extends Error {
  /** 稳定错误码（UI 据此决定「原样展示」）。 */
  readonly code = 'RECORDS_SCHEMA_MISSING'

  constructor(message: string) {
    super(message)
    this.name = 'RecordsSchemaMissingError'
  }
}

/** 是否是「云库缺列」错误（按 `code` 判定，跨 bundle 也不会因 instanceof 失效）。 */
export function isRecordsSchemaMissingError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  return (error as { code?: unknown }).code === 'RECORDS_SCHEMA_MISSING'
}

/** 从任意错误里读错误码（兼容 `code` 与嵌套 `error.code`）。 */
function readErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const e = error as { code?: unknown; error?: { code?: unknown } }
  const code = e.code ?? e.error?.code
  return typeof code === 'string' ? code : typeof code === 'number' ? String(code) : ''
}

/** 记录查询相关上限集中配置。 */
const LIMITS = {
  search: 50,
  searchCandidates: 20,
  listByRange: 200,
  streakSample: 500,
  relatedTargets: 500,
  reminderCandidates: 200,
  /** v2.13 R5 第 4 步：14 天健康判定取最近 90 天更新过的记录。 */
  updatedSince: 500,
  /** v2.13 R6 .ics 导出上限（单次导出条数，防浏览器卡死）。 */
  export: 1000,
  /**
   * v2.14 .ics 导入查重：单次 `in(...)` 的 UID 数量上限。
   * 200 是 PostgREST/网关 GET 长度与 PG 参数个数的安全折中（一份日历常见几十到几百条）。
   */
  externalUidBatch: 200,
} as const

/** JSONB 循环规则归一：脏数据（字符串/缺字段/非法 freq）统一为 null。 */
function toRecurrence(value: unknown): RecurrenceRule | null {
  if (typeof value === 'string') {
    try {
      return normalizeRecurrenceRule(JSON.parse(value))
    } catch {
      return null
    }
  }
  return normalizeRecurrenceRule(value)
}

/** JSONB 链接元数据归一：脏数据统一为 null，status 非法视为失败。 */
function toLinkMeta(value: unknown): LinkMeta | null {
  let raw: unknown = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
  const status: LinkMeta['status'] = obj.status === 'ok' ? 'ok' : 'failed'
  const meta: LinkMeta = {
    title: text(obj.title),
    description: text(obj.description),
    image: text(obj.image),
    site: text(obj.site),
    fetchedAt: typeof obj.fetchedAt === 'string' ? obj.fetchedAt : undefined,
    status,
  }
  if (typeof obj.errorCode === 'string' && obj.errorCode) meta.errorCode = obj.errorCode
  // 全部字段为空且未标记失败 → 视为无元数据
  if (status === 'ok' && !meta.title && !meta.description && !meta.image && !meta.site) return null
  return meta
}

/**
 * JSONB 正文派生元数据归一（v2.14 .ics 导入）。
 *
 * 容错口径与 `toLinkMeta` 一致：字符串先尝试 JSON.parse，非对象/全空 → null。
 * **不抛错**是硬要求：`mapRecord` 是所有读路径的必经之地，一条脏数据不能让整页记录打不开。
 * 只搬已知字段、且逐个校验类型——将来 JSON 结构演进时，未知字段被静默忽略而不是漏进 UI。
 *
 * @param value `records.record_meta` 原值（可能是对象 / JSON 字符串 / null）
 */
function toRecordMeta(value: unknown): RecordMeta | null {
  let raw: unknown = value
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      return null
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
  const meta: RecordMeta = {}
  const source = text(obj.source)
  if (source) meta.source = source
  const externalUid = text(obj.externalUid)
  if (externalUid) meta.externalUid = externalUid
  if (obj.icsKind === 'event' || obj.icsKind === 'todo' || obj.icsKind === 'journal') {
    meta.icsKind = obj.icsKind
  }
  const rrule = text(obj.rrule)
  if (rrule) meta.rrule = rrule
  if (Array.isArray(obj.exdates)) {
    const exdates = obj.exdates.filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    if (exdates.length > 0) meta.exdates = exdates
  }
  const completedAt = text(obj.completedAt)
  if (completedAt) meta.completedAt = completedAt
  const dtstart = text(obj.dtstart)
  if (dtstart) meta.dtstart = dtstart
  const importedAt = text(obj.importedAt)
  if (importedAt) meta.importedAt = importedAt
  return Object.keys(meta).length > 0 ? meta : null
}

/** 数据库行（snake_case）→ 领域类型（camelCase）。 */
export function mapRecord(row: RecordsRow): InfoRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    content: row.content,
    url: row.url,
    filePath: row.file_path,
    category: row.category,
    tags: Array.isArray(row.tags) ? row.tags : [],
    summary: row.summary,
    todoStatus: row.todo_status,
    priority: row.priority,
    remindAt: row.remind_at,
    recurrence: toRecurrence(row.recurrence),
    recurrenceParentId: row.recurrence_parent_id ?? null,
    recurrenceNextId: row.recurrence_next_id ?? null,
    linkMeta: toLinkMeta(row.link_meta),
    // v2.13 新列：迁移未执行时行里没有这些键，全部回落默认值（旧行为不变）
    someday: row.someday ?? false,
    snoozedUntil: row.snoozed_until ?? null,
    snoozeCount: row.snooze_count ?? 0,
    // v2.14 新列：同上，缺列 / 脏数据一律回落 null
    externalUid: row.external_uid ?? null,
    recordMeta: toRecordMeta(row.record_meta),
    parentId: row.parent_id ?? null,
    isDeleted: row.is_deleted,
    deletedAt: row.deleted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * 检索链路用到的查询方法子集。
 *
 * 只声明用得到的方法，避免把 SDK 的复杂泛型签名泄漏到业务代码里；
 * 收窄点集中在 `asKeywordQuery()` 一处。
 */
interface KeywordQuery {
  or(filter: string): KeywordQuery
  textSearch(
    column: string,
    query: string,
    options: { type: 'websearch'; config: 'simple' },
  ): KeywordQuery
  order(column: string, options: { ascending: boolean }): KeywordQuery
  limit(count: number): KeywordQuery
}

/** 把 SDK 查询构建器收窄为检索链路所需的方法子集（SDK 泛型签名过于宽泛，无法直接赋值）。 */
function asKeywordQuery<T>(query: T): KeywordQuery {
  return query as unknown as KeywordQuery
}

/** 执行一条查询并返回宽松包络（builder 是 thenable，类型上显式收窄一次）。 */
async function execQuery(query: KeywordQuery): Promise<{ data: unknown; error: unknown }> {
  const result = await (query as unknown as Promise<{ data: unknown; error: unknown }>)
  return result ?? { data: null, error: null }
}

/**
 * 关键词检索的唯一执行入口（v2.13 R1）：`search()` 与 `searchCandidates()` 共用。
 *
 * - q1（ilike/trgm 路径）：中文唯一可靠命中路径，也是全部单关键词行为的保底；
 * - q2（search_tsv 叠加路径）：仅当**全部**关键词都是「长度 ≥ 2 的 ASCII 词」时执行，
 *   结果按 id 与 q1 求并集，再按 `created_at DESC` 截断。
 *   只要有一个词进不了 tsquery（CJK / 单字符 / 纯数字）就不发 q2 —— 否则并集会
 *   把 q1 的「词间 AND」稀释成 OR（见 `lib/search.ts` 的 `buildTsQuery` 不变式）。
 *
 * q2 允许失败：迁移未执行时列不存在（42703）或后端不支持该语法，
 * 此时**静默只用 q1**，保证迁移未执行时应用照常可用。
 *
 * @param build 每次调用返回一条**新的**基础查询（调用方负责 is_deleted / type / category / excludeId）
 * @param kw 已 trim 的关键词（可为空 = 不加关键词过滤）
 * @param limit 结果上限
 */
async function runKeywordQuery(
  build: () => KeywordQuery,
  kw: string,
  limit: number,
): Promise<RecordsRow[]> {
  const filter = buildKeywordOrFilter(kw)

  let primary = build()
  if (filter) primary = primary.or(filter)
  primary = primary.order('created_at', { ascending: false }).limit(limit)
  const primaryResult = await execQuery(primary)
  const primaryRows =
    (unwrap({ data: primaryResult.data, error: primaryResult.error }) as RecordsRow[] | null) ?? []

  const tsQuery = buildTsQuery(kw)
  if (!tsQuery) return primaryRows

  try {
    let overlay = build()
    overlay = overlay
      .textSearch('search_tsv', tsQuery, { type: 'websearch', config: 'simple' })
      .order('created_at', { ascending: false })
      .limit(limit)
    const overlayResult = await execQuery(overlay)
    // 有错（典型：迁移未执行 → 42703 列不存在）→ 静默跳过叠加路径
    if (overlayResult.error) return primaryRows
    const overlayRows = (overlayResult.data as RecordsRow[] | null) ?? []
    return mergeRowsById(primaryRows, overlayRows, limit)
  } catch {
    return primaryRows
  }
}

/**
 * 应用关键词过滤（过滤器构造见 lib/search.ts）。
 *
 * 单关键词与 v2.12.2 同形；多关键词自动获得「词间 AND / 字段间 OR」语义。
 * 空关键词不加任何过滤。本函数只服务**带分页/计数的**列表查询
 * （`listRecords`）——它必须与 `count`、`range` 共存，故不做 tsvector 并集叠加。
 */
function applyKeyword<Q extends { or(filter: string): Q }>(query: Q, kw: string): Q {
  const filter = buildKeywordOrFilter(kw)
  return filter ? query.or(filter) : query
}

/** 解包并返回非空行数组；空结果抛统一中文错误。 */
function unwrapRows(result: { data: unknown; error: unknown }, msg = '无权限或记录不存在'): RecordsRow[] {
  const rows = unwrap(result) as RecordsRow[] | null
  if (!rows || rows.length === 0) throw new Error(msg)
  return rows
}

/**
 * 该记录是否带 snooze 状态（为 false 时无需复位，避免多余写入）。
 *
 * @param record 领域记录
 */
function hasSnoozeState(record: InfoRecord): boolean {
  return (record.snoozeCount ?? 0) > 0 || !!record.snoozedUntil
}

/**
 * 复位 snooze 状态（v2.13 R4）：`snoozed_until = null`、`snooze_count = 0`。
 *
 * 调用时机：待办被完成、或用户改了 `remind_at`（视为新一轮提醒）。
 * **best-effort**：迁移未执行时这两列不存在（42703），此时静默跳过，
 * 保证「迁移未执行也必须能跑」——不让新特性拖垮完成待办/改提醒这些既有路径。
 *
 * @param id 记录 id
 */
async function resetSnoozeState(id: number): Promise<void> {
  try {
    await cloud.database
      .from('records')
      .update({ snoozed_until: null, snooze_count: 0 })
      .eq('id', id)
  } catch {
    /* 列不存在（迁移未执行）或网络抖动：不影响主流程 */
  }
}

/**
 * 连带把子任务放进回收站（v2.14 P0-2，best-effort）。
 *
 * 为什么由应用层做而不是外键级联：`records.parent_id` 刻意没加外键（见 migration.sql 注释），
 * 且"软删除"不是数据库行为；这里补一层应用语义，避免删父任务后列表里留下永远点不开的孤儿。
 *
 * 迁移未执行（缺 `parent_id` 列 → 42703）时静默跳过：父记录已删成功，
 * 不能让"清理子任务"失败反过来把整个删除操作判为失败。
 *
 * @param parentId 被删除的记录 id
 * @param deletedAt 与父记录一致的删除时刻（回收站排序/还原口径统一）
 */
async function softDeleteChildren(parentId: number, deletedAt: string): Promise<void> {
  try {
    const { data, error } = await cloud.database
      .from('records')
      .select('id')
      .eq('parent_id', parentId)
      .eq('is_deleted', false)
    if (error) return
    const rows = (data as Array<{ id?: unknown }> | null) ?? []
    const ids = rows
      .map((row) => (row && typeof row.id === 'number' ? row.id : null))
      .filter((id): id is number => id !== null && id !== parentId)
    if (ids.length === 0) return
    await cloud.database
      .from('records')
      .update({ is_deleted: true, deleted_at: deletedAt })
      .in('id', ids)
      .select()
  } catch {
    /* 缺列 / 网络抖动：不影响父记录的删除结果 */
  }
}

/** 本地日期 key（避免 UTC toISOString 时区偏移导致跨天）。 */
function localDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 连续记录天数（从今天或昨天起，往前数有记录的天数）。 */
function computeStreak(createdAts: string[]): number {
  const days = new Set<string>()
  for (const iso of createdAts) {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) continue
    days.add(localDayKey(d))
  }
  const cursor = new Date()
  cursor.setHours(0, 0, 0, 0)
  if (!days.has(localDayKey(cursor))) cursor.setDate(cursor.getDate() - 1)
  let streak = 0
  while (days.has(localDayKey(cursor))) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}

/** 领域字段 → snake_case 数据库字段。 */
function toSnake(input: RecordUpdateInput): Record<string, unknown> {
  const fields: Record<string, unknown> = {}
  if (input.type !== undefined) fields.type = input.type
  if (input.title !== undefined) fields.title = input.title
  if (input.content !== undefined) fields.content = input.content
  if (input.url !== undefined) fields.url = input.url
  if (input.filePath !== undefined) fields.file_path = input.filePath
  if (input.category !== undefined) fields.category = input.category
  if (input.tags !== undefined) fields.tags = input.tags
  if (input.summary !== undefined) fields.summary = input.summary
  if (input.todoStatus !== undefined) fields.todo_status = input.todoStatus
  if (input.priority !== undefined) fields.priority = input.priority
  if (input.remindAt !== undefined) fields.remind_at = input.remindAt
  if (input.recurrence !== undefined) fields.recurrence = input.recurrence
  if (input.recurrenceParentId !== undefined) fields.recurrence_parent_id = input.recurrenceParentId
  if (input.recurrenceNextId !== undefined) fields.recurrence_next_id = input.recurrenceNextId
  if (input.linkMeta !== undefined) fields.link_meta = input.linkMeta
  // v2.13 新列：只在显式传入时写入（迁移未执行时用户不会触发这些字段，旧路径不受影响）
  if (input.someday !== undefined) fields.someday = input.someday
  if (input.snoozedUntil !== undefined) fields.snoozed_until = input.snoozedUntil
  if (input.snoozeCount !== undefined) fields.snooze_count = input.snoozeCount
  // v2.14 新列：同样只在显式传入时写入（手写记录不会带上，迁移未执行也不受影响）
  if (input.externalUid !== undefined) fields.external_uid = input.externalUid
  if (input.recordMeta !== undefined) fields.record_meta = input.recordMeta
  // v2.14 P0-2：父级 id 同理（只在显式传入时写，手写记录永远不带这个键）
  if (input.parentId !== undefined) fields.parent_id = input.parentId
  return fields
}

/**
 * 写完「带提醒」的记录后，主动补跑一轮提醒调度。
 *
 * 背景（2026-11-18 节流改造）：`reminderService` 从固定 30s 轮询改成
 * 「有候选 60s / 无候选退避 5 分钟」。退避状态下新插入的提醒最多要等 5 分钟才被查到，
 * 这里主动戳一次把这个延迟抹平。
 *
 * 用动态 import 是为了避开循环依赖：`reminderService` 顶部就 import 了本模块。
 */
function pokeReminder(): void {
  void import('./reminderService')
    .then((m) => m.kick())
    .catch(() => {
      /* 提醒调度失败不影响写入结果 */
    })
}

export const recordService = {
  /** 新建记录（owner_id 由数据库 DEFAULT auth.uid() 填充，前端不发送）。 */
  async createRecord(input: RecordCreateInput): Promise<InfoRecord> {
    const { data, error } = await cloud.database
      .from('records')
      .insert({
        type: input.type,
        title: input.title ?? '',
        content: input.content ?? '',
        url: input.url ?? null,
        file_path: input.filePath ?? null,
        category: input.category ?? null,
        tags: input.tags ?? [],
        todo_status: input.todoStatus ?? null,
        priority: input.priority ?? null,
        remind_at: input.remindAt ?? null,
        recurrence: input.recurrence ?? null,
        recurrence_parent_id: input.recurrenceParentId ?? null,
        // v2.14：外部标识 / 元数据只在显式传入时才写（手写记录不带这两个键，
        // 迁移未执行时也不会因为写不存在的列而失败）
        ...(input.externalUid !== undefined ? { external_uid: input.externalUid } : {}),
        ...(input.recordMeta !== undefined ? { record_meta: input.recordMeta } : {}),
        ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
      })
      .select()
    const created = mapRecord(unwrapRows({ data, error })[0])
    // 带提醒的新记录：立刻补跑一轮调度。调度器改成「无候选退避 5 分钟」后，
    // 不主动戳一下的话，刚设的提醒最多要等 5 分钟才被查到。
    if (created.remindAt) pokeReminder()
    return created
  },

  /** 分页列表（支持类型/分类/关键词/回收站筛选）。 */
  async listRecords(filter: RecordListFilter = {}): Promise<RecordListResult> {
    const page = filter.page ?? 1
    const pageSize = filter.pageSize ?? 20
    const from = (page - 1) * pageSize
    const to = from + pageSize - 1

    let query = cloud.database
      .from('records')
      .select('*', { count: 'exact' })
      .eq('is_deleted', filter.isDeleted ?? false)

    if (filter.type) query = query.eq('type', filter.type)
    if (filter.category) query = query.eq('category', filter.category)
    if (filter.keyword && filter.keyword.trim()) {
      query = applyKeyword(query, filter.keyword.trim())
    }
    query = query.order('created_at', { ascending: false }).range(from, to)

    const { data, error, count } = await query
    const rows = (unwrap({ data, error }) as RecordsRow[] | null) ?? []
    return { records: rows.map(mapRecord), total: count ?? 0 }
  },

  /** 导航徽标计数（全部/想法/资料/待办未完成）。 */
  async counts(): Promise<{ all: number; idea: number; material: number; todoPending: number }> {
    const countOf = async (type?: RecordType, todoPending?: boolean): Promise<number> => {
      let query = cloud.database.from('records').select('id', { count: 'exact' }).eq('is_deleted', false)
      if (type) query = query.eq('type', type)
      if (todoPending) query = query.eq('todo_status', 'pending')
      const { count } = await query
      return count ?? 0
    }
    const [all, idea, material, todoPending] = await Promise.all([
      countOf(),
      countOf('idea'),
      countOf('material'),
      countOf('todo', true),
    ])
    return { all, idea, material, todoPending }
  },

  /** 首页统计卡：本周新增 / 待办未完成 / 连续记录天数。 */
  async stats(): Promise<{ weekNew: number; todoPending: number; streak: number }> {
    const now = new Date()
    const weekStart = new Date(now)
    weekStart.setDate(now.getDate() - ((now.getDay() + 6) % 7))
    weekStart.setHours(0, 0, 0, 0)

    const [weekNew, todoPending] = await Promise.all([
      (async () => {
        const { count } = await cloud.database
          .from('records')
          .select('id', { count: 'exact' })
          .eq('is_deleted', false)
          .gte('created_at', weekStart.toISOString())
        return count ?? 0
      })(),
      (async () => {
        const { count } = await cloud.database
          .from('records')
          .select('id', { count: 'exact' })
          .eq('is_deleted', false)
          .eq('type', 'todo')
          .eq('todo_status', 'pending')
        return count ?? 0
      })(),
    ])

    // 连续记录：拉取最近 500 条创建时间，按本地日期计算连续天数
    const { data, error } = await cloud.database
      .from('records')
      .select('created_at')
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(LIMITS.streakSample)
    const rows = (unwrap({ data, error }) as Array<{ created_at: string }> | null) ?? []
    const streak = computeStreak(rows.map((r) => r.created_at))

    return { weekNew, todoPending, streak }
  },

  /**
   * 关键词检索（v2.13 R1：ilike/trgm 主路径 + tsvector 叠加路径并集）。
   *
   * 返回字段、排序（`created_at DESC`）、上限（`LIMITS.search`）与 v2.12.2 一致；
   * 语义变化只有两点：多词按 AND 处理、英文词额外获得 tsvector 召回。
   * 空关键词行为不变（不加过滤，按时间倒序）。
   *
   * @param keyword 用户输入
   * @param filter 可选的类型 / 分类限定
   */
  async search(keyword: string, filter: { type?: RecordType; category?: string } = {}): Promise<InfoRecord[]> {
    const kw = keyword.trim()
    const build = (): KeywordQuery => {
      let query = cloud.database.from('records').select('*').eq('is_deleted', false)
      if (filter.type) query = query.eq('type', filter.type)
      if (filter.category) query = query.eq('category', filter.category)
      return asKeywordQuery(query)
    }
    const rows = await runKeywordQuery(build, kw, LIMITS.search)
    return rows.map(mapRecord)
  },

  /** 按创建时间区间拉取记录（回顾用，未删除）。 */
  async listByRange(startIso: string, endIso: string, limit: number = LIMITS.listByRange): Promise<InfoRecord[]> {
    const { data, error } = await cloud.database
      .from('records')
      .select('*')
      .eq('is_deleted', false)
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .order('created_at', { ascending: false })
      .limit(limit)
    const rows = (unwrap({ data, error }) as RecordsRow[] | null) ?? []
    return rows.map(mapRecord)
  },

  /** 单条记录（不存在返回 null）。 */
  async getRecord(id: number): Promise<InfoRecord | null> {
    const { data, error } = await cloud.database
      .from('records')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    const row = unwrap({ data, error }) as RecordsRow | null
    return row ? mapRecord(row) : null
  },

  /**
   * 提醒候选：未删除 + 待办 + 未完成 + remind_at 落在窗口内。
   * 使用 records_owner_todo_remind_idx 索引，limit 200 防一次拉太多。
   */
  async listReminderCandidates(fromIso: string, toIso: string): Promise<InfoRecord[]> {
    const { data, error } = await cloud.database
      .from('records')
      .select('*')
      .eq('is_deleted', false)
      .eq('type', 'todo')
      .eq('todo_status', 'pending')
      .gte('remind_at', fromIso)
      .lte('remind_at', toIso)
      .order('remind_at', { ascending: true })
      .limit(LIMITS.reminderCandidates)
    const rows = (unwrap({ data, error }) as RecordsRow[] | null) ?? []
    return rows.map(mapRecord)
  },

  /** 更新记录（UI 编辑）。 */
  async updateRecord(id: number, input: RecordUpdateInput): Promise<InfoRecord> {
    const fields = toSnake(input)
    const { data, error } = await cloud.database
      .from('records')
      .update(fields)
      .eq('id', id)
      .select()
    const updated = mapRecord(unwrapRows({ data, error })[0])
    // 动了提醒时间（含清空）→ 立刻重算一次，别等退避周期
    if (input.remindAt !== undefined) pokeReminder()
    // v2.13 R4：改了提醒时间 = 新一轮提醒，复位 snooze 状态
    // （仅在确有 snooze 状态时才发请求，避免给常规编辑路径增加无谓写入）
    if (input.remindAt !== undefined && hasSnoozeState(updated)) {
      await resetSnoozeState(id)
      // 复位是独立的一次写入，返回值需同步清掉 snooze 字段：
      // 否则调用方（详情弹窗 / 列表）会继续显示「已推迟至 …」。
      return { ...updated, snoozedUntil: null, snoozeCount: 0 }
    }
    return updated
  },

  /**
   * 复位 snooze 状态（v2.13 R4，best-effort）。
   * 供 `recurrenceService` 在完成待办（走的是条件更新，不经过 updateTodoStatus）时调用。
   */
  async resetSnoozeState(id: number): Promise<void> {
    await resetSnoozeState(id)
  },

  /**
   * 按 `updated_at` 取记录（v2.13 R5 第 4 步「项目健康检查」用）。
   *
   * @param sinceIso 起始时刻（ISO），通常传 now − 90 天
   * @param limit 上限，默认 500
   */
  async listByUpdatedSince(sinceIso: string, limit: number = LIMITS.updatedSince): Promise<InfoRecord[]> {
    const { data, error } = await cloud.database
      .from('records')
      .select('*')
      .eq('is_deleted', false)
      .gte('updated_at', sinceIso)
      .order('updated_at', { ascending: false })
      .limit(limit)
    const rows = (unwrap({ data, error }) as RecordsRow[] | null) ?? []
    return rows.map(mapRecord)
  },

  /**
   * 取可导出的待办（v2.13 R6 .ics 导出用）。
   *
   * 区间按 **`remind_at`** 过滤（不是 `created_at`）：导出的是「提醒/截止时间」，
   * 与日历页按 `created_at` 排布的口径不同，弹窗里已写明。
   * 不传区间（`range='all'`）时不过滤 `remind_at`，因此 `remind_at` 为空的待办也会返回
   * （它们只出 `VTODO`、无 `DUE`、无 `VEVENT`）。
   *
   * @param opts.fromIso 区间起点（含），不传则不限
   * @param opts.toIso 区间终点（不含），不传则不限
   * @param opts.includeDone 是否包含已完成待办
   * @param opts.limit 上限，默认 1000
   */
  async listTodosForExport(opts: {
    fromIso?: string
    toIso?: string
    includeDone: boolean
    limit?: number
  }): Promise<InfoRecord[]> {
    let query = cloud.database.from('records').select('*').eq('is_deleted', false).eq('type', 'todo')
    if (!opts.includeDone) query = query.eq('todo_status', 'pending')
    if (opts.fromIso) query = query.gte('remind_at', opts.fromIso)
    if (opts.toIso) query = query.lt('remind_at', opts.toIso)
    query = query.order('remind_at', { ascending: true }).limit(opts.limit ?? LIMITS.export)
    const { data, error } = await query
    const rows = (unwrap({ data, error }) as RecordsRow[] | null) ?? []
    return rows.map(mapRecord)
  },

  /**
   * 批量查询「已存在的外部标识」（v2.14 .ics 导入查重用）。
   *
   * 为什么必须由这里提供而不能让导入逻辑自己拼：`cloud.database.from('records')`
   * 是唯一查询入口，把 42703 的判定收在一处，才不会出现"某条路径缺列没报错、
   * 静默把同一份日历导入三遍"的事故。
   *
   * 分批（每批 `LIMITS.externalUidBatch` 条）：`in(...)` 会被拼进 URL，
   * 一份几千条的日历一次性拼进去会被网关截断，表现为"查重结果不全 → 重复导入"。
   *
   * @param uids 待查的外部标识（自动去重、去空）
   * @returns 命中的外部标识（顺序不保证）
   * @throws RecordsSchemaMissingError 迁移未执行（缺 `external_uid` 列）
   */
  async listExternalUids(uids: string[]): Promise<string[]> {
    const unique: string[] = []
    for (const raw of Array.isArray(uids) ? uids : []) {
      if (typeof raw !== 'string') continue
      const text = raw.trim()
      if (!text) continue
      if (!unique.includes(text)) unique.push(text)
    }
    if (unique.length === 0) return []

    const found: string[] = []
    for (let index = 0; index < unique.length; index += LIMITS.externalUidBatch) {
      const chunk = unique.slice(index, index + LIMITS.externalUidBatch)
      const { data, error } = await cloud.database
        .from('records')
        .select('external_uid')
        .in('external_uid', chunk)
      if (error) {
        // 迁移未执行：**必须**抛错。缺列时查重结果永远为空，继续走插入就会重复导入。
        if (readErrorCode(error) === '42703') {
          throw new RecordsSchemaMissingError(
            '云库缺少 external_uid 字段，请先执行 docs/v2.14/migration.sql 后再导入',
          )
        }
        unwrap({ data: null, error })
      }
      const rows = (data as Array<{ external_uid?: unknown }> | null) ?? []
      for (const row of rows) {
        const value = row && typeof row === 'object' ? row.external_uid : null
        if (typeof value === 'string' && value && !found.includes(value)) found.push(value)
      }
    }
    return found
  },

  /**
   * 批量查询「外部标识 → 记录 id」映射（v2.14 P0-2，.ics 导入回填 `parent_id` 用）。
   *
   * 为什么需要 id：`RELATED-TO` 写的是父记录的 **UID**，而 `records.parent_id` 要的是 **id**，
   * 中间必须有一次"UID → id"的解析；导入后父子可能同批写入，所以查的是**整库**而不是本地草稿。
   *
   * @param uids 待查的外部标识（自动去重、去空）
   * @returns UID → id（未命中的键不存在）
   * @throws RecordsSchemaMissingError 迁移未执行（缺 `external_uid` 列）
   */
  async mapIdByExternalUids(uids: string[]): Promise<Map<string, number>> {
    const unique: string[] = []
    for (const raw of Array.isArray(uids) ? uids : []) {
      if (typeof raw !== 'string') continue
      const text = raw.trim()
      if (!text) continue
      if (!unique.includes(text)) unique.push(text)
    }
    const result = new Map<string, number>()
    if (unique.length === 0) return result

    for (let index = 0; index < unique.length; index += LIMITS.externalUidBatch) {
      const chunk = unique.slice(index, index + LIMITS.externalUidBatch)
      const { data, error } = await cloud.database
        .from('records')
        .select('id,external_uid')
        .in('external_uid', chunk)
      if (error) {
        if (readErrorCode(error) === '42703') {
          throw new RecordsSchemaMissingError(
            '云库缺少 external_uid 字段，请先执行 docs/v2.14/migration.sql 后再导入',
          )
        }
        unwrap({ data: null, error })
      }
      const rows = (data as Array<{ id?: unknown; external_uid?: unknown }> | null) ?? []
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue
        if (typeof row.id !== 'number' || typeof row.external_uid !== 'string') continue
        if (row.external_uid) result.set(row.external_uid, row.id)
      }
    }
    return result
  },

  /**
   * 批量把一组记录挂到同一个父级下（v2.14 P0-2）。
   *
   * 迁移未执行（42703）时**不抛错**：父级关系是导入的附加信息，不该让一次已成功的导入整体失败。
   *
   * @param ids 子记录 id
   * @param parentId 父记录 id
   */
  async setParentIds(ids: number[], parentId: number): Promise<void> {
    const targets = Array.isArray(ids) ? ids.filter((id) => Number.isInteger(id) && id > 0) : []
    if (targets.length === 0 || !Number.isInteger(parentId) || parentId <= 0) return
    const { error } = await cloud.database
      .from('records')
      .update({ parent_id: parentId })
      .in('id', targets)
    if (error && readErrorCode(error) !== '42703') unwrap({ data: null, error })
  },

  /** 底层补丁（snake_case 字段，供 aiService 回写分类/摘要等）。 */
  async patchRecord(id: number, fields: Record<string, unknown>): Promise<InfoRecord> {
    const { data, error } = await cloud.database
      .from('records')
      .update(fields)
      .eq('id', id)
      .select()
    return mapRecord(unwrapRows({ data, error })[0])
  },

  /** 软删除（进回收站）。v2.14 P0-2：连带把「子任务」（`parent_id = id`）一起放进回收站，不留孤儿。 */
  async softDelete(id: number): Promise<void> {
    const nowIso = new Date().toISOString()
    const { data, error } = await cloud.database
      .from('records')
      .update({ is_deleted: true, deleted_at: nowIso })
      .eq('id', id)
      .select()
    unwrapRows({ data, error })
    await softDeleteChildren(id, nowIso)
  },

  /** 恢复（移出回收站）。 */
  async restore(id: number): Promise<void> {
    const { data, error } = await cloud.database
      .from('records')
      .update({ is_deleted: false, deleted_at: null })
      .eq('id', id)
      .select()
    unwrapRows({ data, error })
  },

  /** 彻底删除（物理删除）。 */
  async hardDelete(id: number): Promise<void> {
    const { data, error } = await cloud.database
      .from('records')
      .delete()
      .eq('id', id)
      .select()
    unwrapRows({ data, error })
  },

  /** 切换待办状态（v2.13 R4：置 done 时顺带复位 snooze 状态）。 */
  async updateTodoStatus(id: number, status: TodoStatus): Promise<InfoRecord> {
    const { data, error } = await cloud.database
      .from('records')
      .update({ todo_status: status })
      .eq('id', id)
      .select()
    const updated = mapRecord(unwrapRows({ data, error })[0])
    if (status === 'done' && hasSnoozeState(updated)) {
      await resetSnoozeState(id)
      // 同步返回值：完成后不应再显示「已推迟至 …」
      return { ...updated, snoozedUntil: null, snoozeCount: 0 }
    }
    return updated
  },

  /**
   * 检索候选记录（用于智能关联召回）。
   *
   * v2.13 R1：与 `search()` 共用 `runKeywordQuery()`（多词 AND + tsvector 叠加），
   * 语义保持不变：排除自身（`excludeId`）、按 `created_at DESC`、上限默认 20。
   */
  async searchCandidates(keyword: string, k = LIMITS.searchCandidates, excludeId?: number): Promise<InfoRecord[]> {
    const kw = keyword.trim()
    const build = (): KeywordQuery => {
      let query = cloud.database.from('records').select('*').eq('is_deleted', false)
      if (excludeId !== undefined) query = query.neq('id', excludeId)
      return asKeywordQuery(query)
    }
    const rows = await runKeywordQuery(build, kw, k)
    return rows.map(mapRecord)
  },

  /**
   * 待办未完成 / 已完成总数（v2.13 R2：三段视图的「共 M 条」）。
   *
   * 只发 2 次 head count：三段划分依赖本地日边界与 someday/priority 组合，
   * PostgREST 无法表达，拆成多次 count 再前端容斥既易漏数又易重复计数
   * （见 DESIGN §1.2 计数方案）。
   *
   * @returns `{ pending, done }`；查询失败时抛错（由 UI 统一渲染中文提示）
   */
  async countTodoByStatus(): Promise<{ pending: number; done: number }> {
    const countOf = async (status: TodoStatus): Promise<number> => {
      const { count, error } = await cloud.database
        .from('records')
        .select('id', { count: 'exact' })
        .eq('is_deleted', false)
        .eq('type', 'todo')
        .eq('todo_status', status)
      if (error) unwrap({ data: null, error })
      return count ?? 0
    }
    const [pending, done] = await Promise.all([countOf('pending'), countOf('done')])
    return { pending, done }
  },

  /** 保存关联关系（去重 upsert，按 owner_id+source_id+target_id 唯一约束）。 */
  async saveLinks(sourceId: number, items: RelateResultItem[]): Promise<void> {
    if (items.length === 0) return
    const rows = items.map((it) => ({
      source_id: sourceId,
      target_id: it.targetId,
      score: it.score,
      reason: it.reason ?? null,
    }))
    const { error } = await cloud.database
      .from('record_links')
      .upsert(rows, { onConflict: 'owner_id,source_id,target_id' })
    if (error) throw error
  },

  /** 查询某条记录的关联记录（含目标记录详情）。 */
  async listRelated(
    sourceId: number,
  ): Promise<Array<{ record: InfoRecord; score: number; reason: string | null }>> {
    const { data, error } = await cloud.database
      .from('record_links')
      .select('id, score, reason, target_id')
      .eq('source_id', sourceId)
      .order('score', { ascending: false })
    const links = (unwrap({ data, error }) as Array<{
      id: number
      score: number
      reason: string | null
      target_id: number
    }> | null) ?? []

    if (links.length === 0) return []

    const targetIds = links.map((l) => l.target_id).slice(0, LIMITS.relatedTargets)
    const { data: recData, error: recError } = await cloud.database
      .from('records')
      .select('*')
      .eq('is_deleted', false)
      .in('id', targetIds)
    const rows = (unwrap({ data: recData, error: recError }) as RecordsRow[] | null) ?? []
    const byId = new Map(rows.map((r) => [r.id, r]))

    const result: Array<{ record: InfoRecord; score: number; reason: string | null }> = []
    for (const link of links) {
      const row = byId.get(link.target_id)
      if (row) result.push({ record: mapRecord(row), score: link.score, reason: link.reason })
    }
    return result
  },
}

/** UI 编辑补丁（领域字段，camelCase）。 */
export interface RecordUpdateInput extends Partial<RecordCreateInput> {
  summary?: string | null
  /** 由本条生成的下一期 id（循环回写用）。 */
  recurrenceNextId?: number | null
  /** 链接元数据（P0-C 回写用）。 */
  linkMeta?: LinkMeta | null
}
