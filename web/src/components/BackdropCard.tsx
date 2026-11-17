import { useEffect, useState } from 'react'
import { Box, Button, Card, CardContent, Chip, Slider, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import DarkModeOutlinedIcon from '@mui/icons-material/DarkModeOutlined'
import LightModeOutlinedIcon from '@mui/icons-material/LightModeOutlined'
import ContrastOutlinedIcon from '@mui/icons-material/ContrastOutlined'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import { pushNotice } from '@/store/noticeStore'
import {
  BACKDROP_DEFAULTS,
  BACKDROP_ORDER,
  BACKDROP_PARAM_META,
  getBackdropMeta,
  getBackdropName,
  isBackdropDefault,
  type BackdropTheme,
} from '@/lib/backdrop'
import {
  CONTRAST_STEP,
  DEFAULT_CONTRAST,
  MAX_CONTRAST,
  MIN_CONTRAST,
  getColorSchemeName,
  type ColorScheme,
} from '@/lib/color-scheme'

/**
 * 设置页「背景氛围」卡片：主题 + 四个参数。
 *
 * ## 为什么不和「界面方案」合并
 * 界面方案改布局与交互，背景只改画布底纹，两者正交。混在一张卡里会让人以为
 * "换背景会挪按钮"。
 *
 * ## 参数语义
 * - 点选即时生效（不弹确认框、不刷新）；
 * - 每套主题一套推荐值；改过的值按主题记住，切走再切回来仍是你的手感；
 * - 「恢复默认」只重置当前主题；
 * - 参数与主题一起写 `localStorage`，重开还在；**不写账号、不动数据库**。
 *
 * ## 窄屏
 * 主题块 xs 单列、≥sm 两列；滑杆 xs 单列全宽，值右对齐等宽数字，
 * 三个刻度标签只保留「最小 / 中位 / 最大」，避免 390px 下文字互相压住。
 */

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    try {
      return window.matchMedia?.(REDUCED_QUERY).matches ?? false
    } catch {
      return false
    }
  })
  useEffect(() => {
    let mq: MediaQueryList | null = null
    try {
      mq = window.matchMedia(REDUCED_QUERY)
    } catch {
      return
    }
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return reduced
}

/** 四张小预览图：只用 SVG/CSS，和真实背景同一套令牌取值。 */
function BackdropPreview({ id }: { id: BackdropTheme }) {
  const common = { width: '100%', height: '100%', display: 'block' } as const

  if (id === 'off') {
    return (
      <Box
        sx={{
          width: '100%',
          height: '100%',
          backgroundImage:
            'linear-gradient(to right, var(--grid-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-line) 1px, transparent 1px)',
          backgroundSize: '16px 16px',
          bgcolor: 'var(--canvas)',
        }}
      />
    )
  }

  if (id === 'orbit') {
    return (
      <svg viewBox="0 0 96 56" style={common} aria-hidden>
        <circle cx="72" cy="28" r="24" fill="none" stroke="var(--bd-line)" strokeWidth="1" />
        <circle cx="72" cy="28" r="16" fill="none" stroke="var(--bd-accent)" strokeWidth="1" />
        <circle cx="72" cy="28" r="8" fill="none" stroke="var(--bd-line)" strokeWidth="1" />
        <circle cx="72" cy="4" r="2" fill="var(--brand)" opacity="0.7" />
        <circle cx="61" cy="17" r="1.5" fill="var(--brand)" opacity="0.45" />
        <path d="M72 4v48M48 28h48" stroke="var(--bd-line)" strokeWidth="1" />
      </svg>
    )
  }

  if (id === 'starfield') {
    const dots = [
      [12, 14], [26, 30], [40, 12], [46, 40], [60, 22], [72, 44], [84, 16], [30, 46], [56, 8], [18, 38],
    ]
    return (
      <svg viewBox="0 0 96 56" style={common} aria-hidden>
        <path d="M12 14L26 30L40 12L46 40L60 22L72 44L84 16" fill="none" stroke="var(--bd-line)" strokeWidth="0.8" />
        <path d="M18 38L30 46L46 40M26 30L18 38M60 22L56 8M40 12L56 8" fill="none" stroke="var(--bd-line)" strokeWidth="0.8" />
        {dots.map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r={i % 3 === 0 ? 1.6 : 1.1} fill="var(--bd-dot)" />
        ))}
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 96 56" style={common} aria-hidden>
      <path d="M-4 16C14 10 26 22 44 16S74 8 100 16" fill="none" stroke="var(--bd-line)" strokeWidth="1" />
      <path d="M-4 24C14 18 26 30 44 24S74 16 100 24" fill="none" stroke="var(--bd-accent)" strokeWidth="1" />
      <path d="M-4 32C14 26 26 38 44 32S74 24 100 32" fill="none" stroke="var(--bd-line)" strokeWidth="1" />
      <path d="M-4 40C14 34 26 46 44 40S74 32 100 40" fill="none" stroke="var(--bd-line)" strokeWidth="1" />
      <path d="M-4 48C14 42 26 54 44 48S74 40 100 48" fill="none" stroke="var(--bd-line)" strokeWidth="1" />
    </svg>
  )
}

