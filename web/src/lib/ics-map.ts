/**
 * iCalendar 条目 → 记录草稿的**纯映射层**（日历互通 P0-1 导入层下半第一步）。
 *
 * 约束（与 `lib/ics-parse.ts` 同族）：
 * - **纯函数**：不碰 DOM / 网络 / 存储，也**不读时钟**（`recordMeta.importedAt` 由
 *   `services/icsImportService.ts` 注入）——这样"预览"和"确认导入"看到的是同一批草稿；
 * - 只做语义翻译，不做去重、不做落库：查重与批量写入是 service 的职责；
 * - 分类只认 `shared/constants/categories.ts` 的预置键，绝不在这里自造分类
 *   （自造分类会让侧边栏出现无法配色、无法筛选的孤儿项）。
 *
 * 映射口径（后续改这里前先看一眼产品约定）：
 * | ICS | 本产品 |
 * | --- | --- |
 * | VEVENT | `type='todo'`（有开始时刻的待办，`remindAt = DTSTART`） |
 * | VTODO | `type='todo'`（`remindAt = DUE ?? DTSTART`） |
 * | VJOURNAL | `type='idea'`（笔记，不参与排期；DTSTART 只进 `record_meta`） |
 * | STATUS:CANCELLED | `deleted=true`（导入即进回收站，不悄悄丢数据） |
 * | RELATED-TO | 草稿的 `parentUid`（落库后由 service 解析成 `records.parent_id`） |
 */

import { PRESET_CATEGORY_KEYS } from '@shared/constants/categories'
import type { Priority, RecordMeta, TodoStatus } from '@shared/types/domain'
import type { IcsItem, IcsParseResult } from '@/lib/ics-parse'

/* ============================== 对外契约 ============================== */

/** 导入来源的 iCalendar 组件类型（比 `IcsItem['kind']` 多一层语义命名，便于元数据落库）。 */
export type IcsItemKind = 'event' | 'todo' | 'journal'

/** 一条待落库的草稿（camelCase 领域字段；service 负责转 snake_case 并写入）。 */
export interface IcsImportDraft {
  /** `event`/`todo` → `'todo'`；`journal` → `'idea'`（records.type 的 CHECK 只允许 idea/material/todo）。 */
  type: 'todo' | 'idea'
  /** 已做空标题回退，落库时不会出现空串标题。 */
  title: string
  content: string
  /** 命中的预置分类 key（首个命中者）；无命中为 null。 */
  category: string | null
  /** CATEGORIES 的全部取值（去重去空；含命中分类的那个值）。 */
  tags: string[]
  priority: Priority | null
  todoStatus: TodoStatus | null
  /** 排期时刻（UTC ISO）；笔记恒为 null。 */
  remindAt: string | null
  /** `STATUS:CANCELLED` → true（导入即进回收站）。 */
  deleted: boolean
  /** 外部稳定标识，导入查重的唯一依据（同一文件重复导入必得同一个值）。 */
  externalUid: string
  /**
   * 父条目的外部标识（v2.14 P0-2，来自 `RELATED-TO`）；无则 null。
   *
   * 只存 **UID**，不是 id：导入时父记录可能是同批新写入的，id 要等落库后才存在，
   * 由 `services/icsImportService.ts` 在写入完成后统一解析成 `records.parent_id`。
   */
  parentUid: string | null
  /** 写入 `records.record_meta` 的派生元数据（`importedAt` 由 service 注入）。 */
  recordMeta: RecordMeta
  /** 该草稿来自哪种 iCalendar 组件（UI 预览列表按它显示类型 chip）。 */
  icsKind: IcsItemKind
}

/* ============================== 常量 ============================== */

/**
 * 空标题回退文案。
 *
 * 为什么要回退而不是留空：列表页用 `title || '（无标题）'` 兜底，但 `title` 落库为空串时
 * 搜索（ilike）永远命中不到，用户会以为"导入丢了"。给一个可搜索的占位标题更诚实。
 */
const FALLBACK_TITLE: Readonly<Record<IcsItemKind, string>> = {
  event: '（无标题日程）',
  todo: '（无标题待办）',
  journal: '（无标题笔记）',
}

/** 派生外部标识的前缀（与真实 UID 一眼可区分：`ics-xxxxxxxx` 是算出来的，不是文件里写的）。 */
const DERIVED_UID_PREFIX = 'ics-'

/* ============================== 小工具 ============================== */

/**
 * FNV-1a 32 位哈希 → 8 位小写 hex。
 *
 * 为什么不用 `crypto`：同构要求（浏览器 / Node 都要跑）下 `crypto.subtle` 是异步的，
 * 而映射层必须是同步纯函数；FNV-1a 冲突率对本用途（同一文件的几十上百条）完全够用。
 * 注意用 `Math.imul` 做 32 位乘法，避免 53 位浮点在乘法中丢低位。
 *
 * @param input 参与哈希的字符串
 * @returns 8 位小写十六进制（恒定长度，可直接拼进 UID）
 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/** 状态原文归一（RFC 5545 规定大写，但导出器不一定守规矩）。 */
function normalizeStatus(status: string | null): string {
  return typeof status === 'string' ? status.trim().toUpperCase() : ''
}

/** `RELATED-TO` → 父条目 UID（去空白；空串视作无父级）。 */
function resolveParentUid(relatedTo: string | null): string | null {
  if (typeof relatedTo !== 'string') return null
  const text = relatedTo.trim()
  return text ? text : null
}

/** 取非空标题；空则按类型回退。 */
function resolveTitle(item: IcsItem): string {
  const raw = typeof item.summary === 'string' ? item.summary.trim() : ''
  return raw || FALLBACK_TITLE[normalizeKind(item.kind)]
}

