/**
 * P0-3 下半 · QA 独立对抗性验证（`web/src/services/feedService.ts` / `lib/feed-store.ts` / `lib/opml.ts`）。
 *
 * 与工程师自测（`p0-d-feed-store.test.ts` / `p0-d-feed-upsert.test.ts`）刻意换角度，
 * 不复用他们的数据构造与断言入口。
 *
 * 覆盖清单（编号与下方分节标题一一对应；改动用例时同步改这里，别再写「现状锁定 / 缺口见 §x」
 * 这类会随修复失效的说法）：
 * 1. **upsertEntries 的零请求口径**（§1）：空数组 / 全部拿不到去重键时零数据库调用；
 * 2. **304 退避阶梯**（§2）：逐档核对毫秒数、退避窗口内 deferred、有新条目即归零；
 * 3. **fetchFeed 三态失败机直连**（§3）：3 次才 failing 且只告警 1 次、连续 2 次成功才回 ok
 *    且只发 1 条恢复、恢复期掉回 failing 不再告警（成功已把 failCount 归零）、
 *    failing 期间 304 不动计数器；
 * 4. **buildFeedRecord 的 url 边界**（§4）：null / 空串 / 纯空白 / 相对路径 / 带 hash /
 *    只剩跟踪参数 / 非字符串；
 * 5. **OPML 往返**（§5）：title / url / category 同时含 `<&"'` 与字面量 `&amp;` 时不二次转义；
 * 6. **runFeedTick 失败分支**（§6）：配置回写失败（persistError）后记录仍入库、下一轮状态自洽；
 *    落库抛非 23505 时**必须与 `fetchFeed` 的失败路径共用同一状态机**（门槛 / 退避 / 告警去重），
 *    并与「上游 500」在同一状态输入下逐字段对拍；落库失败时 `lastHash` 回滚到抓取前；
 *    异常路径进入 failing 后的恢复口径同样是「连续 2 次成功 + 只 1 条 recovered」；
 * 7. **runFeedTickIfDue 三闸**（§7）：免打扰 / 断网 / 节流都返回 null 且**零网络请求**，
 *    免打扰不占用节流额度；
 * 8. **缺列硬失败**（§8）：settings 写入侧 42703 与 PGRST204 都抛 `FeedSchemaMissingError`，
 *    文案含迁移路径；
 * 9. **单源失败隔离 / 批内去重 / 重复导入**（§9）：三源中间一源 500 不中断整批、
 *    tick 层告警回调抛错不外溢、同 URL（含跟踪参数差异）只加一条。
 *
 * 时钟一律注入（`T0` / 偏移量），不写死当前时间；零网络、零真实数据库。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __dbCalls,
  __dbInserts,
  __dbUpdates,
  __queueDbResults,
  __resetDbCalls,
  __resetDbQueue,
  __resetDbWrites,
  __setDbResult,
} from './mocks/cloud'
import {
  FeedSchemaMissingError,
  addFeeds,
  fetchFeed,
  feedIdOf,
  isFeedSchemaMissingError,
  normalizeFeedState,
  runFeedTick,
  runFeedTickIfDue,
  saveFeedConfig,
  upsertEntries,
  type FeedEntry,
  type FeedHttpResponse,
  type FeedSource,
  type FeedState,
  type FeedTransport,
} from '../web/src/services/feedService'
import { buildFeedRecord } from '../web/src/lib/feed-store'
import { buildOpml, parseOpml, type OpmlFeed } from '../web/src/lib/opml'

/* ============================== 常量与数据构造 ============================== */

/** 注入的「当前时刻」。 */
const T0 = '2026-11-06T02:00:00.000Z'
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
/** 迁移文件的修复路径（文案必须原样到达用户）。 */
const MIGRATION_PATH = 'docs/v2.14/migration.sql'

beforeEach(() => {
  __resetDbCalls()
  __resetDbQueue()
  __resetDbWrites()
  // 兜底：未显式入队的结果一律当「无数据、无错误」
  __setDbResult({ data: null })
})

/** ISO + 毫秒偏移 → ISO。 */
function plus(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

/** 造一条订阅源。 */
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
  const key = over.dedupeKey ?? 'k1'
  return {
    dedupeKey: key,
    title: `${key} 标题`,
    url: `https://example.com/p/${key}`,
    guid: key || null,
    publishedAt: null,
    summary: null,
    content: null,
    author: null,
    feedId: 'feed-a',
    feedTitle: 'A 频道',
    ...over,
  }
}

