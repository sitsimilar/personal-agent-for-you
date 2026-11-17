/**
 * 背景氛围（Ambient Backdrop）—— 「线构」令牌体系里的**第二层画布**。
 *
 * ## 它是什么 / 不是什么
 * - 是：画布底纹的一层可关闭的装饰，挂在 `<html data-backdrop>` 上，
 *   颜色全部复用 `index.css` 的 `--ink* / --line* / --brand*`，不新建色板。
 * - 不是：界面方案（`lib/ui-scheme.ts`）。界面方案改的是**布局与交互**，
 *   背景氛围只改**画布底纹**，两者正交，任意组合都可以。
 *
 * ## 三条硬约束（实现与文案都要能对上）
 * 1. **不阻塞首屏**：装饰层在应用挂载后才渲染，Canvas 起帧走 `requestAnimationFrame`；
 * 2. **不吃正文对比度**：装饰只出现在留白处，底色 alphas 上限约 10%（线）/ 30%（点），
 *    强度滑杆只是在这个预算内做 0–100% 缩放；
 * 3. **可一键关闭 + 尊重减弱动效**：`off` 直接不挂载渲染层；
 *    `prefers-reduced-motion: reduce` 下轨道停转、地形不飘、星野只画一帧。
 *
 * ## 参数模型（v2.15）
 * 每套主题有一套推荐默认值；用户改过的值按主题分别记录（`params[id]`），
 * 所以「切走再切回来」保留用户手感，而没改过的主题仍然是推荐值。
 * 取值范围刻意收在安全区间内，理由见 `BACKDROP_PARAM_META` 的 `safe` 字段。
 *
 * 本文件是纯函数与常量：不读 `localStorage`、不碰 DOM（副作用在 `store/uiSchemeStore.ts`）。
 */

/** 四档背景氛围。 */
export type BackdropTheme = 'off' | 'orbit' | 'starfield' | 'terrain'

/** 展示顺序（设置页与顶栏快捷入口共用）。 */
export const BACKDROP_ORDER: readonly BackdropTheme[] = ['off', 'orbit', 'starfield', 'terrain'] as const

/**
 * 出厂默认：`orbit`。
 *
 * 为什么不是 `off`：它是纯 CSS/SVG，无脚本帧循环，风险与「关闭」几乎等价，
 * 但能让新界面第一眼就有「线构」的气质；不喜欢的用户在设置页一次点击即可关掉。
 */
export const DEFAULT_BACKDROP: BackdropTheme = 'orbit'

/** 本地存储键（背景与参数都只做设备级偏好，**不写账号、不动数据库**）。 */
export const BACKDROP_STORAGE_KEY = 'pa.ui.backdrop'

/** 存储格式版本：v2 起带 `params`；读到 v1（只有 backdrop）时参数补默认值。 */
export const BACKDROP_STORAGE_VERSION = 2

/* ============================================================
 *  参数：四个滑杆
 * ============================================================ */

/** 可调参数（四个维度，顺序即面板顺序）。 */
export type BackdropParamKey = 'speed' | 'intensity' | 'blur' | 'opacity'

/** 单套主题的参数取值。 */
export interface BackdropParams {
  /** 变化速度 0–100（0 = 完全静止）。 */
  speed: number
  /** 线条/图形强度 0–100（线宽 0.6–1.6px，透明度在底色预算内缩放）。 */
  intensity: number
  /** 模糊度 0–4px（只作用于装饰层）。 */
  blur: number
  /** 整层透明度 0–100。 */
  opacity: number
}

/** 参数的展示与安全边界（面板、提示、归一化共用同一份）。 */
export interface BackdropParamMeta {
  key: BackdropParamKey
  /** 中文名（2–3 字）。 */
  label: string
  /** 单位（空表示百分比）。 */
  unit: string
  min: number
  max: number
  step: number
  /** 当前值怎么读（面板右侧显示）。 */
  format: (value: number) => string
  /** 刻度的文字标签：值与文案。 */
  marks: Array<{ value: number; label: string }>
  /** 一句话解释这个参数改的是什么。 */
  hint: string
  /** 为什么不能更大 / 更小（安全上限的理由，面板直接展示）。 */
  safe: string
}

