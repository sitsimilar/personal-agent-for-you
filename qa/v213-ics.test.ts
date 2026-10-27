/**
 * v2.13 R6「日历导出 .ics」测试。
 *
 * 三段：
 * 1. 纯函数（`web/src/lib/ics.ts`）：UTF-8 字节折行（75 字节 / 续行前导空格 / 中文 3 字节）、
 *    RFC 5545 转义顺序、UTC 时间形式、UID 稳定性、状态与优先级映射、`dtstampIso` 注入；
 * 2. 视图边界（`web/src/lib/calendar-range.ts`）：月 = 当月 1 日 → 次月 1 日、周 = 周一 → 下周一（左闭右开）；
 * 3. 服务层（`web/src/services/calendarService.ts`）：范围过滤走 `remind_at`、空集抛错不下空文件。
 *
 * 另有一条「源码守门」：`ics.ts` 里**不允许出现 `Date.now()`**（DTSTAMP 必须外部注入，
 * 否则单测不可重放、同一份数据每次导出都会产生 diff）。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  __dbCalls,
  __queueDbResults,
  __resetDbCalls,
  __resetDbQueue,
  __setDbResult,
} from './mocks/cloud'
import {
  ICS_CRLF,
  ICS_MAX_LINE_BYTES,
  buildIcs,
  icsEscape,
  icsFileName,
  foldLine,
  toIcsUtc,
  utf8ByteLength,
  type IcsSource,
} from '../web/src/lib/ics'
import { resolveViewRange } from '../web/src/lib/calendar-range'
import { calendarService } from '../web/src/services/calendarService'
import type { RecordsRow } from '../web/src/lib/database.types'

const DTSTAMP = '2026-10-27T02:00:00.000Z'

/** 构造一条待导出的记录。 */
function src(over: Partial<IcsSource> = {}): IcsSource {
  return {
    id: 1,
    title: '交周报',
    content: null,
    category: null,
    priority: null,
    todoStatus: 'pending',
    remindAt: '2026-10-27T01:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...over,
  }
}

/** 取文本中的某类行（已展开折行，便于断言）。 */
function lines(content: string): string[] {
  return content.split(ICS_CRLF).filter((l) => l.length > 0)
}

/** 展开一段已折行的文本（去掉 CRLF 与续行前导空格）。 */
function unfoldedOf(folded: string): string {
  return folded
    .split(ICS_CRLF)
    .map((part, i) => (i === 0 ? part : part.slice(1)))
    .join('')
}

beforeEach(() => {
  __resetDbCalls()
  __resetDbQueue()
  __setDbResult({ data: [] })
})

/* ============================== 1. 纯函数 ============================== */

test('utf8ByteLength：ASCII 1 / 中文 3 / emoji 4 字节', () => {
  assert.equal(utf8ByteLength('abc'), 3)
  assert.equal(utf8ByteLength('中文'), 6)
  assert.equal(utf8ByteLength('🙂'), 4)
})

test('icsEscape：先转义反斜杠再转义 ; , 与换行（不会被二次转义）', () => {
  assert.equal(icsEscape('a\\b'), 'a\\\\b')
  assert.equal(icsEscape('a;b,c'), 'a\\;b\\,c')
  assert.equal(icsEscape('第一行\r\n第二行'), '第一行\\n第二行')
  assert.equal(icsEscape('第一行\n第二行'), '第一行\\n第二行')
  // 反斜杠只被转义一次：'a\b' → 'a\\b'（不是 'a\\\\b'）
  assert.equal(icsEscape('a\\b;c'), 'a\\\\b\\;c')
})

