-- v2.14 P0-1 下半：.ics 导入落库所需的列与唯一索引
--
-- 执行方式：**由智能体通过云库 SQL 通道逐条执行**（`mode: "migrate"`，一次一条语句）。
--   注意：WorkBuddy 不向用户开放 SQL 控制台（平台刻意收口，避免直接操作生产库），
--   所以这里说的「执行」指的是让智能体代跑，不是自己找控制台粘贴。
--   应用层本身不执行 DDL，也不在运行时拼 SQL。
-- 执行状态：**2026-11-13 已在真库执行完毕并校验通过**（5 列 + 1 索引 + 1 约束；
--   `settings.feeds` / `feed_state` 2 列同批完成；`settings.ui_scheme` 取自
--   `docs/v2.13/migration-ui-scheme.sql`，同日一并执行）。本文件仍保持幂等，可重复跑。
-- 幂等：全部使用 `IF NOT EXISTS` / `DO $$ ... $$` 守卫，可重复执行，不会因为重跑报错。
--
-- 不执行会怎样：`web/src/services/icsImportService.ts` 首次查重时会拿到
-- PostgREST 的 `42703`（列不存在），此时**明确抛出**「云库缺少 external_uid 字段，
-- 请先执行 docs/v2.14/migration.sql 后再导入」并中止整次导入。
-- 这是刻意设计：缺列时无法查重，盲目插入会把同一份 .ics 重复导入 N 份，
-- 数据比报错更难收拾。宁可挡住并给出可执行的修复指引。
--
-- 其余历史列（parent_id / context / duration_min / record_meta）补齐后，
-- 应用层仍是"只在显式使用新特性时写"（见 `recordService.toSnake`），
-- 因此未执行迁移时旧路径完全不受影响（读侧一律回落默认值）。
--
-- v2.14 P0-3 下半同理：`settings.feeds` / `settings.feed_state` 缺失时，订阅配置读写会拿到
-- PostgreSQL 的 `42703`（列不存在）或 PostgREST 的 `PGRST204`（schema cache 未识别列），
-- `web/src/services/feedService.ts` 会抛 `FeedSchemaMissingError`（文案指向本文件），
-- 而不是把订阅列表静默当成空的——否则用户会以为"导入的订阅全丢了"。

-- 1) 补列（全部可空，不加 DEFAULT，避免大表重写）
ALTER TABLE public.records
  ADD COLUMN IF NOT EXISTS parent_id BIGINT,
  ADD COLUMN IF NOT EXISTS context TEXT,
  ADD COLUMN IF NOT EXISTS external_uid TEXT,
  ADD COLUMN IF NOT EXISTS duration_min INTEGER,
  ADD COLUMN IF NOT EXISTS record_meta JSONB;

COMMENT ON COLUMN public.records.parent_id IS
  '父记录 / 来源记录 id（自引用，指向 public.records.id）。不加外键：记录可能被物理删除，级联语义由应用层决定。'
  'v2.14 P0-2 起承载 .ics 的 RELATED-TO;RELTYPE=PARENT：导入时先按 external_uid 反查父记录 id 再回填；'
  '删除父记录时用 recordService.softDelete 连带把子任务一起放进回收站（应用层语义，不是 DB 级联）';
COMMENT ON COLUMN public.records.context IS
  '上下文补充说明（自由文本，如"在哪个会议/哪本书里看到的"）。与 content 分工：content 是主体内容，context 是来源语境';
COMMENT ON COLUMN public.records.external_uid IS
  '外部系统稳定标识（当前用于 .ics 的 UID）。与 owner_id 组成唯一键，是导入查重的唯一依据；手写记录恒为 NULL';
COMMENT ON COLUMN public.records.duration_min IS
  '预计/实际耗时（分钟，整数 ≥ 0）。NULL = 未填（不是 0）；0 是合法值（"零耗时事项"）';
COMMENT ON COLUMN public.records.record_meta IS
  '正文派生状态 / 导入来源等 JSONB 桶：{ source, externalUid, icsKind, rrule, exdates, completedAt, dtstart, importedAt }。不放链接元数据（那是 link_meta），避免两处各写一半';

-- 2) 导入查重唯一键
-- 为什么必须是「部分唯一索引」：owner_id + external_uid 只有一侧非空时才是同一外部条目；
-- 手写记录的 external_uid 恒为 NULL，若用普通唯一索引，NULL 之间的比较在 PG 里不等，
-- 行为虽然"能用"，但语义含糊且索引体积更大。WHERE external_uid IS NOT NULL 让意图显式化。
-- 这个索引同时是并发重复导入的最后一道闸：两个标签页同时导入同一文件时，
-- 后插入的一方会拿到 23505，应用层计为「跳过（已存在）」而不是整体失败。
CREATE UNIQUE INDEX IF NOT EXISTS records_owner_external_uid_uniq
  ON public.records (owner_id, external_uid)
  WHERE external_uid IS NOT NULL;

-- 3) 耗时不能为负
-- 用 NOT VALID 加：只校验此后写入的行，不回头扫历史全表（避免长时间持锁）。
-- 应用层已把非法值归一成 NULL（见 `recordService.toRecordMeta` 同风格容错），
-- 这里的约束是防"绕过应用直写"。
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'records_duration_min_chk'
  ) THEN
    ALTER TABLE public.records
      ADD CONSTRAINT records_duration_min_chk
      CHECK (duration_min IS NULL OR duration_min >= 0)
      NOT VALID;
  END IF;
END
$$;

-- 4) v2.14 P0-3 下半：订阅源配置 + 运行时状态（settings 上的两个 JSONB 桶）
--
-- 为什么**不**单开一列 `feed_health`：健康态（ok/failing/recovering）与失败计数、304 计数
-- 是同一次 `fetchFeed()` 一起算出来的，拆成两列必然出现「status 说 ok、failCount 却是 3」
-- 这种自相矛盾的数据，而修正这种不一致没有任何可靠依据。
-- **健康态一律 = `feed_state[id].status`**，读健康态就是读状态对象，不需要第二处真相。
--
-- 两个桶都 NOT NULL + 默认空值：应用层不必处理 null，`[]` / `{}` 就是「还没有订阅」。
-- 加 DEFAULT 只影响新行（PG 11+ 不重写表），因此对既有 settings 行无锁风险。
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS feeds JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS feed_state JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.settings.feeds IS
  '订阅源配置数组：[{ id, title, url, htmlUrl, category, enabled }]。'
  'id 由 url 派生（feedService.feedIdOf），与 feed_state 的键一一对应；'
  'enabled=false 表示用户暂停该源（不参与 tick），与「删除」区分开';
COMMENT ON COLUMN public.settings.feed_state IS
  '订阅运行时状态：{ [feedId]: { etag, lastModified, failCount, consecutiveNotModified, consecutiveOk, '
  'status, nextFetchAt, lastHash, lastFetchedAt, lastError } }。'
  '健康态 = feed_state[id].status（不另设 feed_health 列，避免与计数器不一致）；'
  'nextFetchAt 为 null 表示「下一轮就抓」，非 null 表示退避窗口（304 阶梯 / failing 退避）';
