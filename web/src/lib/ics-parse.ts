/**
 * iCalendar（RFC 5545）**解析**纯函数（日历互通 P0-1 导入层上半）。
 *
 * 约束：
 * - **纯函数**：不碰 DOM / 网络 / 存储；输入文本 → 输出结构化结果；同一输入永远同一输出
 *   （当前时刻由 `opts.nowIso` 注入，仅在未注入时才读 `Date.now()` 兜底）；
 * - **任何异常都不外抛**：空文本、非 `VCALENDAR`、`ICAL.parse` 抛错一律转成 `warnings`
 *   （导入 UI 要能"带着残缺数据继续走"，不能因为一个文件炸掉整个导入流程）；
 * - 时区判定见 `resolveTime` 的四类规则；**不能**把 `toJSDate()` 当作唯一路径：
 *   全天事件（`VALUE=DATE`）的 `toJSDate()` 会前移一天（实测 `20261120` → `2026-11-19T16:00Z`），
 *   Windows 时区名（`China Standard Time`，文件内无 `VTIMEZONE`）会被 ical.js 静默按本机时区
 *   解释——在 +08 机器上"看起来是对的"，换台机器就错。所以：
 *   ① 全天必须用 `year/month/day` 拼日期；② 原始 TZID 必须从**属性参数**取
 *   （`prop.getParameter('tzid')`），不能看 `time.zone.tzid`（那是 `'floating'`）。
 *
 * 与 `lib/ics.ts`（导出）对称：那边构造文本、这边还原语义；两边共享"不隐式读时钟"的约定。
 */

import ICAL from 'ical.js'

/* ============================== 对外契约 ============================== */

/** `VALARM`（本产品只关心展示型提醒）。 */
export interface IcsAlarm {
  /** 原始 TRIGGER 值：相对触发器形如 `-PT15M`，绝对触发器给 UTC ISO。 */
  trigger: string
  description: string | null
}

/** 单个展开实例（仅 `event` 有；`todo` / `journal` 恒为空数组）。 */
export interface IcsOccurrence {
  /** UTC ISO（例如 `'2026-11-04T06:00:00.000Z'`）；全天实例为该日**本地** 00:00 的 ISO。 */
  startIso: string
  /**
   * 实例结束时刻：**由 item 级时长推导**（`startIso + durationMs`），优先级**高于**
   * `getOccurrenceDetails().endDate`。
   *
   * 为什么不直接采信 `endDate`：混合写法（`DTSTART;TZID=...` + `DTEND:...Z` + `RRULE`）下，
   * `getOccurrenceDetails()` 返回的 `endDate.zone.tzid` 会退化成 `'floating'`（原文明明是 `Z`），
   * 于是 UTC 值被当成"本地墙钟"按 DTSTART 的 TZID 又换算一次——实测 `07:00Z` 变成前一晚 `23:00Z`，
   * 结束早于开始（负时长）。ical.js 自己的 `Event.duration` 在同一场景是 -25200 秒，同样不可用。
   * 因此实例结束时间只能"在 item 级算一次时长、逐实例套到各自的 `startIso` 上"。
   *
   * 兜底：时长不可用（无 `DTEND`、或算出负数）时，退回 `endDate` 的绝对值解析结果（可能为 null）。
   */
  endIso: string | null
  allDay: boolean
  /** `'YYYY-MM-DD'`：属性里的**墙钟日期**（不受运行机器时区影响）；全天事件以此为准。 */
  localDate: string
  summary: string
  description: string | null
  /** 该实例是否被 `RECURRENCE-ID` 覆盖（`getOccurrenceDetails().item !== master`）。 */
  isOverride: boolean
  /** `RECURRENCE-ID` 换算后的 UTC ISO（即"原定时段"的时刻），非覆盖实例为 null。 */
  recurrenceIdIso: string | null
}

/** 一个日历条目（一条 `VEVENT` / `VTODO` / `VJOURNAL`；同一 UID 的覆盖实例已合并进主事件）。 */
export interface IcsItem {
  /** `journal`（VJOURNAL）只作笔记导入，不展开实例、不参与排期。 */
  kind: 'event' | 'todo' | 'journal'
  uid: string | null
  summary: string
  description: string | null
  location: string | null
  /** `CATEGORIES` 多值全取（`getFirstPropertyValue` 只会给第一个，必须用 `getValues()`）。 */
  categories: string[]
  /** `PRIORITY` 原样 1..9（RFC 5545：1 最高），不做业务映射。 */
  priority: number | null
  /** `STATUS` 原文（`'NEEDS-ACTION'` / `'COMPLETED'` / ...）。 */
  status: string | null
  percentComplete: number | null
  relatedTo: string | null
  completedIso: string | null
  /** `RRULE` 原文但去掉 `'RRULE:'` 前缀（`FREQ=WEEKLY;COUNT=6;BYDAY=WE`）；无则 null。 */
  rrule: string | null
  /** `EXDATE` 的 UTC ISO 列表（各值按自身属性的 TZID 换算）。 */
  exdates: string[]
  isRecurring: boolean
  allDay: boolean
  /** 时间属性上**原始的** TZID 参数（未映射，如 `'China Standard Time'`），无则 null。 */
  tzidRaw: string | null
  /** 归一后的 IANA 时区标识；浮动时间与全天为 null。 */
  tzid: string | null
  startIso: string | null
  /**
   * 结束时刻；无 `DTEND`/`DURATION` 的定时事件按 RFC 5545 视为 0 时长（等于 `startIso`），全天事件为次日同刻。
   *
   * 这个值同时也是**展开实例结束时长的唯一来源**：`occurrences[].endIso` 由
   * `item.startIso/endIso` 求出的时长逐实例套用，优先级高于 `getOccurrenceDetails().endDate`
   * ——后者的 `zone` 会退化为 `floating`，把 UTC 值当墙钟再换算一次就会得到负时长
   * （详见 `IcsOccurrence.endIso`）。
   */
  endIso: string | null
  dueIso: string | null
  alarms: IcsAlarm[]
  /** 仅 `event` 展开；`todo` / `journal` 恒为 `[]`。 */
  occurrences: IcsOccurrence[]
}

/** 解析选项（全部可省略；单测必须注入 `nowIso` 以便重放）。 */
export interface IcsParseOptions {
  /** 单个循环事件的展开上限，默认 200，强制夹取到 `[1, 2000]`（防无 `COUNT/UNTIL` 的 RRULE 死循环）。 */
  maxOccurrences?: number
  /** 展开时间窗（天），默认 730：`now + horizonDays` 之后的实例不再展开。 */
  horizonDays?: number
  /** 注入当前时刻（ISO），默认 `new Date().toISOString()`。 */
  nowIso?: string
}

