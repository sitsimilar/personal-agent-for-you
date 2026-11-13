/**
 * 命令面板的纯逻辑层（P1-12 上半）。
 *
 * ## 为什么把逻辑从组件里抽出来
 *
 * 面板最容易烂的地方和快捷键一样：**列表是手写的**。`Layout` 里一份导航、
 * 面板里再抄一份「跳转到待办」，加一个菜单就漏一处，而且没有任何测试能发现
 * ——因为两份都「各自自洽」。
 *
 * 所以这里只做三件事，且全部是纯函数（不碰 DOM、不读 store、不 import React）：
 * 1. **从导航配置派生跳转命令**（`buildNavCommands`）——`NAV_GROUPS` 仍是唯一事实源；
 * 2. **过滤与分组**（`filterCommands` / `groupCommands`）——搜索语义只有一份；
 * 3. **键盘契约**（`moveActive` / `resolvePaletteKey`）——`↑ ↓ Enter Esc` 的行为可被断言。
 *
 * 11-13 补上两件（P1-12 下半）：
 * 4. **记录 provider**（`shouldSearchRecords` / `buildRecordCommands`）——检索结果来自
 *    `recordService.search()`，本文件只负责「什么算够长」与「长什么样」，不碰网络；
 * 5. **排序**（`scoreCommand` / `applyRecentOrder`）——前缀 > 词边界 > 词中 > 英文子序列。
 *
 * 组件（`CommandPalette.tsx`）只剩「状态 + 渲染 + 把命令跑起来」。
 */
import { pinyinKeyword } from './pinyin'

/** 面板里的分组（顺序即渲染顺序，不随搜索命中顺序抖动）。 */
export type PaletteGroup = '动作' | '界面方案' | '跳转' | '记录'

/**
 * 分组渲染顺序：先做动作，再换外观，最后才是跳页与检索结果。
 *
 * 「记录」排最后是刻意的：它是**异步 provider**（要等云端返回），
 * 若排在前面，命中记录时列表会在结果到达的瞬间整体下移，把用户正在看的那条挤走。
 */
export const PALETTE_GROUP_ORDER: readonly PaletteGroup[] = ['动作', '界面方案', '跳转', '记录']

/**
 * 默认高亮位置。
 *
 * `-1` = 不高亮。这是刻意的：面板最高频的误操作是「想搜索，按了 Enter，结果跳走了」，
 * 无高亮 + 空输入时 Enter 无效可以彻底避免这一类。
 */
export const PALETTE_INITIAL_ACTIVE = -1

/** 能进入面板的最小导航项形状（`lib/nav.tsx` 的 `NavItem` 结构子集，测试可传朴素对象）。 */
export interface PaletteNavItem {
  label: string
  path: string
  hint?: string
}

export interface PaletteCommand<T = unknown> {
  /** 唯一标识（`nav:<path>` / `act:<name>`），也是「最近使用」排序未来的键。 */
  id: string
  /** 面板上显示的主文本。 */
  label: string
  /** 右侧补充说明。 */
  hint?: string
  group: PaletteGroup
  /** 检索时额外命中的词（别名 / 拼音首字母等）。 */
  keywords?: string
  /**
   * 已经由 provider（服务端）筛过，本地过滤**无条件放行**。
   *
   * 记录检索的命中判定在云端（`title/content/tags` 的 ilike + tsvector），
   * 本地只拿到「命中的那几条」。若本地再按关键词过滤一遍，标题里没有这个词的记录
   * （靠正文命中的）会被二次筛掉 —— 用户会看到「明明有却搜不到」。
   */
  alwaysShow?: boolean
  /** 导航目标（只有跳转类命令才有）。 */
  path?: string
  /** 原始条目（组件据此取图标，纯逻辑层不关心它是什么）。 */
  source?: T
}

/* ------------------------------ 跳转命令派生 ------------------------------ */

/**
 * 跳转命令的显示文案。
 *
 * 必须是「跳转到「待办」」而不是裸「待办」：面板里同时有动作（快速记录、切换方案）
 * 与位置（页面），动作与位置长得一样时，用户按 Enter 前无法判断会发生什么。
 */
export function navCommandLabel(item: PaletteNavItem): string {
  const label = typeof item?.label === 'string' ? item.label.trim() : ''
  return label ? `跳转到「${label}」` : '跳转到未命名页面'
}

