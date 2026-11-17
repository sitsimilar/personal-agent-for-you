import { Box } from '@mui/material'

/**
 * 列表骨架屏（仅「流畅优先」方案使用）。
 *
 * ## 为什么不用居中转圈
 * 转圈表示"不知道要多久"，骨架表示"马上就是这个形状"。后者让用户在等待期间
 * 就已经建立起版面的心理模型，内容出现时不会"跳一下"。
 *
 * ## 尺寸约定
 * 高度按 `rows` 与 `density` 推出来，**与真实行高一致**，所以替换时 CLS 为 0。
 * 改真实行高时记得同步这里的 `rowHeight`，否则会出现换行抖动。
 */
interface SkeletonListProps {
  /** 占位行数。默认 5。 */
  rows?: number
  /** 单行高度（px）。默认 56，对应待办/记录列表的紧凑行。 */
  rowHeight?: number
  /** 每行是否显示左侧方框（卡片式列表用）。 */
  avatar?: boolean
}

export default function SkeletonList({ rows = 5, rowHeight = 56, avatar = false }: SkeletonListProps) {
  return (
    <Box role="status" aria-label="加载中" sx={{ py: 0.5 }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Box
          key={i}
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1.5,
            height: rowHeight,
            px: 1.5,
            mb: 1,
            border: 'var(--stroke) solid var(--line)',
            borderRadius: 'var(--r-card)',
            bgcolor: 'var(--surface)',
            boxShadow: 'var(--shadow-card)',
          }}
        >
          {avatar && (
            <Box className="skeleton" sx={{ width: 28, height: 28, borderRadius: 'var(--r-ctl)', flex: 'none' }} />
          )}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Box
              className="skeleton"
              sx={{ height: 12, width: `${70 - (i % 3) * 12}%`, mb: 1 }}
            />
            <Box className="skeleton" sx={{ height: 10, width: `${40 - (i % 2) * 10}%` }} />
          </Box>
        </Box>
      ))}
    </Box>
  )
}
