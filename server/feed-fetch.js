'use strict'

/**
 * 订阅源抓取代理（P0-3，纯 Node，零第三方依赖）。
 *
 * 为什么必须服务端抓：RSS/Atom 站点绝大多数不给 CORS 头，浏览器直连一律
 * `TypeError: Failed to fetch`；同时条件请求（`If-None-Match`）属于非安全列表头，
 * 直连会触发预检，多数源直接 4xx。
 *
 * 安全模型与 `server/link-preview.js` **同一套**（直接复用其地址判定函数，不复制实现）：
 *   1. 协议仅 http/https；拒绝 userinfo；端口仅 80/443（且与协议匹配）；
 *   2. 主机名黑名单：localhost / *.localhost / *.local / *.internal / metadata.google.internal；
 *   3. DNS 取**全部** A/AAAA，每个地址都必须通过 isPrivateAddress；
 *   4. 建连用 `lookup` 钩子钉住已校验 IP（防 DNS rebinding），Host 头保留域名，HTTPS 带 servername；
 *   5. 重定向 ≤3 跳，每跳重跑 2/3/4；
 *   6. 预算：单次 10s 总超时、响应累计 >2MB 立即中断。
 *
 * 与 link-preview 的两处**有意差异**：
 *   - `Accept` 是 feed 类型，内容类型判定放宽到 text/* 与 xml（老源常报 text/plain）；
 *   - **透传上游 304**：条件请求没变时上游回 304 且无 body，这不是错误，
 *     由前端把 `consecutive_not_modified` +1（见 `web/src/services/feedService.ts`）。
 *
 * 代理环境：本模块**只做直连**。部署容器是直连出网（`viaProxy:false`），
 * 本机开发若在必须走代理的网络里，抓取会失败并给出 `NETWORK_ERROR`——
 * 属已知限制，不在此处重复实现 CONNECT 隧道（那套逻辑在 link-preview 里且绑定了 HTML 语义）。
 */

const dns = require('dns')
const http = require('http')
const https = require('https')
const net = require('net')
const zlib = require('zlib')
const {
  isPrivateAddress,
  isBlockedHostname,
  createRateLimiter,
} = require('./link-preview')

/** 响应体上限 2MB（一个十年老 feed 的完整 XML 通常 <1MB）。 */
const MAX_BYTES = 2 * 1024 * 1024
/** 解压后上限 4MB（防压缩炸弹）。 */
const MAX_DECODED_BYTES = 4 * 1024 * 1024
/** 单次抓取总超时 10s（订阅源普遍比网页慢）。 */
const TIMEOUT_MS = 10000
/** 最大重定向跳数。 */
const MAX_REDIRECTS = 3
/** url 参数长度上限。 */
const MAX_URL_LENGTH = 2048
/** POST 请求体上限 8KB（只承载 url + 两个条件请求头）。 */
const MAX_BODY_BYTES = 8 * 1024
/** 限流：每 IP 每 60s 最多 60 次（一次 tick 可能连抓十几个源）。 */
const RATE_LIMIT = 60
const RATE_WINDOW_MS = 60 * 1000
/** 抓取 UA。 */
const USER_AGENT = 'PersonalAgentBot/2.13 (+feed)'
/** 订阅源可接受的响应类型前缀。 */
const ALLOWED_TYPE_PREFIXES = ['text/', 'application/xml', 'application/rss+xml', 'application/atom+xml', 'application/json']

/** 限流器（模块级单例，与 link-preview 各自独立计数）。 */
const limiter = createRateLimiter({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS })

/** 仅测试用：允许私网地址（默认关闭）。 */
let allowPrivateForTest = false
/** 仅测试用：注入 DNS 解析结果。 */
let lookupForTest = null

/* ------------------------------ 工具 ------------------------------ */

/** 去掉 IPv6 方括号与 zone id。 */
function stripBrackets(host) {
  let value = String(host || '').trim().toLowerCase()
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1)
  const zone = value.indexOf('%')
  if (zone >= 0) value = value.slice(0, zone)
  return value
}

/** 统一响应体。 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/** 失败响应（与 link-preview 同构，前端只读 code / message）。 */
function fail(res, status, code, message, extra) {
  const body = { ok: false, code, message }
  if (extra && Number.isInteger(extra.upstreamStatus)) body.upstreamStatus = extra.upstreamStatus
  sendJson(res, status, body)
}

/** 读取 query 参数（本地开发路径）。 */
function readQueryParam(rawUrl, name) {
  try {
    return new URL(String(rawUrl || '/'), 'http://localhost').searchParams.get(name) || ''
  } catch {
    return ''
  }
}

