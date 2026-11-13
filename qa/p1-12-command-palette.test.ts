/**
 * 命令面板 P1-12 上半 · 测试。
 *
 * 覆盖三层（与 `p0-f-bottom-nav.test.ts` 同一套路）：
 * 1. **纯逻辑**（`lib/palette.ts`）：跳转命令派生 / 过滤 / 分组 / 键盘契约；
 * 2. **配置一致性**：面板里的「跳转」类命令必须与 `NAV_GROUPS` 一一对应，
 *    且这些 path 都是 `App.tsx` 里真实存在的路由；
 * 3. **源码级约束**：面板不得自己写第二份路径表、不得自己拼标签；
 *    `Ctrl+K` 必须同步开面板（`Layout` 的唯一 keydown 入口里直接 `togglePalette()`），
 *    且面板只在能力位存在时挂载。
 *
 * 源码断言一律先去注释再匹配 —— 11-09 踩过「注释里写了 1201，正则以为代码对了」的假绿。
 *
 * 验收句「任意页面 Ctrl+K **2 帧内**出面板」在 Node 里只能钉住可钉的部分：
 * 打开路径全程同步（store 同 tick 生效 + 面板内无异步加载 + 无 debounce），
 * 真机/浏览器的逐帧计时见交付说明。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  PALETTE_GROUP_ORDER,
  PALETTE_INITIAL_ACTIVE,
  buildNavCommands,
  filterCommands,
  groupCommands,
  moveActive,
  navCommandLabel,
  resolvePaletteKey,
  splitPaletteTerms,
  type PaletteCommand,
  type PaletteNavItem,
} from '../web/src/lib/palette'
import { useUiShellStore } from '../web/src/store/uiShellStore'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

function readSource(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
}

/** 去掉 `//` 行注释与 `/* *\/` 块注释（断言只关心代码片段）。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** 从 `lib/nav.tsx` 源码里抽 {label, path}（该文件含 JSX，Node 侧不宜直接 import 图标）。 */
function navEntriesFromSource(): Array<{ label: string; path: string }> {
  const src = readSource('web/src/lib/nav.tsx')
  return [...src.matchAll(/label:\s*'([^']+)',\s*path:\s*'([^']+)'/g)].map((m) => ({
    label: m[1],
    path: m[2],
  }))
}

/** `App.tsx` 的路由表（校验跳转目标真实存在）。 */
function routePathsFromSource(): Set<string> {
  const src = readSource('web/src/App.tsx')
  return new Set([...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]))
}

const FAKE_NAV: PaletteNavItem[] = [
  { label: '全部信息', path: '/', hint: '想法、资料、待办' },
  { label: '待办', path: '/todo', hint: '今天 / 即将 / 某天' },
  { label: '设置', path: '/settings' },
]

/* --------------------------- 跳转命令派生 --------------------------- */

test('跳转命令：文案是「跳转到「X」」，不是裸页面名', () => {
  const cmds = buildNavCommands(FAKE_NAV)
  assert.equal(cmds.length, 3)
  assert.deepEqual(
    cmds.map((c) => c.label),
    ['跳转到「全部信息」', '跳转到「待办」', '跳转到「设置」'],
  )
  // 裸 label 会让「动作」与「位置」长得一样，按 Enter 前无法判断后果
  for (const cmd of cmds) assert.match(cmd.label, /^跳转到「.+」$/)
})

test('跳转命令：id 用 path 而非 label（改字不丢历史），path / hint / 原条目都带出', () => {
  const cmds = buildNavCommands(FAKE_NAV)
  assert.deepEqual(
    cmds.map((c) => c.id),
    ['nav:/', 'nav:/todo', 'nav:/settings'],
  )
  assert.equal(cmds[1].path, '/todo')
  assert.equal(cmds[1].hint, '今天 / 即将 / 某天')
  assert.equal(cmds[1].source, FAKE_NAV[1], '必须保留原条目，组件靠它取图标')
  // keywords 含裸 label：用户不会输入「跳转到「待办」」这么长
  assert.equal(cmds[1].keywords, '待办 db', 'keywords 必须同时带裸名与拼音首字母')
})

