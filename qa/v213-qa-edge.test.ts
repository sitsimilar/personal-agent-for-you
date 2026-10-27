/**
 * v2.13 增量 · QA 独立验证（边界 / 对抗 / 现状锁定）
 *
 * 目的：不复述工程师自测结论，而是从 PRD 验收标准与设计风险点出发独立构造用例。
 * 覆盖 7 个已知风险点 + 工程师测漏的边界：
 *
 *  R1 检索：中文 tsquery 必为 null；`search('周报 模板')` 只发 1 条查询；
 *           混合「CJK + ASCII」多词时 tsvector 叠加层只带 ASCII 子集（风险 M1，锁定现状）；
 *           `countTodoByStatus()` 无数据返回 0 而非 undefined。
 *  R2 三段：someday 优先于 high；本地日边界（明日 00:00 整 / 今日 23:59:59.999）；
 *           时区注入确实改变分段（不是 UTC 日）；计数守恒 + 不复制。
 *  R3 循环：due 不落 mode 键；completion 且 remind_at 为空；提前完成；service 链路不丢 mode。
 *  R4 稍后：pruneFired 清理非法键（空 id / 缺段 / 非 ISO 第二段）；snooze 键不被误删；
 *           effectiveFireAt 的「有 snoozed 不减提前量」与「remind_at 为空」；
 *           同一分钟内多次 tick 不重复弹、连续 3 轮各弹一次。
 *  R5 向导：等待中并集去重；finish 幂等的真实边界（风险 M2，锁定现状）；
 *           焦点待办条数；进度 TTL 边界。
 *  R6 ICS：超长中文 + emoji 标题的 75 字节折行、无裸 LF、展开无损；转义顺序；
 *           二次导出除 DTSTAMP 外完全一致；源码守门（无 Date.now / 无无参 new Date）。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  __dbCalls,
  __dbInserts,
  __queueDbResults,
  __resetDbCalls,
  __resetDbQueue,
  __resetDbWrites,
  __setDbResult,
} from './mocks/cloud'
import { buildKeywordOrFilter, buildTsQuery } from '../web/src/lib/search'
import { bucketCounts, bucketTodo, splitByBucket } from '../web/src/lib/todo-segments'
import { computeNext, normalizeRecurrenceRule } from '../web/src/lib/recurrence'
import {
  dedupeKey,
  effectiveFireAt,
  legacyDedupeKey,
  pruneFired,
} from '../web/src/lib/reminder-schedule'
import { recordService } from '../web/src/services/recordService'
import { completeTodoWithRecurrence } from '../web/src/services/recurrenceService'
import { reviewWizardService } from '../web/src/services/reviewWizardService'
import {
  buildReviewNoteBody,
  isProgressExpired,
  pickInbox,
  pickWaiting,
  PROGRESS_TTL_MS,
} from '../web/src/lib/review-wizard'
import { ICS_CRLF, ICS_MAX_LINE_BYTES, buildIcs, foldLine, icsEscape, utf8ByteLength } from '../web/src/lib/ics'
import type { InfoRecord, ReviewWizardProgress } from '../shared/types/domain'
import type { RecordsRow } from '../web/src/lib/database.types'

const TZ = 480

beforeEach(() => {
  __resetDbCalls()
  __resetDbQueue()
  __resetDbWrites()
  __setDbResult({ data: [] })
})

/* -------------------------------------------------------------------------- */
/* 公共构造                                                                    */
/* -------------------------------------------------------------------------- */

/** 东八区墙钟 → epoch ms。 */
function cn(hhmm: string, day = '2026-10-12'): number {
  return Date.parse(`${day}T${hhmm}:00+08:00`)
}

/** 东八区墙钟 → ISO。 */
function cnIso(hhmm: string, day = '2026-10-12'): string {
  return new Date(cn(hhmm, day)).toISOString()
}

