/**
 * PWA 运行时（P1-9）：注册 Service Worker、在线态订阅、通知可达性判定。
 *
 * 三条口径（都是踩过坑才写下来的）：
 * 1. **桌面伴侣与开发模式不注册 SW**：Electron 里缓存层只会让「换了分享码/换了域名」更难自救；
 *    开发模式（`import.meta.env.DEV`）注册会命中 `devOptions.enabled:false` 的空配置。
 * 2. **不引 `virtual:pwa-register`**：那是个虚拟模块，QA 侧的 esbuild 打包不认它。
 *    手动 `register(sw.js)` + 自己算更新节奏，行为等价且可测。
 * 3. **通知可达性是「环境 × 权限」的纯函数**：iOS 标签页、iOS 主屏、Android 原生壳
 *    的能力完全不同（Safari 标签页与 WebView 都不发系统通知），文案必须分环境给，
 *    不能一句「请开启通知」糊过去。
 */
import { isNativeShell } from './platform'

/** Service Worker 文件名（与 `vite-plugin-pwa` 的 `filename` 默认值一致）。 */
export const SERVICE_WORKER_FILE = 'sw.js'

/** 在线时多久主动查一次新版本（毫秒）。autoUpdate 下新 SW 会自接管，查得勤才「5s 内更新」。 */
export const SW_UPDATE_INTERVAL_MS = 30 * 60 * 1000

/* --------------------------- 通知可达性（纯函数） --------------------------- */

/** 四种可达性环境：桌面伴侣 / 原生壳（APK） / 已安装（主屏） / iOS 标签页 / 普通浏览器标签页。 */
export type NotifyEnvKind = 'desktop' | 'native' | 'installed' | 'ios-tab' | 'browser-tab'

export type NotifyLevel = 'ok' | 'warn' | 'limited'

export interface NotifyEnvironmentInput {
  /** 是否跑在桌面伴侣（Electron）里。 */
  hasDesktopBridge: boolean
  /** 是否跑在 Capacitor 原生壳（Android APK）里。 */
  nativeShell: boolean
  /** 浏览器 User-Agent。 */
  userAgent: string
  /** 是否以安装态（standalone）打开：manifest 的 display-mode 或 iOS 的 `navigator.standalone`。 */
  standalone: boolean
  /** 运行环境是否提供 Notification API。 */
  notificationSupported: boolean
  /** 当前通知权限。 */
  permission: NotificationPermission | 'unsupported'
}

export interface NotifyReachability {
  kind: NotifyEnvKind
  level: NotifyLevel
  title: string
  detail: string
  /** 建议动作：安装到主屏 / 去系统设置放权限。 */
  action?: 'install' | 'permission'
}

/** iOS / iPadOS 判定（iPadOS 13+ 的 UA 伪装成 macOS，用触点数兜住）。 */
export function isIosUserAgent(userAgent: string, maxTouchPoints = 0): boolean {
  const ua = userAgent || ''
  if (/iPad|iPhone|iPod/i.test(ua)) return true
  // iPadOS 13+ 桌面模式：UA 形如 macOS，但有多点触控
  return /Macintosh/i.test(ua) && maxTouchPoints > 1
}

/** 环境归类：桌面 > 原生壳 > 安装态 > iOS 标签页 > 普通标签页（顺序即优先级）。 */
export function resolveNotifyEnvKind(input: {
  hasDesktopBridge: boolean
  /** 是否 Capacitor 原生壳；缺省 false（旧调用方不必改）。 */
  nativeShell?: boolean
  userAgent: string
  standalone: boolean
  maxTouchPoints?: number
}): NotifyEnvKind {
  if (input.hasDesktopBridge) return 'desktop'
  // 原生壳要排在 standalone 之前：Capacitor WebView 里 matchMedia 可能报 standalone，
  // 但 WebView **不支持 Web Notification**，按「已安装」描述会骗用户。
  if (input.nativeShell === true) return 'native'
  if (input.standalone) return 'installed'
  if (isIosUserAgent(input.userAgent, input.maxTouchPoints ?? 0)) return 'ios-tab'
  return 'browser-tab'
}

/**
 * 可达性三态文案。**权限被拒优先于一切环境描述**——否则用户会以为「装到主屏就能收到」。
 */
export function resolveNotifyReachability(input: NotifyEnvironmentInput): NotifyReachability {
  const kind = resolveNotifyEnvKind(input)
  const denied = input.permission === 'denied' || input.permission === 'unsupported'
  if (denied) {
    return {
      kind,
      level: 'limited',
      title: '仅应用内提示',
      detail:
        input.permission === 'denied'
          ? '系统已拒绝通知权限，到点提醒只在应用内提示；可在浏览器站点设置里重新允许。'
          : '当前环境不支持系统通知，到点提醒只在应用内提示。',
      action: 'permission',
    }
  }

  const base: Record<NotifyEnvKind, NotifyReachability> = {
    desktop: {
      kind,
      level: 'ok',
      title: '桌面伴侣 · 系统通知',
      detail: '到点弹系统通知（含「完成 / 稍后」按钮），关掉网页也不影响。',
    },
    native: {
      kind,
      level: 'warn',
      title: '安卓 App · 仅应用内提醒',
      detail:
        'Android 的 WebView 不提供系统通知能力，到点提醒在应用打开时可见；要做到锁屏也能收到，需要接入系统级推送（FCM）。',
    },
    installed: {
      kind,
      level: 'ok',
      title: '已安装到主屏 · 可收系统通知',
      detail: '从主屏图标打开时可收系统通知；应用退到后台后能否收到取决于系统省电策略。',
    },
    'ios-tab': {
      kind,
      level: 'limited',
      title: 'iOS 标签页 · 收不到系统通知',
      detail:
        'iOS 只在「添加到主屏幕」并从图标打开时才允许通知，Safari 标签页内不发通知；当前到点提醒只在页面内可见。',
      action: 'install',
    },
    'browser-tab': {
      kind,
      level: 'warn',
      title: '浏览器标签页 · 仅在打开本页时提醒',
      detail: '关闭标签页后提醒不会弹出；Android Chrome 可「添加到主屏幕」后获得更稳定的通知。',
      action: 'install',
    },
  }
  return base[kind]
}

