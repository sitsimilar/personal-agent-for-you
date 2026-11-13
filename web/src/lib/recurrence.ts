/**
 * 待办循环规则纯函数（P0-B）。
 *
 * 设计要点（见 docs/p0-2026-10/DESIGN-P0.md §3.2）：
 * - 所有「墙钟」运算统一在平移时间轴上做：`shifted = t + tzOffsetMinutes * 60000`，
 *   再用 UTC getter 读写年月日时分，最后平移回来。中国无 DST，不会漂移；
 *   注入 `tzOffsetMinutes` 也让单测与机器时区解耦。
 * - 不引入任何日期库（零新增依赖）。
 * - 每次推进都从「基准时间」（上一期的 remind_at 或完成时刻）出发计算，
 *   daily / weekly / monthly 三条分支互不复用，避免相互干扰。
 */

import type { RecurrenceFreq, RecurrenceMode, RecurrenceRule } from '@shared/types/domain'

const MS_PER_DAY = 86_400_000
const MS_PER_MINUTE = 60_000
/** 周分支遍历上限（约 7.7 年，足够覆盖任何实际使用场景，防死循环）。 */
const WEEK_SCAN_LIMIT = 400
/** 月分支遍历上限（20 年，同上）。 */
const MONTH_SCAN_LIMIT = 240
/** P2-7「下次实例」连续推进上限（daily 约 2.7 年，覆盖任何离线/不同步时长）。 */
const NEXT_INSTANCE_SCAN_LIMIT = 1000

/** 循环推进入参。 */
export interface ComputeNextInput {
  /** 基准提醒时间（ISO）；null 表示无提醒时间。 */
  remindAt: string | null
  /** 完成时刻（ISO）；remindAt 为 null 时作为基准。 */
  nowIso: string
  /** 东八区 = 480（即 -getTimezoneOffset()）；默认取运行时。 */
  tzOffsetMinutes?: number
}

/** 循环推进结果。 */
export interface ComputeNextResult {
  /** 下一期提醒时间（ISO）；null 表示无提醒时间。 */
  nextRemindIso: string | null
  /** 规则是否已结束（超过 endDate）。 */
  ruleEnded: boolean
}

/** 当前运行时相对 UTC 的分钟偏移（东八区 = 480）。 */
export function localTzOffsetMinutes(date: Date = new Date()): number {
  return -date.getTimezoneOffset()
}

/** 把 ISO 字符串解析为毫秒；非法返回 null。 */
function parseIso(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/** 平移轴上的「本地日」字符串（YYYY-MM-DD，可直接字典序比较）。 */
function shiftedDayKey(shiftedMs: number): string {
  const d = new Date(shiftedMs)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 某年某月的天数（monthIndex 从 0 开始）。 */
function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate()
}

/** 间隔归一（非整数/越界回落到 1..99）。 */
function normalizeInterval(interval: unknown): number {
  const n = typeof interval === 'number' && Number.isFinite(interval) ? Math.floor(interval) : 1
  return Math.min(Math.max(n, 1), 99)
}

/** 周几归一：仅 0..6 的整数，升序去重。 */
function normalizeWeekdays(weekdays: unknown): number[] {
  if (!Array.isArray(weekdays)) return []
  const set = new Set<number>()
  for (const item of weekdays) {
    const n = typeof item === 'number' ? Math.floor(item) : Number.NaN
    if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n)
  }
  return [...set].sort((a, b) => a - b)
}

/** endDate 归一：合法的 'YYYY-MM-DD' 才保留。 */
function normalizeEndDate(endDate: unknown): string | null {
  if (typeof endDate !== 'string') return null
  const trimmed = endDate.trim()
  return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : null
}

/**
 * 锚定日号归一（1–31 整数）；非法/缺省返回 null。
 * 缺省时 `advanceMonthly` 回退到基准日号，保证旧数据行为不变。
 */
export function normalizeAnchorDay(value: unknown): number | null {
  const n = typeof value === 'number' ? Math.floor(value) : Number.NaN
  if (!Number.isInteger(n) || n < 1 || n > 31) return null
  return n
}

/**
 * 循环基准模式归一（v2.13 R3）。
 *
 * 只有 `'completion'` 会被保留：`'due'` / 缺省 / 非法值一律返回 `undefined`，
 * 使 `normalizeRecurrenceRule()` 在旧数据上**不新增 JSONB 键**（diff 噪声最小，
 * 且「缺省即 due」这一契约由读取侧统一保证）。
 *
 * @param value 任意来源（JSONB / 表单）的 mode 值
 * @returns `'completion'` 或 `undefined`
 */
export function normalizeMode(value: unknown): RecurrenceMode | undefined {
  return value === 'completion' ? 'completion' : undefined
}

