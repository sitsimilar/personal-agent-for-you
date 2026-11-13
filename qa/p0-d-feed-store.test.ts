/**
 * P0-3 下半 · 订阅入库纯函数层单测（`web/src/lib/feed-store.ts` + `buildOpml`）。
 *
 * 覆盖四组必须成立的行为（全部零网络、零数据库、时钟注入，可重放）：
 * 1. **合并订阅**：按 `feedIdOf(url)` 判重、保留用户改过的标题、输出顺序稳定、
 *    `incoming` 内部重复只算一次 `duplicated`；
 * 2. **挑选待抓源**：暂停的源跳过、退避窗口内跳过、非法 `nextFetchAt` 当「已到」、
 *    按 `nextFetchAt` 升序（null 最先）、`limit` 上限；
 * 3. **条目 → 记录草稿**：落库 URL 剥跟踪参数、非法 URL 的 `site` 为 null、
 *    `content` 回落链、`externalUid` 与去重键一致；
 * 4. **批次去重** + **OPML 导出**（转义 / 分类分组 / 空数组 / `parseOpml` 往返）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFeedRecord,
  feedIdOf,
  mergeFeedSources,
  partitionNewEntries,
  selectDueFeeds,
} from '../web/src/lib/feed-store'
import { buildOpml, parseOpml, type OpmlFeed } from '../web/src/lib/opml'
import type { FeedEntry, FeedSource, FeedState } from '../web/src/services/feedService'

/** 注入的「当前时刻」（所有与时间相关的断言都以它为基准）。 */
const NOW = '2026-11-06T02:00:00.000Z'

/** 造一条订阅源（id 默认按 URL 派生，模拟真实落库形态）。 */
function source(over: Partial<FeedSource> = {}): FeedSource {
  const url = over.url ?? 'https://a.example.com/rss.xml'
  return {
    id: over.id ?? feedIdOf(url),
    title: over.title ?? 'A 源',
    url,
    htmlUrl: over.htmlUrl ?? null,
    category: over.category ?? null,
    enabled: over.enabled ?? true,
  }
}

/** 造一条抓取条目。 */
function entry(over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    dedupeKey: 'p1',
    title: '第一篇',
    url: 'https://example.com/p/1',
    guid: 'p1',
    publishedAt: null,
    summary: null,
    content: null,
    author: null,
    feedId: 'feed-a',
    feedTitle: 'A 频道',
    ...over,
  }
}

/** 造一份运行时状态（只填用到的字段，`normalizeFeedState` 会补全其余）。 */
function state(over: Partial<FeedState> = {}): FeedState {
  return {
    etag: null,
    lastModified: null,
    failCount: 0,
    consecutiveNotModified: 0,
    consecutiveOk: 0,
    status: 'ok',
    nextFetchAt: null,
    lastHash: null,
    lastFetchedAt: null,
    lastError: null,
    ...over,
  }
}

/* ============================== 1. 合并订阅 ============================== */

test('mergeFeedSources：新增项按 incoming 顺序追加在 existing 之后，id 由 URL 派生', () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  const b = source({ url: 'https://b.example.com/rss.xml', title: 'B 源' })
  const result = mergeFeedSources<FeedSource>([], [a, b])

  assert.equal(result.feeds.length, 2)
  assert.equal(result.added.length, 2)
  assert.equal(result.duplicated, 0)
  assert.deepEqual(
    result.feeds.map((feed) => feed.url),
    ['https://a.example.com/rss.xml', 'https://b.example.com/rss.xml'],
    '新增项顺序必须与 incoming 一致',
  )
  assert.deepEqual(
    result.added.map((feed) => feed.id),
    [feedIdOf('https://a.example.com/rss.xml'), feedIdOf('https://b.example.com/rss.xml')],
    '新加项的 id 必须是 URL 派生值（否则 feed_state 的键对不上）',
  )

  const merged = mergeFeedSources([a], [b])
  assert.deepEqual(
    merged.feeds.map((feed) => feed.url),
    ['https://a.example.com/rss.xml', 'https://b.example.com/rss.xml'],
    '输出顺序：先 existing 原序，再新加项',
  )
})

