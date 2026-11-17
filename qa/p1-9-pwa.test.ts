/**
 * PWA 可安装 + 离线壳（P1-9）测试。
 *
 * 验收原文（§五 11-16 块 + 第 13/14/15 期增补）：
 * - manifest `display: standalone` / `theme_color: #5B54D9` / `start_url: /`；
 * - `navigateFallback: '/index.html'`，但 `/welcome/`、`/api/`、`/.cloud/` 不得被回退吞掉；
 * - `runtimeCaching` 里接口走 `NetworkOnly`，预缓存只收构建产物与字体（白名单）；
 * - 通知可达性三态文案：桌面 / iOS 主屏 / iOS 标签页；
 * - 离线库容量 500、按 `updatedAt` 淘汰但**不误删 `dirty`**。
 *
 * 真机部分（Android Chrome 出现「添加到主屏幕」、断网从图标进入、Cache Storage 实条目）
 * 只能人工验，见交付说明的「需人工」一行；这里锁的是**可脚本化的规则与接线**。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  NO_CACHE_PATH_PREFIXES,
  PRECACHE_EXTENSIONS,
  PRECACHE_IGNORES,
  PWA_BRAND_COLOR,
  PWA_MANIFEST,
  PWA_WORKBOX,
  isNoCacheUrl,
  isPrecachableAsset,
  shouldFallbackToShell,
} from '../web/pwa.config'
import {
  isIosUserAgent,
  registerServiceWorker,
  resolveNotifyEnvKind,
  resolveNotifyReachability,
  resolveNotifyReachability as reach,
} from '../web/src/lib/pwa'
import {
  OFFLINE_MAX_RECORDS,
  formatSnapshotTime,
  selectEvictedIds,
  toOfflineSummary,
  toSnippet,
} from '../web/src/lib/offline-db'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

/** 去掉 `//` 与 `/* *\/` 注释，避免注释里的字样造成假绿（11-09 踩过）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf-8')
}

/* ------------------------------- manifest ------------------------------- */

test('manifest：可安装四要素（standalone / 品牌色 / start_url / scope）', () => {
  assert.equal(PWA_MANIFEST.display, 'standalone')
  assert.equal(PWA_MANIFEST.theme_color, PWA_BRAND_COLOR)
  assert.equal(PWA_BRAND_COLOR, '#5B54D9') // = theme.ts 的 primary.main
  assert.equal(PWA_MANIFEST.start_url, '/')
  assert.equal(PWA_MANIFEST.scope, '/')
  assert.equal(PWA_MANIFEST.name, '个人信息管家')
  assert.ok(PWA_MANIFEST.short_name && PWA_MANIFEST.short_name.length <= 12, 'short_name 超过 12 字会被 Android 桌面截断')
})

test('manifest：图标含 192/512 的 any 与 maskable 两档', () => {
  const icons = PWA_MANIFEST.icons ?? []
  const has = (size: string, purpose: string) =>
    icons.some((i) => i.sizes === size && String(i.purpose) === purpose)
  assert.ok(has('192x192', 'any'))
  assert.ok(has('512x512', 'any'))
  assert.ok(has('192x192', 'maskable'), 'maskable 档缺 192')
  assert.ok(has('512x512', 'maskable'), 'maskable 档缺 512')
  for (const i of icons) {
    assert.ok(i.src?.startsWith('/icons/'), `图标路径应落在 /icons/ 下：${i.src}`)
    assert.equal(i.type, 'image/png')
  }
})

test('图标文件真实存在且尺寸与 manifest 一致（读 PNG IHDR）', () => {
  const dims = (rel: string) => {
    const buf = readFileSync(path.join(ROOT, rel))
    assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG', `${rel} 不是 PNG`)
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
  }
  assert.deepEqual(dims('web/public/icons/icon-192.png'), { w: 192, h: 192 })
  assert.deepEqual(dims('web/public/icons/icon-512.png'), { w: 512, h: 512 })
  assert.deepEqual(dims('web/public/icons/maskable-192.png'), { w: 192, h: 192 })
  assert.deepEqual(dims('web/public/icons/maskable-512.png'), { w: 512, h: 512 })
  assert.deepEqual(dims('web/public/icons/apple-touch-icon-180.png'), { w: 180, h: 180 })
})