/** 四个参数的元信息（唯一事实来源：面板、说明、归一化都读这里）。 */
export const BACKDROP_PARAM_META: readonly BackdropParamMeta[] = [
  {
    key: 'speed',
    label: '变化速度',
    unit: '',
    min: 0,
    max: 100,
    step: 1,
    format: (v) => (v <= 0 ? '静止' : `${Math.round(v)}`),
    marks: [
      { value: 0, label: '静止' },
      { value: 50, label: '慢' },
      { value: 100, label: '快' },
    ],
    hint: '动画走得多快；0 会真正停帧，不是把透明度调到看不见。',
    safe: '上限 100 对应轨道约 45s / 圈、等高线约 50s 单程、星野呼吸约 2 倍速；再快会接近闪烁，前庭不适且星野本身封顶 30fps，再快也没有额外帧。',
  },
  {
    key: 'intensity',
    label: '线条强度',
    unit: '',
    min: 0,
    max: 100,
    step: 1,
    format: (v) => `${Math.round(v)}%`,
    marks: [
      { value: 0, label: '极淡' },
      { value: 50, label: '中等' },
      { value: 100, label: '上限' },
    ],
    hint: '同时调线条粗细与浓度；0% 会把装饰压到看不见（想省电请用「关闭」）。',
    safe: '上限 100% 就是对比度预算的上限：线 alpha ≤10%、点 alpha ≤30%（浅色）/ 62%（深色）、线宽 ≤1.6px。再往上会和卡片的 1px 发丝描边打架，也容易被误读成内容分割线。',
  },
  {
    key: 'blur',
    label: '模糊度',
    unit: 'px',
    min: 0,
    max: 4,
    step: 0.5,
    format: (v) => `${v}px`,
    marks: [
      { value: 0, label: '实线' },
      { value: 2, label: '2px' },
      { value: 4, label: '化雾' },
    ],
    hint: '只作用于装饰层，不会模糊正文；越大越像底纹。模糊会稀释发丝线，所以线宽会跟着自动补偿，保证仍看得见形体。',
    safe: '上限 4px：1px 发丝线在 4px 模糊下已接近纯色雾（峰值 alpha 只剩约 1/5），再往上只是给 GPU 加离屏采样成本——全屏 `filter: blur()` 每帧都要重新采样，低端集显会掉帧。模糊超过 1px 时线宽按 `1 + (模糊-1)/3 × 2.2` 自动补偿（最多约 ×3.2），只加宽不加 alpha，不突破对比度预算。',
  },
  {
    key: 'opacity',
    label: '透明度',
    unit: '',
    min: 0,
    max: 100,
    step: 1,
    format: (v) => `${Math.round(v)}%`,
    marks: [
      { value: 0, label: '0' },
      { value: 50, label: '50' },
      { value: 100, label: '100' },
    ],
    hint: '整层的存在感；0% 视觉上消失，但仍在渲染。',
    safe: '0 只用于对照 —— 想彻底省电请直接选「关闭」（渲染层不挂载）；100% 已是设计上限，不会再盖住正文。',
  },
] as const

/** 参数默认值（每套主题一套；`off` 不使用但保留，切回来不丢值）。 */
export const BACKDROP_DEFAULTS: Record<BackdropTheme, BackdropParams> = {
  off: { speed: 0, intensity: 90, blur: 0, opacity: 80 },
  orbit: { speed: 50, intensity: 92, blur: 0, opacity: 92 },
  starfield: { speed: 50, intensity: 92, blur: 0, opacity: 94 },
  terrain: { speed: 50, intensity: 90, blur: 1, opacity: 90 },
}

/** 背景相关的全部偏好（主题 + 每套主题的参数）。 */
export interface BackdropPreference {
  theme: BackdropTheme
  params: Record<BackdropTheme, BackdropParams>
}

/** 单套背景的元信息（设置页卡片与快捷入口共用，避免文案两处维护）。 */
export interface BackdropMeta {
  id: BackdropTheme
  /** 展示名（2–4 字）。 */
  name: string
  /** 一句话定位。 */
  tagline: string
  /** 气质。 */
  feel: string
  /** 性能开销（给用户看的量级，不写实现黑话）。 */
  cost: string
  /** 适合什么场景。 */
  scene: string
  /** 实现要点（一行，说明为什么不需要大依赖）。 */
  how: string
  /** GitHub 参考来源（名称 + 它解决的问题）。 */
  source: string
}