/**
 * 把导航项拍平成跳转命令。
 *
 * `id` 用 `nav:<path>` 而不是 `nav:<label>`：label 会改字，path 是稳定契约，
 * 「最近使用」「权重」这类后续能力要靠 id 做持久化键（改字就丢历史）。
 */
export function buildNavCommands<T extends PaletteNavItem>(
  items: readonly T[] | null | undefined,
): PaletteCommand<T>[] {
  if (!Array.isArray(items)) return []
  const seen = new Set<string>()
  const out: PaletteCommand<T>[] = []
  for (const item of items) {
    const path = typeof item?.path === 'string' ? item.path.trim() : ''
    if (!path || seen.has(path)) continue // 同一路由不出现两次：否则「跳转到 X」会有两条一模一样
    seen.add(path)
    out.push({
      id: `nav:${path}`,
      label: navCommandLabel(item),
      hint: item.hint,
      group: '跳转',
      /**
       * 别名 = 裸页面名 + 拼音首字母（`待办` → `db`）。
       * 中文输入法用户在面板里更习惯敲字母，没有这一项时 `db` 一条都命中不了。
       * 首字母表覆盖不足时 `pinyinKeyword` 返回 undefined，退化成只有裸名 —— 不做假命中。
       */
      keywords: [typeof item.label === 'string' ? item.label : '', pinyinKeyword(item.label)]
        .filter(Boolean)
        .join(' '),
      path,
      source: item,
    })
  }
  return out
}

/* -------------------------------- 过滤 -------------------------------- */

/* -------------------------------- 检索匹配 -------------------------------- */

/** 检索文本：主文本 + 说明 + 分组 + 别名（`keywords` 让「待办」「db」也能命中）。 */
function searchableText(cmd: PaletteCommand): string {
  return [cmd.label, cmd.hint, cmd.group, cmd.keywords].filter(Boolean).join(' ').toLowerCase()
}

/**
 * 命中层级（分数越高排越前）。
 *
 * 三层来自 11-10 的增补（前缀 / 词边界 / 词中），第四层是 11-07 的英文子序列兜底。
 * 这几个数字是**排序权重**，不是「匹配强度」的物理量，改它们只影响同组内的顺序。
 */
export const PALETTE_SCORE_PREFIX = 4
export const PALETTE_SCORE_BOUNDARY = 3
export const PALETTE_SCORE_SUBSTRING = 2
export const PALETTE_SCORE_FUZZY = 1

/** 词边界字符：文案里的分隔符（空白、斜杠、括号、书名号等）。 */
const BOUNDARY_PATTERN = /[\s/、，,·|「」（）()《》\-_>]/

/** 词的第一个字符是否落在「词边界之后」（`records` 里的 `cor` 算，`scores` 里的不算）。 */
function hitsBoundary(text: string, term: string): boolean {
  let from = 0
  while (from <= text.length - term.length) {
    const at = text.indexOf(term, from)
    if (at < 0) return false
    if (at === 0 || BOUNDARY_PATTERN.test(text[at - 1])) return true
    from = at + 1
  }
  return false
}

/** 纯 ASCII 词（含至少一个字母）才走子序列兜底：中文没有「跳字母」的直觉。 */
function isAsciiWord(term: string): boolean {
  return /^[a-z0-9]+$/.test(term) && /[a-z]/.test(term)
}

/** 子序列匹配（`stng` 命中 `settings`）。只借 uFuzzy 的语义，不引依赖。 */
function isSubsequence(text: string, term: string): boolean {
  let cursor = 0
  for (const char of term) {
    const at = text.indexOf(char, cursor)
    if (at < 0) return false
    cursor = at + 1
  }
  return true
}

/**
 * 单个词的命中层级；`0` 表示未命中。
 *
 * 顺序不能换：先判命中（`includes`），再分级；子序列只在**完全没命中**时才试，
 * 否则「设置」会被 `st` 之类的子序列噪音抢到前排。
 */
export function scoreCommandTerm(cmd: PaletteCommand, term: string): number {
  if (!term) return 0
  const label = String(cmd.label ?? '').toLowerCase()
  const text = searchableText(cmd)
  if (text.includes(term)) {
    if (label.startsWith(term)) return PALETTE_SCORE_PREFIX
    if (hitsBoundary(label, term) || hitsBoundary(text, term)) return PALETTE_SCORE_BOUNDARY
    return PALETTE_SCORE_SUBSTRING
  }
  if (isAsciiWord(term) && isSubsequence(text, term)) return PALETTE_SCORE_FUZZY
  return 0
}

