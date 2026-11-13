/**
 * web/src/lib/ui-scheme.ts 单元测试（v2.13.2 UI-1 界面方案内核）。
 *
 * 这层是被三个方案共用的"事实来源"：谁改坏了归一化或能力矩阵，
 * 表现是"切方案行为不一致"或"偏好丢失"，都不是编译期能发现的。
 * 所以这里把**默认值、别名、脏数据、能力位互斥、变化摘要文案**全部钉死。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_UI_SCHEME,
  UI_SCHEME_META,
  UI_SCHEME_ORDER,
  getUiSchemeMeta,
  getUiSchemeName,
  isUiScheme,
  needsSchemeSwitchHint,
  normalizeUiScheme,
  resolveUiSchemeFeatures,
  summarizeUiSchemeChange,
} from '../web/src/lib/ui-scheme'

test('默认方案是 silent（不动布局、不动交互、不动入口位置）', () => {
  assert.equal(DEFAULT_UI_SCHEME, 'silent')
})

test('三方案顺序固定为 静默 / 分区 / 流畅', () => {
  assert.deepEqual([...UI_SCHEME_ORDER], ['silent', 'zoned', 'fluid'])
})

test('只有 silent 被标记为推荐（出厂默认）', () => {
  const recommended = UI_SCHEME_ORDER.filter((id) => getUiSchemeMeta(id).recommended)
  assert.deepEqual(recommended, ['silent'])
})

test('每个方案都有完整元信息，且维度与影响面自洽', () => {
  for (const id of UI_SCHEME_ORDER) {
    const meta = getUiSchemeMeta(id)
    assert.equal(meta.id, id)
    assert.ok(meta.name.length > 0, `${id} 缺展示名`)
    assert.ok(meta.tagline.length > 0, `${id} 缺一句话定位`)
    assert.ok(meta.changes.length >= 4, `${id} 改动要点应不少于 4 条`)
    assert.ok(meta.noticeable.length > 0, `${id} 缺"切换后会发生什么"提示`)
    // 维度与影响面必须一致，否则设置页会显示"影响：视觉 + 布局"但维度写"视觉"
    const expectedImpact =
      meta.dimension === '视觉' ? '仅视觉' : meta.dimension === '布局' ? '视觉 + 布局' : '视觉 + 交互'
    assert.equal(meta.impact, expectedImpact, `${id} 维度与影响面不一致`)
  }
})

test('normalizeUiScheme：合法值原样返回', () => {
  for (const id of UI_SCHEME_ORDER) {
    assert.equal(normalizeUiScheme(id), id)
  }
})

test('normalizeUiScheme：脏数据一律回落默认值，不抛错', () => {
  const dirty: unknown[] = [undefined, null, '', '   ', 0, 1, {}, [], true, 'unknown-scheme', '静默化']
  for (const raw of dirty) {
    assert.equal(normalizeUiScheme(raw), DEFAULT_UI_SCHEME, `脏数据 ${String(raw)} 应回落默认`)
  }
})

test('normalizeUiScheme：大小写与首尾空格容错', () => {
  assert.equal(normalizeUiScheme(' SILENT '), 'silent')
  assert.equal(normalizeUiScheme('Zoned'), 'zoned')
  assert.equal(normalizeUiScheme('FLUID'), 'fluid')
})

test('normalizeUiScheme：历史别名映射到对应方案（升级不重置用户选择）', () => {
  assert.equal(normalizeUiScheme('a'), 'silent')
  assert.equal(normalizeUiScheme('minimal'), 'silent')
  assert.equal(normalizeUiScheme('b'), 'zoned')
  assert.equal(normalizeUiScheme('bento'), 'zoned')
  assert.equal(normalizeUiScheme('c'), 'fluid')
  assert.equal(normalizeUiScheme('smooth'), 'fluid')
})

test('isUiScheme：只认三个合法 id', () => {
  assert.equal(isUiScheme('silent'), true)
  assert.equal(isUiScheme('zoned'), true)
  assert.equal(isUiScheme('fluid'), true)
  assert.equal(isUiScheme('a'), false)
  assert.equal(isUiScheme(''), false)
  assert.equal(isUiScheme(undefined), false)
  assert.equal(isUiScheme(1), false)
})

test('能力位：三方案都启用收敛令牌（切方案时视觉基调不变）', () => {
  for (const id of UI_SCHEME_ORDER) {
    assert.equal(resolveUiSchemeFeatures(id).tokenLayer, true, `${id} 应共享令牌层`)
  }
})

test('能力位：zoned 只加布局能力，不加交互能力', () => {
  const f = resolveUiSchemeFeatures('zoned')
  assert.equal(f.zonedLayout, true)
  assert.equal(f.headerBand, true)
  assert.equal(f.slimTopBar, true)
  assert.equal(f.commandPalette, false)
  assert.equal(f.tieredMotion, false)
  assert.equal(f.skeletons, false)
  assert.equal(f.viewTransitions, false)
  assert.equal(f.optimisticToggle, false)
})

test('能力位：fluid 只加交互能力，不改布局', () => {
  const f = resolveUiSchemeFeatures('fluid')
  assert.equal(f.commandPalette, true)
  assert.equal(f.tieredMotion, true)
  assert.equal(f.skeletons, true)
  assert.equal(f.viewTransitions, true)
  assert.equal(f.optimisticToggle, true)
  assert.equal(f.zonedLayout, false)
  assert.equal(f.headerBand, false)
  assert.equal(f.slimTopBar, false)
})

test('能力位：silent 不加任何增量能力', () => {
  const f = resolveUiSchemeFeatures('silent')
  assert.equal(f.zonedLayout, false)
  assert.equal(f.headerBand, false)
  assert.equal(f.slimTopBar, false)
  assert.equal(f.commandPalette, false)
  assert.equal(f.tieredMotion, false)
  assert.equal(f.skeletons, false)
  assert.equal(f.viewTransitions, false)
  assert.equal(f.optimisticToggle, false)
})

test('resolveUiSchemeFeatures 返回副本，外部改动不会污染矩阵', () => {
  const a = resolveUiSchemeFeatures('zoned')
  a.zonedLayout = false
  assert.equal(resolveUiSchemeFeatures('zoned').zonedLayout, true)
})

test('变化摘要：静默 → 分区 只算布局变化', () => {
  const s = summarizeUiSchemeChange('silent', 'zoned')
  assert.equal(s.layoutChanged, true)
  assert.equal(s.interactionChanged, false)
  assert.equal(s.visualChanged, false)
  assert.ok(s.notes.some((n) => n.includes('收窄')), '应提示容器宽度变化')
})

test('变化摘要：静默 → 流畅 只算交互变化', () => {
  const s = summarizeUiSchemeChange('silent', 'fluid')
  assert.equal(s.layoutChanged, false)
  assert.equal(s.interactionChanged, true)
  assert.ok(s.notes.some((n) => n.includes('Ctrl')), '应提示命令面板')
})

test('变化摘要：分区 → 流畅 同时提示"按钮回到顶栏"与命令面板', () => {
  const s = summarizeUiSchemeChange('zoned', 'fluid')
  assert.equal(s.layoutChanged, true)
  assert.equal(s.interactionChanged, true)
  assert.ok(s.notes.some((n) => n.includes('回到顶栏')))
})

test('变化摘要：同方案切换不产生任何"会变"的提示', () => {
  for (const id of UI_SCHEME_ORDER) {
    const s = summarizeUiSchemeChange(id, id)
    assert.equal(s.layoutChanged, false)
    assert.equal(s.interactionChanged, false)
    assert.equal(s.notes.length, 1)
    assert.ok(s.notes[0].includes('保持一致'))
  }
})

test('变化摘要：notes 最多 3 条（避免提示条变成一篇说明）', () => {
  for (const from of UI_SCHEME_ORDER) {
    for (const to of UI_SCHEME_ORDER) {
      assert.ok(summarizeUiSchemeChange(from, to).notes.length <= 3)
    }
  }
})

test('needsSchemeSwitchHint：只有跨布局维度才需要额外说明', () => {
  assert.equal(needsSchemeSwitchHint('silent', 'zoned'), true)
  assert.equal(needsSchemeSwitchHint('zoned', 'silent'), true)
  assert.equal(needsSchemeSwitchHint('silent', 'fluid'), false)
  assert.equal(needsSchemeSwitchHint('fluid', 'silent'), false)
  assert.equal(needsSchemeSwitchHint('silent', 'silent'), false)
})

test('getUiSchemeName：未知值也能显示（UI 不留空白）', () => {
  assert.equal(getUiSchemeName('zoned'), UI_SCHEME_META.zoned.name)
  // 运行时脏值（类型上不允许，但存储/URL 可能传进来）
  assert.equal(getUiSchemeName('nope' as never), UI_SCHEME_META[DEFAULT_UI_SCHEME].name)
})
