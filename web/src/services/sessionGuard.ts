/**
 * 会话守护（多端同时在线的前台侧）。
 *
 * 安卓壳与桌面端有一个共同点：**应用会被挂起很久**（手机切后台、桌面合盖）。
 * WebView / Chromium 在后台会冻结定时器，`accessToken` 到期后不会自己续，
 * 回到前台的第一屏常常是「一大片 401」。这里做三件事：
 *
 * 1. **恢复即校验**：`visibilitychange → visible` 时立刻 `getSession()`
 *    （云 SDK 内部只在临近过期时才真打 `/v1/token`，不会每次多一个请求）；
 * 2. **心跳**：前台每分钟一次 `last_seen_at`，顺带读回自己是否被别的设备注销；
 * 3. **被注销即登出**：读到 `revoked_at` 就本地 `signOut`，路由守卫自然把
 *    用户送回登录页，并给一条可读提示。
 *
 * 刻意**不做**的事：不轮询 `getUser()`（每端每分钟一次用户接口纯属浪费）、
 * 不在后台起定时器（安卓会直接冻结，反而制造「假在线」）。
 */
import { authService } from './authService'
import { deviceRegistry } from './deviceRegistry'
import { useAuthStore } from '@/store/authStore'
import { pushNotice } from '@/store/noticeStore'

/** 心跳周期（毫秒）。配合 `HEARTBEAT_MIN_INTERVAL_MS` 节流，实际写入 ≤1 次/分钟。 */
export const GUARD_TICK_MS = 60_000

let disposers: Array<() => void> = []

/** 生成一条无副作用的空清理函数（多次调用安全）。 */
function noop(): void {}

/** 本端是否处于前台可见。 */
function isVisible(): boolean {
  try {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden'
  } catch {
    return true
  }
}

/**
 * 处理「被其它设备注销」：本地登出 + 提示。
 * 幂等——重复心跳不会重复弹提示（`signOut` 后 session 已空，此处直接早退）。
 */
async function handleRevoked(): Promise<void> {
  if (!useAuthStore.getState().session) return
  pushNotice('本机已被其它设备退出登录，请重新登录', 'warning')
  try {
    await authService.signOut()
  } catch {
    /* 断网也必须能退出：SDK 的 signOut 无论服务端成败都会清本地会话 */
  }
  useAuthStore.getState().setSession(null)
}

/** 一次前台检查：先续会话，再心跳。 */
async function tick(force: boolean): Promise<void> {
  if (!useAuthStore.getState().session) return
  if (!isVisible()) return
  try {
    // 临近过期才真续期；返回 null 表示会话已不可恢复
    const session = await authService.getSession()
    if (!session) {
      useAuthStore.getState().setSession(null)
      return
    }
  } catch {
    // 断网：保留现有会话（离线仍可用离线库），不要因为一次失败就踢人
  }
  const result = await deviceRegistry.heartbeat(force)
  if (result === 'revoked') await handleRevoked()
}

/**
 * 启动会话守护。返回停止函数（测试 / 登出时可调）。
 *
 * 必须在 `bootstrap()` 里调用一次：它同时负责「登录后注册设备」。
 */
export function startSessionGuard(): () => void {
  stopSessionGuard()

  // 登录态出现即注册设备（注册失败不阻断，注册表可能还没迁移）
  const unsubAuth = useAuthStore.subscribe((state, prev) => {
    if (state.session && !prev.session) {
      void deviceRegistry.register().then(() => deviceRegistry.heartbeat(true))
    }
  })

  const timer = window.setInterval(() => {
    void tick(false)
  }, GUARD_TICK_MS)

  const onVisible = () => {
    if (isVisible()) void tick(true)
  }
  const onOnline = () => {
    void tick(true)
  }

  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
  window.addEventListener('online', onOnline)

  // 启动时若已有会话（刷新 / 冷启动恢复），立刻补一次注册 + 心跳
  if (useAuthStore.getState().session) {
    void deviceRegistry.register().then(() => deviceRegistry.heartbeat(true))
  }

  disposers = [
    unsubAuth,
    () => window.clearInterval(timer),
    () => document.removeEventListener('visibilitychange', onVisible),
    () => window.removeEventListener('focus', onVisible),
    () => window.removeEventListener('online', onOnline),
  ]

  return stopSessionGuard
}

/** 停止会话守护（幂等）。 */
export function stopSessionGuard(): void {
  for (const dispose of disposers) {
    try {
      dispose()
    } catch {
      /* 单个清理失败不影响其余 */
    }
  }
  disposers = []
}

export { noop as _noop }
