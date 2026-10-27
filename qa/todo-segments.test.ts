/**
 * v2.13 R2 待办三段视图判定测试。
 *
 * 钉死三件事：
 * 1. 分段规则：逾期归「今天」、someday 互斥优先、无 remind_at 按优先级兜底；
 * 2. 互斥完备：每条待办只属于一段（三段条数之和 = 总数）；
 * 3. 时区口径：本地日边界由注入的 tzOffsetMinutes 决定，与机器时区无关。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { InfoRecord } from '../shared/types/domain'
import {
  BUCKET_LABELS,
  bucketCounts,
  bucketTodo,
  localDayStartMs,
  nextLocalDayStartMs,
  splitByBucket,
} from '../web/src/lib/todo-segments'

const TZ = 480
/** 基准时刻：2026-10-27（周二）10:00 东八区。 */
const NOW = Date.parse('2026-10-27T10:00:00+08:00')

/** 构造一条只填必要字段的待办。 */
function todo(over: Partial<InfoRecord> = {}): InfoRecord {
  return {
    id: 1,
    type: 'todo',
    title: '待办',
    content: '',
    tags: [],
    todoStatus: 'pending',
    isDeleted: false,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

test('本地日边界：localDayStartMs / nextLocalDayStartMs 按注入时区取界', () => {
  assert.equal(new Date(localDayStartMs(NOW, TZ)).toISOString(), '2026-10-26T16:00:00.000Z') // 东八区 10-27 00:00
  assert.equal(
    new Date(nextLocalDayStartMs(NOW, TZ)).toISOString(),
    '2026-10-27T16:00:00.000Z', // 东八区 10-28 00:00
  )
})

test('逾期归「今天」：昨天到期未完成的任务不会在三段里消失', () => {
  const record = todo({ remindAt: '2026-10-26T09:00:00+08:00' })
  assert.equal(bucketTodo(record, NOW, TZ), 'today')
})

test('今天 23:59 归「今天」；明天 00:01 归「即将」', () => {
  assert.equal(bucketTodo(todo({ remindAt: '2026-10-27T23:59:00+08:00' }), NOW, TZ), 'today')
  assert.equal(bucketTodo(todo({ remindAt: '2026-10-28T00:01:00+08:00' }), NOW, TZ), 'upcoming')
})

test('someday 互斥优先：标了「某天」的今天到期待办只算某天', () => {
  const record = todo({ someday: true, remindAt: '2026-10-27T09:00:00+08:00', priority: 'high' })
  assert.equal(bucketTodo(record, NOW, TZ), 'someday')
})

test('无 remind_at：高优先级归「今天」，其余归「即将」', () => {
  assert.equal(bucketTodo(todo({ priority: 'high' }), NOW, TZ), 'today')
  assert.equal(bucketTodo(todo({ priority: 'medium' }), NOW, TZ), 'upcoming')
  assert.equal(bucketTodo(todo({ priority: null }), NOW, TZ), 'upcoming')
})

test('非法 remind_at 字符串：按「无提醒时间」规则兜底，不抛错', () => {
  assert.equal(bucketTodo(todo({ remindAt: '不是时间', priority: 'high' }), NOW, TZ), 'today')
  assert.equal(bucketTodo(todo({ remindAt: '不是时间', priority: 'low' }), NOW, TZ), 'upcoming')
})

test('计数守恒：三段之和 === 总数，且与 splitByBucket 各段长度一致', () => {
  const records: InfoRecord[] = [
    todo({ id: 1, remindAt: '2026-10-25T09:00:00+08:00' }), // 逾期 → 今天
    todo({ id: 2, remindAt: '2026-10-27T18:00:00+08:00' }), // 今天
    todo({ id: 3, remindAt: '2026-10-30T09:00:00+08:00' }), // 即将
    todo({ id: 4, someday: true }), // 某天
    todo({ id: 5, priority: 'high' }), // 无日期高优 → 今天
    todo({ id: 6 }), // 无日期 → 即将
    todo({ id: 7, someday: false, remindAt: '2026-10-30T09:00:00+08:00' }), // 即将
  ]
  const counts = bucketCounts(records, NOW, TZ)
  assert.equal(counts.today, 3)
  assert.equal(counts.upcoming, 3)
  assert.equal(counts.someday, 1)
  assert.equal(counts.today + counts.upcoming + counts.someday, records.length)
  assert.equal(counts.total, records.length)

  const buckets = splitByBucket(records, NOW, TZ)
  assert.equal(buckets.today.length, counts.today)
  assert.equal(buckets.upcoming.length, counts.upcoming)
  assert.equal(buckets.someday.length, counts.someday)
  // 互斥：三段 id 集合两两不相交，并集 = 全部
  const ids = new Set<number>()
  for (const key of ['today', 'upcoming', 'someday'] as const) {
    for (const record of buckets[key]) {
      assert.equal(ids.has(record.id), false, `id ${record.id} 重复出现在多个段`)
      ids.add(record.id)
    }
  }
  assert.equal(ids.size, records.length)
})

test('标「某天」后从今天消失、某天 +1，总数不变（互斥迁移）', () => {
  const records = [todo({ id: 1, remindAt: '2026-10-27T09:00:00+08:00' }), todo({ id: 2, remindAt: '2026-10-30T09:00:00+08:00' })]
  const before = bucketCounts(records, NOW, TZ)
  // 模拟 UI 的 someday 切换（只改标记，不动 remind_at）
  records[0] = { ...records[0], someday: true }
  const after = bucketCounts(records, NOW, TZ)
  assert.equal(after.today, before.today - 1)
  assert.equal(after.someday, before.someday + 1)
  assert.equal(after.total, before.total)
})

test('分段标签齐全（UI 与空态文案共用）', () => {
  assert.deepEqual(BUCKET_LABELS, { today: '今天', upcoming: '即将', someday: '某天' })
})
