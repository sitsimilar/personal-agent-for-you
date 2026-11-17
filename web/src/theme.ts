import { createTheme, type Theme } from '@mui/material/styles'

/** 等宽字体 token（代码编辑器/输出面板/数字统计共用）。 */
export const MONO_FONT = '"JetBrains Mono",SFMono-Regular,Consolas,"Liberation Mono",monospace'

/**
 * 设计语言：**线构 · Line Geometry**（v2.14 视觉升级）
 *
 * 三条母题（组件里只允许用这三种几何装饰，别再发明第四种）：
 * 1. **线**：1px 发丝描边承担所有层级，阴影只作"贴地"补充，不用大面积色块；
 * 2. **圆点**：类型/状态用 6px 圆点或 32px 方形字形块表示；
 * 3. **切角**：卡片右上角 14px 的 L 形直角，悬停时由 0 → 1 出现。
 *
 * 令牌分层（改之前先读 `lib/ui-scheme.ts` 文件头）：
 * - `PALETTE`：语义色，浅/深各一份，**同名同义**；
 * - `TYPE_SCALE`：六档字号（hero 只用于首页/预览，不进正文）；
 * - `SPACE`：4pt 节奏，页面内边距只允许 12/16/24/32/48；
 * - `RADIUS` / `STROKE`：圆角四档 + 描边三档；
 * - `MOTION`：按压 / 进场 / 退场 / 位移四档 + 列表错峰。
 *
 * 深浅色不是两套主题：MUI theme 由 `buildTheme(mode)` 从同一份语义令牌派生，
 * CSS 变量在 `index.css` 里按 `[data-theme='dark']` 覆盖，组件只读变量或 theme。
 */

/**
 * 全局动效 token —— 分四档 + 一个错峰值（v2.14 线构）。
 *
 * 旧版只有 enter/exit/move 三档，按压反馈仍靠浏览器默认的 300ms 过渡，点下去"钝"。
 * 现在补 `press`（90ms，只做 transform/opacity）与 `fast`（120ms，悬停描边变色），
 * 硬上限仍是 260ms：超过这个值用户会开始觉得"卡"，而不是"顺"。
 */
export const MOTION = {
  /** 按压反馈（仅针对可点块面，90ms 内完成）。 */
  press: 90,
  /** 轻量状态变化（描边、底色、悬停）。 */
  fast: 120,
  /** 进场时长（ms）。 */
  enter: 220,
  /** 退场时长（ms）。 */
  exit: 140,
  /** 位移时长（ms）。 */
  move: 260,
  /** 旧字段保留：等价于 `enter`，避免既有调用点语义突变。 */
  duration: 220,
  /** 启动界面→内容交叉淡出时长（ms）。 */
  bootDuration: 240,
  /** 列表错峰：第 n 项延迟 = n × stagger（n 最多取 8，尾部不再累积）。 */
  stagger: 26,
  /** 进场缓动（快出慢收）。 */
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** 退场缓动。 */
  exitEase: 'cubic-bezier(0.4, 0, 1, 1)',
  /** 统一缓动曲线（位移与通用过渡）。 */
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
  /** 带一点回弹的落位曲线（卡片抬起、面板出现）。 */
  spring: 'cubic-bezier(0.2, 0.9, 0.2, 1)',
  /** 旧字段保留：退场缓动的历史命名。 */
  easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
} as const

/** 六档字号（正文只允许 title/body/meta/caption，hero/display 用于页头与数字）。 */
export const TYPE_SCALE = {
  hero: 30,
  display: 24,
  title: 16,
  body: 14,
  meta: 13,
  caption: 11.5,
} as const

/** 4pt 间距节奏（组件里用 MUI spacing 时等价于 theme.spacing(n/4)）。 */
export const SPACE = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
  xxxl: 64,
} as const

