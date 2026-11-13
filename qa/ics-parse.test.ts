/**
 * P0-1 上半「.ics 解析层」单测（`web/src/lib/ics-parse.ts`）。
 *
 * 按 `qa/fixtures/ics/README.md` 的用例矩阵逐条断言，覆盖：
 * 1. `google-weekly-count-exdate.ics`：VTIMEZONE + TTZID + RRULE COUNT + EXDATE + RECURRENCE-ID 覆盖 + VALARM；
 * 2. `apple-monthly-byday-until.ics`：`FREQ=MONTHLY;BYDAY=2TU;UNTIL`；
 * 3. `outlook-allday-floating.ics`：全天（VALUE=DATE）+ 浮动时间 + Windows 时区名；
 * 4. `radicale-vtodo.ics`：VTODO 四态 + PRIORITY/STATUS/PERCENT-COMPLETE/CATEGORIES/RELATED-TO；
 * 5. `self-export-roundtrip.ics`：本产品导出格式 + 转义 + 折行还原；
 * 6. 容错与展开上限（空文本 / 非 VCALENDAR / 无 COUNT 的 RRULE / horizonDays）。
 *
 * **跨机器稳定**原则：显式 TZID 或 `Z` 后缀的用例可以写死 ISO；
 * 浮动时间与全天条目只断言"本地日期"，或与本地构造的 `Date` 反算比对，不写死 `Z` 时刻。
 * 所有用例都注入 `nowIso`，因此与运行时刻无关。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeTzid, parseIcs, type IcsItem } from '../web/src/lib/ics-parse'

/** 注入的"当前时刻"（固定值：展开时间窗与 maxOccurrences 才可重放）。 */
const NOW = '2026-10-30T12:00:00.000Z'
/** bundle 产物在 `qa/dist/`，向上一级即 `qa/`。 */
const FIXTURE_DIR = resolve(__dirname, '..', 'fixtures', 'ics')

/** 读夹具（保留 CRLF，ical.js 自己处理折行与行尾）。 */
function load(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf8')
}

/** 用行数组拼一段 .ics（CRLF，符合 RFC 5545）。 */
function ics(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

/** 取第一条 `event`。 */
function firstEvent(items: IcsItem[]): IcsItem {
  const found = items.find((item) => item.kind === 'event')
  assert.ok(found, '应当至少有一个 event')
  return found
}

/** 断言 `iso` 在本机时区语义下是该日期（跨机器稳定地断言"本地日期"）。 */
function assertLocalDate(iso: string | null, expected: string, message: string): void {
  assert.ok(iso, `${message}：iso 不得为空`)
  const date = new Date(iso as string)
  const pad = (n: number) => String(n).padStart(2, '0')
  const local = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  assert.equal(local, expected, message)
}

/* ==================== 1. google：COUNT + EXDATE + 覆盖 + VALARM ==================== */

test('google：RECURRENCE-ID 覆盖实例必须合并进主事件，只出 1 个 item', () => {
  const result = parseIcs(load('google-weekly-count-exdate.ics'), { nowIso: NOW })

  assert.equal(result.items.length, 1, 'RECURRENCE-ID 覆盖实例不得单独成为 item')
  assert.equal(result.calendarName, '工作日程')
  assert.equal(result.timezone, 'Asia/Shanghai')
  assert.deepEqual(result.warnings, [], '正常文件不应产生 warning')

  const item = firstEvent(result.items)
  assert.equal(item.uid, 'weekly-sync-001@example.com')
  assert.equal(item.summary, '产品周会')
  assert.equal(item.description, '同步本周进度\n讨论下周排期', 'DESCRIPTION 的 \\n 必须还原成换行')
  assert.equal(item.location, '会议室 A / 线上')
  assert.equal(item.allDay, false)
  assert.equal(item.isRecurring, true)
  assert.equal(item.rrule, 'FREQ=WEEKLY;COUNT=6;BYDAY=WE', 'RRULE 原文不得带 RRULE: 前缀')
  assert.equal(item.tzidRaw, 'Asia/Shanghai')
  assert.equal(item.tzid, 'Asia/Shanghai')
  assert.equal(item.startIso, '2026-11-04T06:00:00.000Z', '14:00 +08 = 06:00Z')
  assert.equal(item.endIso, '2026-11-04T07:00:00.000Z')
  assert.deepEqual(item.exdates, ['2026-11-18T06:00:00.000Z'], 'EXDATE 按自身 TZID 换算')
})

test('google：ALARM TRIGGER 读成 -PT15M', () => {
  const result = parseIcs(load('google-weekly-count-exdate.ics'), { nowIso: NOW })
  const item = firstEvent(result.items)
  assert.equal(item.alarms.length, 1)
  assert.equal(item.alarms[0].trigger, '-PT15M')
  assert.equal(item.alarms[0].description, '产品周会')
})

test('google：展开 5 个实例（COUNT=6 减 EXDATE 1 个），EXDATE 那天必须消失', () => {
  const result = parseIcs(load('google-weekly-count-exdate.ics'), { nowIso: NOW })
  const item = firstEvent(result.items)

  assert.equal(item.occurrences.length, 5)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-04', '2026-11-11', '2026-11-25', '2026-12-02', '2026-12-09'],
  )
  assert.ok(
    !item.occurrences.some((occurrence) => occurrence.localDate === '2026-11-18'),
    'EXDATE 当天不得出现实例',
  )
  assert.equal(item.occurrences[0].startIso, '2026-11-04T06:00:00.000Z')
  assert.equal(item.occurrences[0].endIso, '2026-11-04T07:00:00.000Z')
  assert.equal(item.occurrences[0].allDay, false)
  assert.equal(item.occurrences[0].isOverride, false)
  assert.equal(item.occurrences[0].recurrenceIdIso, '2026-11-04T06:00:00.000Z')
})

