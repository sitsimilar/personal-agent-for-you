import type { ReactNode } from 'react'
import { Box } from '@mui/material'
import { useUiSchemeStore } from '@/store/uiSchemeStore'

/**
 * 内容区容器（v2.13.1 UI-2）。
 *
 * ## 它解决什么问题
 * 改造前各页自带宽度：设置 640、待办 760、回收站 760、回顾 860、学习目标 860、
 * 插件 900、工具箱 1100、思维树 1280，首页与记录页干脆不限宽 —— **5 种以上的宽度**，
 * 宽屏上每切一页内容区的左右边界都在跳。`PageShell` 把这件事收成一处。
 *
 * ## 宽度规则（两套并存，这是刻意的）
 * | 方案 | 宽度 |
 * |---|---|
 * | 静默化 / 流畅优先 | 用各页原有的 `baseWidth`（不传=铺满）→ **使用习惯不变** |
 * | 分区骨架 | 按 `tone` 收敛：表单 860 / 列表 1120 / 看板 1280 |
 *
 * 为什么分区方案不强行全部 1120：设置页这种纯表单铺到 1120 会让每行输入框过长、
 * 阅读回扫距离变大，反而比 860 难用。所以保留三档，但**从"每页自定"变成"按内容类型选"**。
 *
 * ## aside（仅分区方案生效）
 * 传了 `aside` 且在分区方案下，才切成左右分栏（主区 2fr / 副栏 1fr，≥1200px 时生效）；
 * 其余情况 `aside` 不渲染 —— 保证另外两个方案的版面与改造前完全一致。
 */

/** 内容类型 → 分区方案下的容器宽度。 */
const TONE_MAX = {
  form: 860,
  list: 1120,
  board: 1280,
} as const

export type PageShellTone = keyof typeof TONE_MAX

interface PageShellProps {
  children: ReactNode
  /** 内容类型（决定分区方案下的宽度）。默认 `list`。 */
  tone?: PageShellTone
  /** 非分区方案下使用的宽度（沿用各页原值；不传表示铺满）。 */
  baseWidth?: number
  /** 分区方案下的右侧副栏（bento）。 */
  aside?: ReactNode
  /** 额外样式（极少数页面需要）。 */
  sx?: Record<string, unknown>
}

export default function PageShell({ children, tone = 'list', baseWidth, aside, sx }: PageShellProps) {
  const zoned = useUiSchemeStore((s) => s.scheme === 'zoned')
  const maxWidth = zoned ? TONE_MAX[tone] : baseWidth
  const withAside = zoned && Boolean(aside)

  const containerSx = {
    p: 3,
    mx: 'auto',
    width: '100%',
    ...(maxWidth ? { maxWidth } : {}),
    ...sx,
  }

  if (!withAside) {
    return <Box sx={containerSx}>{children}</Box>
  }

  return (
    <Box sx={containerSx}>
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', lg: 'minmax(0, 2fr) minmax(0, 1fr)' },
          gap: 'var(--layout-gap)',
          alignItems: 'start',
        }}
      >
        <Box sx={{ minWidth: 0 }}>{children}</Box>
        <Box sx={{ minWidth: 0, position: { lg: 'sticky' }, top: { lg: 16 } }}>{aside}</Box>
      </Box>
    </Box>
  )
}
