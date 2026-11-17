import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Android 壳配置（Capacitor 6）。
 *
 * 三条定死的口径：
 * 1. **本地打包，不走 `server.url` 远程托管**：WebView 从 APK assets 读 dist，
 *    源站固定为 `https://localhost`（`androidScheme: 'https'`）。云 SDK 的 CORS
 *    实测回显该 Origin（`Access-Control-Allow-Origin: https://localhost`），
 *    登录与数据库请求可直连，且首屏不依赖网络。
 * 2. **必须是 `https` scheme**：Android WebView 在 `http://localhost` 下是
 *    非安全上下文，`crypto.subtle`（云 SDK 的 PKCE）、`navigator.serviceWorker`、
 *    剪贴板 API 全部不可用，微信登录与提醒都会静默失败。
 * 3. **`webContentsDebuggingEnabled` 仅调试构建开**：由 `CAP_DEBUG=1` 控制，
 *    正式包关掉，避免任何人用 chrome://inspect 读到 localStorage 里的会话。
 */
const isDebug = process.env.CAP_DEBUG === '1'

const config: CapacitorConfig = {
  appId: 'com.personalagent.mobile',
  appName: '个人信息管家',
  // dist 由 `npm run build:android` 先构建（含 .env 注入）
  webDir: '../web/dist',
  android: {
    // 与 Electron 侧 keep-awake / 通知口径保持一致的最小权限集
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: isDebug,
    // 允许在 WebView 内直接打开云存储的预签名下载链接（https 之外一律拦截）
    useLegacyBridge: false,
  },
  server: {
    androidScheme: 'https',
    hostname: 'localhost',
  },
  ios: {
    // iOS 暂不发布，只保留同构配置，避免 `cap sync ios` 时再抄一遍
    contentInset: 'always',
    scheme: 'App',
  },
}

export default config
