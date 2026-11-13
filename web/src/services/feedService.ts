/**
 * 订阅源服务（P0-3：`importOpml` / `fetchFeed` / 配置读写 / 条目落库 / 一轮 tick）。
 *
 * 分工（与 `icsImportService` 同风格：能纯则纯，只有一处碰网络）：
 * - `lib/opml.ts`：OPML 文本 ↔ 订阅列表（纯函数，容错、可往返）；
 * - `lib/feed-parse.ts`：RSS/Atom 文本 → 条目（纯函数，容错）；
 * - `lib/feed-dedupe.ts`：去重键 + 内容指纹（纯函数）；
 * - `lib/feed-store.ts`：合并订阅 / 挑选待抓源 / 条目 → 记录草稿 / 批内去重（纯函数）；
 * - **本文件**：`importOpml`（导入前校验）、`fetchFeed`（条件请求 + 三态失败机 + 304 退避 +
 *   内容指纹门）、配置读写（`settings.feeds` / `settings.feed_state`）、条目落库（`records`）、
 *   以及把上面这些串成一轮 tick。
 *
 * 三条口径来自计划（不重新论证）：
 * 1. **304 不计入失败**：`consecutiveNotModified` 与 `failCount` 是两个独立计数器；
 * 2. **三态失败机**：`ok / failing / recovering`，`failCount >= 3` 才进 `failing` 并告警一次，
 *    进 `failing` 后**连续 2 次成功**才回 `ok` 并恢复通知一次，`failing` 期间不重复告警；
 * 3. **连续 ≥6 次 304 退避** `1h → 2h → 4h → 12h`（封顶），有新条目即归零。
 *
 * 传输（transport）可注入：单测直接喂「假响应」就能覆盖全部状态机分支，不需要起服务。
 * 默认传输优先走同源 `POST /api/feed-fetch`（腾讯云 WAF 会拦 GET query 里的 URL，
 * 与 `linkPreviewService` 同一原因），端点不存在时（Vite 直连开发）降级为直连 fetch。
 *
 * 依赖方向（刻意保持单向，避免环）：
 * `feedService` → `lib/*` / `lib/cloud` / `profileService` / `noticeStore`；
 * **不** import `notification.ts`（它强制要 `recordId`）与 `reminderService`。
 */

import { cloud } from '@/lib/cloud'
import type { SettingsRow } from '@/lib/database.types'
import { buildDedupeKey, contentHash, stripTrackingParams } from '@/lib/feed-dedupe'
import {
  buildFeedRecord,
  feedIdOf as feedIdOfByUrl,
  mergeFeedSources,
  partitionNewEntries,
  selectDueFeeds,
  type FeedRecordDraft,
} from '@/lib/feed-store'
import { parseFeed, type ParsedFeedItem } from '@/lib/feed-parse'
import { buildOpml, parseOpml, type OpmlFeed, type OpmlSkip } from '@/lib/opml'
import { profileService } from '@/services/profileService'
import { pushNotice } from '@/store/noticeStore'

/* ============================== 对外类型 ============================== */

/** 一条订阅源（`settings.feeds` 的元素形状；落库在 P0-3 下半）。 */
export interface FeedSource {
  /** 稳定 id（导入时按 URL 派生，便于 `settings.feed_state[id]` 对齐）。 */
  id: string
  title: string
  url: string
  htmlUrl?: string | null
  category?: string | null
  /** 暂停的订阅不参与 tick（默认 true）。 */
  enabled?: boolean
}

/** 健康状态：`new` 只用于「从未抓过」的新增订阅。 */
export type FeedHealth = 'new' | 'ok' | 'failing' | 'recovering'

/** 单个订阅的运行时状态（对应 `settings.feed_state[feedId]`）。 */
export interface FeedState {
  /** 条件请求：`ETag`。 */
  etag: string | null
  /** 条件请求：`Last-Modified`。 */
  lastModified: string | null
  /** 连续失败次数（成功即归零；304 **不**动它）。 */
  failCount: number
  /** 连续 304 次数（200 即归零）。 */
  consecutiveNotModified: number
  /** 进入 `recovering` 后的连续成功次数。 */
  consecutiveOk: number
  status: FeedHealth
  /** 下次允许抓取的时间（ISO）；未退避为 null。 */
  nextFetchAt: string | null
  /** 内容指纹（`contentHash`）：相同则只更新 `lastFetchedAt`，不写记录。 */
  lastHash: string | null
  /** 最近一次真正发起抓取的时间（含 304）。 */
  lastFetchedAt: string | null
  /** 最近一次错误的可读原因（成功即清空）。 */
  lastError: string | null
}

/** 新订阅的初始状态（冻结，避免调用方误改共享对象）。 */
export const EMPTY_FEED_STATE: Readonly<FeedState> = Object.freeze({
  etag: null,
  lastModified: null,
  failCount: 0,
  consecutiveNotModified: 0,
  consecutiveOk: 0,
  status: 'new',
  nextFetchAt: null,
  lastHash: null,
  lastFetchedAt: null,
  lastError: null,
})

/** 抓取出的条目（已算好去重键，尚未落库）。 */
export interface FeedEntry {
  /** 去重键（`guid || link || sha1(title+published)`）。 */
  dedupeKey: string
  title: string
  /** 绝对链接；条目没给链接时为 null。 */
  url: string | null
  guid: string | null
  publishedAt: string | null
  summary: string | null
  content: string | null
  author: string | null
  /** 来源订阅。 */
  feedId: string
  feedTitle: string
}

/** 健康状态变化的通知（由调用方决定怎么发；同一状态只出一次）。 */
export interface FeedNotice {
  kind: 'failing' | 'recovered'
  feedId: string
  feedTitle: string
  message: string
}

/** 单次抓取的结局。 */
export type FeedFetchOutcome = 'updated' | 'not-modified' | 'unchanged' | 'failed' | 'deferred'

/** 单次抓取结果。 */
export interface FeedFetchResult {
  outcome: FeedFetchOutcome
  /** 仅 `updated` 非空；其它情况一律空数组（避免调用方误把旧条目再写一遍）。 */
  entries: FeedEntry[]
  /** 因「拿不到去重键」被丢弃的条目数。 */
  skipped: number
  /** 抓取后的状态（调用方负责落库）。 */
  state: FeedState
  /** 需要发的健康通知；无则 null。 */
  notice: FeedNotice | null
  /** 失败原因（`outcome === 'failed'` 时非空）。 */
  error: { code: string; message: string } | null
  /** 上游 HTTP 状态码（没发请求时为 null）。 */
  httpStatus: number | null
}