/** 圆角四档：几何标记 3 / 控件 8 / 卡片 12 / 弹层 16；胶囊单独 999。 */
export const RADIUS = {
  mark: 3,
  control: 8,
  card: 12,
  popover: 16,
  pill: 999,
} as const

/** 描边三档：发丝 1 / 强调 1.5 / 选中 2。 */
export const STROKE = {
  hair: 1,
  strong: 1.5,
  accent: 2,
} as const

export type ThemeMode = 'light' | 'dark'

/** 语义色板：浅/深同名同义，组件读语义不读具体色值。 */
export interface DesignPalette {
  brand: string
  brandDark: string
  brandLight: string
  /** 品牌色 8% 底（悬停/图表填充）。 */
  brandSoft: string
  /** 品牌色 14% 底（选中态）。 */
  brandSoft2: string
  ink: string
  ink2: string
  ink3: string
  /** 发丝分隔线。 */
  line: string
  /** 控件描边。 */
  line2: string
  /** 悬停描边。 */
  lineStrong: string
  surface: string
  surface2: string
  canvas: string
  /** 页面背景的几何网格线。 */
  grid: string
  success: string
  warning: string
  danger: string
  info: string
  /** 键盘焦点环。 */
  focus: string
  shadowCard: string
  shadowHover: string
  /** 骨架屏渐变两端。 */
  skeletonA: string
  skeletonB: string
}

/** 浅色：白底 + 发丝线，主色保持既有品牌紫（不换身份，只换表达方式）。 */
export const LIGHT_PALETTE: DesignPalette = {
  brand: '#5B54D9',
  brandDark: '#4A43C4',
  brandLight: '#6B64E3',
  brandSoft: 'rgba(91,84,217,0.08)',
  brandSoft2: 'rgba(91,84,217,0.14)',
  ink: '#18181B',
  ink2: '#5F5F6B',
  ink3: '#9A9AA6',
  line: '#ECECF1',
  line2: '#E2E2E9',
  lineStrong: '#C6C6D3',
  surface: '#FFFFFF',
  surface2: '#F4F4F7',
  canvas: '#F7F7F9',
  grid: 'rgba(24,24,27,0.045)',
  success: '#15803D',
  warning: '#B45309',
  danger: '#C4342F',
  info: '#0E7490',
  focus: 'rgba(91,84,217,0.55)',
  shadowCard: '0 1px 2px rgba(24,24,27,0.04)',
  shadowHover: '0 10px 24px -14px rgba(24,24,27,0.28), 0 1px 2px rgba(24,24,27,0.04)',
  skeletonA: '#ECECF2',
  skeletonB: '#F7F7FA',
}

/**
 * 深色：不是"把白底反相"，而是重新定层级 ——
 * 卡片比画布**亮**（surface #16161C > canvas #0F0F13），描边比浅色更明显，
 * 主色提亮到 #8C86FF 保证 4.5:1 对比度。
 */
export const DARK_PALETTE: DesignPalette = {
  brand: '#8C86FF',
  brandDark: '#736CEB',
  brandLight: '#A6A0FF',
  brandSoft: 'rgba(140,134,255,0.12)',
  brandSoft2: 'rgba(140,134,255,0.2)',
  ink: '#F2F2F6',
  ink2: '#A5A5B4',
  ink3: '#74748A',
  line: '#24242D',
  line2: '#30303B',
  lineStrong: '#484857',
  surface: '#16161C',
  surface2: '#1D1D25',
  canvas: '#0F0F13',
  grid: 'rgba(255,255,255,0.05)',
  success: '#4ADE80',
  warning: '#FBBF24',
  danger: '#F87171',
  info: '#67E8F9',
  focus: 'rgba(140,134,255,0.65)',
  shadowCard: '0 1px 2px rgba(0,0,0,0.5)',
  shadowHover: '0 14px 30px -18px rgba(0,0,0,0.9), 0 1px 2px rgba(0,0,0,0.5)',
  skeletonA: '#20202A',
  skeletonB: '#2B2B36',
}

