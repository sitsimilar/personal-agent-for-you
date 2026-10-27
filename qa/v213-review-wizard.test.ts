/**
 * v2.13 R5「GTD 周回顾向导」测试。
 *
 * 三段：
 * 1. 纯函数（`web/src/lib/review-wizard.ts`）：本周一、进度归一/过期、
 *    收件箱挑选、分类统计、等待中并集（someday ∪ 逾期）、14 天健康、正文 5 小节；
 * 2. 服务层（`web/src/services/reviewWizardService.ts`）：AI 失败降级不阻断、
 *    `finish()` 落库用 `type='idea'`（不是 note）、焦点写高优先级待办、
 *    next_action 只进正文不建待办、已有 completedRecordId 时幂等；
 * 3. 进度读写走 `profileService`（settings 唯一写入口，不直连 settings 表）。
 */
import { test, beforeEach, afterEach } from 'node:test'
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
  __setCloudMock,
  __resetCloudMock,
} from './mocks/cloud'
import type { InfoRecord, ReviewWizardProgress } from '../shared/types/domain'
import {
  FOCUS_COUNT,
  PROGRESS_TTL_MS,
  REVIEW_NOTE_SECTIONS,
  STALE_DAYS,
  buildReviewNoteBody,
  emptyProgress,
  isProgressExpired,
  isoWeekStart,
  normalizeProgress,
  pickCategories,
  pickInbox,
  pickStaleCategories,
  pickWaiting,
  reviewNoteTitle,
} from '../web/src/lib/review-wizard'
import { reviewWizardService } from '../web/src/services/reviewWizardService'

const TZ = 480
/** 基准时刻：2026-10-28（周三）10:00 东八区；本周一 = 2026-10-26。 */
const NOW = Date.parse('2026-10-28T10:00:00+08:00')

/** 构造一条只填必要字段的记录。 */
function rec(over: Partial<InfoRecord> = {}): InfoRecord {
  return {
    id: 1,
    type: 'todo',
    title: '一条记录',
    content: '',
    tags: [],
    todoStatus: 'pending',
    isDeleted: false,
    createdAt: '2026-10-26T00:00:00.000Z',
    updatedAt: '2026-10-26T00:00:00.000Z',
    ...over,
  }
}

/** 构造一份可用的进度。 */
function progress(over: Partial<ReviewWizardProgress> = {}): ReviewWizardProgress {
  return { ...emptyProgress(NOW, TZ), ...over }
}

beforeEach(() => {
  __resetDbCalls()
  __resetDbQueue()
  __resetDbWrites()
  __setDbResult({ data: [] })
})

afterEach(() => {
  __resetCloudMock()
})

/* ============================== 1. 纯函数 ============================== */

test('isoWeekStart：周一为一周起点；周日归到上一个周一', () => {
  assert.equal(isoWeekStart(NOW, TZ), '2026-10-26')
  // 2026-10-25 是周日 → 属于 10-19 那一周
  assert.equal(isoWeekStart(Date.parse('2026-10-25T10:00:00+08:00'), TZ), '2026-10-19')
  // 周一当天
  assert.equal(isoWeekStart(Date.parse('2026-10-26T00:00:00+08:00'), TZ), '2026-10-26')
  // 跨年：2027-01-01 是周五 → 本周一 2026-12-28
  assert.equal(isoWeekStart(Date.parse('2027-01-01T10:00:00+08:00'), TZ), '2026-12-28')
})

test('emptyProgress：step=1、本周周一起点、焦点固定 3 条空串', () => {
  const p = emptyProgress(NOW, TZ)
  assert.equal(p.step, 1)
  assert.equal(p.weekStart, '2026-10-26')
  assert.equal(p.focus.length, FOCUS_COUNT)
  assert.deepEqual(p.focus, ['', '', ''])
  assert.equal(p.completedAt, null)
  assert.equal(p.completedRecordId, null)
  assert.equal(p.aiFailed, false)
})

