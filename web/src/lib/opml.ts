/**
 * OPML 解析 / 导出（纯函数，浏览器 / Node 同构，零依赖）。
 *
 * v2.14 P0-3 上半只做解析（`parseOpml`）；下半补 `buildOpml` 供"导出订阅"用。
 * 两者必须往返兼容（`parseOpml(buildOpml(x))` 的 title / url 一致），
 * 否则用户导出的文件在自家产品里都读不回来。
 *
 * 为什么不用 `DOMParser`：QA 用例跑在 Node（`node:test`）里，没有 DOM；引入
 * `linkedom` / `fast-xml-parser` 只为一个「读 `<outline>` 属性」的需求不划算，
 * 且会进首屏包。OPML 的结构极简（outline 套 outline，叶子带 `xmlUrl`），
 * 这里用**容错扫描**而不是严格 XML 解析，正是要它在半截坏文件上也能干活。
 *
 * 容错口径（对应 P0-3 的「一条坏 URL 不能拖垮整批」）：
 * - 单条 outline 的地址不合法 → 进 `skipped` 并带**可读原因**，其余照常导入；
 * - 标签不平衡 / 缺 `</outline>` → 尽力还原层级，不抛错；
 * - `feed://` 前缀（部分阅读器导出）自动改写成 `https://`；
 * - 文件夹（无 `xmlUrl` 但有子 outline）不计数，其标题作为子项的 `category`。
 */

/** 一条可导入的订阅源。 */
export interface OpmlFeed {
  /** 显示标题（`text` 优先，回落 `title`，再回落 URL 主机名）。 */
  title: string
  /** 规范化后的订阅地址。 */
  url: string
  /** 站点主页（`htmlUrl`，无则 null）。 */
  htmlUrl: string | null
  /** 所属文件夹标题（顶层为 null）。 */
  category: string | null
}

/** 被跳过的条目（带可读原因，直接展示给用户）。 */
export interface OpmlSkip {
  title: string
  url: string
  reason: string
}

/** 解析结果。 */
export interface OpmlParseResult {
  /** `<head><title>`，无则 null。 */
  title: string | null
  feeds: OpmlFeed[]
  skipped: OpmlSkip[]
  /** 参与判定的叶子 outline 数（= feeds.length + skipped.length）。 */
  outlineCount: number
  /** 非致命提示（缺 body / 没有 outline / 标签不平衡……）。 */
  warnings: string[]
}

/** 单条 outline 的属性表（键统一小写）。 */
type OutlineAttrs = Record<string, string>

/** XML 实体解码（只需覆盖 OPML 里会出现的几个 + 数字实体）。 */
export function decodeXmlEntities(input: string): string {
  const text = String(input ?? '')
  if (!text.includes('&')) return text
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    const key = body.toLowerCase()
    if (key.startsWith('#x')) {
      const code = Number.parseInt(body.slice(2), 16)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    if (key.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole
    }
    switch (key) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      case 'nbsp':
        return ' '
      default:
        return whole
    }
  })
}

/** 解析一个标签内部的属性串（双引号 / 单引号 / 无引号都能读）。 */
function parseAttributes(raw: string): OutlineAttrs {
  const attrs: OutlineAttrs = {}
  const pattern = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(raw)) !== null) {
    const name = match[1].toLowerCase()
    const value = match[2] ?? match[3] ?? match[4] ?? ''
    attrs[name] = decodeXmlEntities(value)
  }
  return attrs
}

/** 从 URL 里取主机名（去掉 `www.`），非法 URL 返回空串。 */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

/** 地址校验结果。 */
export type FeedUrlResult = { ok: true; url: string } | { ok: false; reason: string }

/**
 * 校验并规范化订阅地址。
 *
 * 规则与 `linkPreviewService.isHttpUrl` 同源（只放行 http/https、必须能构造出 host），
 * 额外做两件事：`feed://` → `https://`、去掉首尾空白与零宽字符。
 */
export function normalizeFeedUrl(raw: string): FeedUrlResult {
  let input = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\ufeff]/g, '')
    .trim()
  if (!input) return { ok: false, reason: '订阅地址为空' }

  // feed://example.com/rss 是旧阅读器的写法，等价于 https
  if (/^feed:\/\//i.test(input)) input = input.replace(/^feed:\/\//i, 'https://')
  // feed:https://... 这种写法也见过
  if (/^feed:/i.test(input)) input = input.replace(/^feed:/i, '')

  if (!/^https?:\/\//i.test(input)) {
    return { ok: false, reason: '订阅地址不是 http/https 链接' }
  }

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return { ok: false, reason: '订阅地址格式不正确' }
  }

  if (!url.hostname) return { ok: false, reason: '订阅地址缺少域名' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: '订阅地址不是 http/https 链接' }
  }

  return { ok: true, url: url.toString() }
}

