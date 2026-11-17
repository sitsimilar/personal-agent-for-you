/**
 * 机器视觉模块 · 场景分类（可解释的加权证据，不是黑盒模型）
 * ============================================================================
 * 为什么用规则而不是小模型：
 * - 这一步要「在浏览器里、几十毫秒内、无网络」给出结果，规则是唯一选择；
 * - 分类结果直接决定后面问模型的清单（代码/表格/图表各问一套），
 *   出错要能一眼看出是哪条证据导致的，规则比概率模型好排查；
 * - 规则只做「先验」，模型（LLM）可以在结果里覆盖它——`scene` 字段允许模型改写。
 *
 * 局限（必须写清，别对外宣称"能识别一切"）：
 * - 它靠排版信号（行周期、长直线、颜色分布），**不理解内容语义**；
 * - 深色代码截图 + 深色终端照片、无网格的 Markdown 表格、纯文字流程图，
 *   这三类容易互相误判，所以界面在低置信度时允许用户手动改类别。
 */

import type { SceneKind, VisionFeatures } from './types'

/** 分类结果：完整打分 + 置信度，便于日志复盘与 UI 提示。 */
export interface SceneDecision {
  scene: SceneKind
  /** 全部候选按分降序（只保留 >0 的）。 */
  scores: Array<{ scene: SceneKind; score: number }>
  /** 第一名与第二名的分差；越小越不可信。 */
  margin: number
  /** margin < UNCERTAIN_MARGIN 时置 true，UI 可提示「可手动切换类别」。 */
  uncertain: boolean
}

/** 置信阈值：0.06 来自合成样本上的分差分布（正确样本中位 0.21，错误样本 <0.05）。 */
export const UNCERTAIN_MARGIN = 0.06

/** 夹取到 0..1。 */
const c01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** 线性归一化到 0..1（lo..hi 之外夹取）。 */
const norm = (v: number, lo: number, hi: number) => c01((v - lo) / (hi - lo || 1))

/**
 * 主入口：根据特征打分。
 * 返回的第一名即场景；`unknown` 表示所有证据都不足（此时按通用清单提问）。
 */