/** 一次条件请求。 */
export interface FeedHttpRequest {
  url: string
  etag: string | null
  lastModified: string | null
}

/** 一次条件请求的响应（304 时 body 为空串）。 */
export interface FeedHttpResponse {
  status: number
  url: string
  etag: string | null
  lastModified: string | null
  contentType: string | null
  body: string
}

/** 传输实现（可注入；单测用它绕开网络）。 */
export type FeedTransport = (request: FeedHttpRequest) => Promise<FeedHttpResponse>

/** 传输层错误（带机器可读 code）。 */
export class FeedFetchError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'FeedFetchError'
    this.code = code
  }
}

/** OPML 导入结果（预览形态，不落库）。 */
export interface OpmlImportResult {
  /** OPML 的 `<head><title>`。 */
  title: string | null
  feeds: OpmlFeed[]
  skipped: OpmlSkip[]
  counts: { outline: number; accepted: number; skipped: number }
  warnings: string[]
}

/** 订阅配置（`settings.feeds` + `settings.feed_state` 的内存形态）。 */
export interface FeedConfig {
  feeds: FeedSource[]
  /** 键为 `feedIdOf(url)`；缺失的源按 `EMPTY_FEED_STATE` 归一。 */
  state: Record<string, FeedState>
}

/** 一轮 tick 的汇总（也是 `runFeedTickIfDue` 的返回值形状）。 */
export interface FeedTickSummary {
  /** 本轮实际尝试抓取的源数（被 `selectDueFeeds` 过滤掉的不计）。 */
  checked: number
  /** 有新内容并成功落库的源数。 */
  updated: number
  /** 200 但内容指纹没变（只更新 `lastFetchedAt`）。 */
  unchanged: number
  /** 上游 304。 */
  notModified: number
  /** 失败（网络 / 上游错误 / 单源异常）。 */
  failed: number
  /** 退避中、本轮根本没发请求的源数（见 `selectDueFeeds` 注释）。 */
  deferred: number
  /** 实际写入的记录条数。 */
  inserted: number
  /** 因「库里已存在 / 批内重复 / 唯一索引冲突」被跳过的条数。 */
  duplicated: number
  /** 本轮产生的健康通知（已通过 `noticeStore` 推送，同时回传给调用方）。 */
  notices: FeedNotice[]
  /**
   * 状态回写失败的原因（成功为 null）。
   *
   * 为什么不让它抛：这一轮抓到的记录已经入库，因为"状态没存下来"就让整轮看起来失败、
   * 把已写入的条目也一并否定，是更糟的选择。但上层必须看得见，所以带在返回值里。
   */
  persistError: string | null
}

/**
 * 迁移未执行（缺 `settings.feeds` / `settings.feed_state`）时的专用错误。
 *
 * 与 `RecordsSchemaMissingError` 同一思路：文案必须**原样**到达用户
 * （告诉他去执行迁移文件），而 `friendlyError()` 会把带 `/` 的长文案脱敏成
 * "操作失败，请稍后重试"，用户就再也看不到修复路径了。
 */
export class FeedSchemaMissingError extends Error {
  /** 稳定错误码（UI 据此决定「原样展示」；跨 bundle 也不会因 instanceof 失效）。 */
  readonly code = 'FEED_SCHEMA_MISSING'

  constructor(message: string = FEED_SCHEMA_HINT) {
    super(message)
    this.name = 'FeedSchemaMissingError'
  }
}

/** 是否是「云库缺 feeds/feed_state 列」错误（按 `code` / `name` 双判定）。 */
export function isFeedSchemaMissingError(error: unknown): boolean {
  if (error instanceof FeedSchemaMissingError) return true
  if (!error || typeof error !== 'object') return false
  const e = error as { code?: unknown; name?: unknown }
  return e.code === 'FEED_SCHEMA_MISSING' || e.name === 'FeedSchemaMissingError'
}

/* ============================== 内部常量 ============================== */

/** 进入 `failing` 的失败次数门槛。 */
const FAIL_THRESHOLD = 3
/** 连续 304 达到该次数后开始退避。 */
const NOT_MODIFIED_BACKOFF_AFTER = 6
/** 304 退避阶梯（1h → 2h → 4h → 12h，最后一档封顶）。 */
const NOT_MODIFIED_BACKOFF_MS = [60 * 60 * 1000, 2 * 60 * 60 * 1000, 4 * 60 * 60 * 1000, 12 * 60 * 60 * 1000]
/** `failing` 状态的下次抓取间隔（避免每 tick 都去打一个已经挂掉的源）。 */
const FAIL_BACKOFF_MS = 60 * 60 * 1000
/** 单次抓取最多入库的条目数（防止首抓一个十年老 feed 把库灌满）。 */
const MAX_ENTRIES = 100
/** 客户端超时（服务端 10s + 2s 余量）。 */
const CLIENT_TIMEOUT_MS = 12_000
/** 代理端点（与 `server.js` 路由一致）。 */
const ENDPOINT = '/api/feed-fetch'
/** 查重时单次 `in(...)` 的键数量上限（拼进 URL，太长会被网关截断）。 */
const ENTRY_LOOKUP_BATCH = 100
/** 单次 insert 的条数上限（行宽较大，50 条一批既有吞吐又不至于超请求体限制）。 */
const ENTRY_INSERT_BATCH = 50
/** 两轮抓取之间的最小间隔（`runFeedTickIfDue` 的默认节流）。 */
const DEFAULT_TICK_INTERVAL_MS = 30 * 60 * 1000
/** 迁移未执行的修复指引（`friendlyError` 会脱敏带 `/` 的文案，故由 UI 原样展示）。 */
const FEED_SCHEMA_HINT =
  '云库缺少 feeds 字段，请先执行 docs/v2.14/migration.sql（订阅配置读写在 settings.feeds / settings.feed_state）'

/* ============================== 状态工具 ============================== */