/* ------------------------------ workbox 规则 ------------------------------ */

test('workbox：navigateFallback 指向应用壳', () => {
  assert.equal(PWA_WORKBOX.navigateFallback, '/index.html')
  assert.equal(PWA_WORKBOX.cleanupOutdatedCaches, true, '旧缓存必须清，否则升级后出现双份')
})

test('workbox：导航回退不吞接口 / 宣传页 / 版本探针', () => {
  const deny = PWA_WORKBOX.navigateFallbackDenylist as RegExp[]
  const denied = (p: string) => deny.some((re) => re.test(p))
  assert.ok(denied('/api/feed-fetch'))
  assert.ok(denied('/.cloud/database/rest/records'))
  assert.ok(denied('/version.json'))
  assert.ok(denied('/welcome/'))
  assert.ok(denied('/welcome/index.html'))
  // 应用内路由必须仍走回退，否则刷新 /todo 变 404
  assert.ok(!denied('/'))
  assert.ok(!denied('/todo'))
  assert.ok(!denied('/records'))
})

test('预缓存白名单：只收构建产物与字体，不收图片（防 manifest 图标双份）', () => {
  const exts = PRECACHE_EXTENSIONS as readonly string[]
  for (const need of ['html', 'js', 'css']) assert.ok(exts.includes(need), `缺 ${need}`)
  for (const banned of ['png', 'svg', 'ico', 'webmanifest', 'mp4', 'jpg']) {
    assert.ok(!exts.includes(banned), `${banned} 不该进 globPatterns（会与 manifest 注入的条目重复）`)
  }
})

test('预缓存排除清单：接口 / 用户数据 / 宣传页 / 版本探针 / 媒体', () => {
  const ignore = (PRECACHE_IGNORES as readonly string[]).join(' ')
  for (const frag of ['api', '.cloud', 'welcome', 'version.json', 'mp4', 'jpg']) {
    assert.ok(ignore.includes(frag), `排除清单缺 ${frag}`)
  }
  const runtime = PWA_WORKBOX.runtimeCaching as Array<{ urlPattern: RegExp; handler: string }>
  const networkOnly = runtime.filter((r) => r.handler === 'NetworkOnly')
  assert.ok(networkOnly.some((r) => r.urlPattern.test('/.cloud/database/rest/records')))
  assert.ok(networkOnly.some((r) => r.urlPattern.test('/api/feed-fetch')))
  assert.ok(networkOnly.some((r) => r.urlPattern.test('/version.json')))
  // 静态资源走缓存优先
  const cacheFirst = runtime.filter((r) => r.handler === 'CacheFirst')
  assert.ok(cacheFirst.some((r) => r.urlPattern.test('/icons/icon-192.png')))
  assert.ok(cacheFirst.some((r) => r.urlPattern.test('/assets/inter-var.woff2')))
})

test('URL 判定：接口永不缓存，静态资源可预缓存', () => {
  for (const p of NO_CACHE_PATH_PREFIXES) {
    assert.equal(isNoCacheUrl(p + 'x'), true, `${p} 应判为不可缓存`)
  }
  assert.equal(isNoCacheUrl('/.cloud/database/rest/records'), true)
  assert.equal(isNoCacheUrl('https://personal-agent-08495.app.workbuddy.link/.cloud/database/rest'), true)
  assert.equal(isNoCacheUrl('/assets/index-abc.js'), false)
  assert.equal(isNoCacheUrl('/sw.js'), true, 'sw.js 自身不能被缓存（autoUpdate 靠它）')

  assert.equal(isPrecachableAsset('/assets/index-abc.js'), true)
  assert.equal(isPrecachableAsset('index.html'), true)
  assert.equal(isPrecachableAsset('/welcome/assets/cover.png'), false)
  assert.equal(isPrecachableAsset('/version.json'), false)
  assert.equal(isPrecachableAsset('/.cloud/x.js'), false)
  assert.equal(isPrecachableAsset('/api/x.css'), false)
})

test('shouldFallbackToShell 与 denylist 口径一致', () => {
  assert.equal(shouldFallbackToShell('/'), true)
  assert.equal(shouldFallbackToShell('/mindtree'), true)
  assert.equal(shouldFallbackToShell('/welcome'), false)
  assert.equal(shouldFallbackToShell('/welcome/index.html'), false)
  assert.equal(shouldFallbackToShell('/api/link-preview'), false)
  assert.equal(shouldFallbackToShell('/.cloud/auth'), false)
})

