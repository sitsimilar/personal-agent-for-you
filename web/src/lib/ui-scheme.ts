/**
 * 界面方案（UI Scheme）纯函数与常量 —— v2.13.1 UI-1 令牌层配套。
 *
 * ## 三个方案的关系（重要，改之前先读这段）
 *
 * 三个方案解决的是**不同层面**的问题，不是三个平行主题：
 * - `silent`（A · 静默化）只管**视觉令牌**：主色收敛、圆角归三档、双层阴影、字号收五档、导航降噪；
 * - `zoned`（B · 分区骨架）在 A 的令牌之上，再加**布局**：统一容器 + 页眉带 + bento 主次分栏 + 顶栏精简；
 * - `fluid`（C · 流畅优先）在 A 的令牌之上，再加**交互**：动效分档 + 骨架屏 + View Transitions + 命令面板 + 勾选乐观反馈。
 *
 * 所以 **B / C 都包含 A 的视觉收敛**——切到 B 或 C 时视觉不会“跳回去”，
 * 只有布局或交互发生变化。这是「切换后行为清晰一致」的实现基础：
 * 用户感知到的差异永远只有一处（要么布局、要么交互），不会两个维度一起变。
 *
 * ## 为什么默认是 `silent`
 *
 * `silent` 不动布局、不动交互、不动任何入口位置，是三者中对既有使用习惯冲击最小的一个。
 * 新设备 / 重置后一律回到 `silent`，用户不主动选择就不会遇到“按钮换了位置”。
 *
 * 本文件是**纯函数**：不读 `localStorage`、不读 `window`、不碰 DOM，便于单测。
 * 所有副作用（持久化、dataset 写入）都在 `store/uiSchemeStore.ts`。
 */

/** 三个可选方案。 */
export type UiScheme = 'silent' | 'zoned' | 'fluid'

/** 方案的展示顺序（设置页与快捷菜单共用，改这里即两处同步）。 */
export const UI_SCHEME_ORDER: readonly UiScheme[] = ['silent', 'zoned', 'fluid'] as const

/** 出厂默认方案。 */
export const DEFAULT_UI_SCHEME: UiScheme = 'silent'

/** 本地存储键（与云端 `settings.ui_scheme` 双写；云端失败时以本地为准）。 */
export const UI_SCHEME_STORAGE_KEY = 'pa.ui.scheme'

/**
 * 本地存储格式版本。改结构时 +1，旧值按 `normalizeUiScheme` 归一化（不迁移、直接回落默认）。
 */
export const UI_SCHEME_STORAGE_VERSION = 1

/**
 * 各方案启用的能力位。
 *
 * 用「能力位」而不是 `if (scheme === 'zoned')` 散落各处，是为了让新增能力只改一处、
 * 也让设置页的影响清单可以直接从这张表生成（文案与实现不会脱节）。
 */
export interface UiSchemeFeatures {
  /** 视觉令牌层（三方案恒启用；保留位，便于将来加“经典外观”回退）。 */
  tokenLayer: boolean
  /** 统一容器 + bento 主次分栏。 */
  zonedLayout: boolean
  /** 页眉带：标题区承载主操作，顶栏相应精简。 */
  headerBand: boolean
  /** 顶栏精简（隐藏「快速记录」，最多 4 个元素）。 */
  slimTopBar: boolean
  /** 命令面板（Ctrl / ⌘ + K）。 */
  commandPalette: boolean
  /** 动效分档（进场 / 退场 / 位移三档，取代“一律 180ms”）。 */
  tieredMotion: boolean
  /** 列表骨架屏（替代居中转圈）。 */
  skeletons: boolean
  /** 页面切换 View Transitions（特性检测，不支持自动降级为淡入）。 */
  viewTransitions: boolean
  /** 勾选待办的同帧乐观反馈（后台落库，失败回滚）。 */
  optimisticToggle: boolean
}

/** 三方案的能力矩阵（唯一事实来源）。 */
const FEATURES: Record<UiScheme, UiSchemeFeatures> = {
  silent: {
    tokenLayer: true,
    zonedLayout: false,
    headerBand: false,
    slimTopBar: false,
    commandPalette: false,
    tieredMotion: false,
    skeletons: false,
    viewTransitions: false,
    optimisticToggle: false,
  },
  zoned: {
    tokenLayer: true,
    zonedLayout: true,
    headerBand: true,
    slimTopBar: true,
    commandPalette: false,
    tieredMotion: false,
    skeletons: false,
    viewTransitions: false,
    optimisticToggle: false,
  },
  fluid: {
    tokenLayer: true,
    zonedLayout: false,
    headerBand: false,
    slimTopBar: false,
    commandPalette: true,
    tieredMotion: true,
    skeletons: true,
    viewTransitions: true,
    optimisticToggle: true,
  },
}