/** 客户端 IP（含反代头）。 */
function clientIp(req) {
  const forwarded = req.headers && req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    const first = forwarded.split(',')[0].trim()
    if (first) return first
  }
  const socket = req.socket || req.connection
  return (socket && socket.remoteAddress) || 'unknown'
}

/** 读请求体（上限 limit 字节）。 */
function readRequestBody(req, limit) {
  return new Promise((resolve) => {
    let total = 0
    const chunks = []
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const timer = setTimeout(() => finish({ error: true }), 5000)
    if (typeof timer.unref === 'function') timer.unref()

    req.on('data', (chunk) => {
      if (settled) return
      total += chunk.length
      if (total > limit) {
        finish({ tooLarge: true })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      clearTimeout(timer)
      finish({ raw: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', () => {
      clearTimeout(timer)
      finish({ error: true })
    })
  })
}

/** 校验并解析目标 URL（协议/端口/userinfo/黑名单）。 */
function prepareTarget(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl))
  } catch {
    return { error: { status: 400, code: 'BAD_REQUEST', message: '订阅地址格式不正确' } }
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: { status: 400, code: 'UNSUPPORTED_PROTOCOL', message: '仅支持 http/https 订阅地址' } }
  }
  if (url.username || url.password) {
    return { error: { status: 400, code: 'BAD_REQUEST', message: '订阅地址不能包含账号信息' } }
  }
  if (!allowPrivateForTest) {
    const expectedPort = url.protocol === 'https:' ? '443' : '80'
    if (url.port && url.port !== '80' && url.port !== '443') {
      return { error: { status: 400, code: 'PORT_NOT_ALLOWED', message: '仅允许 80/443 端口' } }
    }
    if (url.port && url.port !== expectedPort) {
      return { error: { status: 400, code: 'PORT_NOT_ALLOWED', message: '端口与协议不匹配' } }
    }
  }

  const hostname = url.hostname.toLowerCase()
  if (isBlockedHostname(hostname)) {
    return { error: { status: 403, code: 'BLOCKED_HOST', message: '该地址不允许访问' } }
  }
  return { url, hostname }
}

/** 解析主机并校验全部地址。 */
async function resolveHost(hostname) {
  const bare = stripBrackets(hostname)
  const literalFamily = net.isIP(bare)
  if (literalFamily) {
    if (!allowPrivateForTest && isPrivateAddress(bare)) return { blocked: true }
    return { addresses: [{ address: bare, family: literalFamily }] }
  }

  try {
    const list =
      typeof lookupForTest === 'function'
        ? await lookupForTest(bare)
        : await dns.promises.lookup(bare, { all: true, verbatim: true })
    if (!Array.isArray(list) || list.length === 0) return { failed: true }
    for (const item of list) {
      if (!allowPrivateForTest && isPrivateAddress(item && item.address)) return { blocked: true }
    }
    return { addresses: list.map((item) => ({ address: item.address, family: item.family })) }
  } catch {
    return { failed: true }
  }
}

/** 解压响应体（服务端可能无视 Accept-Encoding: identity）。 */
function decodeBody(buffer, encoding) {
  const value = String(encoding || '').toLowerCase()
  try {
    if (value.includes('br')) return zlib.brotliDecompressSync(buffer, { maxOutputLength: MAX_DECODED_BYTES })
    if (value.includes('gzip')) return zlib.gunzipSync(buffer, { maxOutputLength: MAX_DECODED_BYTES })
    if (value.includes('deflate')) return zlib.inflateSync(buffer, { maxOutputLength: MAX_DECODED_BYTES })
  } catch {
    return null
  }
  return buffer
}

