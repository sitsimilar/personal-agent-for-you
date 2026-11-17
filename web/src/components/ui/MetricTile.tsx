import type { ReactNode } from 'react'
import { Box, Card, Typography } from '@mui/material'
import { MONO_FONT } from '@/theme'

export type MetricGlyph = 'square' | 'circle' | 'lines'

interface MetricTileProps {
  label: string
  value: ReactNode
  unit?: string
  /** 右上角几何图形（三种母题之一，不引入第四种）。 */
  glyph?: MetricGlyph
  /** 悬浮说明（可选）。 */
  hint?: string
}

/** 右上角 18×18 几何图形：方块 / 圆 / 三条横线。 */
function Glyph({ variant }: { variant: MetricGlyph }) {
  return (
    <Box
      component="svg"
      width={18}
      height={18}
      viewBox="0 0 18 18"
      fill="none"
      aria-hidden
      sx={{ color: 'var(--brand)', opacity: 0.75, flex: 'none' }}
    >
      {variant === 'square' && <rect x="1.75" y="1.75" width="14.5" height="14.5" rx="2.5" stroke="currentColor" />}
      {variant === 'circle' && <circle cx="9" cy="9" r="7" stroke="currentColor" />}
      {variant === 'lines' && (
        <>
          <path d="M2 4.5h14M2 9h10M2 13.5h14" stroke="currentColor" strokeLinecap="round" />
          <circle cx="14.5" cy="9" r="1.75" fill="currentColor" />
        </>
      )}
    </Box>
  )
}

/**
 * 指标块：上线一条标签、下线一条发丝分隔线，数字用等宽字体。
 *
 * 不用彩色填充区分三个指标 —— 颜色只留给"需要行动"的元素，
 * 三个统计块靠右上角几何图形区分即可（方块 / 圆 / 横线）。
 */
export default function MetricTile({ label, value, unit, glyph = 'square', hint }: MetricTileProps) {
  return (
    <Card
      variant="outlined"
      className="geo-frame"
      title={hint}
      sx={{
        p: 2,
        height: '100%',
        bgcolor: 'var(--surface)',
        borderColor: 'var(--line)',
        borderRadius: 'var(--r-card)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 1 }}>
        <Typography
          component="span"
          sx={{
            fontSize: 'var(--fs-caption)',
            fontWeight: 700,
            letterSpacing: 'var(--tracking-label)',
            color: 'text.secondary',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </Typography>
        <Glyph variant={glyph} />
      </Box>

      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, mt: 1.5 }}>
        <Typography
          component="span"
          sx={{
            fontFamily: MONO_FONT,
            fontSize: 28,
            fontWeight: 700,
            lineHeight: 1,
            letterSpacing: '-0.03em',
            color: 'text.primary',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </Typography>
        {unit && (
          <Typography component="span" sx={{ fontSize: 'var(--fs-caption)', color: 'text.secondary' }}>
            {unit}
          </Typography>
        )}
      </Box>

      <Box sx={{ mt: 1.75, height: 'var(--stroke)', bgcolor: 'var(--line)' }} />
    </Card>
  )
}
