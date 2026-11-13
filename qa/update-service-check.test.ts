/**
 * web/src/services/updateService.ts 的 checkForUpdate() / currentVersion() 单元测试。
 * 用「相对路径 mock fetch」验证同源 /version.json 被正确请求 —— 这是 CORS 修复的回归验证：
 * 相对路径经浏览器解析为与页面同源，请求不再跨域，从根因上避免被 CORS 拦截。
 * 运行方式：node qa/run-tests.mjs。
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { checkForUpdate, currentVersion } from '../web/src/services/updateService'

const realFetch = globalThis.fetch

/** 用自定义 handler 替换全局 fetch，并记录调用参数。 */
function stubFetch(handler: (url: string, init?: RequestInit) => unknown): void {
  ;(globalThis as Record<string, unknown>).fetch = handler
}

function jsonResponse(body: unknown, ok = true, status = 200): unknown {
  return { ok, status, json: async () => body }
}

afterEach(() => {
  ;(globalThis as Record<string, unknown>).fetch = realFetch
  delete (globalThis as Record<string, unknown>).__APP_VERSION__
})

test('checkForUpdate：使用同源相对路径 /version.json 进行 fetch', async () => {
  let capturedUrl = ''
  let capturedInit: RequestInit | undefined
  stubFetch(async (url: string, init?: RequestInit) => {
    capturedUrl = url
    capturedInit = init
    return jsonResponse({ version: '9.9.9', url: 'https://example.com/dl' })
  })

  const r = await checkForUpdate()

  // 核心回归：URL 必须是相对路径（同源），而非跨域绝对地址
  assert.equal(capturedUrl, '/version.json')
  assert.equal(r.hasUpdate, true)
  assert.equal(r.currentVersion, '0.0.0')
  assert.equal(r.latestVersion, '9.9.9')
  assert.equal(r.info?.version, '9.9.9')
  assert.equal(r.error, undefined)
  // 附带验证请求选项：禁缓存 + 可中止
  assert.equal(capturedInit?.cache, 'no-store')
  assert.ok(capturedInit?.signal instanceof AbortSignal)
})

test('checkForUpdate：最新版本 ≤ 当前版本时 hasUpdate=false', async () => {
  ;(globalThis as Record<string, unknown>).__APP_VERSION__ = '2.13.1'
  stubFetch(async () => jsonResponse({ version: '2.13.0' }))

  const r = await checkForUpdate()
  assert.equal(r.currentVersion, '2.13.1')
  assert.equal(r.latestVersion, '2.13.0')
  assert.equal(r.hasUpdate, false)
})

test('checkForUpdate：HTTP 非 200 返回「更新源不可用」且不抛异常', async () => {
  stubFetch(async () => jsonResponse({}, false, 500))
  const r = await checkForUpdate()
  assert.equal(r.hasUpdate, false)
  assert.equal(r.error, '更新源不可用（HTTP 500）')
})

test('checkForUpdate：fetch 网络异常返回「网络异常」且不抛异常', async () => {
  stubFetch(async () => {
    throw new Error('ECONNREFUSED')
  })
  const r = await checkForUpdate()
  assert.equal(r.hasUpdate, false)
  assert.equal(r.error, '网络异常，无法连接更新源')
})

test('checkForUpdate：版本号缺失或为空返回「版本号解析失败」', async () => {
  stubFetch(async () => jsonResponse({}))
  let r = await checkForUpdate()
  assert.equal(r.hasUpdate, false)
  assert.equal(r.error, '版本号解析失败')

  stubFetch(async () => jsonResponse({ version: '   ' }))
  r = await checkForUpdate()
  assert.equal(r.error, '版本号解析失败')

  stubFetch(async () => jsonResponse(null))
  r = await checkForUpdate()
  assert.equal(r.error, '版本号解析失败')
})

test('currentVersion：读取构建注入的 __APP_VERSION__，缺省回退 0.0.0', () => {
  assert.equal(currentVersion(), '0.0.0')
  ;(globalThis as Record<string, unknown>).__APP_VERSION__ = '2.13.1'
  assert.equal(currentVersion(), '2.13.1')
})
