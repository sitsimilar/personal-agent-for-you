/**
 * 移动端骨架 P0-4 上半 · 侧栏断点切换测试。
 *
 * 覆盖：
 * - 纯函数边界（767 / 768 / 1024）与非法输入（NaN / Infinity / 0 / -1）；
 * - 媒体查询字符串与 `PERMANENT_DRAWER_MIN_WIDTH` 的**单一事实源**一致性
 *   （否则「判定说 768 常驻、媒体查询却写 900」，只有真机才能发现）；
 * - 主内容宽度占比是否达到 `docs/MOBILE-BASELINE.md` §八 的 ≥96% 门槛；
 * - `Layout.tsx` 源码级约束（没有死写的 `variant="permanent"`、汉堡按钮、遮罩可关、导航后收起）。
 *
 * 这层不渲染 React：QA 跑在 Node 里，只有纯函数与源码文本可断言。
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

/** 读取仓库内源码原文（源码级约束用）。 */
function readSource(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
}

/* ------------------------------ 边界与非法输入 ------------------------------ */

test('侧栏形态：767 收起 / 768 常驻 / 1024 常驻（断点取验收的 768，不是 md 的 900）', () => {
  assert.equal(resolveDrawerMode(767), 'temporary')
  assert.equal(resolveDrawerMode(768), 'permanent')
  assert.equal(resolveDrawerMode(1024), 'permanent')
  // 768~899 这一段是「计划正文说 md(900)、验收说 768」的冲突区，必须常驻
  assert.equal(resolveDrawerMode(899), 'permanent')
  assert.equal(resolveDrawerMode(900), 'permanent')
})

test('侧栏形态：窄屏档位（320 / 375 / 390 / 767）一律收起', () => {
  for (const vw of [320, 375, 390, 414, 600, 767]) {
    assert.equal(resolveDrawerMode(vw), 'temporary', `${vw}px 应收起侧栏`)
  }
})

test('侧栏形态：非法输入回落 temporary（宁可收起，不要撑坏布局）', () => {
  for (const vw of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -1, -768]) {
    assert.equal(resolveDrawerMode(vw), 'temporary', `${String(vw)} 应回落 temporary`)
  }
})

/* ------------------------- 单一事实源（常量 ↔ 媒体查询） ------------------------- */

test('媒体查询字符串由常量派生：min-width 数字必须等于 PERMANENT_DRAWER_MIN_WIDTH', () => {
  const mq = permanentDrawerMediaQuery()
  assert.match(mq, /^\(min-width:\s*[\d.]+px\)$/)

  const matched = mq.match(/min-width:\s*([\d.]+)px/)
  assert.ok(matched, `媒体查询里必须能解析出宽度：${mq}`)
  const n = Number(matched[1])

  assert.equal(n, PERMANENT_DRAWER_MIN_WIDTH, '媒体查询与判定常量必须同一个数字')
  assert.equal(resolveDrawerMode(n), 'permanent', '恰好等于阈值应是常驻')
  assert.equal(resolveDrawerMode(n - 0.5), 'temporary', '阈值下 0.5px 应已收起')
})

test('媒体查询：显式入参可覆盖阈值，非法入参回落常量（不生成 NaNpx）', () => {
  assert.equal(permanentDrawerMediaQuery(1024), '(min-width: 1024px)')
  assert.equal(permanentDrawerMediaQuery(0), `(min-width: ${PERMANENT_DRAWER_MIN_WIDTH}px)`)
  assert.equal(permanentDrawerMediaQuery(Number.NaN), `(min-width: ${PERMANENT_DRAWER_MIN_WIDTH}px)`)
  assert.equal(
    permanentDrawerMediaQuery(Number.POSITIVE_INFINITY),
    `(min-width: ${PERMANENT_DRAWER_MIN_WIDTH}px)`,
  )
})

test('媒体查询布尔值 → 模式：与 resolveDrawerMode(768/767) 完全一致', () => {
  assert.equal(resolveDrawerModeFromMatch(true), resolveDrawerMode(768))
  assert.equal(resolveDrawerModeFromMatch(false), resolveDrawerMode(767))
  assert.equal(resolveDrawerModeFromMatch(true), 'permanent')
  assert.equal(resolveDrawerModeFromMatch(false), 'temporary')
})

/* ------------------------------ 主内容宽度占比 ------------------------------ */

test('宽度占比：375 / 390 档恒为 1（覆盖式抽屉），对齐 §八 ≥96% 门槛', () => {
  assert.equal(resolveContentRatio(375), 1)
  assert.equal(resolveContentRatio(390), 1)
  assert.ok(resolveContentRatio(375) >= 0.96, '375 档必须 ≥96%')
  assert.ok(resolveContentRatio(390) >= 0.96, '390 档必须 ≥96%')
})

test('宽度占比：768 档 = 528/768 ≈ 0.6875（常驻侧栏仍占位）', () => {
  const ratio = resolveContentRatio(768)
  assert.ok(Math.abs(ratio - 528 / 768) < 1e-6, `期望 528/768，实际 ${ratio}`)
  assert.ok(Math.abs(ratio - 0.6875) < 1e-6)
  assert.ok(ratio < 0.96, '768 档不在 §八 的 ≥96% 要求范围内（该门槛只针对 375 / 390）')
})

