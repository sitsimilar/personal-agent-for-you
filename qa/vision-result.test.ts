/**
 * 机器视觉 · 结果解析与校验单元测试
 * ============================================================================
 * 这一层是「模型胡说八道」的第一道闸门。测试围绕四条不变量：
 * 1. **永不抛错**：任何输入（空串、乱码、半个 JSON）都要有返回值；
 * 2. **字段类型收敛**：字符串数字、换行分隔数组、非法枚举值都要被纠正；
 * 3. **自评与结构一致**：自评 ok 但缺一半字段 → 降为 partial；
 * 4. **降级可展示**：非 JSON 输出保留原文，structured=false。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVisionResult, toMarkdown } from '../web/src/lib/vision/result'

/** 一份"标准答案"的模型输出。 */
const FULL = {
  scene: 'code',
  status: 'ok',
  coverage: { expected: 6, missing: [], unreadable: [] },
  blocks: [
    { type: 'title', order: 0, text: 'TypeError' },
    { type: 'code', order: 1, text: 'const a = undefined.foo' },
  ],
  understanding: {
    summary: '控制台报 TypeError，说明访问了 undefined 的属性。',
    evidence: ['图1 顶部红字：Cannot read properties of undefined', '你给的 app.ts 第 12 行对 user 未判空'],
    transcribed: ['TypeError: Cannot read properties of undefined (reading "name")', 'at getUser (app.ts:12)'],
  },
  localization: { file: 'app.ts', line: 12, symbol: 'getUser', reason: '第 12 行直接读 user.name，未判空', confidence: 0.82 },
  solution: {
    steps: ['在 getUser 里对 user 判空', '返回可选值并让调用方处理'],
    patch: '- return user.name\n+ return user?.name ?? ""',
    verification: ['复现步骤：清空登录态后进入首页', '控制台不再报错'],
    boundaries: ['若 user 一定存在，判空属冗余，可改为断言'],
  },
  needMoreInfo: [],
}

/** 便捷：对象 → JSON 字符串。 */
const j = (o: unknown) => JSON.stringify(o)

test('parseVisionResult：完整 JSON 全字段映射正确', () => {
  const r = parseVisionResult(j(FULL), 'unknown')
  assert.equal(r.structured, true)
  assert.equal(r.scene, 'code')
  assert.equal(r.status, 'ok')
  assert.equal(r.understanding.summary, FULL.understanding.summary)
  assert.deepEqual(r.understanding.transcribed, FULL.understanding.transcribed)
  assert.equal(r.localization.file, 'app.ts')
  assert.equal(r.localization.line, 12)
  assert.equal(r.localization.symbol, 'getUser')
  assert.ok(Math.abs(r.localization.confidence - 0.82) < 1e-9)
  assert.equal(r.solution.steps.length, 2)
  assert.ok(r.solution.patch?.includes('??'))
  assert.equal(r.solution.boundaries.length, 1)
  assert.equal(r.blocks.length, 2)
  assert.equal(r.blocks[0].type, 'title')
  assert.equal(r.coverage.ratio, 0, '无缺失时比率为 0')
})

test('parseVisionResult：带 markdown 围栏也能解析', () => {
  const r = parseVisionResult('```json\n' + j(FULL) + '\n```', 'unknown')
  assert.equal(r.structured, true)
  assert.equal(r.scene, 'code')
})

test('parseVisionResult：纯文本降级为 structured=false 且保留原文', () => {
  const raw = '图中是一段报错，建议检查第 12 行。'
  const r = parseVisionResult(raw, 'error')
  assert.equal(r.structured, false)
  assert.equal(r.status, 'partial')
  assert.equal(r.understanding.summary, raw)
  assert.equal(r.scene, 'error', '无 scene 字段时用前置分类结果')
})

test('parseVisionResult：空输入 → unreadable，不抛错', () => {
  const r = parseVisionResult('', 'code')
  assert.equal(r.status, 'unreadable')
  assert.equal(r.structured, false)
})

