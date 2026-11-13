/**
 * P0-3 上半 · 服务端订阅抓取代理单测（`server/feed-fetch.js`）。
 *
 * 覆盖点（这些只能在本机桩上验，真实源不可控）：
 * 1. 200 正常返回 body + etag/lastModified，且**透传 304**（304 不是错误）；
 * 2. 条件请求头真的发出去了（桩按 If-None-Match 回 304）；
 * 3. 重定向逐跳跟随（≤3 跳）；
 * 4. 协议 / 端口 / 私网三类拒绝；
 * 5. 非文本类型（图片）拒绝为 415，不把二进制塞给前端。
 *
 * 说明：`__setAllowPrivateForTest` 只在本模块生效（与 link-preview 各自的开关独立），
 * 用来允许 `127.0.0.1` 上的桩服务；生产默认关闭。
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import zlib from 'node:zlib'
import { Readable } from 'node:stream'
import feedFetch from '../server/feed-fetch.js'

/** 桩返回的 RSS。 */
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>桩频道</title><link>http://127.0.0.1/</link>
<item><title>桩条目</title><link>http://127.0.0.1/p/1</link><guid>stub-1</guid></item>
</channel></rss>`

let server: http.Server | null = null
let origin = ''

/** 造一个"像 req"的可读流。 */
function makeReq(method: string, url: string, payload?: unknown): unknown {
  const body = payload === undefined ? null : JSON.stringify(payload)
  const stream = Readable.from(body ? [Buffer.from(body, 'utf8')] : []) as unknown as Record<string, unknown>
  stream.method = method
  stream.url = url
  stream.headers = body ? { 'content-type': 'application/json' } : { host: '127.0.0.1' }
  stream.socket = { remoteAddress: '127.0.0.1' }
  return stream
}

/** 造一个"像 res"的收集器。 */
function makeRes(): { res: unknown; read: () => { status: number; body: Record<string, unknown> | null } } {
  let status = 0
  let raw = ''
  const res = {
    writeHead(code: number) {
      status = code
      return res
    },
    end(chunk?: string) {
      raw = chunk ?? ''
    },
  }
  return {
    res,
    read: () => ({ status, body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null }),
  }
}

before(async () => {
  feedFetch.__resetForTest()
  feedFetch.__setAllowPrivateForTest(true)
  server = http.createServer((req, res) => {
    const url = String(req.url || '')

    if (url === '/redirect') {
      res.writeHead(302, { Location: '/rss.xml' })
      res.end()
      return
    }
    if (url === '/image.png') {
      res.writeHead(200, { 'Content-Type': 'image/png' })
      res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      return
    }
    if (url === '/rss.xml') {
      // 条件请求：客户端带了 If-None-Match 且匹配 → 304（无 body）
      if (req.headers['if-none-match'] === 'W/"stub-1"') {
        res.writeHead(304, { ETag: 'W/"stub-1"' })
        res.end()
        return
      }
      res.writeHead(200, {
        'Content-Type': 'application/rss+xml; charset=utf-8',
        ETag: 'W/"stub-1"',
        'Last-Modified': 'Wed, 05 Nov 2026 01:00:00 GMT',
      })
      res.end(RSS)
      return
    }
    if (url === '/gzip.xml') {
      res.writeHead(200, { 'Content-Type': 'application/rss+xml', 'Content-Encoding': 'gzip' })
      res.end(zlib.gzipSync(Buffer.from(RSS, 'utf8')))
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
  const address = server!.address()
  assert.ok(address && typeof address === 'object')
  origin = `http://127.0.0.1:${(address as { port: number }).port}`
})

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
  server = null
  feedFetch.__resetForTest()
})

test('feed-fetch：200 返回正文与 etag/lastModified，且 Content-Type 原样带回', async () => {
  const { res, read } = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', { url: `${origin}/rss.xml` }), res)

  const out = read()
  assert.equal(out.status, 200)
  assert.equal(out.body?.ok, true)
  const data = (out.body as { data: Record<string, unknown> }).data
  assert.equal(data.status, 200)
  assert.match(String(data.body), /桩条目/)
  assert.equal(data.etag, 'W/"stub-1"')
  assert.equal(data.lastModified, 'Wed, 05 Nov 2026 01:00:00 GMT')
  assert.match(String(data.contentType), /application\/rss\+xml/)
})