test('foldLine：按 UTF-8 字节折行，每行 ≤ 75 字节，展开后与原文一致', () => {
  const line = `SUMMARY:${'中'.repeat(40)}`
  const folded = foldLine(line)
  const parts = folded.split(ICS_CRLF)
  assert.ok(parts.length > 1, '长中文行必须折行')
  for (const part of parts) {
    assert.ok(utf8ByteLength(part) <= ICS_MAX_LINE_BYTES, `每行不得超过 ${ICS_MAX_LINE_BYTES} 字节：${part}`)
  }
  for (const part of parts.slice(1)) assert.ok(part.startsWith(' '), '续行必须以单个空格开头')
  assert.equal(unfoldedOf(folded), line, '折行不可丢字符（中文不能按字符数折）')
})

test('foldLine：短行原样返回（不额外加 CRLF）', () => {
  assert.equal(foldLine('VERSION:2.0'), 'VERSION:2.0')
})

test('toIcsUtc：转成 UTC 形式 YYYYMMDDTHHMMSSZ；非法输入返回 null', () => {
  assert.equal(toIcsUtc('2026-10-27T02:00:00.000Z'), '20261027T020000Z')
  assert.equal(toIcsUtc('2026-10-27T10:00:00+08:00'), '20261027T020000Z')
  assert.equal(toIcsUtc(null), null)
  assert.equal(toIcsUtc(''), null)
  assert.equal(toIcsUtc('not-a-date'), null)
})

test('buildIcs：头部含 VERSION / PRODID / X-WR-TIMEZONE，行尾统一 CRLF 且以 CRLF 结束', () => {
  const { content } = buildIcs([src()], { dtstampIso: DTSTAMP })
  const raw = lines(content)
  assert.equal(raw[0], 'BEGIN:VCALENDAR')
  assert.ok(raw.includes('VERSION:2.0'))
  assert.ok(raw.includes('CALSCALE:GREGORIAN'))
  assert.ok(raw.includes('X-WR-TIMEZONE:Asia/Shanghai'))
  assert.equal(raw[raw.length - 1], 'END:VCALENDAR')
  assert.ok(content.endsWith(ICS_CRLF), '文件必须以 CRLF 结尾')
  assert.ok(!/[^\r]\n/.test(content), '不得出现裸 LF（RFC 5545 要求 CRLF）')
  assert.ok(!content.includes('BEGIN:VTIMEZONE'), '不内嵌 VTIMEZONE（统一走 UTC 形式）')
})

test('buildIcs：UID 稳定且带固定域名；无 remind_at 时只出 VTODO 不出 VEVENT', () => {
  const { content, todoCount, eventCount } = buildIcs([src({ id: 42, remindAt: null })], {
    dtstampIso: DTSTAMP,
  })
  const raw = lines(content)
  assert.ok(raw.includes('UID:record-42@personal-agent'))
  assert.ok(!raw.some((l) => l.startsWith('UID:record-42-event')))
  assert.equal(todoCount, 1)
  assert.equal(eventCount, 0)
  assert.ok(!raw.some((l) => l.startsWith('DUE:')), '无提醒时间不写 DUE')
})

test('buildIcs：有 remind_at 时额外产出一个 30 分钟 VEVENT（独立 UID）', () => {
  const { content, todoCount, eventCount } = buildIcs([src({ id: 42 })], { dtstampIso: DTSTAMP })
  const raw = lines(content)
  assert.ok(raw.includes('BEGIN:VEVENT'))
  assert.ok(raw.includes('UID:record-42-event@personal-agent'))
  assert.ok(raw.includes('DTSTART:20261027T010000Z'))
  assert.ok(raw.includes('DURATION:PT30M'))
  assert.equal(todoCount, 1)
  assert.equal(eventCount, 1)
})

test('buildIcs：DTSTAMP 用注入值（同一输入两次导出完全一致）', () => {
  const a = buildIcs([src()], { dtstampIso: DTSTAMP }).content
  const b = buildIcs([src()], { dtstampIso: DTSTAMP }).content
  assert.equal(a, b, '纯函数不得依赖当前时钟')
  assert.ok(lines(a).includes('DTSTAMP:20261027T020000Z'))
})