/**
 * 归一化任意来源（JSONB 脏数据 / 表单）的循环规则。
 * 非法结构返回 null（视为「不循环」），保证不会因脏数据抛错。
 */
export function normalizeRecurrenceRule(rule: unknown): RecurrenceRule | null {
  if (!rule || typeof rule !== 'object') return null
  const raw = rule as {
    freq?: unknown
    interval?: unknown
    weekdays?: unknown
    anchorDay?: unknown
    endDate?: unknown
    mode?: unknown
  }
  const freq = raw.freq
  const validFreq: RecurrenceFreq[] = ['daily', 'weekly', 'monthly']
  if (typeof freq !== 'string' || !validFreq.includes(freq as RecurrenceFreq)) return null

  const normalized: RecurrenceRule = {
    freq: freq as RecurrenceFreq,
    interval: normalizeInterval(raw.interval),
    endDate: normalizeEndDate(raw.endDate),
  }
  if (normalized.freq === 'weekly') {
    const weekdays = normalizeWeekdays(raw.weekdays)
    // weekly 未选周几时由 computeNext 用基准日的星期兜底；此处保留空数组语义
    normalized.weekdays = weekdays
  }
  // 仅在合法时保留，避免给旧数据/非 monthly 规则增加无意义字段
  const anchorDay = normalizeAnchorDay(raw.anchorDay)
  if (anchorDay !== null) normalized.anchorDay = anchorDay
  // 仅在 completion 时写键：due / 缺省 / 非法值一律不落键（旧数据 JSONB 保持原样）
  const mode = normalizeMode(raw.mode)
  if (mode) normalized.mode = mode
  return normalized
}

/** 循环规则是否等价于「不重复」。 */
export function isRecurrenceEmpty(rule: RecurrenceRule | null | undefined): boolean {
  return !rule || !rule.freq
}

/**
 * 计算下一期提醒时间。
 *
 * - `remindAt` 为空：`nextRemindIso = null`，仅按 `nowIso` 判断 endDate（上层仍会新建记录）。
 * - 下一期的本地日 > endDate → `ruleEnded = true`，`nextRemindIso = null`；
 *   等于 endDate 时仍然生成（B4）。
 */
export function computeNext(rule: RecurrenceRule, input: ComputeNextInput): ComputeNextResult {
  const tz = typeof input.tzOffsetMinutes === 'number' ? input.tzOffsetMinutes : localTzOffsetMinutes()
  const remindMs = parseIso(input.remindAt)
  const nowMs = parseIso(input.nowIso) ?? Date.now()
  const endDate = normalizeEndDate(rule.endDate)

  // 无提醒时间：不推进时间轴，只判断规则是否已过期
  // （v2.13 R3：completion 模式同样走这条分支 —— 时分无处可取，下一期无提醒时间）
  if (remindMs === null) {
    const shiftedNow = nowMs + tz * MS_PER_MINUTE
    const ended = endDate !== null && shiftedDayKey(shiftedNow) > endDate
    return { nextRemindIso: null, ruleEnded: ended }
  }

  // v2.13 R3：基准时刻由 mode 决定（due = 上一期 remind_at；completion = 完成日的同一时分）
  const baseMs = resolveBaseMs(rule.mode, remindMs, nowMs, tz)
  const shiftedBase = baseMs + tz * MS_PER_MINUTE

  const interval = normalizeInterval(rule.interval)
  const shiftedNext = advance(
    rule.freq,
    interval,
    rule.weekdays,
    normalizeAnchorDay(rule.anchorDay),
    shiftedBase,
  )

  if (shiftedNext === null) {
    // 无法推进（理论上不会发生）：按结束处理，避免上层死循环
    return { nextRemindIso: null, ruleEnded: true }
  }

  if (endDate !== null && shiftedDayKey(shiftedNext) > endDate) {
    return { nextRemindIso: null, ruleEnded: true }
  }

  return { nextRemindIso: new Date(shiftedNext - tz * MS_PER_MINUTE).toISOString(), ruleEnded: false }
}

/** 某时刻「本地日 00:00」对应的真实 epoch 毫秒（在平移轴上取日界，再平移回来）。 */
function localDayStartMs(ms: number, tz: number): number {
  const wall = new Date(ms + tz * MS_PER_MINUTE)
  const shiftedDayStart = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate())
  return shiftedDayStart - tz * MS_PER_MINUTE
}

/**
 * 解析推进的基准时刻（v2.13 R3 唯一改动点）。
 *
 * - `due`（缺省/非法值）：基准 = 上一期 `remind_at`，与 v2.12.2 完全一致；
 * - `completion`：基准 = **完成日**（`nowMs` 的本地日）+ **原 `remind_at` 的本地时分**。
 *   时分取自 `remind_at` 而非完成时刻，是为了保住习惯类待办「每天早上 9 点提醒」的语义
 *   （见 PRD §7 问题 4 的默认假设：23:50 完成、原时分 09:00 → 新一期仍是 09:00）。
 *
 * 后续 `advance()` 三条分支（weekdays 优先 / anchorDay 短月夹取 / endDate 比较）逻辑不变。
 */
