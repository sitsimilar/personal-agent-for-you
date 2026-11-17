/**
 * PWA 配置单一事实源（P1-9）。
 *
 * 为什么单独一份而不是直接写在 `vite.config.ts` 里：
 * 验收要求「Cache Storage 没有 `.cloud` / `api` 条目」「`/welcome/` 不被导航回退吞掉」，
 * 这些都是**可以脱离浏览器断言的纯规则**。规则与 `workbox` 选项同源放在这里，
 * `vite.config.ts` 只做消费，`qa/p1-9-pwa.test.ts` 直接 import 断言——配置改了测试就会红，
 * 不必用正则去猜 vite 配置。
 *
 * 白名单口径（第 15 期 UpUp 增补）：**只预缓存构建产物 + 图标 + 字体**，
 * 正文/附件/视频/宣传页/接口一律不进壳缓存。
 */
import type { ManifestOptions } from 'vite-plugin-pwa'

/** 品牌主色，与 `web/src/theme.ts` 的 `primary.main` 同源。 */
export const PWA_BRAND_COLOR = '#5B54D9'

/** 安装后桌面图标下的名字（≤12 字才不会在 Android 桌面被截断成省略号）。 */
export const PWA_SHORT_NAME = '信息管家'

export const PWA_NAME = '个人信息管家'

/**
 * 允许进预缓存的构建产物扩展名白名单（不写裸 `**\/*`）。
 *
 * 刻意**不含 png / svg / ico / webmanifest**：`vite-plugin-pwa` 会把 manifest 与其中列出的图标
 * 自动补进预缓存清单，再从 `globPatterns` 捞一遍就会出现同名双份条目
 * （实测 15 条里有 5 条是重复的）。图片类改由下面 `runtimeCaching` 的 `pa-icons` 按需缓存。
 */
export const PRECACHE_EXTENSIONS = ['html', 'js', 'css', 'woff2', 'woff'] as const

/**
 * 预缓存显式排除清单。
 * - `api` / `.cloud` / `rest` / `storage`：接口与用户数据，必须永远走网络；
 * - `welcome`：官网宣传页自带大量图片与视频，属于「内容」不是「应用壳」；
 * - `version.json`：更新检测端点，缓存住就永远查不到新版本。
 */
export const PRECACHE_IGNORES = [
  '**/api/**',
  '**/.cloud/**',
  '**/rest/**',
  '**/storage/**',
  '**/welcome/**',
  '**/version.json',
  '**/*.mp4',
  '**/*.m4v',
  '**/*.webm',
  '**/*.vtt',
  '**/*.jpg',
  '**/*.jpeg',
  '**/*.webp',
] as const

/** 绝不缓存的路径前缀：接口、用户数据、版本探针。 */
export const NO_CACHE_PATH_PREFIXES = [
  '/api/',
  '/.cloud/',
  '/rest/',
  '/storage/',
  '/version.json',
] as const

/** 应用外壳可以回退到 `index.html` 的路径判定。 */
export function shouldFallbackToShell(pathname: string): boolean {
  if (!pathname || pathname === '/') return true
  const lower = pathname.toLowerCase()
  return !NO_CACHE_PATH_PREFIXES.some((p) => lower.startsWith(p)) && !lower.startsWith('/welcome')
}

/** 该 URL 是否必须直连网络（不允许任何缓存接管）。 */
export function isNoCacheUrl(rawUrl: string): boolean {
  let pathname = rawUrl
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    pathname = String(rawUrl).split('?')[0].split('#')[0]
  }
  const lower = pathname.toLowerCase()
  return NO_CACHE_PATH_PREFIXES.some((p) => lower.startsWith(p)) || lower === '/sw.js'
}

/** 预缓存白名单判定（扩展名 + 非排除路径），与 `globPatterns` / `globIgnores` 同义。 */
export function isPrecachableAsset(rawUrl: string): boolean {
  let pathname = rawUrl
  try {
    pathname = new URL(rawUrl, 'http://localhost').pathname
  } catch {
    pathname = String(rawUrl).split('?')[0].split('#')[0]
  }
  const lower = pathname.toLowerCase()
  if (NO_CACHE_PATH_PREFIXES.some((p) => lower.startsWith(p))) return false
  if (lower.startsWith('/welcome')) return false
  const ext = lower.slice(lower.lastIndexOf('.') + 1)
  return (PRECACHE_EXTENSIONS as readonly string[]).includes(ext)
}

export const PWA_MANIFEST: Partial<ManifestOptions> = {
  id: '/',
  name: PWA_NAME,
  short_name: PWA_SHORT_NAME,
  description: '个人信息管家：想法、资料、待办与日历，一处收拢。',
  lang: 'zh-CN',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  orientation: 'portrait-primary',
  theme_color: PWA_BRAND_COLOR,
  background_color: '#ffffff',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
  shortcuts: [
    { name: '新建记录', short_name: '新建', url: '/?action=create' },
    { name: '待办', short_name: '待办', url: '/todo' },
  ],
}

export const PWA_WORKBOX = {
  globPatterns: [`**/*.{${PRECACHE_EXTENSIONS.join(',')}}`],
  globIgnores: [...PRECACHE_IGNORES],
  navigateFallback: '/index.html',
  // 导航回退**不能**吞掉接口、宣传页与更新探针，否则断网点 /welcome/ 会进应用壳
  navigateFallbackDenylist: [
    /^\/api\//,
    /^\/\.cloud\//,
    /^\/rest\//,
    /^\/storage\//,
    /^\/version\.json/,
    /^\/welcome/,
  ],
  cleanupOutdatedCaches: true,
  clientsClaim: true,
  skipWaiting: true,
  runtimeCaching: [
    // 用户数据接口：永远直连，绝不落缓存（离线时应「不可用」而不是「看到旧数据以为是真的」）
    { urlPattern: /\/\.cloud\//i, handler: 'NetworkOnly' as const },
    { urlPattern: /\/api\//i, handler: 'NetworkOnly' as const },
    { urlPattern: /\/version\.json/i, handler: 'NetworkOnly' as const },
    {
      urlPattern: /\/icons\/[^/?]+\.(?:png|svg|ico)$/i,
      handler: 'CacheFirst' as const,
      options: {
        cacheName: 'pa-icons',
        expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 30 },
      },
    },
    {
      urlPattern: /\/assets\/[^/?]+\.(?:woff2?|ttf)$/i,
      handler: 'CacheFirst' as const,
      options: {
        cacheName: 'pa-fonts',
        expiration: { maxEntries: 12, maxAgeSeconds: 60 * 60 * 24 * 180 },
      },
    },
  ],
}
