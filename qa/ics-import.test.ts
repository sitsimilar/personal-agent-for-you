/**
 * .ics 导入落库链路单测（`web/src/services/icsImportService.ts`）—— 解析 → 预览 → 查重 → 落库。
 *
 * 这是「日历互通 P0-1 下半」的当日验收线，覆盖 7 组必须通过的行为：
 * 1. **5 组件样本**（`qa/fixtures/ics/jtxboard-journal.ics`）：`counts` 分布 = 1/3/1、`cancelled` = 1；
 *    `PRIORITY:1` → `high`；已完成那条 `todoStatus=done` 且 `recordMeta.completedAt` 非空；
 *    且已完成条目**不进三段视图**（`todo_status='done'` 被 `TodoPage` 的 pending 过滤挡在外面）；
 * 2. **幂等**：第一次导入 `created=5`；第二次查重命中同一批 `external_uid` → `created=0`、`skipped=5`；
 *    插入行必须带 `external_uid` 与 `record_meta.importedAt`（否则查重/追溯都失效）；
 * 3. **迁移未执行**（`42703`）：整次报错、文案指向 `docs/v2.14/migration.sql`，且**一条 insert 都不许发生**；
 * 4. **空文件 / 非 VCALENDAR**：抛「没有可导入的日历条目」，且不发起任何查询；
 * 5. **STATUS:CANCELLED**：落库 `is_deleted=true` 且 `deleted_at` 非空（进回收站而不是丢弃）；
 * 6. **分批**：21 条必须拆成 2 次 insert（单批上限 20）；
 * 7. **冲突降级**（`23505`）：整批冲突 + 逐条重试仍冲突 → `created=0`、`skipped=总数`，**不抛错**。
 *
 * 时钟一律由 `nowIso` 注入，因此与运行机器时区/时刻无关；`cloud.database` 由
 * `qa/mocks/cloud.ts` 替换（用法照 `qa/recordService-crud.test.ts`）。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { InfoRecord } from '@shared/types/domain'
import {
  __dbCalls,
  __dbInserts,
  __queueDbResults,
  __resetDbCalls,
  __resetDbQueue,
  __resetDbWrites,
  __setDbResult,
} from './mocks/cloud'
import {
  describeIcsImportError,
  importIcs,
  isIcsImportError,
  previewIcs,
} from '../web/src/services/icsImportService'
import { bucketCounts, splitByBucket } from '../web/src/lib/todo-segments'

/** 注入的"导入时刻"（同时充当 `record_meta.importedAt` 与 `deleted_at`）。 */
const NOW = '2026-10-30T12:00:00.000Z'
/** 东八区偏移（分钟）：三段视图判定显式注入，避免依赖运行机器时区。 */
const TZ_OFFSET = 480
/** bundle 产物在 `qa/dist/`，向上一级即 `qa/`。 */
const FIXTURE_DIR = resolve(__dirname, '..', 'fixtures', 'ics')
/** 5 组件样本（1 VEVENT + 3 VTODO + 1 VJOURNAL）。 */
const FIXTURE = 'jtxboard-journal.ics'
/** 迁移未执行时的修复指引片段（文案必须原样到达用户）。 */
const MIGRATION_PATH = 'docs/v2.14/migration.sql'
/** `friendlyError()` 的兜底文案：迁移提示**不允许**退化成它。 */
const GENERIC_FAILURE = '操作失败，请稍后重试'

beforeEach(() => {
  __resetDbCalls()
  __resetDbQueue()
  __resetDbWrites()
  __setDbResult({ data: [] })
})

/** 读夹具（保留 CRLF，ical.js 自己处理折行与行尾）。 */
function load(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf8')
}

/** 用行数组拼一段 .ics（CRLF，符合 RFC 5545）。 */
function ics(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

/** 断言 `iso` 在给定时区偏移下落在该日期（全天属性跨机器稳定地断言"墙钟日期"）。 */
function assertLocalDate(iso: string | null, expected: string, message: string): void {
  assert.ok(iso, `${message}：iso 不得为空`)
  const shifted = new Date(Date.parse(iso as string) + TZ_OFFSET * 60_000)
  const local = `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`
  assert.equal(local, expected, message)
}

/** 把 `__dbInserts` 里的批次摊平成行（单条重试时是对象，批量时是数组）。 */
function insertedRows(): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const batch of __dbInserts) {
    if (Array.isArray(batch)) rows.push(...(batch as Array<Record<string, unknown>>))
    else if (batch && typeof batch === 'object') rows.push(batch as Record<string, unknown>)
  }
  return rows
}

