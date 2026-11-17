/**
 * 把背景主题 + 四个参数编译成 CSS 变量（DOM 副作用集中在这里）。
 *
 * ## 为什么在 JS 里算，而不是纯 CSS
 * 面板要实时改「线宽 / 颜色 alpha / 模糊 / 时长」，这些量需要**乘法**
 * （底色 alpha × 强度、基准时长 × 速度曲线）。CSS `calc()` 对颜色 alpha 的乘法
 * 依赖较新的 `rgb(... / calc(...))` 语法，`getComputedStyle` 读回来的自定义属性
 * 也未必是解析后的颜色 —— Canvas 直接喂给 `fillStyle` 会失败。
 * 所以统一在 JS 里算出**最终值**再写变量：CSS 与 Canvas 读到的都是确定结果。
 *
 * ## 安全上限在哪里兑现
 * - 线宽：`0.6–1.6px`（`BACKDROP_PARAM_META.intensity.safe`）；
 * - 模糊：`0–4px`，只挂在装饰层上，不影响正文；模糊 >1px 时按比例补偿线宽
 *   （模糊会把发丝线稀释成看不见的雾，补偿只加宽、不加 alpha）；
 * - 颜色 alpha：底色预算 × 0–100%，底色本身已按正文对比度预留过余量；
 * - 速度：指数映射，最快也给足 45s/圈（轨道）与 50s/单程（等高线），不会变成闪烁。
 */

import {
  BACKDROP_PARAM_META,
  type BackdropParams,
  type BackdropTheme,
  type BackdropParamKey,
} from '@/lib/backdrop'

/** 参数 → 最终数值的换算规则（集中一处，方便审阅安全边界）。 */
const RANGE = {
  /** 强度 0–1 映射到线宽 0.6–1.6px。 */
  strokeMin: 0.6,
  strokeMax: 1.6,
  /** 轨道：最慢 480s/圈，最快 45s/圈。 */
  orbitSlow: 480,
  orbitFast: 45,
  /** 等高线：最慢 600s 单程，最快 50s 单程。 */
  terrainSlow: 600,
  terrainFast: 50,
} as const

function readNumber(style: CSSStyleDeclaration, name: string, fallback: number): number {
  const value = Number.parseFloat(style.getPropertyValue(name))
  return Number.isFinite(value) ? value : fallback
}

/** 指数插值：速度 0 → slow，速度 100 → fast（慢端变化更细腻）。 */
function speedToDuration(slow: number, fast: number, speed: number): number {
  const t = Math.min(100, Math.max(0, speed)) / 100
  return Math.round(slow * Math.pow(fast / slow, t))
}

/** 把 `24 24 27` 这种 RGB 三元组拼成 `rgba(...)`。 */
function composeRgba(rgb: string, alpha: number): string {
  const parts = rgb.replace(/\s+/g, ',').replace(/,+$/, '')
  return `rgba(${parts}, ${Math.max(0, Math.min(1, alpha)).toFixed(3)})`
}

/**
 * 应用背景视觉变量。
 *
 * 只写 `<html>` 上的自定义属性与 `data-backdrop`，不碰任何组件样式，
 * 所以换参数不会触发 React 重渲染之外的布局计算。
 */
export function applyBackdropStyle(theme: BackdropTheme, params: BackdropParams): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.dataset.backdrop = theme

  const cs = getComputedStyle(root)
  const rgb = cs.getPropertyValue('--bd-ink-rgb').trim() || '24 24 27'
  const accentRgb = cs.getPropertyValue('--bd-accent-rgb').trim() || '91 84 217'
  const dotBase = readNumber(cs, '--bd-dot-a', 0.3)
  const lineBase = readNumber(cs, '--bd-line-a', 0.1)
  const accentBase = readNumber(cs, '--bd-accent-a', 0.2)

  /**
   * 强度直接对应「底色预算的使用比例」：100% 就是预留给背景的最大 alpha，
   * 不额外放大 —— 这样滑杆的上限天然等于对比度预算的上限。
   */
  const strength = Math.min(100, Math.max(0, params.intensity)) / 100

  /**
   * 模糊补偿：`filter: blur()` 把 1px 发丝线摊到 (1 + 2r) 像素上，峰值 alpha
   * 近似按 1/(1+2r) 衰减 —— 4px 时只剩约 1/9，背景会看起来像被关掉了。
   * 所以模糊 >1px 时按同一比例加宽线宽（只加宽、不加 alpha）：
   * 总墨量守恒，对比度预算不变，但形体还能看见。
   */
  const blurComp = params.blur > 1 ? 1 + ((params.blur - 1) / 3) * 2.2 : 1

  root.style.setProperty('--bd-dot', composeRgba(rgb, dotBase * strength))
  root.style.setProperty('--bd-line', composeRgba(rgb, lineBase * strength))
  root.style.setProperty('--bd-accent', composeRgba(accentRgb, accentBase * strength))
  root.style.setProperty(
    '--bd-stroke-w',
    `${((RANGE.strokeMin + (RANGE.strokeMax - RANGE.strokeMin) * strength) * blurComp).toFixed(2)}px`,
  )

  root.style.setProperty('--bd-blur', `${params.blur}px`)
  root.style.setProperty('--bd-layer-opacity', (params.opacity / 100).toFixed(2))

  const orbitDuration = speedToDuration(RANGE.orbitSlow, RANGE.orbitFast, params.speed)
  root.style.setProperty('--bd-spin-duration', `${orbitDuration}s`)
  root.style.setProperty('--bd-spin-duration-b', `${Math.round(orbitDuration * 0.62)}s`)
  root.style.setProperty(
    '--bd-drift-duration',
    `${speedToDuration(RANGE.terrainSlow, RANGE.terrainFast, params.speed)}s`,
  )
  root.style.setProperty('--bd-run', params.speed <= 0 ? 'paused' : 'running')
}

/**
 * 参数默认值的说明文案（给面板的「恢复默认」做 aria-label 用）。
 *
 * 放在这里而不是组件里：默认值改了以后，读屏文案自动跟着走。
 */
export function describeBackdropDefaults(params: BackdropParams): string {
  return BACKDROP_PARAM_META.map((meta) => `${meta.label} ${meta.format(params[meta.key])}`).join('，')
}

/** 供面板做「这一项是否被改过」的判断。 */
export function isParamChanged(key: BackdropParamKey, value: number, defaults: BackdropParams): boolean {
  return value !== defaults[key]
}
