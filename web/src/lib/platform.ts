/**
 * 平台识别与设备身份（多端同时在线的基础设施）。
 *
 * 为什么单独一个模块而不是塞进 `lib/pwa.ts`：
 * 1. `pwa.ts` 回答的是「浏览器能不能装/能不能发通知」，而这里回答的是
 *    「我在哪台机器、我是谁」——多端会话、离线库隔离、错误上报都要用到它，
 *    但都不关心 PWA 能力。
 * 2. 这里的判定必须**纯函数可测**：UA 被传入而不是内部读 `navigator`，
 *    否则 Node 侧测试没法覆盖「Android 壳」「鸿蒙」「iPadOS 桌面模式」这些分支。
 *
 * 三条口径：
 * - **设备 ID 存 localStorage，不存 Cookie**：与云 SDK 的会话存储同域同介质，
 *   Android WebView 里随应用数据持久化（卸载才清），Electron 里随 BrowserWindow
 *   partition 持久化。两侧天然不共享 → 正好是「两台设备」。
 * - **不引 `@capacitor/core`**：它会被打进首屏包（~40KB）换一个 `isNativePlatform()`。
 *   Capacitor 的 native bridge 会往 WebView 注入全局 `Capacitor` 对象，读全局即可。
 * - **平台标签给人看，`platform` 字段给机器看**：后者只允许四个稳定值，别把
 *   `Windows NT 10.0` 这种会变的串写进库。
 */

/** 机器可读的平台标识（入库字段，值域固定）。 */
export type PlatformKind = 'desktop' | 'android' | 'ios' | 'web'

/** localStorage 里的设备 ID 键（不随账号变化，换账号仍视作同一台设备）。 */
export const DEVICE_ID_KEY = 'pa.device.id'

/** Capacitor 注入到 WebView 的最小形状（只声明用到的两个方法）。 */
interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

/** 读取 Capacitor 全局对象（浏览器 / Electron 下为 undefined）。 */
function readCapacitorGlobal(): CapacitorGlobal | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as Window & { Capacitor?: CapacitorGlobal }).Capacitor
}

/** 是否跑在 Capacitor 原生壳（Android/iOS APK）里。 */
export function isNativeShell(): boolean {
  const cap = readCapacitorGlobal()
  if (!cap) return false
  try {
    if (typeof cap.isNativePlatform === 'function') return cap.isNativePlatform()
    return typeof cap.getPlatform === 'function' && cap.getPlatform() !== 'web'
  } catch {
    return false
  }
}

/**
 * 当前页面能否承接网页 OAuth 回调（微信扫码 / WorkBuddy 账号登录）。
 *
 * 判断依据是**页面源站**而不是「是否原生壳」：
 * - 联网模式 APK（`server.url` 指线上域名）里 `location.origin` 就是已注册域名，
 *   Relay 可以把用户重定向回来，回调由 `handleWechatWebCallback()` 消费；
 * - 离线模式壳 / 本地 dev（`https://localhost`、`http://127.0.0.1`）不行：
 *   微信开放平台不可能把用户跳到 localhost，跳过去只会白屏。
 *
 * 注意：能回调 ≠ 体验好。手机端微信只提供「网站应用扫码」页（qrconnect），
 * 同一个手机扫不了自己屏幕上的码，必须用另一台设备扫。
 */
export function canReceiveWebOAuthCallback(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return isCallbackCapableOrigin(window.location.origin)
  } catch {
    return false
  }
}

/** 纯判定：给定源站能否承接网页 OAuth 回调（无 DOM 依赖，便于单测）。 */
export function isCallbackCapableOrigin(origin: string): boolean {
  if (!/^https:\/\//i.test(origin)) return false
  return !/^https:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin)
}

/** 是否跑在 Electron 桌面端（主窗口或悬浮窗）。 */
export function isDesktopShell(): boolean {
  if (typeof window === 'undefined') return false
  if (window.desktopBridge) return true
  try {
    return new URLSearchParams(window.location.search).get('desktop') === '1'
  } catch {
    return false
  }
}

/**
 * 平台归类。**桌面优先于 UA**：Electron 的 UA 里也带 `Windows`，
 * 只看 UA 会把桌面端误判成网页版，进而选错设备标签与通知口径。
 */
export function detectPlatformFrom(input: {
  hasDesktopBridge: boolean
  nativePlatform?: string | null
  userAgent: string
}): PlatformKind {
  if (input.hasDesktopBridge) return 'desktop'
  const native = (input.nativePlatform ?? '').toLowerCase()
  if (native === 'android') return 'android'
  if (native === 'ios') return 'ios'
  const ua = input.userAgent || ''
  if (/Android/i.test(ua)) return 'android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios'
  return 'web'
}

