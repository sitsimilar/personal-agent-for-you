/**
 * 机器视觉模块 · 特征提取（纯函数）
 * ============================================================================
 * 输入一张 RGBA 位图，输出一组「与语义无关」的数值特征，供下游三处使用：
 *   1. classify.ts —— 判断这是代码/表格/照片/…
 *   2. quality.ts  —— 判断糊没糊、有没有眩光、字是不是太小
 *   3. plan.ts     —— 决定裁不裁、缩到多大、用什么格式
 *
 * 复杂度：先把长边压到 ANALYSIS_LONG_EDGE（默认 480）再算，
 * 因此 4K 图与 720p 图的特征耗时基本相同（都是 ~0.15MP），
 * 这是「速度」指标的主要来源，也让特征在不同分辨率下可比。
 *
 * 所有阈值都写成常量并注明含义，避免"魔法数字"散落在 if 里。
 */

import { ANALYSIS_LONG_EDGE, downsampleRGBA, fitLongEdge, toGray, type RGBAImage } from './gray'
import type { Rect, VisionFeatures } from './types'

/** 特征分析分辨率（长边），定义在 gray 层以便 phash 共用；此处 re-export 保持旧引用可用。 */
export { ANALYSIS_LONG_EDGE } from './gray'

/** Sobel 幅值阈值：低于此值视为噪声（0..255 尺度上的 24 ≈ 9% 亮度跳变）。 */
const EDGE_THRESHOLD = 24
/** 强边缘阈值：只保留结构线，用于轴对齐与容器判定。 */
const STRONG_EDGE_THRESHOLD = 64

/** 文字行高搜索范围（分析图像素）：3px 以下无法稳定估计，60px 以上已不是"文字行"。 */
const LINE_LAG_MIN = 3
const LINE_LAG_MAX = 60

/** 亮度直方图桶数（32 桶 ≈ 每桶 8 级，足够看出双峰）。 */
const LUMA_BINS = 32

/** 颜色量化位数：每通道 4bit → 16³ = 4096 个桶。 */
const COLOR_QUANT_BITS = 4

/** 颜色采样步长（像素）：跳过取样既够快，又不影响"颜色多不多"的判断。 */
const COLOR_SAMPLE_STRIDE = 3

/** 一次性结果：特征 + 供下游复用的中间图（避免重复解码/缩放）。 */
export interface FeatureExtraction {
  features: VisionFeatures
  /** 分析分辨率灰度图（0..255 浮点）；保留给需要「看像素」的调试与可视化使用。 */
  gray: Float32Array
  grayWidth: number
  grayHeight: number
  /** 内容包围盒（原图坐标系）；全图无内容时为 null。 */
  contentBox: Rect | null
}

/**
 * 主入口：抽取特征。
 *
 * @param img    RGBA 位图（EXIF 已应用；可以已经是缩小过的工作副本）
 * @param opts.analysisLongEdge 覆盖分析分辨率（测试里会传小值验证边界）
 * @param opts.sourceWidth/sourceHeight **工作副本对应的原图尺寸**
 *
 * 为什么需要 sourceWidth/sourceHeight：
 * 调用方通常只把长边压到 512 的工作副本交进来（省内存），此时 `img.width` 不是原图宽度。
 * 若用它算 scaleToOriginal，`contentBox` 会变成工作副本坐标系，下游 `planPreprocess`
 * 会拿它去裁原图 —— 实测 2560×1440 的界面被裁成 340×258，整张图只剩 2%。
 * 同时 `lineHeightPx` 也会被低估 5~8 倍，"小字放大"规则随之失效。
 * 缺省时退化为 `img` 自身尺寸（等价于"这就是原图"）。
 */
