/**
 * 命令面板 P1-12 下半 · 测试（记录 provider / 拼音首字母 / 排序 / 最近使用）。
 *
 * 覆盖四层：
 * 1. **纯逻辑**（`lib/palette.ts`）：`shouldSearchRecords` 门槛、`buildRecordCommands` 形状、
 *    三层 + 子序列打分、`applyRecentOrder`；
 * 2. **纯逻辑**（`lib/pinyin.ts`）：首字母映射、表外字不假命中、`NAV_GROUPS` 全量覆盖；
 * 3. **存储**（`lib/palette-recent.ts`）：脏数据、写失败、截断；
 * 4. **源码级接线约束**：面板必须真的走 `recordService.search()`（带防覆盖序号与 debounce）、
 *    记录详情由壳层全局挂载、面板内输入不得触发全局快捷键。
 *
 * 为什么第 4 层要用源码断言：`recordService` 依赖云 SDK，Node 侧无法真跑；
 * 而「写了逻辑没接线」是本项目已经踩过的假绿（11-11 的教训）。
 * 源码断言一律先剥注释，避免注释里的同名字符串造成假绿。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  PALETTE_GROUP_ORDER,
  PALETTE_RECORD_LIMIT,
  PALETTE_RECORD_MIN_QUERY,
  PALETTE_SCORE_BOUNDARY,
  PALETTE_SCORE_FUZZY,
  PALETTE_SCORE_PREFIX,
  PALETTE_SCORE_SUBSTRING,
  applyRecentOrder,
  buildNavCommands,
  buildRecordCommands,
  filterCommands,
  groupCommands,
  recordCommandLabel,
  scoreCommandTerm,
  shouldSearchRecords,
  type PaletteCommand,
} from '../web/src/lib/palette'
import { initialLetters, pinyinCoverage, pinyinKeyword } from '../web/src/lib/pinyin'
import {
  PALETTE_RECENT_KEY,
  PALETTE_RECENT_MAX,
  readRecentIds,
  rememberRecentId,
} from '../web/src/lib/palette-recent'
import { SHORTCUTS, createSequenceState, isEditableTarget, resolveShortcut } from '../web/src/lib/shortcuts'
import { useUiShellStore } from '../web/src/store/uiShellStore'

const ROOT = typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd()

function readSource(relPath: string): string {
  return readFileSync(path.join(ROOT, relPath), 'utf8')
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/* ---------------------------- 检索门槛（≥2 字） ---------------------------- */

test('记录检索门槛：至少 2 个字才查云端，空白输入不算字', () => {
  assert.equal(PALETTE_RECORD_MIN_QUERY, 2)
  for (const kw of ['', '   ', '周', ' 周 ', '\t\n']) {
    assert.equal(shouldSearchRecords(kw), false, `「${JSON.stringify(kw)}」不该发起检索`)
  }
  for (const kw of ['周报', ' 周报模板 ', 'ab', '周报 模板']) {
    assert.equal(shouldSearchRecords(kw), true, `「${kw}」应该发起检索`)
  }
})

test('记录检索门槛：按码点计数（emoji / 生僻字占 2 个 UTF-16 单元，不能算 2 个字）', () => {
  assert.equal([...'😀'].length, 1)
  assert.equal('😀'.length, 2, '前提：这个 emoji 的 length 是 2')
  assert.equal(shouldSearchRecords('😀'), false, '1 个字符不应触发（否则每个 emoji 都打一发请求）')
  assert.equal(shouldSearchRecords('😀😀'), true)
  assert.equal(shouldSearchRecords(undefined as never), false)
})

/* ------------------------- 记录命令形状（打开记录：《》） ------------------------- */

const RECORDS = [
  { id: 7, title: '周报模板', createdAt: '2026-11-12T08:30:00.000Z' },
  { id: 9, title: '  月度复盘  ', createdAt: '2026-11-01T00:00:00.000Z' },
]

test('记录命令：文案是「打开记录：《标题》」，id 用主键，带日期提示', () => {
  const cmds = buildRecordCommands(RECORDS)
  assert.equal(cmds.length, 2)
  assert.deepEqual(cmds.map((c) => c.id), ['rec:7', 'rec:9'])
  assert.equal(cmds[0].label, '打开记录：《周报模板》')
  assert.equal(cmds[1].label, '打开记录：《月度复盘》', '标题两端空白必须清掉')
  assert.equal(cmds[0].hint, '2026-11-12')
  assert.equal(cmds[0].group, '记录')
  assert.equal(cmds[0].alwaysShow, true, '命中由服务端判定，本地必须无条件放行')
  assert.equal(cmds[0].source, RECORDS[0], '必须保留原记录，组件靠它开详情')
  assert.equal(recordCommandLabel(RECORDS[0]), cmds[0].label, '文案模板只能来自纯逻辑层')
})