test('跳转命令：统一归到「跳转」组，且不改动入参', () => {
  const input = FAKE_NAV.map((i) => ({ ...i }))
  const snapshot = JSON.stringify(input)
  const cmds = buildNavCommands(input)
  for (const cmd of cmds) assert.equal(cmd.group, '跳转')
  assert.equal(JSON.stringify(input), snapshot, 'buildNavCommands 不得就地修改入参')
})

test('跳转命令：同 path 去重、空 path 跳过（不产出点了没反应的空命令）', () => {
  const cmds = buildNavCommands([
    { label: '待办', path: '/todo' },
    { label: '待办（重复入口）', path: '/todo' },
    { label: '无路由', path: '' },
    { label: '空白路由', path: '   ' },
  ])
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].id, 'nav:/todo')
})

test('跳转命令：脏入参一律返回空数组，不抛错', () => {
  for (const bad of [null, undefined, 0, '', {}] as unknown[]) {
    assert.deepEqual(buildNavCommands(bad as never), [], `${String(bad)} 应返回 []`)
  }
  // 条目本身残缺（无 label / 非对象）也不该炸
  const cmds = buildNavCommands([null, undefined, { path: '/todo' }] as never)
  assert.equal(cmds.length, 1)
  assert.equal(cmds[0].label, '跳转到未命名页面')
  assert.equal(navCommandLabel({ path: '/x' } as never), '跳转到未命名页面')
})

/* --------------------- 与 NAV_GROUPS 的一致性（单一事实源） --------------------- */

test('面板跳转项与 NAV_GROUPS 一一对应，数量与 path 都不许漂移', () => {
  const entries = navEntriesFromSource()
  assert.equal(entries.length, 12, `NAV_GROUPS 应仍是 12 项，实际 ${entries.length}`)

  const cmds = buildNavCommands(entries)
  assert.equal(cmds.length, entries.length, '每个导航项必须恰好派生出 1 条跳转命令')
  assert.deepEqual(
    cmds.map((c) => c.path),
    entries.map((e) => e.path),
    '顺序必须与抽屉一致（用户在两处看到同一个次序）',
  )
  assert.equal(new Set(cmds.map((c) => c.id)).size, cmds.length, 'id 不得重复')
})

test('面板跳转项的每个 path 都是真实路由', () => {
  const routes = routePathsFromSource()
  for (const cmd of buildNavCommands(navEntriesFromSource())) {
    // NAV_GROUPS 里的「想法 / 资料」带 query，路由表只有 pathname
    const pathname = String(cmd.path).split('?')[0]
    assert.ok(routes.has(pathname), `${cmd.path} 不是 App.tsx 里的真实路由`)
  }
})

test('跳转文案只在一处生成（改文案不会出现两套）', () => {
  const libSrc = stripComments(readSource('web/src/lib/palette.ts'))
  const cmptSrc = stripComments(readSource('web/src/components/CommandPalette.tsx'))
  assert.match(libSrc, /跳转到「/, '文案模板应在 lib/palette.ts')
  assert.doesNotMatch(cmptSrc, /跳转到「/, '组件不得自己拼标签（否则与派生逻辑脱节）')
})

/* ------------------------------- 过滤 ------------------------------- */

function cmd(partial: Partial<PaletteCommand> & { id: string }): PaletteCommand {
  return { label: partial.id, group: '动作', ...partial }
}

const POOL: PaletteCommand[] = [
  cmd({ id: 'act:create', label: '快速记录', hint: '新建想法 / 资料 / 待办', group: '动作' }),
  cmd({ id: 'act:scheme:fluid', label: '切换到「流畅优先」', hint: '动效最足', group: '界面方案' }),
  cmd({ id: 'nav:/todo', label: '跳转到「待办」', hint: '今天 / 即将 / 某天', group: '跳转', keywords: '待办', path: '/todo' }),
  cmd({ id: 'nav:/settings', label: '跳转到「设置」', group: '跳转', keywords: '设置', path: '/settings' }),
]

