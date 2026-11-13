/**
 * P0-3 下半 · 订阅入库服务层单测（`feedService.upsertEntries` / `runFeedTick` / `addFeeds`）。
 *
 * `cloud` 由 `qa/mocks/cloud.ts` 替换（写法照 `qa/ics-import.test.ts`：FIFO 队列 + 调用序列断言）。
 * 时钟一律注入 `now`，因此与运行机器时区/时刻无关。
 *
 * 钉死的六组行为：
 * 1. **upsertEntries 查重**：全新插入 N 条一次批量写；全部已存在 → 0 写入且不发 insert；
 * 2. **空数组不查库**（0 次数据库调用）：一轮 tick 里大多数源都是 unchanged，这条决定省不省流量；
 * 3. **并发冲突降级**（23505）：整批失败 → 逐条重试，冲突计 duplicated，其余照常插入；
 * 4. **迁移未执行**（42703 / PGRST204）→ 抛 `FeedSchemaMissingError`，文案指向 migration.sql，
 *    且一条 insert 都不许发生（缺列时无法查重，盲目插入会灌重复数据）；
 * 5. **单源失败不中断整批**：三个源中间一个 500 → 另两个照常 updated，失败源 `lastError` 非空；
 * 6. **幂等**：同一源连抓两次（第二次 304 / 同 body）→ 第二次 inserted === 0，不再写记录。
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
  feedIdOf,
  isFeedSchemaMissingError,
  loadFeedConfig,
  runFeedTick,
  upsertEntries,
  type FeedEntry,
  type FeedHttpResponse,
  type FeedSource,
  type FeedState,
  type FeedTransport,
} from '../web/src/services/feedService'

/** 注入的「当前时刻」。 */
const NOW = '2026-11-06T02:00:00.000Z'
/** 第二轮的当前时刻（比 NOW 晚 4 小时，仍为同一秒级精度）。 */
const LATER = '2026-11-06T06:00:00.000Z'
/** 迁移文件的修复路径片段（文案必须原样到达用户）。 */
const MIGRATION_PATH = 'docs/v2.14/migration.sql'

beforeEach(() => {
  __resetDbCalls()
  __resetDbQueue()
  __resetDbWrites()
  // 兜底：未显式入队的结果一律当「无数据、无错误」，避免某个 await 吃掉不该吃的队列项
  __setDbResult({ data: null })
})

/* ------------------------------ 数据构造 ------------------------------ */

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
function entry(key: string, over: Partial<FeedEntry> = {}): FeedEntry {
  return {
    dedupeKey: key,
    title: `${key} 的标题`,
    url: `https://example.com/p/${key}`,
    guid: key,
    publishedAt: null,
    summary: null,
    content: null,
    author: null,
    feedId: 'feed-a',
    feedTitle: 'A 频道',
    ...over,
  }
}

/** 造一份 src 完整状态（只填用得到的字段）。 */
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

/** 造一份 RSS 2.0（每条 item 只有 title/link/guid，够 `parseFeed` 产出条目）。 */
function rss(items: Array<{ title: string; link: string; guid: string }>): string {
  const body = items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link><guid isPermaLink="false">${item.guid}</guid></item>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>频道</title>${body}</channel></rss>`
}

/** 一份 200 响应（每个源一条独占 guid 的条目）。 */
function okResponse(url: string, guid: string, title = '新条目'): FeedHttpResponse {
  return {
    status: 200,
    url,
    etag: `W/"${guid}"`,
    lastModified: null,
    contentType: 'application/rss+xml',
    body: rss([{ title, link: `${url}#${guid}`, guid }]),
  }
}

/** 计数某类调用（`insert` 被调几次 = 写了几批）。 */
function countCalls(token: string): number {
  return __dbCalls.filter((call) => call === token).length
}

