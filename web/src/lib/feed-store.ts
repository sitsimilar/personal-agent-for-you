/**
 * 订阅源入库的纯函数层（P0-3 下半）：合并订阅 / 挑选本轮该抓的源 / 条目 → 记录草稿 / 批内去重。
 *
 * 为什么单独成文件（而不是塞进 `services/feedService.ts`）：
 * - 这四件事是导入、定时抓取、OPML 导出共用的**纯计算**，不碰网络也不碰数据库，
 *   放在 lib 里能被 Node 单测直接喂数据验证；service 只负责"读配置 / 发请求 / 落库"。
 * - 依赖方向只有 `services → lib`：本文件**不 import 任何 service**（用了最小结构类型声明，
 *   service 侧的 `FeedSource` / `FeedState` / `FeedEntry` 结构化兼容，天然可传进来）。
 *   反过来 import 会形成 lib↔service 环，单测里也会连带拉起 cloud SDK。
 *
 * 三条口径（与 `feed-dedupe.ts` 同源，不重新论证）：
 * 1. 订阅 id 由 URL 派生（`feedIdOf`），因此同一地址重复导入得到同一个 id，
 *    `settings.feed_state[id]` 里的退避/失败计数不会丢；
 * 2. 落库 URL **不含跟踪参数**（`utm_*` / `fbclid` 等），否则同一篇资讯会以 N 个渠道进来；
 * 3. 条目去重键沿用 `buildDedupeKey`（guid → 剥参数的 link → sha1(title+published)），
 *    本文件不另造一套。
 */

import {
  buildDedupeKey,
  stripTrackingParams,
} from '@/lib/feed-dedupe'
import type { LinkMeta, RecordMeta } from '@shared/types/domain'

/* ============================== 结构类型（与 service 侧同名接口字段一致） ============================== */

/** 订阅源的最小结构（对应 `FeedSource`）。 */
export interface FeedSourceLike {
  /** 稳定 id（`feedIdOf(url)` 派生）。 */
  id: string
  title: string
  url: string
  htmlUrl?: string | null
  category?: string | null
  /** 缺省视为启用（只有显式 `false` 才跳过）。 */
  enabled?: boolean
}

/** 调度只需要 `nextFetchAt`，因此只声明这一个字段。 */
export interface FeedScheduleState {
  /** 下次允许抓取的时间（ISO）；null/缺失 = 立即抓。 */
  nextFetchAt?: string | null
}

/** 条目最小结构（对应 `FeedEntry`）。 */
export interface FeedEntryLike {
  /** 去重键（`buildDedupeKey` 的结果，空串表示拿不到键）。 */
  dedupeKey: string
  title: string
  url: string | null
  guid: string | null
  publishedAt: string | null
  summary: string | null
  content: string | null
  author: string | null
  feedId: string
  feedTitle: string
}

/* ============================== 常量 ============================== */

/** 单轮 tick 最多抓几个源：一次抓几十个会把主线程和页面拖死，剩下的下一轮再抓。 */
export const DEFAULT_TICK_LIMIT = 5

/** 条目拿不到标题时的兜底文案（与 `reminderService` 的「待办提醒」同风格）。 */
const FALLBACK_TITLE = '未命名条目'

/* ============================== 订阅 id ============================== */

/**
 * 订阅 id：由 URL 派生（同一地址重复导入得到同一个 id，状态才不会丢）。
 *
 * 放在 lib 而不是 service：合并/挑选是纯函数，若要 import `feedService.feedIdOf`
 * 就形成 lib→service 的运行时反向依赖（lib 被 service 依赖，环上再套一环）。
 * service 侧的 `feedIdOf` 现在直接委托到这里，外部签名与语义不变。
 *
 * `buildDedupeKey({ link })` 内部会先剥跟踪参数，因此 `?utm_source=x` 的差异不算不同源。
 *
 * @param url 订阅地址
 */
export function feedIdOf(url: string): string {
  return buildDedupeKey({ link: url })
}

/* ============================== 合并订阅 ============================== */

/** 合并结果（`feeds` 已含既有项与新增项，`added` 只有新增，`duplicated` 为被判重的入参条数）。 */
export interface MergeFeedSourcesResult<T extends FeedSourceLike> {
  feeds: T[]
  added: T[]
  duplicated: number
}