/** 把解析层的 kind 收敛到本层枚举（防止上游将来再加类型时静默落成 event）。 */
function normalizeKind(kind: IcsItem['kind']): IcsItemKind {
  if (kind === 'todo') return 'todo'
  if (kind === 'journal') return 'journal'
  return 'event'
}

/**
 * 外部稳定标识。
 *
 * 优先用文件里真实存在的 `UID`（跨设备、跨次导出都稳定）；
 * 没有 UID 时按「类型 + 标题 + 开始时刻」派生——**同一份文件重复导入必须得到同一个 key**，
 * 否则查重失效、每次导入都会新增一份。这也是唯一不用"导入时间"参与哈希的原因。
 *
 * @param kind 条目类型
 * @param title 已回退的标题
 * @param item 原始条目（取开始/截止时刻）
 */
function resolveExternalUid(kind: IcsItemKind, title: string, item: IcsItem): string {
  const uid = typeof item.uid === 'string' ? item.uid.trim() : ''
  if (uid) return uid
  const when = item.startIso ?? item.dueIso ?? ''
  return `${DERIVED_UID_PREFIX}${fnv1a32(`${kind}|${title}|${when}`)}`
}

/* ============================== 映射函数 ============================== */

/**
 * `PRIORITY` → 本产品优先级。
 *
 * RFC 5545：1 最高、9 最低、**0 表示"未设"**（不是"最高"）。产品只有三档，故按区间收敛：
 * 1–4 → high、5 → medium、6–9 → low；0 / null / 越界 / 非整数一律 null（不猜）。
 *
 * @param raw `IcsItem.priority` 原值
 */
export function mapPriority(raw: number | null | undefined): Priority | null {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null
  if (raw >= 1 && raw <= 4) return 'high'
  if (raw === 5) return 'medium'
  if (raw >= 6 && raw <= 9) return 'low'
  return null
}

/**
 * `CATEGORIES` → 「分类 + 标签」。
 *
 * 口径：**全部取值都进 tags**（信息不丢）；其中若有一个值正好等于预置分类 key，
 * 就用它当 `category`（取第一个命中者），否则 `category = null`。
 * 绝不把"会议"这类自由文本硬塞进分类——预置分类是封闭集合，塞进去会无法配色/无法筛选。
 *
 * @param categories 解析层给出的多值数组（可能含空串与重复）
 */
export function mapCategories(categories: string[]): { category: string | null; tags: string[] } {
  const tags: string[] = []
  const list = Array.isArray(categories) ? categories : []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const text = raw.trim()
    if (!text) continue
    if (!tags.includes(text)) tags.push(text)
  }
  const hit = tags.find((tag) => PRESET_CATEGORY_KEYS.includes(tag))
  return { category: hit ?? null, tags }
}

/**
 * 单条 iCalendar 条目 → 草稿。
 *
 * 类型映射见文件头的表格。两个刻意的取舍：
 * 1. **VEVENT 也落成 `type='todo'`**：本产品没有"日程"类型（records.type 只有 idea/material/todo），
 *    有确定时刻的事项天然是"带提醒的待办"；放进 `remindAt` 后日历/提醒链路自动可用；
 * 2. **VJOURNAL 的 DTSTART 只进 `record_meta.dtstart`**：笔记不排期，否则它会被
 *    `listReminderCandidates` 当成待办提醒，属于典型的"导进来一堆莫名提醒"。
 *
 * @param item 解析层条目
 */
export function toDraft(item: IcsItem): IcsImportDraft {
  const kind = normalizeKind(item.kind)
  const title = resolveTitle(item)
  const status = normalizeStatus(item.status)
  const { category, tags } = mapCategories(item.categories)
  const externalUid = resolveExternalUid(kind, title, item)

  // 笔记不排期、不进待办状态机；event/todo 才走 todo 语义
  const isNote = kind === 'journal'
  const remindAt = isNote ? null : (kind === 'event' ? item.startIso : (item.dueIso ?? item.startIso))
  const todoStatus: TodoStatus | null = isNote ? null : (status === 'COMPLETED' ? 'done' : 'pending')
  // CANCELLED 进回收站：用户可能只是想"这份日历里的已取消项别出现在列表里"，
  // 但直接丢弃等于静默丢数据，放回收站还能找回来。
  const deleted = !isNote && status === 'CANCELLED'

  const recordMeta: RecordMeta = {
    source: 'ics-import',
    externalUid,
    icsKind: kind,
    rrule: item.rrule ?? undefined,
    exdates: item.exdates.length > 0 ? item.exdates : undefined,
    completedAt: item.completedIso ?? undefined,
    // DTSTART 只作元数据（笔记的"记录时刻"、待办的"开始时刻"都留个痕），不参与排期
    dtstart: item.startIso ?? undefined,
    // importedAt 由调用方注入（纯函数不读时钟）
  }

  return {
    type: isNote ? 'idea' : 'todo',
    title,
    content: item.description ?? '',
    category,
    tags,
    priority: mapPriority(item.priority),
    todoStatus,
    remindAt,
    deleted,
    externalUid,
    parentUid: resolveParentUid(item.relatedTo),
    recordMeta,
    icsKind: kind,
  }
}

/**
 * 整份解析结果 → 草稿数组（保持文件内的原始顺序）。
 *
 * @param result `parseIcs()` 的返回值
 */
export function buildDrafts(result: IcsParseResult): IcsImportDraft[] {
  const items = result && Array.isArray(result.items) ? result.items : []
  return items.map((item) => toDraft(item))
}
