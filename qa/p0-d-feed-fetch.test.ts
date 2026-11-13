/**
 * P0-3 上半 · `fetchFeed` 状态机与解析层单测。
 *
 * 全部零网络：传输函数注入假响应，时钟注入 `now`，因此每个分支都能重放。
 *
 * 钉死的口径（计划 §13.1 / §14.1 / §16.1 / §17.1 / §18.1，不重新论证）：
 * 1. 304 **不计入失败**：`consecutiveNotModified` 与 `failCount` 是两个独立计数器；
 * 2. 连续 ≥6 次 304 退避 `1h → 2h → 4h → 12h`（封顶），有新条目归零；
 * 3. 三态失败机：`failCount>=3` 才进 `failing` 且**只告警一次**；进 `failing` 后
 *    **连续 2 次成功**回 `ok` 并发一次恢复通知；
 * 4. 内容指纹没变（200 + 同 hash）→ 只更新 `lastFetchedAt`，`entries` 必须为空；
 * 5. 去重键 `guid → 剥跟踪参数的 link → sha1(title+published)`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDedupeKey, contentHash, sha1Hex, stripTrackingParams } from '../web/src/lib/feed-dedupe'
import { htmlToText, parseFeed, parseFeedDate } from '../web/src/lib/feed-parse'
import {
  EMPTY_FEED_STATE,
  fetchFeed,
  feedIdOf,
  normalizeFeedState,
  type FeedHttpRequest,
  type FeedHttpResponse,
  type FeedSource,
  type FeedState,
  type FeedTransport,
} from '../web/src/services/feedService'

/** 测试用订阅源。 */
const FEED: FeedSource = {
  id: 'feed-example',
  title: '示例订阅',
  url: 'https://example.com/rss.xml',
}

/** 注入时钟（所有退避断言都以它为基准）。 */
const NOW = '2026-11-05T02:00:00.000Z'