/** 领域记录（只为纯函数服务的字段子集）。 */
function rec(over: Partial<InfoRecord> = {}): InfoRecord {
  return {
    id: 1,
    type: 'todo',
    title: '待办',
    content: '',
    tags: [],
    todoStatus: 'pending',
    priority: 'medium',
    remindAt: null,
    someday: false,
    snoozeCount: 0,
    snoozedUntil: null,
    isDeleted: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

/** 数据库行。 */
function row(over: Partial<RecordsRow> = {}): RecordsRow {
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
  } as RecordsRow
}

/* ========================================================================== */
/* R1 · 检索                                                                   */
/* ========================================================================== */

test('R1：中文（含多词）在 tsquery 路径必须为 null —— PG 默认 parser 不切 CJK', () => {
  assert.equal(buildTsQuery('周报'), null, '单中文词不得进入 tsvector 路径')
  assert.equal(buildTsQuery('周报 模板'), null, '全中文多词同样不得进入')
  assert.equal(buildTsQuery('周报模板整理'), null)
  // 空白 + 标点混入后仍无 ASCII 词
  assert.equal(buildTsQuery('  周报  '), null)
})

test('R1：search("周报 模板") 只发 1 条查询，且不出现 textSearch（中文主力路径是 ilike）', async () => {
  __setDbResult({ data: [row({ id: 1 }), row({ id: 2 })] })
  await recordService.search('周报 模板')

  const fromCalls = __dbCalls.filter((c) => c.startsWith('from('))
  assert.equal(fromCalls.length, 1, `中文多词只能发 1 条查询，实际 ${fromCalls.length} 条`)
  assert.equal(__dbCalls.some((c) => c.startsWith('textSearch(')), false, '不得出现 textSearch(')

  const filter = __dbCalls.find((c) => c.startsWith('or(and(')) ?? ''
  assert.match(filter, /title\.ilike\.%周报%/)
  assert.match(filter, /title\.ilike\.%模板%/)
  // 过滤器必须是「词间 AND」，不是把两个词拼成一个子串
  assert.equal(filter.includes('%周报 模板%'), false)
})

test('R1（M1 已修）：CJK + ASCII 混合多词时不再发 tsvector 叠加查询 → 词间 AND 成立', async () => {
  // 词间 AND 的过滤器本身是正确的（两个词都在 and(...) 里）
  assert.match(buildKeywordOrFilter('周报 report') ?? '', /^and\(or\(/)

  // 修复后：只要有一个词进不了 tsquery，就整体弃用（部分词生效会破坏 AND）
  assert.equal(buildTsQuery('周报 report'), null, '部分词可用即整体弃用（M1 修复）')

  __resetDbQueue()
  __queueDbResults([
    { data: [] }, // q1：同时含「周报」和「report」的记录 = 0 条
    { data: [row({ id: 9, title: 'weekly report 归档' })] }, // 该结果不得被采用（不发 q2）
  ])
  const rows = await recordService.search('周报 report')
  assert.deepEqual(
    rows.map((r) => r.id),
    [],
    '修复后：只采用 q1（ilike，词间 AND），不含「周报」的记录不会被并集带回来',
  )
  assert.equal(__dbCalls.some((c) => c.startsWith('textSearch(')), false, '不得发 tsvector 叠加查询')
})

test('R1：单字/两字中文关键词（trigram < 3 字符）不触发 tsvector 第二条查询', async () => {
  __setDbResult({ data: [] })
  await recordService.search('周')
  assert.equal(__dbCalls.filter((c) => c.startsWith('from(')).length, 1)
  assert.equal(__dbCalls.some((c) => c.startsWith('textSearch(')), false)
})

test('R1：countTodoByStatus 无数据时返回 0 而非 undefined（count 为 null）', async () => {
  __resetDbQueue()
  __queueDbResults([
    { data: null, count: null },
    { data: null, count: null },
  ])
  const counts = await recordService.countTodoByStatus()
  assert.deepEqual(counts, { pending: 0, done: 0 })
  assert.equal(typeof counts.pending, 'number')
  assert.equal(typeof counts.done, 'number')
  // 只发 2 次 head count（设计 §1.2 明确不做 3 次分段 count）
  assert.equal(__dbCalls.filter((c) => c.startsWith('from(')).length, 2)
})

test('R1：countTodoByStatus 查询出错时抛错（UI 走 friendlyError，不静默返回 0）', async () => {
  __resetDbQueue()
  __queueDbResults([
    { data: null, error: { message: 'boom' } },
    { data: null, error: { message: 'boom' } },
  ])
  await assert.rejects(() => recordService.countTodoByStatus())
})

/* ========================================================================== */
/* R2 · 待办三段                                                               */
/* ========================================================================== */

test('R2：someday 优先于 high 优先级与今日到期（三段互斥的第一条规则不能被后续规则盖掉）', () => {
  const now = cn('10:00')
  assert.equal(
    bucketTodo({ someday: true, remindAt: cnIso('09:00'), priority: 'high' }, now, TZ),
    'someday',
  )
  assert.equal(bucketTodo({ someday: true, remindAt: null, priority: 'high' }, now, TZ), 'someday')
})

test('R2：本地日边界 —— 今日 23:59:59.999 归今天，本地明日 00:00 整归即将', () => {
  const now = cn('10:00')
  const todayEnd = cn('23:59', '2026-10-12') + 59_999
  const tomorrowStart = cn('00:00', '2026-10-13')
  assert.equal(todayEnd, tomorrowStart - 1, '夹具自检：两者相差 1ms')

  assert.equal(bucketTodo({ someday: false, remindAt: new Date(todayEnd).toISOString(), priority: 'low' }, now, TZ), 'today')
  assert.equal(
    bucketTodo({ someday: false, remindAt: new Date(tomorrowStart).toISOString(), priority: 'low' }, now, TZ),
    'upcoming',
    '本地明日 00:00 整必须归「即将」（右开区间）',
  )
})

test('R2：分段按「注入时区的本地日」判定，同一时刻换时区即换段（不是 UTC 日）', () => {
  const now = cn('22:00') // 2026-10-12T14:00Z
  const remindAt = cnIso('00:30', '2026-10-13') // 2026-10-12T16:30Z
  // 东八区：提醒落在 10-13 00:30 → 明日，归「即将」
  assert.equal(bucketTodo({ someday: false, remindAt, priority: 'low' }, now, 480), 'upcoming')
  // UTC：同一时刻是 10-12 16:30，仍在「今天」内 → 归「今天」
  assert.equal(bucketTodo({ someday: false, remindAt, priority: 'low' }, now, 0), 'today')
})

test('R2：混合集合的三段计数守恒且 splitByBucket 不复制、不遗漏', () => {
  const now = cn('10:00')
  const list: InfoRecord[] = [
    rec({ id: 1, remindAt: cnIso('09:00') }), // 今天
    rec({ id: 2, remindAt: cnIso('09:00', '2026-10-01') }), // 逾期 → 今天
    rec({ id: 3, remindAt: cnIso('09:00', '2026-10-20') }), // 即将
    rec({ id: 4, remindAt: null, priority: 'high' }), // 今天
    rec({ id: 5, remindAt: null, priority: 'low' }), // 即将
    rec({ id: 6, someday: true, remindAt: cnIso('09:00') }), // 某天
    rec({ id: 7, someday: null, remindAt: null, priority: null }), // 即将（someday 缺失按 false）
  ]

  const counts = bucketCounts(list, now, TZ)
  assert.equal(counts.total, 7)
  assert.equal(counts.today + counts.upcoming + counts.someday, counts.total, '计数守恒')
  assert.deepEqual(
    { today: counts.today, upcoming: counts.upcoming, someday: counts.someday },
    { today: 3, upcoming: 3, someday: 1 },
  )

  const buckets = splitByBucket(list, now, TZ)
  const ids = [...buckets.today, ...buckets.upcoming, ...buckets.someday].map((r) => r.id).sort((a, b) => a - b)
  assert.deepEqual(ids, [1, 2, 3, 4, 5, 6, 7], '三段并集 = 输入集合，无重复无遗漏')
  assert.deepEqual(buckets.someday.map((r) => r.id), [6])
})

test('R2：非法 remind_at 字符串按「无提醒时间」规则兜底，不抛错也不消失', () => {
  const now = cn('10:00')
  assert.doesNotThrow(() => bucketTodo({ someday: false, remindAt: 'not-a-date', priority: 'high' }, now, TZ))
  assert.equal(bucketTodo({ someday: false, remindAt: 'not-a-date', priority: 'high' }, now, TZ), 'today')
  assert.equal(bucketTodo({ someday: false, remindAt: '', priority: 'medium' }, now, TZ), 'upcoming')
})

/* ========================================================================== */
/* R3 · 循环「按完成日重复」                                                    */
/* ========================================================================== */

test('R3：mode="due" / 非法值归一后不留 mode 键（旧数据 JSONB 不被污染）', () => {
  const due = normalizeRecurrenceRule({ freq: 'daily', interval: 2, mode: 'due' })
  assert.ok(due)
  assert.equal(Object.hasOwn(due, 'mode'), false, 'due 不得落键')
  const bad = normalizeRecurrenceRule({ freq: 'daily', interval: 2, mode: 'whatever' })
  assert.ok(bad)
  assert.equal(Object.hasOwn(bad, 'mode'), false, '非法值不得落键')
  const completion = normalizeRecurrenceRule({ freq: 'daily', interval: 2, mode: 'completion' })
  assert.equal(completion?.mode, 'completion')
})

test('R3：completion 且 remind_at 为空 → 下一期无提醒时间；endDate 已过 → ruleEnded', () => {
  const rule = { freq: 'daily' as const, interval: 2, mode: 'completion' as const }
  const r1 = computeNext(rule, { remindAt: null, nowIso: '2026-10-12T02:00:00.000Z', tzOffsetMinutes: TZ })
  assert.deepEqual(r1, { nextRemindIso: null, ruleEnded: false })

  const ended = computeNext(
    { ...rule, endDate: '2026-10-01' },
    { remindAt: null, nowIso: '2026-10-12T02:00:00.000Z', tzOffsetMinutes: TZ },
  )
  assert.equal(ended.nextRemindIso, null)
  assert.equal(ended.ruleEnded, true)
})

test('R3（现状锁定）：completion 且「提前完成」→ 下一期按完成日 + interval 推进，可能早于原到期日', () => {
  // 原到期 10-14 09:00，10-12 就完成了，interval=2
  const r = computeNext(
    { freq: 'daily', interval: 2, mode: 'completion' },
    { remindAt: cnIso('09:00', '2026-10-14'), nowIso: new Date(cn('10:00', '2026-10-12')).toISOString(), tzOffsetMinutes: TZ },
  )
  // 设计口径：基准 = 完成日（10-12）+ 原时分 09:00 → 下一期 10-14 09:00 与 due 相同
  assert.equal(r.nextRemindIso, cnIso('09:00', '2026-10-14'))
  // 完成得更早时确实会「早于原到期日」：10-10 完成 → 下一期 10-12
  const earlier = computeNext(
    { freq: 'daily', interval: 2, mode: 'completion' },
    { remindAt: cnIso('09:00', '2026-10-14'), nowIso: new Date(cn('10:00', '2026-10-10')).toISOString(), tzOffsetMinutes: TZ },
  )
  assert.equal(earlier.nextRemindIso, cnIso('09:00', '2026-10-12'), '提前完成时新一期可以早于原到期日（设计后果，非缺陷）')
})

test('R3：service 链路不丢 mode —— completeTodoWithRecurrence 下 completion 与 due 的下一期日期不同', async (t) => {
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const dayKeyBefore = `${dayStart.getFullYear()}-${dayStart.getMonth()}-${dayStart.getDate()}`

  // 原 remind_at = 今天 09:00 本地；今天完成
  const remindAt = new Date(dayStart)
  remindAt.setHours(9, 0, 0, 0)

  /** 期望：完成日（今天） + days 天的 09:00（本地时区，独立于 computeNext 的实现）。 */
  const expected = (days: number): string => {
    const d = new Date(dayStart)
    d.setDate(d.getDate() + days)
    d.setHours(9, 0, 0, 0)
    return d.toISOString()
  }

  const base = rec({
    id: 901,
    remindAt: remindAt.toISOString(),
    recurrence: { freq: 'daily', interval: 2, mode: 'completion' },
  })
  __resetDbQueue()
  __queueDbResults([
    { data: [row({ id: 901, type: 'todo', todo_status: 'done' })] }, // 条件更新置 done
    { data: [row({ id: 902, type: 'todo', remind_at: expected(2) })] }, // 新建下一期
    { data: [row({ id: 901, type: 'todo' })] }, // 回写 recurrence_next_id
  ])
  await completeTodoWithRecurrence(base)

  const dayKeyAfter = (() => {
    const d = new Date()
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
  })()
  if (dayKeyBefore !== dayKeyAfter) {
    t.skip('测试跨过本地零点，completion 基准日不稳定，跳过')
    return
  }

  // 由于 completion 与 due 在今天完成时结果相同，改用「完成日 vs 到期日不同」的第二种场景验证
  const futureDue = new Date(dayStart)
  futureDue.setDate(futureDue.getDate() - 1) // 到期日 = 昨天 09:00（迟到 1 天完成）
  futureDue.setHours(9, 0, 0, 0)

  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: [row({ id: 911, type: 'todo', todo_status: 'done' })] },
    { data: [row({ id: 912, type: 'todo' })] },
    { data: [row({ id: 911, type: 'todo' })] },
  ])
  await completeTodoWithRecurrence(
    rec({ id: 911, remindAt: futureDue.toISOString(), recurrence: { freq: 'daily', interval: 2, mode: 'completion' } }),
  )
  const completionInsert = __dbInserts[0] as Record<string, unknown>
  assert.equal(
    completionInsert.remind_at,
    expected(2),
    'completion：下一期 = 完成日 + 2 天（不是 到期日 + 2 天）',
  )

  // 对照：同一场景 due 模式必须与 v2.12.2 一致（到期日 + 2 天）
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: [row({ id: 921, type: 'todo', todo_status: 'done' })] },
    { data: [row({ id: 922, type: 'todo' })] },
    { data: [row({ id: 921, type: 'todo' })] },
  ])
  await completeTodoWithRecurrence(
    rec({ id: 921, remindAt: futureDue.toISOString(), recurrence: { freq: 'daily', interval: 2 } }),
  )
  const dueInsert = __dbInserts[0] as Record<string, unknown>
  const dueExpected = new Date(futureDue)
  dueExpected.setDate(dueExpected.getDate() + 2)
  assert.equal(dueInsert.remind_at, dueExpected.toISOString(), 'due：下一期 = 原 remind_at + 2 天')
})