export function extractFeatures(
  img: RGBAImage,
  opts?: { analysisLongEdge?: number; sourceWidth?: number; sourceHeight?: number },
): FeatureExtraction {
  const longEdge = opts?.analysisLongEdge ?? ANALYSIS_LONG_EDGE

  // ---- 1. 一次分块采样 → 小图 → 灰度 ----
  // 关键优化（2026-11-14）：上一版是 `toGray(整图)` 后再 resize，
  // 等于把 4K 图的 830 万像素全量转成 Float32（33MB 分配 + 写），
  // 实测 4K 特征耗时 223ms、是 720p 的 6 倍，与"分析分辨率固定"的设计不符。
  // 现在直接在 RGBA 上按块采样到 480 长边（每个目标像素最多 3×3 样本），
  // 再把这张小图转灰度——单次、O(目标像素)，4K 与 720p 的耗时回到同一量级。
  const fit = fitLongEdge(img.width, img.height, longEdge)
  const small = downsampleRGBA(img, fit.width, fit.height)
  const g = toGray(small)
  const { data: gray, width: gw, height: gh } = g

  // scaleToOriginal：分析图 1px 对应原图多少 px（用于把行高与包围盒换算回原图）
  // 用「原图宽 / 分析图宽」而不是「工作副本宽 / 分析图宽」——两者在 512 工作副本下差 5~8 倍。
  const srcW = opts?.sourceWidth && opts.sourceWidth > 0 ? opts.sourceWidth : img.width
  const srcH = opts?.sourceHeight && opts.sourceHeight > 0 ? opts.sourceHeight : img.height
  const scaleToOriginal = srcW / Math.max(1, gw)
  const n = gw * gh

  // ---- 2. 亮度统计（一次遍历出均值/方差/直方图/溢出比例）----
  const hist = new Float64Array(256)
  let sum = 0
  let sumSq = 0
  let brightClip = 0
  let darkClip = 0
  for (let i = 0; i < n; i++) {
    const v = gray[i]
    sum += v
    sumSq += v * v
    hist[Math.min(255, Math.max(0, v | 0))]++
    if (v > 250) brightClip++
    if (v < 5) darkClip++
  }
  const meanLuma = n > 0 ? sum / n : 0
  const variance = n > 0 ? Math.max(0, sumSq / n - meanLuma * meanLuma) : 0
  const stdLuma = Math.sqrt(variance)

  // 分位数用累计直方图取，避免对 0.5MP 排序（O(n log n) → O(n)）
  const p5 = percentileFromHist(hist, n, 0.05)
  const p95 = percentileFromHist(hist, n, 0.95)
  const contrastSpread = Math.max(0, (p95 - p5) / 255)

  // ---- 3. Sobel 边缘 ----
  const edge = sobel(gray, gw, gh)
  const edgeDensity = edge.count / Math.max(1, n)
  const strongEdgeDensity = edge.strongCount / Math.max(1, n)

  // ---- 4. 行/列墨迹投影 + 周期性（文字行检测）----
  const rowInk = new Float32Array(gh)
  const colInk = new Float32Array(gw)
  for (let y = 0; y < gh; y++) {
    let c = 0
    const base = y * gw
    for (let x = 0; x < gw; x++) if (edge.mask[base + x]) c++
    rowInk[y] = c / gw
  }
  for (let x = 0; x < gw; x++) {
    let c = 0
    for (let y = 0; y < gh; y++) if (edge.mask[y * gw + x]) c++
    colInk[x] = c / gh
  }
  const period = bestPeriod(rowInk, LINE_LAG_MIN, Math.min(LINE_LAG_MAX, Math.floor(gh / 3)))
  const lineHeightPx = period.lag > 0 ? period.lag * scaleToOriginal : 0

  // 有墨迹的行占比：文档"满版"（约 0.4~0.6），弹窗/界面只有零星几行（0.1~0.2）。
  // 这是区分「一页文档」与「一个提示框」最省算力的信号——两者行距都很规律。
  const ROW_INK_MIN = 0.015
  let inkRows = 0
  for (let y = 0; y < gh; y++) if (rowInk[y] > ROW_INK_MIN) inkRows++
  const inkRowCoverage = gh > 0 ? inkRows / gh : 0

  // ---- 5. 颜色统计（在小图上做：颜色是"大面积属性"，不需要全分辨率）----
  const color = colorStats(small)

  // ---- 6. 锐度：原生分辨率下的拉普拉斯方差（不能在看缩略图后的图上算）----
  // 说明：分析图做过面积平均，高频被抹平，用它算锐度会让 4K 截图被误判为"糊"。
  // 所以锐度单独在**原图**上取 3 块 256×256 补丁测，取中位数，与分辨率无关。
  const sharpness = nativeSharpness(img)

  // ---- 7. 轴对齐强度（界面/表格有长直线，照片很少有）----
  // 分开统计横/竖：表格需要"横竖都长"，界面通常只有横向分隔线横跨整幅。
  // 只取两者的最大值会让「一条顶栏」的界面和「满屏网格」的表格拿到同分——
  // 这是旧版把界面误判成表格的直接原因。
  const axisH = longestRunRatio(edge.strongMask, gw, gh, true)
  const axisV = longestRunRatio(edge.strongMask, gw, gh, false)

  // ---- 8. 红色占比 + 亮度双峰性 ----
  const lumaBimodality = bimodality(hist, n)

  const features: VisionFeatures = {
    width: gw,
    height: gh,
    scaleToOriginal,
    meanLuma,
    stdLuma,
    // 暗底判定：均值 <85。上一版还要求 darkClip>0.4（纯黑像素占比），
    // 结果「深灰底 (#1e2028) 的编辑器」被判成非暗底——深色主题很少是纯黑。
    darkBg: meanLuma < 85,
    edgeDensity,
    strongEdgeDensity,
    linePeriodicity: period.score,
    inkRowCoverage,
    lineHeightPx,
    saturationMean: color.saturationMean,
    colorfulness: color.colorfulness,
    distinctColorRatio: color.distinctRatio,
    brightClipRatio: brightClip / Math.max(1, n),
    darkClipRatio: darkClip / Math.max(1, n),
    sharpness,
    contrastSpread,
    hueEntropy: color.hueEntropy,
    axisRatio: Math.max(axisH, axisV),
    axisH,
    axisV,
    redRatio: color.redRatio,
    lumaBimodality,
  }

  return {
    features,
    gray,
    grayWidth: gw,
    grayHeight: gh,
    contentBox: contentBBox(gray, gw, gh, scaleToOriginal, srcW, srcH),
  }
}

