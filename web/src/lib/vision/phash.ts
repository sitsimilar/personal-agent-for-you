/**
 * 机器视觉模块 · 感知哈希（批次内去重 + 结果缓存 key）
 * ============================================================================
 * 算法：aHash（均值哈希）+ dHash（差分哈希）各 64 bit，拼成 32 位十六进制串。
 *
 * 为什么两种都算：
 * - aHash 对整体亮度变化敏感（截图调了主题亮度就变），但对结构变化很稳；
 * - dHash 只看相邻像素的**梯度方向**，对亮度/对比度整体偏移几乎免疫。
 * 两者拼起来：结构相同 → 两个距离都小；只有亮度变了 → aHash 变、dHash 稳，
 * 从而能区分「同一张图的不同亮度版本」与「两张不同的图」。
 *
 * 阈值：汉明距离 ≤ 10（满分 128）视为同一张图；这一档来自合成样本（同图缩放/轻微
 * 亮度偏移距离 0~6，不同图普遍 >40），留了足够余量。
 */

import { ANALYSIS_LONG_EDGE, downsampleRGBA, fitLongEdge, resizeGray, toGray, type GrayImage, type RGBAImage } from './gray'

/** 视为「同一张图」的最大汉明距离。 */
export const SAME_IMAGE_DISTANCE = 10

/**
 * 计算感知哈希：返回 32 位十六进制（前 16 位 aHash，后 16 位 dHash）。
 *
 * 先降到 480 长边再哈希——与特征提取走**完全相同的预处理**，
 * 因此"管线内复用灰度图算的哈希"与"这里单独算的哈希"逐位相同（缓存 key 才可靠）。
 * 顺带把 4K 图的开销从 100ms+ 压到 20ms 级。
 */
export function perceptualHash(img: RGBAImage): string {
  const fit = fitLongEdge(img.width, img.height, ANALYSIS_LONG_EDGE)
  return perceptualHashOfGray(toGray(downsampleRGBA(img, fit.width, fit.height)))
}

/**
 * 从已有的灰度图算哈希。
 *
 * 存在的意义：特征提取阶段已经产出了 480 长边的灰度图，
 * 直接复用它就不必再对整图做一次 toGray（4K 图那是 33MB 的分配）。
 * 先降采样再哈希还有个副作用收益：高频噪声被抹平，同图不同压缩率的距离更小。
 */
export function perceptualHashOfGray(gray: GrayImage): string {
  return aHash(gray) + dHash(gray)
}

/** 两张图的汉明距离（0..128）。长度不一致时返回 Infinity，调用方按"不同"处理。 */
export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length || a.length !== 32) return Number.POSITIVE_INFINITY
  let dist = 0
  for (let i = 0; i < 32; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    // 半字节里数 1（只有 4 bit，直接查表最省）
    dist += BIT_COUNT[x & 0xf]
  }
  return dist
}

/** 是否同一张图。 */
export function isSameImage(a: string, b: string): boolean {
  return hashDistance(a, b) <= SAME_IMAGE_DISTANCE
}

/** 4bit 的 1 个数查表。 */
const BIT_COUNT = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]

/** aHash：8×8 缩略图，像素 > 均值记 1。 */
function aHash(gray: { data: Float32Array; width: number; height: number }): string {
  const small = resizeGray(gray, 8, 8)
  let mean = 0
  for (let i = 0; i < 64; i++) mean += small.data[i]
  mean /= 64
  return bitsToHex(Array.from(small.data, (v) => v > mean))
}

/** dHash：9×8 缩略图，横向相邻比较（左 > 右记 1）。 */
function dHash(gray: { data: Float32Array; width: number; height: number }): string {
  const small = resizeGray(gray, 9, 8)
  const bits: boolean[] = []
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits.push(small.data[y * 9 + x] > small.data[y * 9 + x + 1])
    }
  }
  return bitsToHex(bits)
}

/** 64 个 bool → 16 位十六进制（每 4 bit 一个字符，高位在前）。 */
function bitsToHex(bits: boolean[]): string {
  let out = ''
  for (let i = 0; i < 64; i += 4) {
    const nibble = (bits[i] ? 8 : 0) | (bits[i + 1] ? 4 : 0) | (bits[i + 2] ? 2 : 0) | (bits[i + 3] ? 1 : 0)
    out += nibble.toString(16)
  }
  return out
}