test('parseVisionResult：非法 scene 回落到前置判断', () => {
  const r = parseVisionResult(j({ ...FULL, scene: 'hologram' }), 'table')
  assert.equal(r.scene, 'table')
})

test('parseVisionResult：字符串型 confidence 被转成数字并夹取', () => {
  const r = parseVisionResult(j({ ...FULL, localization: { ...FULL.localization, confidence: '0.8' } }))
  assert.equal(r.localization.confidence, 0.8)
  const over = parseVisionResult(j({ ...FULL, localization: { ...FULL.localization, confidence: 3 } }))
  assert.equal(over.localization.confidence, 1, '超过 1 夹到 1')
  const bad = parseVisionResult(j({ ...FULL, localization: { ...FULL.localization, confidence: '高' } }))
  assert.equal(bad.localization.confidence, 0)
})

test('parseVisionResult：数组字段被写成换行字符串时按行拆', () => {
  const r = parseVisionResult(j({ ...FULL, solution: { ...FULL.solution, steps: '1. 判空\n2. 加默认值' } }))
  assert.deepEqual(r.solution.steps, ['判空', '加默认值'])
})

test('parseVisionResult：自评 ok 但缺失过半 → 降为 partial', () => {
  const r = parseVisionResult(
    j({
      ...FULL,
      coverage: { expected: 4, missing: ['列名', '单位', '合计'], unreadable: ['第3行'] },
    }),
  )
  assert.equal(r.status, 'partial')
  assert.equal(r.coverage.ratio, 1)
})

test('parseVisionResult：expected 非法（字符串/负数）时比率为 0 不炸', () => {
  const r = parseVisionResult(j({ ...FULL, coverage: { expected: 'many', missing: ['a'] } }))
  assert.equal(r.coverage.expected, null)
  assert.equal(r.coverage.ratio, 0)
})

test('parseVisionResult：blocks 的 order 缺失时按下标补齐并排序', () => {
  const r = parseVisionResult(
    j({
      ...FULL,
      blocks: [
        { type: 'paragraph', text: '第二段', order: 2 },
        { type: 'title', text: '标题' },
        { type: 'bogus', text: '非法类型' },
      ],
    }),
  )
  assert.equal(r.blocks.length, 3)
  assert.equal(r.blocks[0].type, 'title', 'order 缺省取下标 1，排在最前')
  assert.equal(r.blocks[2].order, 2, '按 order 升序')
  assert.equal(r.blocks[2].type, 'text', '非法类型归为 text')
  assert.ok(r.blocks.every((b) => typeof b.order === 'number'))
})

test('parseVisionResult：needMoreInfo 最多保留 3 条', () => {
  const r = parseVisionResult(j({ ...FULL, needMoreInfo: ['a', 'b', 'c', 'd', 'e'] }))
  assert.equal(r.needMoreInfo.length, 3)
})

test('parseVisionResult：模型完全空壳（只有 {}）→ unreadable', () => {
  const r = parseVisionResult('{}', 'photo')
  assert.equal(r.status, 'unreadable')
})

test('toMarkdown：三段式齐全时输出含定位、补丁、边界', () => {
  const md = toMarkdown(parseVisionResult(j(FULL)))
  assert.ok(md.includes('识别结果'))
  assert.ok(md.includes('图内文本'))
  assert.ok(md.includes('app.ts'))
  assert.ok(md.includes('第 12 行'))
  assert.ok(md.includes('```diff'))
  assert.ok(md.includes('适用边界'))
  assert.ok(md.includes('- [ ]'), '验证项应可勾选')
})

test('toMarkdown：覆盖度差时给出换图提示', () => {
  const md = toMarkdown(
    parseVisionResult(j({ ...FULL, coverage: { expected: 4, missing: ['a', 'b'], unreadable: [] } })),
  )
  assert.ok(md.includes('覆盖度告警'))
})
