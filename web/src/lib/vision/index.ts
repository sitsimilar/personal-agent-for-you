/**
 * 机器视觉模块 · 统一出口
 * ============================================================================
 * 上层只从这里 import，避免依赖具体文件名（后续把 classify 换成小模型时不用改调用方）。
 *
 * 分层（从下到上，箭头表示依赖方向）：
 *   gray ──▶ features ──▶ classify / quality / plan
 *                    └──▶ phash
 *   types 被所有层引用（只读契约）
 *   codec ──▶ pipeline（浏览器 API 只出现在这两层）
 *   prompt / result 只依赖 types，可在 Node 里单测
 */

export * from './types'
export { toGray, resizeGray, downsampleRGBA, fitLongEdge, pixelAt, type RGBAImage, type GrayImage } from './gray'
export { extractFeatures, ANALYSIS_LONG_EDGE, type FeatureExtraction } from './features'
export { classifyScene, dominantScene, isTextLike, SCENE_LABEL, UNCERTAIN_MARGIN, type SceneDecision } from './classify'
export { assessQuality, shouldBlock, summarizeQuality, SHARP_GOOD, SHARP_POOR, SMALL_TEXT_PX } from './quality'
export { perceptualHash, perceptualHashOfGray, hashDistance, isSameImage, SAME_IMAGE_DISTANCE } from './phash'
export {
  planPreprocess,
  planResize,
  firstAttempt,
  nextAttempt,
  estimateDataUrlBytes,
  perImageBudget,
  compressionRatio,
  MAX_EDGE_BY_SCENE,
  PER_IMAGE_BUDGET,
  BATCH_BUDGET,
  MAX_ENCODE_ATTEMPTS,
  type EncodeAttempt,
} from './plan'
export { buildSystemPrompt, buildUserContent, buildJsonRepairPrompt, sceneChecklistText, type PromptImageInfo } from './prompt'
export { parseVisionResult, toMarkdown } from './result'
export { sniffImageFormat, parseDataUrl, readDataUrlHead, decodeSource, encodeWithBudget, readRGBA, blobToDataUrl } from './codec'
export { prepareVisionInput, toPromptImages, summarizeBundle, MAX_IMAGES, type PrepareOutcome, type PrepareFailure } from './pipeline'
