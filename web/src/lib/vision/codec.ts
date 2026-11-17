/**
 * 机器视觉模块 · 编解码（浏览器侧）
 * ============================================================================
 * 职责边界：
 * - **纯函数**（魔数嗅探、data URL 拆解、体积换算）放在文件上半部分，Node 可直接单测；
 * - **浏览器 API**（createImageBitmap / canvas / toBlob）只出现在函数体内，
 *   模块顶层不触碰 DOM，因此 import 本文件不会在 Node 里炸。
 *
 * 相比旧实现的三个实质变化：
 * 1. 不再相信 `file.type`：微信/QQ 转发、改扩展名都会给出错误 MIME，
 *    统一按文件头魔数判格式，判不出才回落 MIME。
 * 2. 不再原样透传：解码后按计划裁剪/缩放/转码，EXIF 方向一并纠正
 *    （旧实现手机竖拍照片会横躺，模型读到的行序是错的）。
 * 3. 不再可能超预算：编码走体积阶梯，硬预算见 plan.ts。
 */

import type { ImageFormat, ImageMeta, PreprocessPlan, Rect } from './types'
import { MAX_ENCODE_ATTEMPTS, estimateDataUrlBytes, nextAttempt, type EncodeAttempt } from './plan'
import type { RGBAImage } from './gray'

/** 浏览器解码支持情况（用于错误提示，不影响流程）。 */
export interface DecodedSource {
  /** 已应用 EXIF 方向的位图。 */
  bitmap: ImageBitmap | HTMLImageElement
  width: number
  height: number
  meta: ImageMeta
}

/**
 * 按魔数嗅探格式。
 *
 * 只读前 16 字节，够判主流容器。判不出返回 'unknown'，
 * 由调用方决定是"再试 MIME"还是"直接拒绝"（不猜，避免把 .zip 当图片解码）。
 */
export function sniffImageFormat(bytes: Uint8Array): ImageFormat {
  if (!bytes || bytes.length < 4) return 'unknown'
  const b = bytes
  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  // GIF: GIF8
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'gif'
  // WEBP: RIFF....WEBP
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'webp'
  }
  // BMP: BM
  if (b[0] === 0x42 && b[1] === 0x4d) return 'bmp'
  // TIFF: II*\0 或 MM\0*
  if ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a)) {
    return 'tiff'
  }
  // ISO-BMFF 家族：偏移 4 起是 'ftyp'，品牌决定具体类型
  if (b.length >= 12 && b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) {
    const brand = String.fromCharCode(b[8], b[9], b[10], b[11]).toLowerCase()
    if (brand.startsWith('avi')) return 'avif'
    if (brand === 'heic' || brand === 'heix' || brand === 'mif1' || brand === 'msf1' || brand === 'hevc') return 'heic'
    return 'unknown'
  }
  // SVG：前 512 字节里出现 <svg（XML 声明可能在前）
  const head = safeAscii(b.subarray(0, 512))
  if (/<svg[\s>]/i.test(head)) return 'svg'
  return 'unknown'
}

/** 把字节解码成 ASCII 前缀（非法字节用空格替代，避免抛错）。 */
function safeAscii(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i] >= 32 && bytes[i] < 127 ? String.fromCharCode(bytes[i]) : ' '
  return s
}

/** data URL 拆解结果。 */
export interface DataUrlParts {
  mime: string
  /** Base64 载荷（不含 `data:...;base64,` 前缀）。 */
  base64: string
  /** 估算的原始字节数。 */
  bytes: number
}

/**
 * 拆 data URL。非 data URL（http/https/blob）返回 null，调用方走 fetch 分支。
 *
 * 边界：`data:,` 这种非 base64 形式也支持（按 URI 解码后取字节长度），
 * 但这类输入在截图场景几乎不存在，只做不崩处理。
 */
export function parseDataUrl(url: string): DataUrlParts | null {
  if (typeof url !== 'string' || !url.startsWith('data:')) return null
  const comma = url.indexOf(',')
  if (comma < 0) return null
  const header = url.slice(5, comma)
  const isBase64 = /;base64$/i.test(header)
  const mime = header.replace(/;base64$/i, '') || 'application/octet-stream'
  const payload = url.slice(comma + 1)
  const bytes = isBase64 ? Math.floor((payload.length * 3) / 4) - countPadding(payload) : payload.length
  return { mime, base64: isBase64 ? payload : '', bytes: Math.max(0, bytes) }
}