test('过滤：空关键词返回全部，且保持传入顺序', () => {
  for (const kw of ['', '   ', '\t\n']) {
    assert.deepEqual(
      filterCommands(POOL, kw).map((c) => c.id),
      POOL.map((c) => c.id),
      `关键词「${JSON.stringify(kw)}」应按默认视图返回全部`,
    )
  }
})

test('过滤：主文本 / 说明 / 分组 / 别名 四个字段都能命中', () => {
  const ids = (kw: string) => filterCommands(POOL, kw).map((c) => c.id)
  assert.deepEqual(ids('记录'), ['act:create'], 'label 命中')
  assert.deepEqual(ids('某天'), ['nav:/todo'], 'hint 命中')
  assert.deepEqual(ids('界面方案'), ['act:scheme:fluid'], 'group 命中')
  assert.deepEqual(ids('设置'), ['nav:/settings'], 'keywords 命中（裸 label）')
})

test('过滤：多词取交集，且与词序无关', () => {
  const a = filterCommands(POOL, '跳转 待办').map((c) => c.id)
  const b = filterCommands(POOL, '待办 跳转').map((c) => c.id)
  assert.deepEqual(a, ['nav:/todo'])
  assert.deepEqual(b, a, '词序不应影响结果')
  // 两个词分属不同条目时无交集
  assert.deepEqual(filterCommands(POOL, '快速 设置').map((c) => c.id), [])
})

test('过滤：英文大小写不敏感，无命中返回空数组', () => {
  const withEn = [cmd({ id: 'act:en', label: 'Open Settings' })]
  assert.equal(filterCommands(withEn, 'open').length, 1)
  assert.equal(filterCommands(withEn, 'OPEN').length, 1)
  assert.deepEqual(filterCommands(POOL, '绝不存在的词'), [])
  assert.deepEqual(filterCommands(POOL, 'zzz'), [])
})

test('过滤：关键词最多取 5 段（防长输入退化成全表扫描），脏入参不抛错', () => {
  assert.equal(splitPaletteTerms('a b c d e f g').length, 5)
  assert.deepEqual(splitPaletteTerms('   '), [])
  assert.deepEqual(splitPaletteTerms(undefined as never), [])
  assert.deepEqual(filterCommands(undefined as never, 'x'), [])
})

/* ------------------------------- 分组 ------------------------------- */

test('分组：顺序恒为 动作 → 界面方案 → 跳转 → 记录，不随命中顺序抖动', () => {
  const shuffled = [POOL[3], POOL[0], POOL[2], POOL[1]]
  const groups = groupCommands(shuffled)
  assert.deepEqual(
    groups.map((g) => g.name),
    ['动作', '界面方案', '跳转'],
  )
  assert.deepEqual(PALETTE_GROUP_ORDER, ['动作', '界面方案', '跳转', '记录'])
})

test('分组：index 是「扁平结果里的下标」，不是组内下标（错一位会高亮 A 执行 B）', () => {
  const shuffled = [POOL[3], POOL[0], POOL[2], POOL[1]] // nav:/settings, act:create, nav:/todo, act:scheme
  const groups = groupCommands(shuffled)
  const flat = groups.flatMap((g) => g.items)
  // 扁平序列按组渲染顺序拼出来，下标必须仍是原始（过滤后）序列里的位置
  assert.deepEqual(
    flat.map((it) => it.index).sort((a, b) => a - b),
    [0, 1, 2, 3],
  )
  for (const g of groups) {
    for (const it of g.items) {
      assert.equal(shuffled[it.index].id, it.cmd.id, 'index 必须指向原序列里的同一条命令')
    }
  }
})

test('分组：空列表返回空数组；未知分组兜底排在最后（命令不得凭空消失）', () => {
  assert.deepEqual(groupCommands([]), [])
  assert.deepEqual(groupCommands(undefined as never), [])
  const withUnknown = [...POOL, cmd({ id: 'x', group: '未分组' as never })]
  const groups = groupCommands(withUnknown)
  assert.equal(groups.at(-1)?.name, '未分组')
  assert.equal(groups.flatMap((g) => g.items).length, withUnknown.length)
})

