/**
 * 机器视觉模块 · 像素层工具（纯函数，零依赖，可 Node 单测）
 * ============================================================================
 * 这里只做两件事：
 * 1. RGBA → 灰度（Rec.709 亮度）；
 * 2. 面积平均（box filter）缩放——视觉特征在缩略图上算即可，
 *    这一步把 4K 图的计算量压到 640 长边以内，是「快」的主要来源。
 *
 * 为什么不用 canvas 的 drawImage 做缩放？
 * - canvas 缩放受实现影响（Chrome 对小图用双线性、大图用分块），不可复现；
 * - 面积平均对「按行统计墨迹」这类任务最稳：它等价于把每个目标像素
 *   覆盖的源像素求均值，不会像最近邻那样漏掉细笔画。
 */

/**
 * 特征/哈希共用的分析分辨率（长边 px）。
 * 480 是精度与耗时的折中：再小丢笔画，再大收益递减。
 * 放在 gray 层是为了让 features 与 phash 用同一个值——两边不一致会导致
 * 「管线内算的哈希」与「单独调 perceptualHash 算的哈希」不同，缓存 key 就对不上。
 */
export const ANALYSIS_LONG_EDGE = 480

/** 内存里的 RGBA 位图（与 ImageData 同构，但不依赖 DOM 类型）。 */
export interface RGBAImage {
  /** 长度 = width * height * 4，顺序 R,G,B,A。 */
  data: Uint8ClampedArray
  width: number
  height: number
}

/** 单通道灰度图（0..255 浮点，保留小数避免多次缩放丢精度）。 */
export interface GrayImage {
  data: Float32Array
  width: number
  height: number
}

/**
 * RGBA → 灰度。
 *
 * 权重采用 Rec.709（0.2126 / 0.7152 / 0.0722），而不是 NTSC 的 0.299/0.587/0.114：
 * 屏幕截图以 sRGB 为主，Rec.709 对绿色更敏感，深色主题下的彩色语法高亮
 * （关键字紫、字符串绿）区分度更好。
 *
 * 边界：完全透明像素（a=0）按白底合成后取亮度——这与「用户看到的截图」
 * 一致（截图不会透出桌面），避免透明 PNG 被当成纯黑。
 */
export function toGray(img: RGBAImage): GrayImage {
  const { data, width, height } = img
  const out = new Float32Array(width * height)
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    const a = data[p + 3] / 255
    // 透明像素按白底合成：c' = c*a + 255*(1-a)
    const r = data[p] * a + 255 * (1 - a)
    const g = data[p + 1] * a + 255 * (1 - a)
    const b = data[p + 2] * a + 255 * (1 - a)
    out[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b
  }
  return { data: out, width, height }
}

/**
 * 面积平均缩放（box filter）。
 *
 * 实现要点：
 * - 先把源图的行方向按整数边界累加成一维前缀（每行一次 O(w)），
 *   再按目标列区间取均值；列方向同理。整体 O(src + dst)，不是 O(src*dst)。
 * - 放大（dstW > srcW）时退化为最近邻：视觉特征不需要插值，
 *   而且放大只发生在「小图补分辨率」的少数场景。
 * - 宽高任一 ≤0 时返回 1×1 的空图，调用方据此判空，不抛异常
 *   （用户随手传一张损坏图不该让整条链路炸掉）。
 */
export function resizeGray(src: GrayImage, dstW: number, dstH: number): GrayImage {
  const w = Math.max(1, Math.round(dstW))
  const h = Math.max(1, Math.round(dstH))
  if (src.width <= 0 || src.height <= 0) {
    return { data: new Float32Array(w * h), width: w, height: h }
  }

  // ---- 水平方向 ----
  const tmp = new Float32Array(w * src.height)
  const sx = src.width / w
  // 预计算每个目标列的源区间，避免内层重复乘除
  const x0 = new Int32Array(w)
  const x1 = new Int32Array(w)
  for (let x = 0; x < w; x++) {
    const a = Math.floor(x * sx)
    const b = Math.max(a + 1, Math.floor((x + 1) * sx))
    x0[x] = Math.min(a, src.width - 1)
    x1[x] = Math.min(b, src.width)
  }
  for (let y = 0; y < src.height; y++) {
    const rowBase = y * src.width
    const outBase = y * w
    for (let x = 0; x < w; x++) {
      let sum = 0
      const a = x0[x]
      const b = x1[x]
      for (let i = a; i < b; i++) sum += src.data[rowBase + i]
      tmp[outBase + x] = sum / (b - a)
    }
  }

  // ---- 垂直方向 ----
  const out = new Float32Array(w * h)
  const sy = src.height / h
  for (let y = 0; y < h; y++) {
    const a = Math.min(Math.floor(y * sy), src.height - 1)
    const b = Math.min(Math.max(a + 1, Math.floor((y + 1) * sy)), src.height)
    const outBase = y * w
    const n = b - a
    for (let x = 0; x < w; x++) {
      let sum = 0
      for (let row = a; row < b; row++) sum += tmp[row * w + x]
      out[outBase + x] = sum / n
    }
  }
  return { data: out, width: w, height: h }
}