export function classifyScene(f: VisionFeatures): SceneDecision {
  // ---- 先把原始特征归一化成 0..1 的「证据强度」 ----
  const periodicity = norm(f.linePeriodicity, 0.08, 0.55) // 文字行规律性
  // 「满版文字」程度：文档 0.4+，弹窗/界面 0.1~0.2。用来把"一页文档"和"一个提示框"分开。
  const cover = norm(f.inkRowCoverage, 0.15, 0.55)
  const axisH = norm(f.axisH, 0.3, 0.9) // 横向长线（顶栏、分隔线、表格横线）
  const axisV = norm(f.axisV, 0.2, 0.8) // 纵向长线（表格竖线、侧栏边框）
  const axisMax = Math.max(axisH, axisV)
  // 表格的关键是"横竖都长"，所以取两者较小值；界面通常只有横向长线，axisMin 会很低
  const axisMin = Math.min(axisH, axisV)
  const colorfulness = norm(f.colorfulness, 4, 70) // 色彩丰富度
  // 颜色种类占比的量级很小（文字类 <0.001，照片 0.05+），按这个区间归一才分得开
  const distinct = norm(f.distinctColorRatio, 0.001, 0.08)
  const saturation = c01(f.saturationMean / 0.45)
  const contrast = norm(f.contrastSpread, 0.25, 0.85)
  // 红色占比：旧区间 0.2%~3% 太容易饱和——一张"角落有个红图标"的图也拿满分，
  // 于是任何带暖色块的照片都可能被判成报错。报错截图的红是**成片**的
  // （告警条 + 危险按钮通常占 10% 以上），所以区间改为 1%~12%，
  // 小面积红色装饰不再等于"满屏报错"，同时真弹窗仍接近满分。
  const red = norm(f.redRatio, 0.01, 0.12)
  const bimodal = norm(f.lumaBimodality, 0.02, 0.3)
  // 色相分散度：照片里红/橙/蓝/绿都有（0.6~0.8），截图往往只有"一个主题色 + 灰"
  // （0.1~0.3）。这是把"暖色照片"和"红色告警弹窗"分开的关键证据。
  const hueSpread = norm(f.hueEntropy, 0.15, 0.7)
  const dark = f.darkBg ? 1 : 0
  const brightBg = f.meanLuma > 170 ? 1 : 0
  const sparse = 1 - norm(f.edgeDensity, 0.02, 0.22) // 稀疏（大字/留白多）
  const dense = norm(f.edgeDensity, 0.03, 0.2) // 密集（小字/纹理多、噪声图）
  const flat = 1 - colorfulness // 近乎无彩
  // 文档的"软门"：文档几乎都是浅底。深底 + 满版文字更像代码/终端，
  // 用 0.35 的系数把深底图的文档得分压下去，而不是写死排除。
  const docGate = 0.35 + 0.65 * brightBg

  /**
   * 各类别的加权证据。
   * 权重含义：主判据给 0.3+，辅助判据各 0.1~0.2，总分再夹到 1。
   * 注释里写清「哪条证据在起作用」，方便误判时定位。
   *
   * 两处负权（-0.12*red）不是拍脑袋：深色终端里的红字会让 code 的各项证据都很高，
   * 只有把"红色很多"当作反证据才能把 error 拉上来。
   */
  const raw: Record<Exclude<SceneKind, 'unknown'>, number> = {
    // 代码：深色主题 + 规则行距是最强信号；行距规律但无长分隔线 → 不是表格
    code: 0.3 * dark + 0.3 * periodicity + 0.16 * dense + 0.12 * (1 - axisMax) + 0.1 * flat - 0.12 * red,
    // 报错：红色块是最强信号 + 文字行；浅底弹窗与深色终端都覆盖
    // +0.06*(1-cover)：报错弹窗通常"不满版"（卡片 + 留白），而整页文档/满版代码不是
    error: 0.5 * red + 0.18 * periodicity + 0.12 * (1 - axisMax) + 0.1 * dark + 0.1 * contrast + 0.06 * (1 - cover),
    // 界面：横向长线（顶栏/卡片边）+ 双底色 + 字不多 + 纵向长线不明显
    ui: 0.32 * axisH + 0.2 * bimodal + 0.16 * flat + 0.14 * (1 - dense) + 0.14 * brightBg + 0.04 * (1 - axisMin),
    // 对话：两种底色的气泡、几乎没有长直线、留白多
    chat: 0.36 * bimodal + 0.2 * (1 - axisMax) + 0.18 * sparse + 0.16 * (1 - periodicity) + 0.1 * flat,
    // 表格：横竖长线同时强（axisMin）+ 行距规律 + 满版 + 黑白为主
    table: 0.4 * axisMin + 0.18 * periodicity + 0.14 * cover + 0.16 * brightBg + 0.12 * flat,
    // 图表：有彩色但颜色种类少（几个系列色）+ 边缘稀疏（不是纹理）+ 无行距
    chart: 0.26 * colorfulness + 0.2 * (1 - distinct) + 0.18 * (1 - periodicity) + 0.14 * saturation + 0.12 * brightBg + 0.1 * (1 - dense),
    // 文档：白底（软门）+ 高对比 + 文字行规律 + **满版** + 几乎无彩色 + 无网格
    // -0.18*axisMin：整幅网格是表格的特征，出现网格就该让位给 table
    // -0.14*red：整块红色更像告警，不属于文档
    document:
      docGate * (0.32 * brightBg + 0.18 * periodicity + 0.14 * cover + 0.2 * contrast + 0.14 * flat + 0.08 * (1 - axisMax) - 0.18 * axisMin - 0.14 * red),
    // 示意图：中等彩色、边缘稀疏、无行距、有直线但不横跨全宽
    diagram: 0.26 * saturation + 0.22 * sparse + 0.2 * (1 - periodicity) + 0.16 * (1 - axisMax) + 0.16 * (1 - flat),
    // 照片：色彩最丰富 + 颜色种类最多 + 边缘是"满屏纹理"而不是"一行行"
    // +0.1*hueSpread：色彩渐变的照片（日落、暖光）颜色种类可能很少（量化后只有几十个
    // 桶），但色相是分散的；加这一项避免"暖色渐变"被当成红色告警（实测该样本 distinct
    // 只有 0.005，仅靠 distinct 这一项照片必输）。
    photo: 0.3 * colorfulness + 0.22 * distinct + 0.18 * (1 - periodicity) + 0.15 * dense + 0.15 * saturation + 0.1 * hueSpread,
    // 手写：白底 + 行距不规律 + 无长线 + 笔画粗细不均（用边缘密度中段近似）
    handwriting: 0.3 * brightBg + 0.26 * (1 - periodicity) + 0.2 * (1 - axisMax) + 0.14 * flat + 0.1 * dense,
  }

  const scores = (Object.keys(raw) as Array<Exclude<SceneKind, 'unknown'>>)
    .map((scene) => ({ scene: scene as SceneKind, score: Math.round(c01(raw[scene]) * 1000) / 1000 }))
    .sort((a, b) => b.score - a.score || a.scene.localeCompare(b.scene))

  const top = scores[0]
  const second = scores[1] ?? { score: 0 }
  const margin = Math.max(0, top.score - second.score)

  // 纯色/近纯色图：没有场景可言。必须先拦，否则"缺席类证据"会作弊——
  // 图表与文档的公式里有 (1-行距)、(1-长直线)、(1-色彩) 这类项，
  // 一张全白图恰好全部满足，会拿到 0.5 以上的假高分。
  if (f.edgeDensity < 0.004 && f.stdLuma < 6) {
    return { scene: 'unknown', scores, margin, uncertain: true }
  }

  // 证据太弱时给 unknown，避免强行套清单误导模型。
  // 0.35 的依据：纯色亮图只有"浅底"一条证据（document 得 0.32），
  // 必须落在阈值之下；而正常文档/截图都在 0.6 以上，留了足够余量。
  if (top.score < 0.35) {
    return { scene: 'unknown', scores, margin, uncertain: true }
  }
  return { scene: top.scene, scores, margin, uncertain: margin < UNCERTAIN_MARGIN }
}