// ============================================================================
// 以下为内部实现
// ============================================================================

/** 从 256 桶直方图取分位数（线性插值到桶内，避免台阶）。 */
function percentileFromHist(hist: Float64Array, total: number, q: number): number {
  if (total <= 0) return 0
  const target = total * q
  let acc = 0
  for (let v = 0; v < 256; v++) {
    const next = acc + hist[v]
    if (next >= target) {
      const inBucket = hist[v] > 0 ? (target - acc) / hist[v] : 0
      return v + Math.min(1, Math.max(0, inBucket))
    }
    acc = next
  }
  return 255
}

/** 边缘检测产物：幅值掩码（弱/强）+ 计数。 */
function sobel(gray: Float32Array, w: number, h: number) {
  const mask = new Uint8Array(w * h)
  const strongMask = new Uint8Array(w * h)
  let count = 0
  let strongCount = 0
  // 边界像素不参与（省掉 clamped index 判断，图像边缘对统计影响 <1%）
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const tl = gray[i - w - 1]
      const t = gray[i - w]
      const tr = gray[i - w + 1]
      const l = gray[i - 1]
      const r = gray[i + 1]
      const bl = gray[i + w - 1]
      const b = gray[i + w]
      const br = gray[i + w + 1]
      const gx = tr + 2 * r + br - (tl + 2 * l + bl)
      const gy = bl + 2 * b + br - (tl + 2 * t + tr)
      const mag = Math.abs(gx) + Math.abs(gy) // L1 近似，比 sqrt 快且对阈值不敏感
      if (mag > EDGE_THRESHOLD) {
        mask[i] = 1
        count++
        if (mag > STRONG_EDGE_THRESHOLD) {
          strongMask[i] = 1
          strongCount++
        }
      }
    }
  }
  return { mask, strongMask, count, strongCount }
}

/**
 * 一维投影的自相关：找「每隔多少像素重复一次」。
 *
 * 文字行是这个特征的最佳信号：每行文字 → 一条墨迹峰，行距固定 → 自相关在 lag=行高 处出峰。
 * 返回的 score 是归一化到 0..1 的峰值（除以零延迟的能量），lag=0 表示没找到。
 *
 * 边界：整幅纯色（无墨迹）时能量为 0，直接返回 {lag:0, score:0}，
 * 不能除零、也不能把噪声当周期。
 */
function bestPeriod(profile: Float32Array, lagMin: number, lagMax: number): { lag: number; score: number } {
  const n = profile.length
  if (n < lagMax + 2 || lagMax <= lagMin) return { lag: 0, score: 0 }

  // 去均值：否则「整体偏亮」会给出正的自相关底噪
  let mean = 0
  for (let i = 0; i < n; i++) mean += profile[i]
  mean /= n
  const centered = new Float32Array(n)
  let energy = 0
  for (let i = 0; i < n; i++) {
    const v = profile[i] - mean
    centered[i] = v
    energy += v * v
  }
  if (energy < 1e-6) return { lag: 0, score: 0 }

  let best = { lag: 0, score: 0 }
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let acc = 0
    for (let i = 0; i + lag < n; i++) acc += centered[i] * centered[i + lag]
    // 除以 (n-lag) 的归一化：不同 lag 的有效样本数不同，否则长 lag 系统性偏低
    const score = acc / energy / (1 - lag / n)
    if (score > best.score) best = { lag, score }
  }
  // 自相关峰值理论上 ≤1，浮点误差可能略超，夹取以保持契约
  return { lag: best.lag, score: Math.min(1, Math.max(0, best.score)) }
}

