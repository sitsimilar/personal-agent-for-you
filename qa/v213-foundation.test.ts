/**
 * v2.13 T01 地基测试：新列的类型映射 / 写入映射 / 迁移脚本结构。
 *
 * 覆盖三件事：
 * 1. `mapRecord` 对 v2.13 新列（someday / snoozed_until / snooze_count）全部回落默认值
 *    —— **迁移未执行时**行里没有这些键，读取必须不抛错且行为等同 v2.12.2；
 * 2. `toSnake` 只在显式传入时写新列（旧路径不会被塞入未知列，避免 42703）；
 * 3. `docs/v2.13/migration.sql` 与 `docs/db-setup.sql` 的增量段结构正确
 *    （pg_trgm 首条、generated 列、幂等索引），且两份文档的列/约束/索引完全一致
 *    （含第二批的 snoozed_until / snooze_count / review_wizard）。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  __setDbResult,
  __resetDbCalls,
  __dbCalls,
  __dbUpdates,
  __resetDbWrites,
  __queueDbResults,
  __resetDbQueue,
} from './mocks/cloud'
import { mapRecord, recordService } from '../web/src/services/recordService'
import type { RecordsRow } from '../web/src/lib/database.types'

/** 构造一行「迁移未执行」的旧行（不含 v2.13 新列）。 */
function makeLegacyRow(over: Partial<RecordsRow> = {}): RecordsRow {
  return {
    id: 1,
    owner_id: 'u1',
    type: 'todo',
    title: '旧待办',
    content: '内容',
    url: null,
    file_path: null,
    category: null,
    tags: [],
    summary: null,
    todo_status: 'pending',
    priority: null,
    remind_at: null,
    recurrence: null,
    recurrence_parent_id: null,
    recurrence_next_id: null,
    link_meta: null,
    is_deleted: false,
    deleted_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...over,
  }
}

/** 读取仓库内的文档文件（qa/dist → 仓库根）。 */
function readDoc(relativePath: string): string {
  return readFileSync(resolve(__dirname, '..', '..', relativePath), 'utf8')
}

beforeEach(() => {
  __resetDbCalls()
  __resetDbWrites()
})

test('mapRecord：迁移未执行（行里没有新列）时回落 false / null / 0，不抛错', () => {
  const record = mapRecord(makeLegacyRow())
  assert.equal(record.someday, false)
  assert.equal(record.snoozedUntil, null)
  assert.equal(record.snoozeCount, 0)
})

test('mapRecord：新列有值时原样映射（someday / snoozedUntil / snoozeCount）', () => {
  const record = mapRecord(
    makeLegacyRow({
      someday: true,
      snoozed_until: '2026-10-27T09:10:00.000Z',
      snooze_count: 3,
    }),
  )
  assert.equal(record.someday, true)
  assert.equal(record.snoozedUntil, '2026-10-27T09:10:00.000Z')
  assert.equal(record.snoozeCount, 3)
})

test('mapRecord：新列为 null 时同样回落默认值（列存在但值为空）', () => {
  const record = mapRecord(makeLegacyRow({ someday: null, snoozed_until: null, snooze_count: null }))
  assert.equal(record.someday, false)
  assert.equal(record.snoozedUntil, null)
  assert.equal(record.snoozeCount, 0)
})

test('updateRecord：显式传 someday 时写入 someday 列', async () => {
  __setDbResult({ data: [makeLegacyRow({ someday: true })] })
  const updated = await recordService.updateRecord(1, { someday: true })
  assert.equal(updated.someday, true)
  const payload = __dbUpdates[__dbUpdates.length - 1] ?? {}
  assert.deepEqual(Object.keys(payload), ['someday'])
  assert.equal(payload.someday, true)
})

test('updateRecord：旧字段更新不会附带新列（迁移未执行时旧路径不报 42703）', async () => {
  __setDbResult({ data: [makeLegacyRow({ title: '改后' })] })
  await recordService.updateRecord(1, { title: '改后' })
  const payload = __dbUpdates[__dbUpdates.length - 1] ?? {}
  assert.deepEqual(Object.keys(payload), ['title'])
})

