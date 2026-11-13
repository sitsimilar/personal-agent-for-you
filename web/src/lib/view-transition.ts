import { flushSync } from 'react-dom'

/**
 * View Transitions 封装（仅「流畅优先」方案使用）。
 *
 * ## 为什么要 flushSync
 * `document.startViewTransition(cb)` 要求 `cb` **同步**改完 DOM，浏览器才能拍下"新帧"。
 * React 18 的 `setState` 默认是异步批处理的，不套 `flushSync` 时浏览器拍到的新帧
 * 与旧帧一样，表现为"完全没有过渡"。这是最容易踩的坑。
 *
 * ## 降级策略（三层，缺一不可）
 * 1. 浏览器不支持 `startViewTransition`（旧 WebView / 老版 Firefox）→ 直接执行，不抛错；
 * 2. 系统开启 `prefers-reduced-motion: reduce` → 直接执行（过渡会引起前庭不适）；
 * 3. `startViewTransition` 自身抛错（部分嵌入环境禁用）→ 捕获后补执行一次，
 *    保证"导航一定发生"，过渡永远只是增强项。
 *
 * **不做 UA 判断、不引 polyfill**：特性检测足够，polyfill 在旧引擎上反而更慢。
 */

/** 是否存在可用的 View Transitions API。 */
export function supportsViewTransition(): boolean {
  return typeof document !== 'undefined' && typeof document.startViewTransition === 'function'
}

/** 系统是否要求减弱动效。 */
export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

/**
 * 在 View Transition 中执行一次同步 DOM 更新（通常是路由跳转）。
 *
 * @param apply 同步执行的状态更新（内部会用 `flushSync` 包裹）
 * @returns 是否真的走了过渡（false 表示已降级为普通跳转）
 */
export function runViewTransition(apply: () => void): boolean {
  if (!supportsViewTransition() || prefersReducedMotion()) {
    apply()
    return false
  }
  try {
    document.startViewTransition(() => {
      flushSync(apply)
    })
    return true
  } catch {
    // 过渡失败不能吞掉导航——补执行一次
    apply()
    return false
  }
}