test('mergeFeedSources：已存在的源保留用户改过的标题，重复项计入 duplicated', () => {
  const existing = source({ url: 'https://a.example.com/rss.xml', title: '我改过的标题' })
  const result = mergeFeedSources(
    [existing],
    [
      source({ url: 'https://a.example.com/rss.xml', title: 'OPML 里的标题' }),
      source({ url: 'https://b.example.com/rss.xml', title: 'B 源' }),
    ],
  )

  assert.equal(result.feeds.length, 2)
  assert.equal(result.added.length, 1)
  assert.equal(result.duplicated, 1)
  assert.equal(result.feeds[0].title, '我改过的标题', '已存在项的标题不得被导入内容覆盖')
  assert.equal(result.added[0].url, 'https://b.example.com/rss.xml')
})

test('mergeFeedSources：incoming 内部重复只算一次 duplicated（先到先得）', () => {
  const result = mergeFeedSources<FeedSource>(
    [],
    [
      source({ url: 'https://a.example.com/rss.xml', title: '第一次' }),
      source({ url: 'https://a.example.com/rss.xml', title: '第二次' }),
    ],
  )

  assert.equal(result.feeds.length, 1)
  assert.equal(result.added.length, 1)
  assert.equal(result.duplicated, 1)
  assert.equal(result.feeds[0].title, '第一次', '同一批里先出现的标题胜出')
})

test('mergeFeedSources：跟踪参数差异视为同一条源（不重复导入）', () => {
  const existing = source({ url: 'https://a.example.com/rss.xml' })
  const result = mergeFeedSources([existing], [source({ url: 'https://a.example.com/rss.xml?utm_source=opml' })])

  assert.equal(result.feeds.length, 1)
  assert.equal(result.added.length, 0)
  assert.equal(result.duplicated, 1)
})

test('mergeFeedSources：地址为空的入参被忽略，既不算新增也不算重复', () => {
  const result = mergeFeedSources([], [source({ url: '', title: '空地址' })])

  assert.equal(result.feeds.length, 0)
  assert.equal(result.added.length, 0)
  assert.equal(result.duplicated, 0)
})

/* ============================== 2. 挑选待抓源 ============================== */

test('selectDueFeeds：暂停的源与退避未到的源都跳过', () => {
  const paused = source({ url: 'https://paused.example.com/rss', enabled: false })
  const backingOff = source({ url: 'https://backoff.example.com/rss' })
  const ready = source({ url: 'https://ready.example.com/rss' })

  const due = selectDueFeeds(
    [paused, backingOff, ready],
    { [backingOff.id]: state({ nextFetchAt: '2026-11-06T12:00:00.000Z' }) },
    NOW,
  )

  assert.deepEqual(
    due.map((feed) => feed.url),
    ['https://ready.example.com/rss'],
    '只应剩下「启用 + 不在退避窗口内」的源',
  )
})

test('selectDueFeeds：nextFetchAt 已到 / 缺失 / 非法一律视为「该抓」', () => {
  const past = source({ url: 'https://past.example.com/rss' })
  const missing = source({ url: 'https://missing.example.com/rss' })
  const broken = source({ url: 'https://broken.example.com/rss' })

  const due = selectDueFeeds(
    [past, missing, broken],
    {
      [past.id]: state({ nextFetchAt: '2026-11-06T01:00:00.000Z' }),
      [broken.id]: state({ nextFetchAt: '这不是时间' }),
    },
    NOW,
  )

  assert.equal(due.length, 3, '脏状态不能让一个源永久停摆')
})

test('selectDueFeeds：按 nextFetchAt 升序，null 最先；同值保持传入顺序', () => {
  const late = source({ url: 'https://late.example.com/rss' })
  const early = source({ url: 'https://early.example.com/rss' })
  const never = source({ url: 'https://never.example.com/rss' })
  const never2 = source({ url: 'https://never2.example.com/rss' })

  // 两个时间都必须早于 NOW（否则会被"还没到"过滤掉，这条用例就成了空断言）
  const due = selectDueFeeds(
    [late, never, early, never2],
    {
      [late.id]: state({ nextFetchAt: '2026-11-06T01:50:00.000Z' }),
      [early.id]: state({ nextFetchAt: '2026-11-06T01:00:00.000Z' }),
    },
    NOW,
  )

  assert.deepEqual(
    due.map((feed) => feed.url),
    [
      'https://never.example.com/rss',
      'https://never2.example.com/rss',
      'https://early.example.com/rss',
      'https://late.example.com/rss',
    ],
    'null 最先，其余按时间升序，同值保持原序',
  )
})

test('selectDueFeeds：默认最多 5 个，可显式收窄', () => {
  const feeds = Array.from({ length: 8 }, (_, index) => source({ url: `https://f${index}.example.com/rss` }))

  assert.equal(selectDueFeeds(feeds, {}, NOW).length, 5, '默认一轮最多 5 个源（避免把页面拖死）')
  assert.equal(selectDueFeeds(feeds, {}, NOW, 2).length, 2)
  assert.equal(selectDueFeeds(feeds, {}, NOW, 0).length, 0, 'limit=0 是合法的「本轮不抓」')
})

