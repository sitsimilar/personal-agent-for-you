/**
 * 快捷键注册表（P1-14）—— **单一事实来源**。
 *
 * ## 为什么要抽注册表
 *
 * 快捷键最容易烂的地方不是实现，是**散了**：`Layout` 里一个 `Ctrl+K`、某个页面里一个
 * `/`、帮助文档里第三份手写的说明。三份东西各改各的，最后用户按出来的和文档写的不是一回事。
 * 所以这里只保留一份数据：组件、帮助浮层、`docs/SHORTCUTS.md` 全部从 `SHORTCUTS` 派生。
 *
 * ## 键盘契约（改之前先读）
 *
 * - `mod` = Windows / Linux 的 `Ctrl`、macOS 的 `⌘`（运行时按 `ctrlKey || metaKey` 判定）；
 * - 单字符键（`/`、`?`）**不再叠加 shift**：`?` 本身就是 `Shift+/` 打出来的字符，
 *   若把 shift 也算进组合，注册表里就得写 `shift+?`，与文档、与用户认知都脱节；
 * - 字母键被 shift 大写时（`Ctrl+Shift+N` 的 `key` 是 `N`）算作 `shift`，
 *   这样 `mod+n` 与 `mod+shift+n` 不会被当成同一条；
 * - 序列键写空格（`g t`）：先按 `G` 再按 `T`，超过 `SEQUENCE_TIMEOUT_MS` 作废。
 *
 * ## 作用域（scope）
 *
 * `scope` 决定「在哪里生效」，也是冲突检测的分组维度：
 * `app` = 整个应用，`palette` = 只在命令面板内。两个作用域里同键位**不算冲突**
 * （`Enter` 在列表里是「打开」、在面板里是「执行」，这是合理的）。
 *
 * 本文件是纯函数 + 常量：不碰 DOM、不读 store。事件到动作的映射在 `Layout.tsx`。
 */

/** 一条快捷键的作用域。 */
export type ShortcutScope = 'app' | 'palette'

/** 快捷键分组（帮助浮层与文档按此分节，顺序即数组顺序）。 */
export type ShortcutGroup = '记录' | '导航' | '通用'

/** 需要的能力位（不存在时整条不注册，避免「按了没反应」）。 */
export type ShortcutRequirement = 'commandPalette'

export interface ShortcutSpec {
  /** 唯一标识，也是动作分发键（`Layout.tsx` 按它 switch）。 */
  id: string
  /** 匹配用组合（小写、`mod` 归一的规范形式）。 */
  combo: string
  /** 展示用按键（给帮助浮层与文档，允许 `⌘`、`→` 这类排版符号）。 */
  keys: string
  /** 一句话说明这个键做什么。 */
  label: string
  group: ShortcutGroup
  scope: ShortcutScope
  /** 在输入框 / 可编辑区域里是否仍然生效（默认 false —— 打字优先）。 */
  allowInEditable?: boolean
  /** 依赖的能力位；缺失时 `disabledIds` 里会带上它。 */
  requires?: ShortcutRequirement
  /** 导航类快捷键的目标路由（帮助文档里显示，组件里直接用）。 */
  path?: string
}

/** 序列键的等待上限（毫秒）。超过就作废，避免「按过 G 很久以后再按 T 还跳页」。 */
export const SEQUENCE_TIMEOUT_MS = 1200

/** 检索框的 DOM id：`/` 快捷键靠它聚焦（`SearchBar` 从 Layout 拿到这个值）。 */
export const SEARCH_INPUT_ID = 'global-search'

/** 文档路径（生成脚本与一致性测试共用，不许两处各写一遍）。 */
export const SHORTCUTS_DOC_PATH = 'docs/SHORTCUTS.md'

/**
 * 注册表本体。
 *
 * 只放**已经能用**的键：注册表里出现一条按了没反应的快捷键，比没有这条更糟。
 */
export const SHORTCUTS: readonly ShortcutSpec[] = [
  {
    id: 'create-record',
    combo: 'mod+n',
    keys: 'Ctrl / ⌘ + N',
    label: '新建记录（想法 / 资料 / 待办）',
    group: '记录',
    scope: 'app',
    allowInEditable: false,
  },
  {
    id: 'focus-search',
    combo: '/',
    keys: '/',
    label: '聚焦顶部检索框',
    group: '导航',
    scope: 'app',
    allowInEditable: false,
  },
  {
    id: 'goto-todo',
    combo: 'g t',
    keys: 'G → T',
    label: '跳转到待办',
    group: '导航',
    scope: 'app',
    path: '/todo',
  },
  {
    id: 'goto-records',
    combo: 'g r',
    keys: 'G → R',
    label: '跳转到记录（想法与资料）',
    group: '导航',
    scope: 'app',
    path: '/records',
  },
  {
    id: 'command-palette',
    combo: 'mod+k',
    keys: 'Ctrl / ⌘ + K',
    label: '打开命令面板（仅流畅方案）',
    group: '通用',
    scope: 'app',
    allowInEditable: true,
    requires: 'commandPalette',
  },
  {
    id: 'shortcut-help',
    combo: '?',
    keys: '?',
    label: '查看快捷键速查',
    group: '通用',
    scope: 'app',
    allowInEditable: false,
  },
] as const

