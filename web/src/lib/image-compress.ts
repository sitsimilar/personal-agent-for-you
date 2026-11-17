/**
 * 上传前压缩（浏览器 Canvas）。
 *
 * ## 为什么要压
 * 图片消耗三项云资源：**文件读写请求**（按次）、**标准存储容量**（按月算体积）、
 * **下载流量**（每次看都算）。手机随手拍一张 4–8MB，直接上传后再被查看几次，
 * 流量成本远高于压缩带来的那点清晰度损失。
 *
 * ## 规则
 * 1. 最长边 **≤1280**（手机屏幕 3x 也够看）；
 * 2. 统一转 **JPEG 0.82**（PNG 截图也转，透明区域铺白底，避免转 JPEG 后变黑）；
 * 3. **小图免压**：已经是 JPEG、且 ≤300KB、且最长边 ≤1280 —— 原样返回，不做二次编码；
 * 4. 压缩失败（老 WebView 没有 `createImageBitmap`）时降级为原图，绝不因此阻断上传。
 *
 * 尺寸计算是纯函数（可单测）；Canvas 部分依赖浏览器环境。
 */
import { computeThumbnailSize } from './thumbnail'

/** 上传图最长边上限。 */
export const UPLOAD_MAX_EDGE = 1280
/** JPEG 质量。 */
export const UPLOAD_JPEG_QUALITY = 0.82
/** 小于这个体积且尺寸达标就跳过压缩。 */
export const SKIP_COMPRESS_BYTES = 300 * 1024

export interface CompressedImage {
  /** 实际要上传的数据。 */
  blob: Blob
  /** 扩展名（jpg / png / webp）。 */
  ext: string
  /** MIME 类型。 */
  mime: string
  /** 是否真的压缩过（用于统计与调试）。 */
  compressed: boolean
  /** 原始大小（字节）。 */
  originalSize: number
}

/** 从文件名取扩展名（jpeg 归一成 jpg）。 */
export function extOfName(name: string): string {
  const idx = name.lastIndexOf('.')
  const ext = idx === -1 ? '' : name.slice(idx + 1).toLowerCase()
  return ext === 'jpeg' ? 'jpg' : ext
}

/** 目标尺寸：最长边不超过 maxEdge，且不放大。 */
export function computeUploadSize(
  srcW: number,
  srcH: number,
  maxEdge: number = UPLOAD_MAX_EDGE,
): { w: number; h: number } {
  return computeThumbnailSize(srcW, srcH, maxEdge)
}

/** 是否可以跳过压缩（已经是够小的 JPEG）。 */
export function canSkipCompress(input: {
  mime: string
  size: number
  width: number
  height: number
}): boolean {
  if (input.mime !== 'image/jpeg') return false
  if (input.size > SKIP_COMPRESS_BYTES) return false
  return Math.max(input.width, input.height) <= UPLOAD_MAX_EDGE
}

/**
 * 压缩一张图片供上传。任何异常都降级为原图（返回原 File 的 Blob）。
 */
export async function compressImageForUpload(file: File): Promise<CompressedImage> {
  const originalSize = file.size
  const fallback: CompressedImage = {
    blob: file,
    ext: extOfName(file.name) || 'jpg',
    mime: file.type || 'image/jpeg',
    compressed: false,
    originalSize,
  }

  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return fallback

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
    if (canSkipCompress({ mime: file.type, size: file.size, width: bitmap.width, height: bitmap.height })) {
      return fallback
    }
    const { w, h } = computeUploadSize(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return fallback
    // 转 JPEG 会丢 alpha：先铺白底，否则透明 PNG 会变成黑块
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(bitmap, 0, 0, w, h)
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((b) => resolve(b), 'image/jpeg', UPLOAD_JPEG_QUALITY)
    })
    if (!blob || blob.size >= originalSize) return fallback
    return { blob, ext: 'jpg', mime: 'image/jpeg', compressed: true, originalSize }
  } catch {
    return fallback
  } finally {
    bitmap?.close?.()
  }
}
