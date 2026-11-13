/**
 * iCalendar（RFC 5545）文本构造纯函数（v2.13 R6 / v2.14 P0-2 增补）。
 *
 * 约束（照设计 §1.6 与 §8-4）：
 * - **不读 `Date.now()`**：`DTSTAMP` 由入参 `dtstampIso` 注入，单测可重放；
 * - 不碰 DOM/网络：下载动作在 `services/calendarService.ts`；
 * - 时区统一用 UTC 形式（`20261027T090000Z`）+ 头部 `X-WR-TIMEZONE:Asia/Shanghai`，
 *   **不内嵌 `VTIMEZONE`**（Google / Outlook 对未内嵌的 TZID 行为不一致，UTC 兼容性最好）；
 * - 只导出 `type='todo'` 的记录：每条 1 个 `VTODO`，`remind_at` 非空时额外 1 个 `VEVENT`。
 *
 * P0-2 增补的四类字段（都是为了"导出去还能被别的日历读成完整任务"）：
 * - `VALARM`（多提醒 / `ACTION:DISPLAY`）：写在 `VEVENT` 上，默认 -15 分钟与准点各一条；
 * - `RRULE`：写在 `VEVENT` 上（`VTODO` 无 `DTSTART` 时带 `RRULE` 违反 RFC 5545 §3.6.2）；
 * - `RELATED-TO;RELTYPE=PARENT`：父任务关系，值沿用本产品的 UID 约定；
 * - `TRANSP`：`VEVENT` 的忙碌/空闲，默认 `OPAQUE`（有提醒的事项视为占用时间）。
 *
 * `parentId` 为空时**一行都不输出**——这一项自身对被导出文件零扰动（快照回归的基线）。
 */

import type { IcsRange, RecurrenceRule } from '@shared/types/domain'

/** 一条待导出的提醒（`VALARM`）。 */
export interface IcsAlarmSpec {
  /** 相对触发（`-PT15M`）或绝对时刻（UTC ISO）。非法值整条跳过。 */
  trigger: string
  /** 展示文案（`ACTION:DISPLAY` 的 DESCRIPTION）；空则回落到事件标题。 */
  description?: string | null
}

/** 导出来源（只声明用到的字段）。 */
export interface IcsSource {
  id: number
  title: string
  content?: string | null
  category?: string | null
  priority?: 'high' | 'medium' | 'low' | null
  todoStatus?: 'pending' | 'done' | null
  remindAt?: string | null
  updatedAt?: string | null
  /** 父记录 id（v2.14 P0-2，导出为 `RELATED-TO;RELTYPE=PARENT`）；空 = 不输出该属性。 */
  parentId?: number | null
  /** 循环规则（v2.14 P0-2，导出为 `RRULE`）；空 = 不输出。 */
  recurrence?: RecurrenceRule | null
  /** 显式提醒；**不传**时按 `opts.alarmOffsetsMinutes` 生成默认多条，传 `[]` 表示不产提醒。 */
  alarms?: IcsAlarmSpec[] | null
  /** 忙碌/空闲（仅 `VEVENT`）；缺省 `'OPAQUE'`。 */
  transparency?: 'OPAQUE' | 'TRANSPARENT' | null
}

/** 构造选项。 */
export interface BuildIcsOptions {
  /** DTSTAMP（注入以便单测可重放；函数内不得读 Date.now）。 */
  dtstampIso: string
  /** 时区声明，默认 'Asia/Shanghai'（仅写进 X-WR-TIMEZONE，不做 VTIMEZONE）。 */
  timezone?: string
  /** VEVENT 时长（分钟），默认 30。 */
  eventDurationMinutes?: number
  /** 是否包含已完成待办（默认 false）。 */
  includeDone?: boolean
  /**
   * 默认提醒偏移（分钟，负数 = 提前；0 = 准点）。缺省 `[-15, 0]`（两条 DISPLAY 提醒），
   * 传空数组表示不产 `VALARM`。
   */
  alarmOffsetsMinutes?: number[]
}

/** 构造结果。 */
export interface BuildIcsResult {
  content: string
  todoCount: number
  eventCount: number
}

/** 行尾统一 CRLF（RFC 5545 要求）。 */
export const ICS_CRLF = '\r\n'
/** 单行最大 UTF-8 字节数（不含 CRLF）。 */
export const ICS_MAX_LINE_BYTES = 75

/** UTF-8 字节长度（不依赖 TextEncoder/Buffer，浏览器与 Node 一致）。 */
export function utf8ByteLength(text: string): number {
  let bytes = 0
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code <= 0xffff) bytes += 3
    else bytes += 4
  }
  return bytes
}