/* ------------------------------ 组合规范化 ------------------------------ */

const MODIFIER_ALIASES: Record<string, 'mod' | 'alt' | 'shift'> = {
  ctrl: 'mod',
  control: 'mod',
  cmd: 'mod',
  command: 'mod',
  meta: 'mod',
  mod: 'mod',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  spacebar: 'space',
  ' ': 'space',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  return: 'enter',
}

/** 单段规范化：修饰符按 `mod` → `alt` → `shift` 固定顺序，便于比较与去重。 */
function normalizeSingle(part: string): string {
  const tokens = part.split('+').map((t) => t.trim().toLowerCase())
  const keyRaw = tokens.pop() ?? ''
  const mods = new Set<'mod' | 'alt' | 'shift'>()
  for (const token of tokens) {
    const mapped = MODIFIER_ALIASES[token]
    if (mapped) mods.add(mapped)
    else if (token) mods.add('mod') // 未知修饰符按 mod 处理：宁可判错也不静默丢失
  }
  const key = KEY_ALIASES[keyRaw] ?? keyRaw
  const ordered = (['mod', 'alt', 'shift'] as const).filter((m) => mods.has(m))
  return [...ordered, key].filter(Boolean).join('+')
}

/** 规范化任意组合（`Ctrl+K` → `mod+k`，`G→T` 之类展示符不要喂进来）。 */
export function normalizeCombo(raw: string): string {
  return String(raw ?? '')
    .trim()
    // 先吃掉 `Alt + N` / `Ctrl + K` 里加号两侧的空格，否则会被当成「序列键」拆成三段
    .replace(/\s*\+\s*/g, '+')
    .split(/\s+/)
    .filter(Boolean)
    .map(normalizeSingle)
    .join(' ')
}

