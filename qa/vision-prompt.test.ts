/**
 * 机器视觉 · 提示词构造单元测试
 * ============================================================================
 * 断言的是一份"契约"，不是措辞：
 * - 三段式字段名必须出现（understanding / localization / solution）；
 * - 场景清单必须真的随场景变化（否则等于没做分场景）；
 * - 有代码 / 无代码两种情况下，定位规则必须不同；
 * - 图片消息必须排在文字之后（视觉模型对末尾图像注意力最高）；
 * - 代码必须截断，不能把整仓代码塞进去挤掉图片 token。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildJsonRepairPrompt, buildSystemPrompt, buildUserContent, sceneChecklistText } from '../web/src/lib/vision/prompt'
import type { SceneKind } from '../web/src/lib/vision/types'

test('buildSystemPrompt：包含三段式字段与输出 schema', () => {
  const p = buildSystemPrompt('code', false)
  for (const key of ['understanding', 'localization', 'solution', 'blocks', 'coverage', 'needMoreInfo']) {
    assert.ok(p.includes(key), `缺少字段 ${key}`)
  }
  assert.ok(p.includes('只输出一个 JSON 对象'))
})

test('buildSystemPrompt：有代码时强调"落到真实文件/行/符号"', () => {
  const withCode = buildSystemPrompt('code', true)
  assert.ok(withCode.includes('用户同时提供了代码'))
  assert.ok(withCode.includes('缩进'))
})

test('buildSystemPrompt：无代码时要求 file/line/symbol 填 null', () => {
  const noCode = buildSystemPrompt('code', false)
  assert.ok(noCode.includes('一律填 null'))
  assert.equal(noCode.includes('用户同时提供了代码'), false)
})

test('buildSystemPrompt：场景清单确实随场景变化', () => {
  const code = buildSystemPrompt('code', false)
  const table = buildSystemPrompt('table', false)
  const chart = buildSystemPrompt('chart', false)
  assert.notEqual(code, table)
  assert.ok(table.includes('行列数') && table.includes('合并单元格'))
  assert.ok(chart.includes('横纵轴') || chart.includes('坐标轴') || chart.includes('系列'))
  assert.ok(code.includes('缩进'))
})

test('sceneChecklistText：11 个场景都有非空清单且互不相同', () => {
  const scenes: SceneKind[] = ['code', 'error', 'ui', 'chat', 'table', 'chart', 'document', 'diagram', 'photo', 'handwriting', 'unknown']
  const texts = scenes.map((s) => sceneChecklistText(s))
  texts.forEach((t, i) => assert.ok(t.length > 30, `${scenes[i]} 清单太短`))
  assert.equal(new Set(texts).size, scenes.length, '清单不能重复')
})

test('buildUserContent：文字在前、图片在后，且图片数量一致', () => {
  const imgs = [
    { label: '图1', width: 1600, height: 900, scene: 'code' as SceneKind, issues: ['blurry'], dataUrl: 'data:image/png;base64,AAA' },
    { label: '图2', width: 1200, height: 800, scene: 'error' as SceneKind, issues: [], dataUrl: 'data:image/png;base64,BBB' },
  ]
  const content = buildUserContent(imgs, 'const a = 1', '登录页报错', '为什么 401？')
  const types = content.map((c) => c.type)
  const firstImage = types.indexOf('image_url')
  const lastText = types.lastIndexOf('text')
  assert.equal(types.filter((t) => t === 'image_url').length, 2)
  assert.ok(firstImage > 0)
  assert.ok(lastText > firstImage - 1, '图片之后不应再插大段文字（除标签）')
  // 元信息里要带上尺寸与质量问题，模型才知道"为什么看不清"
  const metaText = String((content[0] as { text: string }).text)
  assert.ok(metaText.includes('1600×900'))
  assert.ok(metaText.includes('blurry'))
})

test('buildUserContent：代码超长被截断到 12000 字符', () => {
  const imgs = [{ label: '图1', width: 100, height: 100, scene: 'code' as SceneKind, issues: [], dataUrl: 'data:image/png;base64,AAA' }]
  const longCode = 'x'.repeat(30_000)
  const content = buildUserContent(imgs, longCode)
  const codePart = content.find((c) => c.type === 'text' && String((c as { text: string }).text).includes('【用户代码】'))
  assert.ok(codePart, '应包含代码段')
  const text = String((codePart as { text: string }).text)
  assert.ok(text.length < 30_000, '必须截断')
  assert.ok(text.length <= 12_000 + 20, `截断后长度 ${text.length}`)
})

test('buildUserContent：空代码/空上下文不产生空段落', () => {
  const imgs = [{ label: '图1', width: 100, height: 100, scene: 'ui' as SceneKind, issues: [], dataUrl: 'data:image/png;base64,AAA' }]
  const content = buildUserContent(imgs, '', '', '')
  // 三段文字：图片元信息、分析指令、每张图前的「图1：」标签；没有空段落
  const texts = content.filter((c) => c.type === 'text').map((c) => String((c as { text: string }).text))
  assert.equal(texts.length, 3)
  assert.ok(texts.every((t) => t.trim().length > 0), '不应出现空段落')
})

test('buildJsonRepairPrompt：包含原文并限定只改格式', () => {
  const p = buildJsonRepairPrompt('这是模型随口说的一段话')
  assert.ok(p.includes('这是模型随口说的一段话'))
  assert.ok(p.includes('不要新增或删除事实'))
  assert.ok(p.length < 6500, '原文要被截断，避免二次超长')
})