test('google：11-25 实例被替换（时间 16:00、标题「改到 16:00」、isOverride=true）', () => {
  const result = parseIcs(load('google-weekly-count-exdate.ics'), { nowIso: NOW })
  const item = firstEvent(result.items)
  const overridden = item.occurrences.find((occurrence) => occurrence.localDate === '2026-11-25')

  assert.ok(overridden, '被覆盖的实例必须仍然出现')
  assert.equal(overridden?.isOverride, true)
  assert.equal(overridden?.summary, '产品周会（改到 16:00）')
  assert.equal(overridden?.startIso, '2026-11-25T08:00:00.000Z', '覆盖实例的 DTSTART 是 16:00 +08')
  assert.equal(overridden?.endIso, '2026-11-25T09:00:00.000Z')
  assert.equal(overridden?.recurrenceIdIso, '2026-11-25T06:00:00.000Z', 'RECURRENCE-ID 指回原定时段 14:00')
})

/* ==================== 2. apple：MONTHLY BYDAY + UNTIL ==================== */

test('apple：FREQ=MONTHLY;BYDAY=2TU;UNTIL 展开 5 个实例且 UNTIL 之后停止', () => {
  const result = parseIcs(load('apple-monthly-byday-until.ics'), { nowIso: NOW })
  assert.equal(result.items.length, 1)
  assert.deepEqual(result.warnings, [])

  const item = firstEvent(result.items)
  assert.equal(item.rrule, 'FREQ=MONTHLY;BYDAY=2TU;UNTIL=20270331T015959Z')
  assert.equal(item.isRecurring, true)
  assert.equal(item.tzid, 'Asia/Shanghai')
  assert.equal(item.startIso, '2026-11-10T01:30:00.000Z', '09:30 +08 = 01:30Z')
  assert.equal(item.occurrences.length, 5)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-10', '2026-12-08', '2027-01-12', '2027-02-09', '2027-03-09'],
    '每月的第二个周二',
  )
  for (const occurrence of item.occurrences) {
    assert.ok(
      occurrence.startIso.endsWith('T01:30:00.000Z'),
      `全部实例都应是 09:30 +08（实际 ${occurrence.startIso}）`,
    )
  }
  assert.equal(item.occurrences[0].isOverride, false)
  assert.equal(item.alarms[0].trigger, '-PT30M')
})

/* ============ 3. outlook：全天（VALUE=DATE）+ 浮动时间 + Windows 时区名 ============ */

test('outlook：三条都能解析，顺序与文件一致', () => {
  const result = parseIcs(load('outlook-allday-floating.ics'), { nowIso: NOW })
  assert.equal(result.items.length, 3)
  assert.deepEqual(result.warnings, [])
  assert.deepEqual(
    result.items.map((item) => item.uid),
    ['allday-003@example.com', 'floating-004@example.com', 'tzid-ref-005@example.com'],
  )
  for (const item of result.items) assert.equal(item.kind, 'event')
})

