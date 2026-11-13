/**
 * 命令面板的「最近使用」持久化（P1-12 增补 · 11-02）。
 *
 * 抽成独立文件的原因与 `lib/greeting.ts` 一致：`localStorage` 在 Node 测里不存在，
 * 隐私模式下 `setItem` 还会抛 `QuotaExceededError`。把存储对象**注入**进来，
 * 纯函数就能在单测里精确构造「读不出来」「写不进去」两种边界。
 *
 * 存的是**命令 id**（`nav:/todo` / `rec:42`），不是 label：改文案不该丢历史。
 * `rec:<id>` 这类带记录主键的 id 也会进历史，记录被删后只是再也不会被命中，
 * 不做额外清理（清理需要一次网络请求，面板打开路径必须保持同步）。
 */

/** 存储键（前缀 `pa.` 与本项目其它本地键一致）。 */
export const PALETTE_RECENT_KEY = 'pa.palette.recent'

/** 最多记 5 条：再多对排序已无意义，还会把默认视图挤变形。 */
export const PALETTE_RECENT_MAX = 5

/** 只需要 `getItem` / `setItem` 两个方法（`window.localStorage` 的结构子集）。 */
export interface RecentStorageLike {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

function safeGet(storage: RecentStorageLike | null | undefined, key: string): string | null {
  if (!storage) return null
  try {
    return storage.getItem(key)
  } catch {
    return null
  }
}

/**
 * 读历史 id 列表（最近的在前）。
 *
 * 脏数据一律当空：非数组、非字符串项、重复项都过滤掉 —— 面板不能因为一条坏历史
 * 就整块打不开。
 */
export function readRecentIds(storage?: RecentStorageLike | null): string[] {
  const raw = safeGet(storage, PALETTE_RECENT_KEY)
  if (!raw) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of parsed) {
    if (typeof item !== 'string' || !item || seen.has(item)) continue
    seen.add(item)
    out.push(item)
    if (out.length >= PALETTE_RECENT_MAX) break
  }
  return out
}

/**
 * 记一次使用，返回新列表（`id` 置顶、去重、截断到 5 条）。
 *
 * 存储写失败时**仍然返回新列表**：用户这次的使用顺序在内存里是对的，
 * 只是下次打开记不住 —— 不能因为写不进 localStorage 就让面板行为变形。
 */
export function rememberRecentId(
  storage: RecentStorageLike | null | undefined,
  id: string,
  current?: readonly string[] | null,
): string[] {
  if (typeof id !== 'string' || !id) return Array.isArray(current) ? [...current] : []
  const base = Array.isArray(current) ? current : readRecentIds(storage)
  const next = [id, ...base.filter((item) => item !== id)].slice(0, PALETTE_RECENT_MAX)
  if (storage) {
    try {
      storage.setItem(PALETTE_RECENT_KEY, JSON.stringify(next))
    } catch {
      // 隐私模式 / 配额满：静默降级为「本次会话内有效」
    }
  }
  return next
}