/** 键盘事件的最小形状（`KeyboardEvent` 结构子集，便于在 Node 里构造）。 */
export interface KeyboardInput {
  key: string
  ctrlKey?: boolean
  metaKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

/**
 * 事件 → 规范组合。
 *
 * 单字符键的 shift 已体现在 `key` 里（`?`、`/`），不再重复叠加；
 * 字母被 shift 大写时补回 `shift`，避免 `mod+shift+n` 被误判成 `mod+n`。
 */
export function comboFromEvent(input: KeyboardInput): string {
  const key = typeof input.key === 'string' ? input.key : ''
  if (!key) return ''
  const mods: string[] = []
  if (input.ctrlKey || input.metaKey) mods.push('mod')
  if (input.altKey) mods.push('alt')
  const isPrintable = key.length === 1
  const isShiftedLetter = isPrintable && key === key.toUpperCase() && key !== key.toLowerCase()
  if (input.shiftKey && (!isPrintable || isShiftedLetter)) mods.push('shift')
  const normalizedKey = isPrintable ? key.toLowerCase() : (KEY_ALIASES[key.toLowerCase()] ?? key.toLowerCase())
  return [...mods, normalizedKey].join('+')
}

/* ------------------------------ 可编辑目标判定 ------------------------------ */

/** 这些 `<input type>` 不是「打字」，快捷键应当照常生效。 */
const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

const EDITABLE_ROLES = new Set(['textbox', 'searchbox', 'combobox'])

/**
 * 事件目标是否处于「正在打字」的位置。
 *
 * 不做 `target instanceof HTMLElement`：Node 里没有 HTMLElement，而且测试要能注入
 * 朴素对象。用结构判定（tagName / isContentEditable / role）足够覆盖真实场景。
 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const el = target as {
    tagName?: string
    type?: string
    isContentEditable?: boolean
    getAttribute?: (name: string) => string | null
  }
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = typeof el.type === 'string' && el.type ? el.type.toLowerCase() : 'text'
    return !NON_TEXT_INPUT_TYPES.has(type)
  }
  if (el.isContentEditable === true) return true
  const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null
  return typeof role === 'string' && EDITABLE_ROLES.has(role.toLowerCase())
}

/* ------------------------------ 序列键状态机 ------------------------------ */

/** 序列前缀状态（`G` 已按下、等待第二个键）。 */
export interface SequenceState {
  prefix: string | null
  at: number
}

export function createSequenceState(): SequenceState {
  return { prefix: null, at: 0 }
}

/* ------------------------------ 事件 → 决议 ------------------------------ */

export type ShortcutResolution =
  | { type: 'run'; shortcut: ShortcutSpec }
  | { type: 'pending'; prefix: string }
  | { type: 'ignored'; reason: 'editable' | 'suspended' | 'no-match' }

export interface ResolveOptions {
  /** 序列状态（调用方持有，跨事件复用）。不传则不处理序列键。 */
  state?: SequenceState
  /** 当前时间戳（毫秒），默认 `Date.now()`。 */
  now?: number
  /** 事件目标是否可编辑（用 `isEditableTarget(event.target)` 算好传进来）。 */
  editable?: boolean
  /** 被禁用的 id（如能力位缺失、对话框打开时只留有限几条）。 */
  disabledIds?: readonly string[]
  /** 整轮挂起（例如快速记录对话框打开）：任何键都不动。 */
  suspended?: boolean
  /** 生效作用域，默认 `app`。 */
  scope?: ShortcutScope
  /** 自定义注册表（默认 `SHORTCUTS`，测试用）。 */
  shortcuts?: readonly ShortcutSpec[]
}

/** 注册表里所有序列前缀（`g t` → `g`）。 */
export function sequencePrefixes(list: readonly ShortcutSpec[] = SHORTCUTS): string[] {
  const set = new Set<string>()
  for (const spec of list) {
    const parts = spec.combo.split(' ')
    if (parts.length > 1) set.add(parts[0])
  }
  return [...set]
}

/**
 * 把一个键盘事件解析成决议。**纯函数**（除了读 `options.now`），不碰 DOM。
 *
 * 优先级：序列第二键 → 单键；命中序列前缀则进入 pending。
 */
export function resolveShortcut(input: KeyboardInput, options: ResolveOptions = {}): ShortcutResolution {
  if (options.suspended) return { type: 'ignored', reason: 'suspended' }

  const scope = options.scope ?? 'app'
  const list = (options.shortcuts ?? SHORTCUTS).filter((s) => s.scope === scope)
  const disabled = new Set(options.disabledIds ?? [])
  const combo = comboFromEvent(input)
  if (!combo) return { type: 'ignored', reason: 'no-match' }

  const editable = Boolean(options.editable)
  const now = typeof options.now === 'number' ? options.now : Date.now()
  const state = options.state
  const prefixes = sequencePrefixes(list)

  const gate = (spec: ShortcutSpec): ShortcutResolution => {
    if (disabled.has(spec.id)) return { type: 'ignored', reason: 'no-match' }
    if (editable && !spec.allowInEditable) return { type: 'ignored', reason: 'editable' }
    return { type: 'run', shortcut: spec }
  }

  // 1) 序列第二键：只在窗口内、且前缀与当前键不相等时尝试（`g g` 不该跳页）
  if (state?.prefix && now - state.at <= SEQUENCE_TIMEOUT_MS) {
    const seq = `${state.prefix} ${combo}`
    const hit = list.find((s) => s.combo === seq)
    state.prefix = null
    state.at = 0
    if (hit) return gate(hit)
  } else if (state) {
    state.prefix = null
    state.at = 0
  }

  // 2) 单键
  const single = list.find((s) => !s.combo.includes(' ') && s.combo === combo)
  if (single) return gate(single)

  // 3) 序列前缀：只有非输入框里才吃这个键，否则打字「g」就跳页了
  if (prefixes.includes(combo)) {
    if (editable) return { type: 'ignored', reason: 'editable' }
    if (state) {
      state.prefix = combo
      state.at = now
      return { type: 'pending', prefix: combo }
    }
  }

  return { type: 'ignored', reason: 'no-match' }
}

/* ------------------------------ 冲突检测 ------------------------------ */

export interface ShortcutConflict {
  kind: 'duplicate-id' | 'duplicate-combo'
  /** 冲突涉及的 id（duplicate-combo 至少 2 个）。 */
  ids: string[]
  scope?: ShortcutScope
  combo?: string
}

/**
 * 注册表自检：同一个 id 出现两次，或同一作用域里同键位绑了两个动作。
 *
 * 这是 11-03 增补的「冲突检测」——注册表一长大就必然有人复制粘贴忘改键位，
 * 冲突的后果是「按一次触发两个动作」，且只在特定页面才看得见，很难复现。
 */
export function detectShortcutConflicts(list: readonly ShortcutSpec[] = SHORTCUTS): ShortcutConflict[] {
  const conflicts: ShortcutConflict[] = []

  const byId = new Map<string, string[]>()
  for (const spec of list) {
    const ids = byId.get(spec.id) ?? []
    ids.push(spec.id)
    byId.set(spec.id, ids)
  }
  for (const [id, ids] of byId) {
    if (ids.length > 1) conflicts.push({ kind: 'duplicate-id', ids: [id] })
  }

  const byCombo = new Map<string, ShortcutSpec[]>()
  for (const spec of list) {
    const key = `${spec.scope}::${normalizeCombo(spec.combo)}`
    const bucket = byCombo.get(key) ?? []
    bucket.push(spec)
    byCombo.set(key, bucket)
  }
  for (const bucket of byCombo.values()) {
    if (bucket.length > 1) {
      conflicts.push({
        kind: 'duplicate-combo',
        ids: bucket.map((s) => s.id),
        scope: bucket[0].scope,
        combo: normalizeCombo(bucket[0].combo),
      })
    }
  }

  return conflicts
}

/** 能力位 → 需要禁用的 id 列表（`Layout` 与文档共用口径）。 */
export function disabledShortcutIds(
  capabilities: Partial<Record<ShortcutRequirement, boolean>> = {},
  list: readonly ShortcutSpec[] = SHORTCUTS,
): string[] {
  return list.filter((s) => s.requires && !capabilities[s.requires]).map((s) => s.id)
}

/* ------------------------------ 文档渲染 ------------------------------ */

const SCOPE_LABEL: Record<ShortcutScope, string> = {
  app: '全局',
  palette: '仅命令面板',
}

const GROUP_ORDER: readonly ShortcutGroup[] = ['记录', '导航', '通用']

/** 把一个组合翻译成人能读的写法（文档里不出现 `mod+n`）。 */
export function formatCombo(combo: string): string {
  return normalizeCombo(combo)
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((token) => {
          if (token === 'mod') return 'Ctrl / ⌘'
          if (token === 'alt') return 'Alt'
          if (token === 'shift') return 'Shift'
          if (token === 'escape') return 'Esc'
          // 单字符键：字母要显示成大写（`mod+k` → `K`），符号原样（`/`、`?`）
          if (token.length === 1) return token.toUpperCase()
          return token.charAt(0).toUpperCase() + token.slice(1)
        })
        .join(' + '),
    )
    .join(' → ')
}