test('outlook 第 1 条：VALUE=DATE 全天，日期不得前移一天', () => {
  const result = parseIcs(load('outlook-allday-floating.ics'), { nowIso: NOW })
  const item = result.items[0]

  assert.equal(item.allDay, true)
  assert.equal(item.rrule, null)
  assert.equal(item.tzid, null, '全天事件没有时区')
  assert.equal(item.tzidRaw, null)
  assert.equal(item.occurrences.length, 1, '非循环事件放 1 条自身实例')
  assert.equal(item.occurrences[0].allDay, true)
  assert.equal(item.occurrences[0].localDate, '2026-11-20')
  // 断言"本地日期"而不是 UTC 时刻：全天事件的 ISO 是本机该日 00:00，跨机器时刻不同
  assertLocalDate(item.startIso, '2026-11-20', '全天 DTSTART 必须是 11-20（不是 11-19）')
  assertLocalDate(item.occurrences[0].startIso, '2026-11-20', '实例日期同样不得前移')
  assertLocalDate(item.endIso, '2026-11-21', 'DTEND;VALUE=DATE 原样保留（RFC 里是开区间）')
})

test('outlook 第 2 条：浮动时间按本地解释（不得当 UTC）', () => {
  const result = parseIcs(load('outlook-allday-floating.ics'), { nowIso: NOW })
  const item = result.items[1]

  assert.equal(item.allDay, false)
  assert.equal(item.tzidRaw, null)
  assert.equal(item.tzid, null, '浮动时间没有可归一的时间区标识')
  assert.equal(item.occurrences[0].localDate, '2026-11-21')
  // 用"本地构造的 Date"反算，避免写死机器相关的 Z 偏移
  assert.equal(item.startIso, new Date(2026, 10, 21, 9, 30, 0, 0).toISOString(), '09:30 本地时间')
  assert.equal(item.endIso, new Date(2026, 10, 21, 10, 15, 0, 0).toISOString(), '10:15 本地时间')
})

test('outlook 第 3 条：Windows 时区名归一为 Asia/Shanghai，并按 +08 换算', () => {
  const result = parseIcs(load('outlook-allday-floating.ics'), { nowIso: NOW })
  const item = result.items[2]

  assert.equal(item.tzidRaw, 'China Standard Time', '原始 TZID 必须保留（来自属性参数，不是 zone.tzid）')
  assert.equal(item.tzid, 'Asia/Shanghai', 'Windows 名必须归一成 IANA')
  // 这一条是"只在非 +08 机器上才炸的雷"的守门断言：06:00Z 与运行机器时区无关
  assert.equal(item.startIso, '2026-11-22T06:00:00.000Z', '14:00 +08 = 06:00Z')
  assert.equal(item.endIso, '2026-11-22T07:00:00.000Z')
  assert.equal(item.occurrences[0].startIso, '2026-11-22T06:00:00.000Z')
})

/* ==================== 4. radicale：VTODO 四态 ==================== */

test('radicale：4 条 VTODO，顺序与 PRIORITY 原样读出 1/5/9/3', () => {
  const result = parseIcs(load('radicale-vtodo.ics'), { nowIso: NOW })
  assert.equal(result.items.length, 4)
  assert.deepEqual(result.warnings, [])
  for (const item of result.items) assert.equal(item.kind, 'todo')
  assert.deepEqual(
    result.items.map((item) => item.priority),
    [1, 5, 9, 3],
    'PRIORITY 原样 1..9（不做业务映射）',
  )
  assert.deepEqual(
    result.items.map((item) => item.uid),
    ['todo-101@example.com', 'todo-102@example.com', 'todo-103@example.com', 'todo-104@example.com'],
  )
})

test('radicale 第 1 条：定时 DUE + 多值 CATEGORIES + VALARM', () => {
  const result = parseIcs(load('radicale-vtodo.ics'), { nowIso: NOW })
  const item = result.items[0]

  assert.equal(item.summary, '提交季度报销')
  assert.equal(item.dueIso, '2026-11-05T10:00:00.000Z', '18:00 +08 = 10:00Z')
  assert.equal(item.tzidRaw, 'Asia/Shanghai')
  assert.equal(item.tzid, 'Asia/Shanghai')
  assert.equal(item.allDay, false)
  assert.equal(item.status, 'NEEDS-ACTION')
  assert.equal(item.percentComplete, 0)
  assert.deepEqual(item.categories, ['工作', '财务'], 'CATEGORIES 多值必须全取')
  assert.equal(item.description, '含 11 张发票\n金额合计 4,286.50 元', '\\n 与 \\, 都要还原')
  assert.equal(item.alarms.length, 1)
  assert.equal(item.alarms[0].trigger, '-PT60M')
  assert.equal(item.alarms[0].description, '报销今天到期')
})