/** XML 文本转义（`&` 先转，避免把 `&amp;` 里的 `&` 再转一次）。 */
function xmlText(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 造一份 RSS 2.0（`link` 里的 `&` 会被正确转义，供「落库 URL 剥参数」用例使用）。 */
function rss(items: Array<{ title: string; link: string; guid: string }>): string {
  const body = items
    .map(
      (item) =>
        `<item><title>${xmlText(item.title)}</title><link>${xmlText(item.link)}</link>` +
        `<guid isPermaLink="false">${xmlText(item.guid)}</guid></item>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>频道</title>${body}</channel></rss>`
}

/** 一份 200 响应（单个条目）。 */
function okResponse(url: string, guid: string, link?: string): FeedHttpResponse {
  return {
    status: 200,
    url,
    etag: `W/"${guid}"`,
    lastModified: null,
    contentType: 'application/rss+xml',
    body: rss([{ title: `条目 ${guid}`, link: link ?? `https://example.com/p/${guid}`, guid }]),
  }
}

/** 一份 304 响应（body 必空）。 */
function notModified(url: string): FeedHttpResponse {
  return { status: 304, url, etag: 'W/"e"', lastModified: null, contentType: null, body: '' }
}

/** 最后一条配置回写载荷（`saveFeedConfig` → `profileService.save` → update）。 */
function lastUpdate(): Record<string, unknown> {
  const patch = __dbUpdates[__dbUpdates.length - 1]
  assert.ok(patch, '应当有一次配置回写')
  return patch
}

/** 某类调用被调用几次。 */
function countCalls(token: string): number {
  return __dbCalls.filter((call) => call === token).length
}

/* ============================== 1. upsertEntries 的「零请求」口径 ============================== */

test('upsertEntries：空数组与「全部条目都拿不到去重键」都是零数据库调用', async () => {
  assert.deepEqual(await upsertEntries([], { now: T0 }), { inserted: 0, duplicated: 0, skipped: 0 })
  assert.equal(__dbCalls.length, 0, '空数组必须零调用')

  __resetDbCalls()
  const noKey = [entry({ dedupeKey: '' }), entry({ dedupeKey: '   ' })]
  const result = await upsertEntries(noKey, { now: T0 })

  assert.deepEqual(result, { inserted: 0, duplicated: 0, skipped: 2 })
  assert.equal(__dbCalls.length, 0, '没有可查的键时不该发一次空 in(...) 查询')
})

/* ============================== 2. 304 退避阶梯（逐档核对毫秒） ============================== */

test('fetchFeed：304 只动 consecutiveNotModified，退避阶梯 1h→2h→4h→12h 封顶，新条目后归零', async () => {
  const transport: FeedTransport = async (request) => notModified(request.url)

  let state = normalizeFeedState({
    failCount: 2,
    status: 'ok',
    lastError: '上一次的错误',
    consecutiveNotModified: 5,
  })
  let clock = Date.parse(T0)
  const expectedHours = [1, 2, 4, 12, 12]

  for (const hours of expectedHours) {
    const now = new Date(clock + 1).toISOString()
    const result = await fetchFeed(source(), { state, now, transport })

    assert.equal(result.outcome, 'not-modified')
    assert.equal(result.httpStatus, 304)
    assert.equal(result.state.consecutiveNotModified, state.consecutiveNotModified + 1, '只 +1 连续未修改')
    assert.equal(result.state.failCount, 2, '304 不得计入 failCount')
    assert.equal(result.state.status, 'ok', '304 不得改变健康态')
    assert.equal(result.state.lastError, '上一次的错误', '304 不清空既有错误（保守口径）')
    assert.ok(result.state.nextFetchAt, `${result.state.consecutiveNotModified} 次后必须出现 nextFetchAt`)
    assert.equal(
      Date.parse(result.state.nextFetchAt as string) - Date.parse(now),
      hours * HOUR,
      `第 ${result.state.consecutiveNotModified} 次 304 的退避应为 ${hours}h`,
    )

    state = result.state
    clock = Date.parse(result.state.nextFetchAt as string)
  }

  // 退避窗口内（比 nextFetchAt 早 1 秒）：一个请求都不发
  const deferred = await fetchFeed(source(), {
    state,
    now: new Date(clock - 1000).toISOString(),
    transport: async () => {
      throw new Error('退避窗口内不得发请求')
    },
  })
  assert.equal(deferred.outcome, 'deferred')
  assert.equal(deferred.httpStatus, null)

  // 窗口过期后拿到新条目 → 退避与计数全部归零
  const fresh = await fetchFeed(source(), {
    state,
    now: new Date(clock + 1).toISOString(),
    transport: async (request) => okResponse(request.url, 'fresh-1'),
  })
  assert.equal(fresh.outcome, 'updated')
  assert.equal(fresh.state.consecutiveNotModified, 0, '有新条目即归零')
  assert.equal(fresh.state.nextFetchAt, null)
  assert.equal(fresh.state.lastError, null, '成功清空 lastError')
})

/* ============================== 3. 三态失败机（直连 fetchFeed） ============================== */

test('fetchFeed：3 次失败才 failing 且只告警 1 次；随后 2 次成功才回 ok 且只发 1 条恢复', async () => {
  const fail: FeedTransport = async (request) => ({
    status: 403,
    url: request.url,
    etag: null,
    lastModified: null,
    contentType: null,
    body: '',
  })
  const ok: FeedTransport = async (request) => okResponse(request.url, 'e-1')

  let state = normalizeFeedState({})
  let clock = Date.parse(T0)
  const failingNotices: string[] = []

  // 连续 5 次 403：只有第 3 次进 failing 且带通知
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const now = new Date(clock + 1).toISOString()
    const result = await fetchFeed(source(), { state, now, transport: fail })

    assert.equal(result.outcome, 'failed')
    assert.equal(result.state.failCount, attempt)
    assert.ok(result.state.lastError, `第 ${attempt} 次失败必须留下可读原因`)
    assert.equal(result.state.status, attempt >= 3 ? 'failing' : 'new', '必须 3 次才进 failing')
    if (result.notice) failingNotices.push(result.notice.kind)

    state = result.state
    clock = Date.parse(result.state.nextFetchAt ?? now)
  }
  assert.deepEqual(failingNotices, ['failing'], 'failing 期间再失败 2 次不得重复告警')

  // 连续成功：第 1 次只到 recovering，第 2 次才回 ok 并发 1 条恢复
  const statuses: string[] = []
  const healthNotices: string[] = []
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const now = new Date(clock + 1).toISOString()
    const result = await fetchFeed(source(), { state, now, transport: ok })
    statuses.push(result.state.status)
    if (result.notice) healthNotices.push(result.notice.kind)
    state = result.state
    clock = Date.parse(now)
  }
  assert.deepEqual(statuses, ['recovering', 'ok', 'ok'], '2 次成功才回 ok')
  assert.deepEqual(healthNotices, ['recovered'], '恢复通知只发 1 条')

  // 恢复期再掉一次：立刻回 failing，且不再发告警。
  // 这里**不是因为**「门槛已过」（成功会把 failCount 归零，所以 recovering 恒 failCount=0），
  // 而是「回退这次是第 1 次失败、未到 3 次门槛」。两者都要求 notices 为空，故断言成立；
  // 附带的不变式：recovering ⇒ failCount===0，任何 fixture 都得遵守，否则状态机不可达。
  const relapsed = await fetchFeed(source(), {
    state: normalizeFeedState({ status: 'recovering', consecutiveOk: 1 }),
    now: T0,
    transport: fail,
  })
  assert.equal(relapsed.state.status, 'failing')
  assert.equal(relapsed.state.failCount, 1)
  assert.equal(relapsed.notice, null, '回退这次未到门槛，不得发新告警')

  // failing 期间的 304：不动 failCount / status
  const duringFailing = await fetchFeed(source(), {
    state: normalizeFeedState({ status: 'failing', failCount: 3, lastError: 'boom' }),
    now: T0,
    transport: async (request) => notModified(request.url),
  })
  assert.equal(duringFailing.state.status, 'failing')
  assert.equal(duringFailing.state.failCount, 3)
  assert.equal(duringFailing.state.consecutiveNotModified, 1)
  assert.equal(duringFailing.notice, null)
})