/** 扫描到的原始 outline（未校验）。 */
interface RawOutline {
  attrs: OutlineAttrs
  category: string | null
}

/**
 * 扫描全部 `<outline>` 标签，维护「文件夹标题栈」得到 category。
 *
 * 只认 outline：其它标签（head / body / opml / 自定义）一律跳过，不参与层级。
 */
function scanOutlines(xml: string): { outlines: RawOutline[]; warnings: string[] } {
  const warnings: string[] = []
  const outlines: RawOutline[] = []
  const stack: string[] = []
  let unbalanced = false

  const pattern = /<(\/)?\s*outline\b([^>]*)>/gi
  let match: RegExpExecArray | null

  while ((match = pattern.exec(xml)) !== null) {
    const closing = Boolean(match[1])
    const rawAttrs = match[2] ?? ''
    const selfClosing = /\/\s*$/.test(rawAttrs)
    const attrs = parseAttributes(selfClosing ? rawAttrs.replace(/\/\s*$/, '') : rawAttrs)

    if (closing) {
      if (stack.length > 0) stack.pop()
      else unbalanced = true
      continue
    }

    const category = stack.length > 0 ? stack[stack.length - 1] : null
    outlines.push({ attrs, category })

    // 有 xmlUrl 的是叶子；没有的是文件夹（把标题压栈，供子项取 category）
    if (!attrs.xmlurl && !selfClosing) {
      const title = attrs.text || attrs.title || ''
      if (title) stack.push(title)
    }
  }

  if (unbalanced) warnings.push('OPML 里有多余的 </outline>，已按尽力还原处理')
  if (stack.length > 0) warnings.push('OPML 里存在未闭合的 <outline>，已按尽力还原处理')
  return { outlines, warnings }
}

/**
 * 解析 OPML 文本。
 *
 * @param xml 原始文件内容（自动剥 UTF-8 BOM）
 */
export function parseOpml(xml: string): OpmlParseResult {
  const warnings: string[] = []
  const raw = String(xml ?? '').replace(/^\uFEFF/, '')

  if (!raw.trim()) {
    return { title: null, feeds: [], skipped: [], outlineCount: 0, warnings: ['文件内容为空'] }
  }
  if (!/<opml\b/i.test(raw)) {
    // 不直接报错：有些导出工具省了 <opml> 外壳，只给 <body>
    warnings.push('文件里没有 <opml> 根标签，按兼容模式解析')
  }
  if (!/<body\b/i.test(raw)) warnings.push('文件里没有 <body> 标签，可能在 head 里也有 outline')

  // 注释整段剥掉，避免注释里的 outline 被当成真订阅
  const withoutComments = raw.replace(/<!--[\s\S]*?-->/g, '')

  const headTitle = /<head\b[^>]*>[\s\S]*?<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(withoutComments)
  const title = headTitle ? decodeXmlEntities(headTitle[1]).trim() || null : null

  const { outlines, warnings: scanWarnings } = scanOutlines(withoutComments)
  warnings.push(...scanWarnings)

  const feeds: OpmlFeed[] = []
  const skipped: OpmlSkip[] = []
  const seen = new Map<string, string>() // url → 首次出现的标题（重复项提示用）

  for (const { attrs, category } of outlines) {
    const xmlUrl = attrs.xmlurl ?? ''
    const label = (attrs.text || attrs.title || '').trim()

    // 文件夹：没有 xmlUrl，子项已在扫描时归到它的 category 下
    if (!xmlUrl.trim()) {
      // 既没有 xmlUrl 又没有子项 —— 无法判断是空文件夹还是坏条目，按跳过记录
      const hasChildren = outlines.some((item) => item.category === label && item.attrs.xmlurl)
      if (!label || !hasChildren) {
        skipped.push({ title: label, url: '', reason: '缺少订阅地址（xmlUrl）' })
      }
      continue
    }

    const normalized = normalizeFeedUrl(xmlUrl)
    if (!normalized.ok) {
      skipped.push({ title: label || xmlUrl, url: xmlUrl, reason: normalized.reason })
      continue
    }

    const previous = seen.get(normalized.url)
    if (previous !== undefined) {
      skipped.push({
        title: label || normalized.url,
        url: normalized.url,
        reason: `订阅地址重复（与「${previous || normalized.url}」相同）`,
      })
      continue
    }
    seen.set(normalized.url, label)

    const htmlUrlRaw = (attrs.htmlurl ?? '').trim()
    const htmlChecked = htmlUrlRaw ? normalizeFeedUrl(htmlUrlRaw) : null
    const htmlUrl = htmlChecked && htmlChecked.ok ? htmlChecked.url : null
    if (htmlUrlRaw && !(htmlChecked && htmlChecked.ok)) {
      warnings.push(`「${label || normalized.url}」的 htmlUrl 不是有效链接，已忽略`)
    }

    feeds.push({
      title: label || hostOf(normalized.url) || normalized.url,
      url: normalized.url,
      htmlUrl,
      category,
    })
  }

  if (outlines.length === 0) warnings.push('没有找到任何 <outline> 条目')

  return {
    title,
    feeds,
    skipped,
    outlineCount: feeds.length + skipped.length,
    warnings,
  }
}