test('updateRecord：snoozedUntil / snoozeCount 映射为 snake_case 列名', async () => {
  __setDbResult({ data: [makeLegacyRow({ snooze_count: 1 })] })
  await recordService.updateRecord(1, { snoozedUntil: '2026-10-27T09:10:00.000Z', snoozeCount: 1 })
  const payload = __dbUpdates[__dbUpdates.length - 1] ?? {}
  assert.equal(payload.snoozed_until, '2026-10-27T09:10:00.000Z')
  assert.equal(payload.snooze_count, 1)
})

test('countTodoByStatus：两次 head count 取 pending / done 总数', async () => {
  __resetDbQueue()
  __queueDbResults([
    { data: null, count: 12 },
    { data: null, count: 5 },
  ])
  const counts = await recordService.countTodoByStatus()
  assert.deepEqual(counts, { pending: 12, done: 5 })
  assert.ok(__dbCalls.includes('eq(todo_status,"pending")'))
  assert.ok(__dbCalls.includes('eq(todo_status,"done")'))
})

test('migration.sql：首条为 pg_trgm 扩展，含 generated search_tsv 与三条幂等索引', () => {
  const sql = readDoc('docs/v2.13/migration.sql')
  // 扩展必须是文件里第一条可执行语句（索引依赖它）
  const firstStatement = sql
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('--'))
    .shift()
  assert.equal(firstStatement?.trim(), 'CREATE EXTENSION IF NOT EXISTS pg_trgm;')
  // someday 列 + generated search_tsv
  assert.match(sql, /ADD COLUMN IF NOT EXISTS someday\s+BOOLEAN\s+NOT NULL DEFAULT false/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS search_tsv tsvector/)
  assert.match(sql, /GENERATED ALWAYS AS/)
  // 索引：trgm ×2 + tsv ×1 + someday 部分索引 ×1，全部 IF NOT EXISTS
  assert.match(sql, /CREATE INDEX IF NOT EXISTS records_owner_title_trgm_idx/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS records_owner_content_trgm_idx/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS records_owner_search_tsv_idx/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS records_owner_someday_idx/)
  assert.match(sql, /gin_trgm_ops/)
  // mode 只在列注释里出现（JSONB 内键，无 DDL）
  assert.match(sql, /mode\?:due\|completion/)
  assert.doesNotMatch(sql, /ALTER TABLE public\.records\s+ADD COLUMN IF NOT EXISTS mode/)
})

test('migration.sql / db-setup.sql：都包含第二批（T05 snooze / T06 向导）的列与约束', () => {
  for (const doc of ['docs/v2.13/migration.sql', 'docs/db-setup.sql']) {
    const sql = readDoc(doc)
    assert.match(sql, /ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ/, doc)
    assert.match(sql, /ADD COLUMN IF NOT EXISTS snooze_count\s+INT\s+NOT NULL DEFAULT 0/, doc)
    assert.match(sql, /ADD COLUMN IF NOT EXISTS review_wizard JSONB/, doc)
    assert.match(sql, /records_snooze_count_chk CHECK \(snooze_count >= 0\)/, doc)
    // 幂等：每一处 ADD COLUMN 都必须带 IF NOT EXISTS
    assert.doesNotMatch(sql, /ADD COLUMN (?!IF NOT EXISTS)/, doc)
    // 两份文档都不许留「将追加 / 待补充」这类占位（第二批收尾时已补全）
    assert.doesNotMatch(sql, /将追加|待补充|TODO/, doc)
  }
})

test('db-setup.sql：末尾追加了 v2.13 增量迁移段（与 migration.sql 同内容）', () => {
  const sql = readDoc('docs/db-setup.sql')
  assert.match(sql, /增量迁移（v2\.13）/)
  assert.match(sql, /CREATE EXTENSION IF NOT EXISTS pg_trgm;/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS someday\s+BOOLEAN\s+NOT NULL DEFAULT false/)
  assert.match(sql, /records_owner_search_tsv_idx/)
})