/* ============================== 4. buildFeedRecord 的 url 边界 ============================== */

test('buildFeedRecord：url 为 null / 空串 / 纯空白 / 相对路径 / 带 hash / 只剩跟踪参数 都不抛异常', () => {
  const cases: Array<{ url: string | null; expectUrl: string | null; expectSite: string | null }> = [
    { url: null, expectUrl: null, expectSite: null },
    { url: '', expectUrl: null, expectSite: null },
    { url: '   ', expectUrl: null, expectSite: null },
    // 相对路径：解析层已用 absolutize 补全，这里是防御口径——原样保留、site 为 null、不抛异常
    { url: '/p/1', expectUrl: '/p/1', expectSite: null },
    { url: 'https://example.com/p/1#sec-2', expectUrl: 'https://example.com/p/1#sec-2', expectSite: 'example.com' },
    {
      url: 'https://example.com/p/1?utm_source=x&fbclid=y',
      expectUrl: 'https://example.com/p/1',
      expectSite: 'example.com',
    },
    {
      url: 'https://www.example.com/p/1?id=2&utm_medium=rss&fbclid=z#frag',
      expectUrl: 'https://www.example.com/p/1?id=2#frag',
      expectSite: 'example.com',
    },
  ]

  for (const item of cases) {
    const draft = buildFeedRecord(entry({ url: item.url }), T0)
    assert.equal(draft.url, item.expectUrl, `url=${JSON.stringify(item.url)} 的落库值`)
    assert.equal(draft.linkMeta.site, item.expectSite, `url=${JSON.stringify(item.url)} 的 site`)
    assert.equal(draft.linkMeta.fetchedAt, T0, '时刻必须是注入值')
  }

  // 非字符串（脏数据）不得抛异常：会被 String() 归一
  const weird = buildFeedRecord({ ...entry(), url: 123 } as unknown as FeedEntry, T0)
  assert.equal(weird.url, '123')
  assert.equal(weird.linkMeta.site, null)

  // 只有跟踪参数时，剥完是「空查询」，需要留下可用的根地址
  const onlyTracking = buildFeedRecord(entry({ url: 'https://example.com/p/1?utm_source=x' }), T0)
  assert.equal(onlyTracking.url, 'https://example.com/p/1', '剥完不得留下裸 `?`')
})

/* ============================== 5. OPML 往返（特殊字符） ============================== */

test('buildOpml ↔ parseOpml：title/url/category 含 <&"\' 与字面量 &amp; 都能原样往返', () => {
  const trickyTitle = `A <&"' B`
  const trickyCategory = '技术 & <产品>'
  const feeds: OpmlFeed[] = [
    {
      title: trickyTitle,
      url: 'https://a.example.com/rss.xml?x=1&y=2',
      htmlUrl: 'https://a.example.com/?a=1&b=2',
      category: trickyCategory,
    },
    // 字面量 `&amp;` 必须只转义一次（否则往返后变成 `&`）
    { title: '&amp; 字面量', url: 'https://b.example.com/feed', htmlUrl: null, category: null },
  ]

  const xml = buildOpml(feeds, { title: `我的 & <订阅> "备份"` })
  const parsed = parseOpml(xml)

  assert.equal(parsed.title, `我的 & <订阅> "备份"`)
  assert.deepEqual(parsed.skipped, [], '自产文件不应产生跳过项')
  assert.equal(parsed.feeds.length, 2)

  const byUrl = new Map(parsed.feeds.map((feed) => [feed.url, feed]))
  for (const feed of feeds) {
    const back = byUrl.get(feed.url)
    assert.ok(back, `往返后必须还能找到 ${feed.url}`)
    assert.equal(back?.title, feed.title, '标题必须逐字一致（含 <> & " \'）')
    assert.equal(back?.category, feed.category, '分类必须逐字一致')
    assert.equal(back?.htmlUrl, feed.htmlUrl, 'htmlUrl 必须逐字一致')
  }
})

