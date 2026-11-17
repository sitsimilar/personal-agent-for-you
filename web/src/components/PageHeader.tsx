import { Box, Button, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import type { ReactNode } from 'react'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import { useUiShellStore } from '@/store/uiShellStore'
import GeoMark from './ui/GeoMark'

interface PageHeaderProps {
  title: string
  subtitle?: string
  /** 页头右侧操作区（切换按钮/动作按钮等）。 */
  action?: ReactNode
  /**
   * 分区方案下是否在页眉带右侧显示「快速记录」。
   *
   * 默认显示；设置、回收站这类不产内容的页面传 `false`，避免页眉出现无用主操作。
   * 非分区方案下该属性无效果（按钮仍在顶栏）。
   */
  showCreate?: boolean
}

/**
 * 统一内容区页头：标题 + 副标题 + 右侧操作。
 *
 * ## 两套形态（由界面方案决定，组件内部只有一个分支）
 * - **静默化 / 流畅优先**：维持改造前的排版节奏（h6 + 13px 副标题 + 右侧操作），
 *   只把左侧补上「线构」几何标记 —— 标题的落点与操作区位置不变。
 * - **分区骨架**：升级为「页眉带」——标题 20px、描述紧随其下，
 *   右侧挂主操作「快速记录」，底部一条发丝线把页眉与内容分开。
 *
 * 为什么主操作要下移到页眉：顶栏距内容区隔着一个搜索框和头像，视线每次都要回头；
 * 放进页眉后「看标题 → 动手」是同一个视觉落点。
 */
export default function PageHeader({ title, subtitle, action, showCreate = true }: PageHeaderProps) {
  const zoned = useUiSchemeStore((s) => s.scheme === 'zoned')
  const openCreate = useUiShellStore((s) => s.openCreate)

  if (!zoned) {
    return (
      // flexWrap + 操作区 maxWidth：375 档「标题 + 一整排分段/动作按钮」一行放不下时，
      // 让操作区整块换到下一行并按可用宽度折行，而不是顶出 main 的横向滚动。
      <Box
        sx={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 2,
          rowGap: 1.25,
          mb: 2.25,
        }}
      >
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.25, minWidth: 0 }}>
          <Box sx={{ mt: '3px', color: 'primary.main', flex: 'none' }}>
            <GeoMark size={18} />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="h6" fontWeight={700} sx={{ letterSpacing: 'var(--tracking-tight)' }}>
              {title}
            </Typography>
            {subtitle && (
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.25 }}>
                {subtitle}
              </Typography>
            )}
          </Box>
        </Box>
        {action && (
          <Box sx={{ flex: 'none', minWidth: 0, maxWidth: '100%', display: 'flex', alignItems: 'center' }}>
            {action}
          </Box>
        )}
      </Box>
    )
  }

  return (
    <Box
      sx={{
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 2,
        mb: 2.5,
        pb: 1.75,
        borderBottom: 'var(--stroke) solid var(--header-band-divider)',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, minWidth: 0 }}>
        <Box sx={{ mt: '2px', color: 'primary.main', flex: 'none' }}>
          <GeoMark size={22} />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontSize: 20, fontWeight: 700, lineHeight: 1.3, letterSpacing: 'var(--tracking-tight)' }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography sx={{ fontSize: 'var(--fs-meta)', color: 'text.secondary', mt: 0.5 }}>{subtitle}</Typography>
          )}
        </Box>
      </Box>
      <Box sx={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 1 }}>
        {action}
        {showCreate && (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate} className="press">
            快速记录
          </Button>
        )}
      </Box>
    </Box>
  )
}