/**
 * 最长连续「强边缘」行程占边长的比例。
 *
 * 为什么用行程而不是霍夫变换：界面截图的分隔线是 1px 级、横跨整行的，
 * 最长行程天然把它抓出来；霍夫变换要调角度分辨率，成本高一个量级还更难解释。
 * 横向取每行的最长行程，纵向取每列的最长行程，两者取大。
 */
function longestRunRatio(mask: Uint8Array, w: number, h: number, horizontal: boolean): number {
  let best = 0
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      let run = 0
      const base = y * w
      for (let x = 0; x < w; x++) {
        if (mask[base + x]) {
          run++
          if (run > best) best = run
        } else run = 0
      }
    }
    return best / Math.max(1, w)
  }
  for (let x = 0; x < w; x++) {
    let run = 0
    for (let y = 0; y < h; y++) {
      if (mask[y * w + x]) {
        run++
        if (run > best) best = run
      } else run = 0
    }
  }
  return best / Math.max(1, h)
}

/**
 * 原生分辨率锐度：拉普拉斯方差 / 1000。
 *
 * 为什么取补丁而不是整图：
 * - 整图要先把 4K 图转成 33MB 的 Float32 数组，代价高且没必要；
 * - 只关心「边缘锐不锐」，中央与两侧三块 256² 补丁已足够代表。
 *
 * 返回值量纲：拉普拉斯方差通常在 0（纯色）~ 20000（锐利文字），除以 1000 后
 * 落在 0~20，判据见 quality.ts 的 SHARP_* 常量。取中位数是为了抗单块补丁恰好落在空白区。
 */
function nativeSharpness(img: RGBAImage): number {
  const PATCH = 256
  const { width, height } = img
  if (width < 8 || height < 8) return 0
  const pw = Math.min(PATCH, width)
  const ph = Math.min(PATCH, height)
  // 三块补丁：中央、左上 1/4 处、右下 3/4 处（都夹取在界内）
  const origins: Array<[number, number]> = [
    [Math.max(0, Math.floor((width - pw) / 2)), Math.max(0, Math.floor((height - ph) / 2))],
    [Math.floor(width * 0.15), Math.floor(height * 0.15)],
    [Math.floor(width * 0.7), Math.floor(height * 0.7)],
  ]

  const values: number[] = []
  for (const [ox, oy] of origins) {
    const luma = new Float32Array(pw * ph)
    for (let y = 0; y < ph; y++) {
      const sy = Math.min(height - 1, oy + y)
      for (let x = 0; x < pw; x++) {
        const sx = Math.min(width - 1, ox + x)
        const p = (sy * width + sx) * 4
        const a = img.data[p + 3] / 255
        const r = img.data[p] * a + 255 * (1 - a)
        const g = img.data[p + 1] * a + 255 * (1 - a)
        const b = img.data[p + 2] * a + 255 * (1 - a)
        luma[y * pw + x] = 0.2126 * r + 0.7152 * g + 0.0722 * b
      }
    }
    values.push(laplacianVariance(luma, pw, ph))
  }
  values.sort((a, b) => a - b)
  return values[1] / 1000 // 中位数
}

/** 拉普拉斯方差（4 邻域），越大越锐。 */
function laplacianVariance(gray: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0
  let sum = 0
  let sumSq = 0
  let count = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w]
      sum += lap
      sumSq += lap * lap
      count++
    }
  }
  if (count === 0) return 0
  const mean = sum / count
  return Math.max(0, sumSq / count - mean * mean)
}