/** 最后一条 update 载荷（`saveFeedConfig` 走 `profileService.save` → update）。 */
function lastUpdate(): Record<string, unknown> {
  const patch = __dbUpdates[__dbUpdates.length - 1]
  assert.ok(patch, '应当有一次配置回写')
  return patch
}

/* ============================== 1. upsertEntries 查重 ============================== */

test('upsertEntries：全新技术插入 N 条，一次批量 insert，字段按 snake_case 落库', async () => {
  __queueDbResults([{ data: [] }, { data: [] }])

  const result = await upsertEntries([entry('p1'), entry('p2')], { now: NOW })

  assert.deepEqual(result, { inserted: 2, duplicated: 0, skipped: 0 })
  assert.equal(countCalls('insert'), 1, '两条应一次批量写入')
  assert.ok(
    __dbCalls.includes('in(external_uid,["p1","p2"])'),
    '查重必须按 external_uid 批量 in(...)，而不是拉整表',
  )

  const rows = __dbInserts[0] as Array<Record<string, unknown>>
  assert.equal(rows.length, 2)
  assert.equal(rows[0].type, 'material', '订阅条目落成资料')
  assert.equal(rows[0].external_uid, 'p1', 'external_uid 是查重的唯一依据，必须显式写')
  assert.equal((rows[0].link_meta as Record<string, unknown>).status, 'ok')
  assert.equal((rows[0].record_meta as Record<string, unknown>).source, 'feed')
  assert.equal((rows[0].record_meta as Record<string, unknown>).importedAt, NOW, '入库时刻必须用注入值')
})

test('upsertEntries：全部已存在 → inserted 0，且不发起任何 insert', async () => {
  __queueDbResults([{ data: [{ external_uid: 'p1' }, { external_uid: 'p2' }] }])

  const result = await upsertEntries([entry('p1'), entry('p2')], { now: NOW })

  assert.deepEqual(result, { inserted: 0, duplicated: 2, skipped: 0 })
  assert.equal(countCalls('insert'), 0, '查重命中时不得发起 insert')
  assert.equal(__dbInserts.length, 0)
})

test('upsertEntries：空数组不发任何请求（一轮 tick 里大多数源走这条路）', async () => {
  const result = await upsertEntries([], { now: NOW })

  assert.deepEqual(result, { inserted: 0, duplicated: 0, skipped: 0 })
  assert.equal(__dbCalls.length, 0, '空数组必须零数据库调用')
})

/* ============================== 2. 冲突降级 / 缺列 ============================== */

test('upsertEntries：整批 23505 → 降级逐条插入，冲突计 duplicated，其余照常写入', async () => {
  __queueDbResults([
    { data: [] },
    // 1) 整批冲突（另一个标签页刚好同时写入）
    { data: null, error: { code: '23505' } },
    // 2) 逐条重试：p1 冲突、p2 成功
    { data: null, error: { code: '23505' } },
    { data: null },
  ])

  const result = await upsertEntries([entry('p1'), entry('p2')], { now: NOW })

  assert.deepEqual(result, { inserted: 1, duplicated: 1, skipped: 0 })
  assert.equal(countCalls('insert'), 3, '1 次整批 + 2 次逐条重试')
})

test('upsertEntries：查重命中 42703 → 抛 FeedSchemaMissingError（文案指向 migration.sql），一条 insert 都不许发生', async () => {
  __queueDbResults([{ data: null, error: { code: '42703' } }])

  await assert.rejects(
    () => upsertEntries([entry('p1')], { now: NOW }),
    (error: unknown) => {
      assert.equal(isFeedSchemaMissingError(error), true, '必须是本服务的缺列错误，UI 才能原样展示文案')
      assert.ok(error instanceof FeedSchemaMissingError, '错误类型必须是 FeedSchemaMissingError')
      assert.match(String((error as Error).message), new RegExp(MIGRATION_PATH.replace(/[.]/g, '\\.')))
      assert.notEqual((error as Error).message, '操作失败，请稍后重试', '迁移提示不得退化成兜底文案')
      return true
    },
  )

  assert.equal(countCalls('insert'), 0, '缺列时无法查重，一条 insert 都不许发生')
})

