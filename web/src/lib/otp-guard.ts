/**
 * 短信验证码发送频控 / 失败锁定（纯前端兜底）。
 *
 * ## 为什么放在前端
 * 验证码由平台云服务（WorkBuddy Cloud Auth）代发，限流策略在服务端，我们改不了；
 * 这里做的是「本机 + 本浏览器」的兜底，用来挡住三类常见损耗：
 * - 连点「获取验证码」把额度刷掉（短信按条扣资源点，**未送达也扣**）；
 * - 页面脚本循环发码；
 * - 在公共设备上对同一个号穷举 6 位验证码。
 *
 * ## 三条规则
 * 1. 同号 **60 秒**内不可重发（与登录页倒计时一致）；
 * 2. 同号每 **24 小时**最多 **10 条**；
 * 3. 同号连续输错 **5 次**锁 **15 分钟**（输对一次即清零）。
 *
 * ## 局限（不要当成安全边界）
 * localStorage 可被清空、换浏览器/换设备即可绕过。真正防刷需要服务端按 IP/设备限流，
 * 那部分不在本应用可控范围内。这里只是把「误触」和「轻量脚本」挡掉。
 */

/** 只依赖这两个方法，便于单测注入假存储。 */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** 单号单日发送上限。 */
export const OTP_MAX_PER_DAY = 10
/** 同号重发冷却。 */
export const OTP_RESEND_COOLDOWN_MS = 60_000
/** 连续输错多少次锁定。 */
export const OTP_MAX_FAILS = 5
/** 锁定时长。 */
export const OTP_LOCK_MS = 15 * 60_000
/** 统计窗口（也是记录保留时长）。 */
export const OTP_WINDOW_MS = 24 * 60 * 60_000

export const OTP_GUARD_KEY = 'pa.otp.guard'

/** 单个手机号的频控记录。 */
export interface OtpGuardEntry {
  /** 最近 24 小时内的发送时间戳（毫秒），升序。 */
  sent: number[]
  /** 连续输错次数。 */
  fails: number
  /** 锁定到期时间戳；0 表示未锁定。 */
  lockedUntil: number
}

export type OtpGuardState = Record<string, OtpGuardEntry>

export type SendBlockReason = 'cooldown' | 'daily' | 'locked'

export interface SendVerdict {
  allowed: boolean
  /** 被拦时的原因。 */
  reason?: SendBlockReason
  /** 还要等多久（毫秒），用于提示文案。 */
  retryAfterMs?: number
  /** 今天还剩几条可发（allowed 时也给，便于展示）。 */
  remaining: number
}

const EMPTY_ENTRY: OtpGuardEntry = { sent: [], fails: 0, lockedUntil: 0 }

/** 数字安全兜底：任何脏数据都退回 0。 */
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
}

/** 把任意来源的数据归一化成合法状态（脏数据当作没存过）。 */
export function normalizeOtpGuard(raw: unknown): OtpGuardState {
  if (!raw || typeof raw !== 'object') return {}
  const out: OtpGuardState = {}
  for (const [phone, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d{6,20}$/.test(phone)) continue
    if (!value || typeof value !== 'object') continue
    const v = value as Partial<OtpGuardEntry>
    const sent = Array.isArray(v.sent) ? v.sent.map(num).filter((t) => t > 0).sort((a, b) => a - b) : []
    out[phone] = { sent, fails: Math.min(num(v.fails), 999), lockedUntil: num(v.lockedUntil) }
  }
  return out
}

/** 读状态（异常/无存储时当作空状态）。 */
export function readOtpGuard(storage: StorageLike | null | undefined): OtpGuardState {
  if (!storage) return {}
  try {
    const raw = storage.getItem(OTP_GUARD_KEY)
    if (!raw) return {}
    return normalizeOtpGuard(JSON.parse(raw))
  } catch {
    return {}
  }
}