/* ============================== 3. 条目 → 记录草稿 ============================== */

test('buildFeedRecord：落库 URL 剥掉跟踪参数，linkMeta/recordMeta 都带来源身份', () => {
  const draft = buildFeedRecord(
    entry({
      dedupeKey: 'p1',
      title: '  第一篇  ',
      url: 'https://example.com/p/1?utm_source=rss&id=7&fbclid=abc',
      guid: 'p1',
      publishedAt: '2026-11-05T01:00:00.000Z',
      content: '<p>正文</p>',
      summary: '摘要',
      feedId: 'feed-a',
      feedTitle: 'A 频道',
    }),
    NOW,
  )

  assert.equal(draft.type, 'material', '订阅条目落成资料（type=material）')
  assert.equal(draft.title, '第一篇')
  assert.equal(draft.content, '<p>正文</p>', 'content 优先于 summary')
  assert.equal(draft.url, 'https://example.com/p/1?id=7', '落库 URL 必须剥掉 utm_/fbclid 等跟踪参数')
  assert.equal(draft.externalUid, 'p1')

  assert.equal(draft.linkMeta.status, 'ok', '抓取成功才有条目，status 固定 ok')
  assert.equal(draft.linkMeta.title, '第一篇')
  assert.equal(draft.linkMeta.site, 'example.com')
  assert.equal(draft.linkMeta.fetchedAt, NOW)
  assert.equal(draft.linkMeta.externalUid, 'p1')
  assert.equal(draft.linkMeta.feedId, 'feed-a')

  assert.equal(draft.recordMeta.source, 'feed')
  assert.equal(draft.recordMeta.externalUid, 'p1')
  assert.equal(draft.recordMeta.feedId, 'feed-a')
  assert.equal(draft.recordMeta.feedTitle, 'A 频道')
  assert.equal(draft.recordMeta.guid, 'p1')
  assert.equal(draft.recordMeta.publishedAt, '2026-11-05T01:00:00.000Z')
  assert.equal(draft.recordMeta.importedAt, NOW)
})

test('buildFeedRecord：标题空 → 未命名条目；content 三段回落；url 空/非法都有明确结果', () => {
  // content 与 summary 都空 → 回落标题
  const fallbackTitle = buildFeedRecord(entry({ title: '第一篇', content: null, summary: null }), NOW)
  assert.equal(fallbackTitle.content, '第一篇', 'content / summary 都空时回落标题')

  // summary 有值 → 用 summary
  const fallbackSummary = buildFeedRecord(entry({ title: '第一篇', content: null, summary: '摘要' }), NOW)
  assert.equal(fallbackSummary.content, '摘要', 'content 缺失时用 summary')

  const noTitle = buildFeedRecord(entry({ title: '   ' }), NOW)
  assert.equal(noTitle.title, '未命名条目', '空白标题必须回落兜底文案')

  const emptyAll = buildFeedRecord(entry({ title: '', content: null, summary: null }), NOW)
  assert.equal(emptyAll.content, '', '三段都空时给空串，不编造内容')

  const noUrl = buildFeedRecord(entry({ url: '' }), NOW)
  assert.equal(noUrl.url, null, '没有链接时落 null（不写空串，避免库里出现两种"空"）')
  assert.equal(noUrl.linkMeta.site, null)

  const badUrl = buildFeedRecord(entry({ url: 'not a url' }), NOW)
  assert.equal(badUrl.url, 'not a url', '非法 URL 原样保留（去重键仍可用）')
  assert.equal(badUrl.linkMeta.site, null, '非法 URL 取不到 host 时给 null')
})

/* ============================== 4. 批次去重 ============================== */

test('partitionNewEntries：与既有键比对 + 批内自去重，空键计入 skipped', () => {
  const result = partitionNewEntries(
    [
      entry({ dedupeKey: 'k1' }),
      entry({ dedupeKey: 'k2' }),
      entry({ dedupeKey: 'k2' }),
      entry({ dedupeKey: '' }),
      entry({ dedupeKey: '   ' }),
    ],
    ['k1'],
  )

  assert.deepEqual(result.fresh.map((item) => item.dedupeKey), ['k2'], '批内重复只收第一条')
  assert.equal(result.duplicated, 2, 'k1 已存在 + k2 批内重复')
  assert.equal(result.skipped, 2, '拿不到去重键的条目不能入库')
})

