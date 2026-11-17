/**
 * P1-8 上半：窄屏列表降级 + `RecordCard` 紧凑变体。
 *
 * 分两层锁：
 * 1. **密度判定**（`lib/shell-layout.ts` 的纯函数）——边界 599/600、非法输入、
 *    媒体查询与纯函数的一致性，这是「375 不溢出、宽屏不降级」的根；
 * 2. **接线**（`RecordCard.tsx` / `RecordsPage.tsx`）——紧凑分支里不能有封面、
 *    行高不能低于触摸下限、宽屏的 `xs/sm/md/lg` 与 `card-lift` 不能被顺手改掉。
 *
 * 不在这里验的：真实的 `main.scrollWidth === clientWidth`（要浏览器排版）——
 * 那是 `qa/p1-8-narrow-probe.cjs` 的活。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  COMPACT_LIST_MAX_WIDTH,
  COMPACT_ROW_MIN_HEIGHT,
  compactListMediaQuery,
  resolveRecordListDensity,
  resolveRecordListDensityFromMatch,
} from '../web/src/lib/shell-layout'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8')
}

/* ------------------------- 1. 密度判定的边界 ------------------------- */

test('resolveRecordListDensity：手机三档（375 / 390 / 599）都是紧凑列表', () => {
  for (const w of [320, 360, 375, 390, 414, 599]) {
    assert.equal(resolveRecordListDensity(w), 'compact', `${w}px 应该是 compact`)
  }
})

test('resolveRecordListDensity：600 起回到多列卡片（含 768 平板与 1280 桌面）', () => {
  for (const w of [600, 601, 768, 900, 1280, 1920]) {
    assert.equal(resolveRecordListDensity(w), 'grid', `${w}px 应该是 grid`)
  }
})

test('resolveRecordListDensity：非法输入回落 compact（宁可单列也不要撑破版心）', () => {
  for (const w of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1]) {
    assert.equal(resolveRecordListDensity(w), 'compact')
  }
})

test('COMPACT_LIST_MAX_WIDTH = 600（分界值是常量，不在页面里写死数字）', () => {
  assert.equal(COMPACT_LIST_MAX_WIDTH, 600)
})

test('compactListMediaQuery：默认生成 (max-width: 599.95px)', () => {
  assert.equal(compactListMediaQuery(), '(max-width: 599.95px)')
})

test('compactListMediaQuery：自定义分界值按 -0.05 生成；非法值回落默认', () => {
  assert.equal(compactListMediaQuery(480), '(max-width: 479.95px)')
  assert.equal(compactListMediaQuery(Number.NaN), '(max-width: 599.95px)')
  assert.equal(compactListMediaQuery(0), '(max-width: 599.95px)')
})

test('媒体查询与纯函数在 320~1400 每一个整数宽度上判定一致', () => {
  const q = compactListMediaQuery()
  const max = Number(q.replace(/[^0-9.]/g, '')) // 599.95
  for (let w = 320; w <= 1400; w += 1) {
    const byQuery = w <= max
    const byFn = resolveRecordListDensity(w) === 'compact'
    assert.equal(byQuery, byFn, `${w}px 处媒体查询与纯函数打架`)
  }
})

test('resolveRecordListDensityFromMatch：布尔 → 密度的唯一入口', () => {
  assert.equal(resolveRecordListDensityFromMatch(true), 'compact')
  assert.equal(resolveRecordListDensityFromMatch(false), 'grid')
})

test('COMPACT_ROW_MIN_HEIGHT 不低于 44（触摸目标下限）', () => {
  assert.ok(COMPACT_ROW_MIN_HEIGHT >= 44, `行高 ${COMPACT_ROW_MIN_HEIGHT} 小于 44，点不中`)
})

/* ------------------------- 2. RecordCard 紧凑变体 ------------------------- */

const cardSrc = read('web/src/components/RecordCard.tsx')

/**
 * 分支定位用 `data-density` 标记，不用 `className="card-lift"`：
 * 类名会随视觉改版叠加（现已变成 `geo-frame card-lift`），
 * 而 `data-density` 是探针与用例共用的稳定契约。
 */
const COMPACT_START = cardSrc.indexOf('if (compact) {')
const GRID_START = cardSrc.indexOf('data-density="grid"')
const compactBranch = cardSrc.slice(COMPACT_START, GRID_START)
const gridBranch = cardSrc.slice(GRID_START)