/* ============================== 导出（v2.14 P0-3 下半） ============================== */

/** `buildOpml` 选项。 */
export interface BuildOpmlOptions {
  /** `<head><title>`，默认「个人信息管家订阅」。 */
  title?: string
  /** 注入导出时刻（写进 `<dateCreated>`），不传则不写该元素。 */
  now?: Date
}

/** 导出时的默认文档标题。 */
const DEFAULT_OPML_TITLE = '个人信息管家订阅'

/**
 * XML 转义（文本与属性共用一套）。
 *
 * 顺序必须是 `&` 最先：否则把 `<` 转成 `&lt;` 之后，`&` 规则又会把其中的 `&` 再转一次，
 * 得到 `&amp;lt;`（往返解析后变成字面量 `&lt;`，用户看到的就是乱码）。
 *
 * @param input 原文
 */
export function escapeXml(input: string): string {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/** 一条叶子 outline（`type="rss"` + 四个必备属性 + 可选 category）。 */
function leafOutline(feed: OpmlFeed): string {
  const attrs = [
    'type="rss"',
    `text="${escapeXml(feed.title)}"`,
    `title="${escapeXml(feed.title)}"`,
    `xmlUrl="${escapeXml(feed.url)}"`,
  ]
  if (feed.htmlUrl) attrs.push(`htmlUrl="${escapeXml(feed.htmlUrl)}"`)
  if (feed.category) attrs.push(`category="${escapeXml(feed.category)}"`)
  return `    <outline ${attrs.join(' ')} />`
}

/**
 * 生成 OPML 2.0 文本（**必须能被本文件的 `parseOpml` 原样读回**）。
 *
 * 结构：`<?xml?>` + `<opml version="2.0">` + `<head><title>` + `<body>` + `<outline>`。
 * - 有 `category` 的订阅按分类分组（同分类包一层无 `xmlUrl` 的 `<outline>`，
 *   解析层据此把文件夹标题还原成子项的 `category`）；
 * - 无分类的订阅直属 `<body>`；
 * - 空列表也输出合法空文档（`<body></body>`），不返回空串——
 *   拿到空串的调用方会当成"导出失败"，而"没有订阅"是正常状态。
 *
 * 所有文本与属性一律走 `escapeXml`（**不能**反向用 `decodeXmlEntities` 拼），
 * 否则标题里的 `&` / `"` 会直接把文件破坏成非法 XML。
 *
 * @param feeds 订阅列表（`category` 相同即同组）
 * @param options 文档标题 / 导出时刻
 */
export function buildOpml(feeds: OpmlFeed[], options: BuildOpmlOptions = {}): string {
  const list = Array.isArray(feeds) ? feeds : []
  const title = (options.title ?? '').trim() || DEFAULT_OPML_TITLE

  // 分组保持"首次出现顺序"：导出文件的顺序应与界面列表一致，而不是按字典序重排
  const loose: OpmlFeed[] = []
  const groups = new Map<string, OpmlFeed[]>()
  for (const feed of list) {
    if (!feed) continue
    const category = String(feed.category ?? '').trim()
    if (!category) {
      loose.push(feed)
      continue
    }
    const bucket = groups.get(category)
    if (bucket) bucket.push(feed)
    else groups.set(category, [feed])
  }

  const lines: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', '<opml version="2.0">', '  <head>']
  lines.push(`    <title>${escapeXml(title)}</title>`)
  if (options.now instanceof Date && !Number.isNaN(options.now.getTime())) {
    // RFC 822 是 OPML 规范里 dateCreated 的格式（toUTCString 正好产出该格式）
    lines.push(`    <dateCreated>${escapeXml(options.now.toUTCString())}</dateCreated>`)
  }
  lines.push('  </head>', '  <body>')

  for (const feed of loose) lines.push(leafOutline(feed))

  for (const [category, bucket] of groups) {
    lines.push(`    <outline text="${escapeXml(category)}" title="${escapeXml(category)}">`)
    for (const feed of bucket) lines.push(leafOutline(feed))
    lines.push('    </outline>')
  }

  lines.push('  </body>', '</opml>')
  return lines.join('\n')
}