/** 关键词切分（空白分隔，最多 5 段，避免一长串输入退化成 O(n) 全表扫描）。 */
export function splitPaletteTerms(keyword: string): string[] {
  return String(keyword ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 5)
}

/**
 * 过滤命令：**多词取交集**（`跳转 待办` 与 `待办 跳转` 结果相同）。
 *
 * 空关键词返回原列表（保持传入顺序，组件据此渲染「默认视图」）。
 * 有关键词时按命中层级**稳定降序**排列：同分保持传入顺序，
 * 这样「跳转」「待办」这类等价命中不会在每次输入时可视抖动。
 * `alwaysShow` 的条目（服务端已筛过的记录）无条件保留。
 */
export function filterCommands<T extends PaletteCommand>(
  commands: readonly T[],
  keyword: string,
): T[] {
  const list = Array.isArray(commands) ? commands : []
  const terms = splitPaletteTerms(keyword)
  if (terms.length === 0) return [...list]
  const scored: Array<{ cmd: T; score: number; index: number }> = []
  list.forEach((cmd, index) => {
    let total = 0
    for (const term of terms) {
      const score = scoreCommandTerm(cmd, term)
      if (score <= 0) {
        if (cmd.alwaysShow) continue // 服务端命中：本地不参与打分
        return
      }
      total += score
    }
    scored.push({ cmd, score: total, index })
  })
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index))
  return scored.map((it) => it.cmd)
}

/* ------------------------------ 记录 provider ------------------------------ */

/** 少于 2 个字不查云端：单字会命中整个库，面板每次输入都打一发请求没有意义。 */
export const PALETTE_RECORD_MIN_QUERY = 2

/** 面板里最多列几条记录（再多就该去检索页了，面板只负责「快速打开刚才想到的那条」）。 */
export const PALETTE_RECORD_LIMIT = 5

/** 记录命令生成所需的最小形状（测试可传朴素对象，不必造 `InfoRecord`）。 */
export interface PaletteRecordLike {
  id: number | string
  title?: string | null
  /** 线上模型的字段是 `createdAt`（`mapRecord` 做的驼峰化），**不是** `created_at`。 */
  createdAt?: string | null
  created_at?: string | null
}

/**
 * 是否该发起记录检索。
 *
 * 按**码点**计数（`[...str]`），不是 `str.length`：emoji / 生僻字占 2 个 UTF-16 单元，
 * 用 `length` 会把「1 个字符」误判成「2 个字」而提前发请求。
 */
export function shouldSearchRecords(keyword: string): boolean {
  if (typeof keyword !== 'string') return false
  const chars = [...keyword.trim()]
  return chars.length >= PALETTE_RECORD_MIN_QUERY
}

/** 记录命令的显示文案（模板只在这里出现，组件不得自己拼）。 */
export function recordCommandLabel(record: PaletteRecordLike): string {
  const title = typeof record?.title === 'string' ? record.title.trim() : ''
  return `打开记录：《${title || '未命名记录'}》`
}

/** `createdAt` / `created_at` → `YYYY-MM-DD`（纯字符串截取，不引入时区差异）。 */
function recordDateHint(record: PaletteRecordLike): string | undefined {
  const iso =
    (typeof record?.createdAt === 'string' && record.createdAt) ||
    (typeof record?.created_at === 'string' && record.created_at) ||
    ''
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : undefined
}

/**
 * 把云端检索结果拍成记录命令。
 *
 * `alwaysShow: true`：命中判定已由服务端做过，本地不再按关键词筛一遍
 * （正文命中的记录标题里往往没有关键词，二次过滤会让它凭空消失）。
 */
export function buildRecordCommands<T extends PaletteRecordLike>(
  records: readonly T[] | null | undefined,
  limit: number = PALETTE_RECORD_LIMIT,
): PaletteCommand<T>[] {
  if (!Array.isArray(records)) return []
  const max = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : PALETTE_RECORD_LIMIT
  const seen = new Set<string>()
  const out: PaletteCommand<T>[] = []
  for (const record of records) {
    if (out.length >= max) break
    const id = record?.id
    if (id === null || id === undefined || id === '') continue
    const key = String(id)
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      id: `rec:${key}`,
      label: recordCommandLabel(record),
      hint: recordDateHint(record),
      group: '记录',
      alwaysShow: true,
      source: record,
    })
  }
  return out
}