/** 解析结果。 */
export interface IcsParseResult {
  /** `X-WR-CALNAME`。 */
  calendarName: string | null
  /** `X-WR-TIMEZONE` 原文（不归一，保留来源信息）。 */
  timezone: string | null
  items: IcsItem[]
  /**
   * 非致命问题（实例被截断、只有覆盖实例没有主事件、覆盖实例匹配不上、事件缺 `DTSTART`、
   * `VALARM` 缺 `TRIGGER`……），文案面向用户。
   *
   * 注意：**认不出的 TZID**（如 `Mars Standard Time`）目前**不产生** warning，只把 `tzid` 落 null
   * 并按浮动处理（`tzidRaw` 保留原始值，上层可自行提示）——待产品确认口径。
   */
  warnings: string[]
}

/* ============================== 内部类型 ============================== */

/** ical.js 的类只以默认导出的命名空间暴露，用 `InstanceType` 拿实例类型（无需深层 import 类型）。 */
type IcalComponent = InstanceType<typeof ICAL.Component>
type IcalProperty = InstanceType<typeof ICAL.Property>
type IcalEvent = InstanceType<typeof ICAL.Event>
type IcalTime = InstanceType<typeof ICAL.Time>

/** 时间属性的解析结果。 */
interface ResolvedTime {
  iso: string
  allDay: boolean
  localDate: string
  tzidRaw: string | null
  tzid: string | null
}

/** 一次解析的共享上下文。 */
interface ParseContext {
  warnings: string[]
  maxOccurrences: number
  /** 展开时间窗右界（epoch ms）。 */
  horizonMs: number
}

/* ============================== 常量 ============================== */

const MS_PER_DAY = 86_400_000
const DEFAULT_MAX_OCCURRENCES = 200
const MIN_MAX_OCCURRENCES = 1
const MAX_MAX_OCCURRENCES = 2000
const DEFAULT_HORIZON_DAYS = 730
const MAX_HORIZON_DAYS = 36_500

/**
 * Windows 时区名 → IANA 标识。
 *
 * 为什么必须有这张表：Windows / Outlook 导出的 `TZID=China Standard Time` **不报错**，
 * ical.js 找不到同名 `VTIMEZONE` 时会把值当浮动时间、按**本机**时区解释。
 * +08 机器上"碰巧正确"，换机器即错——这是 P0-1 最容易漏的雷。
 */
const WINDOWS_TZID_MAP: Readonly<Record<string, string>> = {
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
  'China Standard Time': 'Asia/Shanghai',
  'Taipei Standard Time': 'Asia/Taipei',
  'Hong Kong Standard Time': 'Asia/Hong_Kong',
  'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'India Standard Time': 'Asia/Kolkata',
  'SE Asia Standard Time': 'Asia/Bangkok',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'Russian Standard Time': 'Europe/Moscow',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
}

/** 小写键索引（查表大小写不敏感）。 */
const WINDOWS_TZID_LOOKUP: ReadonlyMap<string, string> = new Map(
  Object.keys(WINDOWS_TZID_MAP).map((key) => [key.toLowerCase(), WINDOWS_TZID_MAP[key]]),
)

/** `Intl.DateTimeFormat` 实例缓存（每次 `formatToParts` 都新建 formatter 会明显变慢）。 */
const formatterCache = new Map<string, Intl.DateTimeFormat>()
/** 时区合法性缓存（`Intl` 对非法时区抛 `RangeError`，逐次 try/catch 太浪费）。 */
const timeZoneValidityCache = new Map<string, boolean>()

/* ============================== 时区工具 ============================== */

/**
 * 时区名归一：Windows 名 → IANA，已是 IANA 的原样返回，浮动/空返回 null。
 *
 * 规则（顺序即优先级）：
 * 1. 非字符串 / 空 / `'floating'`（大小写不敏感）→ null；
 * 2. 命中内置表（大小写不敏感）→ 映射后的 IANA 名；
 * 3. 含 `'/'` 视为已是 IANA 名 → 原样返回（保留调用方的大小写，不做"纠正"）；
 * 4. 其余（未知的 Windows 名、裸缩写）→ null（交给上层按浮动处理并加 warning）。
 *
 * @param raw 属性上的原始 TZID 参数
 */
export function normalizeTzid(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower === 'floating') return null
  const mapped = WINDOWS_TZID_LOOKUP.get(lower)
  if (mapped) return mapped
  if (trimmed.includes('/')) return trimmed
  return null
}

/** `Intl` 是否认识这个 IANA 时区标识。 */
function isValidIanaTimeZone(timeZone: string): boolean {
  const cached = timeZoneValidityCache.get(timeZone)
  if (cached !== undefined) return cached
  let ok = true
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') {
      ok = false
    } else {
      // eslint-disable-next-line no-new
      new Intl.DateTimeFormat('en-US', { timeZone })
    }
  } catch {
    ok = false
  }
  timeZoneValidityCache.set(timeZone, ok)
  return ok
}

/** 取（或建）指定时区的 formatter。 */
function getFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone)
  if (cached) return cached
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
  formatterCache.set(timeZone, formatter)
  return formatter
}

/**
 * 指定时刻在目标时区的偏移（分钟，东正西负）。
 *
 * 做法：把 `utcMs` 用目标时区格式化出"墙钟"字段，再把这组字段当作 UTC 反算差值。
 * 这是 `Intl` 只有"时刻 → 墙钟"单向能力时的标准反向解法。
 *
 * @param utcMs 绝对时刻（epoch ms）
 * @param timeZone IANA 时区标识
 * @returns 偏移分钟数；时区非法或格式化失败返回 null
 */
function zoneOffsetMinutes(utcMs: number, timeZone: string): number | null {
  if (!isValidIanaTimeZone(timeZone)) return null
  try {
    const parts = getFormatter(timeZone).formatToParts(new Date(utcMs))
    let year = 0
    let month = 1
    let day = 1
    let hour = 0
    let minute = 0
    let second = 0
    for (const part of parts) {
      if (part.type === 'literal') continue
      const value = Number(part.value)
      if (!Number.isFinite(value)) continue
      if (part.type === 'year') year = value
      else if (part.type === 'month') month = value
      else if (part.type === 'day') day = value
      else if (part.type === 'hour') hour = value === 24 ? 0 : value // 少数实现会给 24
      else if (part.type === 'minute') minute = value
      else if (part.type === 'second') second = value
    }
    const asUtc = Date.UTC(year, month - 1, day, hour, minute, second)
    if (Number.isNaN(asUtc)) return null
    return (asUtc - utcMs) / 60_000
  } catch {
    return null
  }
}

/**
 * 墙钟 → 绝对时刻：把 `2026-11-22 14:00 @ Asia/Shanghai` 换算成 UTC。
 *
 * 两步迭代（标准做法）：先假设"墙钟即 UTC"得到猜测值，用猜测值查该时区的偏移，
 * 校正一次；若校正后落到了另一个偏移（夏令时切换边界），再用新偏移校正第二次。
 * 结果**不依赖运行机器的时区**。
 *
 * @returns epoch ms；时区非法/无法换算返回 null
 */
function wallClockToUtcMs(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string,
): number | null {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second)
  if (Number.isNaN(guess)) return null
  const firstOffset = zoneOffsetMinutes(guess, timeZone)
  if (firstOffset === null) return null
  let result = guess - firstOffset * 60_000
  const secondOffset = zoneOffsetMinutes(result, timeZone)
  if (secondOffset === null) return null
  if (secondOffset !== firstOffset) result = guess - secondOffset * 60_000
  return Number.isNaN(result) ? null : result
}