test('buildIcs：STATUS / PRIORITY / COMPLETED 映射（done 用 updated_at 作完成时间）', () => {
  const pending = buildIcs([src({ id: 1, priority: 'high' })], { dtstampIso: DTSTAMP }).content
  const pendingLines = lines(pending)
  assert.ok(pendingLines.includes('STATUS:NEEDS-ACTION'))
  assert.ok(pendingLines.includes('PRIORITY:1'))
  assert.ok(!pendingLines.some((l) => l.startsWith('COMPLETED:')))

  const done = buildIcs(
    [src({ id: 2, todoStatus: 'done', priority: 'low', updatedAt: '2026-10-26T03:04:05.000Z' })],
    { dtstampIso: DTSTAMP, includeDone: true },
  ).content
  const doneLines = lines(done)
  assert.ok(doneLines.includes('STATUS:COMPLETED'))
  assert.ok(doneLines.includes('PRIORITY:9'))
  assert.ok(doneLines.includes('COMPLETED:20261026T030405Z'))

  const medium = buildIcs([src({ id: 3, priority: 'medium' })], { dtstampIso: DTSTAMP }).content
  assert.ok(lines(medium).includes('PRIORITY:5'))
})

test('buildIcs：默认跳过已完成待办（双保险，查询层已过滤）', () => {
  const { todoCount } = buildIcs(
    [src({ id: 1 }), src({ id: 2, todoStatus: 'done' })],
    { dtstampIso: DTSTAMP },
  )
  assert.equal(todoCount, 1)

  const withDone = buildIcs([src({ id: 1 }), src({ id: 2, todoStatus: 'done' })], {
    dtstampIso: DTSTAMP,
    includeDone: true,
  })
  assert.equal(withDone.todoCount, 2)
})

test('buildIcs：标题/正文/分类做 RFC 5545 转义（分号、逗号、换行）', () => {
  const { content } = buildIcs(
    [src({ title: '买牛奶;鸡蛋,面包', content: '第一行\n第二行', category: '生活' })],
    { dtstampIso: DTSTAMP },
  )
  const raw = lines(content)
  assert.ok(raw.includes('SUMMARY:买牛奶\\;鸡蛋\\,面包'))
  assert.ok(raw.includes('DESCRIPTION:第一行\\n第二行'))
  assert.ok(raw.includes('CATEGORIES:生活'))
})

test('buildIcs：空集只产出空的 VCALENDAR（不抛错，由调用方决定是否下载）', () => {
  const { content, todoCount, eventCount } = buildIcs([], { dtstampIso: DTSTAMP })
  assert.equal(todoCount, 0)
  assert.equal(eventCount, 0)
  assert.deepEqual(lines(content), [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//personal-agent//v2.13//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-TIMEZONE:Asia/Shanghai',
    'END:VCALENDAR',
  ])
})

test('icsFileName：personal-agent-YYYYMMDD.ics（按注入时刻的本地日期）', () => {
  assert.equal(icsFileName(Date.parse('2026-10-27T10:00:00+08:00')), 'personal-agent-20261027.ics')
})

test('源码守门：ics.ts 不读 Date.now()（DTSTAMP 必须外部注入）', () => {
  const source = readFileSync(resolve(__dirname, '..', '..', 'web/src/lib/ics.ts'), 'utf8')
  // 先剥掉注释（文件头说明里会写「不读 Date.now()」），只检查真正的代码
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /Date\.now\s*\(/, '纯函数不得读当前时钟')
  assert.match(source, /dtstampIso/, 'DTSTAMP 必须由入参注入')
})

/* ============================ 2. 视图边界 ============================ */

test('resolveViewRange（月）：当月 1 日 → 次月 1 日，左闭右开', () => {
  const [start, end] = resolveViewRange('month', new Date(2026, 9, 15))
  assert.equal(start.getDate(), 1)
  assert.equal(start.getMonth(), 9)
  assert.equal(start.getHours(), 0)
  assert.equal(end.getDate(), 1)
  assert.equal(end.getMonth(), 10, '次月 1 日（开区间）')
})