/** 四套背景的元信息。 */
export const BACKDROP_META: Record<BackdropTheme, BackdropMeta> = {
  off: {
    id: 'off',
    name: '关闭',
    tagline: '纯色画布 + 几何网格，不加任何装饰',
    feel: '安静、纸张感',
    cost: '零：渲染层不挂载',
    scene: '长时间阅读、低电量、录屏与截图',
    how: '只保留 `body` 上原有的 48px 网格',
    source: '无（对照基线）',
  },
  orbit: {
    id: 'orbit',
    name: '轨道线',
    tagline: '同心圆与缓慢轨道点，纯 CSS/SVG',
    feel: '秩序、仪器感',
    cost: '约 1% CPU，无 Canvas、无帧循环',
    scene: '日常默认；想有点生气但不抢注意力',
    how: 'CSS 关键帧只动 `transform`，交给合成层',
    source: 'bansal/pattern.css —— 纯 CSS 几何图案，证明零 JS 也能做出线构底纹',
  },
  starfield: {
    id: 'starfield',
    name: '星野',
    tagline: 'Canvas 星点 + 近邻连线，极慢明暗呼吸',
    feel: '深空、克制',
    cost: '30fps 上限 + 页面隐藏即暂停，约 2–4% CPU',
    scene: '夜间 / 深色模式，写作与整理时的背景',
    how: '自写 Canvas 2D：星点按面积取样，连线对在初始化时一次算好',
    source: 'VincentGarreau/particles.js —— `line_linked`（近邻连线）是星座线的经典做法',
  },
  terrain: {
    id: 'terrain',
    name: '等高线',
    tagline: '噪声等高线，像地形图一样缓慢横移',
    feel: '山野、地理',
    cost: '绘制一次 + CSS 位移，无每帧脚本开销',
    scene: '白天 / 浅色模式，喜欢纸张地图的阅读氛围',
    how: '自写 2D value noise（不引依赖），离屏画完后只做合成层平移',
    source: 'jwagner/simplex-noise.js —— 噪声采样用于地形/等高线；本方案用 2D value noise 替代，避免新增依赖',
  },
}

/** 取元信息（未知 id 回落默认）。 */
export function getBackdropMeta(id: BackdropTheme): BackdropMeta {
  return BACKDROP_META[id] ?? BACKDROP_META[DEFAULT_BACKDROP]
}

/** 取展示名（UI 永远有字可显示）。 */
export function getBackdropName(id: BackdropTheme): string {
  return getBackdropMeta(id).name
}

/**
 * 把任意来源的值归一化为合法背景档位。
 *
 * 覆盖 `undefined` / `null` / 空串 / 大小写 / 历史别名 / 非字符串，**永不抛错**：
 * 一个装饰偏好不值得让应用白屏。
 */
export function normalizeBackdrop(raw: unknown): BackdropTheme {
  if (typeof raw !== 'string') return DEFAULT_BACKDROP
  const key = raw.trim().toLowerCase()
  if (!key) return DEFAULT_BACKDROP
  const alias: Record<string, BackdropTheme> = {
    none: 'off',
    quiet: 'off',
    minimal: 'off',
    ring: 'orbit',
    rings: 'orbit',
    stars: 'starfield',
    star: 'starfield',
    constellation: 'starfield',
    contour: 'terrain',
    contours: 'terrain',
    mountain: 'terrain',
  }
  if ((BACKDROP_ORDER as readonly string[]).includes(key)) return key as BackdropTheme
  return alias[key] ?? DEFAULT_BACKDROP
}

/** 把单个参数夹到安全区间（非数字回落默认值）。 */
export function clampBackdropParam(key: BackdropParamKey, raw: unknown, fallback: number): number {
  const meta = BACKDROP_PARAM_META.find((m) => m.key === key)
  if (!meta) return fallback
  const value = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(value)) return fallback
  const clamped = Math.min(meta.max, Math.max(meta.min, value))
  // 按 step 对齐，避免存储里出现 0.30000000000000004 这种值
  return Math.round(clamped / meta.step) * meta.step
}

/** 归一化一套参数（缺字段逐个回落默认值）。 */
export function normalizeBackdropParams(id: BackdropTheme, raw: unknown): BackdropParams {
  const base = BACKDROP_DEFAULTS[id]
  if (!raw || typeof raw !== 'object') return { ...base }
  const input = raw as Partial<Record<BackdropParamKey, unknown>>
  return {
    speed: clampBackdropParam('speed', input.speed, base.speed),
    intensity: clampBackdropParam('intensity', input.intensity, base.intensity),
    blur: clampBackdropParam('blur', input.blur, base.blur),
    opacity: clampBackdropParam('opacity', input.opacity, base.opacity),
  }
}

/** 归一化整套偏好（主题 + 四套参数）。 */
export function normalizeBackdropPreference(rawTheme: unknown, rawParams: unknown): BackdropPreference {
  const theme = normalizeBackdrop(rawTheme)
  const input = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>
  const params = {} as Record<BackdropTheme, BackdropParams>
  for (const id of BACKDROP_ORDER) params[id] = normalizeBackdropParams(id, input[id])
  return { theme, params }
}

/** 是否是这套主题的推荐值（面板上「恢复默认」的禁用判断）。 */
export function isBackdropDefault(id: BackdropTheme, params: BackdropParams): boolean {
  const base = BACKDROP_DEFAULTS[id]
  return (Object.keys(base) as BackdropParamKey[]).every((key) => params[key] === base[key])
}
