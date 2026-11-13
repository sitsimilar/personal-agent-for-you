/**
 * 快捷键注册表 P1-14 测试。
 *
 * 验收原文：「输入框内按 Ctrl+N 不新建；`docs/SHORTCUTS.md` 与注册表逐条一致（写个脚本比对）」。
 * 对应断言：
 * - `resolveShortcut` 在 `editable=true` 下对 `mod+n` 返回 `ignored/editable`；
 * - 文档比对：`renderShortcutsMarkdown(SHORTCUTS)` 与 `docs/SHORTCUTS.md` **完全相等**
 *   （脚本 `npm run shortcuts:check` 做同一件事，两边共用同一个渲染函数，不可能漂移）。
 *
 * 另外锁住 11-03 增补的两件事：作用域（scope）隔离与冲突检测。
 * 这层不渲染 React：注册表是纯数据 + 纯函数，Node 里可以直接断言。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  SEQUENCE_TIMEOUT_MS,
  SHORTCUTS,
  SHORTCUTS_DOC_PATH,
  comboFromEvent,
  createSequenceState,
  detectShortcutConflicts,
  disabledShortcutIds,
  formatCombo,
  isEditableTarget,
  normalizeCombo,
  renderShortcutsMarkdown,
  resolveShortcut,
  sequencePrefixes,
  type ShortcutSpec,
} from '../web/src/lib/shortcuts'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

/** 造一个键盘事件字面量（KeyboardEvent 结构子集）。 */
function key(k: string, mods: { ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean } = {}) {
  return {
    key: k,
    ctrlKey: Boolean(mods.ctrl),
    metaKey: Boolean(mods.meta),
    altKey: Boolean(mods.alt),
    shiftKey: Boolean(mods.shift),
  }
}

/* ------------------------------ 注册表自检 ------------------------------ */

test('注册表：无重复 id、无同作用域撞键（冲突检测必须为空）', () => {
  assert.deepEqual(detectShortcutConflicts(SHORTCUTS), [])
})

test('注册表：每条都齐备 id / combo / keys / label / group / scope，且 combo 已是规范形式', () => {
  for (const spec of SHORTCUTS) {
    assert.ok(spec.id.trim().length > 0)
    assert.ok(spec.keys.trim().length > 0, `${spec.id} 缺展示按键`)
    assert.ok(spec.label.trim().length > 0, `${spec.id} 缺说明`)
    assert.ok(['记录', '导航', '通用'].includes(spec.group), `${spec.id} 分组非法`)
    assert.ok(['app', 'palette'].includes(spec.scope), `${spec.id} 作用域非法`)
    assert.equal(normalizeCombo(spec.combo), spec.combo, `${spec.id} 的 combo 未规范化`)
  }
})

test('注册表：计划点名的五个键位都在（Ctrl+N / / / G→T / G→R / Ctrl+K）', () => {
  const combos = SHORTCUTS.map((s) => s.combo)
  for (const combo of ['mod+n', '/', 'g t', 'g r', 'mod+k']) {
    assert.ok(combos.includes(combo), `缺少 ${combo}`)
  }
})

test('注册表：序列前缀由组合派生（g），且没有把单键误判成序列', () => {
  assert.deepEqual(sequencePrefixes(SHORTCUTS), ['g'])
  for (const spec of SHORTCUTS) {
    if (!spec.combo.includes(' ')) assert.equal(spec.combo.split('+').length <= 2, true)
  }
})

test('注册表：命令面板被标记为依赖能力位（其他方案下要能被整体禁用）', () => {
  const palette = SHORTCUTS.find((s) => s.id === 'command-palette')
  assert.ok(palette)
  assert.equal(palette?.requires, 'commandPalette')
})

/* ------------------------------ 组合规范化 ------------------------------ */

test('normalizeCombo：别名归一（Ctrl / Cmd / Meta / Option）与修饰符排序', () => {
  assert.equal(normalizeCombo('Ctrl+K'), 'mod+k')
  assert.equal(normalizeCombo('CMD+k'), 'mod+k')
  assert.equal(normalizeCombo('meta+shift+k'), 'mod+shift+k')
  assert.equal(normalizeCombo('shift+ctrl+k'), 'mod+shift+k', '修饰符必须按 mod→alt→shift 排序')
  assert.equal(normalizeCombo(' Alt + N '), 'alt+n')
  assert.equal(normalizeCombo('G  T'), 'g t')
  assert.equal(normalizeCombo('Esc'), 'escape')
})