/**
 * RGBA 分块采样降采样（**特征提取的唯一入口**）。
 *
 * 与 resizeGray 的区别：
 * - resizeGray 是"先转灰度再逐像素精确平均"，适合已经在小尺寸上的二次缩放；
 * - 本函数直接在 RGBA 上按块采样，**每个目标像素最多取 3×3 个源样本**，
 *   把 4K 图的读取量从 830 万次降到 ~130 万次，同时保留块内代表性。
 *
 * 为什么不逐像素全平均：4K 一个目标像素要平均 8×8=64 个源像素，
 * 那是 5 亿次累加，在 Electron 渲染进程里会卡住一帧以上。
 * 统计类特征（边缘密度、行周期、颜色分布）不需要这种精度。
 *
 * @param src          源 RGBA
 * @param dstW/dstH    目标尺寸（调用方用 fitLongEdge 算好）
 * @param maxSamples   每个目标像素单轴最多采样点数（默认 3）
 */
export function downsampleRGBA(src: RGBAImage, dstW: number, dstH: number, maxSamples = 3): RGBAImage {
  const w = Math.max(1, Math.round(dstW))
  const h = Math.max(1, Math.round(dstH))
  if (src.width <= 0 || src.height <= 0) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
  }
  const out = new Uint8ClampedArray(w * h * 4)
  const sx = src.width / w
  const sy = src.height / h

  for (let y = 0; y < h; y++) {
    const y0 = Math.min(src.height - 1, Math.floor(y * sy))
    const y1 = Math.min(src.height, Math.max(y0 + 1, Math.floor((y + 1) * sy)))
    const yStep = Math.max(1, Math.ceil((y1 - y0) / maxSamples))
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(src.width - 1, Math.floor(x * sx))
      const x1 = Math.min(src.width, Math.max(x0 + 1, Math.floor((x + 1) * sx)))
      const xStep = Math.max(1, Math.ceil((x1 - x0) / maxSamples))

      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let syi = y0; syi < y1; syi += yStep) {
        const rowBase = syi * src.width * 4
        for (let sxi = x0; sxi < x1; sxi += xStep) {
          const p = rowBase + sxi * 4
          r += src.data[p]
          g += src.data[p + 1]
          b += src.data[p + 2]
          a += src.data[p + 3]
          n++
        }
      }
      const q = (y * w + x) * 4
      out[q] = r / n
      out[q + 1] = g / n
      out[q + 2] = b / n
      out[q + 3] = a / n
    }
  }
  return { data: out, width: w, height: h }
}

/**
 * 等比缩放到指定长边（只缩不放）。
 * 返回的 scale = 目标长边 / 原长边，调用方可据此把「分析图像素」换算回原图。
 */
export function fitLongEdge(
  width: number,
  height: number,
  longEdge: number,
): { width: number; height: number; scale: number } {
  const srcLong = Math.max(width, height)
  if (!Number.isFinite(srcLong) || srcLong <= 0) {
    return { width: 1, height: 1, scale: 1 }
  }
  const scale = Math.min(1, longEdge / srcLong)
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scale,
  }
}

/** 从 RGBA 直接取出某个像素的 RGB（不合成 alpha），供色相/饱和度统计使用。 */
export function pixelAt(img: RGBAImage, x: number, y: number): { r: number; g: number; b: number; a: number } {
  const p = (y * img.width + x) * 4
  return { r: img.data[p], g: img.data[p + 1], b: img.data[p + 2], a: img.data[p + 3] }
}
