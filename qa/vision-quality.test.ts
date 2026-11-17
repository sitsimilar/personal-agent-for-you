/**
 * 机器视觉 · 质量门禁单元测试
 * ============================================================================
 * 覆盖七类问题与三条"不该误报"的负样本：
 * - 白底文档不该被判眩光（旧版最大的误报源）；
 * - 界面截图不该被判低对比（浅灰是设计，不是缺陷）；
 * - 正常代码截图应当是 good 且 issues 为空。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assessQuality, shouldBlock, summarizeQuality } from '../web/src/lib/vision/quality'
import { extractFeatures } from '../web/src/lib/vision/features'
import type { SceneKind } from '../web/src/lib/vision/types'
import * as F from './vision-fixtures'

/** 便捷：图 + 场景 → 质量报告。 */
function q(img: ReturnType<typeof F.codeShot>, scene: SceneKind = 'unknown') {
  const { features } = extractFeatures(img)
  return assessQuality(features, F.metaOf(img), scene)
}

test('质量：正常代码截图 good 且无问题', () => {
  const r = q(F.codeShot(), 'code')
  assert.equal(r.verdict, 'good')
  assert.deepEqual(r.issues, [])
  assert.equal(r.score, 100)
})

test('质量：纯色图判 blank + poor', () => {
  const r = q(F.solid(300, 200, [250, 250, 250]), 'document')
  assert.equal(r.verdict, 'poor')
  assert.ok(r.issues.some((i) => i.code === 'blank'))
})

test('质量：模糊图判 blurry（锐度断崖）', () => {
  const sharp = q(F.codeShot(), 'code')
  const blurred = q(F.blur(F.codeShot()), 'code')
  assert.ok(blurred.issues.some((i) => i.code === 'blurry'), `问题：${blurred.issues.map((i) => i.code)}`)
  assert.equal(blurred.verdict, 'poor')
  assert.ok(blurred.score < sharp.score)
})

test('质量：过小图判 tiny', () => {
  const r = q(F.makeImage(60, 60, () => [40, 40, 40]), 'code')
  assert.ok(r.issues.some((i) => i.code === 'tiny'))
})

test('质量：照片过曝判 glare', () => {
  const r = q(F.glare(F.photoShot()), 'photo')
  assert.ok(r.issues.some((i) => i.code === 'glare'), `问题：${r.issues.map((i) => i.code)}`)
})

test('质量：白底文档不判眩光（截图不会有反光）', () => {
  const r = q(F.documentShot(), 'document')
  assert.equal(r.issues.some((i) => i.code === 'glare'), false, '白底不等于过曝')
})

test('质量：界面截图不判低对比', () => {
  const r = q(F.uiShot(), 'ui')
  assert.equal(r.issues.some((i) => i.code === 'low_contrast'), false)
  assert.equal(r.verdict, 'good')
})

test('质量：极窄长图判 extreme_aspect', () => {
  const tall = F.solid(140, 1600, [250, 250, 250])
  F.rect(tall, 20, 20, 100, 8, [30, 30, 30])
  const r = q(tall, 'document')
  assert.ok(r.issues.some((i) => i.code === 'extreme_aspect'), `问题：${r.issues.map((i) => i.code)}`)
})

test('质量：小字（行高 6px）判 too_small_text', () => {
  // 480 宽 + 每 6px 一行 → 行高 6px，低于阈值 7
  const img = F.solid(480, 320, [255, 255, 255])
  for (let y = 6; y < 300; y += 6) {
    for (let x = 20; x < 440; x += 28) F.rect(img, x, y, 18, 2, [40, 40, 40])
  }
  const r = q(img, 'document')
  assert.ok(r.issues.some((i) => i.code === 'too_small_text'), `问题：${r.issues.map((i) => i.code)}`)
})

test('质量：shouldBlock 只拦 poor', () => {
  assert.equal(shouldBlock(q(F.solid(300, 200, [250, 250, 250]))), true)
  assert.equal(shouldBlock(q(F.codeShot(), 'code')), false)
})

test('质量：summarizeQuality 输出含问题码', () => {
  const s = summarizeQuality(q(F.blur(F.codeShot()), 'code'))
  assert.match(s, /poor/)
  assert.match(s, /blurry/)
  assert.match(summarizeQuality(q(F.codeShot(), 'code')), /good\(100\)/)
})