/** 写状态（失败静默：隐私模式下 localStorage 可能抛错）。 */
export function writeOtpGuard(storage: StorageLike | null | undefined, state: OtpGuardState): void {
  if (!storage) return
  try {
    storage.setItem(OTP_GUARD_KEY, JSON.stringify(state))
  } catch {
    /* 忽略 */
  }
}

/** 丢掉 24 小时内没有活动、且未锁定的号码，避免存储无限增长。 */
export function pruneOtpGuard(state: OtpGuardState, now: number): OtpGuardState {
  const out: OtpGuardState = {}
  for (const [phone, entry] of Object.entries(state)) {
    const lastSent = entry.sent.length ? entry.sent[entry.sent.length - 1] : 0
    const locked = entry.lockedUntil > now
    if (locked || now - lastSent < OTP_WINDOW_MS) out[phone] = entry
  }
  return out
}

/** 窗口内已发条数。 */
function sentInWindow(entry: OtpGuardEntry, now: number): number[] {
  return entry.sent.filter((t) => now - t < OTP_WINDOW_MS)
}

/**
 * 判断现在能否给这个号发码。纯函数，不改状态。
 */
export function evaluateSend(state: OtpGuardState, phone: string, now: number): SendVerdict {
  const entry = state[phone] ?? EMPTY_ENTRY
  const recent = sentInWindow(entry, now)
  const remaining = Math.max(0, OTP_MAX_PER_DAY - recent.length)

  if (entry.lockedUntil > now) {
    return { allowed: false, reason: 'locked', retryAfterMs: entry.lockedUntil - now, remaining }
  }
  const last = recent.length ? recent[recent.length - 1] : 0
  const sinceLast = now - last
  if (last > 0 && sinceLast < OTP_RESEND_COOLDOWN_MS) {
    return { allowed: false, reason: 'cooldown', retryAfterMs: OTP_RESEND_COOLDOWN_MS - sinceLast, remaining }
  }
  if (recent.length >= OTP_MAX_PER_DAY) {
    const oldest = recent[0]
    return {
      allowed: false,
      reason: 'daily',
      retryAfterMs: Math.max(0, OTP_WINDOW_MS - (now - oldest)),
      remaining: 0,
    }
  }
  return { allowed: true, remaining }
}

/** 记一次发送，返回新状态。 */
export function applySend(state: OtpGuardState, phone: string, now: number): OtpGuardState {
  const entry = state[phone] ?? EMPTY_ENTRY
  const recent = sentInWindow(entry, now)
  return {
    ...pruneOtpGuard(state, now),
    [phone]: { ...entry, sent: [...recent, now] },
  }
}

/** 现在能否提交验证码（被锁则不能）。 */
export function evaluateVerify(
  state: OtpGuardState,
  phone: string,
  now: number,
): { allowed: boolean; retryAfterMs?: number } {
  const entry = state[phone] ?? EMPTY_ENTRY
  if (entry.lockedUntil > now) return { allowed: false, retryAfterMs: entry.lockedUntil - now }
  return { allowed: true }
}

/** 记一次输错；达到阈值即锁定。 */
export function applyVerifyFailure(state: OtpGuardState, phone: string, now: number): OtpGuardState {
  const entry = state[phone] ?? EMPTY_ENTRY
  const fails = entry.fails + 1
  const lockedUntil = fails >= OTP_MAX_FAILS ? now + OTP_LOCK_MS : entry.lockedUntil
  return {
    ...pruneOtpGuard(state, now),
    [phone]: { ...entry, fails, lockedUntil },
  }
}

/** 输对即清零失败计数与锁。 */
export function applyVerifySuccess(state: OtpGuardState, phone: string): OtpGuardState {
  const entry = state[phone]
  if (!entry) return state
  return { ...state, [phone]: { ...entry, fails: 0, lockedUntil: 0 } }
}

/** 把毫秒转成「58 秒」「3 分 20 秒」「2 小时 5 分」这类可读文案。 */
export function formatWait(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  if (total < 60) return `${total} 秒`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} 小时 ${rest} 分` : `${hours} 小时`
}