/* ========================================================================== */
/* R4 · 稍后提醒（snooze）                                                     */
/* ========================================================================== */

test('R4：pruneFired 清理非法键而不是抛错（空 recordId / 缺段 / 非 ISO 第二段 / 非数字时间戳）', () => {
  const now = cn('10:00')
  const iso = cnIso('09:00')
  const store = {
    [`|${iso}|0`]: now - 1000, // 空 recordId
    '123': now - 1000, // 缺段
    '124||0': now - 1000, // 空第二段
    [`125|not-a-date|0`]: now - 1000, // 非 ISO 第二段
    [`126|${iso}|0`]: Number.NaN, // 非数字时间戳
    [`127|${iso}|0`]: now - 1000, // 合法
  }

  let pruned: Record<string, number> = {}
  assert.doesNotThrow(() => {
    pruned = pruneFired(store, now)
  })
  assert.deepEqual(Object.keys(pruned), [`127|${iso}|0`], '只保留合法键，其余静默清理')
})

test('R4：pruneFired 不误删 snooze 键（token 0/1/3 与旧两段键都必须留下）', () => {
  const now = cn('10:00')
  const iso = cnIso('09:00')
  const store = {
    [dedupeKey(1, iso, 0)]: now - 3000,
    [dedupeKey(1, iso, 1)]: now - 2000,
    [dedupeKey(1, iso, 3)]: now - 1000,
    [legacyDedupeKey(2, iso)]: now - 500,
  }
  const pruned = pruneFired(store, now)
  assert.equal(Object.keys(pruned).length, 4, '三段键与旧两段键一个都不能少（否则退化为每 30s 弹一次）')
  assert.equal(pruned[dedupeKey(1, iso, 3)], now - 1000)
})