test('comboFromEvent：macOS ⌘ 与 Windows Ctrl 归一成同一个 mod', () => {
  assert.equal(comboFromEvent(key('k', { ctrl: true })), 'mod+k')
  assert.equal(comboFromEvent(key('k', { meta: true })), 'mod+k')
})

test('comboFromEvent：单字符键的 shift 已含在 key 里，不再叠加（? 就是 ?）', () => {
  assert.equal(comboFromEvent(key('?', { shift: true })), '?')
  assert.equal(comboFromEvent(key('/')), '/')
  /**
   * 真实浏览器里 Shift+/ 的 `key` 本身就是 `?`（`code` 才是 `Slash`），
   * 所以这里断言的契约是：一次 Shift+/ 事件必须能命中 `?` 那条，
   * 而不是内部要不要把 `/` 重映射成 `?`（那是布局假设，不能写死）。
   */
  const result = resolveShortcut(key('?', { shift: true }), {})
  assert.equal(result.type, 'run')
  assert.equal(result.type === 'run' ? result.shortcut.id : '', 'shortcut-help')
})

test('comboFromEvent：字母被 shift 大写时补回 shift，避免与 mod+n 混为一谈', () => {
  assert.equal(comboFromEvent(key('N', { ctrl: true, shift: true })), 'mod+shift+n')
  assert.equal(comboFromEvent(key('n', { ctrl: true })), 'mod+n')
})

test('comboFromEvent：空 key 返回空串（组合键中间态不产生假命中）', () => {
  assert.equal(comboFromEvent({ key: '' }), '')
})

test('formatCombo：文档里不出现 mod 字样', () => {
  assert.equal(formatCombo('mod+k'), 'Ctrl / ⌘ + K')
  assert.equal(formatCombo('g t'), 'G → T')
  assert.ok(!renderShortcutsMarkdown(SHORTCUTS).includes('mod+'), '文档不应暴露内部写法')
})

/* ------------------------------ 可编辑目标判定 ------------------------------ */

test('isEditableTarget：文本输入 / 文本域 / 可编辑区 / textbox 角色都算「正在打字」', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'text' }), true)
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true, '缺 type 默认 text')
  assert.equal(isEditableTarget({ tagName: 'INPUT', type: 'search' }), true)
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true, 'tagName 大小写不敏感')
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', getAttribute: (n: string) => (n === 'role' ? 'textbox' : null) }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', getAttribute: () => 'searchbox' }), true)
})

test('isEditableTarget：复选框 / 按钮类 input 与普通元素不算打字（快捷键应照常生效）', () => {
  for (const type of ['checkbox', 'radio', 'button', 'submit', 'range', 'file', 'color']) {
    assert.equal(isEditableTarget({ tagName: 'INPUT', type }), false, `${type} 不应拦截快捷键`)
  }
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false)
  assert.equal(isEditableTarget({ tagName: 'BUTTON' }), false)
  assert.equal(isEditableTarget(null), false)
  assert.equal(isEditableTarget(undefined), false)
  assert.equal(isEditableTarget('input'), false, '字符串不是元素，不能误判')
})

/* ------------------------- 输入框内 Ctrl+N 不新建（核心验收） ------------------------- */

test('输入框内按 Ctrl+N：返回 ignored/editable（不新建记录）', () => {
  const result = resolveShortcut(key('n', { ctrl: true }), { editable: true })
  assert.equal(result.type, 'ignored')
  assert.equal(result.type === 'ignored' ? result.reason : '', 'editable')
})

test('输入框内按 ⌘+N 同样被拦（macOS 一套逻辑）', () => {
  const result = resolveShortcut(key('n', { meta: true }), { editable: true })
  assert.equal(result.type, 'ignored')
})

test('输入框外按 Ctrl+N：命中 create-record', () => {
  const result = resolveShortcut(key('n', { ctrl: true }), { editable: false })
  assert.equal(result.type, 'run')
  assert.equal(result.type === 'run' ? result.shortcut.id : '', 'create-record')
})

test('输入框内 Ctrl+K 仍可用（allowInEditable=true，唯一的例外）', () => {
  const result = resolveShortcut(key('k', { ctrl: true }), { editable: true })
  assert.equal(result.type, 'run')
  assert.equal(result.type === 'run' ? result.shortcut.id : '', 'command-palette')
})

test('输入框内 / 与 ? 与 G 都不触发（打字优先）', () => {
  for (const input of [key('/'), key('?', { shift: true }), key('g')]) {
    const result = resolveShortcut(input, { editable: true, state: createSequenceState() })
    assert.equal(result.type, 'ignored', `${input.key} 在输入框内不应生效`)
  }
})

/* ------------------------------ 序列键 G→T / G→R ------------------------------ */