/**
 * 合并订阅列表（导入 OPML / 手动新增共用）。
 *
 * 规则：
 * - 按 `feedIdOf(url)` 判重（跟踪参数差异视为同一条）；
 * - **已存在的源保留原 `title`**：用户改过的名字不能被新导入的覆盖，
 *   但 `category` / `htmlUrl` 也不会被覆盖——"已存在"就意味着整条不动；
 * - `incoming` 内部的重复项同样只算一次 `duplicated`（先到先得）；
 * - 输出顺序：先 `existing` 原序，再新加项按 `incoming` 顺序；
 * - 地址为空的入参直接忽略（既不算新增也不算重复）：OPML 解析层已拦截，这里只是防御。
 *
 * `existing` 内部若有同 id 的重复（历史脏数据），这里**不擅自删除**——删订阅是用户的动作，
 * 合并只负责"不要再加一条一样的"。
 *
 * @param existing 已保存的订阅（原序保留）
 * @param incoming 待合并的订阅（通常是 OPML 解析结果）
 */
export function mergeFeedSources<T extends FeedSourceLike>(
  existing: readonly T[],
  incoming: readonly T[],
): MergeFeedSourcesResult<T> {
  const feeds: T[] = []
  const added: T[] = []
  const seen = new Set<string>()

  for (const feed of existing ?? []) {
    if (!feed) continue
    const key = feedIdOf(feed.url)
    // 空地址不可能来自 OPML（解析层已挡），但仍不写进列表以外的地方
    if (!key) continue
    seen.add(key)
    feeds.push(feed)
  }

  let duplicated = 0
  for (const feed of incoming ?? []) {
    if (!feed) continue
    const key = feedIdOf(feed.url)
    if (!key) continue
    if (seen.has(key)) {
      duplicated += 1
      continue
    }
    seen.add(key)
    // 新加项的 id 一律用 URL 派生值：保证与 `feed_state` 的键一致，
    // 调用方（OPML 导入）传进来的对象本来就没有 id 字段
    const next = { ...feed, id: key } as T
    feeds.push(next)
    added.push(next)
  }

  return { feeds, added, duplicated }
}

/* ============================== 调度挑选 ============================== */

/**
 * 挑出本轮该抓的订阅。
 *
 * - `enabled === false` 跳过（用户暂停的源连状态都不该动）；
 * - `state[id].nextFetchAt` 还没到就跳过（304 退避 / failing 退避都在这里兑现）；
 * - `nextFetchAt` 不可解析（脏数据）或缺失 → 当作「已到」：宁可多抓一次，
 *   也不能因为一条坏状态让某个源永久停摆；
 * - 按 `nextFetchAt` 升序（null 最先），同值保持传入顺序（稳定排序）；
 * - 最多取 `limit` 个（默认 5）。
 *
 * @param feeds 全部订阅
 * @param state 运行时状态（`settings.feed_state`）
 * @param nowIso 当前时刻（ISO，由调用方注入，本函数不读时钟）
 * @param limit 单轮上限
 */
export function selectDueFeeds<T extends FeedSourceLike>(
  feeds: readonly T[],
  state: Record<string, FeedScheduleState | undefined>,
  nowIso: string,
  limit: number = DEFAULT_TICK_LIMIT,
): T[] {
  const parsedNow = Date.parse(nowIso)
  const nowMs = Number.isFinite(parsedNow) ? parsedNow : Date.now()
  const max = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : DEFAULT_TICK_LIMIT

  const due: Array<{ feed: T; at: number; index: number }> = []
  ;(feeds ?? []).forEach((feed, index) => {
    if (!feed || feed.enabled === false) return
    const raw = state?.[feed.id]?.nextFetchAt ?? null
    const at = raw ? Date.parse(raw) : Number.NaN
    if (Number.isFinite(at) && at > nowMs) return
    due.push({ feed, at: Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY, index })
  })

  due.sort((a, b) => {
    if (a.at === b.at) return a.index - b.index
    return a.at < b.at ? -1 : 1
  })

  return due.slice(0, max).map((item) => item.feed)
}

/* ============================== 条目 → 记录草稿 ============================== */

/**
 * 记录草稿（camelCase，形状对齐 `RecordCreateInput` 的字段子集）。
 *
 * 刻意**不 import `recordService`**：`RecordCreateInput` 是 service 的入参类型，
 * lib 引它会再次形成反向依赖；这里只导出普通对象类型，
 * 由 `feedService.upsertEntries` 负责翻译成 snake_case 插入行。
 */