function resolveBaseMs(mode: unknown, remindMs: number, nowMs: number, tz: number): number {
  if (normalizeMode(mode) !== 'completion') return remindMs
  const timeOfDay = remindMs - localDayStartMs(remindMs, tz)
  return localDayStartMs(nowMs, tz) + timeOfDay
}

/** 按频率推进平移轴上的时间；无法推进返回 null。 */
function advance(
  freq: RecurrenceFreq,
  interval: number,
  weekdays: number[] | undefined,
  anchorDay: number | null,
  shiftedBase: number,
): number | null {
  if (freq === 'daily') return advanceDaily(interval, shiftedBase)
  if (freq === 'weekly') return advanceWeekly(interval, weekdays, shiftedBase)
  return advanceMonthly(interval, anchorDay, shiftedBase)
}

/** 每天：保留时分，直接加 N 天。 */
function advanceDaily(interval: number, shiftedBase: number): number {
  return shiftedBase + interval * MS_PER_DAY
}

/** 每周：以「基准日所在周的周日」为锚，只在 weekIdx % interval === 0 的周内取日期。 */
function advanceWeekly(interval: number, weekdays: number[] | undefined, shiftedBase: number): number | null {
  const wall = new Date(shiftedBase)
  const dayStart = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate())
  const timeOfDay = shiftedBase - dayStart
  const baseDow = wall.getUTCDay()
  const weekStart = dayStart - baseDow * MS_PER_DAY
  // 先归一再判空：`[9, -1]` 这类全非法数组应回退基准日星期，而不是判为「无法推进」
  const picked = normalizeWeekdays(weekdays)
  const selected = picked.length > 0 ? picked : [baseDow]

  for (let weekIdx = 0; weekIdx <= WEEK_SCAN_LIMIT; weekIdx++) {
    if (weekIdx % interval !== 0) continue
    for (const dow of selected) {
      const candidate = weekStart + weekIdx * 7 * MS_PER_DAY + dow * MS_PER_DAY + timeOfDay
      if (candidate > shiftedBase) return candidate
    }
  }
  return null
}

/**
 * 每月：目标日 = 锚定日号（无锚定取基准日号），短月夹取到当月最后一天；
 * 月份按 interval 递增。锚定日号保证「每月 31 日」在 2 月夹取后仍回到 31 日，
 * 不会逐月漂移（旧数据无 anchorDay 时退化为按基准日号推进）。
 */
function advanceMonthly(interval: number, anchorDay: number | null, shiftedBase: number): number | null {
  const wall = new Date(shiftedBase)
  const year = wall.getUTCFullYear()
  const monthIndex = wall.getUTCMonth()
  const baseDay = wall.getUTCDate()
  const dayStart = Date.UTC(year, monthIndex, baseDay)
  const timeOfDay = shiftedBase - dayStart
  const targetDay = anchorDay ?? baseDay

  for (let step = 1; step <= MONTH_SCAN_LIMIT; step++) {
    const offset = step * interval
    const totalMonth = monthIndex + offset
    const targetYear = year + Math.floor(totalMonth / 12)
    const targetMonth = ((totalMonth % 12) + 12) % 12
    const day = Math.min(targetDay, daysInMonth(targetYear, targetMonth))
    const candidate = Date.UTC(targetYear, targetMonth, day) + timeOfDay
    if (candidate > shiftedBase) return candidate
  }
  return null
}

/** 周几中文标签（0=周日）。 */
const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六']

/**
 * 生成循环规则的中文描述：`每天` / `每 2 天` / `每周一、三` / `每月最后一天`。
 *
 * v2.13 R3：`mode === 'completion'` 时追加 `（按完成日）`，如「每 2 天（按完成日）」。
 *
 * @param rule 循环规则
 * @param remindAt 可选，基准提醒时间；monthly 时用于展示「每月 N 日 / 每月最后一天」。
 */
export function describeRecurrence(
  rule: RecurrenceRule | null | undefined,
  remindAt?: string | null,
): string {
  const normalized = normalizeRecurrenceRule(rule)
  if (!normalized) return ''
  const base = describeRuleBase(normalized, remindAt)
  return normalized.mode === 'completion' ? `${base}（按完成日）` : base
}

