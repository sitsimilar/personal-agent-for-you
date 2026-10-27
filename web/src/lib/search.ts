/**
 * 记录关键词检索纯函数（v2.13 R1）。
 *
 * 三个职责，彼此独立、可单测：
 * 1. 切词 `splitTerms`：按空白切分（`/\s+/u`），去空、去重、保持原序、最多 `MAX_TERMS` 个词；
 * 2. 过滤器构造 `buildKeywordOrFilter`：产出 PostgREST `or=(...)` 的内层内容。
 *    单关键词与 v2.12.2 **完全同形**（零回归：`title.ilike/content.ilike/tags.cs`）；
 *    多关键词用嵌套逻辑树表达「词间 AND / 字段间 OR」：
 *    `and(or(title.ilike.%周报%,content.ilike.%周报%),or(title.ilike.%模板%,content.ilike.%模板%))`。
 * 3. tsquery 构造 `buildTsQuery`：仅供 `search_tsv` 叠加路径使用。
 *    白名单 = 纯 ASCII 字母/数字、长度 ≥ 2、含至少 1 个字母（PG 默认 parser 把连续 CJK
 *    当作 **一个** 词元，中文走 tsvector 命中率接近 0，因此中文一律交给 ilike 路径）；
 *    **不变式：只有全部词都通过白名单时才返回 tsquery，任一词不通过即整体返回 null**。
 *
 * 约束：本文件无副作用、不读 `Date.now()`（时间无关）；不引入第三方依赖。
 * 语法前提（已实测）：托管 PostgREST 接受 `or('and(or(..),or(..))')` 嵌套逻辑树。
 */

/** 多词检索的最大词数（超出部分忽略，防止过滤器长度爆炸）。 */
export const MAX_TERMS = 5

/**
 * 按空白切词。
 *
 * @param keyword 用户原始输入
 * @returns 去空、去重、保持原序、最多 `MAX_TERMS` 个词的数组；空输入返回空数组
 */
export function splitTerms(keyword: string): string[] {
  if (typeof keyword !== 'string') return []
  const seen = new Set<string>()
  const terms: string[] = []
  for (const raw of keyword.trim().split(/\s+/u)) {
    const term = raw.trim()
    if (!term || seen.has(term)) continue
    seen.add(term)
    terms.push(term)
    if (terms.length >= MAX_TERMS) break
  }
  return terms
}

/**
 * 转义 ilike 通配符与 PostgREST 过滤器结构字符，防止用户输入破坏查询语法。
 *
 * 注意：tsvector 路径**不能**复用本函数（`websearch_to_tsquery` 有自己的一套语法），
 * 那条路径用 `buildTsQuery` 的白名单清洗。
 *
 * @param value 待转义的词
 * @returns 转义后的词（原词中 `% _ \ , ( ) "` 前加反斜杠）
 */