test('R4：effectiveFireAt —— snoozed_until 存在（remind_at 为空 / 提前量很大）都以 snoozed_until 为准', () => {
  const snoozed = '2026-10-12T02:10:00.000Z'
  // remind_at 为空但 snoozed_until 有值：返回 snoozed_until（不 NaN）
  assert.equal(effectiveFireAt({ remindAt: null, snoozedUntil: snoozed }, 0), Date.parse(snoozed))
  // 提前量 60 分钟也不得把 snoozed_until 往前拉
  assert.equal(effectiveFireAt({ remindAt: cnIso('10:00'), snoozedUntil: snoozed }, 60), Date.parse(snoozed))
  // 两者都空 → NaN（调用方跳过）
  assert.ok(Number.isNaN(effectiveFireAt({ remindAt: null, snoozedUntil: null }, 5)))
  assert.ok(Number.isNaN(effectiveFireAt({}, 5)))
  // snoozed_until 非法字符串 → 回落 remind_at − 提前量（不因脏数据丢提醒）
  assert.equal(effectiveFireAt({ remindAt: cnIso('10:00'), snoozedUntil: 'oops' }, 10), cn('10:00') - 600_000)
})

/* --------------------------- snooze 调度链路夹具 --------------------------- */

interface Sent {
  key: string
  recordId: number
}

