import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider } from '@mui/material/styles'
import CssBaseline from '@mui/material/CssBaseline'
import App from './App'
import { buildTheme, type ThemeMode } from './theme'
import './index.css'
import { cloud } from './lib/cloud'
import { authService } from './services/authService'
import { initCrossWindowAuthSync } from './services/authSync'
import { useAuthStore } from './store/authStore'
import { setUnwrapAuthHook } from './lib/unwrap'
import { onServiceError } from './services/authExpired'
import { useUiSchemeStore } from './store/uiSchemeStore'
import { registerServiceWorker, setupInstallPrompt } from './lib/pwa'
import { startSessionGuard } from './services/sessionGuard'
import { resolveColorMode, type ColorScheme } from './lib/color-scheme'

/**
 * PWA（P1-9）：安装事件要在启动最初就挂上（`beforeinstallprompt` 只派发一次），
 * Service Worker 注册只发生在生产构建、且非桌面伴侣环境（内部自判）。
 * 两者都失败静默——离线壳与可安装都是增强项，不能拖垮启动。
 */
setupInstallPrompt()
registerServiceWorker()

/**
 * 界面方案必须在**首帧渲染前**落地：
 * 否则会先按 `:root` 默认令牌画一帧、再跳到用户选的方案，出现肉眼可见的闪烁。
 * 这里只读 localStorage（同步、无网络），代价是微秒级。
 */
useUiSchemeStore.getState().hydrateLocal()

/**
 * 启动引导：
 * 1. 无条件先执行微信登录回调处理（早于路由守卫）；
 * 2. 恢复会话；
 * 3. 订阅登录态变化。
 */
/** 启动超时上限（毫秒）。 */
const BOOT_TIMEOUT_MS = 10_000

async function bootstrap(): Promise<void> {
  // 钩子无网络依赖，尽早注册，避免启动卡顿时登录态回调/401 拦截失效
  authService.onAuthStateChange((_event, session) => {
    useAuthStore.getState().setSession(session)
    // 登出/会话过期：清掉离线缓存，否则换账号后能看到上一个人的记录标题
    if (!session) {
      void import('./lib/offline-db')
        .then((m) => m.clearOfflineCache())
        .catch(() => {})
    }
  })
  // 跨窗口登录态同步：主窗口登录后，悬浮窗据此更新本地会话（含登出）。
  initCrossWindowAuthSync()
  /**
   * 多端会话守护：设备注册 + 前台心跳 + 「被其它设备退出」感知。
   * 必须早于 `getSession()`，否则冷启动恢复出的会话要等到下一次定时器才注册设备。
   */
  startSessionGuard()
  setUnwrapAuthHook(onServiceError)

  const work = (async () => {
    // 1. 微信 Web 登录回调（必须最先执行）
    try {
      const { data: session, error } = await cloud.auth.handleWechatWebCallback()
      if (error) {
        // 回调失败不应导致整个启动崩溃，仅记录告警
        console.warn('[auth] 微信登录回调处理失败')
      }
      if (session) {
        // 成功后清理 URL 中的 code/state，避免刷新重放一次性 code
        window.history.replaceState(null, '', window.location.pathname)
        useAuthStore.getState().setSession(session)
      }
    } catch {
      console.warn('[auth] 微信登录回调处理异常')
    }

    // 2. 恢复会话
    let session: Awaited<ReturnType<typeof authService.getSession>> = null
    try {
      session = await authService.getSession()
      useAuthStore.getState().setSession(session)
    } catch {
      useAuthStore.getState().setSession(null)
    }

    // 3. 启动恢复：会话存在时恢复 enabled 插件（失败不阻断启动）
    if (session) {
      try {
        const { usePluginStore } = await import('./store/pluginStore')
        await usePluginStore.getState().restore()
      } catch {
        console.warn('[plugins] 启动恢复插件失败（不阻断启动）')
      }
    }

    useAuthStore.getState().setInitialized(true)
  })()

  // 3. 超时兜底：网络/会话卡住时给出可读错误 + 重试入口，而非无限「正在加载…」
  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      if (!useAuthStore.getState().initialized) {
        useAuthStore.getState().setBootError('启动超时，请检查网络后重试')
      }
      resolve()
    }, BOOT_TIMEOUT_MS)
  })

  await Promise.race([work, timeout])
}

bootstrap()

/** 系统深浅色媒体查询（不支持 `matchMedia` 的环境回落浅色）。 */
const DARK_QUERY = '(prefers-color-scheme: dark)'

function readThemeMode(): ThemeMode {
  try {
    return window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

/** 首帧前落地主题属性：index.html 的内联脚本已挡一次闪烁，这里是测试/异常环境兜底。 */
function applyThemeAttribute(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode
  document.documentElement.style.colorScheme = mode
}

applyThemeAttribute(readThemeMode())

/**
 * 主题宿主：深浅色三档（跟随系统 / 强制浅色 / 强制深色）+ 对比度滑杆。
 *
 * 1) **override 优先**：用户在设置页选了强制浅/深，监听系统变化时不响应；
 *    只有 `system` 模式下才会跟随系统切换；
 * 2) **对比度影响两层**：背景层 alpha 预算 × multiplier（在 store.applyColorDOM 里合成），
 *    正文次调色 `--ink2/--ink3` 由 CSS 的 `[data-contrast='enhance']` / `dimmed` 选择器微调；
 * 3) 深浅色共用 `theme.ts` 的同一份语义令牌，切模式只重算 MUI 主题，
 *    CSS 变量由 `data-theme` 同步覆盖，不会出现"一半新色、一半旧色"的中间帧。
 */
function ThemeHost({ children }: { children: React.ReactNode }) {
  const colorScheme = useUiSchemeStore((s) => s.colorScheme) as ColorScheme
  const [systemDark, setSystemDark] = useState(() => readThemeMode() === 'dark')

  // 只在 `system` override 下监听系统变化
  useEffect(() => {
    let mq: MediaQueryList | null = null
    try {
      mq = window.matchMedia(DARK_QUERY)
    } catch {
      return
    }
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  const effectiveMode = resolveColorMode(colorScheme, systemDark)

  useEffect(() => {
    applyThemeAttribute(effectiveMode)
    // 每次模式变化都让 store 重新合成背景颜色（底色 token 可能换了）
    useUiSchemeStore.getState().applyColorDOM()
  }, [effectiveMode])

  const muiTheme = useMemo(() => buildTheme(effectiveMode), [effectiveMode])

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  )
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <ThemeHost>
      <App />
    </ThemeHost>
  </React.StrictMode>,
)