test('宽度占比：1200 档 = 0.8，且随视口变宽单调回升', () => {
  assert.ok(Math.abs(resolveContentRatio(1200) - 0.8) < 1e-6)
  const wide = resolveContentRatio(1920)
  assert.ok(wide > resolveContentRatio(1200))
  assert.ok(wide < 1)
})

test('宽度占比：非法输入回落 1（视口宽度非法 / 侧栏宽度非法）', () => {
  for (const vw of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
    assert.equal(resolveContentRatio(vw), 1, `${String(vw)} 应回落 1`)
  }
  // 视口合法但侧栏宽度非法：仍按默认 240 计算，不产生 NaN / 负值
  const withBadDrawer = resolveContentRatio(1024, Number.NaN)
  assert.ok(Number.isFinite(withBadDrawer))
  assert.ok(Math.abs(withBadDrawer - (1024 - DRAWER_WIDTH) / 1024) < 1e-6)
  const withZeroDrawer = resolveContentRatio(1024, 0)
  assert.ok(Math.abs(withZeroDrawer - (1024 - DRAWER_WIDTH) / 1024) < 1e-6)
})

test('宽度占比：夹在 [0, 1]，侧栏比视口还宽时不为负', () => {
  assert.equal(resolveContentRatio(768, 2400), 0)
  assert.equal(resolveContentRatio(768, 768), 0)
  assert.ok(resolveContentRatio(1000, 1) <= 1)
})

/* --------------------------- Layout.tsx 源码级约束 --------------------------- */

test('Layout：Drawer 形态由变量决定，不留死写的 permanent', () => {
  const src = readSource('web/src/components/Layout.tsx')

  assert.doesNotMatch(src, /variant="permanent"/, '不得保留死写的 variant="permanent"')
  assert.match(src, /variant=\{drawerMode\}/, 'variant 必须由 drawerMode 驱动')
  assert.match(src, /permanentDrawerMediaQuery\(\)/, '必须用纯函数生成的媒体查询（不自己拼字面量）')
  assert.match(src, /resolveDrawerModeFromMatch\(/, '模式判定必须走唯一入口')
  assert.match(src, /useMediaQuery/, '必须真的用 useMediaQuery 取断点')
})

test('Layout：DRAWER_WIDTH 已迁出（从 @/lib/shell-layout 导入，不再就地声明）', () => {
  const src = readSource('web/src/components/Layout.tsx')

  assert.doesNotMatch(src, /const DRAWER_WIDTH = 240/, 'DRAWER_WIDTH 必须迁到 lib/shell-layout.ts')
  assert.match(src, /from '@\/lib\/shell-layout'/, '必须从壳层纯函数模块导入常量与判定')
  assert.match(src, /DRAWER_WIDTH/, '布局仍需要侧栏宽度（纸面宽度与常驻占位）')
})

test('Layout：窄屏汉堡按钮可被辅助技术识别（aria-label + aria-expanded + 44×44）', () => {
  const src = readSource('web/src/components/Layout.tsx')

  assert.match(src, /aria-label="展开导航"/, '汉堡按钮必须有可访问名称')
  assert.match(src, /aria-expanded=\{mobileNavOpen\}/, '必须暴露展开状态')
  assert.match(src, /minWidth: 44/, '触摸目标不得小于 44×44')
  assert.match(src, /minHeight: 44/)
  assert.match(src, /!isPermanentDrawer && \(/, '汉堡按钮只在窄屏渲染')
  assert.match(src, /from '@mui\/icons-material\/Menu'/, '图标按需引入（不要桶导入）')
})

test('Layout：覆盖式抽屉可关（onClose + 遮罩）且导航后自动收起', () => {
  const src = readSource('web/src/components/Layout.tsx')

  assert.match(src, /onClose=\{/, 'temporary 抽屉必须能通过遮罩/Esc 关闭')
  assert.match(src, /setMobileNavOpen\(false\)/, '必须有收起抽屉的路径')
  assert.match(src, /keepMounted: true/, 'temporary 关闭动画后保留焦点管理')
  assert.match(src, /open=\{isPermanentDrawer \? true : mobileNavOpen\}/, 'permanent 忽略 open，temporary 受状态控制')
})

test('Layout：只有常驻模式占布局宽度，主内容加 minWidth: 0（防 flex 子项撑破）', () => {
  const src = readSource('web/src/components/Layout.tsx')

  assert.match(
    src,
    /\.\.\.\(isPermanentDrawer \? \{ width: DRAWER_WIDTH, flexShrink: 0 \} : \{\}\)/,
    '覆盖式抽屉不得占布局宽度（否则 375 档主内容又被挤掉 240px）',
  )
  assert.match(src, /minWidth: 0/, 'main 需 minWidth: 0，让内容在窄屏正常收缩换行')
})
