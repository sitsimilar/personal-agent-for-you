/**
 * Android APK + 多端同时在线（v2.15）测试。
 *
 * 分三层锁：
 * 1. **纯函数**（平台判定 / 设备标签 / 最近活跃时间）——真正的逻辑，直接断言；
 * 2. **接线**（会话守护、设备注册、设置页卡片、登录页微信入口）——源码级断言，
 *    防的是「函数写好了但没接上」这类静默失效；
 * 3. **Android 工程配置**——APK 能不能装、能不能联网、图标在不在，全靠这几个文件，
 *    改动它们不会让 `typecheck` 变红，只能靠测试钉住。
 *
 * 不在这里验的：真机安装、真机登录、WebView 里的 CORS。那些只能人工过一遍，
 * 见交付说明的「需人工」一行。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import {
  buildDeviceLabel,
  createDeviceId,
  detectPlatformFrom,
  platformName,
  readOsName,
  DEVICE_ID_KEY,
} from '../web/src/lib/platform'
import { formatLastSeen, isDeviceOnline, ONLINE_WINDOW_MS } from '../web/src/lib/device-time'
import { isMissingTableError, toDeviceEntry } from '../web/src/services/deviceRegistry'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

/** 读仓库内文件（测试失败时能直接看到是哪个文件不满足）。 */
function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

/* ------------------------------- 1. 平台判定 ------------------------------- */

test('detectPlatformFrom：桌面桥优先于 UA（Electron 的 UA 也带 Windows）', () => {
  assert.equal(
    detectPlatformFrom({
      hasDesktopBridge: true,
      nativePlatform: null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130',
    }),
    'desktop',
  )
})

test('detectPlatformFrom：Capacitor 原生平台优先于 UA', () => {
  assert.equal(
    detectPlatformFrom({
      hasDesktopBridge: false,
      nativePlatform: 'android',
      // Android WebView 的 UA 里同时含 Linux / Android，只看 UA 也能中，但原生桥更权威
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36',
    }),
    'android',
  )
  assert.equal(
    detectPlatformFrom({ hasDesktopBridge: false, nativePlatform: 'ios', userAgent: 'x' }),
    'ios',
  )
})

test('detectPlatformFrom：普通浏览器归类为 web / ios（按 UA）', () => {
  assert.equal(
    detectPlatformFrom({
      hasDesktopBridge: false,
      nativePlatform: null,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130',
    }),
    'web',
  )
  assert.equal(
    detectPlatformFrom({
      hasDesktopBridge: false,
      nativePlatform: null,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
    }),
    'ios',
  )
})

test('detectPlatformFrom：空 UA 不抛错，回落 web', () => {
  assert.equal(detectPlatformFrom({ hasDesktopBridge: false, nativePlatform: null, userAgent: '' }), 'web')
})

test('platformName：四个平台都有中文名，不允许空串', () => {
  for (const p of ['desktop', 'android', 'ios', 'web'] as const) {
    const name = platformName(p)
    assert.ok(name.length > 0, `${p} 缺中文名`)
  }
  assert.match(platformName('android'), /Android/)
  assert.match(platformName('desktop'), /桌面/)
})