interface Harness {
  sent: Sent[]
  firedKeys: () => string[]
  seedFired: (key: string, ts: number) => void
}

const FIRED_KEY = 'personal-agent.reminder.fired.v1'
const realNow = Date.now
let reminderModule: typeof import('../web/src/services/reminderService')

function installEnv(): Harness {
  const sent: Sent[] = []
  const map = new Map<string, string>()
  const store = {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
  ;(globalThis as unknown as { window: unknown }).window = {
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: (fn: () => void, ms?: number) => globalThis.setInterval(fn, ms) as unknown as number,
    clearInterval: (id: number) => globalThis.clearInterval(id),
    location: { search: '' },
    desktopBridge: {
      notify: async (payload: Sent) => {
        sent.push({ key: payload.key, recordId: payload.recordId })
        return { ok: true }
      },
      onNotificationClicked: () => () => undefined,
    },
  }
  ;(globalThis as unknown as { localStorage: unknown }).localStorage = store

  return {
    sent,
    firedKeys: () => {
      const value = store.getItem(FIRED_KEY)
      return value ? Object.keys(JSON.parse(value) as Record<string, number>) : []
    },
    seedFired: (key, ts) => {
      const value = store.getItem(FIRED_KEY)
      const parsed = value ? (JSON.parse(value) as Record<string, number>) : {}
      parsed[key] = ts
      store.setItem(FIRED_KEY, JSON.stringify(parsed))
    },
  }
}

function clearEnv(): void {
  delete (globalThis as unknown as { window?: unknown }).window
  delete (globalThis as unknown as { localStorage?: unknown }).localStorage
}

function settingsRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    owner_id: 'u1',
    notify_enabled: true,
    remind_lead_minutes: 0,
    quiet_hours_enabled: false,
    quiet_start: '22:00',
    quiet_end: '08:00',
    ...over,
  }
}

/** 跑一次调度 tick。 */
async function tick(records: RecordsRow[], nowMs: number, settings = settingsRow()): Promise<void> {
  __resetDbCalls()
  __resetDbQueue()
  reminderModule.invalidateSettingsCache()
  __queueDbResults([{ data: settings }, { data: records }])
  Date.now = () => nowMs
  await reminderModule.reminderService.tickNow()
}

test('R4：连续 3 次 snooze，同一分钟内多次 tick（1s 间隔）不重复弹，总弹次 = 4', async () => {
  assert.ok(true)
  reminderModule = await import('../web/src/services/reminderService')
  const env = installEnv()
  try {
    const id = 301
    const remind = cnIso('10:00')
    const rounds = [
      { now: cn('10:00'), count: 0, snoozed: null as string | null, key: `${id}|${remind}|0` },
      { now: cn('10:10'), count: 1, snoozed: cnIso('10:10'), key: `${id}|${remind}|1` },
      { now: cn('10:20'), count: 2, snoozed: cnIso('10:20'), key: `${id}|${remind}|2` },
      { now: cn('10:30'), count: 3, snoozed: cnIso('10:30'), key: `${id}|${remind}|3` },
    ]

    for (const r of rounds) {
      const records = [
        row({ id, type: 'todo', todo_status: 'pending', remind_at: remind, snooze_count: r.count, snoozed_until: r.snoozed }),
      ]
      // 同一分钟内 3 次 tick（模拟 30s 轮询 + 可见性补发）
      await tick(records, r.now)
      await tick(records, r.now + 1000)
      await tick(records, r.now + 2000)
    }

    assert.equal(env.sent.length, 4, '4 轮各弹 1 次（首次 + 3 次重弹）')
    assert.deepEqual(env.sent.map((s) => s.key), rounds.map((r) => r.key))
    assert.deepEqual(env.firedKeys().sort(), rounds.map((r) => r.key).sort(), '三段键必须全部留存')
  } finally {
    Date.now = realNow
    clearEnv()
  }
})

