/**
 * 壳层（Layout）布局纯函数与常量 —— 移动端骨架 P0-4 的唯一事实源。
 *
 * ## 为什么单独抽一层
 *
 * `Layout.tsx` 里的侧栏是「常驻 240px」还是「覆盖式抽屉」，取决于视口宽度。
 * 这个判定如果写在组件里，就只能靠人眼看浏览器；而本仓库的 QA 跑在 Node 里
 * （`qa/run-tests.mjs` 用 esbuild 打成 cjs 后用 `node --test`），组件跑不起来。
 * 所以把**判定规则**抽成不读 `window` / 不碰 DOM / 不读 `localStorage` 的纯函数，
 * 让边界值（767 / 768）和宽度占比能被单测钉死，`Layout.tsx` 只负责把
 * `useMediaQuery` 的布尔值转成模式后渲染。
 *
 * ## 为什么断点是 768，而不是 MUI 的 `md`（900）
 *
 * 计划正文写「`md` 以上常驻」，但同一条计划的验收标准写「768px 下仍是常驻侧栏」——
 * MUI 默认 `md = 900`，900 > 768，两者数学上互斥。以**验收标准**为准：
 * 取 **768px**（平板竖屏起点），这样 768×1024 的 iPad 竖屏仍是熟悉的常驻侧栏，
 * 375 / 390 的手机则自动变成覆盖式抽屉。
 *
 * 为了不让「一个常量、一处媒体查询、一份测试」三处各写一个数字，
 * 这里把 768 写死成 `PERMANENT_DRAWER_MIN_WIDTH` 作为唯一事实源：
 * 媒体查询字符串由它派生，判定函数也由它派生。
 */

/**
 * 侧栏常驻的最小视口宽度（px）。
 *
 * 见文件头：以 11-09 验收要求（768 档常驻）为准，**不是** MUI 的 `md`（900）。
 * 改这个值会同时影响媒体查询与 `resolveDrawerMode`，属于骨架级改动，需同步验收。
 */
export const PERMANENT_DRAWER_MIN_WIDTH = 768

/**
 * 侧栏纸面宽度（px）。
 *
 * 从 `Layout.tsx` 迁到这里：永久模式占布局宽度、覆盖模式作为遮罩下方的纸面宽度，
 * 两种模式共用同一个值，避免「算出 240、画出 232」的错位。
 */
export const DRAWER_WIDTH = 240

/** 侧栏的两种形态。`permanent` 常驻占位，`temporary` 覆盖在内容之上。 */
export type DrawerMode = 'permanent' | 'temporary'

/**
 * 生成「侧栏常驻」的媒体查询字符串。
 *
 * @param minWidth 常驻阈值（px），默认取唯一事实源 `PERMANENT_DRAWER_MIN_WIDTH`。
 * @returns 形如 `(min-width: 768px)` 的媒体查询；非法入参回落默认阈值（宁可常驻也不要生成 `(min-width: NaNpx)`）。
 */
export function permanentDrawerMediaQuery(
  minWidth: number = PERMANENT_DRAWER_MIN_WIDTH,
): string {
  const width = Number.isFinite(minWidth) && minWidth > 0 ? minWidth : PERMANENT_DRAWER_MIN_WIDTH
  return `(min-width: ${width}px)`
}

/**
 * 按视口宽度判定侧栏形态。
 *
 * 非法输入（`NaN` / `Infinity` / `<= 0`）一律回落 `temporary`：
 * 宁可收起侧栏（内容 100% 可见，用户还能点汉堡），也不要撑坏布局。
 *
 * @param viewportWidth 视口宽度（CSS px）。
 * @returns `permanent`（>= 768）或 `temporary`（其余情况）。
 */
export function resolveDrawerMode(viewportWidth: number): DrawerMode {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 'temporary'
  return viewportWidth >= PERMANENT_DRAWER_MIN_WIDTH ? 'permanent' : 'temporary'
}

/**
 * 把 `useMediaQuery(permanentDrawerMediaQuery())` 的布尔结果转成侧栏形态。
 *
 * `Layout.tsx` 必须走这个入口而不是自己 `matched ? 'permanent' : 'temporary'`：
 * 保持「模式判定」只有一处实现，将来加第三种形态时不会漏改。
 *
 * @param matched 媒体查询是否命中（视口 >= 768）。
 */
export function resolveDrawerModeFromMatch(matched: boolean): DrawerMode {
  return matched ? 'permanent' : 'temporary'
}

/* ============================================================================
 * 窄屏底部导航（P0-4 下半）
 * ============================================================================
 *
 * 上半把侧栏改成了「窄屏覆盖式抽屉」，问题随之而来：抽屉收起后**所有导航都不可见**，
 * 用户必须点顶栏汉堡才能换页 —— 手机上这是一次多余的点击。下半用底部导航补上
 * 「四个主入口常驻 + 其余进更多抽屉」。
 *
 * 这一层同样只放纯函数/常量：底部导航的高度、安全区留白、FAB 偏移、当前项判定
 * 全部可单测；`MobileBottomNav.tsx` 只负责把结果画出来。
 * 安全区（`env(safe-area-inset-bottom)`）必须进字符串里 —— iPhone 的 Home 指示条
 * 会盖住最底部 34px，导航不加内边距就会点不到。
 */

/** 底部导航条高度（px，不含安全区）。44 是触摸目标下限，56 留出图标 + 文字的呼吸。 */
export const BOTTOM_NAV_HEIGHT = 56

/** FAB 与底部导航之间的安全间距（px）。计划增补要求「FAB 不与底部导航重叠（安全区 +8px）」。 */
export const FAB_SAFE_GAP = 8

