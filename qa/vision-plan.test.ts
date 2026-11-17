/**
 * 机器视觉 · 预处理计划与体积阶梯单元测试
 * ============================================================================
 * 体积阶梯是"稳定性"的核心：旧实现只有"原样发送"，大图必然顶到网关。
 * 这里要证明三件事：
 * 1. 阶梯**单调**（质量/像素不反弹），不会来回横跳；
 * 2. 阶梯**必然终止**（最多 MAX_ENCODE_ATTEMPTS 次）；
 * 3. 阶梯**先牺牲画质、最后牺牲分辨率**（文字类尤其重要）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BATCH_BUDGET,
  MAX_ENCODE_ATTEMPTS,
  PER_IMAGE_BUDGET,
  compressionRatio,
  estimateDataUrlBytes,
  firstAttempt,
  nextAttempt,
  perImageBudget,
  planPreprocess,
  planResize,
  type EncodeAttempt,
} from '../web/src/lib/vision/plan'
import { assessQuality } from '../web/src/lib/vision/quality'
import { extractFeatures } from '../web/src/lib/vision/features'
import type { PreprocessPlan } from '../web/src/lib/vision/types'
import * as F from './vision-fixtures'

/** 构造计划（用真实特征，避免手搓假数据掩盖耦合问题）。 */
function planOf(img: ReturnType<typeof F.codeShot>, scene: Parameters<typeof planPreprocess>[3]) {
  const { features, contentBox } = extractFeatures(img)
  const meta = F.metaOf(img)
  const q = assessQuality(features, meta, scene)
  return planPreprocess(meta, features, q, scene, contentBox)
}

test('planResize：等比缩到长边上限', () => {
  assert.deepEqual(planResize(4000, 3000, 1600), { width: 1600, height: 1200, scale: 0.4 })
  assert.deepEqual(planResize(1600, 900, 1600), { width: 1600, height: 900, scale: 1 })
})

test('planResize：小图放大 2×，但不超过上限的 1.6 倍', () => {
  const r = planResize(700, 500, 1600, 2)
  assert.ok(r.scale > 1 && r.scale <= 2, `缩放 ${r.scale}`)
  assert.equal(r.width, 1400)
  // 1400 已接近上限，再放大必须被 1.6 倍天花板拦住
  const capped = planResize(1500, 1000, 1600, 2)
  assert.ok(Math.max(capped.width, capped.height) <= 1600 * 1.6 + 1, `被夹取后 ${capped.width}×${capped.height}`)
})

test('planResize：非法尺寸回落 1×1 不抛错', () => {
  assert.deepEqual(planResize(0, 100, 1600), { width: 1, height: 1, scale: 1 })
  assert.deepEqual(planResize(-5, -5, 1600), { width: 1, height: 1, scale: 1 })
})

test('planPreprocess：代码截图用 PNG 保笔画', () => {
  const p = planOf(F.codeShot(), 'code')
  assert.equal(p.format, 'image/png')
  assert.ok(p.targetWidth <= 1600)
})

test('planPreprocess：照片用 WebP 省体积', () => {
  const p = planOf(F.photoShot(), 'photo')
  assert.equal(p.format, 'image/webp')
  assert.ok(p.quality > 0.8 && p.quality <= 0.95)
})

test('planPreprocess：文档裁掉留白，界面绝不裁', () => {
  const doc = planOf(F.documentShot(), 'document')
  assert.ok(doc.crop, '文档应裁边')
  const ui = planOf(F.uiShot(), 'ui')
  assert.equal(ui.crop, null, '界面不裁（顶栏/侧栏是内容）')
})

test('planPreprocess：小字 + 小图触发 2× 放大', () => {
  // 320 宽、行高 6px 的文档
  const img = F.solid(320, 240, [255, 255, 255])
  for (let y = 10; y < 230; y += 6) for (let x = 12; x < 300; x += 24) F.rect(img, x, y, 14, 2, [40, 40, 40])
  const p = planOf(img, 'document')
  assert.ok(p.scale > 1, `应放大，实际 scale=${p.scale}`)
  assert.ok(p.reasons.some((r) => r.includes('放大')))
})

test('planPreprocess：判为 poor 时即使小字也不放大（放大只会更糊）', () => {
  // 直接构造特征 + 质量报告来打这个分支：比"把图真的糊掉再指望行高估得出来"更可控
  const base = extractFeatures(F.codeShot()).features
  const features = { ...base, lineHeightPx: 6 }
  const poor = { verdict: 'poor' as const, score: 30, issues: [] }
  const p = planPreprocess(F.metaOf(F.codeShot()), features, poor, 'document', null)
  assert.ok(p.scale <= 1, `poor 图不应放大，实际 scale=${p.scale}`)
  assert.ok(p.reasons.some((r) => r.includes('不放大')))
})

