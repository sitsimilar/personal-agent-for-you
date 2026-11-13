/**
 * RSS / Atom / RDF 解析（纯函数，浏览器 / Node 同构，零依赖）。
 *
 * 与 `lib/opml.ts` 同一取舍：不引 `DOMParser`（QA 在 Node 跑、首屏包也不该多背一个解析器），
 * 用容错扫描。订阅源的现实情况是「三种格式 + 一堆不规范的转义」，所以这里的重点是
 * **拿不到就降级**而不是严格校验：
 * - 缺 `guid` 用 `link`；缺 `link` 用 `sha1(title+published)`（见 `lib/feed-dedupe.ts`）；
 * - 日期解析不出来留 null（不伪造当前时间，否则去重键会漂）；
 * - 摘要里有 HTML/实体会剥成纯文本并截断，正文原样保留给详情页。
 */

import { decodeXmlEntities } from '@/lib/opml'

/** 单条解析出的条目（未去重、未落库）。 */
export interface ParsedFeedItem {
  /** 源站声明的稳定标识（RSS `guid` / Atom `id`）。 */
  guid: string | null
  /** 绝对链接（相对链接已按 feed 地址解析）。 */
  link: string | null
  /** 标题（空标题回落 `(无标题)`，否则列表里是一行空白）。 */
  title: string
  /** 发布/更新时间（ISO），解析不出来为 null。 */
  publishedAt: string | null
  /** 纯文本摘要（≤ 300 字）。 */
  summary: string | null
  /** 正文（HTML 原样，可能很长）。 */
  content: string | null
  /** 作者名。 */
  author: string | null
}

/** 解析结果。 */
export interface ParsedFeed {
  kind: 'rss' | 'atom' | 'rdf' | 'unknown'
  /** 频道标题。 */
  title: string | null
  /** 站点主页。 */
  siteUrl: string | null
  /** 频道描述 / 副标题。 */
  description: string | null
  items: ParsedFeedItem[]
  /** 非致命提示（空 feed / 缺字段……）。 */
  warnings: string[]
}

/** 摘要截断长度（与 `link-preview` 的描述口径保持一致）。 */
const SUMMARY_MAX = 300

/** 剥 CDATA 包裹。 */
function stripCdata(input: string): string {
  const text = String(input ?? '')
  const match = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(text)
  return match ? match[1] : text
}

/** 转义成可在正则里安全使用的标签名（支持 `dc:date` 这类带命名空间的）。 */
function escapeTagName(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 取第一个 `<tag>…</tag>` 的文本（自动剥 CDATA、解实体、去首尾空白）。
 * 找不到返回 null；自闭合标签（如 Atom 的 `<link href/>`）不会命中。
 */
function textOf(block: string, tags: string | string[]): string | null {
  const list = Array.isArray(tags) ? tags : [tags]
  for (const tag of list) {
    const pattern = new RegExp(`<${escapeTagName(tag)}\\b[^>]*>([\\s\\S]*?)<\\/${escapeTagName(tag)}\\s*>`, 'i')
    const match = pattern.exec(block)
    if (match) {
      const value = decodeXmlEntities(stripCdata(match[1])).trim()
      if (value) return value
    }
  }
  return null
}

/** 取自闭合标签的属性值（Atom 的 `<link rel="alternate" href="…"/>`）。 */
function attrTag(block: string, tag: string, attr: string): string | null {
  const pattern = new RegExp(`<${escapeTagName(tag)}\\b([^>]*)>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(block)) !== null) {
    const attrs = match[1] ?? ''
    const attrPattern = new RegExp(`\\b${escapeTagName(attr)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i')
    const hit = attrPattern.exec(attrs)
    if (hit) {
      const value = decodeXmlEntities(hit[1] ?? hit[2] ?? '').trim()
      if (value) return value
    }
  }
  return null
}

/** 取自闭合标签里某个属性的全部取值（多 `<link>` 时按 rel 挑）。 */
function attrTagAll(block: string, tag: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = []
  const pattern = new RegExp(`<${escapeTagName(tag)}\\b([^>]*)>`, 'gi')
  let match: RegExpExecArray | null
  while ((match = pattern.exec(block)) !== null) {
    const attrs: Record<string, string> = {}
    const attrPattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
    let hit: RegExpExecArray | null
    while ((hit = attrPattern.exec(match[1] ?? '')) !== null) {
      attrs[hit[1].toLowerCase()] = decodeXmlEntities(hit[2] ?? hit[3] ?? '')
    }
    out.push(attrs)
  }
  return out
}

/**
 * HTML → 纯文本（剥脚本/样式、去标签、解实体、压空白）。
 *
 * 只用于摘要展示，不追求完整 HTML 语义：保留段落间的空格即可。
 */
export function htmlToText(input: string): string {
  const text = String(input ?? '')
  if (!text) return ''
  return decodeXmlEntities(
    stripCdata(text)
      .replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(p|div|li|h[1-6]|tr|blockquote)\s*>/gi, ' ')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/** 摘要：纯文本 + 截断（超长补省略号）。 */
function toSummary(raw: string | null): string | null {
  if (!raw) return null
  const text = htmlToText(raw)
  if (!text) return null
  const chars = Array.from(text)
  if (chars.length <= SUMMARY_MAX) return text
  return `${chars.slice(0, SUMMARY_MAX).join('')}…`
}

/**
 * 日期解析：ISO / RFC 822 / 中文式「2026年11月5日」都试一遍。
 *
 * 故意**不**回落到 `now`：伪造发布时间会让「无 guid 无 link」条目的去重键每次抓取都变。
 */
export function parseFeedDate(raw: string | null): string | null {
  const input = String(raw ?? '').trim()
  if (!input) return null

  const direct = Date.parse(input)
  if (Number.isFinite(direct)) return new Date(direct).toISOString()

  // RFC 822 里的单字母时区（V8 认大多数，这里只补常见的几个）
  const zoneMap: Record<string, string> = { UT: 'GMT', Z: 'GMT', A: '+0100', EST: '-0500', PST: '-0800' }
  const rfc = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})\s+(\d{2}:\d{2}(?::\d{2})?)\s*([A-Z]{1,5}|[+-]\d{4})?/.exec(input)
  if (rfc) {
    const zone = rfc[5] ? zoneMap[rfc[5]] ?? rfc[5] : 'GMT'
    const rebuilt = `${rfc[1]} ${rfc[2]} ${rfc[3]} ${rfc[4]} ${zone}`
    const parsed = Date.parse(rebuilt)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }

  // 中文式日期（部分国内源这么发）
  const cn = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2}):(\d{2}))?/.exec(input)
  if (cn) {
    const iso = `${cn[1]}-${String(cn[2]).padStart(2, '0')}-${String(cn[3]).padStart(2, '0')}T${String(cn[4] ?? '0').padStart(2, '0')}:${cn[5] ?? '00'}:00+08:00`
    const parsed = Date.parse(iso)
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString()
  }

  return null
}

