/**
 * v2.13 R4「稍后提醒（snooze）」测试。
 *
 * 三段：
 * 1. 纯函数（`web/src/lib/reminder-schedule.ts`）：三段式去重键、`parseDedupeKey`
 *    对旧两段键的兼容、`pruneFired` **不误删**三段键（PRD R4 风险 ①：误删会导致
 *    「每 30s 弹一次」的轰炸）、`effectiveFireAt` 的优先级（snoozed_until 不再减提前量）；
 * 2. `reminderService.snooze()`：参数校验、只写 `snoozed_until` / `snooze_count`、
 *    连续推迟时计数递增；以及复位时机（完成待办 / 改提醒时间）；
 * 3. 调度链路（`tickNow()`）：推迟到点重弹一次、同一轮不重复、连续 3 轮各自一次、
 *    升级前的旧两段键命中时不重弹（但轮次 > 0 时忽略旧键，否则推后再也弹不出来）。
 *
 * 注意：`firedInMemory` 是模块级状态，每个用例使用**不同的记录 id** 互不串扰。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  __dbCalls,
  __dbUpdates,
  __queueDbResults,
  __resetDbCalls,
  __resetDbQueue,
  __resetDbWrites,
  __setDbResult,
} from './mocks/cloud'
import {
  dedupeKey,
  effectiveFireAt,
  isSnoozePending,
  legacyDedupeKey,
  parseDedupeKey,
  pruneFired,
} from '../web/src/lib/reminder-schedule'
import type { RecordsRow } from '../web/src/lib/database.types'

const FIRED_KEY = 'personal-agent.reminder.fired.v1'

/** 东八区墙钟 → epoch ms。 */
function at(hhmm: string, day = '2026-10-12'): number {
  return Date.parse(`${day}T${hhmm}:00+08:00`)
}

/** 记录 remind_at 的 ISO 形态（去重键的第二段）。 */
function iso(hhmm: string, day = '2026-10-12'): string {
  return new Date(at(hhmm, day)).toISOString()
}

/* ------------------------------ 环境注入 ------------------------------ */

interface Sent {
  title: string
  body: string
  recordId: number
  key: string
}

interface Harness {
  sent: Sent[]
  firedKeys: () => string[]
  /** 预置一条已弹记录（模拟升级前写入的旧两段键）。 */
  seedFired: (key: string, ts: number) => void
}

interface FakeWindow {
  setTimeout: (fn: () => void, ms?: number) => number
  clearTimeout: (id: number) => void
  setInterval: (fn: () => void, ms?: number) => number
  clearInterval: (id: number) => void
  location: { search: string }
  desktopBridge?: {
    notify: (payload: Sent) => Promise<{ ok: boolean; message?: string }>
    onNotificationClicked: () => () => void
  }
}

function makeLocalStorage(): {
  getItem: (k: string) => string | null
  setItem: (k: string, v: string) => void
} {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
  }
}