/** 按 `external_uid` 取插入行（找不到直接失败，避免 `?.` 静默通过）。 */
function rowByUid(uid: string): Record<string, unknown> {
  const row = insertedRows().find((item) => item.external_uid === uid)
  assert.ok(row, `插入行里应存在 external_uid=${uid} 的记录`)
  return row
}

/** 统计某类数据库调用次数（`insert` 被调几次 = 写了几批）。 */
function countCalls(token: string): number {
  return __dbCalls.filter((call) => call === token).length
}

/**
 * 用代码循环拼一段含 `count` 条 VTODO 的 .ics（分批用例专用，绝不手写 21 段）。
 *
 * @param count 待办条数
 */
function buildManyTodosIcs(count: number): string {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//qa//EN', 'CALSCALE:GREGORIAN']
  for (let index = 1; index <= count; index += 1) {
    const day = String(index).padStart(2, '0')
    lines.push(
      'BEGIN:VTODO',
      `UID:batch-todo-${index}@qa`,
      'DTSTAMP:20261030T000000Z',
      `SUMMARY:批量待办 ${index}`,
      `DUE:202611${day}T100000Z`,
      'PRIORITY:5',
      'STATUS:NEEDS-ACTION',
      'END:VTODO',
    )
  }
  lines.push('END:VCALENDAR')
  return ics(lines)
}

/* ==================== 1. 5 组件样本：预览与计数 ==================== */

test('样本：5 个组件 → counts 分布 1/3/1，cancelled 单列 1，日历名与警告可读', () => {
  const preview = previewIcs(load(FIXTURE), { nowIso: NOW })

  assert.equal(preview.calendarName, 'jtxBoard 样本', 'X-WR-CALNAME 必须读到')
  assert.equal(preview.drafts.length, 5, '5 个组件应产出 5 条草稿（导入后记录数 = 5）')
  assert.deepEqual(
    preview.counts,
    { total: 5, event: 1, todo: 3, journal: 1, cancelled: 1 },
    'event/todo/journal = 1/3/1，取消项单列计数（取消项也算 total）',
  )
  assert.deepEqual(preview.warnings, [], '样本文件不应产生任何 warning')
})

test('样本：预览与落库共用同一个 importedAt（用户看到的与导进去的是同一批数据）', () => {
  const preview = previewIcs(load(FIXTURE), { nowIso: NOW })
  for (const draft of preview.drafts) {
    assert.equal(draft.recordMeta.importedAt, NOW, `草稿「${draft.title}」必须盖上注入的导入时刻`)
  }
})

test('样本：VEVENT 落成带提醒的待办，多值 CATEGORIES 命中预置分类且 tags 不丢', () => {
  const preview = previewIcs(load(FIXTURE), { nowIso: NOW })
  const event = preview.drafts.find((draft) => draft.externalUid === 'jtx-event-201@example.com')
  assert.ok(event, '应能按 UID 找到 VEVENT 草稿')

  assert.equal(event?.type, 'todo', 'VEVENT 落成 type=todo（本产品无"日程"类型）')
  assert.equal(event?.icsKind, 'event')
  assert.equal(event?.remindAt, '2026-11-10T01:30:00.000Z', 'DTSTART 09:30 +08 = 01:30Z')
  assert.equal(event?.category, '工作/会议', 'CATEGORIES 里命中预置分类 key')
  assert.deepEqual(event?.tags, ['工作/会议', '会议'], 'CATEGORIES 多值全部进 tags 并去重')
  assert.equal(event?.priority, 'medium', 'PRIORITY:5 → medium')
})

test('样本：PRIORITY:1 那条映射为 high，已完成那条 todoStatus=done 且 completedAt 非空', () => {
  const preview = previewIcs(load(FIXTURE), { nowIso: NOW })

  const high = preview.drafts.find((draft) => draft.externalUid === 'jtx-todo-301@example.com')
  assert.ok(high, '应能按 UID 找到 PRIORITY:1 的待办')
  assert.equal(high?.priority, 'high', 'PRIORITY:1 是 RFC 的最高优先级 → high')
  assert.equal(high?.remindAt, '2026-11-12T10:00:00.000Z', 'remindAt 取 DUE（18:00 +08 = 10:00Z）')

  const done = preview.drafts.find((draft) => draft.externalUid === 'jtx-todo-302@example.com')
  assert.ok(done, '应能按 UID 找到已完成的待办')
  assert.equal(done?.todoStatus, 'done', 'STATUS:COMPLETED → todoStatus=done')
  assert.ok(done?.recordMeta.completedAt, '已完成条目的 record_meta.completedAt 不得为空')
  assert.equal(done?.recordMeta.completedAt, '2026-10-28T03:00:00.000Z', 'COMPLETED 原样归一成 UTC ISO')
  assertLocalDate(done?.remindAt ?? null, '2026-11-01', 'DUE;VALUE=DATE 按墙钟日期解析（不得前移一天）')
})

