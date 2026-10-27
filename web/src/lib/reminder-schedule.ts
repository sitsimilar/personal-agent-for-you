/**
 * 提醒调度判定纯函数（P0-A）。
 *
 * 全部无副作用、无 DOM 依赖：时间一律以 epoch 毫秒传入，时区通过
 * `tzOffsetMinutes` 显式注入（东八区 = 480），单测不依赖机器时区。
 *
 * 语义约定：
 * - `fire`  → 本刻立即通知；
 * - `defer` → 命中免打扰，等到 `atMs`（免打扰结束时刻）再发，**不写去重键**；
 * - `drop`  → 丢弃本刻（已弹过 / 超过 12h / 尚未到点），调用方按需写去重键。
 */

/** 免打扰时段（本地墙钟 HH:mm，允许跨零点）。 */
export interface QuietHours {
  start: string
  end: string
}

/** 单次判定入参。 */
export interface ShouldFireInput {
  /** 提醒应触发时刻（remind_at − 提前量），epoch ms。 */
  fireAtMs: number
  /** 当前时刻，epoch ms。 */
  nowMs: number
  quiet: QuietHours
  quietEnabled: boolean
  /** 已触发时刻（来自去重存储）；有值即视为已弹过。 */
  firedAtMs?: number | null
  /** 时区偏移（分钟），默认取运行时。 */
  tzOffsetMinutes?: number
}

/** 单次判定结果。 */
export interface ShouldFireResult {
  action: 'fire' | 'defer' | 'drop'
  /** defer 时为免打扰结束时刻；其余为 fireAtMs。 */
  atMs: number
}

/** 超过该时长的晚到提醒直接丢弃（不堆积轰炸）。 */
export const STALE_MS = 12 * 60 * 60 * 1000
/** 去重键保留时长（超过即清理）。 */
export const FIRED_KEEP_MS = 30 * 24 * 60 * 60 * 1000
const MS_PER_DAY = 86_400_000

/** 当前运行时相对 UTC 的分钟偏移（东八区 = 480）。 */
export function localTzOffsetMinutes(date: Date = new Date()): number {
  return -date.getTimezoneOffset()
}

