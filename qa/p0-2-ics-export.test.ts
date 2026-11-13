/**
 * 日历互通 P0-2 验收测试（`.ics` 导出字段补全 + `parent_id` 回填 + 待办「重要」筛选）。
 *
 * 覆盖四组：
 * 1. **纯函数**（`web/src/lib/ics.ts`）：`RRULE` 映射、相对触发器、UID 约定、
 *    `VALARM`（默认两条 / 可关 / 可换偏移 / 显式覆盖）、`RELATED-TO`（空则零输出）、`TRANSP`；
 * 2. **回环**：`buildIcs()` 的产物再喂给 `parseIcs()`，要求**零 warning** 且字段原样回来
 *    （这是"导进 Google Calendar 不报错"在本仓库唯一可自动化的代理指标）；
 * 3. **父级**：`records.parent_id` 的读写映射、删父任务连带子任务进回收站、
 *    导入时 `RELATED-TO` 反查 id 后回填（父子同批也能挂上）；
 * 4. **「重要」筛选**（`lib/todo-segments.ts`）：口径为「高优先级 或 今天到期」，
 *    纯函数注入 `nowMs`/时区，故三套 UI 方案下计数必然一致。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  __dbCalls,
  __dbInserts,
  __dbUpdates,
  __queueDbResults,
  __resetDbCalls,
  __resetDbQueue,
  __resetDbWrites,
  __setDbResult,
} from './mocks/cloud'
import {
  ICS_CRLF,
  buildIcs,
  normalizeTrigger,
  recordUid,
  recurrenceToRrule,
  toRelativeTrigger,
  type IcsSource,
} from '../web/src/lib/ics'
import { parseIcs } from '../web/src/lib/ics-parse'
import {
  bucketCounts,
  filterImportantTodos,
  isImportantTodo,
} from '../web/src/lib/todo-segments'
import { recordService } from '../web/src/services/recordService'
import { importIcs, previewIcs } from '../web/src/services/icsImportService'
import type { InfoRecord } from '@shared/types/domain'
import type { RecordsRow } from '../web/src/lib/database.types'

const DTSTAMP = '2026-11-04T02:00:00.000Z'
/** 东八区偏移（分钟）：本地日判定显式注入，避免依赖运行机器时区。 */
const TZ = 480
/** 2026-11-04 10:00 +08（周三）。 */
const NOW = Date.parse('2026-11-04T10:00:00+08:00')

beforeEach(() => {
  __resetDbCalls()
  __resetDbQueue()
  __resetDbWrites()
  __setDbResult({ data: [] })
})

/** 构造一条待导出的记录。 */
function src(over: Partial<IcsSource> = {}): IcsSource {
  return {
    id: 1,
    title: '交周报',
    content: null,
    category: null,
    priority: null,
    todoStatus: 'pending',
    remindAt: '2026-11-04T01:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    ...over,
  }
}

/** 展开折行后的行数组（空行剔除）。 */
function lines(content: string): string[] {
  return content.split(ICS_CRLF).filter((line) => line.length > 0)
}

/** 取某个组件（`VTODO` / `VEVENT`）内部的行。 */
function componentLines(content: string, name: 'VTODO' | 'VEVENT'): string[] {
  const all = lines(content)
  const start = all.indexOf(`BEGIN:${name}`)
  const end = all.indexOf(`END:${name}`)
  if (start < 0 || end < 0 || end <= start) return []
  return all.slice(start, end)
}

/* ============================== 1. 纯函数 ============================== */

test('recurrenceToRrule：daily / weekly / monthly 与 INTERVAL、BYDAY、BYMONTHDAY、UNTIL', () => {
  assert.equal(recurrenceToRrule({ freq: 'daily', interval: 1 }), 'FREQ=DAILY')
  assert.equal(recurrenceToRrule({ freq: 'daily', interval: 3 }), 'FREQ=DAILY;INTERVAL=3')
  assert.equal(
    recurrenceToRrule({ freq: 'weekly', interval: 2, weekdays: [5, 1, 3, 3] }),
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR',
    'weekdays 0=周日 应按 SU..SA 映射、升序去重',
  )
  assert.equal(
    recurrenceToRrule({ freq: 'weekly', interval: 1, weekdays: [0, 6] }),
    'FREQ=WEEKLY;BYDAY=SU,SA',
  )
  assert.equal(
    recurrenceToRrule({ freq: 'monthly', interval: 1, anchorDay: 31 }),
    'FREQ=MONTHLY;BYMONTHDAY=31',
  )
  assert.equal(
    recurrenceToRrule({ freq: 'monthly', interval: 1, anchorDay: null, endDate: '2026-11-30' }),
    'FREQ=MONTHLY;UNTIL=20261130T235959Z',
    'endDate 是本地日（含当日），UNTIL 取当日 23:59:59Z',
  )
  assert.equal(
    recurrenceToRrule({ freq: 'daily', interval: 0 }),
    'FREQ=DAILY',
    'interval 非法时夹到 1（且 1 不写 INTERVAL）',
  )
})