/** 颜色统计：饱和度、色彩丰富度、颜色占用比、色相熵、红色占比。 */
function colorStats(img: RGBAImage) {
  const { data, width, height } = img
  const seen = new Uint8Array(1 << (COLOR_QUANT_BITS * 3))
  let distinct = 0
  let sampled = 0
  let satSum = 0
  let redPixels = 0

  // Hasler-Süsstrunk 需要全局均值与方差，先累加
  let rgSum = 0
  let ybSum = 0
  let rgSq = 0
  let ybSq = 0
  const hueHist = new Float64Array(12)
  let hueCount = 0

  for (let y = 0; y < height; y += COLOR_SAMPLE_STRIDE) {
    for (let x = 0; x < width; x += COLOR_SAMPLE_STRIDE) {
      const p = (y * width + x) * 4
      const a = data[p + 3]
      if (a === 0) continue
      const r = data[p]
      const g = data[p + 1]
      const b = data[p + 2]

      const max = Math.max(r, g, b)
      const min = Math.min(r, g, b)
      const sat = max === 0 ? 0 : (max - min) / max
      satSum += sat
      sampled++

      // 红色判定：只认「真红」——色相落在 345°~15°，且饱和、且明显压过绿蓝。
      // 旧规则（r-g>40 && r-b>30）会把橙色/暖光也算红：实测一张日落渐变照片
      // redRatio=0.80，直接被判成"满屏报错"。橙色（hue≈17°）现在被排除在外，
      // 因为告警条/危险按钮的色相几乎都在正负 15° 内。
      if (r > 110 && sat >= 0.5 && r - g >= 60 && r - b >= 60) {
        const hue = hueOf(r, g, b, max, min)
        if (hue <= 15 || hue >= 345) redPixels++
      }

      // 4bit 量化占位
      const key =
        ((r >> (8 - COLOR_QUANT_BITS)) << (COLOR_QUANT_BITS * 2)) |
        ((g >> (8 - COLOR_QUANT_BITS)) << COLOR_QUANT_BITS) |
        (b >> (8 - COLOR_QUANT_BITS))
      if (!seen[key]) {
        seen[key] = 1
        distinct++
      }

      // 色相（仅统计有饱和度的像素，灰色像素的色相无意义）
      if (sat > 0.12) {
        const hue = hueOf(r, g, b, max, min)
        hueHist[Math.min(11, Math.floor(hue / 30))]++
        hueCount++
      }

      const rg = r - g
      const yb = 0.5 * (r + g) - b
      rgSum += rg
      ybSum += yb
      rgSq += rg * rg
      ybSq += yb * yb
    }
  }

  const n = Math.max(1, sampled)
  const rgMean = rgSum / n
  const ybMean = ybSum / n
  const rgStd = Math.sqrt(Math.max(0, rgSq / n - rgMean * rgMean))
  const ybStd = Math.sqrt(Math.max(0, ybSq / n - ybMean * ybMean))
  const colorfulness = Math.sqrt(rgStd * rgStd + ybStd * ybStd) + 0.3 * Math.sqrt(rgMean * rgMean + ybMean * ybMean)

  return {
    saturationMean: satSum / n,
    colorfulness,
    distinctRatio: distinct / n,
    hueEntropy: entropyOf(hueHist, hueCount),
    redRatio: redPixels / n,
  }
}

/** RGB → 色相角 0..360（max==min 时返回 0，调用方已过滤低饱和）。 */
function hueOf(r: number, g: number, b: number, max: number, min: number): number {
  const d = max - min
  if (d === 0) return 0
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  return h < 0 ? h + 360 : h
}

/** 归一化香农熵（除以 log2(bins)）。 */
function entropyOf(hist: Float64Array, total: number): number {
  if (total <= 0) return 0
  let e = 0
  for (let i = 0; i < hist.length; i++) {
    if (hist[i] === 0) continue
    const p = hist[i] / total
    e -= p * Math.log2(p)
  }
  return Math.min(1, e / Math.log2(hist.length))
}

/**
 * 亮度双峰性：把 32 桶直方图平滑后找两个峰，
 * 返回「峰间距 × 两峰质量占比」——气泡/卡片式界面有两种底色时会明显偏高。
 */
