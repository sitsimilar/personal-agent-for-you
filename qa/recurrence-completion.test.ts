/**
 * v2.13 R3 循环「按完成日重复」测试。
 *
 * 两组断言：
 * 1. **回归**：`mode` 缺省 / `'due'` / 非法值时，`computeNext()` 行为与 v2.12.2 完全一致
 *    （基准是上一期 `remind_at`）；
 * 2. **新增**：`mode='completion'` 时基准是完成日的同一时分，`advance()` 三条分支
 *    （daily / weekly+weekdays / monthly+anchorDay 短月夹取 / endDate 越界）逻辑不变。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeNext, describeRecurrence, normalizeMode, normalizeRecurrenceRule } from '../web/src/lib/recurrence'
import type { RecurrenceRule } from '../shared/types/domain'

const TZ = 480

/** 把 ISO 转成东八区墙钟字段，便于断言「日期 + 时分」。 */
function wall(iso: string, tz = TZ): { key: string; hour: number; minute: number; dow: number } {
  const d = new Date(Date.parse(iso) + tz * 60_000)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return {
    key: `${y}-${m}-${day}`,
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    dow: d.getUTCDay(),
  }
}

const rule = (over: Partial<RecurrenceRule> & Pick<RecurrenceRule, 'freq'>): RecurrenceRule => ({
  interval: 1,
  endDate: null,
  ...over,
})

test('归一：normalizeMode 只认 completion（due / 缺省 / 非法值一律 undefined）', () => {
  assert.equal(normalizeMode('completion'), 'completion')
  assert.equal(normalizeMode('due'), undefined)
  assert.equal(normalizeMode('COMPLETION'), undefined)
  assert.equal(normalizeMode(undefined), undefined)
  assert.equal(normalizeMode(1), undefined)
})

test('归一：旧数据（无 mode 键）不新增键，completion 才落键', () => {
  const legacy = normalizeRecurrenceRule({ freq: 'daily', interval: 2 })
  assert.ok(legacy)
  assert.equal('mode' in legacy, false)

  const illegal = normalizeRecurrenceRule({ freq: 'daily', interval: 2, mode: 'weekly-ish' })
  assert.ok(illegal)
  assert.equal('mode' in illegal, false)

  const completion = normalizeRecurrenceRule({ freq: 'daily', interval: 2, mode: 'completion' })
  assert.ok(completion)
  assert.equal(completion.mode, 'completion')
})

test('回归 due：daily/interval=2 仍以原 remind_at 为基准（完成日晚 2 天也不变）', () => {
  const result = computeNext(rule({ freq: 'daily', interval: 2 }), {
    remindAt: '2026-10-12T09:00:00+08:00',
    nowIso: '2026-10-14T23:50:00+08:00', // 实际完成日 = 提醒日 + 2
    tzOffsetMinutes: TZ,
  })
  assert.equal(result.ruleEnded, false)
  const w = wall(result.nextRemindIso as string)
  assert.equal(w.key, '2026-10-14') // 原 remind_at + 2 天（v2.12.2 行为）
  assert.equal(w.hour, 9)
})

test('completion：完成日为 10-14 时，下一期 = 完成日 + 2 天 09:00（时分取原 remind_at）', () => {
  const result = computeNext(rule({ freq: 'daily', interval: 2, mode: 'completion' }), {
    remindAt: '2026-10-12T09:00:00+08:00',
    nowIso: '2026-10-14T23:50:00+08:00',
    tzOffsetMinutes: TZ,
  })
  const w = wall(result.nextRemindIso as string)
  assert.equal(w.key, '2026-10-16')
  assert.equal(w.hour, 9) // 完成时刻 23:50 不参与时分
  assert.equal(w.minute, 0)
})

test('completion：23:50 完成、原时分 09:00 → 新一期仍是 09:00', () => {
  const result = computeNext(rule({ freq: 'daily', interval: 1, mode: 'completion' }), {
    remindAt: '2026-10-27T09:00:00+08:00',
    nowIso: '2026-10-27T23:50:00+08:00',
    tzOffsetMinutes: TZ,
  })
  const w = wall(result.nextRemindIso as string)
  assert.equal(w.key, '2026-10-28')
  assert.equal(w.hour, 9)
  assert.equal(w.minute, 0)
})

test('completion + weekly/weekdays：weekdays 优先，mode 只改基准日', () => {
  // 规则：每周一、三 09:00；10-12（周一）的期次在 10-14（周三）23:50 完成
  const result = computeNext(rule({ freq: 'weekly', weekdays: [1, 3], mode: 'completion' }), {
    remindAt: '2026-10-12T09:00:00+08:00',
    nowIso: '2026-10-14T23:50:00+08:00',
    tzOffsetMinutes: TZ,
  })
  const w = wall(result.nextRemindIso as string)
  assert.equal(w.key, '2026-10-19') // 基准变成 10-14 → 下一个选中日 = 下周一
  assert.equal(w.dow, 1)
  assert.equal(w.hour, 9)
})

test('completion + monthly/anchorDay=31：短月夹取到月末，之后回到 31 日', () => {
  const result = computeNext(
    rule({ freq: 'monthly', anchorDay: 31, interval: 1, mode: 'completion' }),
    {
      remindAt: '2026-01-01T09:00:00+08:00',
      nowIso: '2026-01-31T20:00:00+08:00', // 1-31 完成 → 基准 1-31
      tzOffsetMinutes: TZ,
    },
  )
  const w = wall(result.nextRemindIso as string)
  assert.equal(w.key, '2026-02-28') // 2 月无 31 日 → 夹取到 28 日
  assert.equal(w.hour, 9)
})

test('completion + endDate：推进后的本地日越界 → ruleEnded，且不生成下一期', () => {
  const result = computeNext(rule({ freq: 'daily', interval: 2, mode: 'completion', endDate: '2026-10-10' }), {
    remindAt: '2026-10-01T09:00:00+08:00',
    nowIso: '2026-10-09T12:00:00+08:00', // 完成日 10-09 → 下一期 10-11 > 10-10
    tzOffsetMinutes: TZ,
  })
  assert.equal(result.ruleEnded, true)
  assert.equal(result.nextRemindIso, null)
})

test('completion：remind_at 为空 → 下一期无提醒时间（不推进、不抛错）', () => {
  const result = computeNext(rule({ freq: 'daily', interval: 1, mode: 'completion' }), {
    remindAt: null,
    nowIso: '2026-10-27T23:50:00+08:00',
    tzOffsetMinutes: TZ,
  })
  assert.equal(result.nextRemindIso, null)
  assert.equal(result.ruleEnded, false)
})

test('非法 mode 值：按 due 处理（与旧行为一致）', () => {
  const result = computeNext(
    { freq: 'daily', interval: 2, endDate: null, mode: 'UNKNOWN' as unknown as 'completion' },
    {
      remindAt: '2026-10-12T09:00:00+08:00',
      nowIso: '2026-10-14T23:50:00+08:00',
      tzOffsetMinutes: TZ,
    },
  )
  assert.equal(wall(result.nextRemindIso as string).key, '2026-10-14')
})

test('文案：completion 追加「（按完成日）」', () => {
  assert.equal(describeRecurrence(rule({ freq: 'daily', interval: 2, mode: 'completion' })), '每 2 天（按完成日）')
  assert.equal(describeRecurrence(rule({ freq: 'daily', interval: 2 })), '每 2 天')
  assert.equal(describeRecurrence(rule({ freq: 'daily', interval: 2, mode: 'due' })), '每 2 天')
})