test('recurrenceToRrule：脏数据一律 null（不出重复，也不出脏规则）', () => {
  assert.equal(recurrenceToRrule(null), null)
  assert.equal(recurrenceToRrule(undefined), null)
  assert.equal(recurrenceToRrule({ freq: 'yearly', interval: 1 } as never), null)
  assert.equal(recurrenceToRrule({ freq: 'daily', interval: 1, endDate: '2026/11/30' }), 'FREQ=DAILY')
})

test('toRelativeTrigger / normalizeTrigger：分钟粒度与两种触发形式', () => {
  assert.equal(toRelativeTrigger(-15), '-PT15M')
  assert.equal(toRelativeTrigger(0), 'PT0M')
  assert.equal(toRelativeTrigger(90), 'PT1H30M')
  assert.equal(toRelativeTrigger(-120), '-PT2H')
  assert.equal(toRelativeTrigger(Number.NaN), null)

  assert.equal(normalizeTrigger('-PT15M'), '-PT15M')
  assert.equal(normalizeTrigger('+PT0M'), 'PT0M', '+ 号归一掉（避免个别客户端不认）')
  assert.equal(normalizeTrigger('2026-11-04T01:00:00.000Z'), '20261104T010000Z', '绝对时刻统一成 UTC')
  assert.equal(normalizeTrigger('不是时间'), null)
  assert.equal(normalizeTrigger(''), null)
})

test('recordUid：三处（VTODO / VEVENT / RELATED-TO）共用同一约定', () => {
  assert.equal(recordUid(42), 'record-42@personal-agent')
})

/* ============================== 2. 导出字段 ============================== */

test('buildIcs：默认产出两条 DISPLAY 提醒（-15 分钟 + 准点）', () => {
  const content = buildIcs([src()], { dtstampIso: DTSTAMP }).content
  const event = componentLines(content, 'VEVENT')
  const alarms = lines(content).filter((line) => line === 'BEGIN:VALARM').length
  assert.equal(alarms, 2, '同一条任务必须收到 2 次提醒')
  assert.equal(event.filter((line) => line === 'ACTION:DISPLAY').length, 2)
  assert.ok(event.includes('TRIGGER:-PT15M'))
  assert.ok(event.includes('TRIGGER:PT0M'))
  assert.ok(event.includes('DESCRIPTION:交周报'), 'DISPLAY 的 DESCRIPTION 回落到标题')
})

test('buildIcs：alarmOffsetsMinutes 可关可换；显式 alarms 完全覆盖默认', () => {
  const off = buildIcs([src()], { dtstampIso: DTSTAMP, alarmOffsetsMinutes: [] }).content
  assert.ok(!off.includes('BEGIN:VALARM'), '空数组 = 不产提醒')

  const custom = buildIcs([src()], { dtstampIso: DTSTAMP, alarmOffsetsMinutes: [30] }).content
  assert.equal(pureValarmCount(custom), 1)
  assert.ok(lines(custom).includes('TRIGGER:PT30M'))

  const explicit = buildIcs([src({ alarms: [{ trigger: '-PT1H', description: '提前一小时' }] })], {
    dtstampIso: DTSTAMP,
    alarmOffsetsMinutes: [-15, 0],
  }).content
  assert.equal(pureValarmCount(explicit), 1, '显式 alarms 给出时不再叠加默认偏移')
  assert.ok(lines(explicit).includes('TRIGGER:-PT1H'))
  assert.ok(lines(explicit).includes('DESCRIPTION:提前一小时'))
})