/**
 * RFC 5545 文本转义。
 *
 * 顺序很重要：先转义反斜杠，再转义 `;` `,`，最后把换行变成字面 `\n` 两个字符；
 * 否则 `\` 会被二次转义。
 *
 * @param value 原始文本
 */
export function icsEscape(value: string): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n')
}

/**
 * 按 UTF-8 **字节**折行（超过 75 字节则 CRLF + 单空格续行）。
 *
 * 中文 3 字节/字，不能按字符数折；续行开头的空格本身占 1 字节，也计入下一行。
 *
 * @param line 一行内容（不含 CRLF）
 */
export function foldLine(line: string): string {
  const out: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of Array.from(line)) {
    const len = utf8ByteLength(ch)
    if (bytes + len > ICS_MAX_LINE_BYTES) {
      out.push(current)
      current = ' ' // 续行前缀
      bytes = 1
    }
    current += ch
    bytes += len
  }
  out.push(current)
  return out.join(ICS_CRLF)
}

/**
 * ISO 时间 → iCalendar UTC 形式 `YYYYMMDDTHHMMSSZ`；非法/空返回 null。
 *
 * @param iso ISO 8601 字符串
 */
export function toIcsUtc(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  )
}

/** 优先级映射（RFC 5545：1 最高、9 最低）。 */
function toIcsPriority(priority: IcsSource['priority']): number | null {
  if (priority === 'high') return 1
  if (priority === 'medium') return 5
  if (priority === 'low') return 9
  return null
}

/* ============================== P0-2：UID / 提醒 / 循环 / 父级 ============================== */

/** 默认提醒偏移（分钟）：提前 15 分钟 + 准点各一条。 */
export const DEFAULT_ALARM_OFFSETS_MINUTES: readonly number[] = [-15, 0]

/**
 * 本产品记录的 UID 约定：`record-<id>@personal-agent`。
 *
 * `VTODO`、`VEVENT`、`RELATED-TO` 三处必须同源，否则导回时父级匹配不上
 * （`lib/ics-parse.ts` 读 `RELATED-TO` 的值，`services/icsImportService.ts` 按同一个值查父记录）。
 *
 * @param id 记录 id
 */
export function recordUid(id: number): string {
  return `record-${id}@personal-agent`
}

/**
 * 提醒偏移（分钟）→ RFC 5545 相对触发形式。
 *
 * 只支持分钟粒度（本产品提醒精度就是分钟），`0` 输出 `PT0M`（准点），
 * 负数表示提前。非有限数返回 null（整条提醒跳过，不产出非法 `TRIGGER`）。
 *
 * @param offsetMinutes 相对 `DTSTART` 的偏移分钟数
 */
export function toRelativeTrigger(offsetMinutes: number): string | null {
  if (typeof offsetMinutes !== 'number' || !Number.isFinite(offsetMinutes)) return null
  const minutes = Math.trunc(offsetMinutes)
  const abs = Math.abs(minutes)
  const sign = minutes < 0 ? '-' : ''
  const hours = Math.floor(abs / 60)
  const rest = abs % 60
  const time = hours > 0 ? `${hours}H${rest > 0 ? `${rest}M` : ''}` : `${rest}M`
  return `${sign}PT${time}`
}

/**
 * 归一 `VALARM` 的 `TRIGGER` 值：绝对时刻（ISO）转 UTC 形式，相对形式只做格式校验。
 *
 * @param trigger 原始触发器（`-PT15M` 或 ISO 时刻）
 */
export function normalizeTrigger(trigger: string): string | null {
  const text = typeof trigger === 'string' ? trigger.trim() : ''
  if (!text) return null
  // 相对形式：`[+-]P...`（RFC 5545 duration）；`+PT0M` 归一成 `PT0M`
  if (/^[+-]?P/i.test(text)) return text.replace(/^\+/, '')
  // 绝对形式：ISO 时刻（带不带 Z 都接受，统一成 UTC）
  const utc = toIcsUtc(text)
  return utc
}

/**
 * 循环规则 → `RRULE` 值（不含 `RRULE:` 前缀）；非法规则返回 null（宁可不出重复，也不出脏规则）。
 *
 * 口径：
 * - `interval` 夹取到 1..99（与 `RecurrenceRule` 的约束一致），`1` 时不写 `INTERVAL`；
 * - `weekly` 的 `weekdays` 0=周日…6=周六 → `SU,MO,...`，升序去重；空则交给 `DTSTART` 的星期；
 * - `monthly` 写 `BYMONTHDAY=anchorDay`（短月由日历端各自按"夹到月末"处理）；
 * - `endDate`（本地日，含当日）→ `UNTIL=...T235959Z`。**这是有意的取整**：比 +08 用户的
 *   本地日末宽 8 小时，副作用仅是"00:00–07:59 这类极端时刻可能多出一天"，
 *   换取"不需要在纯函数里做时区换算"（导出层没有时区工具，也不该为了 8 小时引入依赖）；
 * - `mode: 'completion'`（按完成日推进）在 ICS 里没有对应语义，按 `due` 导出——
 *   语义有损，但比"导出去看不出是重复任务"更接近用户预期。
 *
 * @param rule 记录上的循环规则（可为空 / 脏数据）
 */