test('readOsName / buildDeviceLabel：标签区分系统与形态', () => {
  assert.equal(readOsName('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Windows')
  assert.equal(readOsName('Mozilla/5.0 (Linux; Android 14)'), 'Android')
  assert.equal(readOsName('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'), 'macOS')

  assert.equal(
    buildDeviceLabel({ platform: 'desktop', userAgent: 'Mozilla/5.0 (Windows NT 10.0)' }),
    'Windows · 桌面端',
  )
  assert.equal(
    buildDeviceLabel({ platform: 'android', userAgent: 'Mozilla/5.0 (Linux; Android 14)' }),
    'Android · 手机',
  )
  assert.match(
    buildDeviceLabel({ platform: 'web', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/130' }),
    /Windows · Chrome/,
  )
})

test('createDeviceId：UUID 形态且不重复，且不含主机信息', () => {
  const a = createDeviceId()
  const b = createDeviceId()
  // 第 4 段的最高两位是 variant 位：真 UUID 取 8/9/a/b，兜底实现固定写 a，所以按 [89ab] 断言
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.notEqual(a, b)
  const set = new Set(Array.from({ length: 200 }, () => createDeviceId()))
  assert.equal(set.size, 200, '设备 ID 出现碰撞')
  assert.equal(DEVICE_ID_KEY, 'pa.device.id')
})

test('platform：设备 ID 存 localStorage 而非 Cookie（与云 SDK 会话同介质）', () => {
  const src = read('web/src/lib/platform.ts')
  assert.match(src, /localStorage\.getItem\(DEVICE_ID_KEY\)/)
  assert.match(src, /localStorage\.setItem\(DEVICE_ID_KEY/)
  assert.ok(!/document\.cookie/.test(src), '设备 ID 不应写 Cookie（跨子域会串）')
})

/* ---------------------------- 2. 最近活跃时间 ---------------------------- */

test('formatLastSeen：刚刚 / 分钟 / 小时 / 天 / 日期', () => {
  const now = Date.parse('2026-11-16T12:00:00Z')
  assert.equal(formatLastSeen(new Date(now - 10_000).toISOString(), now), '刚刚')
  assert.equal(formatLastSeen(new Date(now - 3 * 60_000).toISOString(), now), '3 分钟前')
  assert.equal(formatLastSeen(new Date(now - 5 * 3600_000).toISOString(), now), '5 小时前')
  assert.equal(formatLastSeen(new Date(now - 3 * 86400_000).toISOString(), now), '3 天前')
  assert.match(formatLastSeen(new Date(now - 30 * 86400_000).toISOString(), now), /^\d{4}-\d{2}-\d{2}$/)
})

test('formatLastSeen：坏数据与未来时间都不抛错', () => {
  assert.equal(formatLastSeen(''), '未知')
  assert.equal(formatLastSeen('not-a-date'), '未知')
  // 两端时钟不一致时不能显示「-2 分钟前」
  assert.equal(formatLastSeen(new Date(Date.now() + 120_000).toISOString()), '刚刚')
})

test('isDeviceOnline：5 分钟窗口（心跳 60s，容忍两次丢失）', () => {
  const now = 1_700_000_000_000
  assert.equal(isDeviceOnline(new Date(now - 60_000).toISOString(), now), true)
  assert.equal(isDeviceOnline(new Date(now - (ONLINE_WINDOW_MS - 1)).toISOString(), now), true)
  assert.equal(isDeviceOnline(new Date(now - ONLINE_WINDOW_MS - 1).toISOString(), now), false)
  assert.equal(isDeviceOnline('', now), false)
})

/* ------------------------------ 3. 设备注册表 ------------------------------ */

test('toDeviceEntry：脏平台值回落 web，current 按设备 ID 判定', () => {
  const row = {
    id: 1,
    owner_id: 'u',
    device_id: 'dev-a',
    platform: 'harmony', // 脏值
    label: '',
    app_version: '2.13.4',
    created_at: '2026-11-16T00:00:00Z',
    last_seen_at: '2026-11-16T01:00:00Z',
    revoked_at: null,
  }
  const entry = toDeviceEntry(row, 'dev-a')
  assert.equal(entry.platform, 'web')
  assert.equal(entry.current, true)
  assert.equal(entry.revoked, false)

  const other = toDeviceEntry({ ...row, device_id: 'dev-b', platform: 'android', revoked_at: 'x' }, 'dev-a')
  assert.equal(other.platform, 'android')
  assert.equal(other.current, false)
  assert.equal(other.revoked, true)
})

test('isMissingTableError：只认 42P01 / undefined_table，其余照常抛', () => {
  assert.equal(isMissingTableError({ code: '42P01' }), true)
  assert.equal(isMissingTableError({ error: { code: '42P01' } }), true)
  assert.equal(isMissingTableError({ message: 'relation "devices" does not exist' }), false, '仅凭文案不降级')
  assert.equal(isMissingTableError({ message: 'undefined_table: devices' }), true)
  assert.equal(isMissingTableError({ code: '42501' }), false)
  assert.equal(isMissingTableError(null), false)
})

test('deviceRegistry：注册/心跳/注销三处的关键约束', () => {
  const src = read('web/src/services/deviceRegistry.ts')
  // 表名与唯一键口径
  assert.match(src, /from\('devices'\)/)
  assert.match(src, /\.eq\('device_id'/)
  // 重新登录要清空 revoked_at（「请下线」不是「封禁」）
  assert.match(src, /revoked_at: null/)
  // 心跳只写一列，代价必须小
  assert.match(src, /update\(\{ last_seen_at: /)
  // 节流：前台反复切换不该每切一次写一次库
  assert.match(src, /HEARTBEAT_MIN_INTERVAL_MS/)
  // 不允许把自己点下线（那是 signOut 的职责）
  assert.match(src, /if \(deviceId === getDeviceIdentity\(\)\.deviceId\) return false/)
  // 表不存在必须降级而不是抛错
  assert.match(src, /registryAvailable = false/)
})

/* ------------------------------ 4. 会话守护接线 ------------------------------ */

test('sessionGuard：前台恢复校验 + 心跳 + 被注销即登出', () => {
  const src = read('web/src/services/sessionGuard.ts')
  assert.match(src, /authService\.getSession\(\)/, '恢复前台必须先校验会话')
  assert.match(src, /deviceRegistry\.heartbeat\(force\)/)
  assert.match(src, /result === 'revoked'/)
  assert.match(src, /authService\.signOut\(\)/, '被注销要真的清本地会话')
  assert.match(src, /visibilitychange/)
  assert.match(src, /addEventListener\('focus'/)
  assert.match(src, /addEventListener\('online'/)
  // 断网不该把用户踢下线
  assert.match(src, /catch \{\s*\/\/ 断网：保留现有会话/)
})

test('main.tsx：会话守护在启动引导里注册，且早于 getSession', () => {
  const src = read('web/src/main.tsx')
  assert.match(src, /startSessionGuard\(\)/)
  const guardAt = src.indexOf('startSessionGuard()')
  const sessionAt = src.indexOf('await authService.getSession()')
  assert.ok(guardAt > 0, '未接入 startSessionGuard')
  assert.ok(sessionAt > 0, '未找到 getSession')
  assert.ok(guardAt < sessionAt, '守护必须在恢复会话之前挂载，否则首个会话不注册设备')
})

test('设置页挂载「已登录设备」卡片', () => {
  const settings = read('web/src/pages/SettingsPage.tsx')
  assert.match(settings, /import DeviceSessionsCard from '@\/components\/DeviceSessionsCard'/)
  assert.match(settings, /<DeviceSessionsCard \/>/)
  const card = read('web/src/components/DeviceSessionsCard.tsx')
  assert.match(card, /deviceRegistry\.list\(\)/)
  assert.match(card, /deviceRegistry\.revoke\(/)
  assert.match(card, /本机/)
})

/* ---------------------------- 5. 平台差异化行为 ---------------------------- */

test('原生壳不注册 Service Worker（否则 APK 升级后页面还是旧的）', () => {
  const src = read('web/src/lib/pwa.ts')
  const fn = src.slice(src.indexOf('export function registerServiceWorker'))
  assert.match(fn, /if \(isNativeShell\(\)\) return/)
})

test('原生壳通知可达性单独一档（WebView 不发系统通知）', () => {
  const src = read('web/src/lib/pwa.ts')
  assert.match(src, /native: \{\s*kind,\s*level: 'warn'/)
  assert.match(src, /WebView 不提供系统通知能力/)
})

test('安卓壳内隐藏微信扫码登录（OAuth 无法回跳 https://localhost）', () => {
  const src = read('web/src/pages/LoginPage.tsx')
  assert.match(src, /isNativeShell\(\)/)
  assert.match(src, /nativeShell \? \(/)
  assert.match(src, /请使用手机号验证码登录/)
})

/* --------------------------- 6. Android 工程配置 --------------------------- */

test('capacitor.config.ts：本地打包 + https 源站（保证 crypto.subtle 可用）', () => {
  const src = read('mobile/capacitor.config.ts')
  assert.match(src, /appId: 'com\.personalagent\.mobile'/)
  assert.match(src, /webDir: '\.\.\/web\/dist'/)
  assert.match(src, /androidScheme: 'https'/)
  assert.ok(!/server:\s*\{[^}]*url:/.test(src), '不允许退化成远程 server.url（登录源站会变）')
})

test('AndroidManifest：联网权限在、明文流量关、备份关', () => {
  const src = read('mobile/android/app/src/main/AndroidManifest.xml')
  assert.match(src, /android\.permission\.INTERNET/)
  assert.match(src, /android:usesCleartextTraffic="false"/)
  assert.match(src, /android:allowBackup="false"/, '会话存在 localStorage，不能被云备份带走')
  assert.match(src, /android:label="@string\/app_name"/)
})

test('build.gradle：版本号取自根 package.json（不另开一处版本）', () => {
  const src = read('mobile/android/app/build.gradle')
  // app 目录是 mobile/android/app，往上三层才是仓库根（多一层会读到 D:\司凤项目\package.json）
  assert.match(src, /file\('\.\.\/\.\.\/\.\.\/package\.json'\)/)
  assert.match(src, /versionName appVersionName/)
  assert.match(src, /vMajor \* 10000 \+ vMinor \* 100 \+ vPatch/)
})

test('variables.gradle：minSdk 23（Android 6.0 起 WebView 可独立升级）', () => {
  const src = read('mobile/android/variables.gradle')
  assert.match(src, /minSdkVersion = 23/)
  assert.match(src, /compileSdkVersion = 34/)
  assert.match(src, /targetSdkVersion = 34/)
})

test('图标与启动图齐备（含自适应前景 5 档）', () => {
  const densities = ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']
  for (const d of densities) {
    for (const name of ['ic_launcher.png', 'ic_launcher_round.png', 'ic_launcher_foreground.png']) {
      const rel = `mobile/android/app/src/main/res/mipmap-${d}/${name}`
      assert.ok(existsSync(path.join(ROOT, rel)), `缺资源 ${rel}`)
    }
    assert.ok(
      existsSync(path.join(ROOT, `mobile/android/app/src/main/res/drawable-port-${d}/splash.png`)),
      `缺启动图 drawable-port-${d}`,
    )
  }
  // 自适应图标背景必须是品牌色（改回模板的白色会让图标在深色启动器上糊成一团）
  // 注意位置：这个 color 只允许出现在 values/ic_launcher_background.xml，
  // 同时在 colors.xml 里写会被资源合并判 Duplicate resources
  const background = read('mobile/android/app/src/main/res/values/ic_launcher_background.xml')
  assert.match(background, /ic_launcher_background">#5B54D9/)
  const colors = read('mobile/android/app/src/main/res/values/colors.xml')
  assert.ok(
    !/name="ic_launcher_background"/.test(colors),
    'ic_launcher_background 重复定义会导致 mergeDebugResources 失败',
  )
})

test('签名与 SDK 路径不入库（keystore 泄露等于谁都能发假包）', () => {
  const gi = read('mobile/.gitignore')
  assert.match(gi, /android\/local\.properties/)
  assert.match(gi, /keystore\.properties/)
  assert.match(gi, /\.jks/)
})