/* ------------------------------ 最近使用排序 ------------------------------ */

/**
 * 按「最近使用」重排（`recentIds[0]` 是最近用过的那条）。
 *
 * 只在**同一组内**影响顺序（组件随后按 `PALETTE_GROUP_ORDER` 分组），
 * 未用过的命令保持原顺序 —— 不能因为「有历史」就把默认视图整个打乱。
 */
export function applyRecentOrder<T extends PaletteCommand>(
  commands: readonly T[],
  recentIds: readonly string[] | null | undefined,
): T[] {
  const list = Array.isArray(commands) ? commands : []
  const ids = Array.isArray(recentIds) ? recentIds.filter((id) => typeof id === 'string') : []
  if (ids.length === 0) return [...list]
  const weight = new Map<string, number>()
  ids.forEach((id, index) => {
    if (!weight.has(id)) weight.set(id, index)
  })
  return list
    .map((cmd, index) => ({ cmd, index, recent: weight.get(cmd.id) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => {
      if (a.recent !== b.recent) return a.recent - b.recent
      return a.index - b.index
    })
    .map((it) => it.cmd)
}

/* -------------------------------- 分组 -------------------------------- */

export interface PaletteGroupBucket<T extends PaletteCommand> {
  name: PaletteGroup
  items: Array<{ cmd: T; index: number }>
}

/**
 * 按固定顺序分组。
 *
 * `index` 是**在原始过滤结果里的下标**，不是组内下标 —— 键盘高亮在扁平序列上移动，
 * 渲染却按组分块，两者靠这个下标对齐（错一位就会出现「高亮在 A 组、Enter 跑了 B」）。
 */
export function groupCommands<T extends PaletteCommand>(
  commands: readonly T[],
  order: readonly PaletteGroup[] = PALETTE_GROUP_ORDER,
): PaletteGroupBucket<T>[] {
  const list = Array.isArray(commands) ? commands : []
  const map = new Map<PaletteGroup, Array<{ cmd: T; index: number }>>()
  list.forEach((cmd, index) => {
    const bucket = map.get(cmd.group) ?? []
    bucket.push({ cmd, index })
    map.set(cmd.group, bucket)
  })
  const known = order.filter((g) => map.has(g)).map((g) => ({ name: g, items: map.get(g) ?? [] }))
  // 未知分组兜底排在最后：组名写错时命令不应该凭空消失
  const extra = [...map.keys()]
    .filter((g) => !order.includes(g))
    .map((g) => ({ name: g, items: map.get(g) ?? [] }))
  return [...known, ...extra]
}

/* -------------------------------- 键盘契约 -------------------------------- */

/**
 * 移动高亮（循环）。
 *
 * 两个边界必须钉住：
 * - 从「无高亮」(`-1`) 往**下**走落在第 1 条，往**上**走落在最后一条（符合列表直觉）；
 * - 越界回绕（最后一条再往下是第 1 条）。
 */
export function moveActive(active: number, length: number, delta: number): number {
  if (!Number.isFinite(length) || length <= 0) return PALETTE_INITIAL_ACTIVE
  const size = Math.floor(length)
  const current = Number.isFinite(active) ? Math.trunc(active) : PALETTE_INITIAL_ACTIVE
  const step = Number.isFinite(delta) ? Math.trunc(delta) : 0
  if (step === 0) return current >= 0 && current < size ? current : PALETTE_INITIAL_ACTIVE
  if (current < 0 || current >= size) return step > 0 ? 0 : size - 1
  return ((current + step) % size + size) % size
}

export type PaletteKeyAction =
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'run' }
  | { type: 'close' }
  | { type: 'none' }

/**
 * 一个按键该做什么。
 *
 * 只认四个键：`↑ ↓ Enter Esc`。其余（含输入）交给浏览器 —— 面板**不复用**
 * `lib/shortcuts.ts` 的 `app` 作用域，避免「输入框里按 `G` 触发跳页」。
 */
export function resolvePaletteKey(key: string): PaletteKeyAction {
  const k = typeof key === 'string' ? key : ''
  if (k === 'ArrowDown') return { type: 'next' }
  if (k === 'ArrowUp') return { type: 'prev' }
  if (k === 'Enter') return { type: 'run' }
  if (k === 'Escape') return { type: 'close' }
  return { type: 'none' }
}