/* ============================== 6. runFeedTick 的 persistError 分支 ============================== */

test('runFeedTick：配置回写失败 → 记录仍入库并回传 persistError；下一轮状态未前进会重抓但绝不重复落库', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  let network = 0
  const transport: FeedTransport = async (request) => {
    network += 1
    return okResponse(request.url, 'a-1')
  }

  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: {} } }, // 读配置
    { data: [] }, // 查重
    { data: [] }, // 写入
    { data: null, error: Object.assign(new Error('settings 写入被拒'), { code: '42501' }) }, // 回写失败
  ])
  const first = await runFeedTick({ now: T0, transport })

  assert.equal(first.inserted, 1, '抓取结果必须照常落库，不能因为状态没存下来就作废')
  assert.equal(first.updated, 1)
  assert.equal(first.failed, 0, '配置写失败不算抓取失败')
  assert.match(String(first.persistError), /settings 写入被拒/, 'persistError 必须被上层看见')

  // 第二轮：状态丢了（读回来仍是空的 feed_state）→ 必然重抓，但去重键拦住重复落库
  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: {} } },
    { data: [{ external_uid: 'a-1' }] }, // 上一轮已经写进去的那条
    { data: null },
  ])
  const second = await runFeedTick({ now: plus(T0, 4 * HOUR), transport })

  assert.equal(network, 2, '状态未前进 → 同一批会被再抓一次（网络成本无法避免）')
  assert.equal(second.inserted, 0, '但绝不产生重复行')
  assert.equal(second.duplicated, 1)
  assert.equal(countCalls('insert'), 0, '全部重复时不得发起 insert')
})

test('runFeedTick：落库抛非 23505 → 走同一失败机（failing + 退避 + 单次告警）', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  const transport: FeedTransport = async (request) => okResponse(request.url, 'a-1')
  let savedState: Record<string, FeedState> = { [a.id]: normalizeFeedState({ status: 'ok' }) }
  const noticeKinds: string[] = []

  for (let round = 1; round <= 3; round += 1) {
    __resetDbCalls()
    __resetDbWrites()
    __resetDbQueue()
    __queueDbResults([
      { data: { id: 1, feeds: [a], feed_state: savedState } },
      { data: [] }, // 查重成功
      { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) }, // 整批失败
      { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) }, // 逐条重试也失败
      { data: null }, // 回写成功
    ])
    const summary = await runFeedTick({ now: T0, transport })

    assert.equal(summary.failed, 1)
    assert.equal(summary.inserted, 0)
    assert.equal(summary.persistError, null, '配置本身写得进去，失败的是记录写入')
    // 与 fetchFeed 的 500 路径同口径：3 次才告警，且只告警一次
    assert.equal(summary.notices.length, round >= 3 ? 1 : 0, `第 ${round} 轮的通知条数必须与门槛一致`)
    noticeKinds.push(...summary.notices.map((notice) => notice.kind))
    savedState = lastUpdate().feed_state as Record<string, FeedState>
  }

  assert.deepEqual(noticeKinds, ['failing'], '异常路径也必须跨门槛告警，且只告警 1 次')

  const state = savedState[a.id]
  assert.equal(state.failCount, 3, '失败计数确实在累加')
  assert.ok(state.lastError, '错误原因留档')
  // 健康态只有一份：status 必须跟着 failCount 走（migration.sql 明确不允许「status 说 ok 而 failCount 是 3」）
  assert.equal(state.status, 'failing', '连续 3 次异常必须进入 failing')
  assert.ok(state.nextFetchAt, '跨过门槛必须退避，否则每轮 tick 都会重打这个已经挂掉的源')
  assert.equal(
    Date.parse(state.nextFetchAt as string) - Date.parse(T0),
    HOUR,
    '退避时长必须与 fetchFeed 失败路径同档（1h）',
  )
})

test('runFeedTick：异常连续 3 次后第 4 次仍异常 → notices 不再新增（告警去重）', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  const transport: FeedTransport = async (request) => okResponse(request.url, 'a-1')
  let savedState: Record<string, FeedState> = { [a.id]: normalizeFeedState({ status: 'ok' }) }

  // 前 3 轮：跨过门槛，告警 1 条（本轮断言略写，细则见上一条用例）
  for (let round = 1; round <= 3; round += 1) {
    __resetDbCalls()
    __resetDbWrites()
    __resetDbQueue()
    __queueDbResults([
      { data: { id: 1, feeds: [a], feed_state: savedState } },
      { data: [] },
      { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
      { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
      { data: null },
    ])
    const summary = await runFeedTick({ now: T0, transport })
    if (round === 3) assert.equal(summary.notices.length, 1, '第 3 轮必须告警一次')
    savedState = lastUpdate().feed_state as Record<string, FeedState>
  }
  assert.equal(savedState[a.id].status, 'failing')
  assert.ok(savedState[a.id].nextFetchAt, '已进入退避')

  // 第 4 轮：必须等退避窗口过去才会再发请求（now 越过 nextFetchAt），异常照旧
  const fourthAt = plus(T0, 2 * HOUR)
  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: savedState } },
    { data: [] },
    { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
    { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
    { data: null },
  ])
  const fourth = await runFeedTick({ now: fourthAt, transport })

  assert.equal(fourth.failed, 1, '第 4 次仍是失败（不是 deferred：退避窗口已过）')
  assert.deepEqual(fourth.notices, [], 'failing 期间再失败不得重复告警')

  const state = (lastUpdate().feed_state as Record<string, FeedState>)[a.id]
  assert.equal(state.failCount, 4, '计数继续累加')
  assert.equal(state.status, 'failing', '仍是 failing')
  assert.ok(state.lastError, 'lastError 不得被清空')
  assert.equal(
    Date.parse(state.nextFetchAt as string) - Date.parse(fourthAt),
    HOUR,
    '退避窗口按本轮时刻重新计算',
  )
})