/** 造一份 RSS 2.0。 */
function rss(
  items: Array<{ title: string; link?: string; guid?: string; date?: string; desc?: string }>,
  channelTitle = '示例频道',
): string {
  const body = items
    .map((item) => {
      const parts = [`<title>${item.title}</title>`]
      if (item.link) parts.push(`<link>${item.link}</link>`)
      if (item.guid) parts.push(`<guid isPermaLink="false">${item.guid}</guid>`)
      if (item.date) parts.push(`<pubDate>${item.date}</pubDate>`)
      if (item.desc) parts.push(`<description><![CDATA[${item.desc}]]></description>`)
      return `<item>${parts.join('')}</item>`
    })
    .join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>${channelTitle}</title>
<link>https://example.com/</link>
<description>频道描述</description>
${body}
</channel></rss>`
}

/** 固定响应。 */
function respond(over: Partial<FeedHttpResponse> = {}): FeedTransport {
  return async () => ({
    status: 200,
    url: FEED.url,
    etag: 'W/"v1"',
    lastModified: 'Wed, 05 Nov 2026 01:00:00 GMT',
    contentType: 'application/rss+xml',
    body: rss([{ title: '第一篇', link: 'https://example.com/p/1', guid: 'p1', date: 'Wed, 05 Nov 2026 01:00:00 GMT' }]),
    ...over,
  })
}

/** 记录调用次数（验证 deferred 真的没发请求）。 */
function counting(inner: FeedTransport): FeedTransport & { calls: FeedHttpRequest[] } {
  const calls: FeedHttpRequest[] = []
  const fn = (async (request: FeedHttpRequest) => {
    calls.push(request)
    return inner(request)
  }) as FeedTransport & { calls: FeedHttpRequest[] }
  fn.calls = calls
  return fn
}

/** 造状态。 */
function state(over: Partial<FeedState> = {}): FeedState {
  return { ...normalizeFeedState(EMPTY_FEED_STATE), ...over }
}

/* ------------------------------ 去重与指纹 ------------------------------ */

test('去重：sha1 已知向量（无 guid 无 link 时用它当键，必须跨实现一致）', () => {
  assert.equal(sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d')
  assert.equal(sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709')
  assert.equal(sha1Hex('中文标题|2026-11-05T01:00:00.000Z').length, 40)
})

test('去重：剥跟踪参数、参数排序、保留 hash', () => {
  assert.equal(
    stripTrackingParams('https://example.com/p/1?utm_source=rss&id=7&fbclid=abc&utm_medium=feed'),
    'https://example.com/p/1?id=7',
  )
  assert.equal(
    stripTrackingParams('https://example.com/p/1?b=2&a=1'),
    stripTrackingParams('https://example.com/p/1?a=1&b=2'),
  )
  assert.equal(stripTrackingParams('https://example.com/p/1#/post/9'), 'https://example.com/p/1#/post/9')
  assert.equal(stripTrackingParams('not a url'), 'not a url')
})

test('去重键优先级：guid → link（剥参数）→ sha1(title+published)', () => {
  assert.equal(buildDedupeKey({ guid: 'g-1', link: 'https://a.com/1', title: 't' }), 'g-1')
  assert.equal(buildDedupeKey({ guid: '  ', link: 'https://a.com/1?utm_source=x', title: 't' }), 'https://a.com/1')
  assert.equal(buildDedupeKey({ guid: '', link: '', title: '标题', publishedAt: '2026-11-05T00:00:00.000Z' }), sha1Hex('标题|2026-11-05T00:00:00.000Z'))
  assert.equal(buildDedupeKey({}), '')
})

test('指纹：同内容同 hash、异内容异 hash；同一 URL 下正文变也变', async () => {
  const a = await contentHash('<rss>a</rss>')
  const b = await contentHash('<rss>a</rss>')
  const c = await contentHash('<rss>b</rss>')
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.ok(a.length >= 8)
})

/* ------------------------------ 解析层 ------------------------------ */

test('解析 RSS：频道标题、绝对链接、ISO 时间、摘要去 HTML', () => {
  const parsed = parseFeed(
    rss([
      {
        title: '带 <b>标签</b> 的标题',
        link: '/p/1',
        guid: 'p1',
        date: 'Wed, 05 Nov 2026 01:00:00 GMT',
        desc: '<p>正文<b>摘要</b> &amp; 更多</p>',
      },
    ]),
    'https://example.com/rss.xml',
  )

  assert.equal(parsed.kind, 'rss')
  assert.equal(parsed.title, '示例频道')
  assert.equal(parsed.siteUrl, 'https://example.com/')
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].guid, 'p1')
  assert.equal(parsed.items[0].link, 'https://example.com/p/1')
  assert.equal(parsed.items[0].title, '带 <b>标签</b> 的标题')
  assert.equal(parsed.items[0].publishedAt, '2026-11-05T01:00:00.000Z')
  // 行内标签（<b>）不插空格——只有块级结束标签才补，否则「正文摘要」会被拆成「正文 摘要」
  assert.equal(parsed.items[0].summary, '正文摘要 & 更多')
})

test('解析 Atom：<id>/<link href>/<summary>/<updated> 都能读，相对链接按 feed 地址补全', () => {
  const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>原子频道</title>
  <subtitle>副标题</subtitle>
  <link rel="alternate" href="https://atom.example.com/"/>
  <entry>
    <id>tag:atom.example.com,2026:1</id>
    <title>原子条目</title>
    <link rel="alternate" href="/p/1"/>
    <updated>2026-11-05T03:00:00+08:00</updated>
    <summary>摘要文本</summary>
    <author><name>某某</name></author>
  </entry>
</feed>`

  const parsed = parseFeed(atom, 'https://atom.example.com/feed.xml')

  assert.equal(parsed.kind, 'atom')
  assert.equal(parsed.title, '原子频道')
  assert.equal(parsed.description, '副标题')
  assert.equal(parsed.items.length, 1)
  assert.equal(parsed.items[0].guid, 'tag:atom.example.com,2026:1')
  assert.equal(parsed.items[0].link, 'https://atom.example.com/p/1')
  assert.equal(parsed.items[0].publishedAt, '2026-11-04T19:00:00.000Z')
})