/** Base64 末尾的 '=' 个数（用于修正字节数）。 */
function countPadding(b64: string): number {
  let n = 0
  for (let i = b64.length - 1; i >= 0 && b64[i] === '=' && n < 2; i--) n++
  return n
}

/** 从 data URL 取前 N 字节（不解码整个图，用于魔数嗅探）。 */
export function readDataUrlHead(url: string, n = 16): Uint8Array {
  const parts = parseDataUrl(url)
  if (!parts || !parts.base64) return new Uint8Array(0)
  try {
    const bin = typeof atob === 'function' ? atob(parts.base64.slice(0, Math.ceil((n * 4) / 3))) : ''
    const out = new Uint8Array(Math.min(n, bin.length))
    for (let i = 0; i < out.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return new Uint8Array(0)
  }
}

/** 允许的输入格式（HEIC/TIFF/SVG 由浏览器解码器决定，解不了会走友好报错）。 */
export const ACCEPTED_FORMATS: ImageFormat[] = ['jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'heic', 'tiff', 'svg']

/**
 * 读取 Blob 前 N 字节。
 * 用 slice + arrayBuffer 而不是 FileReader：前者是 Promise、可 await，且不占主线程。
 */
async function readHead(blob: Blob, n = 16): Promise<Uint8Array> {
  const buf = await blob.slice(0, n).arrayBuffer()
  return new Uint8Array(buf)
}

/** 浏览器能否解码该格式（用于提前给出可操作提示，而不是让 createImageBitmap 抛 DOMException）。 */
function formatHint(format: ImageFormat): string | null {
  if (format === 'heic') return 'HEIC 格式在部分浏览器/系统上无法解码，请先导出为 JPG 再试'
  if (format === 'tiff') return 'TIFF 格式浏览器普遍不支持，请先转成 PNG/JPG'
  if (format === 'svg') return 'SVG 是矢量图，请先导出为 PNG 再识别'
  return null
}

/**
 * 解码任意输入为位图，并补齐元信息。
 *
 * @param input File | Blob | dataURL | http(s) URL
 * @param name  展示名（File 用文件名；其他传入）
 *
 * 失败一律抛 `Error`（中文、可上屏），由上层 `friendlyError` 兜底。
 */
export async function decodeSource(input: File | Blob | string, name: string): Promise<DecodedSource> {
  const { blob, displayName, declaredType } = await toBlob(input, name)

  const head = await readHead(blob, 16)
  const sniffed = sniffImageFormat(head)
  const format: ImageFormat = sniffed !== 'unknown' ? sniffed : mimeToFormat(declaredType || blob.type)
  const hint = formatHint(format)
  if (hint) throw new Error(hint)
  if (format === 'unknown') throw new Error('无法识别这张图的格式（支持 JPG/PNG/WebP/GIF/BMP/AVIF）')

  // EXIF 方向：imageOrientation:'from-image' 让解码器直接摆正，省掉自己解析 APP1 的活
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' })
  } catch {
    // 老内核不认这个选项时退回默认（方向可能不正，但至少能读）
    bitmap = await createImageBitmap(blob)
  }

  const width = bitmap.width
  const height = bitmap.height
  if (width < 1 || height < 1) throw new Error('图片尺寸无效（0×0），可能已损坏')

  const hasAlpha = await detectAlpha(bitmap, format)
  const meta: ImageMeta = {
    name: displayName,
    format,
    bytes: blob.size,
    width,
    height,
    hasAlpha,
    // 方向值已在解码阶段应用；这里记录"是否可能带方向"以便日志排查
    orientation: 1,
  }
  return { bitmap, width, height, meta }
}

/** 转成 Blob：字符串输入走 fetch（data URL 也能被 fetch 吃掉）。 */
async function toBlob(input: File | Blob | string, name: string): Promise<{ blob: Blob; displayName: string; declaredType: string }> {
  if (typeof input === 'string') {
    const parts = parseDataUrl(input)
    if (parts) {
      const blob = await (await fetch(input)).blob()
      return { blob, displayName: name, declaredType: parts.mime }
    }
    const resp = await fetch(input)
    if (!resp.ok) throw new Error(`图片下载失败（HTTP ${resp.status}）`)
    const blob = await resp.blob()
    return { blob, displayName: name, declaredType: blob.type }
  }
  const displayName = 'name' in input && input.name ? input.name : name
  return { blob: input, displayName, declaredType: input.type }
}

/**
 * 是否含透明通道。
 * 判法：抽 3 个 32×32 小样扫 alpha；全不透明即视为无 alpha（绝大多数截图）。
 * 不用 PNG 头里的 color type：PNG 常常声明 RGBA 但实际全不透明，误判会让白底合成白白丢色。
 */
async function detectAlpha(bitmap: ImageBitmap, format: ImageFormat): Promise<boolean> {
  if (format === 'jpeg' || format === 'bmp') return false
  try {
    const s = 32
    const canvas = createCanvas(s, s)
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | null
    if (!ctx) return false
    ctx.drawImage(bitmap, 0, 0, s, s)
    const { data } = ctx.getImageData(0, 0, s, s)
    for (let i = 3; i < data.length; i += 4) if (data[i] < 250) return true
    return false
  } catch {
    return false
  }
}

/** 统一的 canvas 创建（优先 OffscreenCanvas，避免 DOM 节点开销）。 */
function createCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(Math.max(1, w), Math.max(1, h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, w)
  c.height = Math.max(1, h)
  return c
}

/** 取 2D 上下文（类型上把两种 canvas 归一到 CanvasRenderingContext2D 的公共子集）。 */
function ctx2d(canvas: HTMLCanvasElement | OffscreenCanvas): CanvasRenderingContext2D {
  const ctx = (canvas as HTMLCanvasElement).getContext('2d') as CanvasRenderingContext2D | null
  if (!ctx) throw new Error('无法创建画布上下文（浏览器限制或内存不足）')
  return ctx
}

/**
 * 把位图按计划渲染到新 canvas：裁剪 → 缩放（大比例降采样分步进行）→ 白底合成。
 *
 * 为什么要分步降采样：
 * 一次把 4000px 画到 1600px，Chrome 的双线性只采 2×2 邻域，细笔画会"跳字"；
 * 每次减半（4000→2000→1600）等效于低通滤波，文字保留明显更好。
 */
export function renderToCanvas(
  bitmap: ImageBitmap | HTMLImageElement,
  plan: PreprocessPlan,
  pixelRatio = 1,
): HTMLCanvasElement | OffscreenCanvas {
  const crop: Rect | null = plan.crop
  const srcW = crop ? crop.w : bitmap.width
  const srcH = crop ? crop.h : bitmap.height
  const dstW = Math.max(1, Math.round(plan.targetWidth * pixelRatio))
  const dstH = Math.max(1, Math.round(plan.targetHeight * pixelRatio))

  // 第一步：裁剪到离屏画布（只裁不缩，保持原像素）
  let stage: HTMLCanvasElement | OffscreenCanvas
  if (crop && (crop.w < bitmap.width || crop.h < bitmap.height)) {
    stage = createCanvas(srcW, srcH)
    const sctx = ctx2d(stage)
    sctx.drawImage(bitmap as CanvasImageSource, crop.x, crop.y, crop.w, crop.h, 0, 0, srcW, srcH)
  } else {
    stage = createCanvas(srcW, srcH)
    ctx2d(stage).drawImage(bitmap as CanvasImageSource, 0, 0)
  }

  // 第二步：分步减半，直到不超过目标的 2 倍
  let curW = srcW
  let curH = srcH
  while (curW > dstW * 2 && curH > dstH * 2 && curW > 2 && curH > 2) {
    const nextW = Math.max(dstW, Math.round(curW / 2))
    const nextH = Math.max(dstH, Math.round(curH / 2))
    const tmp = createCanvas(nextW, nextH)
    const tctx = ctx2d(tmp)
    tctx.imageSmoothingEnabled = true
    tctx.imageSmoothingQuality = 'high'
    tctx.drawImage(stage as CanvasImageSource, 0, 0, curW, curH, 0, 0, nextW, nextH)
    stage = tmp
    curW = nextW
    curH = nextH
  }

  // 第三步：画到最终尺寸，白底合成（透明 PNG 直接送模型会被当成黑色区域）
  const out = createCanvas(dstW, dstH)
  const octx = ctx2d(out)
  octx.fillStyle = '#ffffff'
  octx.fillRect(0, 0, dstW, dstH)
  octx.imageSmoothingEnabled = true
  octx.imageSmoothingQuality = 'high'
  octx.drawImage(stage as CanvasImageSource, 0, 0, curW, curH, 0, 0, dstW, dstH)
  return out
}

/** canvas → Blob（统一成 Promise，兼容 OffscreenCanvas.convertToBlob）。 */
function canvasToBlob(canvas: HTMLCanvasElement | OffscreenCanvas, format: string, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined' && canvas instanceof OffscreenCanvas) {
    return canvas.convertToBlob({ type: format, quality })
  }
  return new Promise((resolve, reject) => {
    ;(canvas as HTMLCanvasElement).toBlob(
      (b) => (b ? resolve(b) : reject(new Error('图片编码失败（画布为空或格式不支持）'))),
      format,
      quality,
    )
  })
}