/* --------------------------- 通知可达性三态 --------------------------- */

test('可达性：桌面 / 已安装 / iOS 标签页 / 普通标签页 四种环境各不相同', () => {
  const desktop = resolveNotifyReachability({
    hasDesktopBridge: true,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
    standalone: false,
    notificationSupported: true,
    permission: 'granted',
  })
  const installed = reach({
    hasDesktopBridge: false,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari',
    standalone: true,
    notificationSupported: true,
    permission: 'granted',
  })
  const iosTab = reach({
    hasDesktopBridge: false,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari',
    standalone: false,
    notificationSupported: true,
    permission: 'default',
  })
  const browserTab = reach({
    hasDesktopBridge: false,
    userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/120',
    standalone: false,
    notificationSupported: true,
    permission: 'granted',
  })

  assert.equal(desktop.kind, 'desktop')
  assert.equal(desktop.level, 'ok')
  assert.equal(installed.kind, 'installed')
  assert.equal(installed.level, 'ok')
  assert.equal(iosTab.kind, 'ios-tab')
  assert.equal(iosTab.level, 'limited')
  assert.equal(iosTab.action, 'install')
  assert.match(iosTab.detail, /添加到主屏幕/)
  assert.equal(browserTab.kind, 'browser-tab')
  assert.equal(browserTab.level, 'warn')
  assert.equal(browserTab.action, 'install')

  // 四种环境标题不得重复（否则用户看不出差别）
  const titles = new Set([desktop.title, installed.title, iosTab.title, browserTab.title])
  assert.equal(titles.size, 4)
})

test('可达性：权限被拒优先于环境描述（不能让人误以为装到主屏就能收）', () => {
  const denied = reach({
    hasDesktopBridge: false,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari',
    standalone: true,
    notificationSupported: true,
    permission: 'denied',
  })
  assert.equal(denied.level, 'limited')
  assert.equal(denied.action, 'permission')
  assert.match(denied.detail, /拒绝/)

  const unsupported = reach({
    hasDesktopBridge: false,
    userAgent: 'x',
    standalone: false,
    notificationSupported: false,
    permission: 'unsupported',
  })
  assert.equal(unsupported.level, 'limited')
  assert.match(unsupported.detail, /不支持/)
})

test('环境归类：桌面优先于安装态，iPadOS 桌面 UA 仍算 iOS', () => {
  assert.equal(
    resolveNotifyEnvKind({ hasDesktopBridge: true, userAgent: 'x', standalone: true }),
    'desktop',
  )
  assert.equal(
    resolveNotifyEnvKind({ hasDesktopBridge: false, userAgent: 'x', standalone: true }),
    'installed',
  )
  assert.equal(isIosUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), true)
  assert.equal(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 5), true, 'iPadOS 13+ UA 伪装成 macOS')
  assert.equal(isIosUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 0), false, '真 Mac 不该判成 iOS')
  assert.equal(isIosUserAgent('Mozilla/5.0 (Windows NT 10.0)'), false)
})

test('SW 注册在测试环境（无浏览器）不抛错', () => {
  assert.doesNotThrow(() => registerServiceWorker())
  assert.doesNotThrow(() => registerServiceWorker())
})

/* ------------------------------ 离线库 ------------------------------ */

function makeRow(id: number, updatedAt: string, dirty: 0 | 1 = 0) {
  return { id, updatedAt, dirty }
}

test('离线库：超过上限按 updatedAt 淘汰最旧的，但 dirty 一定留下', () => {
  const rows = [
    makeRow(1, '2026-01-01T00:00:00.000Z'),
    makeRow(2, '2026-02-01T00:00:00.000Z'),
    makeRow(3, '2026-03-01T00:00:00.000Z', 1),
    makeRow(4, '2026-04-01T00:00:00.000Z'),
  ]
  const evicted = selectEvictedIds(rows, 2)
  // 脏数据 1 条 → 干净份额 1 条（最新的是 id=4）→ 淘汰 1 和 2
  assert.deepEqual(evicted.sort((a, b) => a - b), [1, 2])
  assert.ok(!evicted.includes(3), 'dirty 项被误删了')
})

