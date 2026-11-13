/**
 * P2-7 循环卡片「下次实例」文案（`nextInstanceLabel`）单元测试。
 *
 * 全部时区显式注入（东八区 +480），与运行机器时区无关。
 * 断言的是**显示串**：同年 `MM-DD HH:mm`，跨年 `YYYY-MM-DD HH:mm`。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextInstanceLabel } from '../web/src/lib/recurrence'
import type { RecurrenceRule } from '../shared/types/domain'

const TZ = 480

/** 构造规则（默认 interval=1 / endDate=null）。 */
const rule = (over: Partial<RecurrenceRule> & Pick<RecurrenceRule, 'freq'>): RecurrenceRule => ({
  interval: 1,
  endDate: null,
  ...over,
})

/** 东八区墙钟 ISO 快捷构造：`cn('2026-11-16T10:00')` → UTC ISO。 */
function cn(wall: string): string {
  return new Date(`${wall}:00+08:00`).toISOString()
}

const NOW = new Date(cn('2026-11-15T09:00'))

test('本期还在未来：下一次就是本期，不得先推进一期', () => {
  const label = nextInstanceLabel(rule({ freq: 'daily' }), cn('2026-11-16T10:00'), {
    now: NOW,
    tzOffsetMinutes: TZ,
  })
  assert.equal(label, '11-16 10:00')
})

test('本期已过一天：推进到下一期', () => {
  const label = nextInstanceLabel(rule({ freq: 'daily' }), cn('2026-11-14T10:00'), {
    now: NOW,
    tzOffsetMinutes: TZ,
  })
  assert.equal(label, '11-15 10:00')
})

test('逾期多期：连续推进到最近一个未过期实例', () => {
  const label = nextInstanceLabel(rule({ freq: 'daily' }), cn('2026-11-10T10:00'), {
    now: NOW,
    tzOffsetMinutes: TZ,
  })
  assert.equal(label, '11-15 10:00')
})

test('每 2 天：推进保持 interval 相位', () => {
  const label = nextInstanceLabel(rule({ freq: 'daily', interval: 2 }), cn('2026-11-10T10:00'), {
    now: NOW,
    tzOffsetMinutes: TZ,
  })
  assert.equal(label, '11-16 10:00')
})

test('weekly 多选周几：落在下一个被选中的星期', () => {
  const label = nextInstanceLabel(
    rule({ freq: 'weekly', weekdays: [1, 3] }),
    cn('2026-11-16T10:00'), // 周一
    { now: new Date(cn('2026-11-18T09:00')), tzOffsetMinutes: TZ }, // 周三 09:00
  )
  assert.equal(label, '11-18 10:00')
})

test('规则已过 endDate：不再给一个不会发生的日期', () => {
  const label = nextInstanceLabel(
    rule({ freq: 'daily', endDate: '2026-11-12' }),
    cn('2026-11-10T10:00'),
    { now: NOW, tzOffsetMinutes: TZ },
  )
  assert.equal(label, '')
})

test('remind_at 为空：无时间轴可推，返回空串', () => {
  assert.equal(nextInstanceLabel(rule({ freq: 'daily' }), null, { now: NOW }), '')
  assert.equal(nextInstanceLabel(rule({ freq: 'daily' }), undefined, { now: NOW }), '')
})

test('非法规则：返回空串', () => {
  assert.equal(nextInstanceLabel(null, cn('2026-11-16T10:00'), { now: NOW }), '')
  assert.equal(
    nextInstanceLabel({ freq: 'yearly' } as unknown as RecurrenceRule, cn('2026-11-16T10:00'), {
      now: NOW,
    }),
    '',
  )
})

test('跨年：带年份，避免 12-30 与次年 01-04 混淆', () => {
  const label = nextInstanceLabel(rule({ freq: 'daily' }), cn('2027-01-04T10:00'), {
    now: new Date(cn('2026-12-31T09:00')),
    tzOffsetMinutes: TZ,
  })
  assert.equal(label, '2027-01-04 10:00')
})

test('时区注入生效：同一 ISO 在 UTC 下显示 02:00 而非 10:00', () => {
  const iso = cn('2026-11-16T10:00')
  assert.equal(nextInstanceLabel(rule({ freq: 'daily' }), iso, { now: NOW, tzOffsetMinutes: 0 }), '11-16 02:00')
  assert.equal(nextInstanceLabel(rule({ freq: 'daily' }), iso, { now: NOW, tzOffsetMinutes: TZ }), '11-16 10:00')
})

test('completion 模式：以完成时刻（now）为基准，不原地踏步', () => {
  const label = nextInstanceLabel(rule({ freq: 'daily', mode: 'completion' }), cn('2026-11-10T10:00'), {
    now: NOW,
    tzOffsetMinutes: TZ,
  })
  assert.equal(label, '11-16 10:00')
})

test('纯函数：不改入参，重复调用结果一致', () => {
  const r = rule({ freq: 'weekly', weekdays: [1, 3] })
  const snapshot = JSON.stringify(r)
  const remindAt = cn('2026-11-10T10:00')
  const first = nextInstanceLabel(r, remindAt, { now: NOW, tzOffsetMinutes: TZ })
  const second = nextInstanceLabel(r, remindAt, { now: NOW, tzOffsetMinutes: TZ })
  assert.equal(first, second)
  assert.equal(JSON.stringify(r), snapshot)
  assert.equal(remindAt, cn('2026-11-10T10:00'))
})