/**
 * 生成 `docs/SHORTCUTS.md` 的正文。
 *
 * 文档由脚本（`npm run shortcuts:doc`）写入文件，测试用同一函数比对 —— 
 * 这样「文档与注册表不一致」在 CI 里就会红，而不是等用户发现。
 */
export function renderShortcutsMarkdown(list: readonly ShortcutSpec[] = SHORTCUTS): string {
  const lines: string[] = []
  lines.push('# 快捷键速查')
  lines.push('')
  lines.push('> **本文件由 `web/src/lib/shortcuts.ts` 自动生成，请勿手改。**')
  lines.push('> 重新生成：`npm run shortcuts:doc`；一致性校验：`npm run shortcuts:check`（`qa/shortcuts.test.ts` 也会比对）。')
  lines.push('> `Ctrl / ⌘` 在 macOS 上为 `⌘`（运行时按 `ctrlKey || metaKey` 判定）。')
  lines.push('')
  lines.push(`共 ${list.length} 条；序列键（如 \`G → T\`）需在前一键后 ${SEQUENCE_TIMEOUT_MS}ms 内按第二个键。`)
  lines.push('')

  for (const group of GROUP_ORDER) {
    const rows = list.filter((s) => s.group === group)
    if (rows.length === 0) continue
    lines.push(`## ${group}`)
    lines.push('')
    lines.push('| 按键 | 动作 | 生效范围 | 输入框内可用 | 目标 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const spec of rows) {
      lines.push(
        `| \`${spec.keys}\` | ${spec.label} | ${SCOPE_LABEL[spec.scope]} | ${
          spec.allowInEditable ? '是' : '否'
        } | ${spec.path ? `\`${spec.path}\`` : '—'} |`,
      )
    }
    lines.push('')
  }

  const orphan = list.filter((s) => !GROUP_ORDER.includes(s.group))
  if (orphan.length > 0) {
    lines.push('## 未分组')
    lines.push('')
    for (const spec of orphan) lines.push(`- \`${spec.keys}\` — ${spec.label}`)
    lines.push('')
  }

  lines.push('## 约定')
  lines.push('')
  lines.push('- 输入框、文本域、可编辑区域内只保留 `Ctrl / ⌘ + K`：打字优先，其余快捷键让位。')
  lines.push('- 任一对话框打开时，全局快捷键整体挂起，只保留命令面板的开关。')
  lines.push('- 快捷键只在登录后的壳层内注册；登录页不响应。')
  lines.push('')

  return lines.join('\n')
}