test('离线库：脏数据超过上限时宁可超限也不删', () => {
  const rows = [
    makeRow(1, '2026-01-01T00:00:00.000Z', 1),
    makeRow(2, '2026-01-02T00:00:00.000Z', 1),
    makeRow(3, '2026-01-03T00:00:00.000Z', 1),
  ]
  assert.deepEqual(selectEvictedIds(rows, 1), [])
})

test('离线库：同 updatedAt 时按 id 倒序保留（结果稳定，不随输入顺序抖动）', () => {
  const same = '2026-05-01T00:00:00.000Z'
  const rows = [makeRow(7, same), makeRow(9, same), makeRow(8, same)]
  assert.deepEqual(selectEvictedIds(rows, 1), [8, 7])
  assert.deepEqual(selectEvictedIds([...rows].reverse(), 1), [8, 7])
})

test('离线库：limit 边界（0 / 负数 全淘汰，恰好等于条数不淘汰）', () => {
  const rows = [makeRow(1, '2026-01-01T00:00:00.000Z'), makeRow(2, '2026-01-02T00:00:00.000Z')]
  assert.equal(selectEvictedIds(rows, 0).length, 2)
  assert.equal(selectEvictedIds(rows, -3).length, 2)
  assert.deepEqual(selectEvictedIds(rows, 2), [])
  assert.equal(selectEvictedIds(rows, OFFLINE_MAX_RECORDS).length, 0)
})

test('离线摘要：正文压成单行、超长截断、空标题兜底、dirty 恒为 0', () => {
  assert.equal(toSnippet('  第一行\n\n第二行  '), '第一行 第二行')
  const long = 'x'.repeat(300)
  const cut = toSnippet(long)
  assert.equal(cut.length, 121) // 120 + 省略号
  assert.ok(cut.endsWith('…'))

  const summary = toOfflineSummary({
    id: 42,
    type: 'todo',
    title: '   ',
    content: '记得交周报',
    tags: [],
    isDeleted: false,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-02T00:00:00.000Z',
  } as never)
  assert.deepEqual(summary, {
    id: 42,
    type: 'todo',
    title: '（无标题）',
    snippet: '记得交周报',
    updatedAt: '2026-05-02T00:00:00.000Z',
    dirty: 0,
  })
})

test('「数据截至」格式化：非法值回落空串，正常值 M-D HH:mm', () => {
  assert.equal(formatSnapshotTime(null), '')
  assert.equal(formatSnapshotTime('not-a-date'), '')
  const d = new Date('2026-05-04T09:07:00')
  assert.equal(formatSnapshotTime(d.toISOString()), '5-04 09:07')
})

/* -------------------------- 接线（源码级约束） -------------------------- */