/* ============================== 通用小工具 ============================== */

/** 左补零。 */
function pad(value: number, length = 2): string {
  return String(Math.trunc(value)).padStart(length, '0')
}

/** 拼 `'YYYY-MM-DD'`。 */
function formatLocalDate(year: number, month: number, day: number): string {
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}`
}

/** 夹取整数到 `[min, max]`；非有限数返回兜底值。 */
function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

/** 该值是不是 `ICAL.Time`（用小写的 `toJSDate` 判据，避免跨包 instanceof 失效）。 */
function isTimeLike(value: unknown): value is IcalTime {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<IcalTime>
  return (
    typeof candidate.toJSDate === 'function' &&
    typeof candidate.year === 'number' &&
    typeof candidate.month === 'number' &&
    typeof candidate.day === 'number'
  )
}

/** `toJSDate()` 的安全包装（非法 Time 会抛）。 */
function safeToIso(time: IcalTime): string | null {
  try {
    const date = time.toJSDate()
    const ms = date instanceof Date ? date.getTime() : NaN
    if (!Number.isFinite(ms)) return null
    return new Date(ms).toISOString()
  } catch {
    return null
  }
}

/** 读属性上的 `TZID` 参数（可能是字符串、数组或缺省）。 */
function readTzidParam(prop: IcalProperty | null): string | null {
  if (!prop) return null
  let raw: unknown
  try {
    raw = prop.getParameter('tzid')
  } catch {
    return null
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    return trimmed ? trimmed : null
  }
  if (Array.isArray(raw) && raw.length > 0) {
    const first = raw[0]
    if (typeof first === 'string') {
      const trimmed = first.trim()
      return trimmed ? trimmed : null
    }
  }
  return null
}

/** 读文本属性（去首尾空白；空串视作 null，避免落库出现 `''`）。 */
function readText(comp: IcalComponent, name: string): string | null {
  let value: unknown
  try {
    value = comp.getFirstPropertyValue(name)
  } catch {
    return null
  }
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return null
  const text = String(value).trim()
  return text ? text : null
}

/** 读数值属性（ical.js 有时给字符串），非法返回 null。 */
function readNumber(comp: IcalComponent, name: string): number | null {
  let value: unknown
  try {
    value = comp.getFirstPropertyValue(name)
  } catch {
    return null
  }
  if (value === null || value === undefined || typeof value === 'object') return null
  const num = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(num) ? num : null
}

/** 读时间属性（`DUE` / `COMPLETED` 等）。 */
function readTimeProp(comp: IcalComponent, name: string): { time: IcalTime | null; tzidRaw: string | null } {
  const prop = comp.getFirstProperty(name)
  if (!prop) return { time: null, tzidRaw: null }
  const value = prop.getFirstValue()
  return { time: isTimeLike(value) ? value : null, tzidRaw: readTzidParam(prop) }
}

/* ============================== 时间判定（五类规则） ============================== */

/**
 * 把一个 `ICAL.Time` 归一成"UTC ISO + 本地日期 + 时区标识"。
 *
 * 判定顺序（每个时间属性独立判定，`tzidRaw` 来自**该属性**的参数）：
 * 1. `isDate === true` → 全天：`localDate` 用 `year/month/day` 拼，`startIso` 用**本机**
 *    该日 00:00 的 ISO（绝不用 `toJSDate()`，否则 `20261120` 会掉到 11-19）；
 * 2. 值自带 `Z`（`zone.tzid === 'UTC'`）→ 绝对时刻已确定，**优先**于任何 TZID 参数
 *    （属性没写 TZID 时我们会把 DTSTART 的时区当缺省回退给 DTEND，UTC 值不能被这个回退覆盖）；
 * 3. 原始 TZID 参数能归一成 IANA → 墙钟按该区换算（Windows 名靠这一步救回来）；
 * 4. ical.js 已用 `VTIMEZONE` 解析出真实时区 → 直接用 `toJSDate()`；
 * 5. 其余（真浮动：无 TZID 也无 `Z`）→ 用 `toJSDate()`，按本机本地时区解释（符合 RFC 5545）。
 *
 * @param time ical.js 的时间值
 * @param tzidRaw 该属性上原始的 TZID 参数
 * @returns 归一结果；时间非法时返回 null
 */
function resolveTime(time: IcalTime | null, tzidRaw: string | null): ResolvedTime | null {
  if (!time) return null
  const localDate = formatLocalDate(time.year, time.month, time.day)

  // 规则 1：VALUE=DATE 全天 —— 只能走墙钟日期
  if (time.isDate) {
    const localMidnight = new Date(time.year, time.month - 1, time.day, 0, 0, 0, 0)
    const ms = localMidnight.getTime()
    if (!Number.isFinite(ms)) return null
    return { iso: new Date(ms).toISOString(), allDay: true, localDate, tzidRaw: null, tzid: null }
  }

  const zoneTzid = time.zone && typeof time.zone.tzid === 'string' ? time.zone.tzid : null

  // 规则 2（前置）：值本身带 `Z`（`zone.tzid === 'UTC'`）→ 绝对时刻已经确定，**必须**直接采信。
  // 为什么排在墙钟换算之前：`DTEND` 常写 `20261122T070000Z`，而我们把 DTEND 缺省 TZID 回退成了
  // DTSTART 的时区（RFC 允许两者一致，所以回退本身是对的）。若不先认 UTC，就会把一个 UTC 值
  // 再当 "+08 墙钟" 换算一次 → endIso 比 startIso 早 8 小时（负时长）。
  if (zoneTzid && zoneTzid.toLowerCase() === 'utc') {
    const iso = safeToIso(time)
    if (iso) return { iso, allDay: false, localDate, tzidRaw, tzid: 'UTC' }
  }

  // 规则 3：属性带可归一 TZID —— 自己换算墙钟（不依赖 ical.js 是否认得该 TZID）
  const iana = normalizeTzid(tzidRaw)
  if (tzidRaw && iana) {
    const ms = wallClockToUtcMs(time.year, time.month, time.day, time.hour, time.minute, time.second, iana)
    if (ms !== null) {
      return { iso: new Date(ms).toISOString(), allDay: false, localDate, tzidRaw, tzid: iana }
    }
  }

  // 规则 4：ical.js 已用 VTIMEZONE 解析出真实时区
  if (zoneTzid && zoneTzid.toLowerCase() !== 'floating') {
    const iso = safeToIso(time)
    if (iso) {
      return { iso, allDay: false, localDate, tzidRaw, tzid: normalizeTzid(zoneTzid) ?? zoneTzid }
    }
  }

  // 规则 5：真浮动时间 —— 按本机本地时区解释
  const iso = safeToIso(time)
  if (!iso) return null
  return { iso, allDay: false, localDate, tzidRaw, tzid: null }
}

/**
 * 解析一个属性可能包含的**多个**时间值（`EXDATE` 支持逗号分隔多值）。
 *
 * @param prop 时间属性
 */
function resolvePropertyTimes(prop: IcalProperty | null): ResolvedTime[] {
  if (!prop) return []
  const tzidRaw = readTzidParam(prop)
  let values: unknown[]
  try {
    values = prop.getValues()
  } catch {
    return []
  }
  const out: ResolvedTime[] = []
  for (const value of values) {
    if (!isTimeLike(value)) continue
    const resolved = resolveTime(value, tzidRaw)
    if (resolved) out.push(resolved)
  }
  return out
}

/* ============================== 时长推导 ============================== */

/**
 * 从一对**已解析**的起止时刻求时长（毫秒）。
 *
 * 负值一律视为**不可用**（返回 null）：它只可能来自"起点和终点不在同一时间基准"
 * 这类非法混合写法（例如 `DTEND` 的 `Z` 值被当成 TZID 墙钟又换算了一次）。
 * 宁可回退到别的路径，也不能把负时长写进 `occurrences`——11-03 会直接拿它落库。
 *
 * @param start 起点（已归一）
 * @param end 终点（已归一）
 * @returns 毫秒时长（`>= 0`）；任一端缺失/非法、或算出负值返回 null
 */
function durationBetween(start: ResolvedTime | null, end: ResolvedTime | null): number | null {
  if (!start || !end) return null
  const startMs = Date.parse(start.iso)
  const endMs = Date.parse(end.iso)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null
  const diff = endMs - startMs
  return diff < 0 ? null : diff
}

/** 时长是否可用（非负有限数）；`undefined` 也视为不可用。 */
function isUsableDuration(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * 从一个组件自身的 `DTSTART` / `DTEND` 求时长（毫秒）。
 *
 * 用于 `RECURRENCE-ID` 覆盖实例：用户可能把 1 小时的会议改成 2 小时，
 * 所以覆盖实例必须用它**自己组件**的时间属性求时长，求不出来才回退主事件的时长。
 * 走 `resolveTime` 而不是 `toJSDate()`，才能同时救回 Windows TZID 与 `Z` 混写两种坑。
 *
 * @param event 已构造好的 `ICAL.Event`（其 `component` 为该覆盖实例组件）
 * @returns 毫秒时长；`DTSTART`/`DTEND` 不可解析或时长为负返回 null
 */
function eventDurationMs(event: IcalEvent): number | null {
  const comp = event.component
  const startTzidRaw = dtstartTzidRaw(comp)
  const start = resolveTime(safeStartDate(event), startTzidRaw)
  // DTEND 未写 TZID 时按 RFC 5545 沿用 DTSTART 的时区；`Z` 形式由 `resolveTime` 的规则 2 优先认定
  const endTzidRaw = dtendTzidRaw(comp) ?? startTzidRaw
  const end = resolveTime(safeEndDate(event), endTzidRaw)
  return durationBetween(start, end)
}

/**
 * 兜底保护：结束时刻不得早于开始时刻。
 *
 * 只在"时长不可用、退回 `endDate` 绝对值解析"这条兜底路上生效。会出现"结束早于开始"
 * 的唯一场景是**源文件自相矛盾**（同一个 `Z` 值被写进了两个不同时间基准的属性，例如
 * `DTSTART;TZID=Europe/London:20261122T140000` + `DTEND:20261122T070000Z`，起止差 -7 小时）。
 * 这种区间对落库毫无意义，宁可把结束时间标为**未知**（null），也不要把负时长写进 `occurrences`
 * （11-03 会直接拿它落库）。
 *
 * @param startIso 实例开始时刻（已确定）
 * @param endIso 实例结束时刻（可能来自兜底解析）
 * @returns 合法（或无法比较）时原样返回；早于开始时刻时返回 null（结束未知）
 */
function clampEndIso(startIso: string, endIso: string | null): string | null {
  if (endIso === null) return null
  const startMs = Date.parse(startIso)
  const endMs = Date.parse(endIso)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return endIso
  return endMs < startMs ? null : endIso
}

/* ============================== 条目构造 ============================== */

/** 读 `VALARM` 列表。 */
function buildAlarms(comp: IcalComponent, ctx: ParseContext, uid: string | null): IcsAlarm[] {
  const alarms: IcsAlarm[] = []
  let nodes: IcalComponent[] = []
  try {
    nodes = comp.getAllSubcomponents('valarm')
  } catch {
    return alarms
  }
  for (const node of nodes) {
    const prop = node.getFirstProperty('trigger')
    if (!prop) {
      ctx.warnings.push(`提醒缺少 TRIGGER，已忽略（UID ${uid ?? '（无）'}）`)
      continue
    }
    const tzidRaw = readTzidParam(prop)
    const raw = prop.getFirstValue()
    let trigger = ''
    if (isTimeLike(raw)) {
      // 绝对触发器：换算成 UTC ISO，跨端可用
      trigger = resolveTime(raw, tzidRaw)?.iso ?? (raw.toString() || '')
    } else if (raw !== null && raw !== undefined && typeof (raw as { toString?: unknown }).toString === 'function') {
      // 相对触发器（ICAL.Duration）：toString() 就是 RFC 形式（'-PT15M'）
      trigger = String(raw)
    }
    alarms.push({ trigger, description: readText(node, 'description') })
  }
  return alarms
}

/** 读 `RRULE` 原文（去掉 `'RRULE:'` 前缀）。 */
function readRrule(comp: IcalComponent): string | null {
  const prop = comp.getFirstProperty('rrule')
  if (!prop) return null
  try {
    const value = prop.getFirstValue()
    if (value && typeof (value as { toString?: unknown }).toString === 'function') {
      const text = String(value).trim()
      if (text) return text
    }
    const ical = prop.toICALString()
    const index = ical.indexOf(':')
    const sliced = index >= 0 ? ical.slice(index + 1).trim() : ical.trim()
    return sliced || null
  } catch {
    return null
  }
}

/** 读 `CATEGORIES` 全部取值（多属性 + 多值）。 */
function readCategories(comp: IcalComponent): string[] {
  const values: string[] = []
  let props: IcalProperty[] = []
  try {
    props = comp.getAllProperties('categories')
  } catch {
    return values
  }
  for (const prop of props) {
    let list: unknown[] = []
    try {
      list = prop.getValues()
    } catch {
      list = []
    }
    for (const item of list) {
      const text = typeof item === 'string' ? item.trim() : ''
      if (text) values.push(text)
    }
  }
  return values
}

/**
 * 构造一个展开实例。
 *
 * 结束时刻的取值优先级：
 * 1. `durationMs` 可用（非负有限数）→ `startIso + durationMs`（**这是循环展开的唯一正确路径**：
 *    `getOccurrenceDetails().endDate` 在 `DTSTART;TZID=...` + `DTEND:...Z` 混合写法下会退化成
 *    `floating`，再按 TZID 换算一次就得到负时长）；
 * 2. 否则退回 `end` 的绝对值解析（非循环事件的单条实例、以及时长不可用的兜底）。
 */
function makeOccurrence(params: {
  start: IcalTime | null
  end: IcalTime | null
  tzidRaw: string | null
  endTzidRaw: string | null
  /** 该实例应使用的时长（毫秒）；不可用时回退到 `end` 的绝对值。 */
  durationMs?: number | null
  summary: string
  description: string | null
  isOverride: boolean
  recurrenceId: IcalTime | null
}): IcsOccurrence | null {
  const startResolved = resolveTime(params.start, params.tzidRaw)
  if (!startResolved) return null

  let endIso: string | null
  const startMs = Date.parse(startResolved.iso)
  if (isUsableDuration(params.durationMs) && Number.isFinite(startMs)) {
    endIso = new Date(startMs + params.durationMs).toISOString()
  } else {
    const endResolved = resolveTime(params.end, params.endTzidRaw ?? params.tzidRaw)
    endIso = endResolved ? endResolved.iso : null
  }

  return {
    startIso: startResolved.iso,
    endIso,
    allDay: startResolved.allDay,
    localDate: startResolved.localDate,
    summary: params.summary,
    description: params.description,
    isOverride: params.isOverride,
    recurrenceIdIso: params.recurrenceId ? (resolveTime(params.recurrenceId, params.tzidRaw)?.iso ?? null) : null,
  }
}

/** 安全读 `Event.startDate`（无 DTSTART 时 getter 会抛）。 */
function safeStartDate(event: IcalEvent): IcalTime | null {
  try {
    const value = event.startDate
    return isTimeLike(value) ? value : null
  } catch {
    return null
  }
}

/** 安全读 `Event.endDate`（无 DTEND 时按 DURATION / DATE 规则推算，可能抛）。 */
function safeEndDate(event: IcalEvent): IcalTime | null {
  try {
    const value = event.endDate
    return isTimeLike(value) ? value : null
  } catch {
    return null
  }
}

/** 安全读 `Event.summary` / `Event.description`。 */
function safeEventText(event: IcalEvent, field: 'summary' | 'description'): string | null {
  try {
    const value = event[field]
    if (typeof value !== 'string') return null
    return value.trim() ? value : null
  } catch {
    return null
  }
}

/** 某个组件的 `DTSTART` TZID 参数。 */
function dtstartTzidRaw(comp: IcalComponent): string | null {
  return readTzidParam(comp.getFirstProperty('dtstart'))
}

/** 某个组件的 `DTEND` TZID 参数。 */
function dtendTzidRaw(comp: IcalComponent): string | null {
  return readTzidParam(comp.getFirstProperty('dtend'))
}

/** 该组件是否是 `RECURRENCE-ID` 覆盖实例。 */
function hasRecurrenceId(comp: IcalComponent): boolean {
  return comp.getFirstProperty('recurrence-id') !== null
}

/**
 * 一个 `RECURRENCE-ID` 覆盖实例的预解析结果。
 *
 * 为什么要自己算一遍：ical.js 的 `relateException()` 是按 `ICAL.Time` 的**字符串键**匹配的，
 * 当 `DTSTART;TZID=Asia/Shanghai:...T140000`（文件内无 VTIMEZONE → 浮动）而
 * `RECURRENCE-ID:...T060000Z`（UTC）时，两个键永远对不上，覆盖会被**静默**丢弃：
 * 用户改过的会议退回原时间且没有任何提示。所以这里把 RECURRENCE-ID 用**它自己属性的 TZID**
 * 归一成绝对时刻，再用"绝对时刻相等"去匹配实例（比字符串键更正确）。
 */
interface ExceptionInfo {
  comp: IcalComponent
  /** `RECURRENCE-ID` 归一后的 UTC ISO（原定时段）。 */
  recurrenceIdIso: string | null
  start: ResolvedTime | null
  end: ResolvedTime | null
  /** 该覆盖实例自己的时长（毫秒，`start → end`）；不可用（缺失/负值）为 null。 */
  durationMs: number | null
  summary: string
  description: string | null
  /** 是否已生效（ical.js 生效或本层兜底替换）。 */
  applied: boolean
}

/** 预解析覆盖实例。 */
function collectExceptions(exceptions: IcalComponent[]): ExceptionInfo[] {
  const infos: ExceptionInfo[] = []
  for (const comp of exceptions) {
    const ridProp = comp.getFirstProperty('recurrence-id')
    if (!ridProp) continue
    const recurrenceIdIso = resolveTime(toTimeOrNull(ridProp), readTzidParam(ridProp))?.iso ?? null

    let event: IcalEvent | null = null
    try {
      event = new ICAL.Event(comp)
    } catch {
      event = null
    }
    const startTzidRaw = dtstartTzidRaw(comp)
    const endTzidRaw = dtendTzidRaw(comp) ?? startTzidRaw
    const start = resolveTime(event ? safeStartDate(event) : toTimeOrNull(comp.getFirstProperty('dtstart')), startTzidRaw)
    const end = resolveTime(event ? safeEndDate(event) : toTimeOrNull(comp.getFirstProperty('dtend')), endTzidRaw)

    infos.push({
      comp,
      recurrenceIdIso,
      start,
      end,
      durationMs: durationBetween(start, end),
      summary: readText(comp, 'summary') ?? '',
      description: readText(comp, 'description'),
      applied: false,
    })
  }
  return infos
}

/**
 * 展开循环事件。
 *
 * 只用 ical.js 的 `iterator()` + `getOccurrenceDetails()` 做"序列生成"与"键能对上时的覆盖替换"，
 * **不手写展开逻辑**；但它有两处键匹配会漏（都出现在"显式 TZID + 无 VTIMEZONE + 对方用 `Z`"的组合里），
 * 所以这里补两道基于**绝对时刻**的兜底：
 * 1. `EXDATE` 未被 ical.js 剔除（EXDATE 用 `...Z`、DTSTART 是浮动）→ 用自己算好的 `exdates` 剔除；
 * 2. `RECURRENCE-ID` 覆盖未生效（覆盖用 `...Z`）→ 用绝对时刻匹配后替换该条实例。
 * 补完仍对不上的覆盖实例会 push 一条 warning，绝不静默丢数据。
 *
 * @param master 主事件（已 `relateException` 挂好覆盖实例）
 * @param exceptionComps 覆盖实例组件（用于兜底匹配）
 * @param exdates 主事件 `EXDATE` 归一后的 UTC ISO 列表（用于兜底剔除）
 * @param ctx 解析上下文
 * @param uid 事件 UID（warning 文案用）
 * @param masterDurationMs 主事件的时长（毫秒，由 item 级的 `startIso`/`endIso` 求出）；
 *   不可用（null / 负数）时实例结束时间退回 `details.endDate` 的绝对值解析
 */
function expandOccurrences(
  master: IcalEvent,
  exceptionComps: IcalComponent[],
  exdates: string[],
  ctx: ParseContext,
  uid: string | null,
  masterDurationMs: number | null,
): IcsOccurrence[] {
  const occurrences: IcsOccurrence[] = []
  const exceptionInfos = collectExceptions(exceptionComps)
  const exceptionByKey = new Map<string, ExceptionInfo>()
  for (const info of exceptionInfos) {
    if (info.recurrenceIdIso) exceptionByKey.set(info.recurrenceIdIso, info)
  }
  const exdateSet = new Set(exdates)

  let iterator: ReturnType<IcalEvent['iterator']>
  try {
    iterator = master.iterator()
  } catch (error) {
    ctx.warnings.push(`循环规则无法展开，已按单次事件处理（UID ${uid ?? '（无）'}）：${errorMessage(error)}`)
    return occurrences
  }

  let truncatedByCount = false
  let truncatedByHorizon = false
  // 安全闸：即便 maxOccurrences / horizonDays 都被放大，也不让迭代无限跑下去
  const hardLimit = ctx.maxOccurrences * 4 + 1000

  let step = 0
  for (; step < hardLimit; step += 1) {
    let next: IcalTime | null = null
    try {
      next = iterator.next() as IcalTime | null
    } catch (error) {
      ctx.warnings.push(`循环展开中断（UID ${uid ?? '（无）'}）：${errorMessage(error)}`)
      break
    }
    if (!next) break

    let details: ReturnType<IcalEvent['getOccurrenceDetails']>
    try {
      details = master.getOccurrenceDetails(next)
    } catch (error) {
      ctx.warnings.push(`实例信息读取失败已跳过（UID ${uid ?? '（无）'}）：${errorMessage(error)}`)
      continue
    }

    const isOverride = details.item !== master
    const comp = details.item.component
    // 结束时间一律"起点 + 时长"推导，不用 details.endDate（其 zone 会退化成 floating，见 IcsOccurrence.endIso）。
    // 覆盖实例用它**自己组件**的 DTSTART/DTEND 求时长（用户可能把 1 小时改成 2 小时），
    // 求不出来才回退主事件时长；全天事件不特殊处理：时长 1 天 + 本地零点 → 次日本地零点，自然成立。
    const effectiveDurationMs = isOverride
      ? (eventDurationMs(details.item) ?? masterDurationMs)
      : masterDurationMs
    const occurrence = makeOccurrence({
      start: details.startDate,
      end: details.endDate,
      tzidRaw: dtstartTzidRaw(comp),
      endTzidRaw: dtendTzidRaw(comp),
      durationMs: effectiveDurationMs,
      summary: safeEventText(details.item, 'summary') ?? '',
      description: safeEventText(details.item, 'description'),
      isOverride,
      recurrenceId: details.recurrenceId,
    })
    if (!occurrence) continue
    // 兜底路径（时长不可用）可能解析出"结束早于开始"，这里统一夹一次（见 clampEndIso）。
    // 非循环事件的单条实例不走这里，保持原有行为。
    occurrence.endIso = clampEndIso(occurrence.startIso, occurrence.endIso)

    // 兜底 1：EXDATE 键对不上时 ical.js 不会剔除（如 EXDATE 用 `...Z`）→ 按绝对时刻自己剔
    if (!occurrence.isOverride && occurrence.recurrenceIdIso && exdateSet.has(occurrence.recurrenceIdIso)) {
      continue
    }

    // 时间窗：超出 now + horizonDays 的实例不再展开
    const startMs = Date.parse(occurrence.startIso)
    if (Number.isFinite(startMs) && startMs > ctx.horizonMs) {
      truncatedByHorizon = true
      break
    }
    if (occurrences.length >= ctx.maxOccurrences) {
      truncatedByCount = true
      break
    }

    // ical.js 已生效的覆盖：用覆盖实例**自己的** RECURRENCE-ID 键登记，避免"部分生效"时漏判
    if (isOverride) {
      const ridProp = comp.getFirstProperty('recurrence-id')
      const ridIso = ridProp ? (resolveTime(toTimeOrNull(ridProp), readTzidParam(ridProp))?.iso ?? null) : null
      if (ridIso) {
        const info = exceptionByKey.get(ridIso)
        if (info) info.applied = true
      }
    }

    occurrences.push(occurrence)
  }

  // 兜底 2：覆盖未生效（ical.js 键对不上）→ 按绝对时刻替换该条实例
  for (let index = 0; index < occurrences.length; index += 1) {
    const occurrence = occurrences[index]
    if (occurrence.isOverride || !occurrence.recurrenceIdIso) continue
    const info = exceptionByKey.get(occurrence.recurrenceIdIso)
    if (!info || !info.start) continue
    // 结束时刻同样走"起点 + 时长"（正常情况下与 `info.end.iso` 完全等价，
    // 但能挡住"混合时区导致负时长"这种非法写法污染落库数据）
    const overrideStartMs = Date.parse(info.start.iso)
    const overrideEndIso = isUsableDuration(info.durationMs) && Number.isFinite(overrideStartMs)
      ? new Date(overrideStartMs + info.durationMs).toISOString()
      : (info.end ? info.end.iso : null)
    occurrences[index] = {
      startIso: info.start.iso,
      endIso: clampEndIso(info.start.iso, overrideEndIso),
      allDay: info.start.allDay,
      localDate: info.start.localDate,
      summary: info.summary,
      description: info.description,
      isOverride: true,
      recurrenceIdIso: occurrence.recurrenceIdIso,
    }
    info.applied = true
  }

  for (const info of exceptionInfos) {
    if (info.applied) continue
    if (!info.recurrenceIdIso) {
      ctx.warnings.push(`RECURRENCE-ID 无法解析，覆盖实例已忽略（UID ${uid ?? '（无）'}）`)
      continue
    }
    // 落在时间窗外的覆盖实例属于"展开截断"，上面已有对应 warning，不再重复报
    const ridMs = Date.parse(info.recurrenceIdIso)
    if (Number.isFinite(ridMs) && ridMs > ctx.horizonMs) continue
    ctx.warnings.push(
      `RECURRENCE-ID 覆盖实例未能匹配到系列实例，已忽略（UID ${uid ?? '（无）'}，原定时段 ${info.recurrenceIdIso}）`,
    )
  }

  if (step >= hardLimit) {
    ctx.warnings.push(`展开达到安全迭代上限已停止（UID ${uid ?? '（无）'}）`)
  }

  if (truncatedByCount) {
    ctx.warnings.push(
      `实例数量超过上限已截断：仅展开前 ${ctx.maxOccurrences} 条（UID ${uid ?? '（无）'}，可用 maxOccurrences 调整）`,
    )
  }
  if (truncatedByHorizon) {
    ctx.warnings.push(`存在超出展开时间窗的实例，已截断（UID ${uid ?? '（无）'}，可用 horizonDays 调整）`)
  }
  return occurrences
}

/** 构造 `event` 条目（含展开）。 */
function buildEventItem(master: IcalEvent, exceptions: IcalComponent[], ctx: ParseContext): IcsItem {
  return buildItem('event', master.component, ctx, master, exceptions)
}

/** 构造 `todo` 条目。 */
function buildTodoItem(comp: IcalComponent, ctx: ParseContext): IcsItem {
  return buildItem('todo', comp, ctx, null, [])
}

/**
 * 构造 `journal`（VJOURNAL 笔记）条目。
 *
 * 与 event/todo 的差异（都必须显式处理，否则会误排期）：
 * - **不展开实例**：VJOURNAL 的 DTSTART 语义是"记录发生的时刻"，不是"日程";
 * - `dueIso` 恒 null（VJOURNAL 无 `DUE` 属性）；
 * - `alarms` 恒 `[]`（VJOURNAL 不允许 `VALARM`，即便文件里塞了也不采信）；
 * - `rrule` / `exdates` 照样读：笔记也可能"每周记一次"，这些留给 `record_meta` 备查，
 *   不做展开就是不做排期，两件事互不影响。
 */
function buildJournalItem(comp: IcalComponent, ctx: ParseContext): IcsItem {
  return buildItem('journal', comp, ctx, null, [])
}

/**
 * 构造条目。
 *
 * @param kind 条目类型
 * @param comp 组件
 * @param ctx 解析上下文
 * @param event `kind==='event'` 时传入已挂好覆盖实例的主事件对象
 * @param exceptions 覆盖实例组件（`RECURRENCE-ID`），用于按绝对时刻兜底匹配
 */
function buildItem(
  kind: 'event' | 'todo' | 'journal',
  comp: IcalComponent,
  ctx: ParseContext,
  event: IcalEvent | null,
  exceptions: IcalComponent[],
): IcsItem {
  const uid = readText(comp, 'uid')
  const warningsPrefix = uid ?? '（无 UID）'

  // 主时间属性：event → DTSTART；todo → DTSTART（有则用），DUE 单独读
  const startProp = comp.getFirstProperty('dtstart')
  const startTzidRaw = readTzidParam(startProp)
  const startTime = event ? safeStartDate(event) : toTimeOrNull(startProp)
  const startResolved = resolveTime(startTime, startTzidRaw)

  const dueProp = comp.getFirstProperty('due')
  const dueTzidRaw = readTzidParam(dueProp)
  const dueTime = toTimeOrNull(dueProp)
  const dueResolved = resolveTime(dueTime, dueTzidRaw)

  const endProp = comp.getFirstProperty('dtend')
  const endTzidRaw = readTzidParam(endProp) ?? startTzidRaw
  const endTime = event ? safeEndDate(event) : toTimeOrNull(endProp)
  const endResolved = resolveTime(endTime, endTzidRaw)

  // **时长只在 item 级算这一次**（此时 start/end 都已是正确的绝对值），展开时逐实例套用。
  // 负值视为不可用：混合时区写法（DTSTART 带 TZID + DTEND 用 Z）在实例级会出现这种非法组合，
  // 宁可退回 `details.endDate` 的解析结果，也不能产出负时长。
  const durationMs = durationBetween(startResolved, endResolved)

  const rrule = readRrule(comp)
  let isRecurring = rrule !== null
  if (event) {
    try {
      isRecurring = event.isRecurring()
    } catch {
      isRecurring = rrule !== null
    }
  }

  const exdates: string[] = []
  let exdateProps: IcalProperty[] = []
  try {
    exdateProps = comp.getAllProperties('exdate')
  } catch {
    exdateProps = []
  }
  for (const prop of exdateProps) {
    for (const resolved of resolvePropertyTimes(prop)) {
      if (!exdates.includes(resolved.iso)) exdates.push(resolved.iso)
    }
  }

  const completed = readTimeProp(comp, 'completed')
  const completedResolved = resolveTime(completed.time, completed.tzidRaw)

  // 事件没有 DTSTART：条目仍然输出（上层要能提示"缺时间"），但必须留一条 warning，
  // 否则会变成"静默导入一条永远排不上期的日程"。
  if (kind === 'event' && !startResolved) {
    ctx.warnings.push(`事件缺少可解析的 DTSTART（开始时间未知），已导入但无法排期（UID ${warningsPrefix}）`)
  }

  // 条目级时区取"主时间属性"：event 用 DTSTART，todo 优先 DTSTART、其次 DUE
  const primary = startResolved ?? dueResolved
  const summary = readText(comp, 'summary') ?? ''

  const occurrences: IcsOccurrence[] = []
  if (kind === 'event' && event) {
    const selfIsOverride = hasRecurrenceId(comp)
    const recurrenceIdProp = comp.getFirstProperty('recurrence-id')
    const recurrenceIdTime = recurrenceIdProp ? toTimeOrNull(recurrenceIdProp) : null
    if (isRecurring) {
      const expanded = expandOccurrences(event, exceptions, exdates, ctx, uid, durationMs)
      occurrences.push(...expanded)
      if (expanded.length === 0) {
        ctx.warnings.push(`循环事件展开后没有任何实例（UID ${warningsPrefix}）`)
      }
    } else {
      // 非循环事件：只有 1 条自身实例，现有"直接解析 end 的绝对值"路径是对的，**不改成时长推导**
      const single = makeOccurrence({
        start: startTime,
        end: endTime,
        tzidRaw: startTzidRaw,
        endTzidRaw: endTzidRaw,
        summary,
        description: readText(comp, 'description'),
        isOverride: selfIsOverride,
        recurrenceId: recurrenceIdTime,
      })
      if (single) occurrences.push(single)
    }
  }

  return {
    kind,
    uid,
    summary,
    description: readText(comp, 'description'),
    location: readText(comp, 'location'),
    categories: readCategories(comp),
    priority: readNumber(comp, 'priority'),
    status: readText(comp, 'status'),
    percentComplete: readNumber(comp, 'percent-complete'),
    relatedTo: readText(comp, 'related-to'),
    completedIso: completedResolved ? completedResolved.iso : null,
    rrule,
    exdates,
    isRecurring,
    allDay: primary ? primary.allDay : false,
    tzidRaw: primary ? primary.tzidRaw : null,
    tzid: primary ? primary.tzid : null,
    startIso: startResolved ? startResolved.iso : null,
    endIso: endResolved ? endResolved.iso : null,
    // VJOURNAL 无 DUE 属性；即便文件里硬塞了也不采信（否则笔记会被当成待办提醒）
    dueIso: kind === 'journal' ? null : (dueResolved ? dueResolved.iso : null),
    // VJOURNAL 不允许 VALARM：不读、也不因它缺 TRIGGER 产生 warning
    alarms: kind === 'journal' ? [] : buildAlarms(comp, ctx, uid),
    occurrences,
  }
}

/** 属性的第一个时间值（非时间返回 null）。 */
function toTimeOrNull(prop: IcalProperty | null): IcalTime | null {
  if (!prop) return null
  try {
    const value = prop.getFirstValue()
    return isTimeLike(value) ? value : null
  } catch {
    return null
  }
}

/** 从任意错误里取可读文案。 */
function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string' && error) return error
  return '未知错误'
}

/** 空结果（容错路径共用）。 */
function emptyResult(warning: string): IcsParseResult {
  return { calendarName: null, timezone: null, items: [], warnings: [warning] }
}

/* ============================== 主入口 ============================== */

/** 待合并的一个成员（组件 + 文档顺序落点）。 */
interface Member {
  comp: IcalComponent
  kind: 'event' | 'todo' | 'journal'
}

/**
 * 解析 `.ics` 文本。
 *
 * 合并规则：按 `kind + UID` 分组，**无 `RECURRENCE-ID` 的组件为正主**，
 * 其余用 `relateException` 挂到主事件上（因此不会单独产出 item）；
 * 只有覆盖实例、缺少主事件时，把覆盖实例当独立条目输出并加 warning。
 * 分组键带 `kind`，因为同一 UID 可能同时出现在 `VEVENT` 与 `VTODO`（本产品导出即如此）；
 * `VJOURNAL`（笔记）不参与覆盖实例合并，同 UID 多条各自成条。
 *
 * @param text `.ics` 全文
 * @param opts 解析选项
 * @returns 解析结果（异常一律转成 `warnings`，不抛）
 */
export function parseIcs(text: string, opts: IcsParseOptions = {}): IcsParseResult {
  const maxOccurrences = clampInt(
    opts.maxOccurrences,
    DEFAULT_MAX_OCCURRENCES,
    MIN_MAX_OCCURRENCES,
    MAX_MAX_OCCURRENCES,
  )
  const horizonDays = clampInt(opts.horizonDays, DEFAULT_HORIZON_DAYS, 0, MAX_HORIZON_DAYS)
  const nowIso = opts.nowIso ?? new Date().toISOString()
  const nowMs = Date.parse(nowIso)
  const baseMs = Number.isNaN(nowMs) ? Date.now() : nowMs
  const ctx: ParseContext = {
    warnings: [],
    maxOccurrences,
    horizonMs: baseMs + horizonDays * MS_PER_DAY,
  }

  // 剥 UTF-8 BOM：Windows 记事本 / 部分导出器会写 BOM，而 `ICAL.parse` 遇 BOM 直接抛，
  // 会让一份完全正常的日历变成"0 条 + 解析失败"。注意 `'\uFEFF'.trim() === ''`，
  // 所以下面的空文本守卫拦不住"BOM + 正文"，必须显式剥掉。
  const normalized = typeof text === 'string' ? text.replace(/^\uFEFF+/, '') : ''

  if (!normalized.trim()) {
    return emptyResult('内容为空，没有任何日历数据')
  }

  let root: IcalComponent
  try {
    const jcal = ICAL.parse(normalized)
    root = new ICAL.Component(jcal as unknown[])
  } catch (error) {
    return emptyResult(`日历解析失败：${errorMessage(error)}`)
  }

  if (!root || root.name !== 'vcalendar') {
    return emptyResult(`不是有效的 VCALENDAR（实际为 ${root && root.name ? root.name.toUpperCase() : '未知组件'}）`)
  }

  const calendarName = readText(root, 'x-wr-calname')
  const timezone = readText(root, 'x-wr-timezone')

  // 按文档顺序收集 VEVENT / VTODO / VJOURNAL（`getAllSubcomponents()` 保序，避免 VEVENT 全排到后面）
  let children: IcalComponent[] = []
  try {
    children = root.getAllSubcomponents()
  } catch (error) {
    return emptyResult(`日历子组件读取失败：${errorMessage(error)}`)
  }

  const order: string[] = []
  const groups = new Map<string, Member[]>()
  let index = 0
  let skippedAlarmsOnly = 0
  for (const comp of children) {
    const name = typeof comp.name === 'string' ? comp.name.toLowerCase() : ''
    if (name !== 'vevent' && name !== 'vtodo' && name !== 'vjournal') {
      if (name === 'valarm' || name === 'vtimezone') continue
      skippedAlarmsOnly += 1
      continue
    }
    const kind: 'event' | 'todo' | 'journal' =
      name === 'vevent' ? 'event' : name === 'vtodo' ? 'todo' : 'journal'
    const uid = readText(comp, 'uid')
    // 分组键带 kind：同一 UID 可能同时出现在 VEVENT / VTODO / VJOURNAL（本产品导出即 VEVENT+VTODO 配对），
    // 跨 kind 合并会把"待办"和"笔记"糅成一条。
    const key = `${kind}\u0000${uid ?? `#${index}`}`
    const member: Member = { comp, kind }
    index += 1
    const existing = groups.get(key)
    if (existing) {
      existing.push(member)
    } else {
      groups.set(key, [member])
      order.push(key)
    }
  }

  if (skippedAlarmsOnly > 0) {
    ctx.warnings.push(`忽略了 ${skippedAlarmsOnly} 个不支持的组件（只处理 VEVENT / VTODO / VJOURNAL）`)
  }

  const items: IcsItem[] = []
  for (const key of order) {
    const members = groups.get(key)
    if (!members || members.length === 0) continue
    const kind = members[0].kind
    const uid = readText(members[0].comp, 'uid')

    if (kind === 'todo' || kind === 'journal') {
      // 待办/笔记不做合并：同 UID 多条各自成条（本产品导出就是 VTODO/VEVENT 配对，UID 重复是常态；
      // VJOURNAL 没有 RECURRENCE-ID 覆盖语义，天然就是独立条目）
      if (members.length > 1) {
        ctx.warnings.push(
          `同一 UID 存在多条${kind === 'todo' ? '待办' : '笔记'}，已分别导入（UID ${uid ?? '（无）'}）`,
        )
      }
      for (const member of members) {
        items.push(kind === 'todo' ? buildTodoItem(member.comp, ctx) : buildJournalItem(member.comp, ctx))
      }
      continue
    }

    const masterMembers = members.filter((member) => !hasRecurrenceId(member.comp))
    if (masterMembers.length === 0) {
      // 只有覆盖实例：当独立条目输出，避免静默丢数据
      ctx.warnings.push(
        `只找到 RECURRENCE-ID 覆盖实例、缺少主事件，已按独立事件导入（UID ${uid ?? '（无）'}）`,
      )
      for (const member of members) {
        items.push(buildEventItem(new ICAL.Event(member.comp), [], ctx))
      }
      continue
    }

    if (masterMembers.length > 1) {
      ctx.warnings.push(`同一 UID 存在多个主事件，只保留第一条（UID ${uid ?? '（无）'}）`)
    }

    const masterComp = masterMembers[0].comp
    let master: IcalEvent
    try {
      master = new ICAL.Event(masterComp)
    } catch (error) {
      ctx.warnings.push(`事件构造失败已跳过（UID ${uid ?? '（无）'}）：${errorMessage(error)}`)
      continue
    }

    // 覆盖实例既登记到 ical.js（键能对上时它自己会做替换），也留在本地列表里
    // （键对不上时由 `expandOccurrences` 按绝对时刻兜底，见 ExceptionInfo 注释）
    const exceptionComps: IcalComponent[] = []
    for (const member of members) {
      if (member === masterMembers[0]) continue
      exceptionComps.push(member.comp)
      try {
        master.relateException(new ICAL.Event(member.comp))
      } catch (error) {
        ctx.warnings.push(
          `覆盖实例无法关联到主事件，将按绝对时刻兜底匹配（UID ${uid ?? '（无）'}）：${errorMessage(error)}`,
        )
      }
    }

    items.push(buildEventItem(master, exceptionComps, ctx))
  }

  return { calendarName, timezone, items, warnings: ctx.warnings }
}