test('记录命令：兼容 created_at 蛇形字段；缺字段不抛错', () => {
  const [cmd] = buildRecordCommands([{ id: 1, title: 'A', created_at: '2026-10-30T12:00:00Z' }])
  assert.equal(cmd.hint, '2026-10-30')
  const [dirty] = buildRecordCommands([{ id: 2, title: 'B', created_at: 'not-a-date' }])
  assert.equal(dirty.hint, undefined, '非法日期不给提示（不要猜）')
  const [noTitle] = buildRecordCommands([{ id: 3 }])
  assert.equal(noTitle.label, '打开记录：《未命名记录》')
})

test('记录命令：上限 5 条、同主键去重、缺主键跳过、脏入参返回空数组', () => {
  assert.equal(PALETTE_RECORD_LIMIT, 5)
  const many = Array.from({ length: 9 }, (_, i) => ({ id: i + 1, title: `记录 ${i + 1}` }))
  assert.equal(buildRecordCommands(many).length, 5)
  assert.deepEqual(
    buildRecordCommands([{ id: 1, title: 'A' }, { id: 1, title: 'A 重复' }]).map((c) => c.id),
    ['rec:1'],
  )
  assert.deepEqual(buildRecordCommands([{ id: null as never, title: 'x' }]), [])
  assert.deepEqual(buildRecordCommands([{ id: '', title: 'x' }]), [])
  for (const bad of [null, undefined, {} as never]) {
    assert.deepEqual(buildRecordCommands(bad), [], `${String(bad)} 应返回 []`)
  }
  // limit 非法时回落到默认上限，不返回 0 条
  assert.equal(buildRecordCommands(many, 0).length, PALETTE_RECORD_LIMIT)
})

test('记录命令：本地过滤不得二次筛掉（正文命中但标题没关键词的那条）', () => {
  const nav = buildNavCommands([{ label: '待办', path: '/todo' }])
  const recs = buildRecordCommands([{ id: 42, title: '周末计划' }])
  const pool = [...nav, ...recs]
  const hits = filterCommands(pool, '绝不存在的词')
  assert.deepEqual(hits.map((c) => c.id), ['rec:42'], '服务端已筛过，本地必须保留记录命令')
  // 分组渲染时「记录」排在最后（异步 provider 追加到尾部，不挤走用户正在看的那条）
  assert.deepEqual(groupCommands(pool).map((g) => g.name), ['跳转', '记录'])
  assert.deepEqual(PALETTE_GROUP_ORDER.at(-1), '记录')
})

/* ------------------------------ 三层排序 ------------------------------ */

function cmd(id: string, label: string, extra: Partial<PaletteCommand> = {}): PaletteCommand {
  return { id, label, group: '动作', ...extra }
}

test('打分：前缀 > 词边界 > 词中 > 英文子序列 > 未命中', () => {
  assert.equal(scoreCommandTerm(cmd('a', '设置'), '设置'), PALETTE_SCORE_PREFIX)
  assert.equal(scoreCommandTerm(cmd('b', '打开「设置」'), '设置'), PALETTE_SCORE_BOUNDARY)
  assert.equal(scoreCommandTerm(cmd('c', '修改设置项'), '设置'), PALETTE_SCORE_SUBSTRING)
  assert.equal(scoreCommandTerm(cmd('d', 'Open Settings'), 'opst'), PALETTE_SCORE_FUZZY)
  assert.equal(scoreCommandTerm(cmd('e', 'Open Settings'), 'zzz'), 0)
  // 中文不走子序列兜底（「待办」里没有「待」的顺序直觉）
  assert.equal(scoreCommandTerm(cmd('f', '待办'), 'tb'), 0)
  assert.equal(scoreCommandTerm(cmd('g', '待办'), ''), 0)
})

test('排序：filterCommands 按命中层级降序，同分保持传入顺序', () => {
  const pool = [
    cmd('substring', '修改设置项'),
    cmd('prefix', '设置'),
    cmd('boundary', '打开「设置」'),
  ]
  assert.deepEqual(
    filterCommands(pool, '设置').map((c) => c.id),
    ['prefix', 'boundary', 'substring'],
  )
  const same = [cmd('first', '待办 A'), cmd('second', '待办 B')]
  assert.deepEqual(filterCommands(same, '待办').map((c) => c.id), ['first', 'second'], '同分不得抖动')
  // 空关键词仍按原顺序返回（默认视图）
  assert.deepEqual(filterCommands(same, '').map((c) => c.id), ['first', 'second'])
})