test('样本：VJOURNAL 落成 type=idea 且 remindAt=null（笔记不排期）', () => {
  const preview = previewIcs(load(FIXTURE), { nowIso: NOW })
  const journal = preview.drafts.find((draft) => draft.externalUid === 'jtx-journal-401@example.com')

  assert.ok(journal, '应能按 UID 找到 VJOURNAL 草稿')
  assert.equal(journal?.type, 'idea')
  assert.equal(journal?.icsKind, 'journal')
  assert.equal(journal?.remindAt, null, '笔记不参与排期，remindAt 必须为 null')
  assert.equal(journal?.recordMeta.dtstart, '2026-10-30T13:30:00.000Z', 'DTSTART 只作元数据备查')
})

test('样本：STATUS:CANCELLED 那条预览即标 deleted（导入后进回收站）', () => {
  const preview = previewIcs(load(FIXTURE), { nowIso: NOW })
  const cancelled = preview.drafts.find((draft) => draft.externalUid === 'jtx-todo-303@example.com')

  assert.ok(cancelled, '应能按 UID 找到已取消的待办')
  assert.equal(cancelled?.deleted, true)
  assert.equal(cancelled?.priority, 'low', 'PRIORITY:9 → low')
})

test('样本：已完成条目不会出现在三段视图里（todo_status=done 被 pending 过滤挡掉）', () => {
  const preview = previewIcs(load(FIXTURE), { nowIso: NOW })

  // 对齐 TodoPage：列表来自 listRecords({ type:'todo', isDeleted:false })，
  // 三段视图只喂 pending（TodoPage 内的判据是 `records.filter(r => r.todoStatus !== 'done')`）。
  const listed = preview.drafts
    .filter((draft) => draft.type === 'todo' && !draft.deleted)
    .map((draft, index) => ({
      id: index + 1,
      type: draft.type,
      title: draft.title,
      content: draft.content,
      tags: draft.tags,
      priority: draft.priority,
      remindAt: draft.remindAt,
      todoStatus: draft.todoStatus,
      someday: false,
      isDeleted: draft.deleted,
    })) as unknown as InfoRecord[]

  assert.equal(listed.length, 3, '待办列表 = VEVENT 转换条 + 未删除的 2 条 VTODO（已取消的进回收站）')

  const pending = listed.filter((record) => record.todoStatus !== 'done')
  assert.equal(pending.length, 2, '已完成条目必须被 pending 过滤挡掉')

  const nowMs = Date.parse(NOW)
  const buckets = splitByBucket(pending, nowMs, TZ_OFFSET)
  const visible = [...buckets.today, ...buckets.upcoming, ...buckets.someday]

  assert.ok(
    !visible.some((record) => record.title === '提交差旅报销单'),
    '已完成的「提交差旅报销单」不得出现在今天/即将/某天任何一段',
  )
  assert.ok(
    !visible.some((record) => record.title === '已取消的线下沙龙'),
    '已取消（进回收站）的条目不得出现在三段视图里',
  )
  assert.equal(visible.length, pending.length, '三段互斥且完备：三段条数之和 = 未完成条数')

  const counts = bucketCounts(pending, nowMs, TZ_OFFSET)
  assert.equal(counts.total, 2)
  assert.equal(counts.today + counts.upcoming + counts.someday, counts.total)
})

/* ==================== 2. 幂等：重复导入不新增 ==================== */

