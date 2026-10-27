/**
 * iCalendar（RFC 5545）文本构造纯函数（v2.13 R6）。
 *
 * 约束（照设计 §1.6 与 §8-4）：
 * - **不读 `Date.now()`**：`DTSTAMP` 由入参 `dtstampIso` 注入，单测可重放；
 * - 不碰 DOM/网络：下载动作在 `services/calendarService.ts`；
 * - 时区统一用 UTC 形式（`20261027T090000Z`）+ 头部 `X-WR-TIMEZONE:Asia/Shanghai`，
 *   **不内嵌 `VTIMEZONE`**（Google / Outlook 对未内嵌的 TZID 行为不一致，UTC 兼容性最好）；
 * - 不导出 `RRULE`（循环规则不展开，见 PRD 非范围）；
 * - 只导出 `type='todo'` 的记录：每条 1 个 `VTODO`，`remind_at` 非空时额外 1 个 `VEVENT`。
 */

import type { IcsRange } from '@shared/types/domain'

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

    lines.push('BEGIN:VTODO')
    lines.push(`UID:record-${record.id}@personal-agent`)
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
      if (lastModified) lines.push(`LAST-MODIFIED:${lastModified}`)
      lines.push('END:VEVENT')
      eventCount += 1
    }
  }

  lines.push('END:VCALENDAR')

  const content = lines.map((line) => foldLine(line)).join(ICS_CRLF) + ICS_CRLF
  return { content, todoCount, eventCount }
}