test('解析：空 feed / HTML 页面都降级为 0 条 + warning，不抛错', () => {
  const empty = parseFeed('<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>')
  assert.equal(empty.items.length, 0)
  assert.ok(empty.warnings.some((w) => w.includes('没有解析出任何条目')))

  const html = parseFeed('<html><body><h1>Not a feed</h1></body></html>')
  assert.equal(html.kind, 'unknown')
  assert.ok(html.warnings.some((w) => w.includes('无法识别订阅格式')))
})

test('解析：日期三种写法 + 不可解析返回 null（不伪造成当前时间）', () => {
  assert.equal(parseFeedDate('Wed, 05 Nov 2026 09:00:00 +0800'), '2026-11-05T01:00:00.000Z')
  assert.equal(parseFeedDate('2026-11-05T09:00:00+08:00'), '2026-11-05T01:00:00.000Z')
  assert.equal(parseFeedDate('2026年11月5日 09:00'), '2026-11-05T01:00:00.000Z')
  assert.equal(parseFeedDate('昨天'), null)
  assert.equal(parseFeedDate(null), null)
})

test('解析：htmlToText 剥脚本样式与标签', () => {
  assert.equal(htmlToText('<style>a{}</style><p>你好<script>x()</script>世界</p>'), '你好 世界')
})

/* ------------------------------ fetchFeed 状态机 ------------------------------ */

test('fetchFeed：200 有新内容 → updated，条目带去重键与来源', async () => {
  const result = await fetchFeed(FEED, { now: NOW, transport: respond() })

  assert.equal(result.outcome, 'updated')
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].dedupeKey, 'p1')
  assert.equal(result.entries[0].feedId, FEED.id)
  assert.equal(result.entries[0].feedTitle, FEED.title)
  assert.equal(result.state.etag, 'W/"v1"')
  assert.equal(result.state.status, 'ok')
  assert.equal(result.state.failCount, 0)
  assert.equal(result.state.lastFetchedAt, NOW)
  assert.equal(result.state.nextFetchAt, null)
  assert.ok(result.state.lastHash)
  assert.equal(result.notice, null)
})

test('fetchFeed：304 → not-modified，只动连续未修改计数，不动 failCount/状态', async () => {
  const result = await fetchFeed(FEED, {
    now: NOW,
    state: state({ failCount: 2, status: 'ok', consecutiveNotModified: 2, etag: 'W/"old"' }),
    transport: respond({ status: 304, body: '', etag: 'W/"v2"' }),
  })

  assert.equal(result.outcome, 'not-modified')
  assert.deepEqual(result.entries, [])
  assert.equal(result.state.consecutiveNotModified, 3)
  assert.equal(result.state.failCount, 2, '304 不得计入失败')
  assert.equal(result.state.status, 'ok')
  assert.equal(result.state.lastFetchedAt, NOW)
  assert.equal(result.state.nextFetchAt, null)
  assert.equal(result.state.etag, 'W/"v2"')
  assert.equal(result.error, null)
})

test('fetchFeed：连续 304 的退避阶梯 1h → 2h → 4h → 12h（封顶）', async () => {
  const ladder = [
    { before: 5, addHours: 1 },
    { before: 6, addHours: 2 },
    { before: 7, addHours: 4 },
    { before: 8, addHours: 12 },
    { before: 12, addHours: 12 },
  ]

  for (const step of ladder) {
    const result = await fetchFeed(FEED, {
      now: NOW,
      state: state({ consecutiveNotModified: step.before, status: 'ok' }),
      transport: respond({ status: 304, body: '' }),
    })
    assert.equal(result.state.consecutiveNotModified, step.before + 1)
    assert.equal(
      result.state.nextFetchAt,
      new Date(Date.parse(NOW) + step.addHours * 60 * 60 * 1000).toISOString(),
      `第 ${step.before + 1} 次 304 应退避 ${step.addHours} 小时`,
    )
  }
})

