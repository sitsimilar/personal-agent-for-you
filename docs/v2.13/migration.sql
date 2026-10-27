-- =============================================================================
-- 个人信息管家 · v2.13 增量迁移（基线 v2.12.2）
-- 范围：R1 记录检索走索引（pg_trgm + tsvector）、R2 待办三段视图（someday）、
--       R3 循环「按完成日重复」（JSONB 内加键，无需 DDL，仅更新列注释）、
--       R4 提醒「稍后」（snoozed_until / snooze_count）、R5 周回顾向导（settings.review_wizard）、
--       R6 日历导出 .ics（纯应用侧，无 DDL）
-- 特性：纯增量（只加列/加索引/加约束/改注释），全部可空或有默认值，幂等可重复执行；
--       不改既有 4 条 RLS 策略（策略按 owner_id，不列字段），不搬迁、不回填数据。
-- 执行方式：在云库 SQL 控制台整段执行一次（或按段执行），失败可原样重跑；
--       建议整段执行两遍确认幂等。
--       需要 migrate 权限（CREATE EXTENSION 需要），由主理人手工执行；
--       应用代码【不执行任何 DDL】，也不在启动时探测扩展/列是否存在。
-- 环境事实（2026-10-27 实测）：pg_available_extensions 中 pg_trgm default_version=1.6、
--       installed_version=null（可装未装）→ 按主案执行 trgm GIN 索引；
--       btree_gin / unaccent 本期【不引入】。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0) 扩展（必须是本文件第一条可执行语句，先于第 4) 段的 trgm 索引）
--    若云库拒绝 CREATE EXTENSION（权限/策略），见 DESIGN §3.3「备而不用」：
--    把本段与第 4) 段的两条 trgm 索引整段注释掉，其余段仍可正常执行
--    （应用层零改动，仅失去 trgm 加速；tsvector 段不依赖扩展，照常可用）。
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1) records 增量列
--    someday       R2「某天」显式标记；历史行由 DEFAULT false 填充
--                  （= 仍出现在今天/即将，与 v2.12.2 表现一致），不需要 UPDATE 回填。
--    snoozed_until R4 稍后提醒的到期时刻；空 = 未推迟，调度走原路径。
--    snooze_count  R4 已 snooze 次数（去重键第三段），0 = 从未 snooze。
--    search_tsv    R1 检索用 generated 列：PG 在建列时对存量行计算一次，
--                  之后随 title/content 变更自动重算，无需回填、无需写入代码。
--                  注意：generated 列只能被 SELECT，写入会被 PG 拒绝。
-- ---------------------------------------------------------------------------
ALTER TABLE public.records
  ADD COLUMN IF NOT EXISTS someday       BOOLEAN     NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS snooze_count  INT         NOT NULL DEFAULT 0;

ALTER TABLE public.records
  ADD COLUMN IF NOT EXISTS search_tsv tsvector
    GENERATED ALWAYS AS (
      to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, ''))
    ) STORED;

COMMENT ON COLUMN public.records.someday IS 'v2.13 R2 待办「某天」显式标记（true 时只出现在某天段，不再出现在今天/即将）';
COMMENT ON COLUMN public.records.snoozed_until IS 'v2.13 R4 稍后提醒的到期时刻（UTC），空表示未推迟；不改 remind_at';
COMMENT ON COLUMN public.records.snooze_count IS 'v2.13 R4 已 snooze 次数，用作去重键第三段；完成/改提醒时间时由应用层复位为 0';
COMMENT ON COLUMN public.records.search_tsv IS 'v2.13 R1 检索用 generated tsvector（simple 配置，title + content）';
COMMENT ON COLUMN public.records.recurrence IS 'P0-B 循环规则 {freq:daily|weekly|monthly,interval:1..99,weekdays:number[],anchorDay?:1..31,endDate:YYYY-MM-DD|null,mode?:due|completion}；v2.13 起 mode=completion 表示以完成日为下一期基准';

-- ---------------------------------------------------------------------------
-- 2) settings 增量列（R5 周回顾向导断点续；沿用 float_position 的 JSONB 先例）
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS review_wizard JSONB;

