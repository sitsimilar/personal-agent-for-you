/**
 * v2.13 R1 检索升级测试（PRD 验收 ②「多词命中」+ ④「中文兜底」）。
 *
 * 两段：
 * 1. 纯函数（`web/src/lib/search.ts`）：切词、过滤器构造、tsquery 清洗、并集合并；
 * 2. service 链路（`recordService.search` / `searchCandidates`）：
 *    单关键词与 v2.12.2 同形、多关键词走嵌套 AND、tsvector 第二条查询按需发、
 *    列不存在（迁移未执行，42703）时静默降级只返回 ilike 结果。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __setDbResult,
  __resetDbCalls,
  __dbCalls,
  __queueDbResults,
  __resetDbQueue,
} from './mocks/cloud'
import { MAX_TERMS, buildKeywordOrFilter, buildTsQuery, escapeLike, escapeTagTerm, mergeRowsById, splitTerms } from '../web/src/lib/search'
import { recordService } from '../web/src/services/recordService'
import type { RecordsRow } from '../web/src/lib/database.types'

/** 构造一行测试数据。 */
function makeRow(over: Partial<RecordsRow> = {}): RecordsRow {
  return {
    id: 1,
    owner_id: 'u1',
    type: 'idea',
    title: '周报模板整理',
    content: '',
    url: null,
    file_path: null,
    category: null,
    tags: [],
    summary: null,
    todo_status: null,
    priority: null,
    remind_at: null,
    recurrence: null,
    recurrence_parent_id: null,
    recurrence_next_id: null,
    link_meta: null,
    is_deleted: false,
    deleted_at: null,
    created_at: '2026-10-27T00:00:00.000Z',
    updated_at: '2026-10-27T00:00:00.000Z',
    ...over,
  }
}

beforeEach(() => {
  __resetDbCalls()
  __resetDbQueue()
})

/* ----------------------------- 纯函数 ----------------------------- */

test('splitTerms：按空白切分、去空、去重、保持原序、最多 5 个词', () => {
  assert.deepEqual(splitTerms('  周报   模板 周报 '), ['周报', '模板'])
  assert.deepEqual(splitTerms(''), [])
  assert.deepEqual(splitTerms('   '), [])
  assert.deepEqual(splitTerms('a b c d e f g'), ['a', 'b', 'c', 'd', 'e'])
  assert.equal(splitTerms('a b c d e f g').length, MAX_TERMS)
})

test('buildKeywordOrFilter：空关键词返回 null（不加过滤）', () => {
  assert.equal(buildKeywordOrFilter(''), null)
  assert.equal(buildKeywordOrFilter('   '), null)
})

test('buildKeywordOrFilter：单关键词与 v2.12.2 完全同形（零回归）', () => {
  assert.equal(buildKeywordOrFilter('周报'), 'title.ilike.%周报%,content.ilike.%周报%,tags.cs.{周报}')
})

test('buildKeywordOrFilter：词含 tags 数组特殊字符时跳过 tags 命中，但仍命中标题/正文', () => {
  assert.equal(buildKeywordOrFilter('a{b'), 'title.ilike.%a{b%,content.ilike.%a{b%')
  assert.equal(escapeTagTerm('a{b'), null)
  assert.equal(escapeTagTerm('周报'), 'tags.cs.{周报}')
})

test('buildKeywordOrFilter：多关键词走嵌套逻辑树，词间 AND / 字段间 OR', () => {
  assert.equal(
    buildKeywordOrFilter('周报 模板'),
    'and(or(title.ilike.%周报%,content.ilike.%周报%,tags.cs.{周报}),' +
      'or(title.ilike.%模板%,content.ilike.%模板%,tags.cs.{模板}))',
  )
})

test('escapeLike：转义 ilike 通配符与 PostgREST 结构字符', () => {
  assert.equal(escapeLike('100%_a,b(c)"d\\e'), '100\\%\\_a\\,b\\(c\\)\\"d\\\\e')
})

