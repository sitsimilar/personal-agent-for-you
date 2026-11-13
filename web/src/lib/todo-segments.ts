/**
 * 待办三段视图判定纯函数（v2.13 R2）。
 *
 * 分段口径（见 docs/v2.13/DESIGN-增量.md §1.2 与 §0-D2/D3）：
 *   1. `someday === true`                       → someday（某天）
 *   2. 无 `remindAt` 且 `priority === 'high'`    → today（今天，避免「最该做的事沉到即将」）
 *   3. 无 `remindAt`（其余）                     → upcoming（即将）
 *   4. `remindAt < 本地明日 00:00`（含逾期）      → today
 *   5. 其余                                     → upcoming
 * 五条互斥且完备：每条未完成待办恰好落在一段，因此
 * 「三段条数之和 = 传入集合条数」是恒等式，可直接单测。
 *
 * 时间约定（照抄 lib/recurrence.ts / lib/reminder-schedule.ts 的范式）：
 * 库里一律 UTC ISO，本地日判定在**平移轴**上做
 * （`shifted = t + tzOffsetMinutes * 60000`，再用 UTC getter 读写年月日），
 * 时区通过 `tzOffsetMinutes` 显式注入（东八区 = 480），单测与机器时区解耦。
 * 禁止用 `toISOString().slice(0, 10)` 当本地日。
 *
 * 约束：无副作用、不读 `Date.now()`（`nowMs` 由调用方注入）；不碰 DOM/网络。
 *
 * v2.14 P0-2 增补：`isImportantTodo()` / `filterImportantTodos()`——「重要」筛选的口径
 * （高优先级或今天到期）与三段视图共用同一套本地日算法，故三套 UI 方案下计数必然一致。
 */

import type { InfoRecord, TodoBucket, TodoBucketCounts } from '@shared/types/domain'

/** 一天的毫秒数（中国无 DST，本地日平移不需要额外校正）。 */
const MS_PER_DAY = 86_400_000

/** 当前运行时相对 UTC 的分钟偏移（东八区 = 480）。 */
export function localTzOffsetMinutes(date: Date = new Date()): number {
  return -date.getTimezoneOffset()
}

/** 三段的中文标签（UI 与空态文案共用，避免多处硬编码）。 */
export const BUCKET_LABELS: Record<TodoBucket, string> = {
  today: '今天',
  upcoming: '即将',
  someday: '某天',
}

/**
 * 某一时刻所属「本地日」的 00:00 对应的 epoch 毫秒。
 *
 * @param ms 任意时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function localDayStartMs(ms: number, tzOffsetMinutes?: number): number {
  const tz = typeof tzOffsetMinutes === 'number' ? tzOffsetMinutes : localTzOffsetMinutes()
  const shifted = ms + tz * 60_000
  const wall = new Date(shifted)
  const shiftedDayStart = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate())
  return shiftedDayStart - tz * 60_000
}

/**
 * 「本地明日 00:00」对应的 epoch 毫秒（今天所有时刻都小于它，含逾期）。
 *
 * @param ms 任意时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function nextLocalDayStartMs(ms: number, tzOffsetMinutes?: number): number {
  return localDayStartMs(ms, tzOffsetMinutes) + MS_PER_DAY
}

/** 解析 `remindAt`；空/非法返回 null。 */
function parseRemindAt(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * 判定一条未完成待办所属分段。
 *
 * @param record 只需 `someday` / `remindAt` / `priority` 三个字段
 * @param nowMs 当前时刻（epoch ms，由调用方注入以便单测可重放）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 * @returns 分段标识（五条规则互斥完备，不会返回 undefined）
 */
export function bucketTodo(
  record: Pick<InfoRecord, 'someday' | 'remindAt' | 'priority'>,
  nowMs: number,
  tzOffsetMinutes?: number,
): TodoBucket {
  if (record.someday === true) return 'someday'

  const remindMs = parseRemindAt(record.remindAt)
  if (remindMs === null) {
    // 无提醒时间：高优先级算今天（否则最该做的事会沉到「即将」），其余归即将
    return record.priority === 'high' ? 'today' : 'upcoming'
  }

  // 含逾期：昨天到期仍未完成的待办归「今天」，否则会在三段里凭空消失
  return remindMs < nextLocalDayStartMs(nowMs, tzOffsetMinutes) ? 'today' : 'upcoming'
}

/**
 * 把待办集合按三段拆开（每条只进入一个段，不复制）。
 *
 * @param records 未完成待办集合
 * @param nowMs 当前时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 * @returns 三段各自的数组（为空时是空数组，不是 undefined）
 */
export function splitByBucket(
  records: InfoRecord[],
  nowMs: number,
  tzOffsetMinutes?: number,
): Record<TodoBucket, InfoRecord[]> {
  const result: Record<TodoBucket, InfoRecord[]> = { today: [], upcoming: [], someday: [] }
  for (const record of records) {
    result[bucketTodo(record, nowMs, tzOffsetMinutes)].push(record)
  }
  return result
}

/**
 * 三段计数。
 *
 * `total` 取传入集合条数，故 `today + upcoming + someday === total` 恒成立（单测断言用）。
 *
 * @param records 未完成待办集合
 * @param nowMs 当前时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function bucketCounts(
  records: InfoRecord[],
  nowMs: number,
  tzOffsetMinutes?: number,
): TodoBucketCounts {
  const counts: TodoBucketCounts = { today: 0, upcoming: 0, someday: 0, total: records.length }
  for (const record of records) {
    counts[bucketTodo(record, nowMs, tzOffsetMinutes)] += 1
  }
  return counts
}

/**
 * 「重要」判定（v2.14 P0-2）：`priority === 'high'` **或** `remindAt` 落在**今天**（本地日）。
 *
 * 口径细节：
 * - "今天"是**本地日窗口** `[今日 00:00, 明日 00:00)`，与 `bucketTodo` 的第 4 条同源，
 *   因此逾期（昨天）**不算**重要——逾期的待办本来就已在「今天」段里，再进「重要」只是重复；
 * - 无提醒时间的高优先级也算（与 `bucketTodo` 的第 2 条一致：高优先级不该沉底）；
 * - 纯函数、不读时钟：`nowMs` / `tzOffsetMinutes` 全部注入，保证三套 UI 方案下计数完全一致
 *   （筛选口径与方案无关，只与数据有关）。
 *
 * @param record 只需 `priority` / `remindAt`
 * @param nowMs 当前时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function isImportantTodo(
  record: Pick<InfoRecord, 'priority' | 'remindAt'>,
  nowMs: number,
  tzOffsetMinutes?: number,
): boolean {
  if (record.priority === 'high') return true
  const remindMs = parseRemindAt(record.remindAt)
  if (remindMs === null) return false
  const dayStart = localDayStartMs(nowMs, tzOffsetMinutes)
  return remindMs >= dayStart && remindMs < dayStart + MS_PER_DAY
}

/**
 * 过滤出「重要」待办（保持原顺序）。
 *
 * @param records 未完成待办集合
 * @param nowMs 当前时刻（epoch ms）
 * @param tzOffsetMinutes 时区偏移（分钟），默认取运行时
 */
export function filterImportantTodos(
  records: InfoRecord[],
  nowMs: number,
  tzOffsetMinutes?: number,
): InfoRecord[] {
  return records.filter((record) => isImportantTodo(record, nowMs, tzOffsetMinutes))
}