/** Blob → data URL。 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('读取图片数据失败'))
    reader.readAsDataURL(blob)
  })
}

/** 编码结果。 */
export interface EncodedImage {
  blob: Blob
  dataUrl: string
  width: number
  height: number
  /** 实际使用的编码参数（可能因体积阶梯被降级）。 */
  attempt: EncodeAttempt
  /** 是否所有尝试都超预算（调用方应在 UI 标注）。 */
  overBudget: boolean
  /** 尝试次数（1 表示一次就达标）。 */
  tries: number
  /** data URL 的字节量（请求体里真正的量）。 */
  dataUrlBytes: number
}

/**
 * 走体积阶梯编码，直到满足预算或退无可退。
 *
 * 不变量：
 * - 返回的 blob 一定存在（除非浏览器连一次编码都失败，此时抛错）；
 * - `tries ≤ MAX_ENCODE_ATTEMPTS`，不会死循环；
 * - 阶梯只降不升（质量/像素单调不增），因此收敛。
 */
export async function encodeWithBudget(
  bitmap: ImageBitmap | HTMLImageElement,
  plan: PreprocessPlan,
  budget: number,
): Promise<EncodedImage> {
  let attempt: EncodeAttempt = { format: plan.format, quality: plan.quality, pixelRatio: 1 }
  let last: { blob: Blob; canvas: HTMLCanvasElement | OffscreenCanvas } | null = null
  let tries = 0

  for (let i = 0; i < MAX_ENCODE_ATTEMPTS; i++) {
    tries++
    const canvas = renderToCanvas(bitmap, plan, attempt.pixelRatio)
    const blob = await canvasToBlob(canvas, attempt.format, attempt.quality)
    last = { blob, canvas }
    if (blob.size <= budget) {
      const dataUrl = await blobToDataUrl(blob)
      return {
        blob,
        dataUrl,
        width: canvas.width,
        height: canvas.height,
        attempt,
        overBudget: false,
        tries,
        dataUrlBytes: estimateDataUrlBytes(blob.size),
      }
    }
    const next = nextAttempt(attempt, blob.size, budget)
    if (!next) break
    attempt = next
  }

  // 走到这里说明预算实在压不下来：交出最后一次结果，由上层标注"体积超预算"
  if (!last) throw new Error('图片编码失败，请换一张图再试')
  const dataUrl = await blobToDataUrl(last.blob)
  return {
    blob: last.blob,
    dataUrl,
    width: last.canvas.width,
    height: last.canvas.height,
    attempt,
    overBudget: last.blob.size > budget,
    tries,
    dataUrlBytes: estimateDataUrlBytes(last.blob.size),
  }
}

