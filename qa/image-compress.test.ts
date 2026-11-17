/**
 * 上传前压缩（`web/src/lib/image-compress.ts`）纯函数单测。
 *
 * Canvas 部分依赖浏览器，不在 node 里跑；这里只守「尺寸计算 / 跳过压缩判定 / 扩展名归一」
 * 这三块最容易写错、又直接影响流量的逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canSkipCompress,
  computeUploadSize,
  extOfName,
  SKIP_COMPRESS_BYTES,
  UPLOAD_MAX_EDGE,
} from '../web/src/lib/image-compress'

test('超长边按比例缩到 1280，短边同比', () => {
  assert.deepEqual(computeUploadSize(4000, 3000), { w: 1280, h: 960 })
  assert.deepEqual(computeUploadSize(3000, 4000), { w: 960, h: 1280 })
})

test('小图不放大', () => {
  assert.deepEqual(computeUploadSize(800, 600), { w: 800, h: 600 })
  assert.deepEqual(computeUploadSize(1280, 1280), { w: 1280, h: 1280 })
})

test('极窄图至少保留 1px（不出现 0 宽）', () => {
  const { w, h } = computeUploadSize(4000, 20)
  assert.equal(w, UPLOAD_MAX_EDGE)
  assert.ok(h >= 1)
})

test('非法尺寸退回 1280 方图（不抛错）', () => {
  assert.deepEqual(computeUploadSize(0, 0), { w: UPLOAD_MAX_EDGE, h: UPLOAD_MAX_EDGE })
  assert.deepEqual(computeUploadSize(NaN, 100), { w: UPLOAD_MAX_EDGE, h: UPLOAD_MAX_EDGE })
})

test('小 JPEG 且尺寸达标才跳过压缩', () => {
  const ok = { mime: 'image/jpeg', size: 120 * 1024, width: 1000, height: 800 }
  assert.equal(canSkipCompress(ok), true)
  // 体积超阈值 → 要压
  assert.equal(canSkipCompress({ ...ok, size: SKIP_COMPRESS_BYTES + 1 }), false)
  // 尺寸超边 → 要压
  assert.equal(canSkipCompress({ ...ok, width: 2000 }), false)
  // PNG 一律压（截图体积大）
  assert.equal(canSkipCompress({ ...ok, mime: 'image/png' }), false)
  // webp 同理
  assert.equal(canSkipCompress({ ...ok, mime: 'image/webp' }), false)
})

test('扩展名归一：jpeg→jpg，大小写不敏感', () => {
  assert.equal(extOfName('a.JPEG'), 'jpg')
  assert.equal(extOfName('a.PNG'), 'png')
  assert.equal(extOfName('no-ext'), '')
})