/* ------------------------------ 拼音首字母 ------------------------------ */

test('拼音：常用词首字母正确，ASCII 原样保留，标点与空格跳过', () => {
  assert.equal(initialLetters('待办'), 'db')
  assert.equal(initialLetters('思维树'), 'sws')
  assert.equal(initialLetters('全部信息'), 'qbxx')
  assert.equal(initialLetters('跳转到「待办」'), 'tzddb')
  assert.equal(initialLetters(''), '')
  assert.equal(initialLetters(undefined as never), '')
})

test('拼音：表外汉字映射成 ? 而不是跳过（跳过会假命中别的词）', () => {
  assert.equal(initialLetters('鬻'), '?')
  assert.equal(pinyinKeyword('鬻'), undefined)
  assert.equal(pinyinKeyword('待'), undefined, '单字缩写无意义，可能撞英文单词')
  assert.equal(pinyinKeyword('待办'), 'db')
  assert.deepEqual(pinyinCoverage('待办鬻').missing, ['鬻'])
})

test('拼音：NAV_GROUPS 的每个标签都被首字母表覆盖（新增菜单项不能悄悄失效）', () => {
  const src = readSource('web/src/lib/nav.tsx')
  const labels = [...src.matchAll(/label:\s*'([^']+)'/g)].map((m) => m[1])
  assert.ok(labels.length >= 12, `应至少解析出 12 个标签，实际 ${labels.length}`)
  for (const label of labels) {
    const { initials, missing } = pinyinCoverage(label)
    assert.deepEqual(missing, [], `「${label}」含表外字，请补 lib/pinyin.ts 的首字母表`)
    assert.notEqual(pinyinKeyword(label), undefined, `「${label}」应能生成首字母关键词（当前 ${initials}）`)
  }
})

test('拼音：面板里敲 db 能命中「待办」，敲 sws 能命中「思维树」', () => {
  const cmds = buildNavCommands([
    { label: '待办', path: '/todo' },
    { label: '思维树', path: '/mindtree' },
    { label: '设置', path: '/settings' },
  ])
  const ids = (kw: string) => filterCommands(cmds, kw).map((c) => c.id)
  assert.deepEqual(ids('db'), ['nav:/todo'])
  assert.deepEqual(ids('sws'), ['nav:/mindtree'])
  assert.deepEqual(ids('sz'), ['nav:/settings'])
  assert.equal(cmds[0].keywords, '待办 db')
})

/* ------------------------------ 最近使用 ------------------------------ */

test('最近使用：按历史顺序前置，未用过的保持原顺序，且不改动入参', () => {
  const pool = [cmd('a', 'A'), cmd('b', 'B'), cmd('c', 'C')]
  const snapshot = JSON.stringify(pool)
  assert.deepEqual(applyRecentOrder(pool, ['c', 'a']).map((x) => x.id), ['c', 'a', 'b'])
  assert.deepEqual(applyRecentOrder(pool, []).map((x) => x.id), ['a', 'b', 'c'])
  assert.deepEqual(applyRecentOrder(pool, null).map((x) => x.id), ['a', 'b', 'c'])
  assert.equal(JSON.stringify(pool), snapshot, '不得就地修改入参')
  // 历史里已不存在的 id 不影响结果（例如记录被删了）
  assert.deepEqual(applyRecentOrder(pool, ['gone', 'b']).map((x) => x.id), ['b', 'a', 'c'])
})

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value)
    },
    dump: () => Object.fromEntries(map),
  }
}

test('最近使用存储：置顶去重、截断到 5 条、写回同一份 JSON', () => {
  const storage = fakeStorage()
  assert.deepEqual(readRecentIds(storage), [])
  let list = rememberRecentId(storage, 'a')
  list = rememberRecentId(storage, 'b', list)
  list = rememberRecentId(storage, 'a', list)
  assert.deepEqual(list, ['a', 'b'])
  for (const id of ['c', 'd', 'e', 'f']) list = rememberRecentId(storage, id, list)
  assert.equal(list.length, PALETTE_RECENT_MAX)
  assert.deepEqual(readRecentIds(storage), list, '写进去的必须能原样读回来')
  assert.ok(storage.dump()[PALETTE_RECENT_KEY], '存储键名固定，便于用户自己清')
})