test('normalizeProgress：脏数据归一（非法 step → 1、非法 decision → skip、focus 补足 3 条）', () => {
  const p = normalizeProgress({
    step: 9,
    weekStart: '2026-10-26',
    updatedAt: '2026-10-28T02:00:00.000Z',
    inbox: [
      { recordId: 3, decision: 'assign', category: ' 工作 ' },
      { recordId: 4, decision: '乱写' },
      { recordId: -1, decision: 'assign' },
      'not-an-object',
    ],
    nextActions: [{ category: '工作', text: '写周报' }, { category: '', text: '   ' }],
    waiting: [{ recordId: 5, decision: 'delete' }],
    health: [{ category: '学习', acknowledged: true }],
    focus: ['只填一条'],
    aiFailed: 'yes',
  })

  assert.ok(p)
  assert.equal(p?.step, 1)
  assert.equal(p?.inbox.length, 2, '非法 recordId 与非法结构必须被丢弃')
  assert.deepEqual(p?.inbox[0], { recordId: 3, decision: 'assign', category: '工作' })
  assert.equal(p?.inbox[1].decision, 'skip')
  assert.deepEqual(p?.nextActions, [{ category: '工作', text: '写周报' }], '空白文本必须丢弃')
  assert.deepEqual(p?.waiting, [{ recordId: 5, decision: 'delete' }])
  assert.deepEqual(p?.health, [{ category: '学习', acknowledged: true }])
  assert.deepEqual(p?.focus, ['只填一条', '', ''], '焦点固定 3 条')
  assert.equal(p?.aiFailed, false, 'aiFailed 只认字面 true')
})

test('normalizeProgress：JSON 字符串也能解析；核心字段不合法时返回 null', () => {
  const raw = JSON.stringify({ weekStart: '2026-10-26', updatedAt: '2026-10-28T02:00:00.000Z', step: 3 })
  assert.equal(normalizeProgress(raw)?.step, 3)
  assert.equal(normalizeProgress('{不是 JSON'), null)
  assert.equal(normalizeProgress(null), null)
  assert.equal(normalizeProgress({ updatedAt: '2026-10-28T02:00:00.000Z' }), null, '缺 weekStart 视为无进度')
  assert.equal(normalizeProgress({ weekStart: '2026-10-26' }), null, '缺 updatedAt 视为无进度')
  assert.equal(normalizeProgress({ weekStart: '10-26', updatedAt: '2026-10-28T02:00:00.000Z' }), null)
})

test('isProgressExpired：超 24h 或跨周即过期，刚更新且同周不过期', () => {
  const fresh = normalizeProgress({ weekStart: '2026-10-26', updatedAt: new Date(NOW - 60_000).toISOString() })
  assert.ok(fresh)
  assert.equal(isProgressExpired(fresh as ReviewWizardProgress, NOW, TZ), false)

  const old = normalizeProgress({
    weekStart: '2026-10-26',
    updatedAt: new Date(NOW - PROGRESS_TTL_MS - 1000).toISOString(),
  })
  assert.equal(isProgressExpired(old as ReviewWizardProgress, NOW, TZ), true)

  // 同一时刻但跨周（weekStart 是上周一）
  const lastWeek = normalizeProgress({ weekStart: '2026-10-19', updatedAt: new Date(NOW).toISOString() })
  assert.equal(isProgressExpired(lastWeek as ReviewWizardProgress, NOW, TZ), true)
})

test('pickInbox：只留「无分类且无标签」的未删除记录', () => {
  const rows = [
    rec({ id: 1 }),
    rec({ id: 2, category: '工作' }),
    rec({ id: 3, tags: ['重要'] }),
    rec({ id: 4, tags: [] }),
    rec({ id: 5, isDeleted: true }),
  ]
  assert.deepEqual(pickInbox(rows).map((r) => r.id), [1, 4])
})

test('pickCategories：按出现次数降序，次数相同按名称升序，忽略空分类', () => {
  const rows = [
    rec({ id: 1, category: '工作' }),
    rec({ id: 2, category: '工作' }),
    rec({ id: 3, category: '学习' }),
    rec({ id: 4, category: '生活' }),
    rec({ id: 5, category: '   ' }),
    rec({ id: 6, category: null }),
  ]
  assert.deepEqual(pickCategories(rows), ['工作', '生活', '学习'], '同为 1 次时按 zh-CN 音序：生活(sheng) < 学习(xue)')
})