test('fetchFeed：退避窗口内 deferred，且压根不发请求', async () => {
  const transport = counting(respond())
  const result = await fetchFeed(FEED, {
    now: NOW,
    state: state({ nextFetchAt: '2026-11-05T12:00:00.000Z' }),
    transport,
  })

  assert.equal(result.outcome, 'deferred')
  assert.equal(transport.calls.length, 0)
  assert.deepEqual(result.entries, [])
  assert.equal(result.httpStatus, null)
})

test('fetchFeed：内容指纹没变 → unchanged，entries 必须为空（只更新 lastFetchedAt）', async () => {
  const first = await fetchFeed(FEED, { now: NOW, transport: respond() })
  assert.equal(first.outcome, 'updated')

  const later = '2026-11-05T03:00:00.000Z'
  const second = await fetchFeed(FEED, {
    now: later,
    state: first.state,
    transport: respond({ etag: 'W/"same"' }),
  })

  assert.equal(second.outcome, 'unchanged')
  assert.deepEqual(second.entries, [])
  assert.equal(second.state.lastFetchedAt, later)
  assert.equal(second.state.lastHash, first.state.lastHash)
})

test('fetchFeed：连续 3 次失败才进 failing，且只告警一次；第 4 次不再告警', async () => {
  const failingTransport: FeedTransport = async () => {
    throw Object.assign(new Error('连接被拒绝'), { code: 'NETWORK_ERROR' })
  }

  let current = state()
  const notices: string[] = []
  for (let i = 1; i <= 4; i += 1) {
    const result = await fetchFeed(FEED, {
      now: NOW,
      // 第 4 次清掉退避窗口，模拟已到下一个 tick
      state: { ...current, nextFetchAt: null },
      transport: failingTransport,
    })
    current = result.state
    if (result.notice) notices.push(result.notice.kind)
    assert.equal(result.outcome, 'failed')
    assert.ok(result.error && result.error.message.length > 0)
    if (i < 3) assert.equal(result.state.status, 'new')
    if (i === 3) {
      assert.equal(result.state.status, 'failing')
      assert.equal(result.state.failCount, 3)
      assert.equal(result.state.nextFetchAt, new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString())
    }
  }

  assert.deepEqual(notices, ['failing'], 'failing 期间不得重复告警')
  assert.equal(current.failCount, 4)
  assert.equal(current.status, 'failing')
})

test('fetchFeed：进 failing 后连续 2 次成功才回 ok，并只发一次恢复通知', async () => {
  const failing = state({ status: 'failing', failCount: 3, lastError: '连接被拒绝' })

  const first = await fetchFeed(FEED, { now: NOW, state: { ...failing, nextFetchAt: null }, transport: respond() })
  assert.equal(first.outcome, 'updated')
  assert.equal(first.state.status, 'recovering')
  assert.equal(first.state.consecutiveOk, 1)
  assert.equal(first.notice, null)
  assert.equal(first.state.failCount, 0)
  assert.equal(first.state.lastError, null)

  const second = await fetchFeed(FEED, { now: '2026-11-05T04:00:00.000Z', state: first.state, transport: respond() })
  // 同一份内容 → unchanged，但健康状态照常推进（指纹门只管"要不要写记录"）
  assert.equal(second.outcome, 'unchanged')
  assert.equal(second.state.status, 'ok')
  assert.equal(second.state.consecutiveOk, 0)
  assert.equal(second.notice?.kind, 'recovered')
})

test('fetchFeed：恢复中途又失败 → 回到 failing 且不重复告警', async () => {
  const recovering = state({ status: 'recovering', consecutiveOk: 1, failCount: 0 })
  const result = await fetchFeed(FEED, {
    now: NOW,
    state: recovering,
    transport: async () => {
      throw Object.assign(new Error('又挂了'), { code: 'NETWORK_ERROR' })
    },
  })

  assert.equal(result.outcome, 'failed')
  assert.equal(result.state.status, 'failing')
  assert.equal(result.notice, null)
  assert.equal(result.state.consecutiveOk, 0)
})

