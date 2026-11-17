/**
 * 深浅色与对比度偏好（v2.15 新增）。
 *
 * ## 定位
 * - 与「背景氛围」正交：背景是底纹，这里是深浅色 + 对比度；
 * - 与「界面方案」正交：方案改布局交互，这里改色板对比度；
 * - 纯偏好，只存本机（localStorage），不写账号、不动数据库。
 *
 * ## 深浅色三档
 * - `system`：跟随系统（当前默认，不破坏现有用户行为）；
 * - `light`：强制浅色；
 * - `dark`：强制深色。
 *
 * 为什么是三档而不是两档？GitHub Primer 的 Day/Night/auto 就是这个结构——
 * 用户往往想"平时跟随系统，但写代码时强制深色"。
 *
 * ## 对比度滑杆
 * - 0.6–1.5，默认 1.0；
 * - 作用面：
 *   1) 背景层 alpha 预算 × multiplier（硬 cap：线 ≤ 0.15、点浅 ≤ 0.40、点深 ≤ 0.80）；
 *   2) 正文次调色 `--ink2/--ink3` 对比度微调（加进主色或画布色）；
 * - 不改正文主色 `--ink` 与卡片底色 `--surface`——保证 WCAG AA 4.5:1 底线。
 *
 * 为什么用 multiplier 而不是直接改色值？因为深浅色切换后底色预算本身已换，
 * 直接覆盖 alpha 会让深色下看起来比浅色更吵。乘算保持"底色 × 强度 × 对比度"
 * 三级叠加，深浅色自动对齐。
 */

/** 深浅色三档。 */
export type ColorScheme = 'system' | 'light' | 'dark'

/** 对比度 0.6–1.5（默认 1.0）。 */
export const DEFAULT_CONTRAST = 1.0
export const MIN_CONTRAST = 0.6
export const MAX_CONTRAST = 1.5
export const CONTRAST_STEP = 0.1

/** 本地存储键。 */
export const COLOR_STORAGE_KEY = 'pa.ui.color'
export const COLOR_STORAGE_VERSION = 2

/** 单套偏好。 */
export interface ColorPreference {
  scheme: ColorScheme
  contrast: number
}

/** 取展示名（设置页与顶栏共用）。 */
export function getColorSchemeName(s: ColorScheme): string {
  switch (s) {
    case 'light': return '浅色'
    case 'dark': return '深色'
    case 'system': return '跟随系统'
  }
}

/** 把任意来源的值归一化为合法深浅色档位。 */
export function normalizeColorScheme(raw: unknown): ColorScheme {
  if (typeof raw !== 'string') return 'system'
  const key = raw.trim().toLowerCase()
  if (!key) return 'system'
  const alias: Record<string, ColorScheme> = {
    auto: 'system',
    default: 'system',
    follow: 'system',
    os: 'system',
    '': 'system',
    day: 'light',
    white: 'light',
    bright: 'light',
    night: 'dark',
    black: 'dark',
  }
  return (['system', 'light', 'dark'] as const).includes(key as ColorScheme)
    ? (key as ColorScheme)
    : (alias[key] ?? 'system')
}

/** 夹对比度到安全区间（非数字回落默认值）。 */
export function clampContrast(raw: unknown): number {
  const v = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(v)) return DEFAULT_CONTRAST
  const clamped = Math.min(MAX_CONTRAST, Math.max(MIN_CONTRAST, v))
  return Math.round(clamped / CONTRAST_STEP) * CONTRAST_STEP
}

/** 归一化整套偏好。 */
export function normalizeColorPreference(raw: unknown): ColorPreference {
  if (!raw || typeof raw !== 'object') {
    return { scheme: 'system', contrast: DEFAULT_CONTRAST }
  }
  const input = raw as Partial<ColorPreference> & { v?: number }
  return {
    scheme: normalizeColorScheme(input.scheme),
    contrast: clampContrast(input.contrast),
  }
}

/** 从存储读出（任何异常当作"没存过"）。 */
export function readColorPreference(): ColorPreference {
  try {
    const raw = window.localStorage.getItem(COLOR_STORAGE_KEY)
    if (!raw) return { scheme: 'system', contrast: DEFAULT_CONTRAST }
    const parsed = JSON.parse(raw)
    return normalizeColorPreference(parsed)
  } catch {
    return { scheme: 'system', contrast: DEFAULT_CONTRAST }
  }
}

/** 写入存储（失败静默）。 */
export function writeColorPreference(pref: ColorPreference): void {
  try {
    window.localStorage.setItem(
      COLOR_STORAGE_KEY,
      JSON.stringify({ v: COLOR_STORAGE_VERSION, scheme: pref.scheme, contrast: pref.contrast }),
    )
  } catch {
    /* 忽略 */
  }
}

/**
 * 解析最终生效的深浅色：如果 override 是 `system`，读当前系统媒体查询；
 * 否则直接返回 override。
 *
 * 纯函数，不碰 DOM——调用方负责监听系统变化。
 */
export function resolveColorMode(
  override: ColorScheme,
  systemIsDark: boolean,
): 'light' | 'dark' {
  if (override === 'system') return systemIsDark ? 'dark' : 'light'
  return override
}
