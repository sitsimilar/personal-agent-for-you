import type { ReactNode } from 'react'
import { Box, Typography } from '@mui/material'

interface EmptyStateProps {
  title: string
  description?: string
  /** 主操作（按钮/链接）。 */
  action?: ReactNode
  /** 紧凑版：用于待办分段内的空段，减少上下留白。 */
  compact?: boolean
}

/**
 * 空态：一张「线构」插图 + 一句说明 + 一个主操作。
 *
 * 插图画的是三块几何体（记录卡 / 资料块 / 虚线基准线），
 * 颜色全部走 CSS 变量，所以深浅色自动成立，不需要第二份资源。
 */
export default function EmptyState({ title, description, action, compact = false }: EmptyStateProps) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        py: compact ? 4 : 7,
        px: 2,
        borderRadius: 'var(--r-card)',
        border: '1px dashed var(--line2)',
        bgcolor: 'transparent',
      }}
    >
      <Box
        component="svg"
        width={compact ? 84 : 104}
        height={compact ? 58 : 72}
        viewBox="0 0 104 72"
        fill="none"
        aria-hidden
        sx={{ mb: 2, opacity: 0.9 }}
      >
        <rect x="8.5" y="16.5" width="52" height="40" rx="4" stroke="var(--line-strong)" />
        <path d="M22 30h24M22 38h16" stroke="var(--line-strong)" strokeLinecap="round" />
        <rect x="62.5" y="8.5" width="30" height="30" rx="4" stroke="var(--brand)" strokeOpacity="0.55" />
        <circle cx="77" cy="23" r="4" stroke="var(--brand)" strokeOpacity="0.75" />
        <path d="M52 64h40" stroke="var(--line-strong)" strokeDasharray="2 5" strokeLinecap="round" />
      </Box>

      <Typography sx={{ fontSize: 'var(--fs-body)', fontWeight: 600, color: 'text.primary' }}>{title}</Typography>
      {description && (
        <Typography sx={{ mt: 0.75, fontSize: 'var(--fs-meta)', color: 'text.secondary', maxWidth: 420 }}>
          {description}
        </Typography>
      )}
      {action && <Box sx={{ mt: 2 }}>{action}</Box>}
    </Box>
  )
}
