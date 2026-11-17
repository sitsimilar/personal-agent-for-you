/**
 * 机器视觉 · 像素层与特征层单元测试
 * ============================================================================
 * 覆盖：灰度权重 / alpha 合成 / 面积平均缩放 / 长边缩放 / 特征对合成图的响应。
 * 断言的是「算法对特定信号的响应方向与量级」，不是精确浮点值——后者会被
 * 编译器优化与运行环境影响，写成精确值等于给自己埋 flaky 测试。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fitLongEdge, resizeGray, toGray } from '../web/src/lib/vision/gray'
import { extractFeatures } from '../web/src/lib/vision/features'
import * as F from './vision-fixtures'

/** 近似断言（浮点）。 */
function near(actual: number, expected: number, tol: number, msg?: string) {
  assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} 期望 ${expected}±${tol}，实际 ${actual}`)
}

test('toGray：Rec.709 权重（纯红 ≈ 0.2126×255）', () => {
  const img = F.solid(2, 2, [255, 0, 0])
  const g = toGray(img)
  near(g.data[0], 54.2, 0.5, '纯红亮度')
})

test('toGray：纯绿权重更高（0.7152）', () => {
  const g = toGray(F.solid(1, 1, [0, 255, 0]))
  near(g.data[0], 182.4, 0.5, '纯绿亮度')
})

test('toGray：全透明像素按白底合成（不是黑）', () => {
  const img = F.makeImage(1, 1, () => [0, 0, 0, 0])
  assert.equal(toGray(img).data[0], 255)
})

test('toGray：半透明黑按 a 合成到灰', () => {
  const img = F.makeImage(1, 1, () => [0, 0, 0, 128])
  near(toGray(img).data[0], 127, 2, '50% 透明黑')
})

test('resizeGray：纯色块缩到 1×1 仍为该色', () => {
  const g = toGray(F.solid(4, 4, [100, 100, 100]))
  const r = resizeGray(g, 1, 1)
  near(r.data[0], 100, 0.001)
})

test('resizeGray：2×2 黑白各半 → 均值 127.5（面积平均，不是最近邻）', () => {
  const img = F.makeImage(2, 2, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]))
  const r = resizeGray(toGray(img), 1, 1)
  near(r.data[0], 127.5, 0.5, '面积平均')
})

test('resizeGray：非法源尺寸返回 1×1 而不抛错', () => {
  const empty = { data: new Float32Array(0), width: 0, height: 0 }
  const r = resizeGray(empty, 8, 8)
  assert.equal(r.width, 8)
  assert.equal(r.height, 8)
  assert.equal(r.data.length, 64)
})

test('fitLongEdge：只缩不放', () => {
  assert.deepEqual(fitLongEdge(4000, 2000, 1600), { width: 1600, height: 800, scale: 0.4 })
  assert.deepEqual(fitLongEdge(800, 600, 1600), { width: 800, height: 600, scale: 1 })
})

test('fitLongEdge：非法尺寸回落 1×1', () => {
  assert.deepEqual(fitLongEdge(0, 0, 1600), { width: 1, height: 1, scale: 1 })
})

test('extractFeatures：纯色图无边缘、无锐度、不判暗底', () => {
  const { features } = extractFeatures(F.solid(320, 240, [250, 250, 250]))
  assert.equal(features.edgeDensity, 0)
  assert.equal(features.sharpness, 0)
  assert.equal(features.darkBg, false)
  assert.equal(features.linePeriodicity, 0, '无墨迹时不能把噪声当周期')
})

test('extractFeatures：深色图判 darkBg', () => {
  const { features } = extractFeatures(F.solid(200, 200, [18, 18, 20]))
  assert.equal(features.darkBg, true)
})

test('extractFeatures：代码截图能估出行高（≈16px）与强周期', () => {
  const { features } = extractFeatures(F.codeShot())
  assert.ok(features.linePeriodicity > 0.7, `行周期应显著，实际 ${features.linePeriodicity}`)
  assert.ok(features.lineHeightPx >= 14 && features.lineHeightPx <= 18, `行高应 ≈16，实际 ${features.lineHeightPx}`)
  assert.ok(features.inkRowCoverage > 0.3, '代码行应占相当比例的行')
})

test('extractFeatures：文档满版度高于弹窗', () => {
  const doc = extractFeatures(F.documentShot()).features
  const dialog = extractFeatures(F.errorDialog()).features
  assert.ok(doc.inkRowCoverage > dialog.inkRowCoverage, `文档 ${doc.inkRowCoverage} 应大于弹窗 ${dialog.inkRowCoverage}`)
})

test('extractFeatures：表格横竖都有长直线，代码只有短笔画', () => {
  const table = extractFeatures(F.tableShot()).features
  const code = extractFeatures(F.codeShot()).features
  assert.ok(table.axisH > 0.8 && table.axisV > 0.7, `表格网格：h=${table.axisH} v=${table.axisV}`)
  assert.ok(code.axisH < 0.2 && code.axisV < 0.2, `代码无长线：h=${code.axisH} v=${code.axisV}`)
})

test('extractFeatures：照片颜色种类远多于文档', () => {
  const photo = extractFeatures(F.photoShot()).features
  const doc = extractFeatures(F.documentShot()).features
  assert.ok(photo.distinctColorRatio > doc.distinctColorRatio * 10, `照片 ${photo.distinctColorRatio} vs 文档 ${doc.distinctColorRatio}`)
})

test('contentBBox：文档能框出正文区域（不等于全图）', () => {
  const r = extractFeatures(F.documentShot()).contentBox
  assert.ok(r, '应能框出内容')
  assert.ok(r!.w < 480 && r!.h < 340, `应小于原图，实际 ${r!.w}×${r!.h}`)
  assert.ok(r!.w > 380, `不应裁掉正文，实际宽 ${r!.w}`)
  assert.ok(r!.x >= 0 && r!.y >= 0 && r!.x + r!.w <= 480 && r!.y + r!.h <= 340, '包围盒必须在图内')
})

test('contentBBox：纯色图返回 null（无内容可裁）', () => {
  assert.equal(extractFeatures(F.solid(300, 200, [240, 240, 240])).contentBox, null)
})

test('extractFeatures：分析分辨率上限生效（大图与 4K 耗时同量级）', () => {
  const small = extractFeatures(F.codeShot()).features
  const big = extractFeatures(F.codeShot(1920, 1280)).features
  // 分析图长边都 ≤480，因此分析尺寸一致，缩放比按原图换算
  assert.ok(big.width <= 480 && big.height <= 480)
  assert.equal(big.width, small.width, '同样的长宽比应得到同样的分析尺寸')
  assert.ok(big.scaleToOriginal > small.scaleToOriginal, '大图的换算比应更大')
})

test('contentBox：按原图坐标返回（工作副本不能污染坐标系）', () => {
  // 回归用例：pipeline 交给特征层的是 512 长边的**工作副本**，
  // 若用工作副本宽度算 scaleToOriginal，包围盒会缩成 1/N，
  // 下游 planPreprocess 拿它去裁原图，实测把 2560×1440 的界面裁成 340×258。
  // 用"白纸 + 居中文字块"造图：留白足够大，才能触发裁剪分支
  const original = F.rect(F.solid(1200, 900, [252, 252, 252]), 200, 200, 800, 500, [60, 60, 60])
  const work = F.downscale(original, 3) // 400×300 的工作副本
  const box = extractFeatures(work, { sourceWidth: 1200, sourceHeight: 900 }).contentBox
  assert.ok(box, '应能框出正文')
  assert.ok(box!.w > 750 && box!.w < 950, `包围盒必须是原图坐标（约 850），实际 ${box!.w}`)
  assert.ok(box!.x + box!.w <= 1200 && box!.y + box!.h <= 900, '必须落在原图范围内')
})

test('extractFeatures：不给 sourceWidth 时退化为位图自身尺寸（等价"这就是原图"）', () => {
  const img = F.documentShot(400, 300)
  const withOpt = extractFeatures(img, { sourceWidth: 400, sourceHeight: 300 }).features
  const without = extractFeatures(img).features
  assert.equal(without.scaleToOriginal, withOpt.scaleToOriginal)
})