/** 描述文案的「频率部分」（不含 mode 后缀）。 */
function describeRuleBase(normalized: RecurrenceRule, remindAt?: string | null): string {
  const interval = normalizeInterval(normalized.interval)

  if (normalized.freq === 'daily') {
    return interval === 1 ? '每天' : `每 ${interval} 天`
  }

  if (normalized.freq === 'weekly') {
    const weekdays = normalized.weekdays ?? []
    const suffix = weekdays.length > 0 ? weekdays.map((d) => WEEKDAY_LABELS[d]).join('、') : ''
    const prefix = interval === 1 ? '每周' : `每 ${interval} 周`
    return suffix ? `${prefix}${suffix}` : prefix
  }

  // monthly
  const dayOfMonth = normalizeAnchorDay(normalized.anchorDay) ?? readDayOfMonth(remindAt)
  const prefix = interval === 1 ? '每月' : `每 ${interval} 个月`
  if (dayOfMonth === null) return prefix
  if (dayOfMonth === 31) return `${prefix}最后一天`
  if (dayOfMonth === 30) return `${prefix} 30 日（2 月取月末）`
  return `${prefix} ${dayOfMonth} 日`
}

/** 读取 ISO 的「本地日号」；非法返回 null。 */
function readDayOfMonth(iso: string | null | undefined): number | null {
  const ms = parseIso(iso)
  if (ms === null) return null
  const d = new Date(ms)
  return d.getDate()
}

/**
 * 卡片用「下次实例」文案（P2-7）：`11-23 10:00`，跨年带年份 `2027-01-04 10:00`。
 *
 * 纯展示，不改规则模型、不落库：
 * - `remindAt` 为空 → `''`（无时间轴可推，与 `computeNext` 的 null 分支对齐）；
 * - 规则已过 `endDate` → `''`（不再给一个不会发生的日期）；
 * - 非法规则 → `''`。
 *
 * @param rule 循环规则
 * @param remindAt 基准提醒时间（ISO）
 * @param options.now 参照时刻，默认当前；`tzOffsetMinutes` 默认取运行时（东八区 480）
 */
export function nextInstanceLabel(
  rule: RecurrenceRule | null | undefined,
  remindAt?: string | null,
  options: { now?: Date; tzOffsetMinutes?: number } = {},
): string {
  const normalized = normalizeRecurrenceRule(rule)
  if (!normalized || !remindAt) return ''
  const now = options.now ?? new Date()
  const tz =
    typeof options.tzOffsetMinutes === 'number' ? options.tzOffsetMinutes : localTzOffsetMinutes(now)
  const nowMs = now.getTime()
  // 本期本身还在未来（最常见：新建了一条「明天 10:00 每 2 天」）→ 下一次就是它，
  // 不能先推进一期，否则会显示成「后天」。
  const remindMs = parseIso(remindAt)
  if (remindMs !== null && remindMs > nowMs) return formatOnShiftedAxis(remindMs, tz, nowMs)
  // `computeNext` 只从基准推**一期**；remind_at 早已过期时（离线多日、跨设备不同步）
  // 需要连续推进到「今天之后」，否则会显示一个已经过去的日期。
  let cursor = remindAt
  let cursorMs = remindMs
  for (let guard = 0; guard < NEXT_INSTANCE_SCAN_LIMIT; guard += 1) {
    const { nextRemindIso } = computeNext(normalized, {
      remindAt: cursor,
      nowIso: now.toISOString(),
      tzOffsetMinutes: tz,
    })
    const nextMs = parseIso(nextRemindIso)
    if (nextMs === null) return ''
    if (nextMs > nowMs) return formatOnShiftedAxis(nextMs, tz, nowMs)
    // 未推进（completion 模式以完成时刻为基准时会原地踏步）→ 放弃，避免死循环
    if (cursorMs !== null && nextMs <= cursorMs) return ''
    cursor = nextRemindIso as string
    cursorMs = nextMs
  }
  return ''
}

/** 在平移时间轴上格式化 `MM-DD HH:mm`（同年）/ `YYYY-MM-DD HH:mm`（跨年），与 computeNext 同源。 */
function formatOnShiftedAxis(ms: number, tzOffsetMinutes: number, nowMs: number): string {
  const shifted = new Date(ms + tzOffsetMinutes * MS_PER_MINUTE)
  const nowShifted = new Date(nowMs + tzOffsetMinutes * MS_PER_MINUTE)
  const monthDay = `${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`
  const time = `${pad2(shifted.getUTCHours())}:${pad2(shifted.getUTCMinutes())}`
  return shifted.getUTCFullYear() === nowShifted.getUTCFullYear()
    ? `${monthDay} ${time}`
    : `${shifted.getUTCFullYear()}-${monthDay} ${time}`
}

/** 两位补零。 */
function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

/**
 * 取 remind_at（或今天）对应的星期，供「重复」控件默认选中（0=周日）。
 * 非法/空输入回落为今天。
 */
export function defaultWeekday(remindAt?: string | null): number {
  const ms = parseIso(remindAt)
  const d = ms === null ? new Date() : new Date(ms)
  return d.getDay()
}
