/**
 * 「最近活跃」时间的人话版本（设备列表用）。
 *
 * 为什么不用 `toLocaleString()` 了事：设备列表里 90% 的行都是「刚刚 / 3 分钟前」，
 * 直接摊一个 `2026-11-16 12:41:07` 会让用户去心算时差。同时**保留绝对时间兜底**——
 * 超过一周的行，相对时间（「9 天前」）反而不如日期直观。
 *
 * 纯函数：`now` 显式传入，测试不需要 mock 系统时间。
 */
export const MINUTE_MS = 60_000
export const HOUR_MS = 60 * MINUTE_MS
export const DAY_MS = 24 * HOUR_MS

/**
 * 把时间戳格式化成「刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD」。
 *
 * - 非法或空值 → `'未知'`（不要抛错，一张坏行不该炸掉整张设备卡片）
 * - 未来时间（两端时钟不一致）→ 按「刚刚」处理，不显示「-3 分钟前」这种鬼话
 */
export function formatLastSeen(iso: string, now: number = Date.now()): string {
  if (!iso) return '未知'
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return '未知'
  const diff = now - t
  if (diff < MINUTE_MS) return '刚刚'
  if (diff < HOUR_MS) return `${Math.floor(diff / MINUTE_MS)} 分钟前`
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR_MS)} 小时前`
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 在线判定：最近 5 分钟内有心跳视为「在线」（心跳周期 60s，容忍两次丢失）。 */
export const ONLINE_WINDOW_MS = 5 * MINUTE_MS

/** 这台设备当前是否算「在线」。 */
export function isDeviceOnline(iso: string, now: number = Date.now()): boolean {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return false
  return now - t < ONLINE_WINDOW_MS
}