export function recurrenceToRrule(rule: RecurrenceRule | null | undefined): string | null {
  if (!rule || typeof rule !== 'object') return null
  const freq = rule.freq
  if (freq !== 'daily' && freq !== 'weekly' && freq !== 'monthly') return null

  const interval = Number.isFinite(rule.interval) ? Math.min(99, Math.max(1, Math.trunc(rule.interval))) : 1
  const parts = [`FREQ=${freq.toUpperCase()}`]
  if (interval > 1) parts.push(`INTERVAL=${interval}`)

  if (freq === 'weekly') {
    const names = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
    const days = Array.isArray(rule.weekdays)
      ? [...new Set(rule.weekdays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b)
      : []
    if (days.length > 0) parts.push(`BYDAY=${days.map((d) => names[d]).join(',')}`)
  }

  if (freq === 'monthly') {
    const anchor = rule.anchorDay
    if (typeof anchor === 'number' && Number.isInteger(anchor) && anchor >= 1 && anchor <= 31) {
      parts.push(`BYMONTHDAY=${anchor}`)
    }
  }

  const until = rruleUntil(rule.endDate ?? null)
  if (until) parts.push(`UNTIL=${until}`)

  return parts.join(';')
}

/**
 * `endDate`（`YYYY-MM-DD` 本地日，含当日）→ `UNTIL` 的 UTC 值。
 *
 * @param endDate 本地日字符串
 */
function rruleUntil(endDate: string | null): string | null {
  if (typeof endDate !== 'string') return null
  const matched = /^(\d{4})-(\d{2})-(\d{2})$/.exec(endDate.trim())
  if (!matched) return null
  return `${matched[1]}${matched[2]}${matched[3]}T235959Z`
}

/** 父记录 id 归一（只接受正整数，其余视为"无父级"）。 */
function normalizeParentId(value: number | null | undefined): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * 解析一条记录最终要写出的提醒列表。
 *
 * 显式传了 `alarms`（含空数组）就完全听调用方；没传才按偏移生成默认多条。
 * 这样"导入→导出"能原样带回原来的提醒，而手写记录拿到的是两条默认提醒。
 */
function resolveAlarms(
  explicit: IcsSource['alarms'],
  offsets: readonly number[],
  summary: string,
): IcsAlarmSpec[] {
  if (Array.isArray(explicit)) {
    return explicit.filter((alarm) => alarm && typeof alarm === 'object' && typeof alarm.trigger === 'string')
  }
  const out: IcsAlarmSpec[] = []
  for (const offset of offsets) {
    const trigger = toRelativeTrigger(offset)
    if (trigger) out.push({ trigger, description: summary })
  }
  return out
}

/**
 * 生成 `VALARM` 子组件行（`ACTION:DISPLAY`）。
 *
 * 为什么只挂在 `VEVENT` 上：`VTODO` 里的 `VALARM` 各客户端支持度差异很大
 * （Google Calendar 直接忽略），而本产品导出 `VEVENT` 正是"带提醒的日历事件"，
 * 挂在 `VEVENT` 上才能保证"导进别的日历仍然会响"。
 */
function alarmLines(alarms: IcsAlarmSpec[], summary: string): string[] {
  const lines: string[] = []
  for (const alarm of alarms) {
    const trigger = normalizeTrigger(alarm.trigger)
    if (!trigger) continue
    const description = icsEscape(alarm.description?.trim() || summary)
    lines.push('BEGIN:VALARM')
    lines.push('ACTION:DISPLAY')
    lines.push(`DESCRIPTION:${description}`)
    lines.push(`TRIGGER:${trigger}`)
    lines.push('END:VALARM')
  }
  return lines
}

/**
 * 导出文件名：`personal-agent-YYYYMMDD.ics`（本地日期）。
 *
 * @param nowMs 当前时刻（epoch ms，注入以便单测可重放）
 */
export function icsFileName(nowMs: number): string {
  const d = new Date(nowMs)
  const p = (n: number) => String(n).padStart(2, '0')
  return `personal-agent-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}.ics`
}

/** 导出范围的接口（与 `IcsRange` 对齐，供页面复用类型）。 */
export type IcsExportRange = IcsRange

/**
 * 构造完整 `.ics` 文本。
 *
 * @param records 待导出的待办（已完成是否包含由 `opts.includeDone` 决定，此处再兜一层）
 * @param opts 构造选项
 * @returns 文本与统计（事件数 / 待办数）
 */
export function buildIcs(records: IcsSource[], opts: BuildIcsOptions): BuildIcsResult {
  const timezone = opts.timezone?.trim() || 'Asia/Shanghai'
  const duration =
    typeof opts.eventDurationMinutes === 'number' && Number.isFinite(opts.eventDurationMinutes)
      ? Math.max(1, Math.floor(opts.eventDurationMinutes))
      : 30
  const includeDone = opts.includeDone === true
  const dtstamp = toIcsUtc(opts.dtstampIso) ?? toIcsUtc(new Date(0).toISOString()) ?? '19700101T000000Z'
  const alarmOffsets = Array.isArray(opts.alarmOffsetsMinutes)
    ? opts.alarmOffsetsMinutes
    : [...DEFAULT_ALARM_OFFSETS_MINUTES]

  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//personal-agent//v2.13//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-TIMEZONE:${timezone}`,
  ]

  let todoCount = 0
  let eventCount = 0

  for (const record of records) {
    const done = record.todoStatus === 'done'
    // 双保险：查询层已过滤，这里再挡一次
    if (done && !includeDone) continue

    const summary = icsEscape(record.title?.trim() || '（无标题）')
    const due = toIcsUtc(record.remindAt ?? null)
    const lastModified = toIcsUtc(record.updatedAt ?? null)
    const rrule = recurrenceToRrule(record.recurrence ?? null)
    const parentId = normalizeParentId(record.parentId ?? null)
    const alarms = resolveAlarms(record.alarms, alarmOffsets, record.title?.trim() || '（无标题）')

    lines.push('BEGIN:VTODO')
    lines.push(`UID:${recordUid(record.id)}`)
    lines.push(`DTSTAMP:${dtstamp}`)
    lines.push(`SUMMARY:${summary}`)
    if (record.content && record.content.trim()) lines.push(`DESCRIPTION:${icsEscape(record.content)}`)
    if (record.category && record.category.trim()) lines.push(`CATEGORIES:${icsEscape(record.category)}`)
    const priority = toIcsPriority(record.priority ?? null)
    if (priority !== null) lines.push(`PRIORITY:${priority}`)
    lines.push(`STATUS:${done ? 'COMPLETED' : 'NEEDS-ACTION'}`)
    if (due) lines.push(`DUE:${due}`)
    if (done && lastModified) lines.push(`COMPLETED:${lastModified}`)
    if (lastModified) lines.push(`LAST-MODIFIED:${lastModified}`)
    // 父任务关系：`parentId` 为空时一行都不输出（字段自身零扰动，见文件头）
    if (parentId !== null) lines.push(`RELATED-TO;RELTYPE=PARENT:${recordUid(parentId)}`)
    lines.push('END:VTODO')
    todoCount += 1

    // 有提醒时间的待办额外产出一个日历事件（30 分钟，默认不可配）
    if (due) {
      lines.push('BEGIN:VEVENT')
      lines.push(`UID:record-${record.id}-event@personal-agent`)
      lines.push(`DTSTAMP:${dtstamp}`)
      lines.push(`DTSTART:${due}`)
      lines.push(`DURATION:PT${duration}M`)
      lines.push(`SUMMARY:${summary}`)
      if (record.content && record.content.trim()) lines.push(`DESCRIPTION:${icsEscape(record.content)}`)
      // 忙碌/空闲：有明确提醒时刻的事项默认占用时间（OPAQUE），调用方可改成 TRANSPARENT
      lines.push(`TRANSP:${record.transparency === 'TRANSPARENT' ? 'TRANSPARENT' : 'OPAQUE'}`)
      // RRULE 只写在 VEVENT：VTODO 没有 DTSTART 时带 RRULE 违反 RFC 5545 §3.6.2
      if (rrule) lines.push(`RRULE:${rrule}`)
      if (lastModified) lines.push(`LAST-MODIFIED:${lastModified}`)
      lines.push(...alarmLines(alarms, record.title?.trim() || '（无标题）'))
      lines.push('END:VEVENT')
      eventCount += 1
    }
  }

  lines.push('END:VCALENDAR')

  const content = lines.map((line) => foldLine(line)).join(ICS_CRLF) + ICS_CRLF
  return { content, todoCount, eventCount }
}