/** 把可能残缺的状态补全成完整 `FeedState`（云端历史数据 / 新增字段都靠它兜底）。 */
export function normalizeFeedState(raw: Partial<FeedState> | null | undefined): FeedState {
  const base = EMPTY_FEED_STATE
  if (!raw) return { ...base }
  const status: FeedHealth =
    raw.status === 'ok' || raw.status === 'failing' || raw.status === 'recovering' || raw.status === 'new'
      ? raw.status
      : 'new'
  return {
    etag: raw.etag ?? null,
    lastModified: raw.lastModified ?? null,
    failCount: Number.isFinite(raw.failCount) ? Math.max(0, Math.trunc(raw.failCount as number)) : 0,
    consecutiveNotModified: Number.isFinite(raw.consecutiveNotModified)
      ? Math.max(0, Math.trunc(raw.consecutiveNotModified as number))
      : 0,
    consecutiveOk: Number.isFinite(raw.consecutiveOk) ? Math.max(0, Math.trunc(raw.consecutiveOk as number)) : 0,
    status,
    nextFetchAt: raw.nextFetchAt ?? null,
    lastHash: raw.lastHash ?? null,
    lastFetchedAt: raw.lastFetchedAt ?? null,
    lastError: raw.lastError ?? null,
  }
}

/**
 * 订阅 id：由 URL 派生（同一地址重复导入得到同一个 id，状态才不会丢）。
 *
 * 实现委托给 `lib/feed-store.feedIdOf`：合并/挑选等纯函数也需要它，
 * 若让 lib 反向 import 本文件就形成 lib↔service 环。外部签名与语义不变。
 */
export function feedIdOf(url: string): string {
  return feedIdOfByUrl(url)
}

/** 从错误对象读错误码（兼容 `code` 与嵌套 `error.code`，与 `icsImportService` 同写法）。 */
function readErrorCodeOf(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const e = error as { code?: unknown; error?: { code?: unknown } }
  const code = e.code ?? e.error?.code
  return typeof code === 'string' ? code : typeof code === 'number' ? String(code) : ''
}

/**
 * 是否属于「列不存在」类错误码：
 * - `42703`：PostgreSQL 的 undefined_column（迁移没执行）；
 * - `PGRST204`：PostgREST 的 schema cache 未识别该列（迁移执行了但缓存没刷）。
 */
function isSchemaMissingCode(code: string): boolean {
  return code === '42703' || code === 'PGRST204'
}

