/**
 * 日历视图时间边界纯函数（v2.13 R6）。
 *
 * 从 `CalendarPage` 里的 `range` memo 提取，供「日历页取数」与「.ics 导出」共用，
 * 避免同一个「当前月 / 当前周」出现两套口径。
 *
 * 口径：周一为一周起点；月视图 = 当月 1 日 00:00 → 次月 1 日 00:00（左闭右开）；
 * 周视图 = 本周一 00:00 → 下周一 00:00（左闭右开）。
 * 全部用**本地时区**的 `Date` 计算（与页面显示一致），返回后再由调用方转 ISO。
 */

/** 视图模式（与 CalendarPage 的 ViewMode 一致）。 */
export type CalendarViewMode = 'month' | 'week'

/** 清空时分秒。 */
function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

/** 加/减天数。 */
function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** 所在周的周一 00:00。 */
function mondayOf(d: Date): Date {
  const x = startOfDay(d)
  const dow = (x.getDay() + 6) % 7
  return addDays(x, -dow)
}

/**
 * 解析视图边界（左闭右开）。
 *
 * @param viewMode 月 / 周
 * @param anchor 视图锚点日期（通常是「今天」或翻页后的日期）
 * @returns `[start, end)`，均为本地时区的 Date
 */
export function resolveViewRange(viewMode: CalendarViewMode, anchor: Date): [Date, Date] {
  if (viewMode === 'month') {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0)
    return [startOfDay(first), startOfDay(addDays(last, 1))]
  }
  const mon = mondayOf(anchor)
  return [mon, startOfDay(addDays(mon, 7))]
}
