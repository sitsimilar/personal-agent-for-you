/**
 * 「.ics 条目 → 记录草稿」纯映射层单测（`web/src/lib/ics-map.ts`）。
 *
 * 覆盖点（全部零网络、零时钟依赖，可重放）：
 * 1. `mapPriority`：RFC 5545 的 1..9 三档收敛 + `0`（未设）/ 越界 / 非整数一律 null；
 * 2. `mapCategories`：多值去重去空保序、只认预置分类 key（自由文本不硬塞分类）；
 * 3. `toDraft`：event / todo / journal 三类的 `remindAt`、`type`、`todoStatus`、`deleted` 口径；
 * 4. `externalUid`：有 UID 原样、无 UID 同一输入两次必得同一个 `ics-xxxxxxxx`（查重的前提）；
 * 5. 空标题回退三种文案（空串标题会让搜索永远命中不到，必须回退成可搜索的占位）；
 * 6. `recordMeta` 的 `rrule` / `exdates` / `dtstart` 透传，且**不写** `importedAt`（纯函数不读时钟）；
 * 7. `buildDrafts` 保序、条数 = `items.length`。
 *
 * 断言全部用中文，失败时能一眼看出违反了哪条产品口径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseIcs, type IcsItem } from '../web/src/lib/ics-parse'
import { buildDrafts, mapCategories, mapPriority, toDraft } from '../web/src/lib/ics-map'

/** 注入的"当前时刻"（映射层本身不读时钟，这里只是让解析层的展开时间窗可重放）。 */
const NOW = '2026-10-30T12:00:00.000Z'

/** 造一条"干净"的 `IcsItem`，用例只覆盖自己关心的字段。 */
function makeItem(over: Partial<IcsItem> = {}): IcsItem {
  return {
    kind: 'event',
    uid: 'uid-001@qa',
    summary: '标题',
    description: null,
    location: null,
    categories: [],
    priority: null,
    status: null,
    percentComplete: null,
    relatedTo: null,
    completedIso: null,
    rrule: null,
    exdates: [],
    isRecurring: false,
    allDay: false,
    tzidRaw: null,
    tzid: null,
    startIso: null,
    endIso: null,
    dueIso: null,
    alarms: [],
    occurrences: [],
    ...over,
  }
}