/** 取某方案的能力位（返回不可变副本，调用方不要就地修改）。 */
export function resolveUiSchemeFeatures(scheme: UiScheme): UiSchemeFeatures {
  return { ...FEATURES[scheme] }
}

/** 方案作用的主要维度（设置页角标用）。 */
export type UiSchemeDimension = '视觉' | '布局' | '交互'

/** 单条「改动要点」。 */
export interface UiSchemeChange {
  /** 要点标题（4–6 字）。 */
  title: string
  /** 一句话说明。 */
  detail: string
}

/** 方案元信息（设置页卡片、快捷菜单、首次提示共用）。 */
export interface UiSchemeMeta {
  id: UiScheme
  /** 展示名，如「静默化」。 */
  name: string
  /** 一句话定位。 */
  tagline: string
  /** 主要改动维度。 */
  dimension: UiSchemeDimension
  /** 相对现状的影响面（用于风险提示）。 */
  impact: '仅视觉' | '视觉 + 布局' | '视觉 + 交互'
  /** 风险等级。 */
  risk: '低' | '中'
  /** 建议：是否为新用户推荐（仅 `silent`）。 */
  recommended: boolean
  /** 改动要点（设置页展开可见）。 */
  changes: UiSchemeChange[]
  /** 切换后用户会明显感觉到什么（撤销提示里复述这三条之一）。 */
  noticeable: string
}

/** 三方案元信息。 */
export const UI_SCHEME_META: Record<UiScheme, UiSchemeMeta> = {
  silent: {
    id: 'silent',
    name: '静默化',
    tagline: '把视觉噪声关掉，不动任何结构',
    dimension: '视觉',
    impact: '仅视觉',
    risk: '低',
    recommended: true,
    changes: [
      { title: '主色收敛', detail: '只有「主操作按钮」和「当前导航项」是品牌色，其余图标默认灰、悬停才显色' },
      { title: '圆角归三档', detail: '控件 8 / 卡片 12 / 弹层 16，删掉中间值' },
      { title: '层级改双层', detail: '卡片用极轻阴影浮起，不再整屏描边' },
      { title: '字号收五档', detail: '24 / 16 / 14 / 13 / 11.5，行高统一' },
    ],
    noticeable: '颜色变安静了，位置和操作方式完全没变',
  },
  zoned: {
    id: 'zoned',
    name: '分区骨架',
    tagline: '把「一列到底」改成有主次的版面',
    dimension: '布局',
    impact: '视觉 + 布局',
    risk: '中',
    recommended: false,
    changes: [
      { title: '统一容器', detail: '各页宽度从 5 种收敛为 1 种（1120px），宽屏不再空荡' },
      { title: '页眉带', detail: '「快速记录」从顶栏移到页眉右侧，离内容更近；顶栏精简到 4 个元素' },
      { title: '主次分栏', detail: '首页主区占 2/3、辅助信息进右栏，一眼知道先看哪' },
      { title: '卡片抬起', detail: '悬停时卡片上移 2px 并加阴影，让「可点」自己说出来' },
    ],
    noticeable: '页面变宽了，有些按钮换了位置（「快速记录」在标题右边）',
  },
  fluid: {
    id: 'fluid',
    name: '流畅优先',
    tagline: '每个状态变化都有人应答',
    dimension: '交互',
    impact: '视觉 + 交互',
    risk: '中',
    recommended: false,
    changes: [
      { title: '动效分档', detail: '进场 220ms、退场 140ms、位移 260ms，不再一律 180ms' },
      { title: '骨架屏', detail: '列表加载显示占位骨架，不再只转一个圈' },
      { title: '勾选即反馈', detail: '勾选待办立刻划线变灰，后台落库，失败自动回滚并提示' },
      { title: '命令面板', detail: 'Ctrl / ⌘ + K 一步跳到任意页面或动作' },
    ],
    noticeable: '操作反馈变快了，多了一个 Ctrl+K 命令面板',
  },
}

/** 取方案元信息。 */
export function getUiSchemeMeta(scheme: UiScheme): UiSchemeMeta {
  return UI_SCHEME_META[scheme]
}