/* ------------------------------ 键盘契约 ------------------------------ */

test('高亮移动：从无高亮往下落在第 1 条，往上落在最后一条', () => {
  assert.equal(moveActive(PALETTE_INITIAL_ACTIVE, 4, 1), 0)
  assert.equal(moveActive(PALETTE_INITIAL_ACTIVE, 4, -1), 3)
})

test('高亮移动：首尾循环回绕', () => {
  assert.equal(moveActive(3, 4, 1), 0, '最后一条往下回到第一条')
  assert.equal(moveActive(0, 4, -1), 3, '第一条往上到最末条')
  assert.equal(moveActive(1, 4, 1), 2)
  assert.equal(moveActive(1, 4, -1), 0)
})

test('高亮移动：单条列表两个方向都停在 0', () => {
  assert.equal(moveActive(-1, 1, 1), 0)
  assert.equal(moveActive(-1, 1, -1), 0)
  assert.equal(moveActive(0, 1, 1), 0)
})

test('高亮移动：空列表保持无高亮；非法入参不产出 NaN', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(moveActive(-1, bad, 1), PALETTE_INITIAL_ACTIVE, `length=${String(bad)} 应保持 -1`)
  }
  assert.equal(moveActive(Number.NaN, 4, 1), 0)
  assert.equal(moveActive(2.7, 4, 1), 3, '小数下标先取整')
  assert.equal(moveActive(1, 4, Number.NaN), 1, '非法步长原地不动')
})

test('按键映射：只认 ↑ ↓ Enter Esc，其余交给浏览器', () => {
  assert.deepEqual(resolvePaletteKey('ArrowDown'), { type: 'next' })
  assert.deepEqual(resolvePaletteKey('ArrowUp'), { type: 'prev' })
  assert.deepEqual(resolvePaletteKey('Enter'), { type: 'run' })
  assert.deepEqual(resolvePaletteKey('Escape'), { type: 'close' })
  for (const other of ['a', 'ArrowLeft', 'Tab', ' ', 'Escape ']) {
    assert.deepEqual(resolvePaletteKey(other), { type: 'none' }, `${other} 不应被面板吞掉`)
  }
  assert.deepEqual(resolvePaletteKey(undefined as never), { type: 'none' })
})

test('键盘链路：↓ ↓ ↑ Enter 顺次命中的是第 1 条，且无高亮时 Enter 不执行', () => {
  const results = filterCommands(POOL, '跳转') // 2 条
  let active = PALETTE_INITIAL_ACTIVE
  // 无高亮时 Enter 不应执行任何命令
  assert.equal(resolvePaletteKey('Enter').type, 'run')
  assert.ok(active < 0, '默认无高亮，Enter 被 runActive 直接 return')

  for (const key of ['ArrowDown', 'ArrowDown', 'ArrowUp']) {
    const action = resolvePaletteKey(key)
    active = moveActive(active, results.length, action.type === 'next' ? 1 : -1)
  }
  assert.equal(active, 0)
  assert.equal(results[active].id, 'nav:/todo')
})

/* --------------------------- 源码级约束（面板） --------------------------- */

