/**
 * 移动端骨架 P0-4 下半 · 窄屏底部导航测试。
 *
 * 覆盖三层：
 * 1. **纯函数**（`lib/shell-layout.ts`）：显示判定、导航高度与安全区留白、FAB 偏移、活跃判定；
 * 2. **配置一致性**：底部导航 4 项的 path 必须真实存在于 `lib/nav.tsx`，且与「更多」抽屉
 *    合起来覆盖全部 12 个导航项（这就是验收句「12 个页面全部能通过底部导航 + 更多抽屉到达」
 *    在 Node 里唯一能被钉死的部分 —— 真机逐页点的那遍见交付说明）；
 * 3. **源码级约束**：`MobileBottomNav.tsx` 的触摸目标 / 无障碍属性 / 不桶导入，
 *    `Layout.tsx` 的接入点与窄屏只在 `temporary` 生效。
 *
 * 源码断言一律先去注释再匹配 —— 11-09 踩过「注释里写了 1201，正则以为代码对了」的假绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  BOTTOM_NAV_HEIGHT,
  BOTTOM_NAV_ITEMS,
  FAB_SAFE_GAP,
  bottomNavPadding,
  isBottomNavItemActive,
  isBottomNavVisible,
  isCompactTopBar,
  resolveBottomNavHeightPx,
  resolveFabBottomOffset,
  resolveDrawerMode,
} from '../web/src/lib/shell-layout'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

function readSource(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
}

/** 去掉 `//` 行注释与 `/* *\/` 块注释（保留字符串里的内容大致即可，断言只关心代码片段）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/* ------------------------------- 显示判定 ------------------------------- */

test('底部导航只在覆盖式抽屉（<768）出现，与侧栏形态严格互补', () => {
  assert.equal(isBottomNavVisible(resolveDrawerMode(375)), true)
  assert.equal(isBottomNavVisible(resolveDrawerMode(390)), true)
  assert.equal(isBottomNavVisible(resolveDrawerMode(767)), true)
  assert.equal(isBottomNavVisible(resolveDrawerMode(768)), false)
  assert.equal(isBottomNavVisible(resolveDrawerMode(1200)), false)
})

test('底部导航：非法/未知模式一律不显示（宁可不画，也不画空导航）', () => {
  for (const bad of ['', 'overlay', 'PERMANENT', 'temporary ', 'responsive'] as unknown[]) {
    assert.equal(isBottomNavVisible(bad as never), false, `${String(bad)} 不应显示底部导航`)
  }
})

test('顶栏收敛与底部导航同源（都由 temporary 触发），但是独立入口', () => {
  assert.equal(isCompactTopBar('temporary'), true)
  assert.equal(isCompactTopBar('permanent'), false)
  assert.equal(isCompactTopBar('unknown' as never), false)
  // 语义独立：不是同一个函数别名
  assert.notEqual(isCompactTopBar, isBottomNavVisible)
})

/* --------------------------- 高度 / 安全区留白 --------------------------- */

test('导航高度非法入参回落 56（不产生 NaNpx / 0px）', () => {
  assert.equal(resolveBottomNavHeightPx(), BOTTOM_NAV_HEIGHT)
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -8, undefined]) {
    assert.equal(resolveBottomNavHeightPx(bad as number | undefined), BOTTOM_NAV_HEIGHT, `${String(bad)} 应回落 56`)
  }
  assert.equal(resolveBottomNavHeightPx(72), 72, '显式高度应被采用（平板可加高）')
})

