interface GeoMarkProps {
  /** 边长（px）。默认 20。 */
  size?: number
  /** 线宽（px）。默认 1.5。 */
  strokeWidth?: number
  /** 额外类名（不影响内部几何）。 */
  className?: string
}

/**
 * 「线构」几何标记 —— 方形 + 对角斜线 + 圆点，整套视觉语言的唯一 logo 母题。
 *
 * 用 `currentColor` 上色：放进页头就是主色，放进弹窗标题就是正文色，
 * 组件不感知主题，也不读 CSS 变量以外的颜色。
 */
export default function GeoMark({ size = 20, strokeWidth = 1.5, className }: GeoMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      className={className}
      style={{ display: 'block', flex: 'none' }}
    >
      <rect
        x={strokeWidth / 2}
        y={strokeWidth / 2}
        width={24 - strokeWidth}
        height={24 - strokeWidth}
        rx={4}
        stroke="currentColor"
        strokeWidth={strokeWidth}
      />
      <path d="M4.5 17.5 17.5 4.5" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" />
      <circle cx="17.5" cy="17.5" r="2.2" fill="currentColor" />
    </svg>
  )
}
