/**
 * 启动问候语（P0-5）· 纯函数 + 一处可降级的持久化。
 *
 * ## 为什么要有这东西
 *
 * 启动屏原来写死「正在加载…」——一句对所有人都一样、对今天第 5 次刷新也一样的话。
 * 换个按时段变化的问候语，成本几乎为零（本地常量，不发请求），但能让「打开软件」
 * 这个动作不像在等一个机器。
 *
 * ## 三条硬约束（验收线）
 *
 * 1. **断网也要有文案**：文案池是编译进包的常量，不依赖任何网络请求；
 *    启动屏本身在登录前就要显示，网络此时未必可用。
 * 2. **连续刷新不重复**：上一条文案会记在 `localStorage`，下一次挑选时排除它。
 *    只排除「上一条」而不是随机历史，是为了让池子在 2 条时也能持续轮换。
 * 3. **空池回落默认文案**：池子被清空 / 全部被排除 / 存储不可用时，一律回落到
 *    `DEFAULT_GREETING_TEXT`（就是原来那句「正在加载…」）——功能不能因为装饰而失败。
 *
 * ## 纯函数边界
 *
 * 时段判定与挑选逻辑不读 `Date`、不读 `window`、不读 `localStorage`（都从参数注入），
 * 这样 QA 在 Node 里可以精确构造边界；副作用只有 `readLastGreeting` / `rememberGreeting`
 * 两个显式函数，且都包了 try/catch（隐私模式下 localStorage 会抛）。
 */

/** 时段（按时段给不同的话，而不是随机抽一句放在错误的时刻）。 */
export type GreetingSlot = 'night' | 'dawn' | 'morning' | 'noon' | 'afternoon' | 'evening'

/** 兜底文案：与改造前的固定文案保持一致，池子出问题时用户无感。 */
export const DEFAULT_GREETING_TEXT = '正在加载…'

/** 上一条文案的存储键（按浏览器隔离，不上云）。 */
export const GREETING_STORAGE_KEY = 'pa.boot.greeting'

/** 池子类型：允许调用方传入自定义池（测试与将来做「自定义问候语」都靠它）。 */
export type GreetingPool = Readonly<Record<GreetingSlot, readonly string[]>>

/**
 * 文案池。每条都短（启动屏一行放得下），且都在**暗示一个动作**而不是空寒暄 ——
 * 启动屏是用户进入软件的第一屏，说「记一句」比说「祝你愉快」更有用。
 */
export const GREETING_POOL: GreetingPool = {
  // 05:00–08:00
  dawn: [
    '天刚亮，先想想今天最要紧的一件事',
    '清早的念头最容易溜走，记一句吧',
    '早上的脑子适合排顺序，不适合堆事情',
    '新的一天，从一条待办开始',
  ],
  // 08:00–11:00
  morning: [
    '上午好，先过一遍今天的待办',
    '上午的注意力最贵，挑一件要紧的做',
    '想法来了就记，别等它跑掉',
    '把攒着的资料归归类，下午会轻松很多',
  ],
  // 11:00–13:00
  noon: [
    '中午了，上午的念头都记下来了吗',
    '饭后十分钟，正好过一遍清单',
    '午间适合收尾，不适合开新战场',
    '先歇一会儿，事情不会跑',
  ],
  // 13:00–18:00
  afternoon: [
    '下午好，还差几条待办',
    '下午容易被打断，先记下来再处理',
    '一件一件来，不急',
    '把今天记下的东西理一理',
  ],
  // 18:00–23:00
  evening: [
    '晚上好，今天想做的事做完了吗',
    '夜里适合回顾，不适合开工',
    '把明天的第一件事写下来，明早省力',
    '今天记下的东西，明天会感谢你',
  ],
  // 23:00–05:00
  night: [
    '夜深了，明早再看也来得及',
    '这么晚还在，先记一句就去睡',
    '睡前留一条待办，明天不容易忘',
    '别熬太晚，记录的事留给明天',
  ],
}

/** 池子里的一条文案 + 它属于哪个时段 + 是否走了兜底。 */
export interface GreetingPick {
  text: string
  slot: GreetingSlot
  /** true = 命中了 `DEFAULT_GREETING_TEXT`（空池 / 全被排除 / 非法随机数之外的兜底路径）。 */
  fallback: boolean
}