/* ------------------------------ 浏览器运行时 ------------------------------ */

/** 当前是否以安装态（standalone）运行。 */
export function isStandaloneDisplay(): boolean {
  try {
    if (typeof window === 'undefined') return false
    // iOS Safari 的私有属性
    const nav = window.navigator as Navigator & { standalone?: boolean }
    if (nav.standalone === true) return true
    return window.matchMedia?.('(display-mode: standalone)').matches ?? false
  } catch {
    return false
  }
}

/** 读取当前环境的可达性（浏览器侧薄封装，逻辑全在纯函数里）。 */
export function readNotifyReachability(): NotifyReachability {
  const supported = typeof window !== 'undefined' && 'Notification' in window
  return resolveNotifyReachability({
    hasDesktopBridge: typeof window !== 'undefined' && !!window.desktopBridge,
    nativeShell: isNativeShell(),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    standalone: isStandaloneDisplay(),
    notificationSupported: supported,
    permission: supported ? Notification.permission : 'unsupported',
  })
}

/** 浏览器在线态（SSR / 测试环境无 `navigator` 时按「在线」处理，避免误报离线）。 */
export function readOnlineStatus(): boolean {
  try {
    if (typeof navigator === 'undefined') return true
    return navigator.onLine !== false
  } catch {
    return true
  }
}

/** 订阅在线态变化，返回取消订阅函数。 */
export function subscribeOnlineStatus(cb: (online: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const on = () => cb(true)
  const off = () => cb(false)
  window.addEventListener('online', on)
  window.addEventListener('offline', off)
  return () => {
    window.removeEventListener('online', on)
    window.removeEventListener('offline', off)
  }
}

let swRegistered = false

/**
 * 注册 Service Worker。**只在生产构建、非桌面伴侣、非原生壳环境执行**；任何异常静默
 * （离线壳是增强项，不能因为它把应用启动搞挂）。
 *
 * 为什么原生壳（Capacitor APK）要跳过：它的静态资源本来就在 APK assets 里，
 * 断网也能开；再注册一层 SW 只会让「升级 APK 后页面还是旧的」——WebView 的
 * Cache Storage 不随 APK 版本清理，是线上出了名的「自锁」故障。
 */
export function registerServiceWorker(): void {
  if (swRegistered) return
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return
  if (!('serviceWorker' in navigator)) return
  if (window.desktopBridge) return
  if (isNativeShell()) return
  if (!import.meta.env.PROD) return
  swRegistered = true

  const swUrl = new URL(SERVICE_WORKER_FILE, document.baseURI).toString()
  navigator.serviceWorker
    .register(swUrl, { scope: '/' })
    .then((reg) => {
      // 在线时定期问一次新版本：autoUpdate 只负责「新的立刻接管」，不会自己定时去问
      const tick = () => {
        if (readOnlineStatus()) void reg.update().catch(() => {})
      }
      tick()
      window.setInterval(tick, SW_UPDATE_INTERVAL_MS)
      window.addEventListener('online', tick)
    })
    .catch(() => {
      // 注册失败（隐私模式 / 非安全上下文）→ 没有离线壳，但应用照常可用
      swRegistered = false
    })
}

/* ------------------------------ 安装提示（BIP） ------------------------------ */

/** Chromium 的 `beforeinstallprompt` 事件（TS 标准库没有，自己声明最小形状）。 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

let deferredInstallPrompt: BeforeInstallPromptEvent | null = null
const installListeners = new Set<(canInstall: boolean) => void>()
let installEventsAttached = false

/** 只挂一次全局监听（`beforeinstallprompt` 只派发一次，重复挂载会拿到多个副本）。 */
function attachInstallEvents(): void {
  if (installEventsAttached || typeof window === 'undefined') return
  installEventsAttached = true
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferredInstallPrompt = e as BeforeInstallPromptEvent
    installListeners.forEach((fn) => fn(true))
  })
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null
    installListeners.forEach((fn) => fn(false))
  })
}

/**
 * 订阅「当前可否弹出安装提示」，返回取消订阅函数。
 *
 * 晚订阅也能用：`attachInstallEvents()` 幂等挂载全局监听，事件到达时写进模块级变量，
 * 订阅瞬间就把当前值回灌给回调。
 */
export function subscribeInstallPrompt(cb: (canInstall: boolean) => void): () => void {
  if (typeof window === 'undefined') return () => {}
  attachInstallEvents()
  installListeners.add(cb)
  cb(deferredInstallPrompt !== null)
  return () => {
    installListeners.delete(cb)
  }
}

/** 弹系统安装提示；没有可用事件时返回 `unavailable`（调用方给文字引导）。 */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const evt = deferredInstallPrompt
  if (!evt) return 'unavailable'
  deferredInstallPrompt = null
  try {
    await evt.prompt()
    const choice = await evt.userChoice
    installListeners.forEach((fn) => fn(false))
    return choice.outcome
  } catch {
    return 'unavailable'
  }
}

/** 应用启动时尽早调一次（`main.tsx`），确保不点设置页也能拿到安装事件。 */
export function setupInstallPrompt(): void {
  attachInstallEvents()
}
