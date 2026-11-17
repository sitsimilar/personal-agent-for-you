/**
 * 机器视觉 · 感知哈希单元测试
 * ============================================================================
 * 目的不是"哈希算法本身"，而是验证**去重阈值在实际输入上可用的三条性质**：
 * 1. 同图（含缩放）距离 ≈ 0；
 * 2. 仅整体亮度偏移时距离仍小（aHash 会动，dHash 稳）；
 * 3. 不同场景距离远大于阈值。
 *
 * 若哪天改了缩放实现或哈希位数，这三条会立刻挂掉——这正是它存在的意义。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hashDistance, isSameImage, perceptualHash, SAME_IMAGE_DISTANCE } from '../web/src/lib/vision/phash'
import * as F from './vision-fixtures'

test('perceptualHash：输出 32 位十六进制（aHash 16 + dHash 16）', () => {
  const h = perceptualHash(F.codeShot())
  assert.equal(h.length, 32)
  assert.match(h, /^[0-9a-f]{32}$/)
})

test('perceptualHash：同图距离为 0', () => {
  const a = perceptualHash(F.codeShot())
  const b = perceptualHash(F.codeShot())
  assert.equal(hashDistance(a, b), 0)
  assert.equal(isSameImage(a, b), true)
})

test('perceptualHash：同一内容缩到一半仍是同一张图', () => {
  const base = F.codeShot()
  const a = perceptualHash(base)
  const small = perceptualHash(F.downscale(base, 2))
  assert.ok(hashDistance(a, small) <= SAME_IMAGE_DISTANCE, `缩放后距离 ${hashDistance(a, small)}`)
})

test('perceptualHash：整体加亮 12 级仍判同图（dHash 对亮度不敏感）', () => {
  const base = F.codeShot()
  const brighter = F.makeImage(base.width, base.height, (x, y) => {
    const p = (y * base.width + x) * 4
    return [
      Math.min(255, base.data[p] + 12),
      Math.min(255, base.data[p + 1] + 12),
      Math.min(255, base.data[p + 2] + 12),
    ] as [number, number, number]
  })
  const d = hashDistance(perceptualHash(base), perceptualHash(brighter))
  assert.ok(d <= SAME_IMAGE_DISTANCE, `亮度偏移后距离 ${d}`)
})

test('perceptualHash：不同场景距离远大于阈值', () => {
  const pairs: Array<[string, string]> = [
    ['代码', perceptualHash(F.codeShot())],
    ['文档', perceptualHash(F.documentShot())],
    ['表格', perceptualHash(F.tableShot())],
    ['照片', perceptualHash(F.photoShot())],
  ]
  for (let i = 0; i < pairs.length; i++) {
    for (let j = i + 1; j < pairs.length; j++) {
      const d = hashDistance(pairs[i][1], pairs[j][1])
      assert.ok(d > SAME_IMAGE_DISTANCE, `${pairs[i][0]} vs ${pairs[j][0]} 距离 ${d} 应 > ${SAME_IMAGE_DISTANCE}`)
    }
  }
})

test('hashDistance：长度不符返回 Infinity（按"不同"处理）', () => {
  assert.equal(hashDistance('abc', 'abcd'), Number.POSITIVE_INFINITY)
  assert.equal(hashDistance('', ''), Number.POSITIVE_INFINITY)
})

test('hashDistance：自身与自身为 0，对称', () => {
  const a = perceptualHash(F.tableShot())
  const b = perceptualHash(F.photoShot())
  assert.equal(hashDistance(a, a), 0)
  assert.equal(hashDistance(a, b), hashDistance(b, a))
})
