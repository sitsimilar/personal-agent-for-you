/**
 * 移动端骨架 P0-4 上半 · QA 独立对抗性验证（8 例）。
 *
 * 与 `qa/p0-f-shell-layout.test.ts`（工程师自测 16 例）**互补不重复**：
 * 那边测「函数算得对不对」，这边测「实现层不会悄悄漂掉」——
 * 即那些只能靠源码文本与边界值扫描才能钉住的脆弱点：
 *
 * 1. 纯函数性：`shell-layout.ts` 一旦读了 `window` / DOM，Node 单测就再也不是真跑；
 * 2. 单一事实源：断点数字不允许在 `Layout.tsx` 或 web 层其它地方二次出现；
 * 3. 小数入参：`matchMedia` 的阈值是浮点，767.5 这类值不能生成非法字符串；
 * 4. 阈值扫描：`resolveDrawerMode` 与 `resolveDrawerModeFromMatch` 两个入口不能漂移；
 * 5. 非法输入不得渗进 CSS 文本（`NaNpx` / `Infinitypx` 会被浏览器静默丢弃 = 永远命中）；
 * 6. 占比夹取：视口恰好等于阈值、侧栏比视口还宽时不得出现负数或 NaN；
 * 7. 导航入口统一：所有导航点击必须走 `go()`，否则窄屏点了不收抽屉；
 * 8. 残留状态清理：窄→宽切换时必须清 `mobileNavOpen`，否则回到窄屏莫名弹开。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DRAWER_WIDTH,
  PERMANENT_DRAWER_MIN_WIDTH,
  permanentDrawerMediaQuery,
  resolveContentRatio,
  resolveDrawerMode,
  resolveDrawerModeFromMatch,
} from '../web/src/lib/shell-layout'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

function readSource(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
}

/** 去掉块注释与行注释，避免把「文档里提到的 window」误判成真实调用。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/* 1 ------------------------------------------------------------------ */
test('对抗·纯函数性：shell-layout.ts 不读 window/DOM/localStorage/时间（Node 单测的前提）', () => {
  const code = stripComments(readSource('web/src/lib/shell-layout.ts'))

  for (const forbidden of [
    'window',
    'document',
    'localStorage',
    'sessionStorage',
    'navigator',
    'matchMedia',
    'new Date',
    'Date.now',
  ]) {
    assert.ok(
      !code.includes(forbidden),
      `shell-layout.ts 出现副作用依赖「${forbidden}」—— 会破坏 Node 下的可测性`,
    )
  }
  // 反向确认：剥注释没把整个文件剥空（否则上面的断言是假绿）
  assert.match(code, /export const PERMANENT_DRAWER_MIN_WIDTH/, '剥注释后仍应看到实现代码')
  assert.ok(code.length > 300, `剥注释后代码长度异常：${code.length}`)
})

/* 2 ------------------------------------------------------------------ */
test('对抗·单一事实源：断点数字不得在 Layout.tsx 或 web 层二次出现', () => {
  const layout = readSource('web/src/components/Layout.tsx')

  assert.doesNotMatch(layout, /\b768\b/, 'Layout.tsx 不得写死 768（应从常量派生）')
  assert.doesNotMatch(layout, /\b900\b/, 'Layout.tsx 不得写死 900（那是 MUI 的 md，与验收冲突）')
  assert.doesNotMatch(layout, /min-width:\s*\d+px/, 'Layout.tsx 不得自己拼媒体查询字面量')

  // 常量本身只允许在 shell-layout.ts 声明一次
  const lib = readSource('web/src/lib/shell-layout.ts')
  const declCount = (lib.match(/export const PERMANENT_DRAWER_MIN_WIDTH\s*=/g) ?? []).length
  assert.equal(declCount, 1, `PERMANENT_DRAWER_MIN_WIDTH 应只声明一次，实际 ${declCount} 次`)
  assert.equal(PERMANENT_DRAWER_MIN_WIDTH, 768, '常量取值必须是验收定案的 768，不是 900')
})

/* 3 ------------------------------------------------------------------ */
test('对抗·小数入参：767.5 / 768.5 等浮点阈值既不能丢精度也不能四舍五入', () => {
  assert.equal(permanentDrawerMediaQuery(767.5), '(min-width: 767.5px)')
  assert.equal(permanentDrawerMediaQuery(768.25), '(min-width: 768.25px)')

  // 阈值本身是浮点时，判定必须严格按 >= 比较，不能先取整
  assert.equal(resolveDrawerMode(767.999), 'temporary', '767.999 仍小于阈值，应收起')
  assert.equal(resolveDrawerMode(768), 'permanent', '恰好等于阈值应常驻')
  assert.equal(resolveDrawerMode(768.001), 'permanent')

  // 负零与极小负数不得被当成合法视口
  assert.equal(resolveDrawerMode(-0), 'temporary', '-0 应视为非法')
  assert.equal(resolveDrawerMode(1e-9), 'temporary', '极小视口应收起而不是常驻')
})