test('upsertEntries：PostgREST 的 PGRST204（schema cache 未识别列）同样视为缺列', async () => {
  __queueDbResults([{ data: null, error: { code: 'PGRST204' } }])

  await assert.rejects(
    () => upsertEntries([entry('p1')], { now: NOW }),
    (error: unknown) => isFeedSchemaMissingError(error),
  )
})

test('upsertEntries：写入命中 42703 也抛缺列错误（顺手覆盖 insert 侧）', async () => {
  __queueDbResults([{ data: [] }, { data: null, error: { code: '42703' } }])

  await assert.rejects(
    () => upsertEntries([entry('p1')], { now: NOW }),
    (error: unknown) => isFeedSchemaMissingError(error),
  )
})

/* ============================== 3. 配置读写 ============================== */

test('loadFeedConfig：无 settings 行 / feeds 非数组 → 空配置，不抛错', async () => {
  __queueDbResults([{ data: null }])
  assert.deepEqual(await loadFeedConfig(), { feeds: [], state: {} })

  __queueDbResults([{ data: { id: 1, feeds: 'not-an-array', feed_state: 42 } }])
  assert.deepEqual(await loadFeedConfig(), { feeds: [], state: {} })
})

test('loadFeedConfig：缺 id 的源按 URL 现算 id，状态一律 normalize', async () => {
  __queueDbResults([
    {
      data: {
        id: 1,
        feeds: [
          { title: 'A 源', url: 'https://a.example.com/rss.xml', enabled: false },
          { url: 'https://b.example.com/rss.xml' },
          { title: '没有地址' },
        ],
        feed_state: { [feedIdOf('https://a.example.com/rss.xml')]: { failCount: 2, status: 'failing' } },
      },
    },
  ])

  const config = await loadFeedConfig()

  assert.equal(config.feeds.length, 2, '没有 url 的脏数据被丢弃')
  assert.equal(config.feeds[0].id, feedIdOf('https://a.example.com/rss.xml'))
  assert.equal(config.feeds[0].enabled, false, 'enabled=false 必须保留（暂停的源）')
  assert.equal(config.feeds[1].title, 'https://b.example.com/rss.xml', '标题缺失回落地址')

  const aState = config.state[feedIdOf('https://a.example.com/rss.xml')]
  assert.equal(aState.failCount, 2)
  assert.equal(aState.status, 'failing')
  assert.equal(aState.etag, null, '残缺状态由 normalizeFeedState 补全')
})

/* ============================== 4. 一轮 tick ============================== */

test('runFeedTick：三个源中间一个 500 → 另两个照常 updated，失败源 lastError 非空且整轮只写一次配置', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  const b = source({ url: 'https://b.example.com/rss.xml', title: 'B 源' })
  const c = source({ url: 'https://c.example.com/rss.xml', title: 'C 源' })

  __queueDbResults([
    { data: { id: 1, feeds: [a, b, c], feed_state: {} } }, // 读配置
    { data: [] }, // A 查重
    { data: [] }, // A 写入
    { data: [] }, // C 查重
    { data: [] }, // C 写入
    { data: null }, // 回写配置
  ])

  const transport: FeedTransport = async (request) => {
    if (request.url === b.url) {
      return { status: 500, url: request.url, etag: null, lastModified: null, contentType: null, body: 'boom' }
    }
    return okResponse(request.url, request.url.includes('a.example.com') ? 'a-1' : 'c-1')
  }

  const summary = await runFeedTick({ now: NOW, transport })

  assert.equal(summary.checked, 3, '三个源都应被尝试')
  assert.equal(summary.updated, 2, '单个源 500 不得中断整批')
  assert.equal(summary.failed, 1)
  assert.equal(summary.inserted, 2)
  assert.equal(summary.duplicated, 0)
  assert.equal(summary.persistError, null)
  assert.deepEqual(summary.notices, [], 'failCount=1 未到告警门槛')

  const patch = lastUpdate()
  const savedState = patch.feed_state as Record<string, FeedState>
  assert.ok(savedState[b.id].lastError, '失败源必须留下可读原因（下一轮据此退避）')
  assert.equal(savedState[b.id].failCount, 1)
  assert.equal(savedState[a.id].status, 'ok')
  assert.equal((patch.feeds as FeedSource[]).length, 3)
  assert.equal(countCalls('insert'), 2)
  assert.equal(
    __dbCalls.filter((call) => call.startsWith('update(')).length,
    1,
    '循环结束后只写一次配置（减少写放大）',
  )
})