/** 错误 → 可读文本（保留 `FeedSchemaMissingError` 的迁移指引，不被兜底文案吞掉）。 */
function describeError(error: unknown): string {
  if (error instanceof Error && error.message && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  return '订阅抓取失败'
}

/** 当前时刻（ISO）。 */
function nowIso(now?: string): string {
  if (now) {
    const parsed = Date.parse(now)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }
  return new Date().toISOString()
}

/** 时间戳 + 毫秒 → ISO。 */
function addMs(iso: string, ms: number): string {
  return new Date(Date.parse(iso) + ms).toISOString()
}

/** 解析 ISO 时间；非法返回 NaN。 */
function timeOf(iso: string | null): number {
  if (!iso) return Number.NaN
  return Date.parse(iso)
}

/* ============================== OPML 导入 ============================== */

/** `importOpml` 选项。 */
export interface ImportOpmlOptions {
  /** 已在订阅列表里的地址（大小写/跟踪参数不敏感）；命中的会记为「已存在」。 */
  existingUrls?: Iterable<string>
  /** 注入当前时刻（本函数目前不读时钟，保留给后续 `createdAt` 用）。 */
  now?: string
}

/**
 * 解析 OPML 并合并已有订阅。
 *
 * 与 `parseOpml` 的差别只有一处：**已存在的订阅也算「跳过」并给出可读原因**，
 * 这样导入结果能直接展示成「19 条新增 / 1 条已存在」，而不是静默少几条。
 */
export function importOpml(xml: string, options: ImportOpmlOptions = {}): OpmlImportResult {
  const parsed = parseOpml(xml)

  const existing = new Set<string>()
  for (const raw of options.existingUrls ?? []) {
    const key = stripTrackingParams(String(raw ?? '')).toLowerCase()
    if (key) existing.add(key)
  }

  const feeds: OpmlFeed[] = []
  const skipped: OpmlSkip[] = [...parsed.skipped]
  for (const feed of parsed.feeds) {
    const key = stripTrackingParams(feed.url).toLowerCase()
    if (existing.has(key)) {
      skipped.push({ title: feed.title, url: feed.url, reason: '已在订阅列表中' })
      continue
    }
    existing.add(key)
    feeds.push(feed)
  }

  return {
    title: parsed.title,
    feeds,
    skipped,
    counts: { outline: parsed.outlineCount, accepted: feeds.length, skipped: skipped.length },
    warnings: parsed.warnings,
  }
}

/* ============================== 传输实现 ============================== */

/** 端点不存在（开发态未起 `server.js`）——内部信号，用于降级直连。 */
class FeedEndpointMissing extends Error {
  constructor() {
    super('feed 端点不存在')
    this.name = 'FeedEndpointMissing'
  }
}

/** 从代理响应里读错误码。 */
function readErrorCode(payload: unknown, fallback: string): string {
  if (payload && typeof payload === 'object') {
    const code = (payload as { code?: unknown }).code
    if (typeof code === 'string' && code) return code
  }
  return fallback
}

/** 同源代理传输（生产主路径）。 */
async function proxyTransport(request: FeedHttpRequest): Promise<FeedHttpResponse> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS) : null
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: request.url, etag: request.etag, lastModified: request.lastModified }),
      signal: controller?.signal,
    })

    // 端点不存在：让上层降级到直连（Vite dev / 静态预览）
    if (res.status === 404 || res.status === 405 || res.status === 501) throw new FeedEndpointMissing()

    const payload = (await res.json().catch(() => null)) as
      | { ok: true; data: FeedHttpResponse }
      | { ok: false; code?: string; message?: string }
      | null

    if (!res.ok || !payload || payload.ok !== true) {
      throw new FeedFetchError(
        readErrorCode(payload, `HTTP_${res.status}`),
        (payload && 'message' in payload && payload.message) || '订阅抓取失败',
      )
    }

    const data = payload.data
    return {
      status: data.status,
      url: data.url || request.url,
      etag: data.etag ?? null,
      lastModified: data.lastModified ?? null,
      contentType: data.contentType ?? null,
      body: data.body ?? '',
    }
  } catch (err) {
    if (err instanceof FeedEndpointMissing) throw err
    if (err instanceof FeedFetchError) throw err
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new FeedFetchError(aborted ? 'TIMEOUT' : 'NETWORK_ERROR', aborted ? '订阅抓取超时' : '网络异常，未能连接订阅源')
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 直连传输（仅用于「代理端点不存在」的本地开发；跨域源会失败，属已知限制）。 */
async function directTransport(request: FeedHttpRequest): Promise<FeedHttpResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
  }
  if (request.etag) headers['If-None-Match'] = request.etag
  if (request.lastModified) headers['If-Modified-Since'] = request.lastModified

  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  const timer = controller ? setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS) : null
  try {
    const res = await fetch(request.url, { method: 'GET', headers, redirect: 'follow', signal: controller?.signal })
    return {
      status: res.status,
      url: res.url || request.url,
      etag: res.headers.get('etag'),
      lastModified: res.headers.get('last-modified'),
      contentType: res.headers.get('content-type'),
      body: res.status === 304 ? '' : await res.text(),
    }
  } catch (err) {
    const aborted = err instanceof Error && err.name === 'AbortError'
    throw new FeedFetchError(aborted ? 'TIMEOUT' : 'NETWORK_ERROR', aborted ? '订阅抓取超时' : '网络异常，未能连接订阅源')
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 默认传输：先代理，端点缺失时降级直连。 */
const defaultTransport: FeedTransport = async (request) => {
  try {
    return await proxyTransport(request)
  } catch (err) {
    if (err instanceof FeedEndpointMissing) return directTransport(request)
    throw err
  }
}

/* ============================== 抓取 ============================== */

/** `fetchFeed` 选项。 */
export interface FetchFeedOptions {
  /** 当前状态（不传按新订阅处理）。 */
  state?: Partial<FeedState> | null
  /** 注入当前时刻（ISO），便于单测断言退避时间。 */
  now?: string
  /** 注入传输（单测用）。 */
  transport?: FeedTransport
  /** 单次最多保留的条目数（默认 100）。 */
  maxEntries?: number
}

/** 转发条目并生成去重键；拿不到键的条目丢弃（无键必然重复入库）。 */
function toEntries(feed: FeedSource, items: ParsedFeedItem[], maxEntries: number): { entries: FeedEntry[]; skipped: number } {
  const entries: FeedEntry[] = []
  const seen = new Set<string>()
  let skipped = 0

  for (const item of items) {
    if (entries.length >= maxEntries) {
      skipped += 1
      continue
    }
    const dedupeKey = buildDedupeKey({
      guid: item.guid,
      link: item.link,
      title: item.title,
      publishedAt: item.publishedAt,
    })
    if (!dedupeKey) {
      skipped += 1
      continue
    }
    if (seen.has(dedupeKey)) {
      skipped += 1
      continue
    }
    seen.add(dedupeKey)
    entries.push({
      dedupeKey,
      title: item.title,
      url: item.link,
      guid: item.guid,
      publishedAt: item.publishedAt,
      summary: item.summary,
      content: item.content,
      author: item.author,
      feedId: feed.id,
      feedTitle: feed.title,
    })
  }

  return { entries, skipped }
}

/**
 * 抓取一个订阅源（不落库）。
 *
 * 结局：
 * - `deferred`：还没到 `nextFetchAt`，压根没发请求；
 * - `failed`：网络/上游错误，`state.failCount` 已递增，需按 `notice` 决定是否告警；
 * - `not-modified`：上游 304，`consecutiveNotModified` 已 +1（可能触发退避）；
 * - `unchanged`：200 但内容指纹没变，只应更新 `lastFetchedAt`（不写记录）；
 * - `updated`：有新内容，`entries` 待落库。
 */
export async function fetchFeed(feed: FeedSource, options: FetchFeedOptions = {}): Promise<FeedFetchResult> {
  const transport = options.transport ?? defaultTransport
  const now = nowIso(options.now)
  const maxEntries = Math.max(1, options.maxEntries ?? MAX_ENTRIES)
  const state = normalizeFeedState(options.state)

  // 1) 退避窗口内直接跳过（不发请求、不动状态，避免把计数刷成"成功"）
  const nextAt = timeOf(state.nextFetchAt)
  if (Number.isFinite(nextAt) && nextAt > timeOf(now)) {
    return { outcome: 'deferred', entries: [], skipped: 0, state, notice: null, error: null, httpStatus: null }
  }

  let response: FeedHttpResponse
  try {
    response = await transport({ url: feed.url, etag: state.etag, lastModified: state.lastModified })
  } catch (err) {
    const code = err instanceof FeedFetchError ? err.code : 'NETWORK_ERROR'
    const message = err instanceof Error ? err.message : '订阅抓取失败'
    return failureResult(feed, state, now, code, message, null)
  }

  // 2) 304：只动「连续未修改」，不动 failCount、不改健康状态
  if (response.status === 304) {
    const consecutiveNotModified = state.consecutiveNotModified + 1
    const over = consecutiveNotModified - NOT_MODIFIED_BACKOFF_AFTER
    const backoffMs = over >= 0 ? NOT_MODIFIED_BACKOFF_MS[Math.min(over, NOT_MODIFIED_BACKOFF_MS.length - 1)] : 0

    return {
      outcome: 'not-modified',
      entries: [],
      skipped: 0,
      state: {
        ...state,
        etag: response.etag ?? state.etag,
        lastModified: response.lastModified ?? state.lastModified,
        consecutiveNotModified,
        nextFetchAt: backoffMs > 0 ? addMs(now, backoffMs) : null,
        lastFetchedAt: now,
        // 304 说明源是活的，但按口径「连续 2 次成功才回 ok」——304 不计入成功次数
        lastError: state.lastError,
      },
      notice: null,
      error: null,
      httpStatus: 304,
    }
  }

  if (response.status < 200 || response.status >= 300) {
    return failureResult(
      feed,
      state,
      now,
      `UPSTREAM_${response.status}`,
      `订阅源返回异常状态（HTTP ${response.status}）`,
      response.status,
    )
  }

  // 3) 200：解析 + 指纹 + 健康状态推进
  const health = advanceHealthOnSuccess(feed, state)
  const parsed = parseFeed(response.body, response.url || feed.url)
  const { entries, skipped } = toEntries(feed, parsed.items, maxEntries)
  const hash = await contentHash(response.url ? `${response.url}\n${response.body}` : response.body)

  const healthy: FeedState = {
    etag: response.etag ?? state.etag,
    lastModified: response.lastModified ?? state.lastModified,
    failCount: 0,
    consecutiveNotModified: 0,
    consecutiveOk: health.consecutiveOk,
    status: health.status,
    nextFetchAt: null,
    lastHash: hash,
    lastFetchedAt: now,
    lastError: null,
  }

  const unchanged = Boolean(state.lastHash) && state.lastHash === hash
  return {
    outcome: unchanged ? 'unchanged' : 'updated',
    entries: unchanged ? [] : entries,
    skipped: unchanged ? parsed.items.length : skipped,
    state: healthy,
    notice: health.notice,
    error: null,
    httpStatus: response.status,
  }
}

/** 成功路径的健康状态推进（含 `failing → recovering → ok` 两段恢复）。 */
function advanceHealthOnSuccess(feed: FeedSource, state: FeedState): { status: FeedHealth; consecutiveOk: number; notice: FeedNotice | null } {
  if (state.status === 'failing') {
    return { status: 'recovering', consecutiveOk: 1, notice: null }
  }
  if (state.status === 'recovering') {
    const consecutiveOk = state.consecutiveOk + 1
    if (consecutiveOk >= 2) {
      return {
        status: 'ok',
        consecutiveOk: 0,
        notice: {
          kind: 'recovered',
          feedId: feed.id,
          feedTitle: feed.title,
          message: `订阅「${feed.title}」已恢复`,
        },
      }
    }
    return { status: 'recovering', consecutiveOk, notice: null }
  }
  return { status: 'ok', consecutiveOk: 0, notice: null }
}

/**
 * 失败路径的健康状态推进（**唯一的失败口径**：门槛 / 退避 / 告警去重都在这里）。
 *
 * 为什么必须只有一个入口：失败有两条来源，而"健康态"只有一份。
 * 1. `fetchFeed` 的传输 / 上游错误（包装成 `failureResult`）；
 * 2. `runFeedTick` 的单源兜底异常（`records` 写入被 RLS 拒成 `42501`、单行数据非法、缺列…）。
 *
 * 若只让第 1 条走状态机，第 2 条就会出现「`status` 说 ok、`failCount` 却是 3」
 * （`docs/v2.14/migration.sql` 明确不允许），并且异常源永不告警、`nextFetchAt` 恒为旧值
 * → 每轮 tick 重复打同一个已经挂掉的源。所以两条来源共用一个函数。
 *
 * 迁移口径（不变）：
 * - `failCount >= FAIL_THRESHOLD` 才进 `failing`，并**只在首次跨过门槛时**产出一条告警；
 * - 进 `failing` 同时设 `nextFetchAt = now + FAIL_BACKOFF_MS`（退避）；
 * - `recovering` 期间再失败：立刻回 `failing`，但**不**重复告警（早就告过警了）。
 *
 * @param feed 订阅源（只用来填通知里的 id / 标题）
 * @param state 失败前的状态
 * @param now 本次失败时刻（ISO）
 * @param message 可读原因；空值回落为 `订阅抓取失败`（`lastError` 绝不为空串）
 * @returns 推进后的状态 + 需要发的告警（无需告警时为 null）
 */
export function advanceHealthOnFailure(
  feed: FeedSource,
  state: FeedState,
  now: string,
  message: string,
): { state: FeedState; notice: FeedNotice | null } {
  const reason = typeof message === 'string' && message.trim() ? message : '订阅抓取失败'
  const failCount = state.failCount + 1
  const reachesThreshold = failCount >= FAIL_THRESHOLD
  // 已告警过（failing）或曾被判失败（recovering 回退）→ 不再重复告警
  const enteringFailing = reachesThreshold && state.status !== 'failing'
  const status: FeedHealth = reachesThreshold || state.status === 'recovering' ? 'failing' : state.status

  return {
    state: {
      ...state,
      failCount,
      consecutiveNotModified: 0,
      consecutiveOk: 0,
      status,
      nextFetchAt: reachesThreshold ? addMs(now, FAIL_BACKOFF_MS) : null,
      lastFetchedAt: now,
      lastError: reason,
    },
    notice: enteringFailing
      ? {
          kind: 'failing',
          feedId: feed.id,
          feedTitle: feed.title,
          message: `订阅「${feed.title}」连续 ${failCount} 次抓取失败：${reason}`,
        }
      : null,
  }
}

/** 失败路径（`fetchFeed` 用）：状态机统一委托给 `advanceHealthOnFailure`。 */
function failureResult(
  feed: FeedSource,
  state: FeedState,
  now: string,
  code: string,
  message: string,
  httpStatus: number | null,
): FeedFetchResult {
  const advanced = advanceHealthOnFailure(feed, state, now, message)

  return {
    outcome: 'failed',
    entries: [],
    skipped: 0,
    state: advanced.state,
    notice: advanced.notice,
    error: { code, message: advanced.state.lastError ?? message },
    httpStatus,
  }
}

/* ============================== 配置读写（settings.feeds / feed_state） ============================== */

/** 空配置（每次新建对象：调用方会就地写 `state`，共享同一个对象会互相污染）。 */
function emptyFeedConfig(): FeedConfig {
  return { feeds: [], state: {} }
}

/**
 * 云端 `settings.feeds` → `FeedSource[]`。
 *
 * 容错口径与 `recordService.mapRecord` 一致：**任何脏数据都不许抛错**。
 * 少 `id` 的条项按 URL 现算（老数据 / 手写 JSON），没有 `url` 的直接丢弃
 * （没有地址的订阅既抓不了也去不了重）。
 *
 * @param value JSONB 原值（对象 / 字符串 / 数组 / null 都可能）
 */
function toFeedSources(value: unknown): FeedSource[] {
  if (!Array.isArray(value)) return []
  const feeds: FeedSource[] = []
  const seen = new Set<string>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const item = raw as Record<string, unknown>
    const url = typeof item.url === 'string' ? item.url.trim() : ''
    if (!url) continue
    const id = typeof item.id === 'string' && item.id.trim() ? item.id.trim() : feedIdOf(url)
    if (!id || seen.has(id)) continue
    seen.add(id)
    const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)
    feeds.push({
      id,
      // 标题缺失时回落地址：列表里出现空白标题比出现 URL 更糟
      title: (typeof item.title === 'string' && item.title.trim()) || url,
      url,
      htmlUrl: text(item.htmlUrl),
      category: text(item.category),
      enabled: item.enabled !== false,
    })
  }
  return feeds
}