test('feed-fetch：带 If-None-Match → 上游 304 原样透传（ok:true，body 为空）', async () => {
  const { res, read } = makeRes()
  await feedFetch.handleFeedFetch(
    makeReq('POST', '/api/feed-fetch', { url: `${origin}/rss.xml`, etag: 'W/"stub-1"' }),
    res,
  )

  const out = read()
  assert.equal(out.status, 200)
  const data = (out.body as { data: Record<string, unknown> }).data
  assert.equal(data.status, 304)
  assert.equal(data.body, '')
})

test('feed-fetch：重定向逐跳跟随（302 → 200）', async () => {
  const { res, read } = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', { url: `${origin}/redirect` }), res)

  const data = (read().body as { data: Record<string, unknown> }).data
  assert.equal(data.status, 200)
  assert.match(String(data.body), /桩条目/)
})

test('feed-fetch：gzip 响应自动解压（部分源无视 Accept-Encoding: identity）', async () => {
  const { res, read } = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', { url: `${origin}/gzip.xml` }), res)

  const data = (read().body as { data: Record<string, unknown> }).data
  assert.match(String(data.body), /桩条目/)
})

test('feed-fetch：非文本类型（图片）拒绝为 415', async () => {
  const { res, read } = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', { url: `${origin}/image.png` }), res)

  const out = read()
  assert.equal(out.status, 415)
  assert.equal(out.body?.ok, false)
  assert.equal(out.body?.code, 'UNSUPPORTED_CONTENT_TYPE')
})

test('feed-fetch：上游 404 → 502 + upstreamStatus 带出真实状态码', async () => {
  const { res, read } = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', { url: `${origin}/missing.xml` }), res)

  const out = read()
  assert.equal(out.status, 502)
  assert.equal(out.body?.upstreamStatus, 404)
})

test('feed-fetch：非 http 协议 / 缺 url / 非 JSON 三类入参错误各自拒绝', async () => {
  const badProtocol = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', { url: 'file:///etc/passwd' }), badProtocol.res)
  assert.equal(badProtocol.read().status, 400)
  assert.equal(badProtocol.read().body?.code, 'UNSUPPORTED_PROTOCOL')

  const missing = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', {}), missing.res)
  assert.equal(missing.read().status, 400)

  const notJson = makeRes()
  const stream = Readable.from([Buffer.from('url=x')]) as unknown as Record<string, unknown>
  stream.method = 'POST'
  stream.url = '/api/feed-fetch'
  stream.headers = { 'content-type': 'text/plain' }
  stream.socket = { remoteAddress: '127.0.0.1' }
  await feedFetch.handleFeedFetch(stream, notJson.res)
  assert.equal(notJson.read().status, 415)
})

test('feed-fetch：黑名单主机 / 非 80-443 端口各自拒绝（生产默认口径）', async () => {
  // 关掉测试开关 → 走生产口径：localhost 命中主机名黑名单（没走到 DNS，所以不需要网络）
  feedFetch.__setAllowPrivateForTest(false)

  const blocked = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', { url: 'http://localhost/rss.xml' }), blocked.res)
  assert.equal(blocked.read().status, 403)
  assert.equal(blocked.read().body?.code, 'BLOCKED_HOST')

  // 桩服务用的是随机高位端口，生产口径下应先被端口规则拦（400 PORT_NOT_ALLOWED），
  // 而不是等到连上去才发现是私网
  const badPort = makeRes()
  await feedFetch.handleFeedFetch(makeReq('POST', '/api/feed-fetch', { url: `${origin}/rss.xml` }), badPort.res)
  assert.equal(badPort.read().status, 400)
  assert.equal(badPort.read().body?.code, 'PORT_NOT_ALLOWED')

  feedFetch.__setAllowPrivateForTest(true)
})