test('幂等：第一次导入 created=5；第二次查重命中 → created=0、skipped=5，且不再发起 insert', async () => {
  const text = load(FIXTURE)

  // 第一次：查重返回空 → 5 条全部写入
  __setDbResult({ data: [] })
  const first = await importIcs(text, { nowIso: NOW })

  assert.deepEqual(first, { created: 5, skipped: 0, cancelled: 1, total: 5 }, '首次导入应写入 5 条')
  assert.equal(countCalls('insert'), 1, '5 条应一次批量写入（未超单批 20 条上限）')

  const firstRows = insertedRows()
  assert.equal(firstRows.length, 5)
  for (const row of firstRows) {
    assert.ok(row.external_uid, '每一行都必须带 external_uid（查重的唯一依据）')
    const meta = row.record_meta as Record<string, unknown>
    assert.equal(meta.importedAt, NOW, `行「${String(row.title)}」的 record_meta.importedAt 必须是注入时刻`)
    assert.equal(meta.source, 'ics-import')
  }
  const firstUids = firstRows.map((row) => String(row.external_uid))

  // 第二次：查重返回第一次插入的 external_uid → 全部跳过
  __resetDbCalls()
  __resetDbWrites()
  __setDbResult({ data: firstUids.map((uid) => ({ external_uid: uid })) })
  const second = await importIcs(text, { nowIso: NOW })

  assert.deepEqual(second, { created: 0, skipped: 5, cancelled: 1, total: 5 }, '重复导入必须全部跳过')
  assert.equal(countCalls('insert'), 0, '查重命中时不得发起任何 insert（否则同一份日历会被导入多遍）')
  assert.equal(__dbInserts.length, 0, '第二次导入不应产生任何写入载荷')
  assert.ok(
    __dbCalls.some((call) => call.startsWith('in(external_uid,')),
    '查重必须按 external_uid 批量 in(...) 查询，而不是拉整表',
  )
})

test('幂等：两次导入得到完全相同的 external_uid 集合（文件内 UID 稳定）', async () => {
  const text = load(FIXTURE)

  __setDbResult({ data: [] })
  await importIcs(text, { nowIso: NOW })
  const firstUids = insertedRows().map((row) => row.external_uid).sort()

  __resetDbWrites()
  __setDbResult({ data: [] })
  await importIcs(text, { nowIso: NOW })
  const secondUids = insertedRows().map((row) => row.external_uid).sort()

  assert.deepEqual(secondUids, firstUids, '同一文件重复导入必须得到同一批 external_uid')
})

/* ==================== 3. 迁移未执行（42703） ==================== */

test('迁移未执行：查重返回 42703 → 整次抛错、文案含 migration.sql，且一条 insert 都不许发生', async () => {
  __setDbResult({ data: null, error: { code: '42703' } })

  let error: unknown = null
  try {
    await importIcs(load(FIXTURE), { nowIso: NOW })
  } catch (err) {
    error = err
  }

  assert.ok(error, '缺列时必须抛错（静默继续导入会造成重复数据）')
  assert.equal(isIcsImportError(error), true, '必须抛本服务的错误类型，UI 才能原样展示 message')

  const message = describeIcsImportError(error)
  assert.ok(message.includes(MIGRATION_PATH), `错误文案必须给出修复路径 ${MIGRATION_PATH}（实际：${message}）`)
  assert.notEqual(message, GENERIC_FAILURE, '迁移提示不得退化成"操作失败，请稍后重试"')
  assert.notEqual(message.trim(), '', '错误文案不得为空串')

  assert.equal(countCalls('insert'), 0, '迁移未执行时一条 insert 都不许发生')
  assert.equal(__dbInserts.length, 0, '不得留下任何写入载荷')
})

/* ==================== 4. 空文件 / 非 VCALENDAR ==================== */

test('空文件：importIcs(\'\') 抛「没有可导入的日历条目」且不发起任何查询', async () => {
  let error: unknown = null
  try {
    await importIcs('', { nowIso: NOW })
  } catch (err) {
    error = err
  }

  assert.ok(error, '空文件必须显式报错，不能静默成功')
  assert.equal(isIcsImportError(error), true)
  assert.ok(
    describeIcsImportError(error).includes('没有可导入的日历条目'),
    `文案必须说明"没有可导入的条目"（实际：${describeIcsImportError(error)}）`,
  )
  assert.equal(__dbCalls.length, 0, '空文件不应发起任何数据库调用')
})

test('非 VCALENDAR：同样抛「没有可导入的日历条目」，不发起任何查询', async () => {
  for (const text of ['这不是一"个日历文件', ics(['BEGIN:VEVENT', 'UID:x@qa', 'END:VEVENT'])]) {
    __resetDbCalls()
    let error: unknown = null
    try {
      await importIcs(text, { nowIso: NOW })
    } catch (err) {
      error = err
    }
    assert.ok(error, `非 VCALENDAR 文本必须抛错（输入：${JSON.stringify(text.slice(0, 12))}）`)
    assert.ok(describeIcsImportError(error).includes('没有可导入的日历条目'))
    assert.equal(__dbCalls.length, 0, '解析失败时不应查询数据库')
  }
})

/* ==================== 5. CANCELLED → is_deleted ==================== */