/** 云端 `settings.feed_state` → `{[feedId]: FeedState}`（每个值都过 `normalizeFeedState`）。 */
function toFeedStateMap(value: unknown): Record<string, FeedState> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const map: Record<string, FeedState> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const id = key.trim()
    if (!id) continue
    if (!raw || typeof raw !== 'object') continue
    map[id] = normalizeFeedState(raw as Partial<FeedState>)
  }
  return map
}

/** 读配置时顺带拿到 settings 行 id：写回时要靠它决定 update 还是 insert。 */
interface LoadedFeedConfig {
  config: FeedConfig
  /** 无 settings 行（新账号）时为 null。 */
  rowId: number | null
}

/**
 * 读 settings 行并归一成订阅配置。
 *
 * **读侧永不因缺列报错**：`select('*')` 本来就不会返回不存在的列，
 * 缺列的表现是 `feeds` 键不存在 → 空配置。真拿到 `42703` 只可能是连 `settings`
 * 表都没建（迁移完全没跑），此时同样按空配置继续，等到**写**的时候再提示用户去执行迁移。
 *
 * 走 `profileService.getSettings()` 而不是自己拼 SQL：settings 行的读入口只有一处
 * （与提醒设置共用），两处各拼一遍必然出现"某处少判了 maybeSingle"的差异。
 */