/** 用行数组拼一段 .ics（CRLF，符合 RFC 5545）。 */
function ics(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

/* ============================== 1. mapPriority ============================== */

test('mapPriority：1–4 → high、5 → medium、6–9 → low（RFC 5545 里 1 最高）', () => {
  const cases: Array<[number, 'high' | 'medium' | 'low']> = [
    [1, 'high'],
    [2, 'high'],
    [4, 'high'],
    [5, 'medium'],
    [6, 'low'],
    [9, 'low'],
  ]
  for (const [raw, expected] of cases) {
    assert.equal(mapPriority(raw), expected, `PRIORITY:${raw} 必须映射为 ${expected}`)
  }
})

test('mapPriority：0 / 越界 / 非整数 / 空值一律 null（不猜）', () => {
  assert.equal(mapPriority(0), null, 'RFC 5545 里 0 表示"未设"，不是"最高"')
  assert.equal(mapPriority(null), null)
  assert.equal(mapPriority(undefined), null)
  assert.equal(mapPriority(10), null, '10 超出 1..9 的合法范围')
  assert.equal(mapPriority(-1), null)
  assert.equal(mapPriority(3.5), null, '非整数不猜')
  assert.equal(mapPriority(Number.NaN), null)
})

/* ============================== 2. mapCategories ============================== */

test('mapCategories：去重去空保序，命中预置分类 key 才给 category', () => {
  const hit = mapCategories(['工作/会议', '会议', '工作/会议', ''])
  assert.deepEqual(hit.tags, ['工作/会议', '会议'], 'tags 必须去重去空且保持原顺序')
  assert.equal(hit.category, '工作/会议', '命中预置分类 key 时应取出该 key')
})

test('mapCategories：无预置分类命中时 category 为 null，但 tags 一条都不能丢', () => {
  const miss = mapCategories(['会议', '杂事'])
  assert.deepEqual(miss.tags, ['会议', '杂事'], '自由文本全部进 tags（信息不丢）')
  assert.equal(miss.category, null, '自由文本绝不能被硬塞进预置分类（会无法配色/筛选）')
})

test('mapCategories：空数组 / 全空白 → 空 tags + null 分类', () => {
  assert.deepEqual(mapCategories([]), { category: null, tags: [] })
  assert.deepEqual(mapCategories(['', '   ', '\t']), { category: null, tags: [] })
})

test('mapCategories：取值首尾空白会被裁掉，裁完重复的只留一条', () => {
  assert.deepEqual(mapCategories([' 工作/会议 ', '工作/会议']), {
    category: '工作/会议',
    tags: ['工作/会议'],
  })
})

/* ============================== 3. toDraft 三类 ============================== */

test('toDraft(event)：remindAt = DTSTART，type=todo、todoStatus=pending', () => {
  const draft = toDraft(
    makeItem({
      kind: 'event',
      uid: 'event-001@qa',
      summary: '季度规划会',
      description: '议程',
      startIso: '2026-11-10T01:30:00.000Z',
      endIso: '2026-11-10T02:30:00.000Z',
      dueIso: null,
    }),
  )

  assert.equal(draft.type, 'todo', '本产品没有"日程"类型：有确定时刻的事项落成带提醒的待办')
  assert.equal(draft.icsKind, 'event')
  assert.equal(draft.remindAt, '2026-11-10T01:30:00.000Z', 'event 的提醒时刻取 DTSTART')
  assert.equal(draft.todoStatus, 'pending')
  assert.equal(draft.deleted, false)
  assert.equal(draft.title, '季度规划会')
  assert.equal(draft.content, '议程')
})

test('toDraft(todo)：remindAt 优先取 DUE，无 DUE 时回退 DTSTART', () => {
  const withDue = toDraft(
    makeItem({
      kind: 'todo',
      uid: 'todo-001@qa',
      summary: '提交报销单',
      startIso: '2026-11-01T01:00:00.000Z',
      dueIso: '2026-11-05T10:00:00.000Z',
      status: 'NEEDS-ACTION',
    }),
  )
  assert.equal(withDue.type, 'todo')
  assert.equal(withDue.icsKind, 'todo')
  assert.equal(withDue.remindAt, '2026-11-05T10:00:00.000Z', 'DUE 优先于 DTSTART')
  assert.equal(withDue.todoStatus, 'pending')

  const onlyStart = toDraft(
    makeItem({
      kind: 'todo',
      uid: 'todo-002@qa',
      summary: '只有开始时刻',
      startIso: '2026-11-02T01:00:00.000Z',
      dueIso: null,
    }),
  )
  assert.equal(onlyStart.remindAt, '2026-11-02T01:00:00.000Z', '没有 DUE 时必须回退 DTSTART，不能丢提醒')

  const noTime = toDraft(makeItem({ kind: 'todo', uid: 'todo-003@qa', startIso: null, dueIso: null }))
  assert.equal(noTime.remindAt, null, '两个时间都没有时 remindAt 为 null（不能编造时刻）')
})

test('toDraft(journal)：type=idea、remindAt 恒为 null（笔记不排期）', () => {
  const draft = toDraft(
    makeItem({
      kind: 'journal',
      uid: 'journal-001@qa',
      summary: '今日复盘',
      description: '结论',
      startIso: '2026-10-30T13:30:00.000Z',
      // 故意塞上 DUE：VJOURNAL 即便被写入 DUE 也不得排期
      dueIso: '2026-11-01T00:00:00.000Z',
    }),
  )

  assert.equal(draft.type, 'idea', 'VJOURNAL 落成笔记（idea）')
  assert.equal(draft.icsKind, 'journal')
  assert.equal(draft.remindAt, null, '笔记不参与排期，remindAt 必须为 null')
  assert.equal(draft.todoStatus, null, '笔记不进待办状态机')
  assert.equal(draft.recordMeta.dtstart, '2026-10-30T13:30:00.000Z', 'DTSTART 只进元数据备查')
})

test('toDraft：STATUS:COMPLETED → todoStatus=done 且 completedAt 透传', () => {
  const draft = toDraft(
    makeItem({
      kind: 'todo',
      uid: 'todo-done@qa',
      summary: '已完成',
      status: 'COMPLETED',
      completedIso: '2026-10-28T03:00:00.000Z',
      dueIso: '2026-11-01T00:00:00.000Z',
    }),
  )
  assert.equal(draft.todoStatus, 'done')
  assert.equal(draft.recordMeta.completedAt, '2026-10-28T03:00:00.000Z')
})

test('toDraft：STATUS:CANCELLED → deleted=true（导入即进回收站，不静默丢数据）', () => {
  const cancelled = toDraft(makeItem({ kind: 'todo', uid: 'todo-cancel@qa', status: 'CANCELLED' }))
  assert.equal(cancelled.deleted, true)

  const normal = toDraft(makeItem({ kind: 'todo', uid: 'todo-normal@qa', status: 'NEEDS-ACTION' }))
  assert.equal(normal.deleted, false)
})

test('toDraft：STATUS 大小写与空白不影响判定（导出器不一定守 RFC 的大写约定）', () => {
  assert.equal(toDraft(makeItem({ kind: 'todo', status: ' completed ' })).todoStatus, 'done')
  assert.equal(toDraft(makeItem({ kind: 'todo', status: 'cancelled' })).deleted, true)
})

/* ============================== 4. externalUid ============================== */

test('externalUid：文件里有 UID 时原样采用（跨设备/跨次导出稳定）', () => {
  const draft = toDraft(makeItem({ uid: '  weekly-sync-001@example.com  ' }))
  assert.equal(draft.externalUid, 'weekly-sync-001@example.com', 'UID 必须裁空白后原样使用')
  assert.equal(draft.recordMeta.externalUid, 'weekly-sync-001@example.com', 'recordMeta 里冗余一份同值')
})

test('externalUid：无 UID 时同输入两次必得同一个 ics-xxxxxxxx（否则查重失效）', () => {
  const source = makeItem({ uid: null, kind: 'todo', summary: '没有 UID 的待办', startIso: '2026-11-01T01:00:00.000Z' })
  const first = toDraft(source).externalUid
  const second = toDraft(source).externalUid

  assert.match(first, /^ics-[0-9a-f]{8}$/, `派生 UID 形如 ics-xxxxxxxx（实际 ${first}）`)
  assert.equal(second, first, '同一份文件重复导入必须得到同一个 key')
})

test('externalUid：类型 / 标题 / 开始时刻任一变化都会改变派生值', () => {
  const base = makeItem({ uid: null, kind: 'todo', summary: '原标题', startIso: '2026-11-01T01:00:00.000Z' })
  const baseUid = toDraft(base).externalUid

  assert.notEqual(toDraft({ ...base, kind: 'event' }).externalUid, baseUid, '类型变化必须换 key')
  assert.notEqual(toDraft({ ...base, summary: '新标题' }).externalUid, baseUid, '标题变化必须换 key')
  assert.notEqual(toDraft({ ...base, startIso: '2026-11-02T01:00:00.000Z' }).externalUid, baseUid, '时刻变化必须换 key')
})

/* ============================== 5. 空标题回退 ============================== */

test('空标题回退：三种类型各自的占位文案（空串标题会让搜索永远命中不到）', () => {
  assert.equal(toDraft(makeItem({ kind: 'event', summary: '' })).title, '（无标题日程）')
  assert.equal(toDraft(makeItem({ kind: 'todo', summary: '' })).title, '（无标题待办）')
  assert.equal(toDraft(makeItem({ kind: 'journal', summary: '' })).title, '（无标题笔记）')
})

test('空标题回退：纯空白标题同样回退，正常标题不被改写', () => {
  assert.equal(toDraft(makeItem({ kind: 'todo', summary: '   ' })).title, '（无标题待办）')
  assert.equal(toDraft(makeItem({ kind: 'todo', summary: '  有标题  ' })).title, '有标题', '正常标题只裁空白')
})

test('空标题回退：回退标题也参与 externalUid 派生（同一无标题条目仍稳定）', () => {
  const source = makeItem({ kind: 'journal', uid: null, summary: '', startIso: '2026-10-30T13:30:00.000Z' })
  assert.equal(toDraft(source).externalUid, toDraft(source).externalUid)
})

/* ============================== 6. recordMeta 透传 ============================== */

test('recordMeta：rrule / exdates / dtstart 透传，importedAt 留空（纯函数不读时钟）', () => {
  const text = ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//qa//EN',
    'BEGIN:VEVENT',
    'UID:recur-001@qa',
    'DTSTAMP:20261030T000000Z',
    'DTSTART:20261104T060000Z',
    'DTEND:20261104T070000Z',
    'SUMMARY:每周同步',
    'RRULE:FREQ=WEEKLY;COUNT=3;BYDAY=WE',
    'EXDATE:20261111T060000Z',
    'END:VEVENT',
    'END:VCALENDAR',
  ])
  const result = parseIcs(text, { nowIso: NOW })
  assert.equal(result.items.length, 1)

  const draft = toDraft(result.items[0])
  assert.equal(draft.recordMeta.source, 'ics-import')
  assert.equal(draft.recordMeta.icsKind, 'event')
  assert.equal(draft.recordMeta.rrule, 'FREQ=WEEKLY;COUNT=3;BYDAY=WE', 'RRULE 原文透传（不带 RRULE: 前缀）')
  assert.deepEqual(draft.recordMeta.exdates, ['2026-11-11T06:00:00.000Z'], 'EXDATE 归一成 UTC ISO 后透传')
  assert.equal(draft.recordMeta.dtstart, '2026-11-04T06:00:00.000Z')
  assert.equal(draft.recordMeta.importedAt, undefined, 'importedAt 必须由 service 注入，映射层不得读时钟')
})

