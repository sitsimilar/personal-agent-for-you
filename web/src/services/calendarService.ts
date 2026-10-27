/**
 * 日历导出服务（v2.13 R6）：取数 + 触发浏览器下载。
 *
 * 分工：文本构造全在 `lib/ics.ts`（纯函数，`DTSTAMP` 由本层注入）；
 * 本层只做「按视图范围取待办 → 构造 → 下载」。不引入服务端、不做订阅 URL。
 */

import { recordService } from '@/services/recordService'
import { resolveViewRange, type CalendarViewMode } from '@/lib/calendar-range'
import { buildIcs, icsFileName, type IcsSource } from '@/lib/ics'
import type { IcsRange, InfoRecord } from '@shared/types/domain'

/** 导出选项（页面传入当前视图状态）。 */
export interface CalendarExportOptions {
  range: IcsRange
  viewMode: CalendarViewMode
  anchor: Date
  includeDone: boolean
}

/** 导出结果。 */
export interface CalendarExportResult {
  content: string
  fileName: string
  /** 产出的 VEVENT 数。 */
  eventCount: number
  /** 产出的 VTODO 数。 */
  todoCount: number
  /** 参与导出的记录条数。 */
  recordCount: number
}

/** 记录 → ics 源的字段裁剪（避免把整个 InfoRecord 传进纯函数）。 */
function toIcsSource(record: InfoRecord): IcsSource {
  return {
    id: record.id,
    title: record.title,
    content: record.content,
    category: record.category ?? null,
    priority: record.priority ?? null,
    todoStatus: record.todoStatus ?? null,
    remindAt: record.remindAt ?? null,
    updatedAt: record.updatedAt,
  }
}

/**
 * 构造导出内容（不触发下载，便于单测与预览）。
 *
 * 范围：`month` / `week` 用当前视图边界按 **`remind_at`** 过滤；`all` 不限区间
 * （含 `remind_at` 为空的待办，它们只出 `VTODO`、无 `DUE`、无 `VEVENT`）。
 *
 * @throws 当前范围没有可导出的待办（不下载空文件）
 */
export async function buildExport(opts: CalendarExportOptions): Promise<CalendarExportResult> {
  let fromIso: string | undefined
  let toIso: string | undefined
  if (opts.range !== 'all') {
    const [start, end] = resolveViewRange(opts.viewMode, opts.anchor)
    fromIso = start.toISOString()
    toIso = end.toISOString()
  }

  const records = await recordService.listTodosForExport({
    fromIso,
    toIso,
    includeDone: opts.includeDone,
  })
  if (records.length === 0) throw new Error('当前范围没有可导出的待办')

  const nowMs = Date.now()
  const { content, todoCount, eventCount } = buildIcs(records.map(toIcsSource), {
    dtstampIso: new Date(nowMs).toISOString(),
    timezone: 'Asia/Shanghai',
    includeDone: opts.includeDone,
  })
  return {
    content,
    fileName: icsFileName(nowMs),
    todoCount,
    eventCount,
    recordCount: records.length,
  }
}

/**
 * 触发浏览器下载（Blob + `<a download>`，用完立即 revoke）。
 *
 * @param fileName 文件名
 * @param content 文件文本
 */
export function downloadIcs(fileName: string, content: string): void {
  const blob = new Blob([content], { type: 'text/calendar;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
}

/** service 单例（与项目其它 service 风格一致）。 */
export const calendarService = { buildExport, downloadIcs }