test('partitionNewEntries：既有键集合可迭代（Set / 数组都行），空键集合不拦任何条目', () => {
  const entries = [entry({ dedupeKey: 'x1' }), entry({ dedupeKey: 'x2' })]

  assert.equal(partitionNewEntries(entries, new Set<string>()).fresh.length, 2)
  assert.equal(partitionNewEntries(entries, []).fresh.length, 2)
  assert.equal(partitionNewEntries([], ['x1']).fresh.length, 0)
})

/* ============================== 5. OPML 导出 ============================== */

test('buildOpml：文本与属性全部转义，非法字符不会破坏 XML', () => {
  const feeds: OpmlFeed[] = [
    {
      title: 'A & B <daily> "引号" \'单引号\'',
      url: 'https://a.example.com/rss.xml?id=1&x=2',
      htmlUrl: 'https://a.example.com/',
      category: '技术 & 产品',
    },
  ]

  const xml = buildOpml(feeds, { title: '我的订阅 & 备份', now: new Date(NOW) })

  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/)
  assert.match(xml, /<opml version="2\.0">/)
  assert.ok(xml.includes('&amp;'), '`&` 必须转成 &amp;')
  assert.ok(xml.includes('&lt;daily&gt;'), '尖括号必须转义')
  assert.ok(xml.includes('&quot;引号&quot;'), '双引号必须转义（否则属性会被截断）')
  assert.ok(xml.includes('&apos;单引号&apos;'), '单引号也必须转义')
  assert.ok(xml.includes('<dateCreated>'), '传了 now 就写 dateCreated')
  // 未转义的裸 `&`（后接非实体）说明有漏转的地方
  assert.doesNotMatch(xml.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, ''), /&/, '不得残留未转义的 &')
})

test('buildOpml：按 category 分组（同分类只包一层文件夹），无分类的直属 body', () => {
  const xml = buildOpml([
    { title: '技术一', url: 'https://t1.example.com/rss', htmlUrl: null, category: '技术' },
    { title: '技术二', url: 'https://t2.example.com/rss', htmlUrl: null, category: '技术' },
    { title: '无分类', url: 'https://n.example.com/rss', htmlUrl: null, category: null },
  ])

  assert.equal((xml.match(/text="技术"/g) ?? []).length, 1, '同一分类只出现一层文件夹')
  assert.equal((xml.match(/type="rss"/g) ?? []).length, 3, '三个叶子 outline')

  const parsed = parseOpml(xml)
  assert.equal(parsed.feeds.length, 3)
  assert.equal(parsed.feeds.filter((feed) => feed.category === '技术').length, 2)
  assert.equal(parsed.feeds.find((feed) => feed.url === 'https://n.example.com/rss')?.category, null)
})

test('buildOpml：往返解析（parseOpml(buildOpml(x))）标题与地址一致', () => {
  const feeds: OpmlFeed[] = [
    { title: 'A & B', url: 'https://a.example.com/rss.xml', htmlUrl: 'https://a.example.com/', category: '技术' },
    { title: '设计源', url: 'https://d.example.com/feed', htmlUrl: null, category: '设计' },
    { title: '无分类源', url: 'https://n.example.com/rss', htmlUrl: null, category: null },
  ]

  const parsed = parseOpml(buildOpml(feeds, { title: '我的订阅' }))

  assert.equal(parsed.title, '我的订阅')
  assert.deepEqual(parsed.skipped, [], '自产文件不应产生任何跳过项')
  assert.equal(parsed.feeds.length, feeds.length)

  const byUrl = new Map(parsed.feeds.map((feed) => [feed.url, feed]))
  for (const feed of feeds) {
    const back = byUrl.get(feed.url)
    assert.ok(back, `往返后必须还能找到 ${feed.url}`)
    assert.equal(back?.title, feed.title, `标题必须一致（${feed.title}）`)
    assert.equal(back?.category, feed.category, `分类必须一致（${feed.title}）`)
  }
})

test('buildOpml：空数组也输出合法空文档（不是空串）', () => {
  const xml = buildOpml([])

  assert.ok(xml.length > 0, '空订阅不是错误，不能返回空串')
  assert.match(xml, /<body>\s*<\/body>/, '必须有空的 body')
  assert.match(xml, /<\/opml>\s*$/)

  const parsed = parseOpml(xml)
  assert.deepEqual(parsed.feeds, [])
  assert.deepEqual(parsed.skipped, [])
})
