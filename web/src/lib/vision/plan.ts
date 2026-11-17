/**
 * 机器视觉模块 · 预处理决策 + 体积阶梯
 * ============================================================================
 * 这一层回答四个问题，并把答案写成可测试的纯函数：
 *   1. 要不要裁掉空白边？（内容包围盒占比）
 *   2. 缩到多大？（按场景给长边上限；视觉模型的「高清档」普遍在 1568px 附近）
 *   3. 用小字要不要放大？（行高 <阈值 且 原图不大时 2× 放大，否则放大只是变糊）
 *   4. 编码成什么格式、超预算时怎么退？（阶梯：先保画质再降质量，最后才缩像素）
 *
 * 「超预算」是旧实现最大的稳定性缺口：一张 4000×3000 的 PNG 截图转 dataURL 后
 * 超过 5MB，请求 body 会顶到网关上限，表现为"偶发失败"，用户只看到"识别失败"。
 * 阶梯把体积压到硬预算内，并且每一步都是显式可解释的。
 */

import type { ImageMeta, PreprocessPlan, Rect, SceneKind, VisionFeatures } from './types'
import { isTextLike } from './classify'
import type { QualityReport } from './types'

/** 单张图送入模型的字节预算（base64 前的原始字节）。1.5MB 与计划里「单张请求 ≤1.5MB」一致。 */
export const PER_IMAGE_BUDGET = 1.5 * 1024 * 1024

/** 整批（≤5 张）总预算。 */
export const BATCH_BUDGET = 4 * 1024 * 1024

/** 单张最多尝试的编码次数（防止体积阶梯死循环）。 */
export const MAX_ENCODE_ATTEMPTS = 6

/**
 * 各场景的长边上限。
 * - 文字类 1600：笔画细节最吃分辨率，1600 是「再高收益递减、再低掉字」的拐点；
 * - 界面 1440：控件位置与文案都重要，但对 1px 边框不敏感；
 * - 图表 1600：要读坐标轴小字；
 * - 照片 1280：语义为主体，压缩省下的预算留给多图；
 * - 示意图 1440：箭头与标签不能糊。
 */
export const MAX_EDGE_BY_SCENE: Record<SceneKind, number> = {
  code: 1600,
  error: 1600,
  table: 1600,
  document: 1600,
  handwriting: 1600,
  ui: 1440,
  chart: 1600,
  diagram: 1440,
  photo: 1280,
  chat: 1440,
  unknown: 1440,
}

/** 小字放大的触发线：原图行高低于此值时考虑放大。 */
export const UPSCALE_LINE_PX = 10

/**
 * 裁剪的「保留面积」下限：检测到的内容区小于整图 35% 时不裁。
 *
 * 理由是稳定性：包围盒在 480 长边的降采样图上算，细笔画文字可能被采样漏掉，
 * 导致包围盒只覆盖一小块 —— 一旦照它裁，整张图会被切掉大半（实测把 2560×1440
 * 的界面裁成 340×258）。而"真实文档留白超过 65%"的情况极少，
 * 宁可少裁（只是多送些空白）也不能误裁（信息直接丢失）。
 */
export const MIN_CROP_KEEP = 0.35

/**
 * 裁剪后每个方向至少要保留的比例：防止出现"细长条"裁剪框
 * （例如只框住一条顶栏），这类框几乎都是检测噪声。
 */
export const MIN_CROP_SIDE = 0.4

/** 放大倍数上限（2× 已经能把 6px 行高抬到 12px；再高只是插值模糊）。 */
export const MAX_UPSCALE = 2

/**
 * 计算目标尺寸。
 *
 * @param srcW/srcH 裁剪后的源尺寸
 * @param maxEdge   长边上限
 * @param upscale   放大倍数（1 或 2）
 * @returns 目标宽高与缩放系数（scale>1 表示放大）
 *
 * 边界：源尺寸非法时返回 1×1（调用方据 width=1 判失败，不抛异常）。
 */