test('radicale 第 2 条：仅日期 DUE + RELATED-TO 指回第 1 条', () => {
  const result = parseIcs(load('radicale-vtodo.ics'), { nowIso: NOW })
  const item = result.items[1]

  assert.equal(item.allDay, true, 'VALUE=DATE 的 DUE 是全天语义')
  assert.equal(item.tzid, null)
  assert.equal(item.tzidRaw, null)
  assertLocalDate(item.dueIso, '2026-11-03', '仅日期 DUE 不得前移一天')
  assert.equal(item.relatedTo, 'todo-101@example.com')
  assert.equal(item.startIso, null, '该条没有 DTSTART')
  assert.equal(item.percentComplete, 40)
})

test('radicale 第 3 条：带 RRULE 的循环待办（时间可读、但 todo 不展开实例）', () => {
  const result = parseIcs(load('radicale-vtodo.ics'), { nowIso: NOW })
  const item = result.items[2]

  assert.equal(item.rrule, 'FREQ=WEEKLY;BYDAY=MO')
  assert.equal(item.isRecurring, true)
  assert.equal(item.startIso, '2026-11-02T01:00:00.000Z', '09:00 +08 = 01:00Z')
  assert.equal(item.dueIso, '2026-11-02T01:30:00.000Z', '09:30 +08 = 01:30Z')
  assert.equal(item.priority, 9)
  assert.deepEqual(item.occurrences, [], 'todo 恒不展开实例')
})

test('radicale 第 4 条：已完成待办（STATUS / COMPLETED / PERCENT-COMPLETE）', () => {
  const result = parseIcs(load('radicale-vtodo.ics'), { nowIso: NOW })
  const item = result.items[3]

  assert.equal(item.status, 'COMPLETED')
  assert.equal(item.percentComplete, 100)
  assert.equal(item.completedIso, '2026-10-29T08:00:00.000Z')
  assertLocalDate(item.dueIso, '2026-10-29', '仅日期 DUE')
  assert.equal(item.priority, 3)
})

test('radicale：所有 VTODO 的 occurrences 都是空数组', () => {
  const result = parseIcs(load('radicale-vtodo.ics'), { nowIso: NOW })
  for (const item of result.items) {
    assert.deepEqual(item.occurrences, [], `VTODO ${item.uid} 不得展开实例`)
  }
})

/* ==================== 5. self-export：折行 + 转义还原 ==================== */

test('self-export：SUMMARY 折行还原后逐字等于原文（80 字）', () => {
  const expected =
    '买牛奶,鸡蛋;顺便取快递（这是一个特意写得很长的标题，用来验证 RFC 5545 的 75 字节折行是否被正确还原，还原后应与原文完全一致，不得多出空格或漏字）'
  const result = parseIcs(load('self-export-roundtrip.ics'), { nowIso: NOW })
  const todo = result.items.find((item) => item.kind === 'todo' && item.uid === 'rec-9001@personal-agent')

  assert.ok(todo, '应当找到 rec-9001 的 VTODO')
  assert.equal(expected.length, 80, '基准字符串长度必须是 80')
  assert.equal(todo?.summary, expected, '折行还原不得多空格、不得漏字')
  assert.equal(todo?.summary.length, 80)
})

test('self-export：\\, \\; \\\\ \\n 四类转义全部还原', () => {
  const result = parseIcs(load('self-export-roundtrip.ics'), { nowIso: NOW })
  const todo = result.items.find((item) => item.kind === 'todo' && item.uid === 'rec-9001@personal-agent')
  const event = result.items.find((item) => item.kind === 'event')

  assert.equal(todo?.description, '第一行\n第二行含反斜杠 \\ 与逗号 , 分号 ;')
  assert.equal(event?.summary, '买牛奶,鸡蛋;顺便取快递')
  assert.equal(event?.startIso, '2026-11-01T09:30:00.000Z')
  assert.equal(event?.tzid, 'UTC')
  assert.equal(event?.alarms[0].trigger, '-PT10M')
})