test('对拍：「落库异常」与「上游 500」对同一状态输入产出逐字段相等的健康态（仅 lastError 文案不同）', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  // 三种有代表性的输入：首次失败 / 恰在门槛上 / 恢复期掉回
  const cases: Array<{ name: string; state: FeedState }> = [
    { name: '首次失败', state: normalizeFeedState({}) },
    { name: '第 3 次失败（跨门槛）', state: normalizeFeedState({ failCount: 2, status: 'ok', lastError: '旧的错误' }) },
    {
      name: '恢复期掉回',
      state: normalizeFeedState({ failCount: 3, consecutiveOk: 1, status: 'recovering' }),
    },
  ]

  for (const item of cases) {
    // 路径 1：上游 500（`fetchFeed` 内部的 failureResult）
    const upstream = await fetchFeed(a, {
      state: item.state,
      now: T0,
      transport: async (request) => ({
        status: 500,
        url: request.url,
        etag: null,
        lastModified: null,
        contentType: null,
        body: 'boom',
      }),
    })
    assert.equal(upstream.outcome, 'failed', `${item.name}：500 必须判失败`)

    // 路径 2：200 抓到了，但整批 insert 被 RLS 拒（`runFeedTick` 的 catch 分支）
    __resetDbCalls()
    __resetDbWrites()
    __resetDbQueue()
    __queueDbResults([
      { data: { id: 1, feeds: [a], feed_state: { [a.id]: item.state } } },
      { data: [] }, // 查重成功
      { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) }, // 整批 insert 失败
      { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) }, // 逐条重试也失败
      { data: null }, // 回写成功
    ])
    const summary = await runFeedTick({
      now: T0,
      transport: async (request) => okResponse(request.url, 'a-1'),
    })
    assert.equal(summary.failed, 1, `${item.name}：异常路径必须计入 failed`)

    const thrown = (lastUpdate().feed_state as Record<string, FeedState>)[a.id]
    assert.ok(thrown, `${item.name}：异常路径必须把状态回写进 feed_state`)

    const fields = (Object.keys(upstream.state) as Array<keyof FeedState>).sort()
    assert.deepEqual(fields, (Object.keys(thrown) as Array<keyof FeedState>).sort(), `${item.name}：字段集合`)
    for (const field of fields) {
      if (field === 'lastError') continue
      assert.deepEqual(thrown[field], upstream.state[field], `${item.name}：${String(field)} 必须与 500 路径一致`)
    }
    // 唯一允许不同的字段：lastError 的文案（一条说 HTTP 500，一条说落库原因）
    assert.ok(thrown.lastError, `${item.name}：lastError 不得为空`)
    assert.match(String(thrown.lastError), /写入被拒/)
    assert.notEqual(thrown.lastError, upstream.state.lastError, `${item.name}：只有 lastError 文案允许不同`)
    // 告警口径也必须一致：同一门槛、同一种 kind
    assert.deepEqual(
      summary.notices.map((notice) => notice.kind),
      upstream.notice ? [upstream.notice.kind] : [],
      `${item.name}：两条路径的告警条数与 kind 必须一致`,
    )
  }
})

test('runFeedTick：200 抓到新内容但落库失败 → lastHash 回滚到抓取前，下一轮必须重抓并补入库', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  const beforeHash = 'hash-before-failure'
  const old = normalizeFeedState({ status: 'ok', lastHash: beforeHash, etag: 'W/"old"' })
  const transport: FeedTransport = async (request) => okResponse(request.url, 'n-1')

  // 第 1 轮：200 有新内容 → 落库被拒
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: { [a.id]: old } } },
    { data: [] },
    { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
    { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
    { data: null },
  ])
  const first = await runFeedTick({ now: T0, transport })
  assert.equal(first.inserted, 0, '落库失败时不得虚报 inserted')
  assert.equal(first.failed, 1)

  const saved = (lastUpdate().feed_state as Record<string, FeedState>)[a.id]
  assert.equal(
    saved.lastHash,
    beforeHash,
    '落库失败时 lastHash 必须停在抓取前的值（否则下一轮判「内容没变」，这批条目永远进不了库）',
  )
  assert.equal(saved.etag, 'W/"old"', 'etag 一并回滚：新内容没进库，条件请求也回到旧值')
  assert.equal(saved.failCount, 1)
  assert.equal(saved.status, 'ok', '未到门槛不改健康态')
  assert.equal(saved.nextFetchAt, null, '未到门槛不退避')

  // 第 2 轮：同样的响应 → 必须重新给出条目并落库（若 lastHash 被写成新值，这里会是 unchanged）
  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: { [a.id]: saved } } },
    { data: [] },
    { data: [] },
    { data: null },
  ])
  const second = await runFeedTick({ now: plus(T0, 31 * MINUTE), transport })

  assert.equal(second.updated, 1, '必须重抓成 updated，而不是 unchanged')
  assert.equal(second.inserted, 1, '上一轮没进库的条目这一轮必须补进去')
  assert.equal(countCalls('insert'), 1)
})