async function readFeedConfig(): Promise<LoadedFeedConfig> {
  let row: SettingsRow | null
  try {
    row = await profileService.getSettings()
  } catch (error) {
    if (isSchemaMissingCode(readErrorCodeOf(error))) return { config: emptyFeedConfig(), rowId: null }
    throw error
  }
  if (!row || typeof row !== 'object') return { config: emptyFeedConfig(), rowId: null }

  const rowId = typeof row.id === 'number' && Number.isFinite(row.id) ? row.id : null
  return {
    config: { feeds: toFeedSources(row.feeds), state: toFeedStateMap(row.feed_state) },
    rowId,
  }
}

/**
 * 读订阅配置（源列表 + 运行时状态）。
 *
 * @returns 无 settings 行 / 迁移未执行 / 字段为空时都是空配置（不抛错）
 */
export async function loadFeedConfig(): Promise<FeedConfig> {
  return (await readFeedConfig()).config
}

/**
 * 写回订阅配置（只写 `feeds` 与 `feed_state` 两列）。
 *
 * 不写 `owner_id`：与 `profileService.save` 一致，身份列由后端 `DEFAULT auth.uid()` 填，
 * 客户端硬塞一个 owner_id 反而会在换账号时写错行。
 *
 * @param config 完整配置（调用方负责先合并）
 * @param rowId settings 行 id；不传则现读一次（传了可省一次查询）
 * @throws FeedSchemaMissingError 迁移未执行（缺这两列）
 */
export async function saveFeedConfig(config: FeedConfig, rowId?: number | null): Promise<void> {
  const feeds = Array.isArray(config?.feeds) ? config.feeds : []
  const state = config && config.state && typeof config.state === 'object' ? config.state : {}
  const id = rowId === undefined ? (await readFeedConfig()).rowId : rowId
  try {
    await profileService.save(id, { feeds, feed_state: state })
  } catch (error) {
    if (isFeedSchemaMissingError(error)) throw error
    if (isSchemaMissingCode(readErrorCodeOf(error))) throw new FeedSchemaMissingError()
    throw error
  }
}

/**
 * 合并并保存新订阅（OPML 导入 / 手动添加都走这里）。
 *
 * 只动 `feeds`：**已有源的 `state` 一个字段都不改**——导入不该把退避/失败计数清零，
 * 否则每次导入 OPML 都会让已经挂了十次的源重新排队挨打。
 *
 * @param incoming 待添加的订阅（id 可缺，合并时按 URL 重算）
 * @param config 已读好的配置（不传则现读一次）
 */
export async function addFeeds(
  incoming: FeedSource[],
  config?: FeedConfig,
): Promise<{ config: FeedConfig; added: FeedSource[]; duplicated: number }> {
  let base: FeedConfig
  let rowId: number | null | undefined
  if (config) {
    base = config
    rowId = undefined
  } else {
    const loaded = await readFeedConfig()
    base = loaded.config
    rowId = loaded.rowId
  }

  const merged = mergeFeedSources(base.feeds, Array.isArray(incoming) ? incoming : [])
  if (merged.added.length === 0) {
    // 全是重复项：不发写请求（省一次往返，也避免把 updated_at 无谓地刷一遍）
    return { config: base, added: [], duplicated: merged.duplicated }
  }

  const next: FeedConfig = { feeds: merged.feeds, state: base.state }
  await saveFeedConfig(next, rowId)
  return { config: next, added: merged.added, duplicated: merged.duplicated }
}

/* ============================== 条目落库 ============================== */

/** `upsertEntries` 选项。 */
export interface UpsertEntriesOptions {
  /** 注入入库时刻（ISO），用于 `record_meta.importedAt` / `link_meta.fetchedAt`。 */
  now?: string
}

/** 记录草稿 → `records` 插入行（snake_case）。 */
function toInsertRow(draft: FeedRecordDraft): Record<string, unknown> {
  return {
    type: draft.type,
    title: draft.title,
    content: draft.content,
    url: draft.url,
    external_uid: draft.externalUid,
    link_meta: draft.linkMeta,
    record_meta: draft.recordMeta,
  }
}

/**
 * 批量查「库里已有的去重键」。
 *
 * 刻意**不加** `.eq('is_deleted', false)`：回收站里的同 UID 也算已存在——
 * 否则用户删掉一条订阅条目后，下一轮抓取会把它"复活"成一条新记录，
 * 而用户的意图是"这条我不要了"。
 *
 * @param keys 待查的去重键（已去重、去空）
 * @throws FeedSchemaMissingError 迁移未执行（缺 `external_uid`）：
 *         缺列时查重结果恒为空，盲目插入会灌重复数据（沿用 P0-1 口径）
 */