test('pickWaiting：「某天」∪ 逾期未完成；当日到期、已完成、已删除都不算', () => {
  const todos = [
    rec({ id: 11, someday: true }),                                  // 某天 → 算
    rec({ id: 12, remindAt: '2026-10-20T09:00:00+08:00' }),           // 逾期 → 算
    rec({ id: 13, remindAt: '2026-10-28T23:00:00+08:00' }),           // 今天晚些到期 → 不算
    rec({ id: 14, remindAt: '2026-10-20T09:00:00+08:00', todoStatus: 'done' }), // 已完成 → 不算
    rec({ id: 15, someday: true, isDeleted: true }),                  // 已删除 → 不算
    rec({ id: 16, someday: true, remindAt: '2026-10-20T09:00:00+08:00' }), // 同时命中 → 只算一次
  ]
  assert.deepEqual(pickWaiting(todos, NOW, TZ).map((r) => r.id), [11, 12, 16])
})

test('pickStaleCategories：按分类内「最晚更新」判 14 天，被别的新记录刷新不算搁置', () => {
  const old = new Date(NOW - (STALE_DAYS + 3) * 86_400_000).toISOString()
  const older = new Date(NOW - (STALE_DAYS + 10) * 86_400_000).toISOString()
  const fresh = new Date(NOW - 86_400_000).toISOString()
  const rows = [
    { category: '工作', updatedAt: old },
    { category: '工作', updatedAt: fresh }, // 该分类有一条近期更新 → 不算搁置
    { category: '学习', updatedAt: old },
    { category: '生活', updatedAt: older },
    { category: '生活', updatedAt: new Date(NOW - 30 * 86_400_000).toISOString() },
    { category: null, updatedAt: old },
  ]
  // 生活（更久没动）在前，学习其次；工作被近期更新排除
  assert.deepEqual(pickStaleCategories(rows, NOW), ['生活', '学习'])
  // 阈值可配：60 天时都不算搁置
  assert.deepEqual(pickStaleCategories(rows, NOW, 60), [])
})

test('buildReviewNoteBody：固定 5 个二级标题且顺序与 PRD 一致', () => {
  const body = buildReviewNoteBody(progress(), { inbox: 0, waiting: 0, stale: [] })
  const headings = body
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3))
  assert.deepEqual(headings, [...REVIEW_NOTE_SECTIONS])
  assert.match(body, /本周期没有待清理的收件箱记录/)
  assert.match(body, /本次未填写下一步行动/)
  assert.match(body, /本周没有搁置或逾期的待办/)
  assert.match(body, /本次未填写下周焦点/)
})

test('buildReviewNoteBody：写入收件箱/等待中/搁置分类/焦点/AI 建议的实数与文案', () => {
  const p = progress({
    inbox: [
      { recordId: 1, decision: 'assign', category: '工作' },
      { recordId: 2, decision: 'archive', category: null },
      { recordId: 3, decision: 'skip', category: null },
    ],
    nextActions: [{ category: '工作', text: '给客户回邮件' }],
    waiting: [
      { recordId: 4, decision: 'keep' },
      { recordId: 5, decision: 'delete' },
    ],
    health: [{ category: '学习', acknowledged: true }],
    focus: ['完成周报', '整理读书笔记'],
  })
  const body = buildReviewNoteBody(p, { inbox: 3, waiting: 2, stale: ['学习', '生活'], aiSummary: '本周节奏偏紧' })

  assert.match(body, /本周期待清理 3 条/)
  assert.match(body, /已归入分类 1 条：工作/)
  assert.match(body, /已归档（保持无分类）1 条/)
  assert.match(body, /暂不处理 1 条/)
  assert.match(body, /- 【工作】给客户回邮件/)
  assert.match(body, /待观察 2 条，其中保留 1 条、删除 1 条/)
  assert.match(body, /学习：超过 14 天未更新（已确认）/)
  assert.match(body, /生活：超过 14 天未更新（待确认）/)
  assert.match(body, /1\. 完成周报/)
  assert.match(body, /2\. 整理读书笔记/)
  assert.match(body, /## AI 建议\n本周节奏偏紧/)
})

test('buildReviewNoteBody：AI 失败时写降级文案，不阻断正文落库', () => {
  const body = buildReviewNoteBody(progress(), { inbox: 0, waiting: 0, stale: [], aiFailed: true })
  assert.match(body, /## AI 建议\n本次未能生成建议/)
})

test('reviewNoteTitle：标题为「<本周一> 周回顾」', () => {
  assert.equal(reviewNoteTitle('2026-10-26'), '2026-10-26 周回顾')
})

/* ============================ 2. 服务层落库 ============================ */

/** 一行最小的 records 行（供 insert/select 返回）。 */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 900,
    owner_id: 'u1',
    type: 'idea',
    title: '周回顾',
    content: '',
    url: null,
    file_path: null,
    category: null,
    tags: [],
    summary: null,
    todo_status: null,
    priority: null,
    remind_at: null,
    recurrence: null,
    recurrence_parent_id: null,
    recurrence_next_id: null,
    link_meta: null,
    is_deleted: false,
    deleted_at: null,
    created_at: '2026-10-28T02:00:00.000Z',
    updated_at: '2026-10-28T02:00:00.000Z',
    ...over,
  }
}