test('runFeedTick：同一源连抓两次（第二次 304）→ 第二次 inserted 0 且不写记录', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })

  // 第一轮：首次抓取 → 有新条目
  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: {} } },
    { data: [] },
    { data: [] },
    { data: null },
  ])
  const first = await runFeedTick({ now: NOW, transport: async (request) => okResponse(request.url, 'a-1') })

  assert.equal(first.inserted, 1)
  const savedState = lastUpdate().feed_state as Record<string, FeedState>

  // 第二轮：上游 304（用上一轮保存的 etag/状态）
  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([{ data: { id: 1, feeds: [a], feed_state: savedState } }, { data: null }])

  const second = await runFeedTick({
    now: LATER,
    transport: async (request) => ({
      status: 304,
      url: request.url,
      etag: 'W/"a-1"',
      lastModified: null,
      contentType: null,
      body: '',
    }),
  })

  assert.equal(second.notModified, 1)
  assert.equal(second.updated, 0)
  assert.equal(second.inserted, 0, '304 表示上游没变，不得再写记录')
  assert.equal(countCalls('insert'), 0, '304 这一轮不应发起任何 insert')
  assert.equal(__dbInserts.length, 0)
})

test('runFeedTick：同一源同 body（200 + 指纹未变）→ unchanged，inserted 0（guid 重复不产生新行）', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })

  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: {} } },
    { data: [] },
    { data: [] },
    { data: null },
  ])
  await runFeedTick({ now: NOW, transport: async (request) => okResponse(request.url, 'a-1') })

  const saved = lastUpdate().feed_state as Record<string, FeedState>
  // 清掉 etag 让上游回 200（模拟不支持条件请求的源），内容指纹仍应拦住重复写入
  const noEtag: Record<string, FeedState> = { [a.id]: { ...saved[a.id], etag: null } }

  __resetDbCalls()
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([{ data: { id: 1, feeds: [a], feed_state: noEtag } }, { data: null }])

  const second = await runFeedTick({ now: LATER, transport: async (request) => okResponse(request.url, 'a-1') })

  assert.equal(second.unchanged, 1)
  assert.equal(second.inserted, 0, '内容指纹没变就不该再写一遍')
  assert.equal(countCalls('insert'), 0)
})

test('runFeedTick：退避中的源不发请求、状态原样保留', async () => {
  const paused = source({ url: 'https://paused.example.com/rss', title: '退避中', enabled: true })
  const ready = source({ url: 'https://ready.example.com/rss', title: '该抓' })

  const backingOff = state({ nextFetchAt: '2026-11-06T12:00:00.000Z', consecutiveNotModified: 7 })

  __queueDbResults([
    { data: { id: 1, feeds: [paused, ready], feed_state: { [paused.id]: backingOff } } },
    { data: [] },
    { data: [] },
    { data: null },
  ])

  const requested: string[] = []
  const transport: FeedTransport = async (request) => {
    requested.push(request.url)
    return okResponse(request.url, 'r-1')
  }

  const summary = await runFeedTick({ now: NOW, transport })

  assert.deepEqual(requested, [ready.url], '退避中的源一个请求都不该发')
  assert.equal(summary.checked, 1)
  assert.equal(summary.deferred, 0, '被 selectDueFeeds 过滤掉的源不计入 deferred（它压根没进本轮）')

  const savedState = lastUpdate().feed_state as Record<string, FeedState>
  assert.equal(savedState[paused.id].nextFetchAt, backingOff.nextFetchAt, '未参与的源状态必须原样保留')
  assert.equal(savedState[paused.id].consecutiveNotModified, 7)
})