test('self-export：同 UID 的 VTODO 与 VEVENT 不得被合并（按 kind 分组）', () => {
  const result = parseIcs(load('self-export-roundtrip.ics'), { nowIso: NOW })
  assert.equal(result.items.length, 3, '2 条 VTODO + 1 条 VEVENT')
  assert.equal(result.items.filter((item) => item.kind === 'todo').length, 2)
  assert.equal(result.items.filter((item) => item.kind === 'event').length, 1)
  assert.deepEqual(result.warnings, [])
  assert.equal(result.timezone, 'Asia/Shanghai')
})

test('self-export：已完成 VTODO 可读，event 非循环只放 1 条自身实例', () => {
  const result = parseIcs(load('self-export-roundtrip.ics'), { nowIso: NOW })
  const done = result.items.find((item) => item.uid === 'rec-9002@personal-agent')
  const event = result.items.find((item) => item.kind === 'event')

  assert.equal(done?.status, 'COMPLETED')
  assert.equal(done?.percentComplete, 100)
  assert.equal(done?.kind, 'todo')
  assert.equal(done?.dueIso, '2026-10-20T02:00:00.000Z')
  assert.equal(event?.occurrences.length, 1)
  assert.equal(event?.occurrences[0].startIso, '2026-11-01T09:30:00.000Z')
  assert.equal(event?.occurrences[0].localDate, '2026-11-01')
  assert.equal(event?.occurrences[0].isOverride, false)
  assert.equal(event?.occurrences[0].recurrenceIdIso, null)
})

/* ==================== 6. 容错与展开上限 ==================== */

test('容错：空文本 / 纯空白都不抛，返回可读 warning', () => {
  for (const text of ['', '   ', '\r\n\r\n', '\t\n']) {
    const result = parseIcs(text, { nowIso: NOW })
    assert.equal(result.items.length, 0)
    assert.equal(result.calendarName, null)
    assert.equal(result.timezone, null)
    assert.ok(result.warnings.length >= 1, `空输入必须给出 warning（实际 ${JSON.stringify(result.warnings)}）`)
  }
})

test('容错：非 VCALENDAR 与非 iCalendar 文本都不抛', () => {
  const notCalendar = parseIcs(ics(['BEGIN:VEVENT', 'UID:x@qa', 'END:VEVENT']), { nowIso: NOW })
  assert.equal(notCalendar.items.length, 0)
  assert.ok(notCalendar.warnings.some((warning) => warning.includes('VCALENDAR')))

  const garbage = parseIcs('这不是一个日历文件', { nowIso: NOW })
  assert.equal(garbage.items.length, 0)
  assert.equal(garbage.warnings.length, 1)
})

test('容错：空 VCALENDAR 返回 0 条且无 warning', () => {
  const result = parseIcs(ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//qa//EN', 'END:VCALENDAR']), {
    nowIso: NOW,
  })
  assert.deepEqual(result.items, [])
  assert.deepEqual(result.warnings, [])
  assert.equal(result.calendarName, null)
})

/** 无 COUNT / UNTIL 的每日循环事件（展开上限与时间窗的测试载体）。 */
const INFINITE_ICS = ics([
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'PRODID:-//qa//EN',
  'BEGIN:VEVENT',
  'UID:infinite-001@qa',
  'DTSTAMP:20261030T000000Z',
  'DTSTART:20261101T090000Z',
  'DTEND:20261101T100000Z',
  'SUMMARY:无限循环',
  'RRULE:FREQ=DAILY',
  'END:VEVENT',
  'END:VCALENDAR',
])

test('上限：无 COUNT/UNTIL 的 RRULE 在 maxOccurrences=3 下只出 3 条且带截断 warning', () => {
  const result = parseIcs(INFINITE_ICS, { nowIso: NOW, maxOccurrences: 3 })
  const item = firstEvent(result.items)

  assert.equal(item.occurrences.length, 3)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-01', '2026-11-02', '2026-11-03'],
  )
  assert.ok(
    result.warnings.some((warning) => warning.includes('截断')),
    `必须明确提示"被截断"而不是解析失败（实际 ${JSON.stringify(result.warnings)}）`,
  )
})

test('上限：horizonDays 生效，超出时间窗的实例不再展开', () => {
  const wide = parseIcs(INFINITE_ICS, { nowIso: NOW, maxOccurrences: 5 })
  assert.equal(firstEvent(wide.items).occurrences.length, 5, '默认时间窗内应有 5 条')

  // now = 2026-10-30T12:00Z，horizonDays=3 → 右界 2026-11-02T12:00Z，11-03 之后被截断
  const narrow = parseIcs(INFINITE_ICS, { nowIso: NOW, maxOccurrences: 5, horizonDays: 3 })
  const narrowItem = firstEvent(narrow.items)
  assert.equal(narrowItem.occurrences.length, 2)
  assert.deepEqual(
    narrowItem.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-01', '2026-11-02'],
  )
  assert.ok(narrow.warnings.some((warning) => warning.includes('时间窗')))
})