test('buildIcs：RRULE 只写在 VEVENT（VTODO 无 DTSTART，带 RRULE 违反 RFC 5545 §3.6.2）', () => {
  const content = buildIcs(
    [src({ recurrence: { freq: 'weekly', interval: 1, weekdays: [3] } })],
    { dtstampIso: DTSTAMP },
  ).content
  const todo = componentLines(content, 'VTODO')
  const event = componentLines(content, 'VEVENT')
  assert.ok(!todo.some((line) => line.startsWith('RRULE:')), 'VTODO 不写 RRULE')
  assert.ok(event.includes('RRULE:FREQ=WEEKLY;BYDAY=WE'), 'VEVENT 写 RRULE')
})

test('buildIcs：RELATED-TO 只在 parentId 非空时出现（空则整行不输出）', () => {
  const withParent = buildIcs([src({ parentId: 7 })], { dtstampIso: DTSTAMP }).content
  assert.ok(
    lines(withParent).includes('RELATED-TO;RELTYPE=PARENT:record-7@personal-agent'),
    '父级 id 按 UID 约定写成 RELATED-TO',
  )

  for (const parentId of [null, undefined, 0, -3, 1.5]) {
    const none = buildIcs([src({ parentId: parentId as never })], { dtstampIso: DTSTAMP }).content
    assert.ok(
      !lines(none).some((line) => line.startsWith('RELATED-TO')),
      `parentId=${String(parentId)} 必须一行都不输出（该字段自身零扰动）`,
    )
  }
})

test('buildIcs：TRANSP 默认 OPAQUE，可显式改 TRANSPARENT', () => {
  const opaque = buildIcs([src()], { dtstampIso: DTSTAMP }).content
  assert.ok(componentLines(opaque, 'VEVENT').includes('TRANSP:OPAQUE'))

  const transparent = buildIcs([src({ transparency: 'TRANSPARENT' })], { dtstampIso: DTSTAMP }).content
  assert.ok(componentLines(transparent, 'VEVENT').includes('TRANSP:TRANSPARENT'))
})

/** 统计 `BEGIN:VALARM` 的条数。 */
function pureValarmCount(content: string): number {
  return lines(content).filter((line) => line === 'BEGIN:VALARM').length
}

/* ============================== 3. 回环（导出 → 解析） ============================== */

test('回环：导出文本再解析零 warning，RRULE / RELATED-TO / 提醒原样回来', () => {
  const built = buildIcs(
    [
      src({
        id: 7,
        title: '每周评审',
        content: '会议室 A',
        category: '工作',
        priority: 'high',
        parentId: 3,
        recurrence: { freq: 'weekly', interval: 1, weekdays: [3], endDate: '2026-11-30' },
      }),
    ],
    { dtstampIso: DTSTAMP },
  ).content

  const parsed = parseIcs(built, { nowIso: '2026-11-04T00:00:00.000Z' })
  assert.deepEqual(parsed.warnings, [], `导出物必须能被自己零告警解析：${parsed.warnings.join('；')}`)

  const event = parsed.items.find((item) => item.kind === 'event')
  assert.ok(event, '必须解析出 VEVENT 条目')
  assert.equal(event.rrule, 'FREQ=WEEKLY;BYDAY=WE;UNTIL=20261130T235959Z')
  assert.equal(event.alarms.length, 2, '两条 DISPLAY 提醒要能读回')
  const triggers = event.alarms.map((alarm) => alarm.trigger)
  assert.ok(triggers.includes('-PT15M'), `提前 15 分钟的提醒应原样读回（实际 ${triggers.join(',')}）`)
  assert.ok(
    triggers.some((trigger) => /^-?PT0[MS]$/.test(trigger)),
    `准点提醒应读回为 PT0M/PT0S（实际 ${triggers.join(',')}）`,
  )
  assert.ok(event.occurrences.length >= 2, `循环事件应展开多条实例（实际 ${event.occurrences.length}）`)

  const todo = parsed.items.find((item) => item.kind === 'todo')
  assert.ok(todo, '必须解析出 VTODO 条目')
  assert.equal(todo.relatedTo, 'record-3@personal-agent', 'RELATED-TO 原文可读回')
  assert.equal(todo.isRecurring, false, 'VTODO 不带 RRULE（见上一条用例）')
})

/* ============================== 4. parent_id 读写 ============================== */