COMMENT ON COLUMN public.settings.review_wizard IS 'v2.13 R5 周回顾向导断点续进度（ReviewWizardProgress），空表示无进行中回顾';

-- ---------------------------------------------------------------------------
-- 3) 约束（幂等：PG 不支持 ADD CONSTRAINT IF NOT EXISTS，用 catalog 判重）
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'records_snooze_count_chk' AND conrelid = 'public.records'::regclass
  ) THEN
    ALTER TABLE public.records ADD CONSTRAINT records_snooze_count_chk CHECK (snooze_count >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 4) 索引
--    trgm ：让现有 ILIKE '%kw%'（title/content 子串）走 GIN —— R1 性能主路径，
--           中文是唯一可靠命中路径（PG 默认 parser 不切 CJK）。
--    tsv  ：英文/显式空格多词的叠加召回路径。
--    someday：待办「某天」段与「未完成待办」列表的部分索引。
--    命名沿用既有 records_owner_* 风格（与 records_owner_type_idx /
--    records_owner_created_idx / records_owner_todo_remind_idx 一致）；
--    但索引键里【不含 owner_id】—— GIN 复合键需要 btree_gin，本期不引入；
--    owner 维度由 RLS 策略作为过滤条件施加，单账号数据量下选择率足够。
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS records_owner_title_trgm_idx
  ON public.records USING GIN (title gin_trgm_ops);

CREATE INDEX IF NOT EXISTS records_owner_content_trgm_idx
  ON public.records USING GIN (content gin_trgm_ops);

CREATE INDEX IF NOT EXISTS records_owner_search_tsv_idx
  ON public.records USING GIN (search_tsv);

CREATE INDEX IF NOT EXISTS records_owner_someday_idx
  ON public.records (owner_id, todo_status)
  WHERE someday = true AND is_deleted = false;

-- ---------------------------------------------------------------------------
-- 5) 自检（执行后人工核对：期望 4 / 1 / 4 / 1 / 4）
-- ---------------------------------------------------------------------------
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='records'
--    AND column_name IN ('someday','snoozed_until','snooze_count','search_tsv');       -- 期望 4
-- SELECT count(*) FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='settings'
--    AND column_name='review_wizard';                                                   -- 期望 1
-- SELECT indexname FROM pg_indexes WHERE schemaname='public'
--   AND indexname IN ('records_owner_title_trgm_idx','records_owner_content_trgm_idx',
--                     'records_owner_search_tsv_idx','records_owner_someday_idx');      -- 期望 4
-- SELECT conname FROM pg_constraint WHERE conname='records_snooze_count_chk';           -- 期望 1
-- SELECT extname, extversion FROM pg_extension WHERE extname='pg_trgm';                 -- 期望 1 行，1.6
-- SELECT policyname FROM pg_policies WHERE schemaname='public'
--   AND tablename IN ('records','settings');                                            -- 期望各 4 条，未变

-- ---------------------------------------------------------------------------
-- 6) 回滚（默认注释；一般只需回退应用代码，新列闲置不影响旧版本）
--    注意：回退代码后仍有 snoozed_until 的记录会按普通提醒再弹一次（可接受）。
-- ---------------------------------------------------------------------------
-- DROP INDEX IF EXISTS public.records_owner_title_trgm_idx;
-- DROP INDEX IF EXISTS public.records_owner_content_trgm_idx;
-- DROP INDEX IF EXISTS public.records_owner_search_tsv_idx;
-- DROP INDEX IF EXISTS public.records_owner_someday_idx;
-- ALTER TABLE public.records DROP CONSTRAINT IF EXISTS records_snooze_count_chk;
-- ALTER TABLE public.records
--   DROP COLUMN IF EXISTS search_tsv,
--   DROP COLUMN IF EXISTS someday,
--   DROP COLUMN IF EXISTS snoozed_until,
--   DROP COLUMN IF EXISTS snooze_count;
-- ALTER TABLE public.settings DROP COLUMN IF EXISTS review_wizard;
-- DROP EXTENSION IF EXISTS pg_trgm;