test('CANCELLED：插入行 is_deleted=true 且 deleted_at 非空（进回收站，可找回）', async () => {
  __setDbResult({ data: [] })
  const result = await importIcs(load(FIXTURE), { nowIso: NOW })

  assert.equal(result.created, 5, '取消项也要落库（丢弃等于静默丢数据）')
  assert.equal(result.cancelled, 1)

  const cancelled = rowByUid('jtx-todo-303@example.com')
  assert.equal(cancelled.is_deleted, true, 'STATUS:CANCELLED → is_deleted=true')
  assert.equal(cancelled.deleted_at, NOW, 'deleted_at 必须写入导入时刻')
  assert.equal(cancelled.type, 'todo')

  const normal = rowByUid('jtx-todo-301@example.com')
  assert.equal(normal.is_deleted, false, '未取消的待办不得被误标删除')
  assert.equal(normal.deleted_at, null, '未删除时 deleted_at 必须为 null')
  assert.equal(normal.priority, 'high')
  assert.equal(normal.todo_status, 'pending')
})

test('落库行：journal 写 type=idea / remind_at=null，已完成写 todo_status=done', async () => {
  __setDbResult({ data: [] })
  await importIcs(load(FIXTURE), { nowIso: NOW })

  const journal = rowByUid('jtx-journal-401@example.com')
  assert.equal(journal.type, 'idea')
  assert.equal(journal.remind_at, null)
  assert.equal(journal.todo_status, null)

  const done = rowByUid('jtx-todo-302@example.com')
  assert.equal(done.todo_status, 'done')
  assert.equal((done.record_meta as Record<string, unknown>).completedAt, '2026-10-28T03:00:00.000Z')
})

/* ==================== 6. 分批：> 20 条拆成多次 insert ==================== */

test('分批：21 条拆成 2 次 insert（20 + 1），created=21', async () => {
  __setDbResult({ data: [] })
  const result = await importIcs(buildManyTodosIcs(21), { nowIso: NOW })

  assert.equal(result.created, 21, '21 条必须全部写入')
  assert.equal(result.skipped, 0)
  assert.equal(result.total, 21)
  assert.ok(countCalls('insert') >= 2, `21 条必须拆成至少 2 次 insert（实际 ${countCalls('insert')} 次）`)

  const batches = __dbInserts as unknown[]
  assert.equal(batches.length, 2, '21 条按单批上限 20 拆分：20 + 1')
  assert.equal((batches[0] as unknown[]).length, 20)
  assert.equal((batches[1] as unknown[]).length, 1)
  assert.equal(insertedRows().length, 21, '摊平后必须正好 21 行')
})

test('分批：20 条及以下只发 1 次 insert（不无谓增加请求数）', async () => {
  __setDbResult({ data: [] })
  const result = await importIcs(buildManyTodosIcs(20), { nowIso: NOW })

  assert.equal(result.created, 20)
  assert.equal(countCalls('insert'), 1, '正好 20 条应一次写完')
})

/* ==================== 7. 冲突降级（23505） ==================== */

test('冲突降级：整批 23505 + 逐条重试仍 23505 → created=0、skipped=总数，且不抛错', async () => {
  // 队列顺序：1) 查重返回空 → 2) 整批 insert 冲突 → 3..7) 5 条逐条重试各自冲突
  __queueDbResults([{ data: [] }])
  __queueDbResults(Array.from({ length: 6 }, () => ({ data: null, error: { code: '23505' } })))
  __setDbResult({ data: null, error: { code: '23505' } })

  const result = await importIcs(load(FIXTURE), { nowIso: NOW })

  assert.equal(result.created, 0, '并发重复导入不应算作写入')
  assert.equal(result.skipped, 5, '冲突条目必须计为"跳过"，不能计入写入')
  assert.equal(result.total, 5)
  assert.equal(result.cancelled, 1, '取消计数来自文件本身，不受写入结果影响')
  assert.equal(countCalls('insert'), 6, '1 次整批 + 5 次逐条重试（单条失败不整体回滚）')
})

/* ==================== 8. 其它错误不被当成"跳过" ==================== */

test('写入失败（非冲突）：抛错且文案带上具体条目标题，不静默丢数据', async () => {
  __queueDbResults([{ data: [] }])
  __queueDbResults([{ data: null, error: { code: '23503' } }])
  __setDbResult({ data: null, error: { code: '23503' } })

  let error: unknown = null
  try {
    await importIcs(load(FIXTURE), { nowIso: NOW })
  } catch (err) {
    error = err
  }

  assert.ok(error, '非冲突类数据库错误必须抛出（否则用户以为导入成功）')
  const message = describeIcsImportError(error)
  assert.ok(message.includes('导入「'), `文案应指出是哪条导入失败（实际：${message}）`)
  assert.ok(message.includes('季度规划会'), `文案应包含失败条目名称（实际：${message}）`)
})