test('runFeedTick：异常路径进了 failing 之后的恢复口径 —— 连续 2 次成功才 ok、只 1 条 recovered，恢复期再异常不重复告警', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  const transport: FeedTransport = async (request) => okResponse(request.url, 'r-1')
  // 异常路径（3 次落库失败）留下的状态：failing + 1h 退避 + lastHash 为 null（回滚过）
  const failing = normalizeFeedState({
    status: 'failing',
    failCount: 3,
    lastError: '写入被拒',
    nextFetchAt: plus(T0, HOUR),
  })

  // 第 1 次成功（退避窗口已过）：failing → recovering，不发通知
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: { [a.id]: failing } } },
    { data: [] },
    { data: [] },
    { data: null },
  ])
  const first = await runFeedTick({ now: plus(T0, 2 * HOUR), transport })
  assert.equal(first.inserted, 1, '退避结束后必须真抓真落库')
  assert.deepEqual(first.notices, [], '第 1 次成功只到 recovering，不得发恢复通知')

  const recovering = (lastUpdate().feed_state as Record<string, FeedState>)[a.id]
  assert.equal(recovering.status, 'recovering')
  assert.equal(recovering.consecutiveOk, 1)
  assert.equal(recovering.failCount, 0, '成功即归零失败计数')
  assert.equal(recovering.nextFetchAt, null, '离开 failing 必须解除退避')
  assert.equal(recovering.lastError, null, '成功必须清空 lastError')

  // 第 2 次成功：recovering → ok，发 1 条 recovered（body 未变 → unchanged，但健康态照常推进）
  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: { [a.id]: recovering } } },
    { data: null },
  ])
  const second = await runFeedTick({ now: plus(T0, 3 * HOUR), transport })
  assert.equal(second.unchanged, 1, '内容指纹没变：不重复写库')
  assert.deepEqual(second.notices.map((notice) => notice.kind), ['recovered'], '第 2 次成功才发恢复通知')

  const okState = (lastUpdate().feed_state as Record<string, FeedState>)[a.id]
  assert.equal(okState.status, 'ok')
  assert.equal(okState.consecutiveOk, 0)

  // 第 3 次成功：不得再发第二条 recovered
  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: { [a.id]: okState } } },
    { data: null },
  ])
  const third = await runFeedTick({ now: plus(T0, 4 * HOUR), transport })
  assert.deepEqual(third.notices, [], '恢复通知只发 1 条')

  // 恢复期（consecutiveOk=1）再遇落库异常 → 立刻回 failing，但不重复告警。
  // 注意 fixture 的 failCount 必须是 0：任何一次成功都会把 failCount 归零，
  // 所以「recovering ⇒ failCount===0」是这台状态机的不变式（见 §3 同口径用例）。
  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    {
      data: {
        id: 1,
        feeds: [a],
        feed_state: { [a.id]: normalizeFeedState({ status: 'recovering', failCount: 0, consecutiveOk: 1 }) },
      },
    },
    { data: [] },
    { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
    { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
    { data: null },
  ])
  const relapsed = await runFeedTick({ now: plus(T0, 5 * HOUR), transport })
  assert.equal(relapsed.failed, 1)
  assert.deepEqual(relapsed.notices, [], '曾经告过警，恢复期再失败不得重复告警')

  const relapsedState = (lastUpdate().feed_state as Record<string, FeedState>)[a.id]
  assert.equal(relapsedState.status, 'failing')
  assert.equal(relapsedState.failCount, 1, '成功已把 failCount 归零，回退这次是第 1 次失败')
  assert.equal(
    relapsedState.nextFetchAt,
    null,
    '退避只看门槛：回退后的第 1 次失败不退避（与上游 500 路径同口径）',
  )

  // 回退后继续异常 2 轮 → 重新爬到门槛 3：进退避，但**整个 failing 周期只告过 1 次警**
  let carry = relapsedState
  for (let round = 1; round <= 2; round += 1) {
    const now = plus(T0, (5 + round) * HOUR)
    __resetDbCalls()
    __resetDbWrites()
    __resetDbQueue()
    __queueDbResults([
      { data: { id: 1, feeds: [a], feed_state: { [a.id]: carry } } },
      { data: [] },
      { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
      { data: null, error: Object.assign(new Error('写入被拒'), { code: '42501' }) },
      { data: null },
    ])
    const again = await runFeedTick({ now, transport })
    assert.deepEqual(again.notices, [], `回退后第 ${round} 轮异常不得再告警`)
    carry = (lastUpdate().feed_state as Record<string, FeedState>)[a.id]
    if (round === 1) assert.equal(carry.nextFetchAt, null, '第 2 次失败仍未到门槛')
  }
  assert.equal(carry.failCount, 3)
  assert.equal(carry.status, 'failing')
  assert.equal(
    Date.parse(carry.nextFetchAt as string) - Date.parse(plus(T0, 7 * HOUR)),
    HOUR,
    '重新爬到门槛后必须回到 1h 退避',
  )
})

/* ============================== 7. runFeedTickIfDue 三闸 ============================== */