/** 构造一行 records 数据。 */
function row(over: Partial<RecordsRow> = {}): RecordsRow {
  return {
    id: 1,
    owner_id: 'u1',
    type: 'todo',
    title: '交周报',
    content: '',
    url: null,
    file_path: null,
    category: null,
    tags: [],
    summary: null,
    todo_status: 'pending',
    priority: 'high',
    remind_at: null,
    recurrence: null,
    recurrence_parent_id: null,
    recurrence_next_id: null,
    link_meta: null,
    is_deleted: false,
    deleted_at: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    ...over,
  }
}

test('mapRecord：parent_id → parentId；缺列（undefined）回落 null', () => {
  __setDbResult({ data: row({ id: 5, parent_id: 3 }) })
  return recordService.getRecord(5).then((record) => {
    assert.equal(record?.parentId, 3)

    __setDbResult({ data: row({ id: 6 }) })
    return recordService.getRecord(6).then((plain) => {
      assert.equal(plain?.parentId, null, '迁移未执行 / 无父级都必须是 null')
    })
  })
})

test('createRecord / updateRecord：只在显式传 parentId 时才写 parent_id', async () => {
  __resetDbWrites()
  __setDbResult({ data: [row({ id: 9, parent_id: 3 })] })
  await recordService.createRecord({ type: 'todo', title: '子任务', parentId: 3 })
  const inserted = __dbInserts[0] as Record<string, unknown>
  assert.equal(inserted.parent_id, 3)

  __resetDbWrites()
  __setDbResult({ data: [row({ id: 10 })] })
  await recordService.createRecord({ type: 'todo', title: '手写记录' })
  const plain = __dbInserts[0] as Record<string, unknown>
  assert.ok(!('parent_id' in plain), '手写记录不得带 parent_id（迁移未执行也不能因此写失败）')

  __resetDbCalls()
  __setDbResult({ data: [row({ id: 11, parent_id: 4 })] })
  await recordService.updateRecord(11, { parentId: 4 })
  assert.ok(__dbCalls.includes('update(parent_id)'), '更新链路要能写 parent_id')
})

test('softDelete：删父任务时把子任务一起放进回收站（不出现孤儿）', async () => {
  __resetDbCalls()
  __resetDbWrites()
  __queueDbResults([
    { data: [row({ id: 1 })] }, // 父记录软删
    { data: [{ id: 2 }, { id: 3 }] }, // 子任务查询
    { data: [{ id: 2 }, { id: 3 }] }, // 子任务软删
  ])
  await recordService.softDelete(1)

  assert.ok(__dbCalls.includes('eq(parent_id,1)'), '必须按 parent_id 查子任务')
  assert.ok(__dbCalls.includes('eq(is_deleted,false)'), '只处理还没删的子任务')
  assert.ok(__dbCalls.includes('in(id,[2,3])'), '子任务一次批量更新，不逐条发请求')
  assert.equal(__dbUpdates.length, 2, '两次 update：父记录 + 子任务')
  assert.equal((__dbUpdates[1] as { is_deleted?: boolean }).is_deleted, true)
})

test('softDelete：缺 parent_id 列（42703）时不影响父记录删除', async () => {
  __resetDbCalls()
  __queueDbResults([
    { data: [row({ id: 1 })] },
    { data: null, error: { code: '42703' } },
  ])
  await recordService.softDelete(1)
  assert.ok(__dbCalls.includes('update(is_deleted,deleted_at)'), '父记录仍然要被软删')
})

/* ============================== 5. 导入时回填 parent_id ============================== */

/** 父 + 子两条 VTODO（子用 RELATED-TO 指向父）。 */
const PARENT_CHILD_ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VTODO',
  'UID:parent-uid',
  'DTSTAMP:20261101T000000Z',
  'SUMMARY:装修',
  'STATUS:NEEDS-ACTION',
  'END:VTODO',
  'BEGIN:VTODO',
  'UID:child-uid',
  'DTSTAMP:20261101T000000Z',
  'SUMMARY:买瓷砖',
  'RELATED-TO:parent-uid',
  'STATUS:NEEDS-ACTION',
  'END:VTODO',
  'END:VCALENDAR',
].join(ICS_CRLF) + ICS_CRLF