test('序列键：G 后按 T 命中 goto-todo，并在窗口内', () => {
  const state = createSequenceState()
  const first = resolveShortcut(key('g'), { state, now: 1000 })
  assert.equal(first.type, 'pending')
  const second = resolveShortcut(key('t'), { state, now: 1000 + SEQUENCE_TIMEOUT_MS })
  assert.equal(second.type, 'run')
  assert.equal(second.type === 'run' ? second.shortcut.id : '', 'goto-todo')
})

test('序列键：G 后按 R 命中 goto-records，且带上目标路由', () => {
  const state = createSequenceState()
  resolveShortcut(key('g'), { state, now: 0 })
  const second = resolveShortcut(key('r'), { state, now: 500 })
  assert.equal(second.type, 'run')
  assert.equal(second.type === 'run' ? second.shortcut.path : '', '/records')
})

test('序列键：超时作废（G 之后隔了 2s 再按 T 不跳页）', () => {
  const state = createSequenceState()
  resolveShortcut(key('g'), { state, now: 0 })
  const late = resolveShortcut(key('t'), { state, now: SEQUENCE_TIMEOUT_MS + 1 })
  assert.equal(late.type, 'ignored')
  assert.equal(state.prefix, null, '超时后必须清掉前缀，否则下一次 T 会误命中')
})

test('序列键：G 之后按无关键不命中，且状态被清空', () => {
  const state = createSequenceState()
  resolveShortcut(key('g'), { state, now: 0 })
  const other = resolveShortcut(key('x'), { state, now: 100 })
  assert.equal(other.type, 'ignored')
  assert.equal(state.prefix, null)
})

test('序列键：按两次 G 不会跳页，第二次仍只是等待（不会把 g 当成第二键）', () => {
  const state = createSequenceState()
  resolveShortcut(key('g'), { state, now: 0 })
  const again = resolveShortcut(key('g'), { state, now: 100 })
  assert.notEqual(again.type, 'run')
})

test('序列键：G 之后按 Ctrl+N 按单键处理（修饰键打断序列）', () => {
  const state = createSequenceState()
  resolveShortcut(key('g'), { state, now: 0 })
  const result = resolveShortcut(key('n', { ctrl: true }), { state, now: 100 })
  assert.equal(result.type, 'run')
  assert.equal(result.type === 'run' ? result.shortcut.id : '', 'create-record')
})

/* ------------------------------ 作用域隔离 ------------------------------ */

test('作用域：palette 作用域下 app 级快捷键不生效', () => {
  const result = resolveShortcut(key('n', { ctrl: true }), { editable: false, scope: 'palette' })
  assert.equal(result.type, 'ignored')
})

test('作用域：同键位在不同 scope 下不算冲突，同 scope 才算', () => {
  const base: ShortcutSpec = {
    id: 'a',
    combo: 'enter',
    keys: 'Enter',
    label: '打开',
    group: '导航',
    scope: 'app',
  }
  const sameOtherScope: ShortcutSpec = { ...base, id: 'b', scope: 'palette' }
  const sameScope: ShortcutSpec = { ...base, id: 'c' }
  assert.deepEqual(detectShortcutConflicts([base, sameOtherScope]), [])
  const conflicts = detectShortcutConflicts([base, sameScope])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].kind, 'duplicate-combo')
  assert.deepEqual(conflicts[0].ids, ['a', 'c'])
})

test('冲突检测：重复 id 被单独报出来（复制粘贴忘改 id）', () => {
  const base: ShortcutSpec = {
    id: 'dup',
    combo: 'mod+j',
    keys: 'Ctrl + J',
    label: '示例',
    group: '通用',
    scope: 'app',
  }
  const conflicts = detectShortcutConflicts([base, { ...base, combo: 'mod+l' }])
  assert.equal(conflicts.length, 1)
  assert.equal(conflicts[0].kind, 'duplicate-id')
})

test('冲突检测：combo 写法不同但规范形式相同也算冲突（Ctrl+K 与 cmd+k）', () => {
  const a: ShortcutSpec = { id: 'a', combo: 'Ctrl+K', keys: 'A', label: 'A', group: '通用', scope: 'app' }
  const b: ShortcutSpec = { id: 'b', combo: 'cmd+k', keys: 'B', label: 'B', group: '通用', scope: 'app' }
  assert.equal(detectShortcutConflicts([a, b]).length, 1)
})

/* ------------------------------ 禁用与挂起 ------------------------------ */

test('disabledShortcutIds：命令面板能力位缺失时只禁它一条', () => {
  assert.deepEqual(disabledShortcutIds({ commandPalette: false }), ['command-palette'])
  assert.deepEqual(disabledShortcutIds({ commandPalette: true }), [])
})