/** 当前平台。 */
export function detectPlatform(): PlatformKind {
  const cap = readCapacitorGlobal()
  let nativePlatform: string | null = null
  try {
    nativePlatform = typeof cap?.getPlatform === 'function' ? cap.getPlatform() : null
  } catch {
    nativePlatform = null
  }
  return detectPlatformFrom({
    hasDesktopBridge: typeof window !== 'undefined' && !!window.desktopBridge,
    nativePlatform,
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
  })
}

/** 平台中文名（设置页 / 设备列表用）。 */
export function platformName(platform: PlatformKind): string {
  switch (platform) {
    case 'desktop':
      return 'Windows 桌面端'
    case 'android':
      return 'Android 手机'
    case 'ios':
      return 'iPhone / iPad'
    default:
      return '网页浏览器'
  }
}

/** 从 UA 里读系统名（只用于给人看的标签，不做业务判断）。 */
export function readOsName(userAgent: string): string {
  const ua = userAgent || ''
  if (/Windows NT 10/i.test(ua)) return 'Windows'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Android/i.test(ua)) return 'Android'
  if (/iPhone|iPad|iPod/i.test(ua)) return 'iOS'
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return '未知系统'
}

/**
 * 人类可读的设备标签，例如 `Windows · 桌面端`、`Android · 手机`、`Windows · Chrome`。
 *
 * 刻意**不含主机名 / 用户名**：标签会写进云端 `devices` 表，跨端可见，
 * 没必要把本地内网信息带上去。
 */
export function buildDeviceLabel(input: {
  platform: PlatformKind
  userAgent: string
}): string {
  const os = readOsName(input.userAgent)
  switch (input.platform) {
    case 'desktop':
      return `${os} · 桌面端`
    case 'android':
      return `${os} · 手机`
    case 'ios':
      return `${os} · 手机`
    default: {
      const browser = /Edg\//i.test(input.userAgent)
        ? 'Edge'
        : /Chrome\//i.test(input.userAgent)
          ? 'Chrome'
          : /Safari\//i.test(input.userAgent)
            ? 'Safari'
            : /Firefox\//i.test(input.userAgent)
              ? 'Firefox'
              : '浏览器'
      return `${os} · ${browser}`
    }
  }
}

/**
 * 生成随机 ID（UUID v4 形态）。
 *
 * 只做**设备标识**，不是密钥：即使 `crypto.randomUUID` 不可用退回 `Math.random`
 * 也安全（撞 ID 的后果是设备列表里少一行，而不是越权——数据边界始终是 `owner_id`）。
 */
export function createDeviceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID()
    }
  } catch {
    /* 非安全上下文（http://）下 randomUUID 不存在，走兜底 */
  }
  const hex = '0123456789abcdef'
  let out = ''
  for (let i = 0; i < 32; i += 1) out += hex[Math.floor(Math.random() * 16)]
  return `${out.slice(0, 8)}-${out.slice(8, 12)}-4${out.slice(13, 16)}-a${out.slice(17, 20)}-${out.slice(20, 32)}`
}

let cachedDeviceId: string | null = null

/**
 * 取本机设备 ID（惰性创建并持久化）。
 *
 * 存储不可用（隐私模式 / 配额满）时退回**进程内随机 ID**：本次运行仍能正常
 * 注册心跳，重启后会被当成新设备——比抛错让登录挂掉好。
 */
export function getDeviceId(): string {
  if (cachedDeviceId) return cachedDeviceId
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY)
    if (existing && existing.length >= 8) {
      cachedDeviceId = existing
      return existing
    }
    const created = createDeviceId()
    window.localStorage.setItem(DEVICE_ID_KEY, created)
    cachedDeviceId = created
    return created
  } catch {
    cachedDeviceId = createDeviceId()
    return cachedDeviceId
  }
}

/** 当前设备的完整描述（注册 / 心跳 / 列表高亮都要用）。 */
export interface DeviceIdentity {
  deviceId: string
  platform: PlatformKind
  label: string
}

let cachedIdentity: DeviceIdentity | null = null

/** 取当前设备身份（进程内缓存：UA 与平台在一次运行里不会变）。 */
export function getDeviceIdentity(): DeviceIdentity {
  if (cachedIdentity) return cachedIdentity
  const platform = detectPlatform()
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  cachedIdentity = {
    deviceId: getDeviceId(),
    platform,
    label: buildDeviceLabel({ platform, userAgent }),
  }
  return cachedIdentity
}

/** 测试用：清空进程内缓存（不改 localStorage）。 */
export function resetDeviceIdentityCache(): void {
  cachedDeviceId = null
  cachedIdentity = null
}
