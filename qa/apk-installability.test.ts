/**
 * APK 可安装性：把「装不上」的四类工程原因钉死在配置里。
 *
 * 2026-11-16 实机反馈「安卓安装包无法安装」，排查结论是包本身没问题
 * （minSdk 23 / 无 native / zip 完整 / 签名 v1+v2 有效），真正的雷是这样埋的：
 *
 *   1. **debug 与 release 同包名、不同证书** —— debug 走 `~/.android/debug.keystore`
 *      （`C=US, O=Android, CN=Android Debug`），release 走 `pa-release.jks`。
 *      Android 把「同包名 + 不同证书」判为 `INSTALL_FAILED_UPDATE_INCOMPATIBLE`，
 *      用户看到的就是「应用未安装」；先装 debug 再装 release 100% 失败。
 *   2. **只写 v1+v2**：AGP 在 minSdk<28 时默认不写 v3，部分国内 ROM 的安装校验更挑剔。
 *   3. **minSdk 被误改低**：低于 23（Android 6.0 以下）WebView 拿不到新版内核，
 *      云 SDK 的 PKCE 直接不可用，装了也是白屏。
 *   4. **manifest 关键项被改**：`allowBackup=true` 会让会话跟着云备份迁移，
 *      `exported=false` 会让桌面没有启动入口。
 *
 * 这些都是「改一行就静默坏掉、且只有真机才暴露」的配置，所以用源码级断言兜住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 去掉 Groovy/XML 注释，避免「注释里写了正确做法、代码里没写」骗过断言。 */
function stripComments(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const gradle = stripComments(read('mobile/android/app/build.gradle'))
const variables = stripComments(read('mobile/android/variables.gradle'))
const manifest = stripComments(read('mobile/android/app/src/main/AndroidManifest.xml'))

/* ------------------- 1. debug 与 release 必须同签名 ------------------- */

test('signingConfigs.release 显式开启 v1/v2/v3 三种签名方案', () => {
  // 取 release 签名块（从 `release {` 到下一个 `}` 的顶层收尾靠缩进判断不可靠，
  // 这里用「三行同时存在」的弱断言 + 各自单独断言，避免解析 Groovy 大括号
  assert.match(gradle, /enableV1Signing\s+true/, 'minSdk 23 必须要 v1')
  assert.match(gradle, /enableV2Signing\s+true/, 'Android 7~8 走 v2')
  assert.match(gradle, /enableV3Signing\s+true/, 'Android 9+ 走 v3')
})

test('v4 保持关闭（只对增量安装有用，还会多出 .idsig 旁文件）', () => {
  assert.match(gradle, /enableV4Signing\s+false/)
  assert.ok(!/enableV4Signing\s+true/.test(gradle))
})

/** 截取 `buildTypes { ... }` 这一段（到 `repositories {` 之前）。
 *  不按大括号配对解析 Groovy：`\s{8}\}` 这种写法会被 12 空格缩进的 `}` 回溯命中，
 *  反而匹配到 `signingConfigs.release` 块上（第一版就踩了这个坑）。 */
function buildTypesSection(): string {
  const start = gradle.indexOf('buildTypes {')
  assert.ok(start > 0, '找不到 buildTypes 块')
  const rest = gradle.slice(start)
  const end = rest.indexOf('\nrepositories')
  return end > 0 ? rest.slice(0, end) : rest
}

test('debug 构建也绑定 release 密钥（这是「应用未安装」的根因）', () => {
  const bt = buildTypesSection()
  const debugAt = bt.indexOf('debug {')
  assert.ok(debugAt > 0, 'buildTypes 里没有 debug 块')
  assert.match(
    bt.slice(debugAt),
    /signingConfig\s+signingConfigs\.release/,
    'debug 必须用 release 密钥签，否则与 release 包互相覆盖必失败',
  )
})

test('signingConfigs 声明在 buildTypes 之前（否则 Gradle 报找不到 release()）', () => {
  const signingAt = gradle.indexOf('signingConfigs {')
  const buildTypesAt = gradle.indexOf('buildTypes {')
  assert.ok(signingAt > 0 && buildTypesAt > 0)
  assert.ok(signingAt < buildTypesAt, 'signingConfigs 必须先声明')
})

test('release buildType 仍然绑定签名（不能被顺手改成 unsigned）', () => {
  const bt = buildTypesSection()
  const relAt = bt.indexOf('release {')
  const debugAt = bt.indexOf('debug {')
  assert.ok(relAt > 0 && debugAt > relAt, 'release 块应在 debug 之前')
  assert.match(bt.slice(relAt, debugAt), /signingConfig\s+signingConfigs\.release/)
})

/* ---------------------- 2. SDK 与版本号来源 ---------------------- */

test('minSdk 固定 23（Android 6.0，WebView 可独立升级的下限）', () => {
  assert.match(variables, /minSdkVersion\s*=\s*23\b/)
})

test('compileSdk / targetSdk 一致为 34', () => {
  assert.match(variables, /compileSdkVersion\s*=\s*34\b/)
  assert.match(variables, /targetSdkVersion\s*=\s*34\b/)
})

test('versionName/versionCode 从仓库根 package.json 读，不另开第四处版本号', () => {
  assert.match(gradle, /file\('\.\.\/\.\.\/\.\.\/package\.json'\)/)
  assert.match(gradle, /versionCode\s+appVersionCode/)
  assert.match(gradle, /versionName\s+appVersionName/)
})

/* ------------------------- 3. manifest 关键项 ------------------------- */

test('allowBackup=false：会话在 localStorage，不能随云备份迁到别的设备', () => {
  assert.match(manifest, /android:allowBackup="false"/)
})

test('MainActivity 显式 exported=true（Android 12+ 不带这个属性直接装不上/装完没图标）', () => {
  const activity = manifest.match(/<activity[\s\S]*?>/)
  assert.ok(activity)
  assert.match(activity![0], /android:exported="true"/)
})

test('usesCleartextTraffic=false：只走 https，避免明文流量被系统拦', () => {
  assert.match(manifest, /android:usesCleartextTraffic="false"/)
})

test('启动入口声明 MAIN/LAUNCHER intent-filter', () => {
  assert.match(manifest, /android\.intent\.action\.MAIN/)
  assert.match(manifest, /android\.intent\.category\.LAUNCHER/)
})

/* --------------------- 4. 构建脚本的产物可诊断性 --------------------- */

test('build-apk.mjs 打印签名指纹（同签名才能互相覆盖升级）', () => {
  const script = read('mobile/scripts/build-apk.mjs')
  assert.match(script, /readSignerFingerprint/, '产物摘要里要带证书指纹，否则签名冲突无法自查')
  assert.match(script, /证书：|签名证书：/)
})

test('build-apk.mjs 构建子进程摘掉 NODE_OPTIONS（否则 cap sync 清 assets 会失败）', () => {
  const script = read('mobile/scripts/build-apk.mjs')
  assert.match(script, /delete childEnv\.NODE_OPTIONS/)
  assert.match(script, /delete childEnv\.ELECTRON_RUN_AS_NODE/)
})