export function planResize(
  srcW: number,
  srcH: number,
  maxEdge: number,
  upscale = 1,
): { width: number; height: number; scale: number } {
  const w = Math.max(0, Math.round(srcW))
  const h = Math.max(0, Math.round(srcH))
  if (w <= 0 || h <= 0) return { width: 1, height: 1, scale: 1 }

  const longEdge = Math.max(w, h)
  // 先按长边缩，再乘放大倍数；放大后仍不得超过 maxEdge 的 1.6 倍（超过就是浪费 token）
  let scale = Math.min(1, maxEdge / longEdge) * upscale
  if (longEdge * scale > maxEdge * 1.6) scale = (maxEdge * 1.6) / longEdge
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
    scale,
  }
}

/**
 * 生成预处理计划。
 *
 * 决策顺序（后面的步骤能看到前面的结论）：
 *   裁剪 → 定长边 → 决定放大 → 定格式/质量。
 *
 * @param meta     原图元信息
 * @param f        特征
 * @param q        质量（只用它的 verdict，用来决定"糊图不放大"）
 * @param scene    场景（决定长边与格式）
 * @param box      内容包围盒（features.contentBox）
 */
export function planPreprocess(
  meta: ImageMeta,
  f: VisionFeatures,
  q: QualityReport,
  scene: SceneKind,
  box: Rect | null,
): PreprocessPlan {
  const reasons: string[] = []
  const maxEdge = MAX_EDGE_BY_SCENE[scene] ?? 1440

  // ---- 1. 裁剪：**只裁文档/表格/图表** ----
  // 这三类的空白边是"页面留白"，裁掉只是提升有效分辨率；
  // 界面（顶栏/侧栏本身就是内容）、代码（终端铺满）、报错（弹窗位置是线索）、
  // 照片/示意图（怕切主体与箭头）一律不裁——旧版对界面也裁，会把导航栏裁掉。
  const croppable = scene === 'document' || scene === 'table' || scene === 'chart'
  let crop: Rect | null = null
  if (box && croppable) {
    const areaRatio = (box.w * box.h) / (meta.width * meta.height)
    const sideRatio = Math.min(box.w / meta.width, box.h / meta.height)
    if (areaRatio < 0.85 && areaRatio >= MIN_CROP_KEEP && sideRatio >= MIN_CROP_SIDE) {
      crop = box
      reasons.push(`裁掉空白边（保留 ${(areaRatio * 100).toFixed(0)}% 面积）`)
    } else if (areaRatio < MIN_CROP_KEEP || sideRatio < MIN_CROP_SIDE) {
      // 检测框小得不可信：不裁，但把原因说出来，方便排查"为什么没裁白边"
      reasons.push('内容区检测结果过小，跳过裁剪')
    }
  }

  const srcW = crop ? crop.w : meta.width
  const srcH = crop ? crop.h : meta.height

  // ---- 2. 放大：小字 + 文字类 + 原图本身不大 + 不糊 ----
  let upscale = 1
  const smallText = f.lineHeightPx > 0 && f.lineHeightPx < UPSCALE_LINE_PX
  if (smallText && isTextLike(scene) && Math.max(srcW, srcH) < 1600 && q.verdict !== 'poor') {
    upscale = MAX_UPSCALE
    reasons.push(`行高 ${f.lineHeightPx.toFixed(1)}px 偏小，${MAX_UPSCALE}× 放大`)
  } else if (smallText) {
    reasons.push(`行高 ${f.lineHeightPx.toFixed(1)}px 偏小但不放大（放大只会更糊或超预算）`)
  }

  const size = planResize(srcW, srcH, maxEdge, upscale)
  if (size.scale < 1) reasons.push(`长边缩到 ${maxEdge}px`)
  if (size.scale === 1 && upscale === 1) reasons.push('尺寸不变')

  // ---- 3. 格式：文字类用 PNG 保笔画；其余用 WebP（同画质体积约为 PNG 的 1/4）----
  const textish = isTextLike(scene)
  const format: PreprocessPlan['format'] = textish ? 'image/png' : 'image/webp'
  // PNG 的 quality 无效；WebP 文字类给 0.92（保笔画），照片类 0.86（省体积）
  const quality = textish ? 1 : scene === 'photo' ? 0.86 : 0.92
  reasons.push(textish ? 'PNG 编码（保文字边缘）' : `WebP q=${quality}（体积/画质折中）`)

  return {
    crop,
    targetWidth: size.width,
    targetHeight: size.height,
    scale: size.scale,
    format,
    quality,
    reasons,
  }
}