export function escapeLike(value: string): string {
  return value.replace(/[%_\\,()"]/g, '\\$&')
}

/**
 * 构造 tags 数组 contains 过滤片段（`tags.cs.{term}`）。
 *
 * @param term 关键词
 * @returns 片段；词为空或含数组字面量特殊字符（`{}",\`）时返回 null，表示跳过 tags 命中
 */
export function escapeTagTerm(term: string): string | null {
  if (!term || /[{}",\\]/.test(term)) return null
  return `tags.cs.{${term}}`
}

/** 单个词的「字段间 OR」组内容：标题命中 / 正文命中 / 标签命中。 */
function fieldOrGroup(term: string): string {
  const esc = escapeLike(term)
  const parts = [`title.ilike.%${esc}%`, `content.ilike.%${esc}%`]
  const tag = escapeTagTerm(term)
  if (tag) parts.push(tag)
  return parts.join(',')
}

/**
 * 构造关键词过滤器（`query.or()` 的入参）。
 *
 * - 空关键词 → `null`（调用方不加任何过滤）；
 * - 单关键词 → 与 v2.12.2 同形：`title.ilike.%t%,content.ilike.%t%[,tags.cs.{t}]`；
 * - 多关键词 → `and(or(..t1..),or(..t2..),…)`，每个词都必须命中某字段（AND 生效）。
 *
 * @param keyword 用户输入（可含空格）
 * @returns `or=(...)` 括号内的内容；无有效词时返回 null
 */
export function buildKeywordOrFilter(keyword: string): string | null {
  const terms = splitTerms(keyword)
  if (terms.length === 0) return null
  if (terms.length === 1) return fieldOrGroup(terms[0])
  const groups = terms.map((term) => `or(${fieldOrGroup(term)})`)
  return `and(${groups.join(',')})`
}

/** tsvector 词元白名单：纯 ASCII 字母/数字、长度 ≥ 2。 */
const TS_TERM_PATTERN = /^[A-Za-z0-9]{2,}$/

/** 该词是否参与 tsvector 叠加路径（必须含至少 1 个 ASCII 字母，纯数字不参与）。 */
function isTsTerm(term: string): boolean {
  return TS_TERM_PATTERN.test(term) && /[A-Za-z]/.test(term)
}

/**
 * 构造 `search_tsv` 叠加查询串（`websearch` 类型，空格表示 AND）。
 *
 * 白名单清洗顺带彻底规避 `& | ! : * ( ) '` 等 tsquery 语法字符注入。
 * 中文词（含 CJK 字符）一律被过滤掉：PG 默认 parser 不切 CJK，走这条路径无召回。
 *
 * **不变式（v2.13 修订）**：tsquery 只能表达**全部**词时才启用，部分词可用即整体弃用。
 * 原因是叠加结果与 ilike 结果做**并集**——只要有一个词落不进 tsquery
 * （CJK / 单字符 / 纯数字），并集就会把「不含该词」的记录带回来，把
 * `buildKeywordOrFilter` 精心构造的「词间 AND」稀释成 OR。
 * 例：`'周报 report'` 若只带 `report` 去查，会召回不含「周报」的记录（PRD R1 验收 ② 失效）。
 * 因此这类关键词只走 q1（ilike，本身已是词间 AND），语义才正确。
 *
 * @param keyword 用户输入
 * @returns 清洗后的查询串（全部词都是可用 ASCII 词）；否则返回 null（调用方跳过第二条查询）
 */
export function buildTsQuery(keyword: string): string | null {
  const terms = splitTerms(keyword)
  if (terms.length === 0) return null
  // 有一个词落不进 tsquery 就整体弃用（见上方不变式）
  if (!terms.every(isTsTerm)) return null
  return terms.join(' ')
}

/** 记录行的最小结构（只需要排序与去重字段，避免依赖具体 Row 类型）。 */
interface SortableRow {
  id: number
  created_at: string
}

/** 解析 created_at；非法值按 0 处理（排到最后，且不抛错）。 */
function createdAtMs(row: SortableRow): number {
  const ms = Date.parse(row.created_at)
  return Number.isNaN(ms) ? 0 : ms
}

/**
 * 两条查询结果按 id 并集合并，再按 `created_at DESC`（同刻按 id DESC）排序并截断。
 *
 * @param primary 主查询（ilike 路径）结果，优先级更高（同 id 保留它的行）
 * @param overlay 叠加查询（tsvector 路径）结果
 * @param limit 结果上限
 * @returns 合并、去重、排序、截断后的行数组
 */
export function mergeRowsById<T extends SortableRow>(primary: T[], overlay: T[], limit: number): T[] {
  const byId = new Map<number, T>()
  for (const row of primary) byId.set(row.id, row)
  for (const row of overlay) {
    if (!byId.has(row.id)) byId.set(row.id, row)
  }
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : Number.MAX_SAFE_INTEGER
  return [...byId.values()]
    .sort((a, b) => {
      const diff = createdAtMs(b) - createdAtMs(a)
      return diff !== 0 ? diff : b.id - a.id
    })
    .slice(0, safeLimit)
}