test('R4：升级兼容——localStorage 里只有旧两段键时，同一条提醒不重弹', async () => {
  reminderModule = await import('../web/src/services/reminderService')
  const env = installEnv()
  try {
    const id = 302
    const remind = cnIso('10:00')
    env.seedFired(legacyDedupeKey(id, remind), cn('10:00'))
    await tick([row({ id, type: 'todo', todo_status: 'pending', remind_at: remind })], cn('10:00'))
    assert.equal(env.sent.length, 0, '旧键命中即视为已弹过（升级不重弹）')
  } finally {
    Date.now = realNow
    clearEnv()
  }
})

test('R4（现状锁定 · 风险 L1）：remind_at 为空的待办即使 snoozed_until 有值也永不弹（snooze 对无提醒待办是空操作）', async () => {
  reminderModule = await import('../web/src/services/reminderService')
  const env = installEnv()
  try {
    const id = 303
    await tick(
      [row({ id, type: 'todo', todo_status: 'pending', remind_at: null, snooze_count: 1, snoozed_until: cnIso('10:00') })],
      cn('10:00'),
    )
    assert.equal(env.sent.length, 0, 'handleCandidate 对 remind_at 空直接 return（真实环境里它也不会成为候选）')
  } finally {
    Date.now = realNow
    clearEnv()
  }
})

/* ========================================================================== */
/* R5 · 周回顾向导                                                             */
/* ========================================================================== */

test('R5：pickWaiting = 「某天」∪ 逾期，且同一记录只出现一次（并集去重）', () => {
  const now = cn('10:00')
  const list: InfoRecord[] = [
    rec({ id: 1, someday: true, remindAt: cnIso('09:00') }), // 某天（今天到期 → 不逾期）
    rec({ id: 2, remindAt: cnIso('09:00', '2026-10-01') }), // 逾期
    rec({ id: 3, someday: true, remindAt: cnIso('09:00', '2026-10-01') }), // 既是某天又逾期
    rec({ id: 4, remindAt: cnIso('23:00') }), // 今天晚些时候，不算逾期
    rec({ id: 5, remindAt: null }), // 无提醒，不算
    rec({ id: 6, remindAt: cnIso('09:00', '2026-10-01'), todoStatus: 'done' }), // 已完成
    rec({ id: 7, remindAt: cnIso('09:00', '2026-10-01'), isDeleted: true }), // 已删除
  ]
  assert.deepEqual(
    pickWaiting(list, now, TZ).map((r) => r.id),
    [1, 2, 3],
    '某天 ∪ 逾期、交集只算一次；当日到期/无提醒/已完成/已删除都排除',
  )
})

test('R5（现状锁定）：category 为空白字符串的记录既不算收件箱、也不算分类（两步都看不到它）', () => {
  const blank = rec({ id: 1, category: '   ' })
  const noCategory = rec({ id: 2, category: null })
  const withTags = rec({ id: 3, category: null, tags: ['x'] })

  assert.deepEqual(pickInbox([blank, noCategory, withTags]).map((r) => r.id), [2], '只有 category=null 且无 tags 进收件箱')
  // 与 pickCategories 的「trim 后为空则跳过」口径不一致：空白分类两边都不出现
  assert.equal(blank.category?.trim(), '')
})

test('R5（M2 已修）：finish 幂等覆盖「回顾已建 + 待办失败后重试」，同一 progress 连调两次只落 1 条', async () => {
  const progress: ReviewWizardProgress = {
    version: 1,
    step: 5,
    weekStart: '2026-10-19',
    startedAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    completedAt: null,
    completedRecordId: null,
    inbox: [],
    nextActions: [],
    waiting: [],
    health: [],
    focus: ['A', '', ''],
    aiFailed: false,
  }
  const stats = { inbox: 0, waiting: 0, stale: [], aiSummary: null, aiFailed: false }

  // 场景 1：整轮已走完（回顾记录已建 completedRecordId + completedAt 有值）→ 直接返回，不落库
  __resetDbWrites()
  const reused = await reviewWizardService.finish(
    { ...progress, completedRecordId: 77, completedAt: '2026-10-19T00:30:00.000Z' },
    stats,
  )
  assert.equal(reused, 77)
  assert.equal(__dbInserts.length, 0, '整轮已完成时不得再落库')

  // 场景 2：同一份 progress 连调两次 → 只落 1 条回顾记录（M2 修复：finish 会就地回写完成标记）
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: [row({ id: 501, type: 'idea' })] },
    { data: [row({ id: 502, type: 'todo' })] },
    { data: [row({ id: 503, type: 'idea' })] },
    { data: [row({ id: 504, type: 'todo' })] },
  ])
  const first = await reviewWizardService.finish(progress, stats)
  const second = await reviewWizardService.finish(progress, stats)

  const ideaInserts = __dbInserts.filter((i) => (i as Record<string, unknown>).type === 'idea')
  assert.equal(ideaInserts.length, 1, '同一 progress 连调两次只落 1 条回顾记录')
  assert.equal(second, first, '第二次必须返回同一条记录 id')
  assert.equal(progress.completedRecordId, first, 'finish 必须把完成标记就地写回 progress')
  // 落库类型必须是 idea（records.type CHECK 只允许 idea/material/todo）
  assert.equal((ideaInserts[0] as Record<string, unknown>).type, 'idea')
})