test('vite 配置真的装了 VitePWA，且 manifest / workbox 来自同一份配置', () => {
  const src = stripComments(read('web/vite.config.ts'))
  assert.match(src, /VitePWA\(/)
  assert.match(src, /registerType:\s*'autoUpdate'/)
  assert.match(src, /from '\.\/pwa\.config'/)
  assert.match(src, /manifest:\s*PWA_MANIFEST/)
  assert.match(src, /workbox:\s*PWA_WORKBOX/)
  assert.match(src, /injectRegister:\s*null/, '注册要手动接管，不能自动注入')
})

test('依赖锁精确版本（不加 ^ / ~）', () => {
  const pkg = JSON.parse(read('web/package.json')) as {
    devDependencies?: Record<string, string>
    dependencies?: Record<string, string>
  }
  const ver = pkg.devDependencies?.['vite-plugin-pwa']
  assert.ok(ver, 'vite-plugin-pwa 应装在 devDependencies')
  assert.match(ver, /^\d+\.\d+\.\d+$/, `必须精确锁版本，实际：${ver}`)
  // 本日按验收线撤掉了 Dexie：gzip 32.64KB > 25KB 上限
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
  assert.ok(!all.dexie, 'dexie 已按「gzip ≤25KB」验收线下线，别加回来')
})

test('离线库用原生 IndexedDB，且 schema 升级只加索引', () => {
  const src = stripComments(read('web/src/lib/offline-db.ts'))
  assert.ok(!/from ['"]dexie['"]/.test(src), '不许再引 dexie')
  assert.match(src, /onupgradeneeded/)
  assert.match(src, /createIndex\('updatedAt'/)
  assert.match(src, /OFFLINE_DB_VERSION = 2/, 'v2 迁移要留痕（验收：迁移不丢数据）')
})

test('应用启动即挂安装事件 + 注册 SW，且 SW 只在生产与非桌面环境启用', () => {
  const main = stripComments(read('web/src/main.tsx'))
  assert.match(main, /setupInstallPrompt\(\)/)
  assert.match(main, /registerServiceWorker\(\)/)
  assert.match(main, /clearOfflineCache/, '登出要清离线缓存，否则换账号能看到上一个人的标题')

  const pwa = stripComments(read('web/src/lib/pwa.ts'))
  assert.match(pwa, /import\.meta\.env\.PROD/)
  assert.match(pwa, /window\.desktopBridge/, '桌面伴侣不注册 SW')
  assert.match(pwa, /serviceWorker' in navigator/)
})

test('壳层挂离线条幅，设置页挂可达性三态卡片', () => {
  assert.match(stripComments(read('web/src/components/Layout.tsx')), /<OfflineBanner \/>/)
  assert.match(stripComments(read('web/src/pages/SettingsPage.tsx')), /<NotifyReachabilityCard \/>/)
})

test('RecordsPage 动态加载离线库（不进首屏 chunk）+ 断网兜底', () => {
  const src = stripComments(read('web/src/pages/RecordsPage.tsx'))
  assert.match(src, /import\('@\/lib\/offline-db'\)/)
  // 允许的静态引用只有 `import type`（类型在编译期被擦除，不进 chunk）
  const staticRefs = src.split('\n').filter((l) => l.includes("from '@/lib/offline-db'"))
  assert.ok(
    staticRefs.every((l) => /^\s*import type\b/.test(l)),
    `静态 import 会把离线库拖进首屏 chunk（实测会被 rollup 合并）：${staticRefs.join(' | ')}`,
  )
  assert.match(src, /readOnlineStatus/)
  assert.match(src, /数据截至/)
})

test('index.html：主题色与 iOS 主屏图标手写，manifest 交给插件注入', () => {
  const html = read('web/index.html')
  // 主题色只锁「手写了并且给了具体色值」，不锁某个品牌色：线构版改成明/暗两档底色
  const themeColors = [...html.matchAll(/<meta name="theme-color"[^>]*content="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1])
  assert.ok(themeColors.length >= 1, '必须手写 theme-color（iOS 不读 manifest）')
  assert.match(html, /rel="apple-touch-icon" href="\/icons\/apple-touch-icon-180\.png"/)
  assert.match(html, /viewport-fit=cover/)
  assert.ok(!/rel="manifest"/.test(html), 'manifest 链接由 vite-plugin-pwa 注入，手写会重复')
})

test('server.js：sw.js 与 manifest 必须 no-cache，webmanifest 有正确 MIME', () => {
  const src = stripComments(read('server.js'))
  assert.match(src, /\.webmanifest':\s*'application\/manifest\+json/)
  assert.match(src, /isSw/)
  assert.match(src, /'no-cache'/)
})

test('构建产物里能找到 sw.js 与 manifest（跑过 build 才成立，缺则跳过）', () => {
  const dist = path.join(ROOT, 'web', 'dist')
  if (!existsSync(path.join(dist, 'sw.js'))) return
  assert.ok(existsSync(path.join(dist, 'manifest.webmanifest')), '缺 manifest.webmanifest')
  const sw = readFileSync(path.join(dist, 'sw.js'), 'utf-8')
  assert.match(sw, /url:"index\.html"/)
  assert.match(sw, /NetworkOnly/)
  // 预缓存条目不得出现同名二份
  const urls = [...sw.matchAll(/url:\"([^\"]+)\"/g)].map((m) => m[1]).filter((u) => !u.startsWith('data'))
  const dup = urls.filter((u, i) => urls.indexOf(u) !== i)
  assert.deepEqual([...new Set(dup)], [], '预缓存清单出现重复条目')
  assert.ok(!urls.some((u) => u.includes('welcome')), '/welcome/ 不该进预缓存')
  assert.ok(!urls.some((u) => u.includes('.cloud')), '接口不该进预缓存')
})