/** 只看时分 → 时段。边界取「左闭右开」，非法小时数按 `night` 处理（安静的兜底）。 */
export function resolveGreetingSlot(hour: number): GreetingSlot {
  if (!Number.isFinite(hour)) return 'night'
  const h = Math.floor(hour)
  if (h >= 5 && h < 8) return 'dawn'
  if (h >= 8 && h < 11) return 'morning'
  if (h >= 11 && h < 13) return 'noon'
  if (h >= 13 && h < 18) return 'afternoon'
  if (h >= 18 && h < 23) return 'evening'
  // 23–24 与 0–5（含负数/超界）都归「夜深」
  return 'night'
}

/** 取某时段的候选池（池子缺失时返回空数组，不抛）。 */
export function greetingCandidates(slot: GreetingSlot, pool: GreetingPool = GREETING_POOL): readonly string[] {
  const list = pool[slot]
  if (!Array.isArray(list)) return []
  return list.filter((t) => typeof t === 'string' && t.trim().length > 0)
}

/**
 * 从池子里挑一条。
 *
 * - `hour` 优先于 `now`；两者都没有时用当前时间；
 * - `previous` 会被排除（这就是「连续刷新不重复」）；
 * - `random` 注入以便测试（默认 `Math.random`）。
 */
export function pickGreeting(
  options: {
    hour?: number
    now?: Date | number
    previous?: string | null
    random?: () => number
    pool?: GreetingPool
  } = {},
): GreetingPick {
  const pool = options.pool ?? GREETING_POOL
  const hour = resolveHour(options)
  const slot = resolveGreetingSlot(hour)
  const previous = typeof options.previous === 'string' ? options.previous.trim() : ''

  // 同一条文案在池子里写两遍没有意义，去重后再挑，否则「排除上一条」会失真
  const all = Array.from(new Set(greetingCandidates(slot, pool)))
  const candidates = previous ? all.filter((t) => t !== previous) : all

  if (candidates.length === 0) {
    return { text: DEFAULT_GREETING_TEXT, slot, fallback: true }
  }

  const random = options.random ?? Math.random
  const r = random()
  // 随机数越界 / NaN 一律取第一条：宁可每次都一样，也不要 undefined
  const index = Number.isFinite(r) && r >= 0 && r < 1 ? Math.floor(r * candidates.length) : 0
  const text = candidates[Math.min(index, candidates.length - 1)]
  return { text, slot, fallback: false }
}

function resolveHour(options: { hour?: number; now?: Date | number }): number {
  if (typeof options.hour === 'number') return options.hour
  const now = options.now
  const date = now instanceof Date ? now : typeof now === 'number' ? new Date(now) : new Date()
  const hour = date.getHours()
  return Number.isFinite(hour) ? hour : 0
}

/* ------------------------------ 持久化（唯一副作用） ------------------------------ */

/** 只依赖 `getItem/setItem` 的最小存储接口，便于测试注入。 */
export type GreetingStorage = Pick<Storage, 'getItem' | 'setItem'>

/** 取默认存储；隐私模式 / SSR / 无 `window` 时返回 null（不是抛错）。 */
export function defaultGreetingStorage(): GreetingStorage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

/** 读上一条文案；存储不可用或值为空时返回 null。 */
export function readLastGreeting(storage: GreetingStorage | null = defaultGreetingStorage()): string | null {
  if (!storage) return null
  try {
    const value = storage.getItem(GREETING_STORAGE_KEY)
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

/** 记住这条文案（写失败不影响显示）。 */
export function rememberGreeting(
  text: string,
  storage: GreetingStorage | null = defaultGreetingStorage(),
): void {
  if (!storage || !text) return
  try {
    storage.setItem(GREETING_STORAGE_KEY, text)
  } catch {
    /* 隐私模式 / 配额满：忽略，下一轮可能重复一次，不影响可用性 */
  }
}

/**
 * 启动屏专用：读上一条 → 排除 → 挑一条 → 写回。
 *
 * 这是 `BootScreen` 唯一需要调用的函数；全部逻辑都走上面那些纯函数，
 * 因此「连续刷新 10 次不重复」可以在 Node 里用假存储逐次验证。
 */
export function nextBootGreeting(
  options: {
    hour?: number
    now?: Date | number
    random?: () => number
    pool?: GreetingPool
    storage?: GreetingStorage | null
  } = {},
): GreetingPick {
  const storage = options.storage === undefined ? defaultGreetingStorage() : options.storage
  const pick = pickGreeting({
    hour: options.hour,
    now: options.now,
    previous: readLastGreeting(storage),
    random: options.random,
    pool: options.pool,
  })
  // 兜底文案也写回：否则「池子空 → 默认 → 池子恢复」时容易与上一条真实文案撞车
  rememberGreeting(pick.text, storage)
  return pick
}
