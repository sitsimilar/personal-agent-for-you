/**
 * 机器视觉 · 场景分类单元测试
 * ============================================================================
 * 断言两件事：
 * 1. **正确性**：10 个合成样本的类别判断（这只能证明规则实现符合设计）；
 * 2. **可解释性**：打分表形态（降序、分数在 0..1、margin 与 uncertain 的联动）。
 *
 * 明确不做的事：不把「合成样本 10/10」当成「真实世界准确率 100%」。
 * 真实基线要等 P1-15 的 50 张人工标注评测集，报告里分开写。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyScene, dominantScene, isTextLike, SCENE_LABEL, UNCERTAIN_MARGIN } from '../web/src/lib/vision/classify'
import { extractFeatures } from '../web/src/lib/vision/features'
import type { SceneKind } from '../web/src/lib/vision/types'
import * as F from './vision-fixtures'

/** 便捷：图 → 判定。 */
function decide(img: ReturnType<typeof F.codeShot>) {
  return classifyScene(extractFeatures(img).features)
}

/** 一组"应有明确答案"的样本。terminal-red 允许 code|error（见下方说明）。 */
const CASES: Array<{ name: string; img: ReturnType<typeof F.codeShot>; expect: SceneKind[] }> = [
  { name: '深色代码截图', img: F.codeShot(), expect: ['code'] },
  { name: '白底文档', img: F.documentShot(), expect: ['document'] },
  { name: '网格表格', img: F.tableShot(), expect: ['table'] },
  { name: '应用界面', img: F.uiShot(), expect: ['ui'] },
  { name: '柱状图', img: F.chartShot(), expect: ['chart'] },
  { name: '彩色照片', img: F.photoShot(), expect: ['photo'] },
  { name: '报错弹窗', img: F.errorDialog(), expect: ['error'] },
  // 终端里的整屏红字：与代码共用"深底 + 等宽行"的证据，
  // 两个场景的清单都包含"读报错行"，判成任一都可接受。
  { name: '终端红字', img: F.errorShot(), expect: ['code', 'error'] },
  // 日落/暖光照片：整幅偏红橙，旧规则（r-g>40 即算红）下 redRatio≈0.8 → 被判成"满屏报错"
  { name: '暖色渐变照片', img: F.warmGradient(), expect: ['photo'] },
  { name: '模糊代码', img: F.blur(F.codeShot()), expect: ['code'] },
]

for (const c of CASES) {
  test(`classifyScene：${c.name} → ${c.expect.join('|')}`, () => {
    const d = decide(c.img)
    assert.ok(c.expect.includes(d.scene), `实判 ${d.scene}（第二 ${d.scores[1]?.scene}:${d.scores[1]?.score}）`)
    // 打分表必须降序且都在 0..1，否则 UI 展示会乱
    for (let i = 1; i < d.scores.length; i++) assert.ok(d.scores[i - 1].score >= d.scores[i].score)
    for (const s of d.scores) assert.ok(s.score >= 0 && s.score <= 1, `分数越界 ${s.scene}:${s.score}`)
    assert.ok(d.margin >= 0)
  })
}

test('classifyScene：10 个具体类别全部出现在打分表里（unknown 不打分）', () => {
  const d = decide(F.codeShot())
  assert.equal(d.scores.length, 10)
  assert.equal(new Set(d.scores.map((s) => s.scene)).size, 10)
  assert.equal(d.scores.some((s) => s.scene === 'unknown'), false, 'unknown 是兜底值，不参与打分')
})

test('classifyScene：低对比纯色图 → unknown 且 uncertain', () => {
  const d = classifyScene(extractFeatures(F.solid(300, 200, [244, 244, 244])).features)
  assert.equal(d.scene, 'unknown')
  assert.equal(d.uncertain, true)
})

test('classifyScene：margin 小于阈值时不确定标记生效', () => {
  const d = decide(F.errorDialog())
  // 报错弹窗与图表在"大块彩色"上会打平，margin 偏小是可接受的：此时 UI 会提示可手动改类
  assert.equal(d.uncertain, d.margin < UNCERTAIN_MARGIN)
})

test('isTextLike：代码/文档/表格/界面/报错/手写为文字类，照片与示意图不是', () => {
  for (const s of ['code', 'error', 'table', 'document', 'handwriting', 'ui'] as SceneKind[]) {
    assert.equal(isTextLike(s), true, `${s} 应为文字类`)
  }
  for (const s of ['photo', 'diagram', 'chart', 'chat', 'unknown'] as SceneKind[]) {
    assert.equal(isTextLike(s), false, `${s} 不应为文字类`)
  }
})

test('dominantScene：票多者胜，平票取先出现', () => {
  assert.equal(dominantScene([]), 'unknown')
  assert.equal(dominantScene(['code']), 'code')
  assert.equal(dominantScene(['code', 'table', 'table']), 'table')
  assert.equal(dominantScene(['table', 'code']), 'table', '平票取先出现')
})

test('SCENE_LABEL：每个类别都有中文名', () => {
  const all: SceneKind[] = ['code', 'error', 'ui', 'chat', 'table', 'chart', 'document', 'diagram', 'photo', 'handwriting', 'unknown']
  for (const s of all) assert.ok(SCENE_LABEL[s] && SCENE_LABEL[s].length > 0, `${s} 缺中文名`)
})
