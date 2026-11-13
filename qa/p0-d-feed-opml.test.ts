/**
 * P0-3 上半 · OPML 导入容错单测（`web/src/lib/opml.ts` + `feedService.importOpml`）。
 *
 * 验收口径（§五 11-05）：
 * - **20 条 OPML（故意埋 1 条坏 URL）→ 19 成功 1 跳过，且跳过项有可读原因**；
 * - 一条坏 URL 不能拖垮整批（这条比"能导入"更重要：批次里最脏的那一条决定用户敢不敢用）。
 *
 * 另外钉死几处容易回归的细节：
 * - 文件夹（无 `xmlUrl`）不计数，其标题落成子项 `category`；
 * - `feed://` 前缀自动改写成 `https://`（旧阅读器导出的常见形态）；
 * - 注释里的 `<outline>` 不能被当成真订阅；
 * - UTF-8 BOM / 未闭合标签 / 缺 `<opml>` 外壳都要能读，且给 warning 而不是抛错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeXmlEntities, normalizeFeedUrl, parseOpml } from '../web/src/lib/opml'
import { importOpml } from '../web/src/services/feedService'

/** 造一条叶子 outline。 */
function leaf(index: number, over: { text?: string; xmlUrl?: string; htmlUrl?: string } = {}): string {
  const text = over.text ?? `源 ${index}`
  const xmlUrl = over.xmlUrl ?? `https://feed${index}.example.com/rss.xml`
  const htmlUrl = over.htmlUrl ?? `https://site${index}.example.com/`
  return `    <outline type="rss" text="${text}" title="${text}" xmlUrl="${xmlUrl}" htmlUrl="${htmlUrl}"/>`
}