test('importIcs：RELATED-TO 在写入后反查 id 并回填 parent_id（父子同批也能挂上）', async () => {
  __resetDbCalls()
  __resetDbWrites()
  __queueDbResults([
    { data: [] }, // 查重：都没导入过
    { data: [] }, // 插入（mock 不回传行）
    {
      data: [
        { id: 11, external_uid: 'parent-uid' },
        { id: 12, external_uid: 'child-uid' },
      ],
    }, // UID → id 反查
    { data: [] }, // 回填 update
  ])
  __setDbResult({ data: [] })

  const result = await importIcs(PARENT_CHILD_ICS, { nowIso: '2026-11-04T02:00:00.000Z' })
  assert.equal(result.created, 2)
  assert.ok(__dbCalls.includes('update(parent_id)'), '必须发生一次 parent_id 回填')
  assert.ok(__dbCalls.includes('in(id,[12])'), '子记录 12 应挂到父记录 11 下')
  assert.equal((__dbUpdates.at(-1) as { parent_id?: number }).parent_id, 11)
})

test('importIcs：父记录不在库里时静默跳过，导入本身仍然成功', async () => {
  __resetDbCalls()
  __queueDbResults([
    { data: [] }, // 查重
    { data: [] }, // 插入
    { data: [{ id: 12, external_uid: 'child-uid' }] }, // 只查得到子记录
  ])
  __setDbResult({ data: [] })

  const result = await importIcs(PARENT_CHILD_ICS, { nowIso: '2026-11-04T02:00:00.000Z' })
  assert.equal(result.created, 2)
  assert.ok(!__dbCalls.includes('update(parent_id)'), '父级不存在时不得发无效更新')
})

test('previewIcs / toDraft：RELATED-TO 进 parentUid，不写 parent_id（写入时才解析）', () => {
  const preview = previewIcs(PARENT_CHILD_ICS, { nowIso: '2026-11-04T02:00:00.000Z' })
  const child = preview.drafts.find((draft) => draft.title === '买瓷砖')
  assert.equal(child?.parentUid, 'parent-uid')
  const parent = preview.drafts.find((draft) => draft.title === '装修')
  assert.equal(parent?.parentUid, null)
})

/* ============================== 6. 「重要」筛选 ============================== */

/** 只带判定所需字段的记录。 */
function pick(over: Partial<InfoRecord>): InfoRecord {
  return {
    id: 1,
    type: 'todo',
    title: 't',
    content: '',
    tags: [],
    todoStatus: 'pending',
    isDeleted: false,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
  }
}

test('isImportantTodo：高优先级或今天到期为真；明天 / 逾期为假', () => {
  assert.equal(isImportantTodo(pick({ priority: 'high', remindAt: null }), NOW, TZ), true, '高优先级无时间也算')
  assert.equal(
    isImportantTodo(pick({ priority: 'medium', remindAt: '2026-11-04T09:00:00+08:00' }), NOW, TZ),
    true,
    '今天到期',
  )
  assert.equal(
    isImportantTodo(pick({ priority: 'medium', remindAt: '2026-11-04T23:30:00+08:00' }), NOW, TZ),
    true,
    '今天 23:30 仍属今天',
  )
  assert.equal(
    isImportantTodo(pick({ priority: 'medium', remindAt: '2026-11-05T00:00:00+08:00' }), NOW, TZ),
    false,
    '明日 00:00 起不算今天',
  )
  assert.equal(
    isImportantTodo(pick({ priority: 'medium', remindAt: '2026-11-03T09:00:00+08:00' }), NOW, TZ),
    false,
    '逾期已在「今天」段里，不再重复进「重要」',
  )
  assert.equal(isImportantTodo(pick({ priority: 'low', remindAt: null }), NOW, TZ), false)
  assert.equal(isImportantTodo(pick({ priority: null, remindAt: 'not-a-date' }), NOW, TZ), false)
})

test('filterImportantTodos 与三段计数同源：筛后集合的段计数之和 = 筛后条数', () => {
  const records = [
    pick({ id: 1, priority: 'high', remindAt: null }),
    pick({ id: 2, priority: 'medium', remindAt: '2026-11-04T20:00:00+08:00' }),
    pick({ id: 3, priority: 'low', remindAt: '2026-11-09T10:00:00+08:00' }),
    pick({ id: 4, priority: null, remindAt: '2026-11-03T10:00:00+08:00' }),
  ]
  const important = filterImportantTodos(records, NOW, TZ)
  assert.deepEqual(
    important.map((record) => record.id),
    [1, 2],
  )
  const counts = bucketCounts(important, NOW, TZ)
  assert.equal(counts.today + counts.upcoming + counts.someday, important.length, '三段互斥完备')
  assert.equal(counts.today, 2, '两条都落在今天段')
})