test('runFeedTick：配置写回失败不抛错，改为回传 persistError（本轮已写入的记录不算白跑）', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })

  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: {} } },
    { data: [] },
    { data: [] },
    { data: null, error: { code: '42501' } }, // 回写配置被拒
  ])

  const summary = await runFeedTick({ now: NOW, transport: async (request) => okResponse(request.url, 'a-1') })

  assert.equal(summary.inserted, 1, '记录已入库，不能因为状态没存下来就否定它')
  assert.ok(summary.persistError, '写库失败必须被上层看见')
  assert.equal(summary.failed, 0, '配置写失败不算抓取失败')
})

test('runFeedTick：落库失败时回滚状态（不得把新指纹留在库里，否则下轮判「没变」而静默丢数据）', async () => {
  const a = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })

  __queueDbResults([
    { data: { id: 1, feeds: [a], feed_state: {} } },
    { data: [] }, // 查重
    { data: null, error: { code: '42501' } }, // 整批 insert 被拒
    { data: null, error: { code: '42501' } }, // 逐条重试也被拒
    { data: null }, // 回写配置
  ])

  const summary = await runFeedTick({ now: NOW, transport: async (request) => okResponse(request.url, 'a-1') })

  assert.equal(summary.failed, 1, '写库失败计为该源失败')
  assert.equal(summary.inserted, 0)

  const saved = lastUpdate().feed_state as Record<string, FeedState>
  assert.equal(saved[a.id].lastHash, null, '抓取成功但没写进去 → 指纹必须回滚为 null，下一轮才会重抓')
  assert.ok(saved[a.id].lastError, '失败原因必须留档')
  assert.equal(saved[a.id].failCount, 1)
})

/* ============================== 5. addFeeds ============================== */

test('addFeeds：重复 URL 不新增（保留原标题），duplicated 计数正确', async () => {
  const existing = source({ url: 'https://a.example.com/rss.xml', title: '我改过的标题' })
  __queueDbResults([{ data: { id: 1, feeds: [existing], feed_state: {} } }, { data: null }])

  const result = await addFeeds([
    source({ id: 'whatever', url: 'https://a.example.com/rss.xml?utm_source=opml', title: 'OPML 里的标题' }),
    source({ id: 'b', url: 'https://b.example.com/rss.xml', title: 'B 源' }),
  ])

  assert.equal(result.duplicated, 1)
  assert.equal(result.added.length, 1, '只有 B 是新增')
  assert.equal(result.added[0].id, feedIdOf('https://b.example.com/rss.xml'), '新加项 id 由 URL 派生')
  assert.equal(result.config.feeds.length, 2)
  assert.equal(result.config.feeds[0].title, '我改过的标题', '已存在源的标题不得被覆盖')

  const savedFeeds = lastUpdate().feeds as FeedSource[]
  assert.equal(savedFeeds.length, 2)
  assert.equal(savedFeeds[0].title, '我改过的标题')
})

test('addFeeds：全部重复时连写请求都不发（无谓刷 updated_at）', async () => {
  const existing = source({ url: 'https://a.example.com/rss.xml', title: 'A 源' })
  __queueDbResults([{ data: { id: 1, feeds: [existing], feed_state: {} } }])

  const result = await addFeeds([source({ url: 'https://a.example.com/rss.xml' })])

  assert.equal(result.added.length, 0)
  assert.equal(result.duplicated, 1)
  assert.equal(
    __dbCalls.filter((call) => call.startsWith('update(')).length,
    0,
    '没有新增就不该产生 update',
  )
})