test('buildTsQuery：中文词不参与（PG 默认 parser 不切 CJK）→ 返回 null', () => {
  assert.equal(buildTsQuery('周报'), null)
  assert.equal(buildTsQuery('周报 模板'), null)
  // M1：只要有一个词进不了 tsquery，就整体弃用（部分生效会破坏词间 AND）
  assert.equal(buildTsQuery('周报 weekly'), null)
  assert.equal(buildTsQuery('周报 report'), null)
})

test('buildTsQuery：只有全部词都是可用 ASCII 词时才启用；任一不可用即整体为 null', () => {
  assert.equal(buildTsQuery('weekly report'), 'weekly report')
  assert.equal(buildTsQuery('a report'), null, '长度 1 的词让整体弃用（否则并集只按 report 召回）')
  assert.equal(buildTsQuery('2026 report'), null, '纯数字词让整体弃用')
  // 危险语法字符本身就通不过白名单 → 整体弃用（比「清洗后部分生效」更安全）
  assert.equal(buildTsQuery('weekly & | ! : * ( )'), null)
})

test('mergeRowsById：按 id 并集去重，created_at DESC 排序并截断', () => {
  const primary = [
    { id: 1, created_at: '2026-10-25T00:00:00.000Z' },
    { id: 2, created_at: '2026-10-27T00:00:00.000Z' },
  ]
  const overlay = [
    { id: 2, created_at: '2026-10-27T00:00:00.000Z' }, // 重复 id → 保留主查询那行
    { id: 3, created_at: '2026-10-26T00:00:00.000Z' },
  ]
  const merged = mergeRowsById(primary, overlay, 10)
  assert.deepEqual(
    merged.map((r) => r.id),
    [2, 3, 1],
  )
  assert.equal(mergeRowsById(primary, overlay, 2).length, 2)
})

/* ----------------------------- service 链路 ----------------------------- */

test('search：单关键词 → 一条 ilike 查询，不发 tsvector 第二条', async () => {
  __setDbResult({ data: [makeRow()] })
  const rows = await recordService.search('周报')
  assert.equal(rows.length, 1)
  assert.ok(__dbCalls.includes('or(title.ilike.%周报%,content.ilike.%周报%,tags.cs.{周报})'))
  assert.equal(__dbCalls.some((c) => c.startsWith('textSearch(')), false)
  assert.ok(__dbCalls.includes('limit(50)'))
})

test('search：多关键词中文 → 嵌套 AND 过滤器，仍不发 tsvector 查询（中文兜底）', async () => {
  __setDbResult({ data: [] })
  await recordService.search('周报 模板')
  const orCall = __dbCalls.find((c) => c.startsWith('or(and('))
  assert.ok(orCall, '应发出嵌套 AND 的 or= 过滤器')
  assert.match(orCall ?? '', /title\.ilike\.%周报%/)
  assert.match(orCall ?? '', /title\.ilike\.%模板%/)
  assert.equal(__dbCalls.some((c) => c.startsWith('textSearch(')), false)
})

/* ------------------- M1：tsquery 只能表达全部词时才启用 ------------------- */

test('M1：search("周报 report") 只发 1 条查询，不出现 textSearch（否则并集破坏词间 AND）', async () => {
  __resetDbCalls()
  __setDbResult({ data: [makeRow({ id: 1 })] })

  const rows = await recordService.search('周报 report')

  assert.equal(__dbCalls.filter((c) => c.startsWith('from(')).length, 1, '部分词进不了 tsquery 时不得发叠加查询')
  assert.equal(__dbCalls.some((c) => c.startsWith('textSearch(')), false)
  assert.equal(rows.length, 1, '只返回 q1（ilike，词间 AND）的结果')
  // q1 的过滤器本身仍是词间 AND
  const filter = __dbCalls.find((c) => c.startsWith('or(and(')) ?? ''
  assert.match(filter, /title\.ilike\.%周报%/)
  assert.match(filter, /title\.ilike\.%report%/)
})