/** 请求头（条件请求 + feed Accept）。 */
function requestHeadersFor(url, etag, lastModified) {
  const headers = {
    Host: url.host,
    'User-Agent': USER_AGENT,
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.8, */*;q=0.5',
    // 不协商压缩：多数源支持 identity，省掉解压分支；少数仍压缩的走 decodeBody 兜底
    'Accept-Encoding': 'identity',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  }
  if (etag) headers['If-None-Match'] = etag
  if (lastModified) headers['If-Modified-Since'] = lastModified
  return headers
}

/**
 * 单跳请求（直连 + DNS 钉扎）。
 *
 * @returns {Promise<{status:number, headers:object, body:Buffer}|{redirect:string}|{error:object}>}
 */
function requestOnce(url, addresses, deadline, conditional) {
  const isHttps = url.protocol === 'https:'
  const hostname = stripBrackets(url.hostname)
  const port = url.port ? Number(url.port) : isHttps ? 443 : 80
  const path = `${url.pathname || '/'}${url.search || ''}`
  const timeoutMs = Math.max(1, deadline - Date.now())
  const headers = requestHeadersFor(url, conditional.etag, conditional.lastModified)
  const pinned = addresses[0]

  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    const options = {
      protocol: url.protocol,
      hostname,
      port,
      path,
      method: 'GET',
      headers,
      // Node ≥20 以 `{ all: true }` 调用 lookup，必须回数组（否则 ERR_INVALID_IP_ADDRESS）
      lookup: (_host, opts, cb) => {
        if (opts && opts.all) cb(null, [{ address: pinned.address, family: pinned.family }])
        else cb(null, pinned.address, pinned.family)
      },
      timeout: timeoutMs,
    }
    if (isHttps && net.isIP(hostname) === 0) options.servername = hostname

    let req
    try {
      req = (isHttps ? https : http).request(options, (res) => {
        const status = res.statusCode || 0
        const responseHeaders = res.headers || {}

        if (status >= 300 && status < 400 && responseHeaders.location) {
          res.resume()
          finish({ redirect: String(responseHeaders.location) })
          return
        }
        if (status === 304) {
          res.resume()
          finish({ status, headers: responseHeaders, body: Buffer.alloc(0) })
          return
        }
        if (status < 200 || status >= 300) {
          res.resume()
          finish({
            error: {
              status: 502,
              code: 'UPSTREAM_ERROR',
              message: `订阅源返回异常状态（HTTP ${status}）`,
              upstreamStatus: status,
            },
          })
          return
        }

        const contentType = String(responseHeaders['content-type'] || '').split(';')[0].trim().toLowerCase()
        const allowed = !contentType || ALLOWED_TYPE_PREFIXES.some((prefix) => contentType.startsWith(prefix))
        if (!allowed) {
          res.resume()
          finish({
            error: {
              status: 415,
              code: 'UNSUPPORTED_CONTENT_TYPE',
              message: `订阅地址返回的不是文本内容（${contentType}）`,
              upstreamStatus: status,
            },
          })
          return
        }

        const chunks = []
        let total = 0
        res.on('data', (chunk) => {
          total += chunk.length
          if (total > MAX_BYTES) {
            res.destroy()
            finish({
              error: { status: 413, code: 'RESPONSE_TOO_LARGE', message: '订阅内容过大（超过 2MB）' },
            })
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          const decoded = decodeBody(Buffer.concat(chunks), responseHeaders['content-encoding'])
          if (!decoded) {
            finish({ error: { status: 502, code: 'DECODE_FAILED', message: '订阅内容解压失败' } })
            return
          }
          finish({ status, headers: responseHeaders, body: decoded })
        })
        res.on('error', () => {
          finish({ error: { status: 502, code: 'UPSTREAM_ERROR', message: '读取订阅内容失败' } })
        })
      })
    } catch {
      finish({ error: { status: 502, code: 'UPSTREAM_ERROR', message: '无法连接订阅源' } })
      return
    }

    req.on('timeout', () => {
      req.destroy()
      finish({ error: { status: 504, code: 'TIMEOUT', message: '抓取超时，请稍后重试' } })
    })
    req.on('error', () => {
      finish({ error: { status: 502, code: 'NETWORK_ERROR', message: '无法连接订阅源' } })
    })
    req.end()
  })
}

/**
 * 抓取（含重定向逐跳复验）。
 *
 * @returns {Promise<{status:number,url:string,etag:string|null,lastModified:string|null,contentType:string|null,body:string}|{error:object}>}
 */
async function fetchFeedDocument(rawUrl, conditional) {
  const deadline = Date.now() + TIMEOUT_MS
  let current = String(rawUrl)

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const prepared = prepareTarget(current)
    if (prepared.error) return { error: prepared.error }

    const resolved = await resolveHost(prepared.hostname)
    if (resolved.blocked) {
      return { error: { status: 403, code: 'BLOCKED_HOST', message: '该地址不允许访问' } }
    }
    if (resolved.failed) {
      return { error: { status: 502, code: 'DNS_FAILED', message: '无法解析订阅地址的域名' } }
    }

    const outcome = await requestOnce(prepared.url, resolved.addresses, deadline, conditional)

    if (outcome.redirect) {
      let next
      try {
        next = new URL(outcome.redirect, prepared.url).toString()
      } catch {
        return { error: { status: 502, code: 'BAD_REDIRECT', message: '订阅源跳转地址不合法' } }
      }
      current = next
      continue
    }
    if (outcome.error) return { error: outcome.error }

    const headers = outcome.headers || {}
    return {
      status: outcome.status,
      url: prepared.url.toString(),
      etag: headers.etag ? String(headers.etag) : null,
      lastModified: headers['last-modified'] ? String(headers['last-modified']) : null,
      contentType: headers['content-type'] ? String(headers['content-type']) : null,
      body: outcome.body.toString('utf8'),
    }
  }

  return { error: { status: 502, code: 'TOO_MANY_REDIRECTS', message: '订阅地址跳转次数过多' } }
}