function installEnv(): Harness {
  const sent: Sent[] = []
  const store = makeLocalStorage()

  const windowStub: FakeWindow = {
    // 应用内提示的自动消失定时器不参与断言：空实现避免挂住事件循环
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    setInterval: (fn, ms) => globalThis.setInterval(fn, ms) as unknown as number,
    clearInterval: (id) => globalThis.clearInterval(id),
    location: { search: '' },
    desktopBridge: {
      notify: async (payload) => {
        sent.push(payload)
        return { ok: true }
      },
      onNotificationClicked: () => () => undefined,
    },
  }

  ;(globalThis as unknown as { window: unknown }).window = windowStub
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

/* ------------------------------ 数据构造 ------------------------------ */

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

function todoRow(over: Partial<RecordsRow> = {}): RecordsRow {
  return {
    id: 42,
    owner_id: 'u1',
    type: 'todo',
    title: '交周报',
    content: null,
    url: null,
    file_path: null,
    category: '工作',
    tags: [],
    summary: null,
    todo_status: 'pending',
    priority: 'high',
    remind_at: iso('10:00'),
    recurrence: null,
    recurrence_parent_id: null,
    recurrence_next_id: null,
    link_meta: null,
    is_deleted: false,
    deleted_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  } as RecordsRow
}

/* --------------------------- 模块加载与时钟控制 --------------------------- */

const realNow = Date.now
const realTz = process.env.TZ

let reminderModule: typeof import('../web/src/services/reminderService')
let recordModule: typeof import('../web/src/services/recordService')

beforeEach(async () => {
  process.env.TZ = 'Asia/Shanghai'
  __resetDbCalls()
  __resetDbQueue()
  __resetDbWrites()
  __setDbResult({ data: [] })
  reminderModule = await import('../web/src/services/reminderService')
  recordModule = await import('../web/src/services/recordService')
  reminderModule.invalidateSettingsCache()
})

afterEach(() => {
  Date.now = realNow
  if (realTz === undefined) delete process.env.TZ
  else process.env.TZ = realTz
  clearEnv()
})

/** 跑一次调度 tick（设置缓存显式失效，保证每次都读设置）。 */
async function tick(
  settings: Record<string, unknown>,
  records: RecordsRow[],
  nowMs: number,
): Promise<void> {
  __resetDbCalls()
  __resetDbQueue()
  reminderModule.invalidateSettingsCache()
  __queueDbResults([{ data: settings }, { data: records }])
  Date.now = () => nowMs
  await reminderModule.reminderService.tickNow()
}

/* ============================== 1. 纯函数 ============================== */

test('dedupeKey：三段式 id|remind_at|snooze序号；parseDedupeKey 可往返解析', () => {
  const remind = '2026-10-12T02:00:00.000Z'
  const key = dedupeKey(7, remind, 2)
  assert.equal(key, `7|${remind}|2`)
  assert.deepEqual(parseDedupeKey(key), { recordId: 7, remindAt: remind, snoozeToken: 2 })
  // 第三段缺省 → 0（原始提醒）
  assert.deepEqual(parseDedupeKey(dedupeKey(7, remind)), { recordId: 7, remindAt: remind, snoozeToken: 0 })
})

test('parseDedupeKey：兼容 v2.12.2 旧两段键（token 视作 0），结构非法返回 null', () => {
  const remind = '2026-10-12T02:00:00.000Z'
  assert.deepEqual(parseDedupeKey(legacyDedupeKey(9, remind)), {
    recordId: 9,
    remindAt: remind,
    snoozeToken: 0,
  })
  assert.equal(parseDedupeKey('badkey'), null, '段数不足应判非法')
  assert.equal(parseDedupeKey(`abc|${remind}|0`), null, 'id 非正整数应判非法')
  assert.equal(parseDedupeKey('7|not-a-date|0'), null, '时间不可解析应判非法')
  assert.equal(parseDedupeKey('7|'), null, '空时间应判非法')
})

test('pruneFired：三段键不会被误删（PRD R4 风险 ①「30s 轰炸」的守门断言）', () => {
  const now = Date.parse('2026-10-20T00:00:00+08:00')
  const remind = '2026-10-19T10:00:00+08:00'
  const expiredRemind = '2026-01-01T10:00:00+08:00'

  const store = {
    [dedupeKey(1, remind, 0)]: now - 1000,
    [dedupeKey(1, remind, 1)]: now - 900,
    [dedupeKey(1, remind, 3)]: now - 800,
    [legacyDedupeKey(2, remind)]: now - 700,
    'badkey': now,
    [dedupeKey(3, expiredRemind, 0)]: now - 100 * 86_400_000,
  }

  const pruned = pruneFired(store, now)
  assert.deepEqual(
    Object.keys(pruned).sort(),
    [dedupeKey(1, remind, 0), dedupeKey(1, remind, 1), dedupeKey(1, remind, 3), legacyDedupeKey(2, remind)].sort(),
    '三段键与旧两段键都必须保留，只清理过期键与非法键',
  )
})

test('pruneFired 反证：若沿用旧写法（截到第一个 | 之后）三段键的时间会解析成 NaN 而被清', () => {
  const remind = '2026-10-19T10:00:00+08:00'
  const key = dedupeKey(1, remind, 3)
  const oldStyle = key.slice(key.indexOf('|') + 1) // 'remind_at|3'
  assert.ok(Number.isNaN(Date.parse(oldStyle)), '这正是「每 30s 弹一次」的成因，必须用 split("|")[1]')
  assert.equal(parseDedupeKey(key)?.remindAt, remind)
})

test('effectiveFireAt：有 snoozed_until 时直接以它为触发点，不再减提前量', () => {
  const remindAt = '2026-10-12T02:00:00.000Z'
  const snoozed = '2026-10-12T02:10:00.000Z'
  assert.equal(effectiveFireAt({ remindAt, snoozedUntil: snoozed }, 10), Date.parse(snoozed))
  // 无 snooze → 回落到 remind_at − 提前量
  assert.equal(effectiveFireAt({ remindAt, snoozedUntil: null }, 10), Date.parse(remindAt) - 10 * 60_000)
  assert.equal(effectiveFireAt({ remindAt, snoozedUntil: null }, 0), Date.parse(remindAt))
  // snoozed_until 不可解析 → 回落到原路径
  assert.equal(effectiveFireAt({ remindAt, snoozedUntil: 'oops' }, 0), Date.parse(remindAt))
  // 两者都没有 → NaN，调用方跳过
  assert.ok(Number.isNaN(effectiveFireAt({ remindAt: null, snoozedUntil: null }, 5)))
  // 时钟回拨：snoozed_until 落在过去时照实返回（由 shouldFire 立即补弹一次）
  const past = '2026-10-12T01:00:00.000Z'
  assert.equal(effectiveFireAt({ remindAt, snoozedUntil: past }, 30), Date.parse(past))
})

test('isSnoozePending：只在「已推迟且未到点」时为 true，到点后 Chip 不再显示（L2）', () => {
  const now = at('10:05')
  assert.equal(isSnoozePending({ snoozedUntil: iso('10:10') }, now), true)
  assert.equal(isSnoozePending({ snoozedUntil: iso('10:00') }, now), false, '推迟时间已过 → 不再显示')
  assert.equal(isSnoozePending({ snoozedUntil: iso('10:05') }, now), false, '正好到点即视为已到期')
  assert.equal(isSnoozePending({ snoozedUntil: null }, now), false)
  assert.equal(isSnoozePending({}, now), false, '迁移未执行（无该字段）也不显示')
  assert.equal(isSnoozePending({ snoozedUntil: 'oops' }, now), false, '非法值不显示')
  assert.equal(isSnoozePending({ snoozedUntil: iso('10:10') }, Number.NaN), false)
})

test('源码守门：TodoPage 与 RecordDetail 两处「已推迟至」Chip 共用 isSnoozePending，且无裸判空', () => {
  const read = (rel: string) => readFileSync(resolve(__dirname, '..', '..', rel), 'utf8')
  /**
   * 先剥注释再查（踩过的坑：注释里提到函数名会让 assert.match 假通过）。
   * 只剥块注释与「整行以 // 开头」的行注释——不碰行内 //（避免误伤 https:// 之类的字符串）。
   */
  const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const file of ['web/src/pages/TodoPage.tsx', 'web/src/components/RecordDetail.tsx']) {
    const code = stripComments(read(file))
    assert.match(code, /isSnoozePending\(/, `${file} 必须用 isSnoozePending 判定推迟是否仍有效`)
    assert.doesNotMatch(code, /snoozedUntil\s*&&/, `${file} 不得再用「只判非空」的裸写法`)
  }
})

/* ============================ 2. snooze() 服务 ============================ */

test('snooze：只写 snoozed_until + snooze_count（count 为旧值 +1），不改 remind_at', async () => {
  Date.now = () => at('10:00')
  __queueDbResults([
    { data: todoRow({ id: 9, snooze_count: 0, snoozed_until: null }) },
    { data: [todoRow({ id: 9, snooze_count: 1, snoozed_until: iso('10:10') })] },
  ])

  const updated = await reminderModule.reminderService.snooze(9, 10)

  assert.equal(updated.snoozeCount, 1)
  const payload = __dbUpdates[__dbUpdates.length - 1] ?? {}
  assert.deepEqual(Object.keys(payload).sort(), ['snooze_count', 'snoozed_until'], '不得改动 remind_at')
  assert.equal(payload.snoozed_until, iso('10:10'))
  assert.equal(payload.snooze_count, 1)
})

test('snooze：连续推迟时在已推迟值上继续递增（2 → 3）', async () => {
  Date.now = () => at('10:20')
  __queueDbResults([
    { data: todoRow({ id: 12, snooze_count: 2, snoozed_until: iso('10:20') }) },
    { data: [todoRow({ id: 12, snooze_count: 3, snoozed_until: iso('11:20') })] },
  ])

  const updated = await reminderModule.reminderService.snooze(12, 60)
  assert.equal(updated.snoozeCount, 3)
  const payload = __dbUpdates[__dbUpdates.length - 1] ?? {}
  assert.equal(payload.snooze_count, 3)
  assert.equal(payload.snoozed_until, iso('11:20'))
})

test('snooze：时长不在 SNOOZE_OPTIONS 内直接抛错，且不发任何请求', async () => {
  __resetDbCalls()
  await assert.rejects(() => reminderModule.reminderService.snooze(9, 45), /不支持的推迟时长/)
  await assert.rejects(() => reminderModule.reminderService.snooze(9, 0), /不支持的推迟时长/)
  assert.equal(__dbCalls.length, 0, '参数非法不应触达数据库')
})

test('snooze：非「未完成待办」或已删除记录抛错', async () => {
  __queueDbResults([{ data: null }])
  await assert.rejects(() => reminderModule.reminderService.snooze(11, 10), /记录不存在或已删除/)

  __queueDbResults([{ data: todoRow({ id: 10, todo_status: 'done' }) }])
  await assert.rejects(() => reminderModule.reminderService.snooze(10, 10), /该记录不是待办/)

  __queueDbResults([{ data: todoRow({ id: 13, type: 'idea', todo_status: null }) }])
  await assert.rejects(() => reminderModule.reminderService.snooze(13, 10), /该记录不是待办/)
})

test('SNOOZE_OPTIONS：10 / 30 / 60 分钟，且全部小于 12h 候选窗口（否则推迟后会被判 drop）', () => {
  assert.deepEqual([...reminderModule.SNOOZE_OPTIONS], [10, 30, 60])
  for (const m of reminderModule.SNOOZE_OPTIONS) assert.ok(m * 60_000 < 12 * 60 * 60 * 1000)
})

/* ============================ 复位时机（R4 §5.4） ============================ */

test('复位：完成待办（有 snooze 状态）→ 写 snoozed_until=null / snooze_count=0', async () => {
  __resetDbWrites()
  __queueDbResults([
    { data: [todoRow({ id: 20, todo_status: 'done', snooze_count: 2, snoozed_until: iso('10:10') })] },
  ])

  await recordModule.recordService.updateTodoStatus(20, 'done')

  assert.equal(__dbUpdates.length, 2, '一次改状态 + 一次复位')
  assert.deepEqual(Object.keys(__dbUpdates[0]), ['todo_status'])
  const reset = __dbUpdates[1] ?? {}
  assert.deepEqual(Object.keys(reset).sort(), ['snooze_count', 'snoozed_until'])
  assert.equal(reset.snoozed_until, null)
  assert.equal(reset.snooze_count, 0)
})

test('复位：完成待办（无 snooze 状态）不发复位请求（不给常规路径加写入）', async () => {
  __resetDbWrites()
  __queueDbResults([
    { data: [todoRow({ id: 21, todo_status: 'done', snooze_count: 0, snoozed_until: null })] },
  ])

  await recordModule.recordService.updateTodoStatus(21, 'done')

  assert.equal(__dbUpdates.length, 1)
  assert.deepEqual(Object.keys(__dbUpdates[0]), ['todo_status'])
})

test('复位：改 remind_at（有 snooze 状态）→ 复位，回到原始轮次键', async () => {
  __resetDbWrites()
  const newRemind = iso('15:00')
  __queueDbResults([
    { data: [todoRow({ id: 22, remind_at: newRemind, snooze_count: 1, snoozed_until: iso('10:10') })] },
  ])

  const updated = await recordModule.recordService.updateRecord(22, { remindAt: newRemind })

  assert.equal(__dbUpdates.length, 2)
  const reset = __dbUpdates[1] ?? {}
  assert.equal(reset.snooze_count, 0)
  assert.equal(reset.snoozed_until, null)
  // 复位后调度重新从「原始轮次键」开始
  assert.equal(dedupeKey(updated.id, updated.remindAt ?? '', updated.snoozeCount ?? 0), `22|${newRemind}|0`)
})

test('复位：改 remind_at（无 snooze 状态）不发复位请求', async () => {
  __resetDbWrites()
  const newRemind = iso('15:00')
  __queueDbResults([
    { data: [todoRow({ id: 23, remind_at: newRemind, snooze_count: 0, snoozed_until: null })] },
  ])

  await recordModule.recordService.updateRecord(23, { remindAt: newRemind })
  assert.equal(__dbUpdates.length, 1, '只有 remind_at 那一次更新')
})

test('复位：resetSnoozeState 是 best-effort（写失败不抛错，不打断完成待办）', async () => {
  __resetDbWrites()
  __setDbResult({ data: null, error: { code: '42703', message: 'column "snoozed_until" does not exist' } })
  await assert.doesNotReject(() => recordModule.recordService.resetSnoozeState(24))
  assert.equal(__dbUpdates.length, 1, '复位请求仍会发出（只是失败被吞掉）')
})

/* ============================== 3. 调度链路 ============================== */

test('调度：snooze 到点重弹一次，键为下一轮次；同一轮重复 tick 不重弹', async () => {
  const env = installEnv()
  const id = 71
  const remind = iso('10:00')

  // 第一轮：原始提醒弹出，键 token=0
  await tick(settingsRow(), [todoRow({ id, remind_at: remind, snooze_count: 0 })], at('10:00'))
  assert.equal(env.sent.length, 1)
  assert.equal(env.sent[0].key, `${id}|${remind}|0`)

  // 用户点了「稍后 10 分钟」：snoozed_until = 10:10；10:05 tick 未到点不弹
  await tick(
    settingsRow(),
    [todoRow({ id, remind_at: remind, snooze_count: 1, snoozed_until: iso('10:10') })],
    at('10:05'),
  )
  assert.equal(env.sent.length, 1, '未到 snoozed_until 不应弹')

  // 10:10 到点 → 弹一次，键 token=1
  await tick(
    settingsRow(),
    [todoRow({ id, remind_at: remind, snooze_count: 1, snoozed_until: iso('10:10') })],
    at('10:10'),
  )
  assert.equal(env.sent.length, 2)
  assert.equal(env.sent[1].key, `${id}|${remind}|1`)

  // 同一轮再 tick 不重弹
  await tick(
    settingsRow(),
    [todoRow({ id, remind_at: remind, snooze_count: 1, snoozed_until: iso('10:10') })],
    at('10:10') + 30_000,
  )
  assert.equal(env.sent.length, 2, '同一轮次只弹一次')
})

test('调度：连续 snooze 3 次，每轮各弹一次；三段键全部留在 localStorage（未被 prune 误删）', async () => {
  const env = installEnv()
  const id = 72
  const remind = iso('10:00')
  const rounds = [
    { now: at('10:00'), count: 0, snoozed: null as string | null, key: `${id}|${remind}|0` },
    { now: at('10:10'), count: 1, snoozed: iso('10:10'), key: `${id}|${remind}|1` },
    { now: at('10:20'), count: 2, snoozed: iso('10:20'), key: `${id}|${remind}|2` },
    { now: at('10:30'), count: 3, snoozed: iso('10:30'), key: `${id}|${remind}|3` },
  ]

  for (const r of rounds) {
    const row = todoRow({ id, remind_at: remind, snooze_count: r.count, snoozed_until: r.snoozed })
    await tick(settingsRow(), [row], r.now)
    // 同一轮里再 tick 一次，模拟 30s 轮询
    await tick(settingsRow(), [row], r.now + 30_000)
  }

  assert.equal(env.sent.length, 4, '4 轮各弹一次')
  assert.deepEqual(env.sent.map((s) => s.key), rounds.map((r) => r.key))
  assert.deepEqual(
    env.firedKeys().sort(),
    rounds.map((r) => r.key).sort(),
    '去重键必须全部保留，否则会退化成「每 30s 弹一次」',
  )
})

test('调度：升级兼容——localStorage 只有旧两段键时不重弹', async () => {
  const env = installEnv()
  const id = 73
  const remind = iso('10:00')
  env.seedFired(legacyDedupeKey(id, remind), at('10:00'))

  await tick(settingsRow(), [todoRow({ id, remind_at: remind, snooze_count: 0 })], at('10:00'))
  assert.equal(env.sent.length, 0, '旧键命中即视为已弹过')
})

test('调度：轮次 > 0 时忽略旧两段键（否则推迟后再也弹不出来）', async () => {
  const env = installEnv()
  const id = 74
  const remind = iso('10:00')
  env.seedFired(legacyDedupeKey(id, remind), at('10:00'))

  await tick(
    settingsRow(),
    [todoRow({ id, remind_at: remind, snooze_count: 1, snoozed_until: iso('10:10') })],
    at('10:10'),
  )
  assert.equal(env.sent.length, 1, 'token>0 时旧键不应挡住新一轮')
  assert.equal(env.sent[0].key, `${id}|${remind}|1`)
})

test('调度：提前量只作用于未推迟的提醒（snoozed_until 精准触发）', async () => {
  const env = installEnv()
  const id = 75
  const remind = iso('10:00')

  // 提前量 10 分钟：未推迟时 09:50 就该弹
  await tick(settingsRow({ remind_lead_minutes: 10 }), [todoRow({ id, remind_at: remind, snooze_count: 0 })], at('09:50'))
  assert.equal(env.sent.length, 1)
  assert.equal(env.sent[0].key, `${id}|${remind}|0`)

  // 已推迟到 10:10：09:50 + 提前量不得提前触发（否则刚点完就弹）
  const id2 = 76
  await tick(
    settingsRow({ remind_lead_minutes: 10 }),
    [todoRow({ id: id2, remind_at: remind, snooze_count: 1, snoozed_until: iso('10:10') })],
    at('10:00'),
  )
  assert.equal(env.sent.length, 1, 'snoozed_until 之前不应弹（不再减提前量）')

  await tick(
    settingsRow({ remind_lead_minutes: 10 }),
    [todoRow({ id: id2, remind_at: remind, snooze_count: 1, snoozed_until: iso('10:10') })],
    at('10:10'),
  )
  assert.equal(env.sent.length, 2)
  assert.equal(env.sent[1].key, `${id2}|${remind}|1`)
})