async function listExistingKeys(keys: string[]): Promise<Set<string>> {
  const found = new Set<string>()
  for (let index = 0; index < keys.length; index += ENTRY_LOOKUP_BATCH) {
    const chunk = keys.slice(index, index + ENTRY_LOOKUP_BATCH)
    const { data, error } = await cloud.database.from('records').select('external_uid').in('external_uid', chunk)
    if (error) {
      if (isSchemaMissingCode(readErrorCodeOf(error))) throw new FeedSchemaMissingError()
      throw error
    }
    for (const row of (data as Array<{ external_uid?: unknown }> | null) ?? []) {
      const value = row && typeof row === 'object' ? row.external_uid : null
      if (typeof value === 'string' && value) found.add(value)
    }
  }
  return found
}

/**
 * 把抓取到的条目写进 `records`（重复的跳过）。
 *
 * 流程：查重（`external_uid`，100 条一批）→ 过滤 → 50 条一批 insert。
 *
 * 三道闸，缺一不可：
 * 1. **查重先于写入**：库里已有的键不再插（这是常态路径，覆盖 99% 的重复）；
 * 2. **批内自去重**：同一份 feed 里同一条出现两次（置顶 + 时间线）只收一条；
 * 3. **唯一索引冲突降级**（`23505`）：另一个标签页刚好写入同一批时整批会失败，
 *    此时逐条重试，冲突的计 `duplicated`，其余照常插入——不能因为并发就让整批丢失。
 *
 * @param entries 待入库条目（`fetchFeed` 的 `entries`）
 * @param options 注入入库时刻
 * @returns 写入 / 重复 / 跳过（拿不到去重键）的条数
 * @throws FeedSchemaMissingError 迁移未执行（缺 `external_uid`）
 */
export async function upsertEntries(
  entries: FeedEntry[],
  options: UpsertEntriesOptions = {},
): Promise<{ inserted: number; duplicated: number; skipped: number }> {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : []
  // 空数组直接返回：**不发任何请求**。一轮 tick 里大多数源都是 unchanged，
  // 这条早退是"不抓白不抓"与"抓了不写库"之间的关键分界
  if (list.length === 0) return { inserted: 0, duplicated: 0, skipped: 0 }

  const now = nowIso(options.now)

  const keys: string[] = []
  for (const entry of list) {
    const key = typeof entry.dedupeKey === 'string' ? entry.dedupeKey.trim() : ''
    if (key && !keys.includes(key)) keys.push(key)
  }

  const existing = await listExistingKeys(keys)
  const { fresh, duplicated, skipped } = partitionNewEntries(list, existing)

  let inserted = 0
  let conflicts = 0
  for (let index = 0; index < fresh.length; index += ENTRY_INSERT_BATCH) {
    const batch = fresh.slice(index, index + ENTRY_INSERT_BATCH)
    const rows = batch.map((entry) => toInsertRow(buildFeedRecord(entry, now)))
    const { error } = await cloud.database.from('records').insert(rows).select()
    if (!error) {
      inserted += batch.length
      continue
    }
    if (isSchemaMissingCode(readErrorCodeOf(error))) throw new FeedSchemaMissingError()

    // 整批失败：逐条重试。最常见的原因是 23505（并发重复导入），
    // 但也可能是某一条行数据本身有问题——一条坏数据不该让另外 49 条都进不来
    for (const row of rows) {
      const { error: rowError } = await cloud.database.from('records').insert(row).select()
      if (!rowError) {
        inserted += 1
        continue
      }
      if (isSchemaMissingCode(readErrorCodeOf(rowError))) throw new FeedSchemaMissingError()
      if (readErrorCodeOf(rowError) === '23505') {
        conflicts += 1
        continue
      }
      // 其它错误不许静默：静默等于用户以为订阅已入库、实际什么都没写
      throw rowError
    }
  }

  return { inserted, duplicated: duplicated + conflicts, skipped }
}

/* ============================== 一轮抓取 ============================== */

/** `runFeedTick` 选项。 */
export interface RunFeedTickOptions {
  /** 注入当前时刻（ISO）。 */
  now?: string
  /** 注入传输（单测用）。 */
  transport?: FeedTransport
  /** 本轮最多抓几个源（默认 5）。 */
  limit?: number
  /** 额外的通知回调（默认已通过 `noticeStore` 推送一次）。 */
  notify?: (notice: FeedNotice) => void
}

/**
 * 推送健康通知。
 *
 * 为什么用 `noticeStore` 而不是 `notification.ts`：后者的 `NotifyPayload` 强制要求
 * `recordId`（点击通知要能定位记录），而订阅告警根本没有对应记录——硬塞 0
 * 会污染桌面端的点击溯源（点进去打开一条不存在的记录）。
 *
 * @param notice 健康状态变化
 * @param notify 调用方注入的额外回调
 */
function notifyFeedNotice(notice: FeedNotice, notify?: (notice: FeedNotice) => void): void {
  try {
    pushNotice(notice.message, notice.kind === 'failing' ? 'warning' : 'info')
  } catch {
    /* 应用内提示失败不影响抓取结果 */
  }
  if (notify) {
    try {
      notify(notice)
    } catch {
      /* 上层回调异常一律吞掉：通知是附加信息，不能回滚一轮已完成的抓取 */
    }
  }
}

/**
 * 跑一轮订阅抓取（**不节流**，由 `runFeedTickIfDue` 负责"该不该跑"）。
 *
 * 顺序：读配置 → 挑待抓源 → 逐个顺序抓（**不 `Promise.all`**，并发请求会把目标站打爆）→
 * 有新内容就落库 → 最后**只写一次**配置（减少写放大）。
 *
 * 三条不能退让的行为：
 * 1. **单源失败绝不中断整批**：每个源单独 try/catch，异常计入 `failed` 并把原因写进
 *    该源的 `lastError`（下一轮按失败计数退避），其余源继续抓；
 * 2. **`failed` 时 `lastError` 必须非空**：`fetchFeed` 已经保证，这里只负责**不要清空它**；
 * 3. **配置写失败不抛**：记录已经入库，没理由因为状态没存下来就否定整轮；
 *    但必须回传 `persistError`，让上层看得见（否则状态永远不前进，每轮重复抓同一批）。
 *
 * 异常路径与 `fetchFeed` 失败路径共用 `advanceHealthOnFailure`（门槛 / 退避 / 告警去重），
 * 所以「上游 500」和「落库被拒」对同一个源产生**同一套**健康态演进与告警。
 *
 * @param options 注入时刻 / 传输 / 上限 / 通知回调
 */