/** 'HH:mm' → 一天中的分钟数；非法返回 null。 */
export function parseHhMm(value: string): number | null {
  if (typeof value !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const hour = Number(m[1])
  const minute = Number(m[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return null
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null
  return hour * 60 + minute
}

/** 分钟数 → 'HH:mm'。 */
export function formatHhMm(minuteOfDay: number): string {
  const safe = Math.min(Math.max(Math.floor(minuteOfDay), 0), 24 * 60 - 1)
  const hour = Math.floor(safe / 60)
  const minute = safe % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

/** epoch ms → 指定时区下一天中的分钟数。 */
export function minuteOfDayOf(ms: number, tzOffsetMinutes?: number): number {
  const tz = typeof tzOffsetMinutes === 'number' ? tzOffsetMinutes : localTzOffsetMinutes()
  const d = new Date(ms + tz * 60_000)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/**
 * 是否处于免打扰时段。
 * 支持跨零点（start > end）；`start === end` 视为时段为空，返回 false。
 */
export function isInQuietHours(minuteOfDay: number, start: string, end: string): boolean {
  const s = parseHhMm(start)
  const e = parseHhMm(end)
  if (s === null || e === null) return false
  if (s === e) return false
  const m = Math.min(Math.max(Math.floor(minuteOfDay), 0), 24 * 60 - 1)
  if (s < e) return m >= s && m < e
  // 跨零点：22:00–08:00 → [22:00, 24:00) ∪ [00:00, 08:00)
  return m >= s || m < e
}

/** 提醒实际触发时刻 = remind_at − 提前量；非法输入返回 NaN。 */
export function resolveFireAt(remindAtIso: string, leadMinutes: number): number {
  const ms = Date.parse(remindAtIso)
  if (Number.isNaN(ms)) return Number.NaN
  const lead = Number.isFinite(leadMinutes) ? Math.max(0, Math.floor(leadMinutes)) : 0
  return ms - lead * 60_000
}

/**
 * 命中免打扰时，返回「免打扰结束」的绝对时刻（跨零点正确）。
 * 未命中则原样返回 fireAtMs。
 */
export function quietReleaseAt(fireAtMs: number, quiet: QuietHours, tzOffsetMinutes?: number): number {
  if (!Number.isFinite(fireAtMs)) return fireAtMs
  const tz = typeof tzOffsetMinutes === 'number' ? tzOffsetMinutes : localTzOffsetMinutes()
  if (!isInQuietHours(minuteOfDayOf(fireAtMs, tz), quiet.start, quiet.end)) return fireAtMs

  const endMin = parseHhMm(quiet.end)
  if (endMin === null) return fireAtMs

  const shifted = fireAtMs + tz * 60_000
  const wall = new Date(shifted)
  const dayStart = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate())
  let release = dayStart + endMin * 60_000
  while (release <= shifted) release += MS_PER_DAY
  return release - tz * 60_000
}

/** 单条提醒的判定。 */
export function shouldFire(input: ShouldFireInput): ShouldFireResult {
  const { fireAtMs, nowMs, quiet, quietEnabled, firedAtMs } = input
  if (!Number.isFinite(fireAtMs) || !Number.isFinite(nowMs)) {
    return { action: 'drop', atMs: nowMs }
  }
  if (firedAtMs !== undefined && firedAtMs !== null) {
    return { action: 'drop', atMs: fireAtMs }
  }
  if (nowMs < fireAtMs) {
    return { action: 'drop', atMs: fireAtMs }
  }
  if (nowMs - fireAtMs > STALE_MS) {
    return { action: 'drop', atMs: fireAtMs }
  }
  if (quietEnabled && isInQuietHours(minuteOfDayOf(nowMs, input.tzOffsetMinutes), quiet.start, quiet.end)) {
    return { action: 'defer', atMs: quietReleaseAt(fireAtMs, quiet, input.tzOffsetMinutes) }
  }
  return { action: 'fire', atMs: fireAtMs }
}

/** 去重键：同一条记录的同一次提醒（含 snooze 轮次）只弹一次。 */
export function dedupeKey(recordId: number, remindAt: string, snoozeToken = 0): string {
  const token = Number.isFinite(snoozeToken) ? Math.max(0, Math.floor(snoozeToken)) : 0
  return `${recordId}|${remindAt}|${token}`
}

/** 去重键的三段解析结果。 */
export interface DedupeKeyParts {
  recordId: number
  remindAt: string
  /** snooze 轮次：0 = 原始提醒，n = 第 n 次推迟后的重弹。 */
  snoozeToken: number
}

/**
 * 解析去重键（v2.13 R4 三段式 `id|remind_at|token`）。
 *
 * 兼容 v2.12.2 的**两段式**旧键 `id|remind_at`：第三段缺失时 `snoozeToken = 0`，
 * 因此升级后旧键仍能被正确识别（不重弹），无需迁移 localStorage。
 *
 * @param key 去重键
 * @returns 解析结果；结构非法（段数不足 / id 非法 / 时间不可解析）返回 null
 */
export function parseDedupeKey(key: string): DedupeKeyParts | null {
  if (typeof key !== 'string') return null
  const parts = key.split('|')
  if (parts.length < 2) return null
  const recordId = Number(parts[0])
  const remindAt = parts[1]
  if (!Number.isInteger(recordId) || recordId <= 0) return null
  if (Number.isNaN(Date.parse(remindAt))) return null
  const rawToken = parts.length >= 3 ? Number(parts[2]) : 0
  const snoozeToken = Number.isInteger(rawToken) && rawToken >= 0 ? rawToken : 0
  return { recordId, remindAt, snoozeToken }
}

/** 去重存储（键 → 首次弹出的 epoch ms）。 */
export type FiredStore = Record<string, number>

/**
 * v2.12.2 的两段式旧键 `id|remind_at`。
 *
 * ⚠️ **只用于只读兼容检查**（`reminderService` 判断「升级前是否已弹过」），
 * 新写入一律用三段式 `dedupeKey()`。不要用它做写入，否则 snooze 后无法区分轮次。
 *
 * @param recordId 记录 id
 * @param remindAt 提醒时间（ISO，原样拼进键）
 */
export function legacyDedupeKey(recordId: number, remindAt: string): string {
  return `${recordId}|${remindAt}`
}

/**
 * 清理过期去重键（默认保留 30 天；非法键一并清理）。
 *
 * ⚠️ v2.13 R4 起键为三段式 `id|remind_at|token`：**只能按 `split('|')` 取第 2 段**解析时间。
 * 若沿用旧写法（`key.slice(key.indexOf('|') + 1)`），三段键会变成 `remind_at|token`，
 * `Date.parse` 得 NaN → 键被立即清理 → 表现为「每 30s 弹一次的轰炸」（PRD R4 风险 ①）。
 */
export function pruneFired(store: FiredStore, nowMs: number, keepMs: number = FIRED_KEEP_MS): FiredStore {
  const next: FiredStore = {}
  for (const [key, ts] of Object.entries(store)) {
    if (!Number.isFinite(ts)) continue
    const parts = key.split('|')
    if (parts.length < 2 || parts[0] === '') continue
    const iso = parts[1]
    if (Number.isNaN(Date.parse(iso))) continue
    if (nowMs - ts > keepMs) continue
    next[key] = ts
  }
  return next
}

/**
 * 计算「实际触发时刻」（v2.13 R4）。
 *
 * - 有 `snoozedUntil`（且可解析）：**直接返回它，不再减提前量** ——
 *   「10 分钟后」就是 10 分钟后，否则会二次提前导致刚点完就弹；
 * - 否则回落到 `remind_at − 提前量`（v2.12.2 行为）。
 * - 两者都不可解析时返回 NaN（调用方按 NaN 跳过）。
 *
 * 时钟回拨导致 `snoozedUntil` 落在过去时，这里照实返回过去时刻，
 * 由 `shouldFire()` 走 fire 分支立即补弹一次（不累积、不循环）。
 *
 * @param record 只需 remindAt / snoozedUntil 两个字段
 * @param leadMinutes 提醒提前量（分钟）
 */
export function effectiveFireAt(
  record: { remindAt?: string | null; snoozedUntil?: string | null },
  leadMinutes: number,
): number {
  const snoozed = record.snoozedUntil ? Date.parse(record.snoozedUntil) : Number.NaN
  if (!Number.isNaN(snoozed)) return snoozed
  if (!record.remindAt) return Number.NaN
  return resolveFireAt(record.remindAt, leadMinutes)
}

/**
 * 该记录是否处于「已推迟、且推迟时间还没到」状态（v2.13 R4，供 UI 显示「已推迟至 …」）。
 *
 * 推迟时间一旦过去，这一轮提醒已经重弹过，Chip 就不应再残留——否则用户会看到
 * 一条早已失效的「已推迟至 10:10」。判定与 `effectiveFireAt()` 同口径（都可解析才认）。
 *
 * @param record 只需 snoozedUntil 字段
 * @param nowMs 当前时刻（epoch ms，由调用方注入，本函数不读时钟）
 */
export function isSnoozePending(record: { snoozedUntil?: string | null }, nowMs: number): boolean {
  if (!record.snoozedUntil) return false
  const ms = Date.parse(record.snoozedUntil)
  if (Number.isNaN(ms)) return false
  if (!Number.isFinite(nowMs)) return false
  return ms > nowMs
}