/* 4 ------------------------------------------------------------------ */
test('对抗·阈值扫描：两个模式入口在 767~769 全程一致（防两份实现漂移）', () => {
  for (let vw = 767; vw <= 769; vw += 0.25) {
    const byWidth = resolveDrawerMode(vw)
    const byMatch = resolveDrawerModeFromMatch(vw >= PERMANENT_DRAWER_MIN_WIDTH)
    assert.equal(byMatch, byWidth, `${vw}px 处两个入口判定不一致：${byWidth} vs ${byMatch}`)
  }
})

/* 5 ------------------------------------------------------------------ */
test('对抗·非法输入不得渗进 CSS 文本（NaNpx / Infinitypx 会让媒体查询永远不命中）', () => {
  const bad = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -1,
    0,
    -0,
  ]
  for (const input of bad) {
    const mq = permanentDrawerMediaQuery(input)
    assert.doesNotMatch(mq, /NaN|Infinity|null|undefined/, `${String(input)} 生成了非法媒体查询：${mq}`)
    assert.match(mq, /^\(min-width: 768px\)$/, `${String(input)} 应回落 768：${mq}`)
  }
})

/* 6 ------------------------------------------------------------------ */
test('对抗·占比夹取：视口恰好等于阈值 / 侧栏宽于视口 / 侧栏宽非法', () => {
  // 恰好阈值 → 常驻，占比 (768-240)/768
  assert.ok(Math.abs(resolveContentRatio(PERMANENT_DRAWER_MIN_WIDTH) - 528 / 768) < 1e-9)
  // 阈值下一档 → 覆盖式，占比 1
  assert.equal(resolveContentRatio(PERMANENT_DRAWER_MIN_WIDTH - 0.001), 1)
  // 侧栏宽于视口 → 夹到 0，不得为负
  assert.equal(resolveContentRatio(PERMANENT_DRAWER_MIN_WIDTH, PERMANENT_DRAWER_MIN_WIDTH * 3), 0)
  // 侧栏宽度非法 → 回落 DRAWER_WIDTH，且结果有限
  for (const badDrawer of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0]) {
    const ratio = resolveContentRatio(1024, badDrawer)
    assert.ok(Number.isFinite(ratio), `drawerWidth=${String(badDrawer)} 产生了非有限值`)
    assert.ok(Math.abs(ratio - (1024 - DRAWER_WIDTH) / 1024) < 1e-9)
  }
  // 全量抽查：任何输入都必须落在 [0,1]
  for (const vw of [320, 375, 390, 767, 768, 1024, 1920]) {
    const r = resolveContentRatio(vw)
    assert.ok(r >= 0 && r <= 1, `${vw}px 占比越界：${r}`)
  }
})

