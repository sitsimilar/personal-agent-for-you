/**
 * 机器视觉 · 计算侧基准（Node，不测编码）
 * ============================================================================
 * 测什么：
 * - extractFeatures：特征提取（含灰度、缩放、Sobel、投影、自相关、颜色统计）
 * - perceptualHash：感知哈希
 * - classifyScene：分类打分（纯算术，应该是微秒级）
 *
 * 为什么分尺寸测：分析分辨率被夹到 480 长边，理论上 720p 与 4K 的耗时应该接近。
 * 实测能验证这个设计是否真的成立（若不成立，说明某段代码漏用了缩略图）。
 *
 * 运行：npx tsx qa/vision-bench.ts
 * 产出：outputs/qa/vision/bench-node-YYYY-MM-DD.json
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFeatures } from '../web/src/lib/vision/features'
import { fitLongEdge, resizeGray, toGray, downsampleRGBA } from '../web/src/lib/vision/gray'
import { perceptualHash } from '../web/src/lib/vision/phash'
import { classifyScene } from '../web/src/lib/vision/classify'
import * as F from './vision-fixtures'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, '..', 'outputs', 'qa', 'vision')

/** 取 n 次运行的中位数（排除首次 JIT 与 GC 抖动）。 */
function median(samples: number[]): number {
  const s = [...samples].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

/** 重复跑 fn，返回中位数毫秒。 */
function bench(fn: () => void, runs = 5): number {
  fn() // 预热
  const t: number[] = []
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    fn()
    t.push(performance.now() - t0)
  }
  return median(t)
}

const SIZES: Array<{ label: string; w: number; h: number }> = [
  { label: '1280×720', w: 1280, h: 720 },
  { label: '1920×1080', w: 1920, h: 1080 },
  { label: '3840×2160', w: 3840, h: 2160 },
]

// 全局预热：避免第一个被测尺寸独自承担 JIT 编译开销（否则它会显得莫名更慢）
for (let i = 0; i < 3; i++) {
  const warm = F.codeShot(320, 200)
  extractFeatures(warm)
  perceptualHash(warm)
  classifyScene(extractFeatures(warm).features)
}

const rows: Array<Record<string, unknown>> = []

for (const s of SIZES) {
  const img = F.codeShot(s.w, s.h)
  const memMB = (img.data.byteLength / 1024 / 1024).toFixed(1)

  const tFeatures = bench(() => {
    extractFeatures(img)
  })
  const tHash = bench(() => {
    perceptualHash(img)
  })

  // ---- 改动前/后的同一段链路 A/B（可复现）----
  // 旧：整图转灰度（4K 分配 33MB Float32）+ 再缩放
  const tLegacyPrep = bench(() => {
    const full = toGray(img)
    const fit = fitLongEdge(img.width, img.height, 480)
    resizeGray(full, fit.width, fit.height)
  })
  // 新：直接在 RGBA 上分块采样，再转小图灰度
  const tNewPrep = bench(() => {
    const fit = fitLongEdge(img.width, img.height, 480)
    toGray(downsampleRGBA(img, fit.width, fit.height))
  })
  // 旧哈希：对整图再转一次灰度
  const tLegacyHash = bench(() => {
    toGray(img)
  }, 3)
  const { features } = extractFeatures(img)
  const tClassify = bench(() => {
    classifyScene(features)
  }, 20)

  const total = tFeatures + tHash + tClassify
  rows.push({
    size: s.label,
    pixels: s.w * s.h,
    rgbaMB: Number(memMB),
    analysisSize: `${features.width}×${features.height}`,
    featuresMs: Number(tFeatures.toFixed(2)),
    phashMs: Number(tHash.toFixed(2)),
    classifyMs: Number((tClassify * 1000).toFixed(1)), // 微秒
    totalMs: Number(total.toFixed(2)),
    prepLegacyMs: Number(tLegacyPrep.toFixed(2)),
    prepNewMs: Number(tNewPrep.toFixed(2)),
    prepSpeedup: Number((tLegacyPrep / Math.max(0.01, tNewPrep)).toFixed(2)),
    hashLegacyExtraMs: Number(tLegacyHash.toFixed(2)),
  })
}

// 退化输入：空白图与极端长图，验证不会退化成"慢路径"
const blank = F.solid(1920, 1080, [255, 255, 255])
const tall = F.solid(300, 6000, [250, 250, 250])
const edgeCases = [
  { label: '空白 1920×1080', ms: Number(bench(() => extractFeatures(blank)).toFixed(2)) },
  { label: '长图 300×6000', ms: Number(bench(() => extractFeatures(tall)).toFixed(2)) },
]

const payload = {
  date: new Date().toISOString().slice(0, 10),
  env: { node: process.version, platform: process.platform, arch: process.arch },
  analysisLongEdge: 480,
  rows,
  edgeCases,
}

mkdirSync(outDir, { recursive: true })
const file = resolve(outDir, `bench-node-${payload.date}.json`)
writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')

console.log('尺寸          像素量      分析尺寸      特征ms   哈希ms   分类µs   合计ms')
console.log('—— 预处理链路 A/B（旧:整图灰度+缩放 / 新:分块采样）——')
for (const r of rows) {
  console.log(
    String(r.size).padEnd(13),
    String(r.pixels).padEnd(11),
    String(r.analysisSize).padEnd(13),
    String(r.featuresMs).padEnd(8),
    String(r.phashMs).padEnd(8),
    String(r.classifyMs).padEnd(8),
    String(r.totalMs),
  )
}
console.log('\n尺寸          旧预处理ms   新预处理ms   提速     旧哈希额外ms')
for (const r of rows) {
  console.log(
    String(r.size).padEnd(13),
    String(r.prepLegacyMs).padEnd(12),
    String(r.prepNewMs).padEnd(12),
    `${r.prepSpeedup}×`.padEnd(8),
    String(r.hashLegacyExtraMs),
  )
}
console.log('\n边界输入：', edgeCases.map((e) => `${e.label} ${e.ms}ms`).join(' | '))
console.log('\n已写入', file)