test('CommandPalette：逻辑全部走 lib/palette，组件不自己排序/过滤/移动高亮', () => {
  const src = stripComments(readSource('web/src/components/CommandPalette.tsx'))
  for (const fn of ['buildNavCommands', 'filterCommands', 'groupCommands', 'moveActive', 'resolvePaletteKey']) {
    assert.ok(src.includes(`${fn}(`), `必须调用 ${fn}()（纯逻辑只有一份实现）`)
  }
  assert.doesNotMatch(src, /\.filter\(\(c\)\s*=>/, '不得在组件里再写一份过滤')
  assert.doesNotMatch(src, /% results\.length/, '不得在组件里再写一份回绕算法')
})

test('CommandPalette：跳转项从 NAV_GROUPS 派生，不写第二份路径表', () => {
  const src = stripComments(readSource('web/src/components/CommandPalette.tsx'))
  assert.match(src, /buildNavCommands\(flatNavItems\(\)\)/, '必须从导航配置派生')
  for (const literal of ["'/todo'", "'/calendar'", "'/settings'", "'/records'", "'/review'"]) {
    assert.ok(!src.includes(literal), `组件里不得出现路由字面量 ${literal}（会与 NAV_GROUPS 脱节）`)
  }
  // 方案硬判断同样禁止（UI 改动一律走能力位）
  assert.doesNotMatch(src, /scheme\s*===/)
})

test('CommandPalette：无障碍关联（listbox / option / aria-activedescendant）', () => {
  const src = stripComments(readSource('web/src/components/CommandPalette.tsx'))
  assert.match(src, /role="listbox"/)
  assert.match(src, /role="option"/)
  assert.match(src, /aria-selected=\{index === active\}/)
  assert.match(src, /aria-activedescendant/, '输入框必须指向当前高亮项')
  // 走 `inputProps` 对象写法，键名带引号
  assert.match(src, /['"]aria-label['"]\s*:\s*['"]命令面板输入['"]/)
})

/* --------------------- 源码级约束 + 同步开面板（壳层） --------------------- */

test('CommandPalette：打开时立即给输入框焦点（否则前 60ms 的方向键会丢）', () => {
  const src = stripComments(readSource('web/src/components/CommandPalette.tsx'))
  // 立即 focus + 延后兜底各一次（顺序：先立即，后 setTimeout）
  const immediate = src.indexOf('inputRef.current?.focus()')
  const delayed = src.indexOf('setTimeout(() => inputRef.current?.focus()')
  assert.ok(immediate >= 0, '必须有立即 focus（消除「面板已出现但按键落在 body」的盲窗）')
  assert.ok(delayed > immediate, '延后那次只能作为兜底，且必须在立即 focus 之后')
})

test('Layout：Ctrl+K 同步开面板（不 debounce、不 setTimeout、不 await）', () => {
  const src = stripComments(readSource('web/src/components/Layout.tsx'))
  assert.match(
    src,
    /if \(id === 'command-palette'\) \{\s*useUiShellStore\.getState\(\)\.togglePalette\(\)/,
    '必须在 keydown 分支里直接同步切换（这就是「2 帧内出面板」的前提）',
  )
  // 打开路径上不许有任何延迟调度
  assert.doesNotMatch(src, /setTimeout\([\s\S]{0,160}togglePalette/, '开面板不得延后')
  assert.doesNotMatch(src, /await[\s\S]{0,120}togglePalette/, '开面板不得 await')
})

test('Layout：面板只在能力位存在时挂载（未挂载 = 快捷键不注册，不会「按了没反应」）', () => {
  const src = stripComments(readSource('web/src/components/Layout.tsx'))
  assert.match(src, /\{features\.commandPalette && <CommandPalette \/>\}/)
  assert.match(src, /disabledShortcutIds\(\{ commandPalette: features\.commandPalette \}\)/)
})

test('Layout：全局只有一个 keydown 监听（面板自身不再挂第二个）', () => {
  const layout = stripComments(readSource('web/src/components/Layout.tsx'))
  const palette = stripComments(readSource('web/src/components/CommandPalette.tsx'))
  assert.equal(
    [...layout.matchAll(/window\.addEventListener\('keydown'/g)].length,
    1,
    '壳层只能有一个 keydown 入口',
  )
  assert.doesNotMatch(palette, /addEventListener\('keydown'/, '面板不得自己挂全局监听')
  // 面板只处理自己的输入框按键
  assert.match(palette, /onKeyDown=\{handleKeyDown\}/)
})

test('打开是同步的：togglePalette() 后同一 tick 即可读到 paletteOpen=true', () => {
  const store = useUiShellStore.getState()
  store.closePalette()
  assert.equal(useUiShellStore.getState().paletteOpen, false)

  useUiShellStore.getState().togglePalette()
  // 不 await、不等 microtask —— 面板的出现不依赖任何异步步骤
  assert.equal(useUiShellStore.getState().paletteOpen, true)

  useUiShellStore.getState().togglePalette()
  assert.equal(useUiShellStore.getState().paletteOpen, false, '同一键位再按一次应关闭')
})