/** 相对链接按 feed 地址补全；非法/空返回 null。 */
function absolutize(raw: string | null, baseUrl: string): string | null {
  const input = String(raw ?? '').trim()
  if (!input) return null
  try {
    return new URL(input, baseUrl || undefined).toString()
  } catch {
    return null
  }
}

/** 取频道层级的主页链接：RSS 用 `<link>…</link>`，Atom 用 `<link rel="alternate" href>`。 */
function resolveSiteUrl(block: string): string | null {
  const plain = textOf(block, 'link')
  if (plain) return plain
  const links = attrTagAll(block, 'link')
  const alternate = links.find((item) => !item.rel || item.rel.toLowerCase() === 'alternate')
  return alternate?.href ?? null
}

/** 判断 feed 类型。 */
function detectKind(xml: string): ParsedFeed['kind'] {
  if (/<feed\b/i.test(xml)) return 'atom'
  if (/<rss\b/i.test(xml)) return 'rss'
  if (/<rdf:RDF\b/i.test(xml)) return 'rdf'
  if (/<rss\b/i.test(xml) === false && /<channel\b/i.test(xml)) return 'rss'
  return 'unknown'
}

/**
 * 解析订阅源文本。
 *
 * @param xml 原始响应体（自动剥 BOM）
 * @param baseUrl 用于补全相对链接（一般传请求的 feed 地址）
 */
export function parseFeed(xml: string, baseUrl = ''): ParsedFeed {
  const warnings: string[] = []
  const raw = String(xml ?? '').replace(/^\uFEFF/, '')
  const kind = detectKind(raw)

  if (!raw.trim()) {
    return { kind, title: null, siteUrl: null, description: null, items: [], warnings: ['响应内容为空'] }
  }
  if (kind === 'unknown') {
    warnings.push('无法识别订阅格式（既不是 RSS 也不是 Atom），可能是 HTML 页面')
  }

  // 条目块：Atom 用 <entry>，RSS/RDF 用 <item>
  const itemTags = kind === 'atom' ? ['entry'] : ['item']
  const blocks: string[] = []
  for (const tag of itemTags) {
    const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi')
    let match: RegExpExecArray | null
    while ((match = pattern.exec(raw)) !== null) blocks.push(match[1])
  }

  // 频道元信息：只扫第一个条目之前的部分，避免把条目标题当成频道标题
  const firstItemAt = blocks.length > 0 ? raw.search(/<(item|entry)\b/i) : -1
  const channelPart = firstItemAt >= 0 ? raw.slice(0, firstItemAt) : raw
  const channelTitle = textOf(channelPart, 'title')
  const channelDescription = textOf(channelPart, ['description', 'subtitle'])
  const rawSiteUrl = resolveSiteUrl(channelPart)
  const siteUrl = absolutize(rawSiteUrl, baseUrl)

  if (blocks.length === 0) warnings.push('没有解析出任何条目（可能是空 feed 或格式不兼容）')

  const items: ParsedFeedItem[] = []
  for (const block of blocks) {
    // Atom: <id> 是指标；RSS: <guid>（可能是 isPermaLink="false"）
    const guid = textOf(block, ['guid', 'id'])
    const link = absolutize(
      textOf(block, 'link') ?? attrTag(block, 'link', 'href'),
      baseUrl,
    )
    const title = textOf(block, 'title') ?? ''
    const publishedRaw = textOf(block, ['pubDate', 'published', 'updated', 'dc:date', 'date'])
    const publishedAt = parseFeedDate(publishedRaw)
    if (publishedRaw && !publishedAt) warnings.push(`条目「${title || '(无标题)'}」的时间无法解析：${publishedRaw}`)

    const summaryRaw = textOf(block, ['description', 'summary', 'dc:description'])
    const contentRaw = textOf(block, ['content:encoded', 'content'])
    const author =
      textOf(block, ['dc:creator', 'author'])
      ?? attrTag(block, 'author', 'name')

    items.push({
      guid: guid ?? null,
      link,
      title: title || '(无标题)',
      publishedAt,
      summary: toSummary(summaryRaw ?? contentRaw),
      content: contentRaw ?? null,
      author: author ?? null,
    })
  }

  return {
    kind,
    title: channelTitle,
    siteUrl,
    description: toSummary(channelDescription),
    items,
    warnings,
  }
}