export interface FeedRecordDraft {
  type: 'material'
  title: string
  content: string
  /** 已剥跟踪参数的链接；条目没给链接则为 null（不写空串，否则库里有两种"空"）。 */
  url: string | null
  /** 查重键（= 条目去重键），落库后即 `records.external_uid`。 */
  externalUid: string
  linkMeta: LinkMeta
  recordMeta: RecordMeta
}

/** 取域名（与 `linkPreviewService.prettyHost` 同口径：去掉 `www.`，非法 URL 给 null）。 */
function hostOf(url: string | null): string | null {
  if (!url) return null
  try {
    const host = new URL(url).hostname.replace(/^www\./i, '')
    return host || null
  } catch {
    return null
  }
}

/**
 * 条目 → 记录草稿。
 *
 * - `title`：空白则回落「未命名条目」（列表里不能出现没有标题的行）；
 * - `content`：`content || summary || title`，全空给空串（三段都没有时宁可为空也不编造）；
 * - `url`：`stripTrackingParams(entry.url)`，空串 → null（**落库 URL 不含跟踪参数**）；
 * - `linkMeta.status` 固定 `'ok'`：抓取成功才会走到这里，失败的源根本没有条目；
 * - `now` 由调用方注入（一次 tick 的所有条目共享同一时刻，便于按值分组排查）。
 *
 * @param entry 抓取出的条目
 * @param now 入库时刻（ISO），默认读本机时钟
 */
export function buildFeedRecord(entry: FeedEntryLike, now: string = new Date().toISOString()): FeedRecordDraft {
  const rawTitle = String(entry.title ?? '').trim()
  const title = rawTitle || FALLBACK_TITLE
  const content = entry.content || entry.summary || entry.title || ''
  const url = stripTrackingParams(String(entry.url ?? '')) || null
  const externalUid = String(entry.dedupeKey ?? '')

  return {
    type: 'material',
    title,
    content,
    url,
    externalUid,
    linkMeta: {
      title,
      site: hostOf(url),
      fetchedAt: now,
      status: 'ok',
      externalUid,
      feedId: entry.feedId,
    },
    recordMeta: {
      source: 'feed',
      externalUid,
      feedId: entry.feedId,
      feedTitle: entry.feedTitle,
      guid: entry.guid ?? null,
      publishedAt: entry.publishedAt ?? null,
      importedAt: now,
    },
  }
}

/* ============================== 批次去重 ============================== */

/** 批内过滤结果：`fresh` 可入库，`duplicated` 是已存在/批内重复，`skipped` 是拿不到去重键。 */
export interface PartitionEntriesResult<T> {
  fresh: T[]
  duplicated: number
  skipped: number
}

/**
 * 过滤掉「已存在」与「批内重复」的条目。
 *
 * 两道都要有：
 * - 与既有键比对拦"上一轮已经写过的"（**回收站里的同 UID 也算已存在**，
 *   否则用户删掉一条订阅条目后下一轮会被"复活"）；
 * - 批内自去重拦"同一份 feed 里同一条出现两次"（源站常见：置顶 + 时间线各一份）。
 *
 * `dedupeKey` 为空串的条目计入 `skipped` 并丢弃：没有稳定键就无法去重，
 * 每次抓取都会新增一条，宁可不收。
 *
 * @param entries 待入库条目
 * @param existingKeys 库里已有的去重键
 */
export function partitionNewEntries<T extends { dedupeKey: string }>(
  entries: readonly T[],
  existingKeys: Iterable<string>,
): PartitionEntriesResult<T> {
  const known = new Set<string>()
  for (const key of existingKeys ?? []) {
    if (typeof key === 'string' && key) known.add(key)
  }

  const fresh: T[] = []
  let duplicated = 0
  let skipped = 0

  for (const entry of entries ?? []) {
    if (!entry) continue
    const key = typeof entry.dedupeKey === 'string' ? entry.dedupeKey.trim() : ''
    if (!key) {
      skipped += 1
      continue
    }
    if (known.has(key)) {
      duplicated += 1
      continue
    }
    known.add(key)
    fresh.push(entry)
  }

  return { fresh, duplicated, skipped }
}