test('上限：maxOccurrences 被夹取到 [1, 2000]（传 0 按 1 处理，不得死循环）', () => {
  const result = parseIcs(INFINITE_ICS, { nowIso: NOW, maxOccurrences: 0 })
  assert.equal(firstEvent(result.items).occurrences.length, 1)

  const huge = parseIcs(INFINITE_ICS, { nowIso: NOW, maxOccurrences: 99999 })
  const hugeCount = firstEvent(huge.items).occurrences.length
  assert.ok(hugeCount > 5 && hugeCount <= 2000, `夹取到 2000 以内（实际 ${hugeCount}）`)
})

test('合并：只有覆盖实例、缺少主事件时按独立事件输出并加 warning', () => {
  const orphan = ics([
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//qa//EN',
    'BEGIN:VEVENT',
    'UID:orphan-001@qa',
    'DTSTAMP:20261030T000000Z',
    'RECURRENCE-ID;TZID=Asia/Shanghai:20261125T140000',
    'DTSTART;TZID=Asia/Shanghai:20261125T160000',
    'DTEND;TZID=Asia/Shanghai:20261125T170000',
    'SUMMARY:孤立覆盖实例',
    'END:VEVENT',
    'END:VCALENDAR',
  ])
  const result = parseIcs(orphan, { nowIso: NOW })

  assert.equal(result.items.length, 1, '不得静默丢数据')
  assert.equal(result.items[0].summary, '孤立覆盖实例')
  assert.equal(result.items[0].startIso, '2026-11-25T08:00:00.000Z')
  assert.equal(result.items[0].occurrences.length, 1)
  assert.equal(result.items[0].occurrences[0].isOverride, true, '自身就是覆盖实例')
  assert.equal(result.items[0].occurrences[0].recurrenceIdIso, '2026-11-25T06:00:00.000Z')
  assert.ok(
    result.warnings.some((warning) => warning.includes('覆盖实例')),
    '缺少主事件必须提示',
  )
})

test('纯函数：同一输入 + 同一 nowIso 两次解析结果完全一致', () => {
  const text = load('google-weekly-count-exdate.ics')
  const first = parseIcs(text, { nowIso: NOW })
  const second = parseIcs(text, { nowIso: NOW })
  assert.deepEqual(second, first)
})

/* ==================== 7. normalizeTzid ==================== */

test('normalizeTzid：Windows 名归一、IANA 原样、浮动/空为 null、大小写不敏感', () => {
  assert.equal(normalizeTzid('China Standard Time'), 'Asia/Shanghai')
  assert.equal(normalizeTzid('china standard time'), 'Asia/Shanghai')
  assert.equal(normalizeTzid('  China Standard Time  '), 'Asia/Shanghai')
  assert.equal(normalizeTzid('Tokyo Standard Time'), 'Asia/Tokyo')
  assert.equal(normalizeTzid('Korea Standard Time'), 'Asia/Seoul')
  assert.equal(normalizeTzid('W. Europe Standard Time'), 'Europe/Berlin')
  assert.equal(normalizeTzid('GMT Standard Time'), 'Europe/London')
  assert.equal(normalizeTzid('Eastern Standard Time'), 'America/New_York')
  assert.equal(normalizeTzid('Pacific Standard Time'), 'America/Los_Angeles')
  assert.equal(normalizeTzid('UTC'), 'UTC')
  assert.equal(normalizeTzid('utc'), 'UTC')
  assert.equal(normalizeTzid('Asia/Shanghai'), 'Asia/Shanghai', '已是 IANA 名原样返回')
  assert.equal(normalizeTzid('America/Argentina/Buenos_Aires'), 'America/Argentina/Buenos_Aires')
  assert.equal(normalizeTzid('floating'), null)
  assert.equal(normalizeTzid('FLOATING'), null)
  assert.equal(normalizeTzid(''), null)
  assert.equal(normalizeTzid('   '), null)
  assert.equal(normalizeTzid(null), null)
  assert.equal(normalizeTzid(undefined), null)
  assert.equal(normalizeTzid('Unknown Zone'), null, '认不出的名字交给上层按浮动处理并加 warning')
})