test('resolveViewRange（周）：本周一 00:00 → 下周一 00:00，且周一为一周起点', () => {
  // 2026-10-28 是周三
  const [start, end] = resolveViewRange('week', new Date(2026, 9, 28))
  assert.equal(start.getDay(), 1, '起点必须是周一')
  assert.equal(start.getDate(), 26)
  assert.equal(end.getDay(), 1, '终点必须是下周一')
  assert.equal(end.getDate(), 2)
  assert.equal(end.getMonth(), 10)
  // 周日归到上一个周一
  const [sunStart] = resolveViewRange('week', new Date(2026, 9, 25))
  assert.equal(sunStart.getDate(), 19)
})

/* ============================ 3. 服务层 ============================ */

/** 构造一行 records 数据。 */
function row(over: Partial<RecordsRow> = {}): RecordsRow {
  return {
    id: 1,
    owner_id: 'u1',
    type: 'todo',
    title: '交周报',
    content: null,
    url: null,
    file_path: null,
    category: null,
    tags: [],
    summary: null,
    todo_status: 'pending',
    priority: 'high',
    remind_at: '2026-10-27T01:00:00.000Z',
    recurrence: null,
    recurrence_parent_id: null,
    recurrence_next_id: null,
    link_meta: null,
    is_deleted: false,
    deleted_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-26T00:00:00.000Z',
    ...over,
  }
}

test('buildExport：当前月/当前周按 remind_at 过滤（gte + lt），文件名与统计正确', async () => {
  __resetDbCalls()
  __queueDbResults([{ data: [row({ id: 11 }), row({ id: 12, remind_at: null })] }])

  const result = await calendarService.buildExport({
    range: 'month',
    viewMode: 'month',
    anchor: new Date(2026, 9, 15),
    includeDone: false,
  })

  assert.ok(__dbCalls.some((c) => c.startsWith('gte(remind_at,')), '范围导出必须按 remind_at 左界过滤')
  assert.ok(__dbCalls.some((c) => c.startsWith('lt(remind_at,')), '范围导出必须按 remind_at 右界过滤（左闭右开）')
  assert.ok(__dbCalls.includes('eq(todo_status,"pending")'), '默认只导出未完成')
  assert.equal(result.recordCount, 2)
  assert.equal(result.todoCount, 2)
  assert.equal(result.eventCount, 1, '只有带提醒时间的那条产出 VEVENT')
  assert.match(result.fileName, /^personal-agent-\d{8}\.ics$/)
  assert.ok(result.content.includes('UID:record-11@personal-agent'))
})

test('buildExport：范围=全部时不过滤时间，且包含已完成待办', async () => {
  __resetDbCalls()
  __queueDbResults([{ data: [row({ id: 21, todo_status: 'done' })] }])

  const result = await calendarService.buildExport({
    range: 'all',
    viewMode: 'month',
    anchor: new Date(2026, 9, 15),
    includeDone: true,
  })

  assert.ok(!__dbCalls.some((c) => c.startsWith('gte(remind_at,')), '全部范围不应限制时间')
  assert.ok(!__dbCalls.some((c) => c.startsWith('lt(remind_at,')), '全部范围不应限制时间')
  assert.ok(!__dbCalls.includes('eq(todo_status,"pending")'), '包含已完成时不得过滤状态')
  assert.ok(result.content.includes('STATUS:COMPLETED'))
})

test('buildExport：范围内没有待办时抛错（不下载空文件）', async () => {
  __queueDbResults([{ data: [] }])
  await assert.rejects(
    () =>
      calendarService.buildExport({
        range: 'week',
        viewMode: 'week',
        anchor: new Date(2026, 9, 28),
        includeDone: false,
      }),
    /当前范围没有可导出的待办/,
  )
})

test('calendarService 暴露 buildExport 与 downloadIcs（下载与构造分离，便于单测）', () => {
  assert.equal(typeof calendarService.buildExport, 'function')
  assert.equal(typeof calendarService.downloadIcs, 'function')
})