test('runFeedTickIfDue：quiet / 断网 / 节流 都返回 null 且零网络请求；免打扰不占用节流额度', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  let network = 0
  const transport: FeedTransport = async (request) => {
    network += 1
    return okResponse(request.url, 'a-1')
  }

  const navigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const stubNavigator = (value: unknown): void => {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true, writable: true })
  }

  try {
    stubNavigator({ onLine: true })

    // 1) 免打扰：直接 null，零网络，且**不**推进节流时间
    assert.equal(await runFeedTickIfDue({ now: T0, quiet: true, transport }), null)
    assert.equal(network, 0, '免打扰窗口内不发任何请求')

    // 2) 断网：直接 null，零网络
    stubNavigator({ onLine: false })
    assert.equal(await runFeedTickIfDue({ now: T0, transport }), null)
    assert.equal(network, 0, '断网时不得尝试抓取')

    stubNavigator({ onLine: true })

    // 3) 到点：真跑一轮（证明前两闸没有被误判成「已跑过」）
    __queueDbResults([
      { data: { id: 1, feeds: [a], feed_state: {} } },
      { data: [] },
      { data: [] },
      { data: null },
    ])
    const ran = await runFeedTickIfDue({ now: T0, transport })
    assert.ok(ran, '免打扰 / 断网不应吞掉节流额度')
    assert.equal(ran?.inserted, 1)
    assert.equal(network, 1)

    // 4) 节流窗口内（+1 分钟）：null 且零网络
    assert.equal(await runFeedTickIfDue({ now: plus(T0, MINUTE), transport }), null)
    assert.equal(network, 1, '节流命中时一个请求都不该发')

    // 5) 越过默认 30 分钟：再跑一轮
    __queueDbResults([
      { data: { id: 1, feeds: [a], feed_state: {} } },
      { data: [] },
      { data: [] },
      { data: null },
    ])
    const again = await runFeedTickIfDue({ now: plus(T0, 31 * MINUTE), transport })
    assert.ok(again, '超过最小间隔必须放行')
    assert.equal(network, 2)
  } finally {
    if (navigatorDesc) Object.defineProperty(globalThis, 'navigator', navigatorDesc)
    else delete (globalThis as { navigator?: unknown }).navigator
  }
})

/* ============================== 8. 缺列硬失败（settings 写侧） ============================== */

test('缺列：settings 写入拿到 42703 / PGRST204 → FeedSchemaMissingError，文案含迁移路径', async () => {
  for (const code of ['42703', 'PGRST204']) {
    __resetDbCalls()
    __resetDbWrites()
    __resetDbQueue()
    __queueDbResults([
      { data: null, error: Object.assign(new Error('column "feeds" does not exist'), { code }) },
    ])

    await assert.rejects(
      () => saveFeedConfig({ feeds: [source()], state: {} }, 1),
      (error: unknown) => {
        assert.equal(isFeedSchemaMissingError(error), true, `${code} 必须映射为缺列错误`)
        assert.ok(error instanceof FeedSchemaMissingError)
        assert.match((error as Error).message, new RegExp(MIGRATION_PATH.replace(/[.]/g, '\\.')))
        assert.notEqual((error as Error).message, '操作失败，请稍后重试', '迁移提示不得退化成兜底文案')
        return true
      },
    )
    assert.equal(
      __dbCalls.filter((call) => call.startsWith('from(records)')).length,
      0,
      '配置写失败时不得顺带写记录表',
    )
  }
})

test('addFeeds：迁移未执行时导入直接失败（不静默丢弃用户订阅）', async () => {
  __queueDbResults([
    { data: { id: 1, feeds: [], feed_state: {} } },
    { data: null, error: Object.assign(new Error('column "feeds" does not exist'), { code: '42703' }) },
  ])

  await assert.rejects(
    () => addFeeds([source({ url: 'https://new.example.com/rss' })]),
    (error: unknown) => isFeedSchemaMissingError(error),
    '导入必须报错并给出修复路径，而不是当作「已导入」返回',
  )
})

/* ============================== 9. 单源失败 / 重复 guid / 同源重复导入 ============================== */

test('runFeedTick：三源中间一源 500 → 另两源照常 updated，失败源 lastError 非空且不进退避', async () => {
  const first = source({ url: 'https://one.example.com/rss', title: '一号源' })
  const middle = source({ url: 'https://two.example.com/rss', title: '二号源' })
  const last = source({ url: 'https://three.example.com/rss', title: '三号源' })

  __queueDbResults([
    {
      data: {
        id: 1,
        feeds: [first, middle, last],
        // 三个源都是「曾经正常」的既有源，这样「未到门槛不改健康态」才有断言价值
        feed_state: {
          [first.id]: normalizeFeedState({ status: 'ok' }),
          [middle.id]: normalizeFeedState({ status: 'ok' }),
          [last.id]: normalizeFeedState({ status: 'ok' }),
        },
      },
    },
    { data: [] },
    { data: [] },
    { data: [] },
    { data: [] },
    { data: null },
  ])

  const transport: FeedTransport = async (request) => {
    if (request.url === middle.url) {
      return { status: 500, url: request.url, etag: null, lastModified: null, contentType: null, body: 'boom' }
    }
    return okResponse(request.url, request.url.includes('one') ? 'one-1' : 'three-1')
  }

  const summary = await runFeedTick({ now: T0, transport })

  assert.equal(summary.checked, 3)
  assert.equal(summary.updated, 2, '单源 500 不得中断整批')
  assert.equal(summary.failed, 1)
  assert.equal(summary.inserted, 2)
  assert.deepEqual(summary.notices, [], 'failCount=1 未到告警门槛')

  const saved = lastUpdate().feed_state as Record<string, FeedState>
  assert.ok(saved[middle.id].lastError, '失败源必须留下可读原因')
  assert.match(String(saved[middle.id].lastError), /HTTP 500/)
  assert.equal(saved[middle.id].failCount, 1)
  assert.equal(saved[middle.id].nextFetchAt, null, '未到 3 次不进退避')
  assert.equal(saved[middle.id].status, 'ok', '未到门槛不改健康态')
  assert.equal(saved[first.id].status, 'ok')
  assert.equal(saved[last.id].status, 'ok')
  assert.equal(countCalls('insert'), 2, '两个成功源各写一批')
})

