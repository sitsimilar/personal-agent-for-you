/**
 * 短信验证码频控（`web/src/lib/otp-guard.ts`）单测。
 *
 * 覆盖三类边界：冷却/日限额/失败锁定的判定，脏数据归一化，以及「记录 → 判定」的
 * 时序不自相矛盾（发一条之后立刻再发必须被拦）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applySend,
  applyVerifyFailure,
  applyVerifySuccess,
  evaluateSend,
  evaluateVerify,
  formatWait,
  normalizeOtpGuard,
  OTP_LOCK_MS,
  OTP_MAX_FAILS,
  OTP_MAX_PER_DAY,
  OTP_RESEND_COOLDOWN_MS,
  OTP_WINDOW_MS,
  pruneOtpGuard,
  readOtpGuard,
  writeOtpGuard,
  type OtpGuardState,
  type StorageLike,
} from '../web/src/lib/otp-guard'

const PHONE = '13800138000'
const T0 = 1_700_000_000_000

/** 最小假存储，避免依赖 DOM 的 localStorage。 */
function fakeStorage(init?: string): StorageLike & { dump(): string | null } {
  let value = init ?? null
  return {
    getItem: () => value,
    setItem: (_k, v) => {
      value = v
    },
    removeItem: () => {
      value = null
    },
    dump: () => value,
  }
}

test('首次发码放行，且剩余条数 = 上限', () => {
  const v = evaluateSend({}, PHONE, T0)
  assert.equal(v.allowed, true)
  assert.equal(v.remaining, OTP_MAX_PER_DAY)
})

test('发一条后立刻再发被冷却拦下，等待时间不超过 60 秒', () => {
  const state = applySend({}, PHONE, T0)
  const v = evaluateSend(state, PHONE, T0 + 5_000)
  assert.equal(v.allowed, false)
  assert.equal(v.reason, 'cooldown')
  assert.ok((v.retryAfterMs ?? 0) > 0 && (v.retryAfterMs ?? 0) <= OTP_RESEND_COOLDOWN_MS)
})

test('冷却结束后可再次发送', () => {
  const state = applySend({}, PHONE, T0)
  const v = evaluateSend(state, PHONE, T0 + OTP_RESEND_COOLDOWN_MS + 1)
  assert.equal(v.allowed, true)
  assert.equal(v.remaining, OTP_MAX_PER_DAY - 1)
})

test('24 小时内达到上限即拒绝，并给到最早一条过期所需的等待时间', () => {
  let state: OtpGuardState = {}
  let now = T0
  for (let i = 0; i < OTP_MAX_PER_DAY; i += 1) {
    const v = evaluateSend(state, PHONE, now)
    assert.equal(v.allowed, true, `第 ${i + 1} 条应当放行`)
    state = applySend(state, PHONE, now)
    now += OTP_RESEND_COOLDOWN_MS + 1
  }
  const blocked = evaluateSend(state, PHONE, now)
  assert.equal(blocked.allowed, false)
  assert.equal(blocked.reason, 'daily')
  assert.equal(blocked.remaining, 0)
  assert.ok((blocked.retryAfterMs ?? 0) > 0 && (blocked.retryAfterMs ?? 0) <= OTP_WINDOW_MS)

  // 窗口是**滑动**的：过 24h 后只有最早那条过期，因此恢复 1 个名额而不是整池
  const later = evaluateSend(state, PHONE, T0 + OTP_WINDOW_MS + 1)
  assert.equal(later.allowed, true)
  assert.equal(later.remaining, 1)
})

test('不同手机号互不影响', () => {
  const state = applySend({}, PHONE, T0)
  const other = evaluateSend(state, '13900139000', T0)
  assert.equal(other.allowed, true)
})

