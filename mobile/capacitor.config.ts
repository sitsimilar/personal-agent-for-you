import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Android 壳配置（Capacitor 6）。
 *
 * ## 联网模式（v2.15 切换）
 *
 * 与桌面 Electron 壳对齐：WebView 直接 load 远程 URL，web/dist 的 UI 升级
 * 靠 web 部署生效，壳本身不打包前端资源。
 *
 * 为什么改：
 * - 离线模式每次 UI 升级都要重打 APK（打包 web + cap sync + gradle ≈ 1 分钟）；
 * - 联网模式只需要 `npm run build:web` + `trae-deploy` 10 秒搞定；
 * - Android WebView 在 `https://` 远程域上 `crypto.subtle` / `navigator.serviceWorker`
 *   / 剪贴板 API / 微信登录 PKCE 都可用，行为与桌面浏览器一致。
 *
 * ## 换域名怎么办
 * 如果 web 部署域名变了，改 `server.url`（或临时用 `PA_WEB_URL=...` 覆盖）重打包就行。
 * Android 壳只做一件事：load URL + 原生桥接（返回键、分享、通知）。
 *
 * 域名沿革：
 * - `37k8rptc2oodht504kb.traesite.cn`：Trae 发布位，2026-11-17 实测已 307 跳 Trae 登录页
 *   （发布环境要求登录，等于失效），不可再用；
 * - `personal-agent-08495.app.workbuddy.link`：WorkBuddy 发布位（2026-11-14 起），
 *   HTTPS 有效、裸访问 200、与桌面端同源，为当前默认。
 *
 * ## CORS 注意
 * 云 API endpoint 仍是 `https://personal-agent-08495.app.workbuddy.link`（baked 在
 * web/dist 的 publicConfig 里）。云端 `Access-Control-Allow-Origin` 回显任意 Origin
 * （2026-11-16 用 `https://localhost` 实测通过，允许头含 `X-Device-Id`），
 * 所以 WebView 源站换成任何域名都不影响 API 调用。
 */
const WEB_URL =
  process.env.PA_WEB_URL ?? 'https://personal-agent-08495.app.workbuddy.link/?sharecode=RK3QMHZAJI'

const config: CapacitorConfig = {
  appId: 'com.personalagent.mobile',
  appName: '个人信息管家',
  // 联网模式：web/dist 不打包进 APK；webDir 给 cap sync 保底（万一以后想切回离线）
  webDir: '../web/dist',
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: process.env.CAP_DEBUG === '1',
    useLegacyBridge: false,
  },
  server: {
    // 核心改：load 远程 URL 而不是 assets/public/index.html
    url: WEB_URL,
    // 保留 localhost 作为 fallback（万一远程域名挂了或未配置 server.url）
    androidScheme: 'https',
    hostname: 'localhost',
    // 允许 HTTP 回退（极少数用户用自定义 HTTP 测试域）
    cleartext: false,
  },
  ios: {
    contentInset: 'always',
    scheme: 'App',
  },
}

export default config