export default function BackdropCard() {
  const backdrop = useUiSchemeStore((s) => s.backdrop)
  const params = useUiSchemeStore((s) => s.backdropParams[s.backdrop])
  const setBackdrop = useUiSchemeStore((s) => s.setBackdrop)
  const setBackdropParam = useUiSchemeStore((s) => s.setBackdropParam)
  const resetBackdropParams = useUiSchemeStore((s) => s.resetBackdropParams)
  const colorScheme = useUiSchemeStore((s) => s.colorScheme)
  const contrast = useUiSchemeStore((s) => s.contrast)
  const setColorScheme = useUiSchemeStore((s) => s.setColorScheme)
  const setContrast = useUiSchemeStore((s) => s.setContrast)
  const reduced = useReducedMotion()
  const active = getBackdropMeta(backdrop)
  const disabled = backdrop === 'off'
  const defaults = BACKDROP_DEFAULTS[backdrop]
  const atDefault = isBackdropDefault(backdrop, params)

  const pickColor = (next: ColorScheme) => {
    if (next === colorScheme) return
    const previous = setColorScheme(next)
    pushNotice(`深浅色已切换为「${getColorSchemeName(next)}」`, 'info', {
      label: '撤销',
      onAction: () => useUiSchemeStore.getState().setColorScheme(previous),
    })
  }

  const pick = (next: BackdropTheme) => {
    if (next === backdrop) return
    const previous = setBackdrop(next)
    pushNotice(`背景已切换到「${getBackdropName(next)}」`, 'info', {
      label: '撤销',
      onAction: () => {
        useUiSchemeStore.getState().setBackdrop(previous)
      },
    })
  }

  const restore = () => {
    if (atDefault && contrast === DEFAULT_CONTRAST) return
    resetBackdropParams()
    setContrast(DEFAULT_CONTRAST)
    pushNotice(`已恢复「${active.name}」的推荐参数 + 默认对比度`, 'info')
  }

  return (
    <Card variant="outlined" id="ui-backdrop" sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="subtitle2" gutterBottom>
          外观
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
          深浅色三档（跟随系统 / 强制浅色 / 强制深色）+ 对比度滑杆；
          背景氛围在下面四选一。<b>都只存本机</b>（不写账号，换设备不会同步）。
        </Typography>

        {/* ---- 深浅色 + 对比度 ---- */}
        <Box sx={{
          display: 'grid',
          gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1.1fr) minmax(0, 1fr)' },
          gap: 2,
          pb: 2,
          mb: 2,
          borderBottom: '1px dashed',
          borderColor: 'divider',
        }}>
          {/* 深浅色 */}
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
              <LightModeOutlinedIcon sx={{ fontSize: 15, color: 'var(--ink3)' }} />
              <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>深浅色</Typography>
              {colorScheme !== 'system' && (
                <Box
                  component="span"
                  sx={{ width: 4, height: 4, borderRadius: '50%', bgcolor: 'primary.main' }}
                />
              )}
            </Box>
            <ToggleButtonGroup
              value={colorScheme}
              exclusive
              size="small"
              onChange={(_e, v) => v && pickColor(v as ColorScheme)}
              aria-label="深浅色模式"
              sx={{
                height: 30,
                '& .MuiToggleButton-root': {
                  fontSize: 11.5,
                  px: 1.25,
                  borderColor: 'divider',
                  '&.Mui-selected': {
                    bgcolor: 'action.selected',
                    color: 'primary.main',
                    fontWeight: 600,
                  },
                },
              }}
            >
              <ToggleButton value="light" aria-label="强制浅色">
                浅色
              </ToggleButton>
              <ToggleButton value="system" aria-label="跟随系统">
                跟随系统
              </ToggleButton>
              <ToggleButton value="dark" aria-label="强制深色">
                深色
              </ToggleButton>
            </ToggleButtonGroup>
            <Typography sx={{ fontSize: 11, color: 'var(--ink3)', lineHeight: 1.5, mt: 0.75 }}>
              默认「跟随系统」。切到强制档位后系统深浅色变化不会自动跟随；
              切回「跟随系统」立即恢复监听。
            </Typography>
          </Box>

          {/* 对比度 */}
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.5 }}>
              <ContrastOutlinedIcon sx={{ fontSize: 15, color: 'var(--ink3)' }} />
              <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>对比度</Typography>
              {contrast !== DEFAULT_CONTRAST && (
                <Box
                  component="span"
                  sx={{ width: 4, height: 4, borderRadius: '50%', bgcolor: 'primary.main' }}
                />
              )}
              <Box sx={{ flex: 1 }} />
              <Typography
                sx={{
                  fontSize: 12,
                  fontFamily: '"JetBrains Mono", SFMono-Regular, Consolas, monospace',
                  fontVariantNumeric: 'tabular-nums',
                  color: contrast === DEFAULT_CONTRAST ? 'var(--ink3)' : 'primary.main',
                  fontFeatureSettings: '"tnum"',
                }}
              >
                {contrast.toFixed(1)}×
              </Typography>
            </Box>
            <Slider
              size="small"
              value={contrast}
              min={MIN_CONTRAST}
              max={MAX_CONTRAST}
              step={CONTRAST_STEP}
              marks={[
                { value: MIN_CONTRAST, label: '柔和' },
                { value: DEFAULT_CONTRAST, label: '默认' },
                { value: MAX_CONTRAST, label: '增强' },
              ]}
              valueLabelDisplay="auto"
              valueLabelFormat={(v) => `${v.toFixed(1)}×`}
              onChange={(_e, v) => setContrast(v as number)}
              aria-label={`对比度，当前 ${contrast.toFixed(1)}×`}
              sx={{ mt: 0.25, mb: '26px', '& .MuiSlider-markLabel': { fontSize: 10, color: 'var(--ink3)' } }}
            />
            <Typography sx={{ fontSize: 11, color: 'var(--ink3)', lineHeight: 1.5 }}>
              同时作用于背景层 alpha 预算（柔和 ×0.6 / 增强 ×1.5）与正文次调色。
              硬 cap 保证不会盖过正文。
            </Typography>
          </Box>
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 1 }}>
          {BACKDROP_ORDER.map((id) => {
            const meta = getBackdropMeta(id)
            const selected = id === backdrop
            return (
              <Box
                key={id}
                role="radio"
                aria-checked={selected}
                tabIndex={0}
                onClick={() => pick(id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    pick(id)
                  }
                }}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1.25,
                  border: '1px solid',
                  borderColor: selected ? 'primary.main' : 'divider',
                  borderRadius: 'var(--r-ctl)',
                  p: 1,
                  cursor: 'pointer',
                  transition: 'border-color 140ms ease, background-color 140ms ease',
                  '&:hover': { borderColor: selected ? 'primary.main' : 'text.disabled' },
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
                }}
              >
                <Box
                  sx={{
                    width: 96,
                    height: 56,
                    flex: 'none',
                    border: '1px solid',
                    borderColor: 'divider',
                    borderRadius: 'var(--r-mark)',
                    overflow: 'hidden',
                    bgcolor: 'var(--canvas)',
                  }}
                >
                  <BackdropPreview id={id} />
                </Box>
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
                    {selected ? (
                      <CheckCircleIcon sx={{ fontSize: 15, color: 'primary.main' }} />
                    ) : (
                      <RadioButtonUncheckedIcon sx={{ fontSize: 15, color: 'text.disabled' }} />
                    )}
                    <Typography sx={{ fontSize: 13, fontWeight: 600 }}>{meta.name}</Typography>
                  </Box>
                  <Typography sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.5, mt: 0.25 }}>
                    {meta.tagline}
                  </Typography>
                </Box>
              </Box>
            )
          })}
        </Box>

        {/* ---- 参数面板 ---- */}
        <Box sx={{ mt: 2, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 0.5 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600 }}>参数</Typography>
            <Typography sx={{ fontSize: 11, color: 'var(--ink3)' }}>
              {disabled ? '选一套背景后可调' : `${active.name} · 推荐值已套用，改动会按主题记住`}
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button
              size="small"
              variant="outlined"
              startIcon={<RestartAltIcon sx={{ fontSize: 15 }} />}
              onClick={restore}
              disabled={disabled || atDefault}
              sx={{ minWidth: 0, py: 0.25, px: 1, fontSize: 11.5 }}
            >
              恢复默认
            </Button>
          </Box>

          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'minmax(0, 1fr) minmax(0, 1fr)' },
              columnGap: { md: 3 },
              rowGap: 1.5,
              mt: 1,
              opacity: disabled ? 0.45 : 1,
              transition: 'opacity 140ms linear',
            }}
          >
            {BACKDROP_PARAM_META.map((meta) => {
              const value = params[meta.key]
              const changed = value !== defaults[meta.key]
              return (
                <Box key={meta.key} sx={{ minWidth: 0 }}>
                  <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
                    <Typography sx={{ fontSize: 12.5, fontWeight: 600 }}>{meta.label}</Typography>
                    {changed && !disabled && (
                      <Box
                        component="span"
                        sx={{
                          width: 4,
                          height: 4,
                          borderRadius: '50%',
                          bgcolor: 'primary.main',
                          alignSelf: 'center',
                        }}
                      />
                    )}
                    <Box sx={{ flex: 1 }} />
                    <Typography
                      sx={{
                        fontSize: 12,
                        fontFamily: '"JetBrains Mono", SFMono-Regular, Consolas, monospace',
                        fontVariantNumeric: 'tabular-nums',
                        color: disabled ? 'var(--ink3)' : 'primary.main',
                        fontFeatureSettings: '"tnum"',
                      }}
                    >
                      {meta.format(value)}
                    </Typography>
                  </Box>
                  <Slider
                    size="small"
                    value={value}
                    min={meta.min}
                    max={meta.max}
                    step={meta.step}
                    marks={meta.marks}
                    valueLabelDisplay="auto"
                    valueLabelFormat={meta.format}
                    onChange={(_e, v) => setBackdropParam(meta.key, v as number)}
                    disabled={disabled}
                    aria-label={`${meta.label}，当前 ${meta.format(value)}`}
                    sx={{
                      mt: 0.25,
                      // 给刻度文字留出垂直空间，否则会和下面的说明叠在一起
                      mb: '26px',
                      '& .MuiSlider-thumb': { width: 14, height: 14 },
                      '& .MuiSlider-markLabel': { fontSize: 10, color: 'var(--ink3)' },
                    }}
                  />
                  <Typography sx={{ fontSize: 11, color: 'var(--ink3)', lineHeight: 1.5 }}>
                    {meta.hint}
                  </Typography>
                </Box>
              )
            })}
          </Box>

          <Box
            sx={{
              mt: 1.25,
              pt: 1,
              borderTop: '1px dashed',
              borderColor: 'divider',
              display: 'flex',
              flexDirection: 'column',
              gap: 0.4,
            }}
          >
            <Typography sx={{ fontSize: 11.5, fontWeight: 600, color: 'text.secondary' }}>
              取值范围与安全上限
            </Typography>
            {BACKDROP_PARAM_META.map((meta) => (
              <Typography key={meta.key} sx={{ fontSize: 11, color: 'var(--ink3)', lineHeight: 1.6 }}>
                <b>
                  {meta.label} {meta.min}
                  {meta.unit}–{meta.max}
                  {meta.unit}
                </b>
                ：{meta.safe}
              </Typography>
            ))}
          </Box>

          <Box sx={{ mt: 1, display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
            {reduced && (
              <Chip
                size="small"
                label="系统已开启减弱动效：背景自动静态化"
                variant="outlined"
                sx={{ height: 20, fontSize: 10.5 }}
              />
            )}
            <Typography sx={{ fontSize: 11, color: 'var(--ink3)' }}>
              背景层不接收点击（pointer-events: none），正文卡片保持不透明底色；参数与主题一起存在本机。
            </Typography>
          </Box>
        </Box>

        <Box sx={{ mt: 1.5, display: 'flex', flexDirection: 'column', gap: 0.35 }}>
          {[
            ['气质', active.feel],
            ['性能', active.cost],
            ['适合', active.scene],
            ['实现', active.how],
          ].map(([label, text]) => (
            <Box key={label} sx={{ display: 'flex', gap: 1, minWidth: 0 }}>
              <Typography sx={{ width: 28, flex: 'none', fontSize: 11.5, color: 'var(--ink3)' }}>
                {label}
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.6 }}>{text}</Typography>
            </Box>
          ))}
          <Typography sx={{ fontSize: 11.5, color: 'var(--ink3)', mt: 0.25 }}>
            参考：{active.source}
          </Typography>
        </Box>
      </CardContent>
    </Card>
  )
}
