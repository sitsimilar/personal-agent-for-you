/**
 * P0-3 下半 · 订阅抓取与提醒链路的**隔离**验证（对抗性）。
 *
 * 工程师在 `reminderService.tickNow()` 里新增了 `scheduleFeedTick()`（挂到下一个宏任务）。
 * 这条改动落在提醒主链路上，是本期唯一可能"污染既有功能"的地方，因此单独验证三件事：
 * 1. **不冒泡**：`runFeedTickIfDue` 直接抛异常时 `tickNow()` 仍正常 resolve，且不产生未处理的 Promise 拒绝；
 * 2. **不插队**：订阅抓取发生在 tickNow 的**后续宏任务**里，不在同步查询序列中（`tickNow` 返回时还没跑）；
 * 3. **安静窗口正确透传**：免打扰时段 `quiet: true` 会传进去（半夜不抓订阅），非免打扰时段不是 true。
 *
 * 用 `qa/mocks/feedService.ts` 替换 `runFeedTickIfDue`（见 qa/run-tests.mjs 的 alias）：
 * 真实现会发网络与写库，与本用例要验证的隔离性无关。
 */
import { test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { __queueDbResults, __resetDbCalls, __resetDbQueue, __setDbResult } from './mocks/cloud'
import { __feedTickCalls, __resetFeedTickMock, __setFeedTickMock } from './mocks/feedService'

/** 东八区墙钟 → epoch ms。 */
function at(hhmm: string, day = '2026-11-06'): number {
  return Date.parse(`${day}T${hhmm}:00+08:00`)
}

/** settings 行（`notify_enabled: false` 让 tickNow 在读完设置后立刻返回，避开通知链路）。 */
function settingsRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    owner_id: 'u1',
    notify_enabled: false,
    remind_lead_minutes: 0,
    quiet_hours_enabled: false,
    quiet_start: '22:00',
    quiet_end: '08:00',
    ...over,
  }
}

/* ------------------------------ 环境注入 ------------------------------ */

/** 待触发的宏任务（`scheduleFeedTick` 的回调会进这个队列）。 */
let timers: Array<() => void> = []

/** 装上假 window（`setTimeout` 只入队不执行，便于断言「还没跑」）+ 固定时钟。 */
function installEnv(nowMs: number): void {
  timers = []
  const windowStub = {
    setTimeout: (fn: () => void) => {
      timers.push(fn)
      return timers.length
    },
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    location: { search: '' },
  }
  ;(globalThis as unknown as { window: unknown }).window = windowStub
  Date.now = () => nowMs
}

/** 触发所有挂起的宏任务，并把微任务队列冲干净（订阅回调里有 await）。 */
async function drainTimers(): Promise<void> {
  const pending = timers
  timers = []
  for (const fn of pending) fn()
  for (let round = 0; round < 4; round += 1) {
    await new Promise((resolve) => setImmediate(resolve))
  }
}

function clearEnv(): void {
  delete (globalThis as unknown as { window?: unknown }).window
}

/* ------------------------------ 用例 ------------------------------ */

const realNow = Date.now
const realTz = process.env.TZ

let reminderService: typeof import('../web/src/services/reminderService')

beforeEach(async () => {
  process.env.TZ = 'Asia/Shanghai'
  __resetDbCalls()
  __resetDbQueue()
  __setDbResult({ data: [] })
  __resetFeedTickMock()
  reminderService = await import('../web/src/services/reminderService')
  reminderService.invalidateSettingsCache()
})

afterEach(() => {
  clearEnv()
  Date.now = realNow
  if (realTz === undefined) delete process.env.TZ
  else process.env.TZ = realTz
})

test('scheduleFeedTick：订阅抓取抛异常不外溢 —— tickNow 正常 resolve，且不留未处理拒绝', async () => {
  installEnv(at('10:00'))
  __setFeedTickMock(async () => {
    throw new Error('订阅抓取炸了')
  })
  __queueDbResults([{ data: settingsRow() }])

  const rejections: unknown[] = []
  const onRejection = (reason: unknown): void => {
    rejections.push(reason)
  }
  process.on('unhandledRejection', onRejection)

  try {
    await assert.doesNotReject(
      () => reminderService.tickNow(),
      '订阅抓取抛错绝不能冒泡到提醒调度器',
    )
    await drainTimers()

    assert.equal(__feedTickCalls.length, 1, '回调必须真的执行到 runFeedTickIfDue（否则这条用例是空断言）')
    assert.deepEqual(rejections, [], '不得留下未处理的 Promise 拒绝（void + try/catch 必须覆盖完整）')
  } finally {
    process.off('unhandledRejection', onRejection)
  }
})

test('scheduleFeedTick：抓取挂在下一个宏任务，tickNow 返回时还没执行（不插队）', async () => {
  installEnv(at('10:00'))
  __queueDbResults([{ data: settingsRow() }])

  await reminderService.tickNow()

  assert.equal(__feedTickCalls.length, 0, 'tickNow 返回时订阅抓取不得插进本次查询序列')
  assert.equal(timers.length, 1, '应当恰好挂了一个宏任务')

  await drainTimers()
  assert.equal(__feedTickCalls.length, 1, '宏任务被触发后才执行订阅抓取')
})

test('scheduleFeedTick：免打扰窗口传 quiet:true，非免打扰不传 true', async () => {
  // 23:00 落在 22:00–08:00 跨夜窗口内
  installEnv(at('23:00'))
  __queueDbResults([{ data: settingsRow({ quiet_hours_enabled: true, quiet_start: '22:00', quiet_end: '08:00' }) }])
  await reminderService.tickNow()
  await drainTimers()

  assert.equal(__feedTickCalls.length, 1)
  assert.equal(__feedTickCalls[0]?.quiet, true, '免打扰时段必须传 quiet:true（半夜不抓订阅）')

  // 换到 10:00，同一套设置不再是免打扰
  __resetFeedTickMock()
  reminderService.invalidateSettingsCache()
  installEnv(at('10:00'))
  __queueDbResults([{ data: settingsRow({ quiet_hours_enabled: true, quiet_start: '22:00', quiet_end: '08:00' }) }])
  await reminderService.tickNow()
  await drainTimers()

  assert.equal(__feedTickCalls.length, 1)
  assert.notEqual(__feedTickCalls[0]?.quiet, true, '非免打扰时段不得误判为 quiet')
})