test('finish：回顾记录用 type=idea（不是 note），标题为「周一起点 + 周回顾」', async () => {
  __queueDbResults([{ data: [row({ id: 901 })] }])

  const id = await reviewWizardService.finish(progress({ focus: ['', '', ''] }), {
    inbox: 0,
    waiting: 0,
    stale: [],
    aiSummary: null,
    aiFailed: false,
  })

  assert.equal(id, 901)
  assert.equal(__dbInserts.length, 1, '没有焦点时不额外建待办')
  const inserted = __dbInserts[0] as Record<string, unknown>
  assert.equal(inserted.type, 'idea', 'records.type 的 CHECK 只允许 idea/material/todo')
  assert.equal(inserted.title, '2026-10-26 周回顾')
  assert.match(String(inserted.content), /## 清空收件箱/)
})

test('finish：第 5 步焦点写成高优先级待办；第 2 步 next_action 只进正文不建待办', async () => {
  __queueDbResults([
    { data: [row({ id: 902 })] },
    { data: [row({ id: 903, type: 'todo', todo_status: 'pending', priority: 'high' })] },
    { data: [row({ id: 904, type: 'todo', todo_status: 'pending', priority: 'high' })] },
  ])

  const p = progress({
    nextActions: [{ category: '工作', text: '给客户回邮件' }],
    focus: ['完成周报', '整理读书笔记'],
  })
  await reviewWizardService.finish(p, { inbox: 0, waiting: 0, stale: [], aiSummary: null, aiFailed: false })

  assert.equal(__dbInserts.length, 3, '1 条回顾 + 2 条焦点待办')
  const body = String((__dbInserts[0] as Record<string, unknown>).content)
  assert.match(body, /给客户回邮件/, 'next_action 必须写进正文')

  const focuses = __dbInserts.slice(1) as Array<Record<string, unknown>>
  assert.deepEqual(focuses.map((f) => f.type), ['todo', 'todo'])
  assert.deepEqual(focuses.map((f) => f.title), ['完成周报', '整理读书笔记'])
  assert.deepEqual(focuses.map((f) => f.priority), ['high', 'high'])
  assert.deepEqual(focuses.map((f) => f.todo_status), ['pending', 'pending'])
})

test('finish：已有 completedRecordId 时幂等，不重复落库', async () => {
  __resetDbWrites()
  const id = await reviewWizardService.finish(progress({ completedRecordId: 777 }), {
    inbox: 0,
    waiting: 0,
    stale: [],
    aiSummary: null,
    aiFailed: false,
  })
  assert.equal(id, 777)
  assert.equal(__dbInserts.length, 0, '不得再次插入回顾记录')
})

test('finish：AI 失败也照常落库（降级不阻断），正文含降级说明', async () => {
  __queueDbResults([{ data: [row({ id: 905 })] }])
  await reviewWizardService.finish(progress(), {
    inbox: 0,
    waiting: 0,
    stale: [],
    aiSummary: null,
    aiFailed: true,
  })
  assert.match(String((__dbInserts[0] as Record<string, unknown>).content), /本次未能生成建议/)
})

test('finish 幂等（M2）：同一 progress 连调两次只落 1 条 idea 回顾记录', async () => {
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([{ data: [row({ id: 701 })] }])

  // startedAt 是「一次运行」的唯一标识，这里显式区分，避免与其他用例共用同一轮运行的键
  const p = progress({ startedAt: '2026-10-28T03:00:00.000Z' })
  const first = await reviewWizardService.finish(p, {
    inbox: 0,
    waiting: 0,
    stale: [],
    aiSummary: null,
    aiFailed: false,
  })
  const second = await reviewWizardService.finish(p, {
    inbox: 0,
    waiting: 0,
    stale: [],
    aiSummary: null,
    aiFailed: false,
  })

  assert.equal(first, 701)
  assert.equal(second, 701, '第二次必须返回同一条记录 id')
  assert.equal(__dbInserts.length, 1, '不得落第二条回顾记录')
  assert.equal(p.completedRecordId, 701, 'finish 必须把完成标记就地写回 progress')
})

test('finish 幂等（M2）：回顾已建但焦点待办创建失败 → 重试只补待办，不重复建回顾', async () => {
  __resetDbWrites()
  __resetDbQueue()
  // 第一次：回顾记录成功，焦点待办创建报错
  __queueDbResults([
    { data: [row({ id: 711 })] },
    { data: null, error: { message: '网络错误' } },
  ])

  const p = progress({ startedAt: '2026-10-28T04:00:00.000Z', focus: ['完成周报', '', ''] })
  const stats = { inbox: 0, waiting: 0, stale: [], aiSummary: null, aiFailed: false }
  await assert.rejects(() => reviewWizardService.finish(p, stats))

  const ideas = () => __dbInserts.filter((i) => (i as Record<string, unknown>).type === 'idea')
  assert.equal(ideas().length, 1, '回顾记录已落库')
  assert.equal(p.completedRecordId, 711, '失败前必须已把完成标记写回 progress（幂等的依据）')

  // 重试：只补焦点待办
  __resetDbWrites()
  __resetDbQueue()
  __queueDbResults([{ data: [row({ id: 712, type: 'todo' })] }])
  const id = await reviewWizardService.finish(p, stats)

  assert.equal(id, 711, '仍然返回原来那条回顾记录')
  assert.equal(ideas().length, 0, '重试不得再建回顾记录')
  assert.equal(__dbInserts.length, 1, '重试只建待办')
  assert.equal((__dbInserts[0] as Record<string, unknown>).type, 'todo')
  assert.equal((__dbInserts[0] as Record<string, unknown>).title, '完成周报')
})

test('suggest：无记录时不调 AI；AI 抛错时降级为 failed=true 且不向外抛', async () => {
  assert.deepEqual(await reviewWizardService.suggest([]), { summary: null, failed: false })

  __setCloudMock({
    chatCreate: () => {
      throw new Error('网络错误')
    },
  })
  const result = await reviewWizardService.suggest([rec({ id: 1 })])
  assert.equal(result.failed, true)
  assert.equal(result.summary, null)
})

/* ============================ 3. 进度读写入口 ============================ */

test('load：读 settings.review_wizard 并归一；无 settings 行时返回 null 进度', async () => {
  __queueDbResults([
    { data: { id: 5, owner_id: 'u1', review_wizard: { weekStart: '2026-10-26', updatedAt: new Date(NOW).toISOString(), step: 4 } } },
  ])
  const loaded = await reviewWizardService.load()
  assert.equal(loaded.settingsId, 5)
  assert.equal(loaded.progress?.step, 4)

  __queueDbResults([{ data: null }])
  const empty = await reviewWizardService.load()
  assert.deepEqual(empty, { progress: null, settingsId: null })
})

test('save：走 profileService（按 id update settings），不直连 settings 表做 insert', async () => {
  __resetDbWrites()
  __queueDbResults([{ data: [row({ id: 5 })] }])

  const id = await reviewWizardService.save(progress({ step: 2 }), 5)

  assert.equal(id, 5)
  assert.equal(__dbUpdates.length, 1)
  assert.ok('review_wizard' in (__dbUpdates[0] ?? {}), '必须写 review_wizard 列')
  assert.ok(__dbCalls.includes('from(settings)'))
  assert.ok(!__dbCalls.includes('insert'), '有 id 时不得 insert（否则会撞 owner_id 唯一约束）')
})

test('clear：把 review_wizard 置空；无 settingsId 时直接返回不发请求', async () => {
  __resetDbWrites()
  __queueDbResults([{ data: [row({ id: 5 })] }])
  await reviewWizardService.clear(5)
  assert.equal(__dbUpdates.length, 1)
  assert.equal((__dbUpdates[0] ?? {}).review_wizard, null)

  __resetDbCalls()
  await reviewWizardService.clear(null)
  assert.equal(__dbCalls.length, 0)
})

test('start：返回 step=1 的空进度，本周周一起点', () => {
  const p = reviewWizardService.start(NOW)
  assert.equal(p.step, 1)
  assert.equal(p.weekStart, isoWeekStart(NOW))
})