/* 7 ------------------------------------------------------------------ */
test('对抗·导航入口统一：所有导航点击都走 go()，不留直接 navigate 的漏网项', () => {
  const layout = readSource('web/src/components/Layout.tsx')

  // 导航项 / 分类标签都必须走 go()
  assert.match(layout, /onClick=\{\(\) => go\(item\.path\)\}/, '主导航项必须走 go()')
  assert.match(layout, /onClick=\{\(\) => go\(`\/records\?category=/, '分类标签必须走 go()')
  // 不允许「点击时直接 navigate」的写法（那会绕过 setMobileNavOpen(false)）
  assert.doesNotMatch(layout, /onClick=\{\(\) => navigate\(/, '存在绕过 go() 的点击跳转，窄屏点了不会收抽屉')
  // 搜索范围下拉也必须走 go()（handleScopeChange 已改为 go）
  assert.match(layout, /const handleScopeChange[\s\S]{0,200}?go\('\/'\)/, '范围下拉必须走 go()')
})

/* 8 ------------------------------------------------------------------ */
/**
 * 回归钉子（第 2 轮补）：顶栏层级的**条件式**形态。
 *
 * 背景：MUI v5.18 把 temporary 抽屉的 Modal 根写死成 `zIndex.drawer`(1200)，
 * 顶栏若无条件 `drawer + 1`(1201) 就会连按钮一起浮到遮罩与纸面之上 ——
 * 抽屉展开时点顶栏等于点顶栏而不是点遮罩（可达回归，第 1 轮实测能弹出对话框）。
 * 这里钉住「条件式」，并禁止退回恒值写法。
 */
test('对抗·顶栏层级必须是条件式，禁止无条件 drawer+1（否则窄屏又浮到遮罩之上）', () => {
  const layout = stripComments(readSource('web/src/components/Layout.tsx'))

  assert.match(
    layout,
    /isPermanentDrawer\s*\?\s*theme\.zIndex\.drawer\s*\+\s*1\s*:\s*theme\.zIndex\.appBar/,
    'AppBar 的 zIndex 必须是 `isPermanentDrawer ? theme.zIndex.drawer + 1 : theme.zIndex.appBar`',
  )
  // 退回函数写法（恒值 1201）会让窄屏重新浮到遮罩之上
  assert.doesNotMatch(
    layout,
    /\(theme\)\s*=>\s*theme\.zIndex\.drawer\s*\+\s*1/,
    '不得恢复成 (theme) => theme.zIndex.drawer + 1 的恒值写法',
  )
  // 退回「不带条件」的 zIndex: drawer+1 同理
  assert.doesNotMatch(
    layout,
    /zIndex:\s*theme\.zIndex\.drawer\s*\+\s*1\s*,/,
    '不得出现无条件的 `zIndex: theme.zIndex.drawer + 1`',
  )
  // 每处 drawer+1 都必须带条件：只允许出现一次
  const hits = [...layout.matchAll(/theme\.zIndex\.drawer\s*\+\s*1/g)]
  assert.equal(hits.length, 1, `drawer+1 应只出现一次（且带 isPermanentDrawer 条件），实际 ${hits.length} 次`)
})

/* 9 ------------------------------------------------------------------ */
test('对抗·层级不变量：常驻档严格高于纸面、窄屏档不得高于 appBar（不把 1100/1200 变成第二事实源）', () => {
  const layout = stripComments(readSource('web/src/components/Layout.tsx'))

  // 常驻档 = drawer + 1 → 数学上严格高于纸面（theme.zIndex.drawer），顶栏压住纸面、导航项靠 pt 让位
  assert.match(layout, /theme\.zIndex\.drawer\s*\+\s*1/, '常驻档必须严格高于纸面：drawer + 1')
  // 窄屏档 = appBar → 低于抽屉 Modal 根（MUI 写死为 zIndex.drawer），遮罩才能盖住顶栏
  assert.match(layout, /:\s*theme\.zIndex\.appBar\b/, '窄屏档必须回落到 theme.zIndex.appBar')
  // 窄屏档不得在 appBar 之上再加偏移，否则重新越过抽屉层级
  assert.doesNotMatch(layout, /theme\.zIndex\.appBar\s*\+/, '窄屏档不得在 appBar 之上升级（+1/+2 都会重新浮到遮罩之上）')
})

/* 10 ----------------------------------------------------------------- */
test('对抗·抽屉 sx 未被顺手改动：仅常驻档占布局宽度，纸面宽度与 pt 仍由常量派生', () => {
  const layout = readSource('web/src/components/Layout.tsx')

  assert.match(
    layout,
    /\.\.\.\(isPermanentDrawer \? \{ width: DRAWER_WIDTH, flexShrink: 0 \} : \{\}\)/,
    '只有常驻档才占布局宽度（窄屏必须让主内容拿到整屏）',
  )
  assert.match(layout, /'& \.MuiDrawer-paper':\s*\{[^}]*width: DRAWER_WIDTH/, '纸面宽度仍取 DRAWER_WIDTH 常量')
  assert.match(layout, /pt: `\$\{topOffset\}px`/, '纸面顶部让位仍取 topOffset（顶栏高度）')
  assert.match(layout, /component="main"/, 'main 地标必须保留（量测脚本与 a11y 都依赖）')
})

/* 11 ----------------------------------------------------------------- */
test('对抗·残留状态清理：窄→宽切换必须清 mobileNavOpen，且 go() 里先收起再跳转', () => {
  const layout = readSource('web/src/components/Layout.tsx')

  // effect 清理：避免常驻模式下留一层遮罩/焦点陷阱
  assert.match(
    layout,
    /useEffect\(\(\) => \{\s*if \(isPermanentDrawer\) setMobileNavOpen\(false\)\s*\}, \[isPermanentDrawer\]\)/,
    '缺少「窄→宽清 mobileNavOpen」的 effect',
  )
  // go() 里 setMobileNavOpen(false) 必须在导航之前（同路径时也要收起）
  assert.match(
    layout,
    /const go = \(path: string\) => \{[\s\S]{0,200}?setMobileNavOpen\(false\)[\s\S]{0,120}?if \(location\.pathname/,
    'go() 必须在跳转判断之前先收起抽屉（同路径点击也要收）',
  )
})