/** 底部导航的四个常驻项（其余 8 项走「更多」抽屉）。 */
export type BottomNavKey = 'home' | 'todo' | 'records' | 'mine'

export interface BottomNavItem {
  key: BottomNavKey
  /** 展示名（同时作为 `aria-label`）。 */
  label: string
  /** 跳转路径，必须存在于 `lib/nav.tsx` 的 `NAV_GROUPS` 里。 */
  path: string
}

/**
 * 四个常驻项。**不在这里放图标**：JSX 图标进纯函数模块会让 QA（Node 环境）无法 import，
 * 图标按 `key` 在组件里映射。
 *
 * 为什么是这四项：首页 / 待办 / 记录 是三个高频落点，「我的」按计划原文指向设置页
 * （账号、界面方案、订阅配置都在那），其余 8 项（日历、回顾、学习目标、思维树、
 * 工具箱、插件、回收站 + 三个分类筛选项）全部在「更多」抽屉里 —— 即既有全量抽屉。
 */
export const BOTTOM_NAV_ITEMS: readonly BottomNavItem[] = [
  { key: 'home', label: '首页', path: '/' },
  { key: 'todo', label: '待办', path: '/todo' },
  { key: 'records', label: '记录', path: '/records' },
  { key: 'mine', label: '我的', path: '/settings' },
] as const

/**
 * 底部导航是否显示 —— 与侧栏形态严格互补：覆盖式抽屉（< 768）才有底部导航。
 *
 * 常驻侧栏（>= 768）时侧栏本身就常显，再叠一条底部导航等于把同一份菜单画两遍。
 * 非法输入回落 `false`：宁可不画，也不要画一条点不动的空导航。
 */
export function isBottomNavVisible(mode: DrawerMode): boolean {
  return mode === 'temporary'
}

/**
 * 顶栏是否进入「窄屏收敛」形态（隐藏导出 / 退出登录等次要图标）。
 *
 * 与 `isBottomNavVisible` 同源判断，但语义不同、将来可能分叉（例如竖屏平板
 * 只要底部导航、不要精简顶栏），所以单独开一个入口而不是复用同一个布尔。
 */
export function isCompactTopBar(mode: DrawerMode): boolean {
  return mode === 'temporary'
}

/** 归一化导航高度入参（非法值回落 `BOTTOM_NAV_HEIGHT`，绝不返回 NaN）。 */
export function resolveBottomNavHeightPx(height?: number): number {
  return typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : BOTTOM_NAV_HEIGHT
}

/**
 * 主内容区需要预留的底部留白（CSS 值）。
 *
 * `calc(56px + env(safe-area-inset-bottom, 0px))`：第二个参数是兜底值，
 * 桌面浏览器与不支持该变量的环境会解析成 `0px`，不会让整条 `calc()` 失效。
 */
export function bottomNavPadding(height?: number): string {
  return `calc(${resolveBottomNavHeightPx(height)}px + env(safe-area-inset-bottom, 0px))`
}

/**
 * FAB 距视口底部的偏移（CSS 值）。
 *
 * = 导航高度 + 安全间距（默认 8px）+ 安全区。三者都算进去才不会出现
 * 「FAB 压在导航上」或「FAB 被 Home 指示条盖住」。
 */
export function resolveFabBottomOffset(navHeight?: number, gap?: number): string {
  const nav = resolveBottomNavHeightPx(navHeight)
  const safeGap = typeof gap === 'number' && Number.isFinite(gap) && gap >= 0 ? gap : FAB_SAFE_GAP
  return `calc(${nav}px + ${safeGap}px + env(safe-area-inset-bottom, 0px))`
}

/**
 * 底部导航项在当前路由下是否活跃。
 *
 * 只比 `pathname`、忽略 query —— 因为「记录」这一项要同时覆盖
 * `/records`、`/records?type=idea`、`/records?type=material`、`/records?category=xxx`：
 * 这些是同一个页面的筛选态，选中的还应该是「记录」。
 *
 * - `'/'` 只在根路径活跃（否则任何页面都会点亮首页）；
 * - 其余按「相等或子路径」匹配，且用 `/` 补位，避免 `/todo` 误匹配 `/todolist`。
 *
 * @param path 导航项配置的路径
 * @param pathname `useLocation().pathname`
 */
export function isBottomNavItemActive(path: string, pathname: string): boolean {
  if (typeof path !== 'string' || typeof pathname !== 'string') return false
  if (!path || !pathname) return false
  if (path === '/') return pathname === '/'
  return pathname === path || pathname.startsWith(`${path}/`)
}

/**
 * 估算主内容可用宽度占视口的比例（供验收阈值对照，不参与渲染）。
 *
 * - `temporary`（覆盖式）：侧栏浮在内容之上，占比恒为 `1`；
 * - `permanent`（常驻）：`(视口 - 侧栏) / 视口`，夹在 `[0, 1]`。
 *
 * 非法输入回落 `1`：断言「主内容没被侧栏吃掉」比断言一个假的精确值更有意义。
 *
 * @param viewportWidth 视口宽度（CSS px）。
 * @param drawerWidth 侧栏宽度（CSS px），默认 `DRAWER_WIDTH`。
 * @returns 0~1 的比例，保留原始浮点精度（不做四舍五入，由调用方决定展示精度）。
 */
export function resolveContentRatio(
  viewportWidth: number,
  drawerWidth: number = DRAWER_WIDTH,
): number {
  const mode = resolveDrawerMode(viewportWidth)
  if (mode === 'temporary') return 1
  const width = Number.isFinite(drawerWidth) && drawerWidth > 0 ? drawerWidth : DRAWER_WIDTH
  const ratio = (viewportWidth - width) / viewportWidth
  if (!Number.isFinite(ratio)) return 1
  return Math.min(1, Math.max(0, ratio))
}