test('runFeedTick：第二次抓到「旧 guid + 新条目」→ 只有新条目落库（inserted 1 / duplicated 1）', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })

  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: {} } },
    { data: [] },
    { data: [] },
    { data: null },
  ])
  await runFeedTick({
    now: T0,
    transport: async (request) => ({ ...okResponse(request.url, 'g-1'), status: 200 }),
  })
  const saved = lastUpdate().feed_state as Record<string, FeedState>

  // 第二轮 body 变了（多了一条 g-2）→ 指纹变 → 走落库路径，g-1 必须被 external_uid 拦住
  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: saved } },
    { data: [{ external_uid: 'g-1' }] },
    { data: [] },
    { data: null },
  ])

  const second = await runFeedTick({
    now: plus(T0, HOUR),
    transport: async (request) => ({
      status: 200,
      url: request.url,
      etag: 'W/"g-2"',
      lastModified: null,
      contentType: 'application/rss+xml',
      body: rss([
        { title: '条目 g-1', link: 'https://example.com/p/g-1', guid: 'g-1' },
        { title: '条目 g-2', link: 'https://example.com/p/g-2', guid: 'g-2' },
      ]),
    }),
  })

  assert.equal(second.updated, 1)
  assert.equal(second.inserted, 1, '重复 guid 不产生新行')
  assert.equal(second.duplicated, 1)

  const rows = __dbInserts[0] as Array<Record<string, unknown>>
  assert.equal(rows.length, 1)
  assert.equal(rows[0].external_uid, 'g-2')
})

test('addFeeds：同一 URL 在入参里出现两次且库里没有 → 只新增 1 条，duplicated 1', async () => {
  __queueDbResults([{ data: { id: 1, feeds: [], feed_state: {} } }, { data: null }])

  const result = await addFeeds([
    source({ url: 'https://x.example.com/rss', title: '第一次' }),
    source({ url: 'https://x.example.com/rss?utm_source=opml', title: '第二次' }),
  ])

  assert.equal(result.added.length, 1, '同一地址只加一条（跟踪参数差异不算不同源）')
  assert.equal(result.duplicated, 1)
  assert.equal(result.added[0].title, '第一次', '先到先得')
  assert.equal(result.config.feeds.length, 1)

  const savedFeeds = lastUpdate().feeds as FeedSource[]
  assert.equal(savedFeeds.length, 1)
})

test('runFeedTick：第 3 次失败在 tick 层产生 1 条 failing 通知，且 notify 回调抛错不影响整轮', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  const transport: FeedTransport = async (request) => ({
    status: 500,
    url: request.url,
    etag: null,
    lastModified: null,
    contentType: null,
    body: 'boom',
  })

  // failCount 已经是 2 → 本轮第 3 次失败必须跨过门槛
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: { [a.id]: normalizeFeedState({ failCount: 2, status: 'new' }) } } },
    { data: null },
  ])

  const seen: string[] = []
  const summary = await runFeedTick({
    now: T0,
    transport,
    notify: () => {
      seen.push('notify')
      throw new Error('上层通知回调炸了')
    },
  })

  assert.equal(summary.failed, 1)
  assert.equal(summary.notices.length, 1, '跨过门槛必须产生 1 条通知')
  assert.equal(summary.notices[0].kind, 'failing')
  assert.match(summary.notices[0].message, /连续 3 次/)
  assert.deepEqual(seen, ['notify'], '额外回调应当被调用一次')
  assert.equal(summary.persistError, null, '回调抛错绝不能影响整轮的结果回写')
  assert.equal((lastUpdate().feed_state as Record<string, FeedState>)[a.id].status, 'failing')
})

test('upsertEntries：落库行的 url 与 link_meta.site 都不含跟踪参数（端到端经 insert 载荷核对）', async () => {
  __queueDbResults([{ data: [] }, { data: [] }])

  const result = await upsertEntries(
    [
      entry({
        dedupeKey: 'g-9',
        url: 'https://site.example.com/post/1?utm_source=rss&utm_medium=feed&fbclid=zzz&id=9',
      }),
    ],
    { now: T0 },
  )

  assert.deepEqual(result, { inserted: 1, duplicated: 0, skipped: 0 })
  const rows = __dbInserts[0] as Array<Record<string, unknown>>
  assert.equal(rows[0].url, 'https://site.example.com/post/1?id=9')
  assert.equal((rows[0].link_meta as Record<string, unknown>).site, 'site.example.com')
  assert.equal(rows[0].external_uid, 'g-9')
  assert.equal((rows[0].record_meta as Record<string, unknown>).importedAt, T0)
})