test('最近使用存储：脏数据当空、写失败仍返回新顺序、无存储不抛错', () => {
  for (const raw of ['not json', '{}', '123', '["a",1,null,"a"]']) {
    assert.deepEqual(readRecentIds(fakeStorage({ [PALETTE_RECENT_KEY]: raw })), raw === '["a",1,null,"a"]' ? ['a'] : [], raw)
  }
  const readonly = {
    getItem: () => null,
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }
  assert.deepEqual(rememberRecentId(readonly, 'x', ['y']), ['x', 'y'], '写不进也要返回内存里的新顺序')
  assert.deepEqual(readRecentIds(null), [])
  assert.deepEqual(rememberRecentId(null, 'x', null), ['x'])
  assert.deepEqual(rememberRecentId(null, '', ['y']), ['y'])
})

/* -------------------- 面板内输入不触发全局快捷键 -------------------- */

test('快捷键闸门：面板打开时只留「开/关面板」，输入框里敲字一律让位', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false)

  // Layout 在面板打开时构造的禁用集：除 command-palette 外全部挂起
  const suspended = SHORTCUTS.filter((s) => s.id !== 'command-palette').map((s) => s.id)
  const state = createSequenceState()
  for (const key of ['g', 'n', '/', '?']) {
    const res = resolveShortcut(
      { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false },
      { state, editable: true, disabledIds: suspended },
    )
    assert.notEqual(res.type, 'run', `面板内敲「${key}」不得触发全局快捷键`)
  }
  // 面板自己仍可被 Ctrl+K 关掉（这是唯一保留的一条）
  const toggle = resolveShortcut(
    { key: 'k', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false },
    { state: createSequenceState(), editable: true, disabledIds: suspended },
  )
  assert.equal(toggle.type, 'run')
  assert.equal(toggle.type === 'run' ? toggle.shortcut.id : '', 'command-palette')
})

/* --------------------------- 源码级接线约束 --------------------------- */

test('CommandPalette：记录 provider 真接了 recordService.search（阈值 + debounce + 防覆盖）', () => {
  const src = stripComments(readSource('web/src/components/CommandPalette.tsx'))
  assert.match(src, /from '@\/services\/recordService'/, '必须用既有检索服务，不要另写查询')
  assert.match(src, /recordService\.search\(/, '必须真的调 search()')
  assert.match(src, /shouldSearchRecords\(/, '必须过「≥2 字」门槛')
  assert.match(src, /buildRecordCommands\(/, '记录命令必须走纯逻辑层派生')
  assert.match(src, /applyRecentOrder\(/, '最近使用排序必须走纯逻辑层')
  assert.match(src, /RECORD_SEARCH_DEBOUNCE_MS/, '必须有 debounce 常量（打字期间不打请求）')
  assert.match(src, /requestSeq/, '必须有请求序号，否则慢回包会覆盖新关键词的结果')
  assert.match(src, /seq === requestSeq\.current/, '写回前必须比对序号')
  assert.doesNotMatch(src, /addEventListener\('keydown'/, '面板不得自己挂全局监听')
  assert.doesNotMatch(src, /打开记录/, '文案模板只能来自 lib/palette.ts')
})

test('Layout：全局记录详情由壳层挂载（任意页面都能被面板打开记录）', () => {
  const src = stripComments(readSource('web/src/components/Layout.tsx'))
  assert.match(src, /import RecordDetail from '\.\/RecordDetail'/)
  assert.match(src, /record=\{detailRecord\}/)
  assert.match(src, /open=\{!!detailRecord\}/)
  assert.match(src, /onOpenRecord=\{openRecordDetail\}/, '详情内点关联记录必须继续复用同一个宿主')
  assert.match(src, /const modalOpen = createOpen \|\| paletteOpen \|\| shortcutHelpOpen/, '面板打开必须挂起全局快捷键')
})

test('壳层 store：记录详情开关是同步的，且可以被清空', () => {
  const store = useUiShellStore.getState()
  store.closeRecordDetail()
  assert.equal(useUiShellStore.getState().detailRecord, null)
  store.openRecordDetail({ id: 1, title: 'x' } as never)
  assert.equal(useUiShellStore.getState().detailRecord?.id, 1, '同一 tick 即可读到（无异步）')
  store.openRecordDetail(null)
  assert.equal(useUiShellStore.getState().detailRecord, null, '传 null 视为关闭')
})