test('连续输错 5 次锁定 15 分钟，锁定期间不允许提交', () => {
  let state: OtpGuardState = {}
  let now = T0
  for (let i = 0; i < OTP_MAX_FAILS; i += 1) {
    assert.equal(evaluateVerify(state, PHONE, now).allowed, true, `第 ${i + 1} 次输错前应可提交`)
    state = applyVerifyFailure(state, PHONE, now)
    now += 1_000
  }
  const gate = evaluateVerify(state, PHONE, now)
  assert.equal(gate.allowed, false)
  assert.ok((gate.retryAfterMs ?? 0) > 0 && (gate.retryAfterMs ?? 0) <= OTP_LOCK_MS)

  // 锁定期内发码也被拒（避免边锁边刷短信）
  const send = evaluateSend(state, PHONE, now)
  assert.equal(send.allowed, false)
  assert.equal(send.reason, 'locked')

  // 锁定到期后恢复
  assert.equal(evaluateVerify(state, PHONE, now + OTP_LOCK_MS + 1).allowed, true)
})

test('输对一次即清零失败计数与锁', () => {
  let state: OtpGuardState = {}
  for (let i = 0; i < OTP_MAX_FAILS; i += 1) state = applyVerifyFailure(state, PHONE, T0)
  assert.equal(evaluateVerify(state, PHONE, T0).allowed, false)
  state = applyVerifySuccess(state, PHONE)
  assert.equal(state[PHONE].fails, 0)
  assert.equal(state[PHONE].lockedUntil, 0)
  assert.equal(evaluateVerify(state, PHONE, T0).allowed, true)
})

test('脏数据被归一化：非数字时间戳丢弃、非法号码忽略、缺字段补零', () => {
  const state = normalizeOtpGuard({
    [PHONE]: { sent: [T0, 'x', -5, null], fails: '9', lockedUntil: 'bad' },
    abc: { sent: [T0] },
    '13900139000': null,
  })
  assert.deepEqual(state[PHONE].sent, [T0])
  assert.equal(state[PHONE].fails, 0)
  assert.equal(state[PHONE].lockedUntil, 0)
  assert.equal(state.abc, undefined)
  assert.equal(state['13900139000'], undefined)
})

test('非对象输入一律当空状态', () => {
  assert.deepEqual(normalizeOtpGuard(null), {})
  assert.deepEqual(normalizeOtpGuard('nope'), {})
  assert.deepEqual(normalizeOtpGuard([]), {})
})

test('读写存储：坏 JSON 不影响后续使用', () => {
  const storage = fakeStorage('{not json')
  assert.deepEqual(readOtpGuard(storage), {})
  writeOtpGuard(storage, applySend({}, PHONE, T0))
  const back = readOtpGuard(storage)
  assert.equal(back[PHONE].sent.length, 1)
})

test('存储不可用时读写都不抛错（隐私模式）', () => {
  const broken: StorageLike = {
    getItem: () => {
      throw new Error('denied')
    },
    setItem: () => {
      throw new Error('denied')
    },
    removeItem: () => {
      throw new Error('denied')
    },
  }
  assert.deepEqual(readOtpGuard(broken), {})
  assert.doesNotThrow(() => writeOtpGuard(broken, {}))
})

test('清理：24 小时前的记录被丢弃，锁定中的保留', () => {
  const state = applySend({}, PHONE, T0)
  // 锁定时长（15 分钟）< 统计窗口（24 小时），要验证「锁定中保留」得让锁跨过窗口
  const lockedUntil = T0 + OTP_WINDOW_MS + 60_000
  const withLock: OtpGuardState = {
    ...state,
    '13900139000': { sent: [T0], fails: OTP_MAX_FAILS, lockedUntil },
  }
  const pruned = pruneOtpGuard(withLock, T0 + OTP_WINDOW_MS + 1)
  assert.equal(pruned[PHONE], undefined, '过期号码应被清掉')
  assert.ok(pruned['13900139000'], '锁定中的号码要保留')
})

test('等待文案：秒 / 分秒 / 小时', () => {
  assert.equal(formatWait(0), '0 秒')
  assert.equal(formatWait(58_000), '58 秒')
  assert.equal(formatWait(200_000), '3 分 20 秒')
  assert.equal(formatWait(120_000), '2 分')
  assert.equal(formatWait(7_500_000), '2 小时 5 分')
})
