import { useState, type MouseEvent } from 'react'
import {
  Box,
  Chip,
  Divider,
  IconButton,
  ListItemButton,
  Popover,
  Tooltip,
  Typography,
} from '@mui/material'
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined'
import CheckIcon from '@mui/icons-material/Check'
import { useNavigate } from 'react-router-dom'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import { pushNotice } from '@/store/noticeStore'
import {
  UI_SCHEME_ORDER,
  getUiSchemeMeta,
  getUiSchemeName,
  summarizeUiSchemeChange,
} from '@/lib/ui-scheme'

import {
  BACKDROP_ORDER,
  getBackdropMeta,
  getBackdropName,
  type BackdropTheme,
} from '@/lib/backdrop'

import { getColorSchemeName, type ColorScheme } from '@/lib/color-scheme'

/**
 * 顶栏「界面方案」快捷入口（方案切换的独立入口之一，另一个在设置页）。
 *
 * ## 为什么顶栏要放一个入口
 * 设置页那个入口是"改一次就不再来"的；但用户在真正用界面的时候才会意识到
 * "这个方案不适合我"。放在顶栏，切换成本是两次点击，且**不用离开当前页**
 * —— 切完立刻能看到当前页面的变化，这是判断"适不适合"的唯一方式。
 *
 * ## 防误操作的三层设计
 * 1. **不自动关**：切换后 Popover 关闭，但底部 toast 保留 6 秒可「撤销」；
 * 2. **说清代价**：跨维度切换（如静默→分区会挪按钮位置）时，撤销条文案会点明"按钮位置变了"；
 * 3. **不改数据**：方案只影响呈现，任何时候切回去都是原样，没有数据迁移风险（这点写在设置页）。
 */
export default function SchemeSwitcher() {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const scheme = useUiSchemeStore((s) => s.scheme)
  const backdrop = useUiSchemeStore((s) => s.backdrop)
  const colorScheme = useUiSchemeStore((s) => s.colorScheme)
  const setScheme = useUiSchemeStore((s) => s.setScheme)
  const setBackdrop = useUiSchemeStore((s) => s.setBackdrop)
  const setColorScheme = useUiSchemeStore((s) => s.setColorScheme)
  const navigate = useNavigate()

  const handleOpen = (e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget)
  const handleClose = () => setAnchor(null)

  const pick = (next: (typeof UI_SCHEME_ORDER)[number]) => {
    handleClose()
    if (next === scheme) return
    const { previous } = setScheme(next)
    const summary = summarizeUiSchemeChange(previous, next)
    pushNotice(`已切换到「${getUiSchemeName(next)}」· ${summary.notes[0]}`, 'info', {
      label: '撤销',
      onAction: () => {
        useUiSchemeStore.getState().setScheme(previous)
      },
    })
  }

  /** 背景氛围在这里也放一份快捷切换：用户往往是在当前页对比时才有判断。 */
  const pickBackdrop = (next: BackdropTheme) => {
    if (next === backdrop) return
    const previous = setBackdrop(next)
    pushNotice(`背景已切换到「${getBackdropName(next)}」`, 'info', {
      label: '撤销',
      onAction: () => {
        useUiSchemeStore.getState().setBackdrop(previous)
      },
    })
  }

  /** 深浅色三档快捷切换。 */
  const pickColor = (next: ColorScheme) => {
    if (next === colorScheme) return
    const previous = setColorScheme(next)
    pushNotice(`深浅色已切换为「${getColorSchemeName(next)}」`, 'info', {
      label: '撤销',
      onAction: () => useUiSchemeStore.getState().setColorScheme(previous),
    })
  }

  return (
    <>
      <Tooltip title={`界面方案：${getUiSchemeName(scheme)}（点击切换）`}>
        {/* minWidth/minHeight 44：§八 第 5 项要求触摸目标 ≥44×44，size="small" 只有 30×30 */}
        <IconButton
          onClick={handleOpen}
          aria-label="切换界面方案"
          size="small"
          sx={{ minWidth: 44, minHeight: 44 }}
        >
          <PaletteOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>

      <Popover
        open={!!anchor}
        anchorEl={anchor}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 336, mt: 1 } } }}
      >
        <Box sx={{ px: 2, pt: 1.75, pb: 1 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600 }}>界面方案</Typography>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25 }}>
            只改呈现方式，不改任何数据；随时可以换回来
          </Typography>
        </Box>

        {UI_SCHEME_ORDER.map((id) => {
          const meta = getUiSchemeMeta(id)
          const active = id === scheme
          return (
            <ListItemButton
              key={id}
              selected={active}
              onClick={() => pick(id)}
              sx={{ alignItems: 'flex-start', py: 1, px: 2, gap: 1 }}
            >
              <Box sx={{ width: 18, flex: 'none', pt: 0.25 }}>
                {active && <CheckIcon sx={{ fontSize: 16, color: 'primary.main' }} />}
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{meta.name}</Typography>
                  <Chip
                    size="small"
                    label={meta.dimension}
                    sx={{ height: 18, fontSize: 10.5, bgcolor: 'action.hover' }}
                  />
                  {meta.recommended && (
                    <Chip
                      size="small"
                      label="默认"
                      color="primary"
                      variant="outlined"
                      sx={{ height: 18, fontSize: 10.5 }}
                    />
                  )}
                </Box>
                <Typography sx={{ fontSize: 11.5, color: 'text.secondary', mt: 0.25 }}>
                  {meta.tagline}
                </Typography>
              </Box>
            </ListItemButton>
          )
        })}

        <Divider />
        <Box sx={{ px: 2, py: 1.25 }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>深浅色</Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25, mb: 0.75 }}>
            默认「跟随系统」；切强制档位后系统变化不自动跟随
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {(['system', 'light', 'dark'] as const).map((id) => (
              <Chip
                key={id}
                size="small"
                label={getColorSchemeName(id)}
                color={id === colorScheme ? 'primary' : 'default'}
                variant={id === colorScheme ? 'filled' : 'outlined'}
                onClick={() => pickColor(id)}
                sx={{ height: 24, fontSize: 11.5 }}
              />
            ))}
          </Box>
        </Box>

        <Divider />
        <Box sx={{ px: 2, py: 1.25 }}>
          <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>背景氛围</Typography>
          <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25, mb: 0.75 }}>
            只改画布底纹，不写账号；选「关闭」即刻停止渲染
          </Typography>
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {BACKDROP_ORDER.map((id) => (
              <Chip
                key={id}
                size="small"
                label={getBackdropMeta(id).name}
                color={id === backdrop ? 'primary' : 'default'}
                variant={id === backdrop ? 'filled' : 'outlined'}
                onClick={() => pickBackdrop(id)}
                sx={{ height: 24, fontSize: 11.5 }}
              />
            ))}
          </Box>
        </Box>

        <Divider />
        <Box sx={{ px: 2, py: 1 }}>
          <Typography
            component="button"
            onClick={() => {
              handleClose()
              navigate('/settings#ui-scheme')
            }}
            sx={{
              all: 'unset',
              cursor: 'pointer',
              fontSize: 12,
              color: 'primary.main',
              '&:hover': { textDecoration: 'underline' },
            }}
          >
            查看三个方案的详细差异 →
          </Typography>
        </Box>
      </Popover>
    </>
  )
}