test('R5：finish 只按非空焦点创建待办（最多 3 条），第 2 步 next_action 不建待办', async () => {
  const progress: ReviewWizardProgress = {
    version: 1,
    step: 5,
    weekStart: '2026-10-19',
    startedAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    completedAt: null,
    completedRecordId: null,
    inbox: [{ recordId: 1, decision: 'assign', category: '工作' }],
    nextActions: [{ category: '工作', text: '补一份需求文档' }],
    waiting: [],
    health: [],
    focus: ['焦点一', '   ', '焦点三', '超出的第四条'],
    aiFailed: false,
  }
  const stats = { inbox: 1, waiting: 0, stale: [], aiSummary: '摘要', aiFailed: false }

  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([
    { data: [row({ id: 601, type: 'idea' })] },
    { data: [row({ id: 602, type: 'todo' })] },
    { data: [row({ id: 603, type: 'todo' })] },
    { data: [row({ id: 604, type: 'todo' })] },
  ])
  await reviewWizardService.finish(progress, stats)

  const types = __dbInserts.map((i) => (i as Record<string, unknown>).type)
  assert.deepEqual(types, ['idea', 'todo', 'todo', 'todo'], '1 条回顾 + 去掉空白后的 3 条焦点（第 4 条被 slice 丢弃）')
  assert.deepEqual(
    __dbInserts.slice(1).map((i) => (i as Record<string, unknown>).title),
    ['焦点一', '焦点三', '超出的第四条'],
    '空白焦点被过滤、只保留前 3 条',
  )
  const todo = __dbInserts[1] as Record<string, unknown>
  assert.equal(todo.priority, 'high')
  assert.equal(todo.todo_status, 'pending')
  assert.equal(todo.title, '焦点一')
  // 第 2 步的 next_action 只进正文，不额外建待办（待办总数只因第 5 步变化）
  assert.equal(types.filter((t) => t === 'todo').length, 3)
})

test('R5：进度过期边界 —— 恰好 24h 不过期，> 24h 或跨周才过期；updatedAt 非法按过期处理', () => {
  const now = cn('10:00', '2026-10-21')
  const weekStart = '2026-10-19'
  const base = {
    version: 1 as const,
    step: 1 as const,
    weekStart,
    startedAt: new Date(now - PROGRESS_TTL_MS).toISOString(),
    inbox: [],
    nextActions: [],
    waiting: [],
    health: [],
    focus: ['', '', ''],
  }
  assert.equal(
    isProgressExpired({ ...base, updatedAt: new Date(now - PROGRESS_TTL_MS).toISOString() }, now, TZ),
    false,
    '恰好 24h 不过期（严格大于才过期）',
  )
  assert.equal(
    isProgressExpired({ ...base, updatedAt: new Date(now - PROGRESS_TTL_MS - 1).toISOString() }, now, TZ),
    true,
  )
  assert.equal(isProgressExpired({ ...base, updatedAt: 'garbage' }, now, TZ), true)
  // 跨周：weekStart 是上一周
  assert.equal(
    isProgressExpired({ ...base, weekStart: '2026-10-12', updatedAt: new Date(now).toISOString() }, now, TZ),
    true,
  )
})

test('R5：回顾正文始终含 5 个二级标题（含 AI 失败分支）', () => {
  const progress: ReviewWizardProgress = {
    version: 1,
    step: 5,
    weekStart: '2026-10-19',
    startedAt: '2026-10-19T00:00:00.000Z',
    updatedAt: '2026-10-19T00:00:00.000Z',
    completedAt: null,
    completedRecordId: null,
    inbox: [],
    nextActions: [],
    waiting: [],
    health: [],
    focus: ['', '', ''],
    aiFailed: true,
  }
  const body = buildReviewNoteBody(progress, { inbox: 0, waiting: 0, stale: [], aiFailed: true })
  for (const title of ['清空收件箱', '下一步行动', '等待中', '项目健康', '下周焦点']) {
    assert.ok(body.includes(`## ${title}`), `正文缺少小节：${title}`)
  }
  assert.ok(body.includes('本次未能生成建议'))
})

/* ========================================================================== */
/* R6 · ICS 导出                                                               */
/* ========================================================================== */

/** 展开折行（续行以单空格开头）。 */
function unfold(content: string): string[] {
  const logical: string[] = []
  for (const physical of content.split(ICS_CRLF)) {
    if (physical === '') continue
    if (physical.startsWith(' ') && logical.length > 0) {
      logical[logical.length - 1] += physical.slice(1)
    } else {
      logical.push(physical)
    }
  }
  return logical
}

/** ICS 源记录。 */
function icsSrc(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    title: '交周报',
    content: null as string | null,
    category: null as string | null,
    priority: null as 'high' | 'medium' | 'low' | null,
    todoStatus: 'pending' as 'pending' | 'done' | null,
    remindAt: cnIso('09:00') as string | null,
    updatedAt: '2026-10-26T00:00:00.000Z' as string | null,
    ...over,
  }
}