test('RecordCard 暴露 compact 可选属性且默认 false（宽屏调用方无需改动）', () => {
  assert.match(cardSrc, /compact\?:\s*boolean/)
  assert.match(cardSrc, /compact\s*=\s*false\s*\}/)
})

test('RecordCard 两种密度用 data-density 标出（探针据此判定走了哪条分支）', () => {
  assert.match(cardSrc, /data-density="compact"/)
  assert.match(cardSrc, /data-density="grid"/)
})

test('紧凑分支不渲染封面与摘要（降级的是信息量，不是点击面积）', () => {
  assert.ok(COMPACT_START > 0, '找不到紧凑分支')
  assert.ok(GRID_START > COMPACT_START, '找不到宽屏分支')
  assert.ok(!/<LinkCover/.test(compactBranch), '紧凑行里不该有封面')
  assert.ok(!/record\.summary/.test(compactBranch), '紧凑行里不该有摘要')
  // 宽屏分支必须仍在同一个分支函数里（防止「宽屏被一起降级」）
  assert.match(gridBranch, /<LinkCover record=\{record\} \/>/)
})

test('紧凑分支行高走常量 COMPACT_ROW_MIN_HEIGHT（不是散落的 56）', () => {
  assert.match(compactBranch, /minHeight:\s*COMPACT_ROW_MIN_HEIGHT/)
  assert.ok(!/minHeight:\s*\d+/.test(compactBranch), '行高不该写死数字')
})

test('紧凑行标题与副行都单行省略（否则 375 档会把行撑成两行）', () => {
  // 标题：Typography noWrap
  assert.match(compactBranch, /variant="body2" fontWeight=\{600\} noWrap/)
  // 副行（时间 · 分类）：由外层 flex 行 + 文本 ellipsis 收束，机制可以换、不换行的结论不能变
  assert.match(compactBranch, /textOverflow:\s*'ellipsis'/, '副行必须 ellipsis 截断')
  assert.match(compactBranch, /whiteSpace:\s*'nowrap'/, '副行必须 nowrap，不能换行')
})

test('紧凑行给出「状态」：已完成 chip + 循环图标', () => {
  assert.match(compactBranch, /label="已完成"/)
  assert.match(compactBranch, /RepeatIcon/)
})

test('宽屏分支保留封面、摘要、card-lift 与优先级 chip（信息密度不降）', () => {
  assert.match(cardSrc, /className="[^"]*\bcard-lift\b[^"]*"/, '宽屏悬停提升类名丢了')
  assert.match(gridBranch, /<LinkCover record=\{record\} \/>/)
  assert.match(gridBranch, /record\.summary/)
  assert.match(gridBranch, /record\.tags\.slice\(0, 3\)/)
  assert.match(gridBranch, /record\.priority/)
})

/* ------------------------- 3. RecordsPage 接线 ------------------------- */

const pageSrc = read('web/src/pages/RecordsPage.tsx')

test('RecordsPage 走纯函数判定密度，不自己写媒体查询字符串', () => {
  assert.match(pageSrc, /resolveRecordListDensityFromMatch/)
  assert.match(pageSrc, /useMediaQuery\(compactListMediaQuery\(\)\)/)
  assert.ok(!/max-width:\s*\d+/.test(pageSrc), '页面里不该出现媒体查询字面量')
  assert.ok(!/\b600\b/.test(pageSrc), '页面里不该出现分界值 600（应取常量）')
})

test('RecordsPage 紧凑模式传 compact、宽屏模式不传（保持原版面）', () => {
  assert.match(pageSrc, /<RecordCard record=\{r\} compact onClick=/)
  assert.match(pageSrc, /<RecordCard record=\{r\} onClick=\{\(\) => setDetail\(r\)\} \/>/)
})

test('宽屏栅格档位未被改动（xs12 / sm6 / md4 / lg3）', () => {
  // 只锁四档档位值，不锁同行其它属性（`key` / `className` 会随列表动画改版增删）
  assert.match(pageSrc, /<Grid item xs=\{12\} sm=\{6\} md=\{4\} lg=\{3\}[\s>]/)
})

test('窄屏分页器收紧：siblingCount=0 + small，避免 20 页时分页条比版心宽', () => {
  assert.match(pageSrc, /siblingCount=\{density === 'compact' \? 0 : 1\}/)
  assert.match(pageSrc, /size=\{density === 'compact' \? 'small' : 'medium'\}/)
})
