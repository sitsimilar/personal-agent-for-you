/**
 * 机器视觉模块 · 类型契约
 * ============================================================================
 * 这一层只放「数据结构」，不含任何浏览器 API 与副作用，便于在 Node（qa/）里单测。
 *
 * 设计要点：
 * 1. 输入、特征、判定、预处理计划、模型结果，五段之间用显式类型衔接，
 *    任何一段都可以单独替换（比如把启发式分类器换成小模型），其余不动。
 * 2. 所有「可能缺失」的字段一律用 `null` 而非 `undefined`——
 *    JSON 往返（持久化、缓存、日志）后 `undefined` 会被丢掉，`null` 不会。
 */

/** 支持的图像容器格式（按魔数嗅探，不看扩展名与 MIME）。 */
export type ImageFormat = 'jpeg' | 'png' | 'gif' | 'webp' | 'bmp' | 'avif' | 'heic' | 'tiff' | 'svg' | 'unknown'

/** 场景类别：决定「问什么」以及「按哪种结构解析」。 */
export type SceneKind =
  | 'code' // 代码截图（编辑器 / 终端 / diff）
  | 'error' // 报错弹窗、堆栈、红色告警条
  | 'ui' // 应用界面、表单、列表
  | 'chat' // 对话气泡
  | 'table' // 表格、报表
  | 'chart' // 折线/柱状/饼图等可视化
  | 'document' // 文档、文章、PDF 页
  | 'diagram' // 流程图、架构图、白板
  | 'photo' // 实拍照片
  | 'handwriting' // 手写/白板手写
  | 'unknown' // 判不出（会退化为通用清单）

/** 识别结果的可信状态：模型给了多少、能不能用。 */
export type VisionStatus = 'ok' | 'partial' | 'unreadable'

/** 图像源元信息（解码后填充）。 */
export interface ImageMeta {
  /** 用户可见名称（用于报告与缓存 key）。 */
  name: string
  /** 嗅探出的真实容器格式。 */
  format: ImageFormat
  /** 原始字节数（压缩后，不是解码后的像素量）。 */
  bytes: number
  /** 解码后的像素尺寸（EXIF 方向已应用）。 */
  width: number
  height: number
  /** 是否带透明通道（会决定落白底还是保留）。 */
  hasAlpha: boolean
  /** EXIF 方向值（1 表示无需旋转；已由解码器应用，这里仅留档）。 */
  orientation: number
}

/**
 * 低层视觉特征。全部是 0..1 或像素单位，不含语义。
 * 这些数值既用于场景分类，也用于质量判定与预处理决策。
 */
export interface VisionFeatures {
  /** 分析分辨率（长边被压到 ANALYSIS_LONG_EDGE 以内）后的宽高。 */
  width: number
  height: number
  /** 分析图相对原图的缩放比（原图宽 / 分析图宽），用于把像素量换算回原尺寸。 */
  scaleToOriginal: number
  /** 平均亮度 0..255。 */
  meanLuma: number
  /** 亮度标准差（对比度粗指标）。 */
  stdLuma: number
  /** 暗底判定：均值 < 96 且暗像素占比 > 0.5。 */
  darkBg: boolean
  /** 边缘密度：Sobel 幅值超阈值像素占比 0..1。 */
  edgeDensity: number
  /** 强边缘密度：阈值更高的那档，用来区分「噪点」与「结构线」。 */
  strongEdgeDensity: number
  /** 行方向墨迹的周期性 0..1（文字行会周期性出现）。 */
  linePeriodicity: number
  /** 有墨迹的行占比 0..1（文档满版 ≈0.45，弹窗/界面 ≈0.1–0.2）。 */
  inkRowCoverage: number
  /** 由周期反推的文字行高（换算回原图像素；判不出为 0）。 */
  lineHeightPx: number
  /** 平均饱和度 0..1。 */
  saturationMean: number
  /** Hasler-Süsstrunk 色彩丰富度（经验值 0..~150）。 */
  colorfulness: number
  /** 4bit 量化后的颜色占用比 0..1（越小越像「纯色 + 文字」）。 */
  distinctColorRatio: number
  /** 高光溢出比例（亮度 > 250 的像素占比），眩光/过曝指标。 */
  brightClipRatio: number
  /** 暗部死黑比例（亮度 < 5）。 */
  darkClipRatio: number
  /** 锐度：拉普拉斯方差归一化到 0..1（越小越糊）。 */
  sharpness: number
  /** 对比度跨度 (p95 - p5)/255。 */
  contrastSpread: number
  /** 色相熵 0..1（12 桶归一化）。 */
  hueEntropy: number
  /** 轴对齐强度 0..1：水平/垂直两个方向的最长直线段占边长比例的**较大值**。 */
  axisRatio: number
  /** 水平方向最长直线段占宽度的比例（界面顶栏/分隔线、表格横线）。 */
  axisH: number
  /** 垂直方向最长直线段占高度的比例（表格竖线、侧边栏边框）。 */
  axisV: number
  /**
   * 「真红」像素占比（色相 345°~15° 且饱和 ≥0.5）——报错条/危险按钮的颜色。
   * 橙色、暖黄**不算**：它们会把日落、暖光室内、食物特写误判成"满屏报错"。
   */
  redRatio: number
  /** 亮度双峰性 0..1（气泡、卡片式界面常见两种底色）。 */
  lumaBimodality: number
}