/** 取方案展示名（未知值回落默认方案名，保证 UI 永远有字可显示）。 */
export function getUiSchemeName(scheme: UiScheme): string {
  return UI_SCHEME_META[scheme]?.name ?? UI_SCHEME_META[DEFAULT_UI_SCHEME].name
}

/**
 * 把任意来源的值归一化为合法方案。
 *
 * 覆盖：`undefined` / `null` / 空串 / 大小写不一致 / 历史别名 / 已废弃的旧方案 id / 非字符串。
 * **永不抛错**——存储脏数据时静默回落默认值，避免整个应用因为一个偏好项白屏。
 *
 * @param raw 任意原始值（localStorage 字符串、云端列值、URL 参数等）
 * @returns 合法方案
 */
export function normalizeUiScheme(raw: unknown): UiScheme {
  if (typeof raw !== 'string') return DEFAULT_UI_SCHEME
  const key = raw.trim().toLowerCase()
  if (!key) return DEFAULT_UI_SCHEME
  // 兼容历史别名，避免旧版本写下的值在升级后被当成“未设置”而重置用户选择
  const alias: Record<string, UiScheme> = {
    a: 'silent',
    quiet: 'silent',
    minimal: 'silent',
    b: 'zoned',
    zone: 'zoned',
    bento: 'zoned',
    c: 'fluid',
    smooth: 'fluid',
    motion: 'fluid',
  }
  if ((UI_SCHEME_ORDER as readonly string[]).includes(key)) return key as UiScheme
  return alias[key] ?? DEFAULT_UI_SCHEME
}

/** 是否是合法方案 id（用于“是否曾经显式选择过”的判断）。 */
export function isUiScheme(raw: unknown): raw is UiScheme {
  return typeof raw === 'string' && (UI_SCHEME_ORDER as readonly string[]).includes(raw)
}

/** 方案切换后「变了什么」的摘要，用于切换提示与撤销条。 */
export interface UiSchemeChangeSummary {
  /** 视觉是否变化（三方案共用同一套收敛令牌，故切换时视觉不变）。 */
  visualChanged: boolean
  /** 布局是否变化。 */
  layoutChanged: boolean
  /** 交互是否变化。 */
  interactionChanged: boolean
  /** 需要提醒用户的具体项（最多 3 条，按影响从大到小）。 */
  notes: string[]
}

/**
 * 计算从 `from` 切到 `to` 的变化摘要。
 *
 * 用途：切换后必须让用户知道"哪里会变"，否则布局变化会被误认为 bug。
 * 文案刻意写“会变”而不是“已变”，因为它同时用于切换前预览。
 *
 * @param from 当前方案
 * @param to 目标方案
 */
export function summarizeUiSchemeChange(from: UiScheme, to: UiScheme): UiSchemeChangeSummary {
  const a = FEATURES[from]
  const b = FEATURES[to]
  const layoutChanged = a.zonedLayout !== b.zonedLayout || a.headerBand !== b.headerBand
  const interactionChanged =
    a.commandPalette !== b.commandPalette ||
    a.tieredMotion !== b.tieredMotion ||
    a.skeletons !== b.skeletons ||
    a.viewTransitions !== b.viewTransitions ||
    a.optimisticToggle !== b.optimisticToggle

  const notes: string[] = []
  if (b.zonedLayout && !a.zonedLayout) {
    notes.push('页面容器会收窄为统一宽度，首页改为左右分栏')
  }
  if (!b.zonedLayout && a.zonedLayout) {
    notes.push('页面改回单列铺满，「快速记录」回到顶栏')
  }
  if (b.commandPalette && !a.commandPalette) {
    notes.push('新增 Ctrl / ⌘ + K 命令面板')
  }
  if (!b.commandPalette && a.commandPalette) {
    notes.push('Ctrl / ⌘ + K 命令面板将不可用')
  }
  if (b.optimisticToggle && !a.optimisticToggle) {
    notes.push('勾选待办改为立即反馈、后台落库')
  }
  if (notes.length === 0) {
    notes.push('视觉令牌保持一致，只影响观感细节')
  }

  return {
    visualChanged: false, // 三方案共享同一套收敛令牌：切换不改视觉基调
    layoutChanged,
    interactionChanged,
    notes: notes.slice(0, 3),
  }
}

/** 是否需要用一次说明性提示（跨维度切换时提示，同维度切换不打扰）。 */
export function needsSchemeSwitchHint(from: UiScheme, to: UiScheme): boolean {
  if (from === to) return false
  return FEATURES[from].zonedLayout !== FEATURES[to].zonedLayout
}