test('R6：超长中文 + emoji 标题 —— 每物理行 ≤ 75 字节、无裸 LF、展开后 SUMMARY 完整', () => {
  const title = `周报模板整理（第三季度复盘会材料）🙂${'很长的中文标题'.repeat(12)}`
  const { content, todoCount } = buildIcs([icsSrc({ title })], { dtstampIso: '2026-10-27T02:00:00.000Z' })

  assert.equal(todoCount, 1)
  const physical = content.split(ICS_CRLF)
  for (const line of physical) {
    assert.ok(
      utf8ByteLength(line) <= ICS_MAX_LINE_BYTES,
      `物理行超过 ${ICS_MAX_LINE_BYTES} 字节（${utf8ByteLength(line)}）：${line.slice(0, 20)}…`,
    )
  }
  // 只允许 CRLF：去掉所有 CRLF 后不得再残留裸 \n 或 \r
  assert.equal(/[\r\n]/.test(content.replace(/\r\n/g, '')), false, '不得出现裸 LF/CR（RFC 5545 只认 CRLF）')
  assert.ok(content.endsWith(ICS_CRLF), '文件必须以 CRLF 结束')

  const logical = unfold(content)
  assert.ok(logical.includes(`SUMMARY:${icsEscape(title)}`), '折行不得丢字符，展开后须与转义后标题完全一致')
  // emoji 不得被折断（4 字节字符不能按 3 字节预算切开）
  assert.ok(content.includes('🙂'), 'emoji 不得被拆断')
})

test('R6：foldLine 边界 —— 恰好 75 字节不折、76 字节折且续行含前导空格', () => {
  const exactly = 'A'.repeat(75)
  assert.equal(foldLine(exactly), exactly, '75 字节整不折行')

  const over = 'A'.repeat(76)
  const folded = foldLine(over)
  const parts = folded.split(ICS_CRLF)
  assert.equal(parts.length, 2)
  assert.equal(parts[0].length, 75)
  assert.equal(parts[1], ' A', '续行以 1 个空格开头，且该空格计入下一行')
  assert.equal(unfold(`${folded}`).join(''), over)

  // 中文 3 字节/字：25 字 = 75 字节（不折），26 字 = 78 字节（折）
  assert.equal(foldLine('中'.repeat(25)).split(ICS_CRLF).length, 1)
  assert.equal(foldLine('中'.repeat(26)).split(ICS_CRLF).length, 2)
})

test('R6：转义顺序（先 \\ 再 ; , 再换行）在折行后仍可还原', () => {
  const title = 'a\\b;c,d\ne'
  const escaped = 'a\\\\b\\;c\\,d\\ne'
  assert.equal(icsEscape(title), escaped)

  const { content } = buildIcs([icsSrc({ title })], { dtstampIso: '2026-10-27T02:00:00.000Z' })
  const logical = unfold(content)
  assert.ok(logical.includes(`SUMMARY:${escaped}`), '展开后应重现一次性转义的结果（不得二次转义）')
})

test('R6：二次导出除 DTSTAMP 外完全一致（UID 稳定，重复导入不产生重复事件）', () => {
  const records = [
    icsSrc({ id: 11, title: '交周报' }),
    icsSrc({ id: 12, title: '评审', remindAt: null, todoStatus: 'done' }),
  ]
  const a = buildIcs(records, { dtstampIso: '2026-10-27T02:00:00.000Z', includeDone: true }).content
  const b = buildIcs(records, { dtstampIso: '2026-11-03T09:30:00.000Z', includeDone: true }).content

  const strip = (s: string) => s.split(ICS_CRLF).filter((l) => !l.startsWith('DTSTAMP:')).join(ICS_CRLF)
  assert.equal(strip(a), strip(b), '除 DTSTAMP 外必须逐字节一致')
  assert.equal(a.includes('UID:record-11@personal-agent'), true)
  assert.equal(a.includes('UID:record-11-event@personal-agent'), true)
  assert.equal(a.includes('UID:record-12@personal-agent'), true)
  assert.equal(a.includes('UID:record-12-event@personal-agent'), false, '无提醒时间不产 VEVENT')
})

test('R6：导出内容不含任何账号标识（只有 UID 域 @personal-agent）', () => {
  const { content } = buildIcs([icsSrc({ id: 21 })], { dtstampIso: '2026-10-27T02:00:00.000Z' })
  assert.equal(content.includes('owner_id'), false)
  const ats = content.match(/@[^\s:;]+/g) ?? []
  assert.deepEqual([...new Set(ats)], ['@personal-agent'], '除 @personal-agent 外不得出现其它域名/账号')
})

test('R6：源码守门 —— lib/ics.ts 既不读 Date.now() 也不调无参 new Date()（DTSTAMP 必须注入）', () => {
  const source = readFileSync(resolve(__dirname, '..', '..', 'web/src/lib/ics.ts'), 'utf8')
  // 先剥注释（文件头注释里写了「不读 Date.now()」），只检查真正的代码
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /Date\.now\s*\(/, '纯函数不得读当前时钟')
  assert.doesNotMatch(code, /new\s+Date\s*\(\s*\)/, '无参 new Date() 同样不可重放')
  assert.match(source, /dtstampIso/)
})

/* 收尾：确保全局桩不残留（若上面某个用例 throw，afterEach 仍会清） */
afterEach(() => {
  Date.now = realNow
  clearEnv()
})
