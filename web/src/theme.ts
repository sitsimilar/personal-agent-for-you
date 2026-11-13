import { createTheme } from '@mui/material/styles'

/** 等宽字体 token（代码编辑器/输出面板共用）。 */
export const MONO_FONT = '"JetBrains Mono",SFMono-Regular,Consolas,"Liberation Mono",monospace'

/**
 * 全局动效 token —— **分三档**（v2.13.1 UI-3）。
 *
 * 旧版所有场景统一 180ms，看不出"谁轻谁重"。现在按语义分档：
 * - `enter` 进场：新内容出现（页面切换、面板展开）
 * - `exit`  退场：内容消失（关闭、收起）—— 退场必须比进场快，否则拖沓
 * - `move`  位移：元素在屏内移动（列表重排、抽屉推挤）
 *
 * 硬上限 260ms：超过这个值用户会开始觉得"卡"，而不是"顺"。
 * 装饰性动效一律不做（只给"状态变化"配动效）。
 */
export const MOTION = {
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
  /** 进场缓动（快出慢收）。 */
  easeOut: 'cubic-bezier(0.16, 1, 0.3, 1)',
  /** 退场缓动。 */
  easeIn: 'cubic-bezier(0.4, 0, 1, 1)',
  /** 统一缓动曲线（位移与通用过渡）。 */
  easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const

/**
 * 收敛后的视觉令牌（方案 A「静默化」的落地值，三方案共用 = 界面方案的地基）。
 *
 * 与改造前的差异，逐条对应 UI 方案文档「A · 静默化」的改动要点：
 * - 圆角从 4–8 种中间值收敛为**三档**：控件 8 / 卡片 12 / 弹层 16；
 * - 层级从"到处描边"改为**白底 + 极轻阴影**，边框只作分隔线且更淡；
 * - 字号从 8 档（11/12/13/14/16/18/20/24，其中 11–14 各差 1px）收敛为**五档**。
 */
export const TOKENS = {
  brand: '#5B54D9',
  brandDark: '#4A43C4',
  brandLight: '#6B64E3',
  ink: '#18181B',
  /** 次要文字：给正文用，对比度 ≥ 4.5:1。 */
  ink2: '#64646E',
  /** 三级文字：仅用于元信息/占位，不承载必要信息。 */
  ink3: '#9A9AA6',
  line: '#EFEFF3',
  line2: '#E7E7EC',
  surface: '#FFFFFF',
  canvas: '#F7F7F9',
  /** 控件圆角。 */
  radiusControl: 8,
  /** 卡片圆角。 */
  radiusCard: 12,
  /** 弹层圆角。 */
  radiusPopover: 16,
  /** 卡片静置阴影（双层：贴地 1px + 扩散 2px）。 */
  shadowCard: '0 1px 2px rgba(24,24,27,0.05)',
  /** 悬浮阴影。 */
  shadowHover: '0 6px 16px -6px rgba(24,24,27,0.16), 0 1px 2px rgba(24,24,27,0.05)',
} as const

/** 五档字号（只允许这五个值，别再随手写 12/13/18）。 */
export const TYPE_SCALE = {
  display: 24,
  title: 16,
  body: 14,
  meta: 13,
  caption: 11.5,
} as const

/**
 * MUI 主题 —— 对齐 UI 方案文档「A · 静默化」的令牌层。
 *
 * 三套界面方案（静默 / 分区 / 流畅）**共用这一份主题**：
 * 方案差异全部在 CSS 变量与布局能力位里，不在 MUI theme 里。
 * 这样切方案时不会出现"颜色也变了、位置也变了"的双重跳变（见 `lib/ui-scheme.ts` 文件头）。
 */
const theme = createTheme({
  palette: {
    primary: {
      main: TOKENS.brand,
      dark: TOKENS.brandDark,
      light: TOKENS.brandLight,
      contrastText: '#ffffff',
    },
    secondary: {
      main: TOKENS.brandDark,
      contrastText: '#ffffff',
    },
    error: { main: '#C4342F' },
    warning: { main: '#D97706' },
    success: { main: '#15803D' },
    info: { main: TOKENS.brand },
    background: {
      default: TOKENS.canvas,
      paper: TOKENS.surface,
    },
    text: {
      primary: TOKENS.ink,
      secondary: TOKENS.ink2,
      disabled: TOKENS.ink3,
    },
    divider: TOKENS.line2,
  },
  shape: {
    borderRadius: TOKENS.radiusControl,
  },
  typography: {
    fontFamily:
      '"Noto Sans SC","PingFang SC","HarmonyOS Sans SC","Microsoft YaHei",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    // 五档：24 / 16 / 14 / 13 / 11.5，行高统一 1.55（标题略紧）
    h4: { fontSize: TYPE_SCALE.display, fontWeight: 700, lineHeight: 1.35 },
    h5: { fontSize: 20, fontWeight: 700, lineHeight: 1.4 },
    h6: { fontSize: TYPE_SCALE.title, fontWeight: 600, lineHeight: 1.45 },
    subtitle1: { fontSize: TYPE_SCALE.title, fontWeight: 600 },
    subtitle2: { fontSize: TYPE_SCALE.meta, fontWeight: 600 },
    body1: { fontSize: TYPE_SCALE.body, lineHeight: 1.55 },
    body2: { fontSize: TYPE_SCALE.meta, lineHeight: 1.55 },
    caption: { fontSize: TYPE_SCALE.caption, lineHeight: 1.5 },
    button: { fontSize: TYPE_SCALE.meta, textTransform: 'none' },
  },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: {
        root: {
          textTransform: 'none',
          // 控件统一 8px 圆角
          borderRadius: TOKENS.radiusControl,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          borderRadius: TOKENS.radiusCard,
          borderColor: TOKENS.line,
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        // 卡片层级改双层：白底 + 极轻阴影，边框退成"淡分隔线"
        outlined: {
          borderColor: TOKENS.line,
        },
        rounded: {
          borderRadius: TOKENS.radiusCard,
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: {
          borderRadius: TOKENS.radiusPopover,
        },
      },
    },
    MuiPopover: {
      styleOverrides: {
        paper: {
          borderRadius: TOKENS.radiusPopover,
        },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          borderRadius: TOKENS.radiusPopover,
        },
      },
    },
    MuiTooltip: {
      styleOverrides: {
        tooltip: {
          borderRadius: TOKENS.radiusControl,
          fontSize: TYPE_SCALE.caption,
        },
      },
    },
    MuiListItemButton: {
      styleOverrides: {
        root: {
          // 导航降噪：hover 用 8% 主色底，不改变文字颜色
          '&:hover': { backgroundColor: 'rgba(91,84,217,0.08)' },
          '&.Mui-selected': { backgroundColor: 'rgba(91,84,217,0.12)' },
          '&.Mui-selected:hover': { backgroundColor: 'rgba(91,84,217,0.16)' },
        },
      },
    },
    MuiDivider: {
      styleOverrides: {
        root: { borderColor: TOKENS.line },
      },
    },
  },
})

export default theme