test('recordMeta：无 rrule / 无 exdates 时值为 undefined，且不会被序列化进 record_meta', () => {
  const text = ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//qa//EN',
    'BEGIN:VTODO',
    'UID:plain-001@qa',
    'DTSTAMP:20261030T000000Z',
    'SUMMARY:普通待办',
    'DUE:20261101T100000Z',
    'END:VTODO',
    'END:VCALENDAR',
  ])
  const draft = toDraft(parseIcs(text, { nowIso: NOW }).items[0])

  assert.equal(draft.recordMeta.rrule, undefined)
  assert.equal(draft.recordMeta.exdates, undefined)
  // 键可能以 `undefined` 存在（`rrule: item.rrule ?? undefined`），但写库前会过 JSON 序列化，
  // 序列化后不得留下这两个键——否则 record_meta 里会出现 `"rrule":null` 这类脏值。
  const serialized = JSON.parse(JSON.stringify(draft.recordMeta)) as Record<string, unknown>
  assert.ok(!('rrule' in serialized), '序列化后不应出现 rrule 键')
  assert.ok(!('exdates' in serialized), '序列化后不应出现 exdates 键')
})

/* ============================== 7. buildDrafts ============================== */

test('buildDrafts：条数 = items.length 且严格保持文件内顺序', () => {
  const text = ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//qa//EN',
    'BEGIN:VEVENT',
    'UID:order-1@qa',
    'DTSTAMP:20261030T000000Z',
    'DTSTART:20261101T010000Z',
    'SUMMARY:第一',
    'END:VEVENT',
    'BEGIN:VTODO',
    'UID:order-2@qa',
    'DTSTAMP:20261030T000000Z',
    'SUMMARY:第二',
    'END:VTODO',
    'BEGIN:VJOURNAL',
    'UID:order-3@qa',
    'DTSTAMP:20261030T000000Z',
    'SUMMARY:第三',
    'END:VJOURNAL',
    'END:VCALENDAR',
  ])
  const result = parseIcs(text, { nowIso: NOW })
  const drafts = buildDrafts(result)

  assert.equal(drafts.length, result.items.length)
  assert.deepEqual(
    drafts.map((draft) => draft.title),
    ['第一', '第二', '第三'],
    '草稿顺序必须与文件内组件顺序一致（预览列表按此展示）',
  )
  assert.deepEqual(
    drafts.map((draft) => draft.icsKind),
    ['event', 'todo', 'journal'],
  )
  assert.deepEqual(
    drafts.map((draft) => draft.type),
    ['todo', 'todo', 'idea'],
  )
})

test('buildDrafts：空结果返回空数组（不抛、不返回 undefined）', () => {
  assert.deepEqual(buildDrafts(parseIcs('', { nowIso: NOW })), [])
})

test('纯函数：同一 items 两次 toDraft 结果完全一致', () => {
  const item = makeItem({ kind: 'todo', uid: null, summary: '幂等', categories: ['会议', '会议'], priority: 1 })
  assert.deepEqual(toDraft(item), toDraft(item))
})
