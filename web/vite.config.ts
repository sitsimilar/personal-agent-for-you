import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { PWA_MANIFEST, PWA_WORKBOX } from './pwa.config'

// 注入当前版本号（从 web/package.json 的 version 字段），供更新检测使用。
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8'))

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    /**
     * PWA（P1-9）：manifest / 预缓存白名单 / 导航回退 / 接口 `NetworkOnly` 全部取自
     * `web/pwa.config.ts`，此处只做装配。`injectRegister: null` 表示不自动注入注册脚本，
     * 由 `web/src/lib/pwa.ts` 在启动时手动注册（要同时接管 Electron 跳过与离线条幅）。
     */
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null,
      manifest: PWA_MANIFEST,
      workbox: PWA_WORKBOX,
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../shared'),
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port: 5173,
    host: true,
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