/** 单条质量问题的机读码 + 人话 + 建议动作。 */
export interface QualityIssue {
  code:
    | 'blurry'
    | 'glare'
    | 'low_contrast'
    | 'too_small_text'
    | 'extreme_aspect'
    | 'blank'
    | 'tiny'
    | 'huge'
  /** 面向用户的一句话说明（中文，可直接上屏）。 */
  message: string
  /** 建议动作（例如「重拍时对准屏幕」），用于 UI 提示。 */
  advice: string
}

/** 质量评估结果。 */
export interface QualityReport {
  /** good=可直接识别；fair=能识别但可能漏字；poor=大概率不可用。 */
  verdict: 'good' | 'fair' | 'poor'
  /** 0..100 的综合可用分（仅用于排序/展示，不参与业务判断）。 */
  score: number
  issues: QualityIssue[]
}

/** 预处理计划：把「要不要裁、缩到多大、用什么格式」显式化，便于测试与解释。 */
export interface PreprocessPlan {
  /** 是否裁掉大块空白边（内容包围盒）。 */
  crop: Rect | null
  /** 目标宽高（已含裁剪与缩放）。 */
  targetWidth: number
  targetHeight: number
  /** 缩放系数（1 = 不缩放；>1 表示小字放大）。 */
  scale: number
  /** 编码格式：文字类优先 PNG 保笔画，照片类优先 WebP。 */
  format: 'image/png' | 'image/webp' | 'image/jpeg'
  /** 编码质量 0..1（PNG 忽略）。 */
  quality: number
  /** 决策理由，写进日志与状态 JSON，便于复盘。 */
  reasons: string[]
}

/** 矩形（像素，左上原点）。 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** 分块结构：对应「识图结果结构化」的 blocks 契约（与 P1-10 一致）。 */
export interface VisionBlock {
  /** 语义类型；未识别到具体类型时用 text。 */
  type: 'title' | 'paragraph' | 'table' | 'figure' | 'formula' | 'code' | 'list' | 'text'
  /** 阅读顺序（从 0 开始，模型给出；缺省时按数组下标）。 */
  order: number
  /** 文本内容（图/图表可为空）。 */
  text: string | null
  /** 表格行/列数（仅 table 块）。 */
  rows: number | null
  cols: number | null
}

/** 覆盖度：模型「该看到」与「实际读到」的差额，用于判断是否降级。 */
export interface VisionCoverage {
  /** 期望字段数（模型自评）；无法判断时为 null。 */
  expected: number | null
  /** 缺失的字段名（人可读）。 */
  missing: string[]
  /** 读不清的字段名（有区域但无法辨认）。 */
  unreadable: string[]
  /** 缺失+读不清 占 expected 的比例 0..1；expected 为 null 时按 0 处理。 */
  ratio: number
}

/** 第一段：输入理解（图里有什么、用户代码是什么、差在哪）。 */
export interface VisionUnderstanding {
  /** 一句话总体判断。 */
  summary: string
  /** 证据：必须能在图里或用户代码里逐条指认。 */
  evidence: string[]
  /** 图内文本/代码的逐字转写（关键行，不要求全文）。 */
  transcribed: string[]
}