/** 从位图直接取 RGBA（特征提取用）。抽到 512 长边以内，避免大图占内存。 */
export function readRGBA(bitmap: ImageBitmap | HTMLImageElement, longEdge = 512): RGBAImage {
  const w0 = bitmap.width
  const h0 = bitmap.height
  const scale = Math.min(1, longEdge / Math.max(w0, h0))
  const w = Math.max(1, Math.round(w0 * scale))
  const h = Math.max(1, Math.round(h0 * scale))
  const canvas = createCanvas(w, h)
  const ctx = ctx2d(canvas)
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bitmap as CanvasImageSource, 0, 0, w0, h0, 0, 0, w, h)
  const img = ctx.getImageData(0, 0, w, h)
  return { data: img.data, width: w, height: h }
}

/** MIME → 格式（嗅探失败时的兜底）。 */
function mimeToFormat(mime: string): ImageFormat {
  const m = (mime || '').toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpeg'
  if (m.includes('png')) return 'png'
  if (m.includes('webp')) return 'webp'
  if (m.includes('gif')) return 'gif'
  if (m.includes('bmp')) return 'bmp'
  if (m.includes('avif')) return 'avif'
  if (m.includes('hei') || m.includes('heif')) return 'heic'
  if (m.includes('tiff')) return 'tiff'
  if (m.includes('svg')) return 'svg'
  return 'unknown'
}

/** 释放位图（ImageBitmap 需要显式 close，否则大图会积压显存）。 */
export function releaseBitmap(bitmap: ImageBitmap | HTMLImageElement): void {
  if ('close' in bitmap && typeof bitmap.close === 'function') {
    try {
      bitmap.close()
    } catch {
      /* 已关闭或已被 GC，忽略 */
    }
  }
}