/** 当前默认（浅色）令牌 —— 旧调用点 `TOKENS.xxx` 保持不变。 */
export const TOKENS = {
  ...LIGHT_PALETTE,
  radiusControl: RADIUS.control,
  radiusCard: RADIUS.card,
  radiusPopover: RADIUS.popover,
} as const

/** 取某个模式的语义色板（未知值回落浅色，绝不返回 undefined）。 */
export function paletteFor(mode: ThemeMode): DesignPalette {
  return mode === 'dark' ? DARK_PALETTE : LIGHT_PALETTE
}

/**
 * 从语义令牌派生 MUI 主题。
 *
 * 只做"令牌 → MUI"的翻译，不在这里写任何页面级样式；
 * 三种界面方案（静默/分区/流畅）仍然共用这一份主题，差异留在 CSS 变量与能力位里。
 */
export function buildTheme(mode: ThemeMode = 'light'): Theme {
  const p = paletteFor(mode)
  const dark = mode === 'dark'

  return createTheme({
    palette: {
      mode,
      primary: {
        main: p.brand,
        dark: p.brandDark,
        light: p.brandLight,
        contrastText: dark ? '#101014' : '#FFFFFF',
      },
      secondary: {
        main: p.info,
        contrastText: dark ? '#101014' : '#FFFFFF',
      },
      error: { main: p.danger },
      warning: { main: p.warning },
      success: { main: p.success },
      info: { main: p.info },
      background: {
        default: p.canvas,
        paper: p.surface,
      },
      text: {
        primary: p.ink,
        secondary: p.ink2,
        disabled: p.ink3,
      },
      divider: p.line2,
      action: {
        hover: dark ? 'rgba(255,255,255,0.06)' : 'rgba(24,24,27,0.04)',
        selected: p.brandSoft2,
        focus: p.brandSoft,
      },
    },
    shape: {
      borderRadius: RADIUS.control,
    },
    typography: {
      fontFamily:
        '"Noto Sans SC","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
      h3: { fontSize: TYPE_SCALE.hero, fontWeight: 700, lineHeight: 1.2, letterSpacing: '-0.01em' },
      h4: { fontSize: TYPE_SCALE.display, fontWeight: 700, lineHeight: 1.3, letterSpacing: '-0.01em' },
      h5: { fontSize: 20, fontWeight: 700, lineHeight: 1.35 },
      h6: { fontSize: TYPE_SCALE.title, fontWeight: 700, lineHeight: 1.45 },
      subtitle1: { fontSize: TYPE_SCALE.title, fontWeight: 600 },
      subtitle2: { fontSize: TYPE_SCALE.meta, fontWeight: 600 },
      body1: { fontSize: TYPE_SCALE.body, lineHeight: 1.6 },
      body2: { fontSize: TYPE_SCALE.meta, lineHeight: 1.55 },
      caption: { fontSize: TYPE_SCALE.caption, lineHeight: 1.45 },
      button: { fontSize: TYPE_SCALE.meta, fontWeight: 600, textTransform: 'none' },
      overline: { fontSize: 10.5, fontWeight: 700, letterSpacing: '0.14em', lineHeight: 1.4 },
    },
    components: {
      MuiButton: {
        defaultProps: { disableElevation: true },
        styleOverrides: {
          root: {
            textTransform: 'none',
            borderRadius: RADIUS.control,
            fontWeight: 600,
            // 线构：按钮不做投影，靠底色与描边区分
            boxShadow: 'none',
            transition: `background-color ${MOTION.fast}ms ${MOTION.easing}, border-color ${MOTION.fast}ms ${MOTION.easing}, color ${MOTION.fast}ms ${MOTION.easing}, transform ${MOTION.press}ms ${MOTION.easing}`,
            '&:active': { transform: 'scale(0.985)' },
            '&:hover': { boxShadow: 'none' },
          },
          sizeSmall: { minHeight: 30, paddingInline: 12 },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            borderRadius: RADIUS.card,
            borderColor: p.line,
            backgroundImage: 'none',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: { backgroundImage: 'none' },
          outlined: { borderColor: p.line },
          rounded: { borderRadius: RADIUS.card },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: {
            borderRadius: RADIUS.popover,
            border: `${STROKE.hair}px solid ${p.line2}`,
            backgroundImage: 'none',
            boxShadow: dark
              ? '0 24px 64px -24px rgba(0,0,0,0.85)'
              : '0 24px 64px -28px rgba(24,24,27,0.28)',
          },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: {
            borderRadius: RADIUS.popover,
            border: `${STROKE.hair}px solid ${p.line2}`,
            backgroundImage: 'none',
          },
        },
      },
      MuiMenu: {
        styleOverrides: {
          paper: {
            borderRadius: RADIUS.popover,
            border: `${STROKE.hair}px solid ${p.line2}`,
            backgroundImage: 'none',
          },
        },
      },
      MuiTooltip: {
        styleOverrides: {
          tooltip: {
            borderRadius: RADIUS.control,
            fontSize: TYPE_SCALE.caption,
            backgroundColor: dark ? p.surface2 : p.ink,
            color: dark ? p.ink : p.surface,
            border: dark ? `${STROKE.hair}px solid ${p.line2}` : 'none',
          },
        },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: RADIUS.control,
            position: 'relative',
            '&:hover': { backgroundColor: p.brandSoft },
            '&.Mui-selected': { backgroundColor: p.brandSoft2 },
            '&.Mui-selected:hover': { backgroundColor: p.brandSoft2 },
            // 选中项左侧 2px 竖线：线构语言里"当前位置"只用一个几何量表达
            '&.Mui-selected::before': {
              content: '""',
              position: 'absolute',
              left: 0,
              top: 7,
              bottom: 7,
              width: STROKE.accent,
              borderRadius: RADIUS.mark,
              backgroundColor: p.brand,
            },
          },
        },
      },
      MuiDivider: {
        styleOverrides: {
          root: { borderColor: p.line },
        },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: RADIUS.control,
            '& .MuiOutlinedInput-notchedOutline': { borderColor: p.line2 },
            '&:hover .MuiOutlinedInput-notchedOutline': { borderColor: p.lineStrong },
            '&.Mui-focused .MuiOutlinedInput-notchedOutline': {
              borderWidth: STROKE.strong,
              borderColor: p.brand,
            },
          },
        },
      },
      MuiChip: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            fontWeight: 600,
          },
          outlined: { borderColor: p.line2 },
        },
      },
      MuiToggleButton: {
        styleOverrides: {
          root: {
            textTransform: 'none',
            borderRadius: RADIUS.control,
            fontWeight: 600,
            borderColor: p.line2,
            '&.Mui-selected': {
              backgroundColor: p.brandSoft2,
              color: p.brand,
              borderColor: p.brand,
              '&:hover': { backgroundColor: p.brandSoft2 },
            },
          },
        },
      },
      MuiToggleButtonGroup: {
        styleOverrides: {
          root: { borderRadius: RADIUS.control, gap: 4 },
          grouped: {
            border: `${STROKE.hair}px solid ${p.line2} !important`,
            borderRadius: `${RADIUS.control}px !important`,
            margin: 0,
          },
        },
      },
      MuiCheckbox: {
        styleOverrides: {
          root: { padding: 8, borderRadius: 6 },
        },
      },
      MuiPaginationItem: {
        styleOverrides: {
          root: { borderRadius: RADIUS.control },
        },
      },
      MuiAvatar: {
        styleOverrides: {
          root: { borderRadius: 10 },
        },
      },
      MuiDialogTitle: {
        styleOverrides: {
          root: { fontWeight: 700, paddingBottom: 12 },
        },
      },
    },
  })
}

const theme = buildTheme('light')

export default theme