/** 场景的中文名（UI 展示与报告用）。 */
export const SCENE_LABEL: Record<SceneKind, string> = {
  code: '代码',
  error: '报错',
  ui: '界面',
  chat: '对话',
  table: '表格',
  chart: '图表',
  document: '文档',
  diagram: '示意图',
  photo: '照片',
  handwriting: '手写',
  unknown: '未判定',
}

/** 判定该场景是否属于「文字为主」——决定编码格式（PNG 保笔画）与放大策略。 */
export function isTextLike(scene: SceneKind): boolean {
  return scene === 'code' || scene === 'error' || scene === 'table' || scene === 'document' || scene === 'handwriting' || scene === 'ui'
}

/** 批次主导场景：多图时取票数最高者（平票取先出现的，保证稳定）。 */
export function dominantScene(scenes: SceneKind[]): SceneKind {
  if (scenes.length === 0) return 'unknown'
  const rank = new Map<SceneKind, number>()
  scenes.forEach((s, i) => {
    // 票数按 10 分一票、越靠前权重略高，避免顺序完全无关
    rank.set(s, (rank.get(s) ?? 0) + 10 - Math.min(9, i))
  })
  let best: SceneKind = scenes[0]
  let bestScore = -1
  for (const [s, v] of rank) {
    if (v > bestScore) {
      best = s
      bestScore = v
    }
  }
  return best
}
