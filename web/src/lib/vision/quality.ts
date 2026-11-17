/**
 * 机器视觉模块 · 质量门禁
 * ============================================================================
 * 目标：**在调用模型之前**把「注定识别不好」的图拦下来，并给出可执行的改进建议。
 *
 * 为什么值得做：
 * - 旧实现拿到图就直接送模型，糊图/眩光图会得到一段"看起来像那么回事"的幻觉，
 *   用户无法分辨是图不行还是模型不行；
 * - 一次视觉调用的成本远高于本地算 0.5MP 特征，先拦后问更省。
 *
 * 阈值来源：qa/vision-bench 在合成样本（锐利文字 / 高斯模糊 / 眩光 / 小字）
 * 上扫了一遍，取值见下方常量注释。真实分布仍需 P1-15 的 50 张评测集校准——
 * 这里给的是「保守阈值」（宁可判 fair 也不误杀），并在报告里标注为待校准。
 */

import type { ImageMeta, QualityIssue, QualityReport, SceneKind, VisionFeatures } from './types'

/**
 * 锐度阈值（features.sharpness = 原生拉普拉斯方差 / 1000）。
 * 合成样本实测：锐利 14px 文字截图 ≈ 6~18；σ=1.2 高斯模糊 ≈ 0.6~1.2；σ=3 ≈ 0.08~0.2。
 * 因此 poor < 0.35、good ≥ 1.2 能把"明显糊"和"正常"分开，中间留一档 fair。
 */
export const SHARP_POOR = 0.35
export const SHARP_GOOD = 1.2

/** 眩光阈值：亮度 >250 的像素占比超过 12% 视为过曝（屏幕反光常见 8%~25%）。 */
export const GLARE_RATIO = 0.12

/** 低对比阈值：p95-p5 跨度低于 0.18（≈46 级）时文字与底色太接近。 */
export const LOW_CONTRAST = 0.18

/** 文字行高下限（原图像素）：低于 7px 时模型基本读不出字，建议局部放大或重截。 */
export const SMALL_TEXT_PX = 7

/** 极窄长图判定：长宽比 >8 时视觉模型会大幅降采样，两侧内容容易丢。 */
export const EXTREME_ASPECT = 8

/** 空白图判定：边缘密度与亮度标准差同时极低。 */
export const BLANK_EDGE = 0.004
export const BLANK_STD = 6

/**
 * 评估一张图。
 *
 * @param f     已提取的特征
 * @param meta  原图元信息（尺寸/字节数）
 * @param scene 场景（可选）。**眩光只在"可能是拍照"的场景下判**——
 *              截图不可能有反光，白底页面的 255 像素不是过曝。
 *              这一步把旧版「所有白底截图都被报眩光」的误报去掉了。
 * @returns verdict + 0..100 分 + 问题清单（每条都带建议动作）
 */