test('fetchFeed：上游 500 → failed 且带状态码；401/404 同路', async () => {
  for (const status of [500, 404, 403]) {
    const result = await fetchFeed(FEED, {
      now: NOW,
      transport: respond({ status, body: 'nope' }),
    })
    assert.equal(result.outcome, 'failed')
    assert.equal(result.httpStatus, status)
    assert.equal(result.error?.code, `UPSTREAM_${status}`)
    assert.match(String(result.error?.message), new RegExp(`HTTP ${status}`))
    assert.equal(result.state.failCount, 1)
    assert.equal(result.state.consecutiveNotModified, 0)
  }
})

test('fetchFeed：正文内重复条目按去重键收敛，重复数计入 skipped', async () => {
  const body = rss([
    { title: '同一篇', link: 'https://example.com/p/1?utm_source=a', guid: 'p1' },
    { title: '同一篇（换了渠道）', link: 'https://example.com/p/1?utm_source=b', guid: 'p1' },
    { title: '第二篇', link: 'https://example.com/p/2', guid: 'p2' },
  ])

  const result = await fetchFeed(FEED, { now: NOW, transport: respond({ body }) })

  assert.equal(result.outcome, 'updated')
  assert.deepEqual(result.entries.map((e) => e.dedupeKey), ['p1', 'p2'])
  assert.equal(result.skipped, 1)
})

test('fetchFeed：maxEntries 截断，超出的计入 skipped（防止首抓灌爆库）', async () => {
  const body = rss(Array.from({ length: 5 }, (_, i) => ({ title: `第 ${i} 篇`, guid: `g${i}` })))
  const result = await fetchFeed(FEED, { now: NOW, transport: respond({ body }), maxEntries: 2 })

  assert.equal(result.entries.length, 2)
  assert.equal(result.skipped, 3)
})

test('fetchFeed：没有 etag 时不带条件头（首次抓取），有则带上', async () => {
  const seen: FeedHttpRequest[] = []
  const transport: FeedTransport = async (request) => {
    seen.push(request)
    return { status: 200, url: FEED.url, etag: null, lastModified: null, contentType: 'text/xml', body: rss([]) }
  }

  await fetchFeed(FEED, { now: NOW, transport })
  await fetchFeed(FEED, { now: NOW, transport, state: state({ etag: 'W/"1"', lastModified: 'Wed, 05 Nov 2026 01:00:00 GMT' }) })

  assert.equal(seen[0].etag, null)
  assert.equal(seen[0].lastModified, null)
  assert.equal(seen[1].etag, 'W/"1"')
  assert.equal(seen[1].lastModified, 'Wed, 05 Nov 2026 01:00:00 GMT')
})

test('normalizeFeedState：残缺状态补全为完整状态（云端老数据兜底）', () => {
  const filled = normalizeFeedState({ failCount: -3, status: 'weird' as never })
  assert.equal(filled.failCount, 0)
  assert.equal(filled.status, 'new')
  assert.equal(filled.etag, null)
  assert.equal(filled.consecutiveOk, 0)

  const partial = normalizeFeedState({ etag: 'W/"1"', consecutiveNotModified: 2 })
  assert.equal(partial.etag, 'W/"1"')
  assert.equal(partial.consecutiveNotModified, 2)
  assert.equal(partial.status, 'new')
})

test('feedIdOf：同一地址（含跟踪参数差异）得到同一个 id', () => {
  assert.equal(feedIdOf('https://a.example.com/rss'), feedIdOf('https://a.example.com/rss?utm_source=x'))
  assert.notEqual(feedIdOf('https://a.example.com/rss'), feedIdOf('https://b.example.com/rss'))
})