export async function runFeedTick(options: RunFeedTickOptions = {}): Promise<FeedTickSummary> {
  const summary: FeedTickSummary = {
    checked: 0,
    updated: 0,
    unchanged: 0,
    notModified: 0,
    failed: 0,
    deferred: 0,
    inserted: 0,
    duplicated: 0,
    notices: [],
    persistError: null,
  }

  const now = nowIso(options.now)
  let loaded: LoadedFeedConfig
  try {
    loaded = await readFeedConfig()
  } catch (error) {
    // 配置都读不到：一个请求都别发（抓回来也无处记状态），把原因交给上层
    summary.persistError = describeError(error)
    return summary
  }

  const config = loaded.config
  const due = selectDueFeeds(config.feeds, config.state, now, options.limit)

  for (const feed of due) {
    summary.checked += 1
    // 抓取前的状态快照：落库失败时要按它回滚。
    // 为什么不能直接在当前状态上改：一次 200 成功会写入新的 lastHash，
    // 若随后 insert 失败而 lastHash 留在库里，下一轮就会判「内容没变」→
    // 这批条目永远进不了库（数据静默丢失）。回滚到抓取前状态，下一轮才会重抓。
    const before = normalizeFeedState(config.state[feed.id])
    try {
      const result = await fetchFeed(feed, {
        state: config.state[feed.id],
        transport: options.transport,
        now,
      })
      // 状态写回内存配置；循环结束后统一落库
      config.state[feed.id] = result.state

      if (result.outcome === 'updated') {
        const written = await upsertEntries(result.entries, { now })
        summary.updated += 1
        summary.inserted += written.inserted
        summary.duplicated += written.duplicated
      } else if (result.outcome === 'unchanged') {
        summary.unchanged += 1
      } else if (result.outcome === 'not-modified') {
        summary.notModified += 1
      } else if (result.outcome === 'deferred') {
        summary.deferred += 1
      } else {
        summary.failed += 1
      }

      if (result.notice) {
        summary.notices.push(result.notice)
        notifyFeedNotice(result.notice, options.notify)
      }
    } catch (error) {
      // 单源异常（含落库时报的 FeedSchemaMissingError）：计入失败并把原因留档，
      // 绝不中断这一轮——否则一个源的迁移/权限问题会让其它源永远抓不到。
      //
      // 健康态推进**必须**走与 `fetchFeed` 失败路径同一个函数 `advanceHealthOnFailure`：
      // 只写 failCount 而不动 status / nextFetchAt 会造出「status 说 ok、failCount 却是 3」
      // 的自相矛盾状态，且异常源永不告警、永不退避（每轮 tick 重打一次已经挂掉的源）。
      summary.failed += 1
      const failure = advanceHealthOnFailure(feed, before, now, describeError(error))
      config.state[feed.id] = failure.state
      if (failure.notice) {
        summary.notices.push(failure.notice)
        notifyFeedNotice(failure.notice, options.notify)
      }
    }
  }

  try {
    await saveFeedConfig(config, loaded.rowId)
  } catch (error) {
    summary.persistError = describeError(error)
  }

  return summary
}

/** `runFeedTickIfDue` 选项。 */
export interface RunFeedTickIfDueOptions {
  /** 注入当前时刻（ISO），节流判定也用它。 */
  now?: string
  /** 最小间隔（默认 30 分钟）。 */
  minIntervalMs?: number
  /** 免打扰窗口内传 true：直接跳过，不轮询。 */
  quiet?: boolean
  transport?: FeedTransport
  limit?: number
}

/** 上一次真正跑起来的时刻（模块级；刷新页面重置——"活跃时才有意义"正符合这个语义）。 */
let lastFeedTickAt: number | null = null
/** 在途闸：定时器与可见性变化同时触发时只跑一次。 */
let feedTickRunning = false

/**
 * 到点才跑一轮订阅抓取（节流 + 免打扰 + 断网 三闸）。
 *
 * 为什么需要这层：`tickNow()` 每 30s 跑一次，订阅抓取却只该半小时一次——
 * 把节流放在这里，调用方（提醒调度 / 页面启动）不必各自记时间。
 *
 * 三闸顺序（先便宜后昂贵）：免打扰 → 断网 → 节流 → 在途。
 *
 * @returns 本轮汇总；任一闸命中返回 null（表示"这轮什么都没做"）
 */
export async function runFeedTickIfDue(
  options: RunFeedTickIfDueOptions = {},
): Promise<FeedTickSummary | null> {
  try {
    if (options.quiet === true) return null
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return null
    if (feedTickRunning) return null

    const parsed = options.now ? Date.parse(options.now) : Number.NaN
    const at = Number.isFinite(parsed) ? parsed : Date.now()
    const minInterval = Number.isFinite(options.minIntervalMs)
      ? Math.max(0, Number(options.minIntervalMs))
      : DEFAULT_TICK_INTERVAL_MS
    if (lastFeedTickAt !== null && at - lastFeedTickAt < minInterval) return null

    feedTickRunning = true
    lastFeedTickAt = at
    try {
      return await runFeedTick({ now: options.now, transport: options.transport, limit: options.limit })
    } catch {
      // `runFeedTick` 已经吞掉单源异常与写库失败，这里只兜"连汇总都没造出来"的极端情况
      return null
    } finally {
      feedTickRunning = false
    }
  } catch {
    return null
  }
}

/* ============================== OPML 导出 ============================== */

/**
 * 导出订阅为 OPML 2.0 文本。
 *
 * `FeedSource` → `OpmlFeed` 的字段补齐（`htmlUrl` / `category` 允许 undefined，
 * `OpmlFeed` 要求 null）在这里做，`buildOpml` 只负责排版与转义。
 */
export async function exportOpml(): Promise<string> {
  const config = await loadFeedConfig()
  const feeds: OpmlFeed[] = config.feeds.map((feed) => ({
    title: feed.title,
    url: feed.url,
    htmlUrl: feed.htmlUrl ?? null,
    category: feed.category ?? null,
  }))
  return buildOpml(feeds)
}

/* ============================== 单例 ============================== */

/** service 单例（与项目其它 service 风格一致）。 */
export const feedService = {
  importOpml,
  fetchFeed,
  feedIdOf,
  normalizeFeedState,
  advanceHealthOnFailure,
  EMPTY_FEED_STATE,
  loadFeedConfig,
  saveFeedConfig,
  addFeeds,
  upsertEntries,
  runFeedTick,
  runFeedTickIfDue,
  exportOpml,
}