function bimodality(hist: Float64Array, total: number): number {
  if (total <= 0) return 0
  const bins = new Float32Array(LUMA_BINS)
  const per = 256 / LUMA_BINS
  for (let v = 0; v < 256; v++) bins[Math.min(LUMA_BINS - 1, (v / per) | 0)] += hist[v]
  // 3 点平滑，抑制单像素噪声造成的假峰
  const smooth = new Float32Array(LUMA_BINS)
  for (let i = 0; i < LUMA_BINS; i++) {
    const a = bins[Math.max(0, i - 1)]
    const b = bins[i]
    const c = bins[Math.min(LUMA_BINS - 1, i + 1)]
    smooth[i] = (a + b + c) / 3
  }
  let i1 = 0
  let i2 = 0
  for (let i = 0; i < LUMA_BINS; i++) {
    if (smooth[i] > smooth[i1]) i1 = i
  }
  for (let i = 0; i < LUMA_BINS; i++) {
    if (i !== i1 && smooth[i] > smooth[i2]) i2 = i
  }
  if (i1 === i2) return 0
  const gap = Math.abs(i1 - i2) / (LUMA_BINS - 1)
  const mass = (smooth[i1] + smooth[i2]) / total
  return Math.min(1, gap * mass)
}

/**
 * 内容包围盒：找出「与主背景不同」的像素范围，用于裁掉大片空白边。
 *
 * **在分析小图上算**（480 长边），再把结果按 scale 换回原图坐标。
 * 精度损失约 ±scale px（4K 时 ±8px），但我们本来就要留 2% 边距（4K 时 ~60px），
 * 这点误差完全被吸收，换来的是读取量下降两个数量级。
 *
 * 做法：以亮度直方图众数为主背景估计，偏差 > 24 记为内容；
 * 行/列投影命中即视为「该行/列有内容」，取首末位置并留 2% 边距。
 *
 * 边界：
 * - 内容占比 <1% → 视为空白图，返回 null（交给 quality 报 blank）；
 * - 包围盒 <8% 面积 → 返回 null，避免把噪点当内容放大；
 * - 裁掉不足 3% → 不裁（省一次重绘，也避免轻微抖动导致结果不稳定）。
 */
function contentBBox(
  gray: Float32Array,
  gw: number,
  gh: number,
  scale: number,
  /** 原图宽（用于把换回后的坐标夹在边界内）；缺省表示不夹逼。 */
  origW = 0,
  /** 原图高。 */
  origH = 0,
): Rect | null {
  if (gw < 8 || gh < 8) return null

  // 主背景 = 亮度直方图众数（截图里通常是纯白或纯深灰）
  const hist = new Float64Array(256)
  for (let i = 0; i < gray.length; i++) hist[Math.min(255, Math.max(0, gray[i] | 0))]++
  let mode = 255
  let modeCount = -1
  for (let v = 0; v < 256; v++) {
    if (hist[v] > modeCount) {
      modeCount = hist[v]
      mode = v
    }
  }

  const rowHit = new Uint8Array(gh)
  const colHit = new Uint8Array(gw)
  let content = 0
  for (let y = 0; y < gh; y++) {
    for (let x = 0; x < gw; x++) {
      if (Math.abs(gray[y * gw + x] - mode) > 24) {
        rowHit[y] = 1
        colHit[x] = 1
        content++
      }
    }
  }
  if (content / Math.max(1, gw * gh) < 0.01) return null

  let top = -1
  let bottom = -1
  for (let y = 0; y < gh; y++) {
    if (rowHit[y]) {
      if (top === -1) top = y
      bottom = y
    }
  }
  let left = -1
  let right = -1
  for (let x = 0; x < gw; x++) {
    if (colHit[x]) {
      if (left === -1) left = x
      right = x
    }
  }
  if (top === -1 || left === -1) return null

  const padX = Math.max(1, Math.round(gw * 0.02))
  const padY = Math.max(1, Math.round(gh * 0.02))
  const x0 = Math.max(0, left - padX)
  const y0 = Math.max(0, top - padY)
  const w0 = Math.min(gw - x0, right - left + 1 + padX * 2)
  const h0 = Math.min(gh - y0, bottom - top + 1 + padY * 2)

  // 面积门限在小图上判（比例与缩放无关）
  const areaRatio = (w0 * h0) / (gw * gh)
  if (areaRatio < 0.08 || areaRatio > 0.97) return null

  // 换回原图坐标；四舍五入可能让右/下边界溢出 1~2px，统一夹回图内，
  // 否则下游 canvas.drawImage 用溢出矩形会出现 1px 黑边（部分浏览器行为不一致）。
  const x = Math.max(0, Math.round(x0 * scale))
  const y = Math.max(0, Math.round(y0 * scale))
  let w = Math.round(w0 * scale)
  let h = Math.round(h0 * scale)
  if (origW > 0) w = Math.min(w, origW - x)
  if (origH > 0) h = Math.min(h, origH - y)
  if (w < 24 || h < 24) return null
  return { x, y, w, h }
}