/** 造一份带两层文件夹的 OPML：技术 10 条 + 设计 10 条（第 20 条是坏地址）。 */
function buildOpml20(): string {
  const tech = Array.from({ length: 10 }, (_, i) => leaf(i + 1)).join('\n')
  const design = [
    ...Array.from({ length: 9 }, (_, i) => leaf(i + 11)),
    // 坏地址：`https://` 后面什么都没有 → 能过「http 前缀」但构造不出 URL
    leaf(20, { text: '坏掉的源', xmlUrl: 'https://' }),
  ].join('\n')

  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>我的订阅</title>
  </head>
  <body>
    <outline text="技术" title="技术">
${tech}
    </outline>
    <outline text="设计" title="设计">
${design}
    </outline>
  </body>
</opml>`
}

test('OPML：20 条埋 1 条坏 URL → 19 成功 1 跳过，跳过项原因可读', () => {
  const result = parseOpml(buildOpml20())

  assert.equal(result.title, '我的订阅')
  assert.equal(result.outlineCount, 20)
  assert.equal(result.feeds.length, 19)
  assert.equal(result.skipped.length, 1)

  const bad = result.skipped[0]
  assert.equal(bad.title, '坏掉的源')
  assert.equal(bad.url, 'https://')
  assert.equal(bad.reason, '订阅地址格式不正确')
  // 原因必须是人话：能直接贴到界面上，而不是错误码
  assert.doesNotMatch(bad.reason, /[A-Z_]{4,}|undefined|null/)
})

test('OPML：文件夹不计数，子项的 category 取最近一层文件夹标题', () => {
  const result = parseOpml(buildOpml20())

  assert.equal(result.feeds.filter((f) => f.category === '技术').length, 10)
  assert.equal(result.feeds.filter((f) => f.category === '设计').length, 9)
  // 文件夹本身不进 feeds（否则会多出两条没有地址的"订阅"）
  assert.ok(result.feeds.every((f) => f.url.startsWith('http')))
})

test('OPML：importOpml 把坏条目算进 skipped 且不拖垮其余 19 条', () => {
  const result = importOpml(buildOpml20())

  assert.deepEqual(result.counts, { outline: 20, accepted: 19, skipped: 1 })
  assert.equal(result.feeds.length, 19)
  assert.equal(result.skipped[0].reason, '订阅地址格式不正确')
  // 19 条每条都有地址、标题、htmlUrl（缺一项界面上就是空白行）
  for (const feed of result.feeds) {
    assert.match(feed.url, /^https:\/\/feed\d+\.example\.com\/rss\.xml$/)
    assert.ok(feed.title.length > 0)
    assert.match(String(feed.htmlUrl), /^https:\/\//)
  }
})

test('OPML：已在订阅列表中的地址记为跳过（原因可读），不静默丢', () => {
  const xml = `<opml version="2.0"><body>
    <outline text="A" xmlUrl="https://a.example.com/rss"/>
    <outline text="B" xmlUrl="https://b.example.com/rss"/>
  </body></opml>`

  const result = importOpml(xml, { existingUrls: ['https://a.example.com/rss?utm_source=x'] })

  assert.equal(result.counts.accepted, 1)
  assert.equal(result.counts.skipped, 1)
  assert.equal(result.skipped[0].title, 'A')
  assert.equal(result.skipped[0].reason, '已在订阅列表中')
  assert.equal(result.feeds[0].url, 'https://b.example.com/rss')
})

test('OPML：文件内重复地址只导一次，第二条记「重复」', () => {
  const xml = `<opml version="2.0"><body>
    <outline text="A" xmlUrl="https://a.example.com/rss"/>
    <outline text="A 副本" xmlUrl="https://a.example.com/rss"/>
  </body></opml>`

  const result = parseOpml(xml)

  assert.equal(result.feeds.length, 1)
  assert.equal(result.skipped.length, 1)
  assert.match(result.skipped[0].reason, /订阅地址重复/)
  assert.match(result.skipped[0].reason, /A/)
})

test('OPML：feed:// 前缀改写为 https，页面地址不是 http 的 htmlUrl 被忽略并给 warning', () => {
  const xml = `<opml version="2.0"><body>
    <outline text="旧阅读器" xmlUrl="feed://old.example.com/rss" htmlUrl="ftp://old.example.com"/>
  </body></opml>`

  const result = parseOpml(xml)

  assert.equal(result.feeds.length, 1)
  assert.equal(result.feeds[0].url, 'https://old.example.com/rss')
  assert.equal(result.feeds[0].htmlUrl, null)
  assert.ok(result.warnings.some((w) => w.includes('htmlUrl')))
})

test('OPML：注释里的 outline 不算订阅，BOM 不影响解析', () => {
  const xml = `\uFEFF<opml version="2.0"><body>
    <!-- <outline text="注释里的" xmlUrl="https://commented.example.com/rss"/> -->
    <outline text="真的" xmlUrl="https://real.example.com/rss"/>
  </body></opml>`

  const result = parseOpml(xml)

  assert.equal(result.feeds.length, 1)
  assert.equal(result.feeds[0].title, '真的')
})

test('OPML：缺 xmlUrl 且没有子项的空条目记跳过（原因指向缺字段）', () => {
  const xml = `<opml version="2.0"><body>
    <outline text="空文件夹"/>
    <outline text="正常" xmlUrl="https://ok.example.com/rss"/>
  </body></opml>`

  const result = parseOpml(xml)

  assert.equal(result.feeds.length, 1)
  assert.equal(result.skipped.length, 1)
  assert.equal(result.skipped[0].reason, '缺少订阅地址（xmlUrl）')
})

test('OPML：实体解码 + 单引号属性 + 未闭合的文件夹标签都能读', () => {
  const xml = `<opml version='2.0'><body>
    <outline text='文件夹'>
      <outline text='A &amp; B' xmlUrl='https://ab.example.com/rss'/>
      <outline text='C' xmlUrl='https://c.example.com/rss'/>
`

  const result = parseOpml(xml)

  assert.equal(result.feeds.length, 2)
  assert.equal(result.feeds[0].title, 'A & B')
  assert.ok(result.warnings.some((w) => w.includes('未闭合')))
})

test('OPML：空文件 / 只有 head 的坏文件不抛错，给可读提示', () => {
  const empty = parseOpml('')
  assert.equal(empty.feeds.length, 0)
  assert.deepEqual(empty.warnings, ['文件内容为空'])

  const noOutline = parseOpml('<opml version="2.0"><head><title>x</title></head><body></body></opml>')
  assert.equal(noOutline.feeds.length, 0)
  assert.ok(noOutline.warnings.some((w) => w.includes('没有找到任何')))
})

test('OPML：normalizeFeedUrl 拒绝非 http 协议与缺域名，接受大小写与首尾空白', () => {
  assert.deepEqual(normalizeFeedUrl('   '), { ok: false, reason: '订阅地址为空' })
  assert.deepEqual(normalizeFeedUrl('ftp://a.example.com/rss'), { ok: false, reason: '订阅地址不是 http/https 链接' })
  assert.deepEqual(normalizeFeedUrl('https://'), { ok: false, reason: '订阅地址格式不正确' })

  const ok = normalizeFeedUrl('  HTTPS://A.example.com/RSS  ')
  assert.equal(ok.ok, true)
  assert.equal(ok.ok && ok.url, 'https://a.example.com/RSS')
})

test('OPML：decodeXmlEntities 覆盖数字实体与未知实体的原样保留', () => {
  assert.equal(decodeXmlEntities('a&amp;b&lt;c&gt;d&quot;e&apos;f'), 'a&b<c>d"e\'f')
  assert.equal(decodeXmlEntities('&#65;&#x4e2d;'), 'A中')
  assert.equal(decodeXmlEntities('&unknown;'), '&unknown;')
})