test('体积阶梯：从超预算到终止，像素单调、同格式质量单调', () => {
  const plan: PreprocessPlan = { crop: null, targetWidth: 1600, targetHeight: 1000, scale: 1, format: 'image/png', quality: 1, reasons: [] }
  let attempt: EncodeAttempt = firstAttempt(plan)
  const seen: EncodeAttempt[] = [attempt]
  // 模拟"每次都还超预算"，看阶梯怎么走
  for (let i = 0; i < MAX_ENCODE_ATTEMPTS + 2; i++) {
    const next = nextAttempt(attempt, 99_999_999, PER_IMAGE_BUDGET)
    if (!next) break
    // 像素比例全局不升
    assert.ok(next.pixelRatio <= attempt.pixelRatio, `像素回升：${attempt.pixelRatio} → ${next.pixelRatio}`)
    // 质量只在"同格式 + 同像素比例"时可比：换编码器会回到高位（不同编码器 quality 不可比），
    // 降像素后也会把质量还回去（像素少了，画质预算应该还回来）。
    if (next.format === attempt.format && next.pixelRatio === attempt.pixelRatio) {
      assert.ok(next.quality <= attempt.quality + 1e-9, `同格式质量回升：${attempt.quality} → ${next.quality}`)
    }
    seen.push(next)
    attempt = next
  }
  assert.ok(seen.length <= MAX_ENCODE_ATTEMPTS + 1, `步数 ${seen.length} 应受限`)
  assert.equal(nextAttempt(attempt, 99_999_999, PER_IMAGE_BUDGET), null, '最终必须返回 null 表示放弃')
})

test('体积阶梯：先降质量、后换格式、最后才降像素', () => {
  const png: EncodeAttempt = { format: 'image/png', quality: 1, pixelRatio: 1 }
  const toWebp = nextAttempt(png, 9_000_000, PER_IMAGE_BUDGET)
  assert.equal(toWebp?.format, 'image/webp', 'PNG 无质量旋钮，先换 WebP')
  assert.equal(toWebp?.pixelRatio, 1, '此时不动分辨率')

  const webpLow: EncodeAttempt = { format: 'image/webp', quality: 0.6, pixelRatio: 1 }
  const toJpeg = nextAttempt(webpLow, 9_000_000, PER_IMAGE_BUDGET)
  assert.equal(toJpeg?.format, 'image/jpeg', 'WebP 压不动就换 JPEG')

  const jpegLow: EncodeAttempt = { format: 'image/jpeg', quality: 0.65, pixelRatio: 1 }
  const shrink = nextAttempt(jpegLow, 9_000_000, PER_IMAGE_BUDGET)
  assert.ok(shrink && shrink.pixelRatio < 1, '最后才降像素')
  assert.equal(shrink?.pixelRatio, 0.6, '像素一次降到 60%')
  const giveUp = nextAttempt({ format: 'image/jpeg', quality: 0.65, pixelRatio: 0.6 }, 9_000_000, PER_IMAGE_BUDGET)
  assert.equal(giveUp, null, '降到底仍超预算 → 放弃')
})

test('体积阶梯：已达标时返回 null（不再继续压）', () => {
  const a: EncodeAttempt = { format: 'image/webp', quality: 0.86, pixelRatio: 1 }
  assert.equal(nextAttempt(a, 1000, PER_IMAGE_BUDGET), null)
})

test('预算分摊：单张不超 1.5MB，总量不超 4MB', () => {
  assert.equal(perImageBudget(1), PER_IMAGE_BUDGET)
  assert.equal(perImageBudget(3), Math.floor(BATCH_BUDGET / 3))
  assert.equal(perImageBudget(5), Math.floor(BATCH_BUDGET / 5))
  assert.ok(perImageBudget(5) * 5 <= BATCH_BUDGET)
  assert.ok(perImageBudget(0) <= PER_IMAGE_BUDGET, '非法张数不应炸')
})

test('estimateDataUrlBytes：Base64 膨胀 4/3 + 头部', () => {
  assert.equal(estimateDataUrlBytes(3000), 4000 + 32)
  assert.equal(estimateDataUrlBytes(0), 32)
})

test('compressionRatio：正常比与除零保护', () => {
  assert.equal(compressionRatio(1000, 250), 0.25)
  assert.equal(compressionRatio(0, 250), 1)
  assert.equal(compressionRatio(1000, 2000), 1, '放大时夹到 1')
})

test('planPreprocess：检测框过小（<35% 面积）时不裁，避免误裁掉整页', () => {
  // 回归用例：包围盒在 480 长边的降采样图上算，细节可能被采样漏掉，
  // 得到一个"只框住一小块"的框。照它裁会把整页切掉大半。
  const img = F.documentShot()
  const f = extractFeatures(img).features
  const meta = F.metaOf(img)
  const q = assessQuality(f, meta, 'document')
  const tiny = { x: 10, y: 10, w: 60, h: 40 } // 480×340 的 1.5%
  const p = planPreprocess(meta, f, q, 'document', tiny)
  assert.equal(p.crop, null, '过小的框必须被拒绝')
  assert.ok(p.reasons.some((r) => r.includes('跳过裁剪')), '应说明为什么没裁')
})

test('planPreprocess：细长条框也不裁（只框住一条顶栏不是"内容区"）', () => {
  const img = F.documentShot()
  const f = extractFeatures(img).features
  const meta = F.metaOf(img)
  const q = assessQuality(f, meta, 'document')
  const strip = { x: 0, y: 0, w: meta.width, h: Math.round(meta.height * 0.2) }
  const p = planPreprocess(meta, f, q, 'document', strip)
  assert.equal(p.crop, null, '细长条框必须被拒绝')
})