test('M1：search("weekly report") 发 2 条查询，第二条 tsquery 含两个词', async () => {
  __resetDbCalls()
  __resetDbQueue()
  __queueDbResults([
    { data: [makeRow({ id: 1 })] },
    { data: [makeRow({ id: 2 })] },
  ])

  await recordService.search('weekly report')

  assert.equal(__dbCalls.filter((c) => c.startsWith('from(')).length, 2)
  assert.equal(
    __dbCalls.filter((c) => c.startsWith('textSearch(')).length,
    1,
    '全部词都是 ASCII 词时才叠加第二条查询',
  )
  assert.ok(__dbCalls.includes('textSearch(search_tsv,weekly report,websearch,simple)'))
})

test('M1 回归：search("周报 模板") 仍只发 1 条查询（全中文行为不变）', async () => {
  __resetDbCalls()
  __setDbResult({ data: [makeRow({ id: 1 })] })

  await recordService.search('周报 模板')

  assert.equal(__dbCalls.filter((c) => c.startsWith('from(')).length, 1)
  assert.equal(__dbCalls.some((c) => c.startsWith('textSearch(')), false)
  assert.equal(__dbCalls.filter((c) => c.startsWith('or(')).length, 1, '只走 q1 的嵌套 AND 过滤器')
})

test('search：含 ASCII 词 → 额外发 search_tsv 叠加查询，并按 id 并集合并去重', async () => {
  __resetDbQueue()
  __queueDbResults([
    { data: [makeRow({ id: 1, title: 'weekly report 归档' }), makeRow({ id: 2, title: 'weekly 计划' })] },
    { data: [makeRow({ id: 2, title: 'weekly 计划' }), makeRow({ id: 3, title: 'report 模板' })] },
  ])
  const rows = await recordService.search('weekly report')
  assert.deepEqual(
    rows.map((r) => r.id),
    [1, 2, 3].sort((a, b) => {
      // created_at 全相同 → 按 id DESC
      return b - a
    }),
  )
  assert.ok(__dbCalls.includes('textSearch(search_tsv,weekly report,websearch,simple)'))
  assert.equal(__dbCalls.filter((c) => c.startsWith('textSearch(')).length, 1)
})

test('search：tsvector 列不存在（迁移未执行，42703）→ 静默降级，只返回 ilike 结果', async () => {
  __resetDbQueue()
  __queueDbResults([
    { data: [makeRow({ id: 7 })] },
    { data: null, error: { code: '42703', message: 'column records.search_tsv does not exist' } },
  ])
  const rows = await recordService.search('weekly report')
  assert.deepEqual(
    rows.map((r) => r.id),
    [7],
  )
})

test('search：空关键词不加任何过滤（行为与 v2.12.2 一致）', async () => {
  __setDbResult({ data: [makeRow()] })
  await recordService.search('   ')
  assert.equal(__dbCalls.some((c) => c.startsWith('or(')), false)
  assert.equal(__dbCalls.some((c) => c.startsWith('textSearch(')), false)
  assert.ok(__dbCalls.includes('order(created_at,asc:false)'))
})

test('searchCandidates：保留排除自身语义，且与 search 共用同一条过滤器链路', async () => {
  __setDbResult({ data: [makeRow({ id: 5 })] })
  const rows = await recordService.searchCandidates('周报 模板', 20, 9)
  assert.deepEqual(
    rows.map((r) => r.id),
    [5],
  )
  assert.ok(__dbCalls.includes('neq(id,9)'))
  assert.ok(__dbCalls.some((c) => c.startsWith('or(and(')))
  assert.ok(__dbCalls.includes('limit(20)'))
})

test('listRecords(keyword)：走同一过滤器构造函数（多词 AND），并保留 count/range 分页', async () => {
  __setDbResult({ data: [makeRow()], count: 1 })
  const result = await recordService.listRecords({ type: 'idea', keyword: '周报 模板' })
  assert.equal(result.total, 1)
  assert.ok(__dbCalls.some((c) => c.startsWith('or(and(')))
  assert.ok(__dbCalls.includes('range(0,19)'))
})