export function assessQuality(f: VisionFeatures, meta: ImageMeta, scene: SceneKind = 'unknown'): QualityReport {
  const issues: QualityIssue[] = []
  let penalty = 0

  // ---- 1. 空白图：截到了纯色区域（常见于截错窗口）----
  if (f.edgeDensity < BLANK_EDGE && f.stdLuma < BLANK_STD) {
    issues.push({
      code: 'blank',
      message: '这张图几乎是纯色，没有可识别的内容。',
      advice: '请确认截到的是目标窗口/区域，而不是空白背景。',
    })
    penalty += 60
  }

  // ---- 2. 太小：解码后长边不足 120px，模型看不清结构 ----
  const longEdge = Math.max(meta.width, meta.height)
  if (longEdge < 120) {
    issues.push({
      code: 'tiny',
      message: `图片只有 ${meta.width}×${meta.height}，细节不足。`,
      advice: '换一张更大的原图，或放大后再截。',
    })
    penalty += 30
  }

  // ---- 3. 糊：只在"有结构"的图上判，纯色图已按空白处理 ----
  if (f.edgeDensity >= BLANK_EDGE) {
    if (f.sharpness < SHARP_POOR) {
      issues.push({
        code: 'blurry',
        message: '画面偏模糊，文字边缘发虚。',
        advice: '重新截图（截图比拍屏幕清晰）；拍屏幕时把手机固定住再按快门。',
      })
      penalty += 35
    } else if (f.sharpness < SHARP_GOOD) {
      // fair 档不报问题，只在分数上体现；避免每张图都弹提示
      penalty += 12
    }
  }

  // ---- 4. 眩光/过曝：屏幕反光会让局部整块丢失 ----
  // 只在「照片/手写/未判定」时检查：这类图才可能拍到反光。
  // 代码/界面/文档/表格/图表是截图，白底再亮也不是过曝，判它等于制造假警报。
  const photoLike = scene === 'photo' || scene === 'handwriting' || scene === 'unknown'
  if (photoLike && f.brightClipRatio > GLARE_RATIO) {
    const pct = Math.round(f.brightClipRatio * 100)
    issues.push({
      code: 'glare',
      message: `有约 ${pct}% 的像素过曝，可能是反光或亮度太高。`,
      advice: '避开直射光、调低屏幕亮度，或直接截图而不是拍屏幕。',
    })
    penalty += f.brightClipRatio > 0.25 ? 30 : 15
  }

  // ---- 5. 低对比：浅灰字 + 白底，或深灰字 + 黑底 ----
  // 加 edgeDensity 门限：界面截图本来就"淡"（大量留白 + 浅灰分隔线），
  // 没有笔画密度支撑的"低对比"不是问题，是设计风格。
  if (f.contrastSpread < LOW_CONTRAST && f.stdLuma > 1 && f.edgeDensity > 0.05) {
    issues.push({
      code: 'low_contrast',
      message: '文字与背景的反差较小。',
      advice: '换浅色/深色主题，或提高系统对比度后再截。',
    })
    penalty += 15
  }

  // ---- 6. 字太小：行高 <7px 时识别率断崖式下降（尤其代码里的标点）----
  if (f.lineHeightPx > 0 && f.lineHeightPx < SMALL_TEXT_PX && f.edgeDensity > 0.03) {
    issues.push({
      code: 'too_small_text',
      message: `估计文字行高约 ${f.lineHeightPx.toFixed(1)}px，偏小。`,
      advice: '只截关键区域（放大字号），或发原图而不是被压缩过的转发图。',
    })
    penalty += 20
  }

  // ---- 7. 极窄长图：截了整页长网页 ----
  const aspect = meta.width / Math.max(1, meta.height)
  const ratio = aspect >= 1 ? aspect : 1 / aspect
  if (ratio > EXTREME_ASPECT) {
    issues.push({
      code: 'extreme_aspect',
      message: `长宽比约 ${ratio.toFixed(0)}:1，缩放到模型输入后细节会被压缩。`,
      advice: '分屏截成几张，或只截关键片段。',
    })
    penalty += 12
  }

  const score = Math.max(0, Math.min(100, 100 - penalty))
  // poor 的判定：出现"结构性"问题（空白/太小/糊）或分数低于 55
  const hard = issues.some((i) => i.code === 'blank' || i.code === 'tiny' || i.code === 'blurry')
  const verdict: QualityReport['verdict'] = hard || score < 55 ? 'poor' : score < 82 ? 'fair' : 'good'
  return { verdict, score, issues }
}

/** 是否值得继续送模型：poor 时 UI 应默认拦一下（但允许用户强传）。 */
export function shouldBlock(q: QualityReport): boolean {
  return q.verdict === 'poor'
}

/** 质量问题汇总成一行（写日志/状态 JSON 用）。 */
export function summarizeQuality(q: QualityReport): string {
  if (q.issues.length === 0) return `${q.verdict}(${q.score})`
  return `${q.verdict}(${q.score}): ${q.issues.map((i) => i.code).join('+')}`
}