/** 第二段：问题定位（指到文件/行/符号，并说明为什么）。 */
export interface VisionLocalization {
  /** 用户提供的代码里的文件名；未提供代码时为 null。 */
  file: string | null
  /** 行号（1 基）；无法定位为 null。 */
  line: number | null
  /** 相关符号（函数名/变量名/组件名）。 */
  symbol: string | null
  /** 定位依据（图内证据 ↔ 代码片段的对应关系）。 */
  reason: string
  /** 0..1；模型自评，低于 0.5 时 UI 应提示补信息。 */
  confidence: number
}

/** 第三段：解决方案（可执行步骤 + 补丁 + 验证 + 边界）。 */
export interface VisionSolution {
  /** 按顺序执行的步骤，每条一句。 */
  steps: string[]
  /** 最小补丁（unified diff 或代码块文本）；不需要改代码时为 null。 */
  patch: string | null
  /** 改完怎么验证（可勾选的动作）。 */
  verification: string[]
  /** 适用边界：什么情况下这个方案不成立。 */
  boundaries: string[]
}

/** 模型结构化输出的完整结果。 */
export interface VisionResult {
  /** schema 版本：结构变更时 +1，便于旧缓存失效。 */
  schemaVersion: 2
  /** 场景（模型可覆盖前置分类器的判断）。 */
  scene: SceneKind
  status: VisionStatus
  coverage: VisionCoverage
  blocks: VisionBlock[]
  understanding: VisionUnderstanding
  localization: VisionLocalization
  solution: VisionSolution
  /** 还缺什么信息才能定论（最多 3 条）。 */
  needMoreInfo: string[]
  /** 原始文本（解析失败时用于兜底展示，不参与业务逻辑）。 */
  raw: string
  /** 是否由 JSON 解析而来（false 表示降级为纯文本，UI 需换一种展示）。 */
  structured: boolean
}

/** 单张图的准备结果（送模型前）。 */
export interface PreparedImage {
  /** 展示用标签，如「图1」。 */
  label: string
  /** 归一化后的 data URL（已缩放/裁剪/转码）。 */
  dataUrl: string
  /** 归一化后的字节数。 */
  bytes: number
  /** 归一化后的尺寸。 */
  width: number
  height: number
  /** 原始元信息。 */
  meta: ImageMeta
  /** 原始字节数（用于算压缩比）。 */
  originalBytes: number
  /** 特征。 */
  features: VisionFeatures
  /** 质量。 */
  quality: QualityReport
  /** 场景判定结果（含完整打分表，便于 UI 展示"为什么按表格问"）。 */
  scene: SceneKind
  sceneScores: Array<{ scene: SceneKind; score: number }>
  /** 预处理计划（实际执行的那一份）。 */
  plan: PreprocessPlan
  /** 感知哈希（批内去重用）。 */
  phash: string
}

/** 整批准备结果。 */
export interface PreparedBundle {
  images: PreparedImage[]
  /** 主导场景（批次内最高票）。 */
  scene: SceneKind
  /** 场景判定明细（便于解释「为什么按表格清单问」）。 */
  sceneScores: Array<{ scene: SceneKind; score: number }>
  /** 批级去重后的指纹（缓存 key）。 */
  fingerprint: string
  /** 耗时与体积账。 */
  metrics: {
    /** 送入前总字节。 */
    bytesBefore: number
    /** 送入后总字节。 */
    bytesAfter: number
    /** 本地预处理耗时（ms）。 */
    prepMs: number
    /** 批内被判为重复而丢弃的张数。 */
    deduped: number
  }
}

/** 调用参数。 */
export interface VisionRequest {
  /** 图片源（最多 5 张）。 */
  images: Array<File | Blob | string>
  /** 用户提供的代码（与图对照）。 */
  code?: string
  /** 代码语言提示（可选，用于让模型按语法读）。 */
  codeLanguage?: string
  /** 用户补充的上下文（自然语言）。 */
  context?: string
  /** 用户的具体问题（可选；为空时模型按「推断需求」处理）。 */
  question?: string
  /** 强制指定场景（用户手动纠正分类时用）。 */
  sceneOverride?: SceneKind
}