test('disabledIds：被禁用的条目返回 no-match（不拦截浏览器原生行为）', () => {
  const result = resolveShortcut(key('k', { ctrl: true }), { disabledIds: ['command-palette'] })
  assert.equal(result.type, 'ignored')
  assert.equal(result.type === 'ignored' ? result.reason : '', 'no-match')
})

test('suspended（对话框打开）：任何键都不动', () => {
  const state = createSequenceState()
  for (const input of [key('n', { ctrl: true }), key('/'), key('g'), key('?', { shift: true })]) {
    const result = resolveShortcut(input, { suspended: true, state })
    assert.equal(result.type, 'ignored')
    assert.equal(result.type === 'ignored' ? result.reason : '', 'suspended')
  }
})

test('无 state 时序列键退化为「不命中」，不会误触发单键动作', () => {
  const result = resolveShortcut(key('t'), {})
  assert.equal(result.type, 'ignored')
})

/* ------------------- 文档与注册表逐条一致（核心验收） ------------------- */

test('docs/SHORTCUTS.md 与注册表逐条一致（生成函数与脚本共用，漂移即红）', () => {
  const actual = readFileSync(path.join(ROOT, SHORTCUTS_DOC_PATH), 'utf8').replace(/\r\n/g, '\n')
  const expected = renderShortcutsMarkdown(SHORTCUTS)
  assert.equal(actual.trimEnd(), expected.trimEnd(), `${SHORTCUTS_DOC_PATH} 已过期，请运行 npm run shortcuts:doc`)
})

test('文档里每一条的按键与说明都能在文本中找到（防止渲染时漏行）', () => {
  const doc = renderShortcutsMarkdown(SHORTCUTS)
  for (const spec of SHORTCUTS) {
    assert.ok(doc.includes(spec.keys), `文档缺少按键 ${spec.keys}`)
    assert.ok(doc.includes(spec.label), `文档缺少说明 ${spec.label}`)
  }
})

test('文档条目数 = 注册表长度（既不漏也不多）', () => {
  const doc = renderShortcutsMarkdown(SHORTCUTS)
  const rows = doc.split('\n').filter((line) => line.startsWith('| `'))
  assert.equal(rows.length, SHORTCUTS.length)
})

/* ------------------- 源码级接线约束（防「注册表写了但没接」） ------------------- */

/**
 * 剥掉注释再断言：11-09 踩过一次「注释里写着 1201，正则匹配到注释 → 假绿」。
 * 源码约束必须只匹配真代码。
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

test('Layout：只有一个 keydown 监听，且经 resolveShortcut 分发（不许绕开注册表另挂）', () => {
  const src = stripComments(readFileSync(path.join(ROOT, 'web/src/components/Layout.tsx'), 'utf8'))
  const listeners = src.match(/addEventListener\('keydown'/g) ?? []
  assert.equal(listeners.length, 1, `keydown 监听应只有 1 处，实际 ${listeners.length} 处`)
  assert.ok(src.includes('resolveShortcut('), 'Layout 必须用注册表解析按键')
  assert.ok(src.includes('isEditableTarget('), 'Layout 必须把「是否在输入框」传进去')
  assert.ok(src.includes('disabledShortcutIds('), '能力位缺失的条目必须被禁用')
  // 旧的单点实现（手写 Ctrl+K 判断）不许回来
  assert.ok(!src.includes("=== 'k'"), '不允许再出现手写键位判断')
})

test('Layout：`/` 的目标输入框 id 与注册表常量同源，帮助浮层已挂载', () => {
  const src = stripComments(readFileSync(path.join(ROOT, 'web/src/components/Layout.tsx'), 'utf8'))
  assert.ok(src.includes('SEARCH_INPUT_ID'), '检索框 id 必须来自注册表常量，不能写死字符串')
  assert.ok(src.includes('focusId={SEARCH_INPUT_ID}'), 'SearchBar 必须拿到这个 id，否则 / 无从聚焦')
  assert.ok(src.includes('<ShortcutHelpDialog'), '`?` 打开的浮层必须真的挂载')
})

test('ShortcutHelpDialog：表格由注册表派生（没有第二份手写清单）', () => {
  const src = stripComments(
    readFileSync(path.join(ROOT, 'web/src/components/ShortcutHelpDialog.tsx'), 'utf8'),
  )
  assert.ok(src.includes('SHORTCUTS'), '必须消费注册表')
  assert.ok(!src.includes('Ctrl + N'), '不许在组件里手写键位文案')
})