/** 一次编码尝试（格式 + 质量 + 像素比例）。 */
export interface EncodeAttempt {
  format: 'image/png' | 'image/webp' | 'image/jpeg'
  /** 0..1；PNG 忽略。 */
  quality: number
  /** 相对目标尺寸的像素比例（1 = 用计划尺寸）。 */
  pixelRatio: number
}

/** 首次尝试 = 计划里的格式与质量。 */
export function firstAttempt(plan: PreprocessPlan): EncodeAttempt {
  return { format: plan.format, quality: plan.quality, pixelRatio: 1 }
}

/**
 * 体积阶梯：给定上一次编码结果，返回下一次尝试；已达标或退无可退时返回 null。
 *
 * 退让顺序（**先牺牲画质、再换编码器、最后牺牲分辨率**），共 5 次让步：
 *   1. PNG → WebP q0.90（PNG 没有质量旋钮，只能换编码器）；
 *   2. WebP → JPEG q0.80（同画质下 JPEG 体积约为 WebP 的 60~75%）；
 *   3. JPEG q0.80 → q0.65（文字仍可读的下限，再低笔画会糊成一团）；
 *   4. 降像素到 60%（此时画质已不可再降）；
 *   5. 仍超预算 → 放弃（返回 null，调用方按"尽力而为"送出去并在 UI 标注体积告警）。
 *
 * 步数刻意压到 5：`MAX_ENCODE_ATTEMPTS = 6` 恰好容纳"首次 + 5 次让步"，
 * 不会出现"阶梯还没走完就被上限截断"的浪费（上一版 0.12 一档的细粒度就有这问题）。
 *
 * @param prev  上一次尝试
 * @param bytes 上一次编码得到的字节数
 * @param budget 预算
 */
export function nextAttempt(prev: EncodeAttempt, bytes: number, budget: number): EncodeAttempt | null {
  if (bytes <= budget) return null // 已达标

  // 1. PNG 无质量旋钮 → 换 WebP 高质量档（对文字也够用）
  if (prev.format === 'image/png') {
    return { format: 'image/webp', quality: 0.9, pixelRatio: prev.pixelRatio }
  }
  // 2. WebP → JPEG
  if (prev.format === 'image/webp') {
    return { format: 'image/jpeg', quality: 0.8, pixelRatio: prev.pixelRatio }
  }
  // 3. JPEG 降质量
  if (prev.quality > 0.65) {
    return { ...prev, quality: 0.65 }
  }
  // 4. 降像素（降完把质量回填到 0.8：像素少了，画质预算可以还回去）
  if (prev.pixelRatio > 0.6) {
    return { format: 'image/jpeg', quality: 0.8, pixelRatio: 0.6 }
  }
  // 5. 放弃
  return null
}

/** data URL 的字节估算：Base64 膨胀 4/3，加头部约 32 字节。 */
export function estimateDataUrlBytes(bytes: number): number {
  return Math.ceil(bytes / 3) * 4 + 32
}

/** 按张数分摊整批预算：单张不超过 PER_IMAGE_BUDGET，总数不超过 BATCH_BUDGET。 */
export function perImageBudget(count: number): number {
  const n = Math.max(1, Math.floor(count))
  return Math.min(PER_IMAGE_BUDGET, Math.floor(BATCH_BUDGET / n))
}

/** 压缩比（用于报告「体积降了多少」）。返回 0..1，越小说明压得越狠。 */
export function compressionRatio(before: number, after: number): number {
  if (before <= 0) return 1
  return Math.max(0, Math.min(1, after / before))
}