test('main 底部留白 = 56px + env(safe-area-inset-bottom)（必须带 0px 兜底）', () => {
  const css = bottomNavPadding()
  assert.match(css, /^calc\(/, '必须是 calc()，否则 env() 无法与 px 相加')
  assert.match(css, /56px/, '必须含导航高度')
  assert.match(css, /env\(safe-area-inset-bottom,\s*0px\)/, '必须带安全区与 0px 兜底')
  // 兜底值缺失时整条 calc() 在不支持 env 的环境里会失效
  assert.doesNotMatch(css, /env\(safe-area-inset-bottom\)/, 'env() 必须写兜底值')
  assert.equal(bottomNavPadding(64), `calc(64px + env(safe-area-inset-bottom, 0px))`)
})

test('FAB 偏移 = 导航高 + 8px + 安全区（保证不与导航重叠）', () => {
  const css = resolveFabBottomOffset()
  assert.match(css, /^calc\(/)
  assert.match(css, /56px/)
  assert.match(css, /8px/)
  assert.match(css, /env\(safe-area-inset-bottom,\s*0px\)/)

  // 数值断言：偏移必须严格大于导航高度，否则 FAB 会压在导航上
  const nums = [...css.matchAll(/([\d.]+)px/g)].map((m) => Number(m[1]))
  assert.ok(nums.length >= 2, `偏移里应至少有两个 px 分量：${css}`)
  assert.ok(nums[0] + nums[1] > BOTTOM_NAV_HEIGHT, 'FAB 底边必须高于导航顶边')
  assert.equal(nums[1], FAB_SAFE_GAP, '安全间距默认 8px')

  assert.equal(resolveFabBottomOffset(64, 12), `calc(64px + 12px + env(safe-area-inset-bottom, 0px))`)
})

test('FAB 偏移：非法入参回落默认值（不产出 NaNpx / 负间距）', () => {
  const fallback = `calc(${BOTTOM_NAV_HEIGHT}px + ${FAB_SAFE_GAP}px + env(safe-area-inset-bottom, 0px))`
  assert.equal(resolveFabBottomOffset(Number.NaN, Number.NaN), fallback)
  assert.equal(resolveFabBottomOffset(0, -4), fallback)
  assert.equal(resolveFabBottomOffset(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), fallback)
})

/* ------------------------------- 活跃判定 ------------------------------- */

test('活跃判定：首页只匹配根路径（否则任何页面都会点亮首页）', () => {
  assert.equal(isBottomNavItemActive('/', '/'), true)
  assert.equal(isBottomNavItemActive('/', '/todo'), false)
  assert.equal(isBottomNavItemActive('/', '/records'), false)
})

test('活跃判定：记录项覆盖全部筛选态（type / category 都算「记录」）', () => {
  for (const pathname of ['/records', '/records/']) {
    assert.equal(isBottomNavItemActive('/records', pathname), true, `${pathname} 应点亮记录`)
  }
  // query 不参与判定：同一 pathname 下的 type/category 筛选仍属同一页
  assert.equal(isBottomNavItemActive('/records', '/records'), true)
})

test('活跃判定：按路径段匹配，/todo 不得误匹配 /todolist', () => {
  assert.equal(isBottomNavItemActive('/todo', '/todo'), true)
  assert.equal(isBottomNavItemActive('/todo', '/todolist'), false)
  assert.equal(isBottomNavItemActive('/settings', '/settings'), true)
  assert.equal(isBottomNavItemActive('/settings', '/settings/ui-scheme'), true)
})

test('活跃判定：非法入参一律 false，不抛错', () => {
  const cases: Array<[unknown, unknown]> = [
    [undefined, '/'],
    ['/', undefined],
    ['', ''],
    [null, '/todo'],
    [0, 0],
  ]
  for (const [p, pn] of cases) {
    assert.equal(
      isBottomNavItemActive(p as string, pn as string),
      false,
      `${String(p)} / ${String(pn)} 应返回 false`,
    )
  }
})

/* --------------------- 配置一致性（12 个页面都能到达） --------------------- */

/** 从 `lib/nav.tsx` 源码里抽 path（不 import：该文件含 JSX，Node 侧打不动 MUI 图标）。 */
function navPathsFromSource(): string[] {
  const src = readSource('web/src/lib/nav.tsx')
  return [...src.matchAll(/path:\s*'([^']+)'/g)].map((m) => m[1])
}

/** 从 `App.tsx` 源码里抽路由（`path="..."`），用于校验底部导航指向真实页面。 */
function routePathsFromSource(): Set<string> {
  const src = readSource('web/src/App.tsx')
  return new Set([...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]))
}

test('底部导航恰好 4 项，key 与 path 都不重复', () => {
  assert.equal(BOTTOM_NAV_ITEMS.length, 4, '计划明确「首页 / 待办 / 记录 / 我的」四项')
  const keys = BOTTOM_NAV_ITEMS.map((i) => i.key)
  const paths = BOTTOM_NAV_ITEMS.map((i) => i.path)
  assert.equal(new Set(keys).size, keys.length, `key 重复：${keys.join(',')}`)
  assert.equal(new Set(paths).size, paths.length, `path 重复：${paths.join(',')}`)
  assert.deepEqual(paths, ['/', '/todo', '/records', '/settings'])
})

test('底部导航的每个 path 都是真实路由（不能指向不存在的页面）', () => {
  const routes = routePathsFromSource()
  // `/records` 是真实路由，但不在 NAV_GROUPS 里（抽屉用「想法 / 资料」两个带 type 的入口），
  // 所以这里校验路由表而不是导航表 —— 两者是不同的事实源。
  assert.ok(routes.has('/records'), 'App.tsx 应有 /records 路由')
  for (const item of BOTTOM_NAV_ITEMS) {
    assert.ok(routes.has(item.path), `底部导航「${item.label}」的 ${item.path} 不是真实路由`)
  }
})

test('「更多」抽屉仍是 NAV_GROUPS 全量 12 项，且覆盖底部导航 4 项之外的页面', () => {
  const navPaths = navPathsFromSource()
  assert.equal(navPaths.length, 12, `NAV_GROUPS 应仍是 12 项（加菜单只改这一处），实际 ${navPaths.length}`)

  // 抽屉里的 12 项一条都不能少：窄屏只能靠它到达「其余页面」
  const navSet = new Set(navPaths)
  for (const mustKeep of [
    '/',
    '/records?type=idea',
    '/records?type=material',
    '/todo',
    '/calendar',
    '/review',
    '/learning-goal',
    '/mindtree',
    '/tools',
    '/plugins',
    '/recycle',
    '/settings',
  ]) {
    assert.ok(navSet.has(mustKeep), `${mustKeep} 不能从「更多」抽屉里消失`)
  }
  // 底部导航 4 项里，除「记录」外的 3 项都必须同时存在于抽屉（同一 path 字面量）
  for (const item of BOTTOM_NAV_ITEMS) {
    if (item.path === '/records') continue
    assert.ok(navSet.has(item.path), `「${item.label}」(${item.path}) 应同时存在于 NAV_GROUPS`)
  }
})

/* --------------------------- 源码级约束（组件） --------------------------- */

test('MobileBottomNav：有无障碍名称、活跃标记与 44×44 触摸目标', () => {
  const src = stripComments(readSource('web/src/components/MobileBottomNav.tsx'))

  assert.match(src, /component="nav"/, '底部导航必须是 nav 地标')
  assert.match(src, /aria-label="底部导航"/, 'nav 必须有可访问名称')
  assert.match(src, /aria-current=\{active \? 'page' : undefined\}/, '当前项必须暴露 aria-current=page')
  assert.match(src, /aria-label=\{item\.label\}/, '每个导航项必须有可访问名称')
  assert.match(src, /minWidth: 44/, '触摸目标不得小于 44×44')
  assert.match(src, /minHeight: 44/)
  assert.match(src, /minWidth: 44[\s\S]{0,400}?aria-label="更多"|aria-label="更多"/, '必须有「更多」入口')
})

test('MobileBottomNav：FAB 一次点击新建，且用安全区偏移避开底部导航', () => {
  const src = stripComments(readSource('web/src/components/MobileBottomNav.tsx'))

  assert.match(src, /aria-label="新建记录"/, 'FAB 必须有可访问名称')
  assert.match(src, /onClick=\{onCreate\}/, 'FAB 必须触发新建（不是跳去记录页再点新建）')
  assert.match(src, /bottom:\s*resolveFabBottomOffset\(\)/, 'FAB 偏移必须走纯函数（含安全区与 8px 间距）')
  assert.match(src, /env\(safe-area-inset-bottom/, '底部导航自身也要处理安全区')
})

test('MobileBottomNav：导航项来自 BOTTOM_NAV_ITEMS，菜单只有一份事实源', () => {
  const src = stripComments(readSource('web/src/components/MobileBottomNav.tsx'))

  assert.match(src, /BOTTOM_NAV_ITEMS\.map/, '必须遍历配置，不得就地写死第二份路径表')
  assert.doesNotMatch(src, /\/calendar/, '组件内不应出现计划外的路由字面量（否则与 NAV_GROUPS 脱节）')
  assert.doesNotMatch(src, /from '@mui\/icons-material'/, '图标必须按需 import（桶导入会拖包体）')
})

/* --------------------------- 源码级约束（壳层） --------------------------- */

test('Layout：接入底部导航，且只在窄屏渲染', () => {
  const src = stripComments(readSource('web/src/components/Layout.tsx'))

  assert.match(src, /import MobileBottomNav from '\.\/MobileBottomNav'/, '必须接入底部导航组件')
  assert.match(src, /isBottomNavVisible\(drawerMode\)/, '显示判定必须由 drawerMode 派生')
  assert.match(src, /\{bottomNavVisible && \(\s*<MobileBottomNav/, '必须条件渲染（常驻侧栏时不画）')
  assert.match(src, /onOpenMore=\{\(\) => setMobileNavOpen\(true\)\}/, '「更多」必须复用既有全量抽屉')
  assert.match(src, /onCreate=\{openCreate\}/, 'FAB 必须复用既有新建弹窗')
})

test('Layout：main 在窄屏为底部导航留白（含安全区），常驻档不加', () => {
  const src = stripComments(readSource('web/src/components/Layout.tsx'))

  assert.match(
    src,
    /pb:\s*bottomNavVisible \? bottomNavPadding\(\) : 0/,
    'main 必须按窄屏补底部留白（否则最后一行被导航盖住）',
  )
  assert.match(src, /component="main"/, 'main 地标必须保留')
})

test('Layout：窄屏顶栏收敛 —— 隐藏次要图标，退出登录改走头像菜单', () => {
  const src = stripComments(readSource('web/src/components/Layout.tsx'))

  assert.match(src, /isCompactTopBar\(drawerMode\)/, '顶栏收敛必须由 drawerMode 派生')
  assert.match(src, /const avatarMenuEnabled = features\.slimTopBar \|\| compactTopBar/, '窄屏头像必须可点开菜单')
  // 快速记录 / 导出 / 退出登录 三个次要元素都必须带窄屏条件
  const compactGuards = [...src.matchAll(/!features\.slimTopBar && !compactTopBar/g)]
  assert.ok(compactGuards.length >= 3, `快速记录/导出/退出登录都应加窄屏条件，实际 ${compactGuards.length} 处`)
})

test('Layout：不得出现散落的界面方案硬判断（窄屏是响应式，不是方案能力）', () => {
  const src = stripComments(readSource('web/src/components/Layout.tsx'))
  assert.doesNotMatch(src, /if\s*\(\s*scheme\s*===/, '禁止 if (scheme === ...)')
  assert.doesNotMatch(src, /\b768\b/, '不得在组件里写死断点数字（从常量派生）')
})