/**
 * 处理器：`POST /api/feed-fetch` + JSON `{url, etag?, lastModified?}`（生产主路径）；
 * `GET /api/feed-fetch?url=`（本地开发；线上会被 WAF 拦，属已知环境限制）。
 */
async function handleFeedFetch(req, res) {
  try {
    const method = String(req.method || 'GET').toUpperCase()
    if (method !== 'GET' && method !== 'POST') {
      fail(res, 405, 'METHOD_NOT_ALLOWED', '仅支持 GET/POST 请求')
      return
    }

    let rawUrl = ''
    let etag = ''
    let lastModified = ''

    if (method === 'POST') {
      const contentType = String((req.headers && req.headers['content-type']) || '').toLowerCase()
      if (!contentType.includes('application/json')) {
        fail(res, 415, 'UNSUPPORTED_CONTENT_TYPE', '请求体必须是 application/json')
        return
      }
      const body = await readRequestBody(req, MAX_BODY_BYTES)
      if (body.tooLarge) {
        fail(res, 413, 'REQUEST_TOO_LARGE', '请求体过大（上限 8KB）')
        return
      }
      if (body.error) {
        fail(res, 400, 'BAD_REQUEST', '读取请求体失败')
        return
      }
      let payload
      try {
        payload = JSON.parse(body.raw || '')
      } catch {
        fail(res, 400, 'BAD_REQUEST', '请求体不是合法 JSON')
        return
      }
      rawUrl = payload && typeof payload.url === 'string' ? payload.url.trim() : ''
      etag = payload && typeof payload.etag === 'string' ? payload.etag.trim() : ''
      lastModified = payload && typeof payload.lastModified === 'string' ? payload.lastModified.trim() : ''
      if (!rawUrl) {
        fail(res, 400, 'BAD_REQUEST', '缺少 url 参数')
        return
      }
    } else {
      rawUrl = readQueryParam(req.url, 'url').trim()
      etag = readQueryParam(req.url, 'etag').trim()
      lastModified = readQueryParam(req.url, 'lastModified').trim()
      if (!rawUrl) {
        fail(res, 400, 'BAD_REQUEST', '缺少 url 参数')
        return
      }
    }

    if (rawUrl.length > MAX_URL_LENGTH) {
      fail(res, 400, 'BAD_REQUEST', '订阅地址过长')
      return
    }
    if (!limiter.check(clientIp(req))) {
      fail(res, 429, 'RATE_LIMITED', '抓取过于频繁，请稍后再试')
      return
    }

    const result = await fetchFeedDocument(rawUrl, { etag, lastModified })
    if (result.error) {
      fail(res, result.error.status, result.error.code, result.error.message, {
        upstreamStatus: result.error.upstreamStatus,
      })
      return
    }

    sendJson(res, 200, {
      ok: true,
      data: {
        status: result.status,
        url: result.url,
        etag: result.etag,
        lastModified: result.lastModified,
        contentType: result.contentType,
        body: result.body,
      },
    })
  } catch {
    fail(res, 502, 'UPSTREAM_ERROR', '抓取失败，请稍后重试')
  }
}

/* ------------------------------ 测试钩子 ------------------------------ */

function __resetForTest() {
  limiter.reset()
  allowPrivateForTest = false
  lookupForTest = null
}

/** 仅测试用：允许私网地址（本地桩）。 */
function __setAllowPrivateForTest(value) {
  allowPrivateForTest = Boolean(value)
}

/** 仅测试用：注入 DNS 解析结果。 */
function __setLookupForTest(fn) {
  lookupForTest = typeof fn === 'function' ? fn : null
}

module.exports = {
  handleFeedFetch,
  __resetForTest,
  __setAllowPrivateForTest,
  __setLookupForTest,
  MAX_BYTES,
  MAX_REDIRECTS,
  TIMEOUT_MS,
  RATE_LIMIT,
}
