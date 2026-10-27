-- =============================================================================
-- 「个人信息管家 Agent」数据库等价 DDL 存档
-- -----------------------------------------------------------------------------
-- 说明：
--   1. 本文件为「等价 DDL 存档」，仅用于本地留档/重建参考。
--      线上数据库（records / record_links / code_analyses / qa_sessions /
--      chat_messages / settings）已建好、RLS 已启用、策略与索引已就绪，
--      应用代码【不执行任何 DDL】。
--   2. 列名均为 snake_case；RLS 通过 owner_id = auth.uid() 隔离；
--      前端永不发送 owner_id（由 DEFAULT auth.uid() 填充）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. records —— 信息记录主表（统一存放想法/资料/待办）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.records (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id    TEXT        NOT NULL DEFAULT auth.uid(),
  type        TEXT        NOT NULL CHECK (type IN ('idea','material','todo')),
  title       TEXT        NOT NULL DEFAULT '',
  content     TEXT        NOT NULL DEFAULT '',
  url         TEXT,
  file_path   TEXT,
  category    TEXT,
  tags        TEXT[]      NOT NULL DEFAULT '{}',
  summary     TEXT,
  todo_status TEXT        CHECK (todo_status IN ('pending','done')),
  priority    TEXT        CHECK (priority IN ('high','medium','low')),
  remind_at   TIMESTAMPTZ,
  is_deleted  BOOLEAN     NOT NULL DEFAULT false,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS records_owner_type_idx      ON public.records (owner_id, type);
CREATE INDEX IF NOT EXISTS records_owner_category_idx  ON public.records (owner_id, category);
CREATE INDEX IF NOT EXISTS records_owner_created_idx   ON public.records (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS records_owner_deleted_idx   ON public.records (owner_id, is_deleted);
CREATE INDEX IF NOT EXISTS records_tags_gin_idx        ON public.records USING GIN (tags);

-- ---------------------------------------------------------------------------
-- 2. record_links —— 智能关联（记录 ↔ 记录）
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.record_links (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id   TEXT        NOT NULL DEFAULT auth.uid(),
  source_id  BIGINT      NOT NULL,
  target_id  BIGINT      NOT NULL,
  score      REAL        NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS record_links_owner_source_idx ON public.record_links (owner_id, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS record_links_owner_src_tgt_uniq ON public.record_links (owner_id, source_id, target_id);

-- ---------------------------------------------------------------------------
-- 3. code_analyses —— VS 代码分析结果
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.code_analyses (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id      TEXT        NOT NULL DEFAULT auth.uid(),
  solution_name TEXT        NOT NULL,
  solution_path TEXT,
  project_name  TEXT,
  issues        JSONB       NOT NULL DEFAULT '[]',
  summary       TEXT,
  status        TEXT        DEFAULT 'done' CHECK (status IN ('pending','analyzing','done','failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS code_analyses_owner_solution_created_idx ON public.code_analyses (owner_id, solution_name, created_at DESC);

-- ---------------------------------------------------------------------------
-- 4. qa_sessions / chat_messages —— 智能问答会话与消息
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.qa_sessions (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id   TEXT        NOT NULL DEFAULT auth.uid(),
  title      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qa_sessions_owner_created_idx ON public.qa_sessions (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.chat_messages (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id   TEXT        NOT NULL DEFAULT auth.uid(),
  session_id BIGINT      NOT NULL,
  role       TEXT        CHECK (role IN ('user','assistant')),
  content    TEXT,
  sources    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx ON public.chat_messages (session_id, created_at);

-- ---------------------------------------------------------------------------
-- 5. settings —— 用户共享设置（跨端一致，每用户一行）
--    id 为 BIGINT 自增主键，同时充当「唯一账户 ID」（展示零填充 9 位，不可修改）；
--    owner_id 唯一索引保证每用户一行；nickname 允许重名（不建唯一约束）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.settings (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id             TEXT      NOT NULL DEFAULT auth.uid(),
  vs_path              TEXT,
  code_upload_enabled  BOOLEAN   DEFAULT true,
  float_window_enabled BOOLEAN   DEFAULT true,
  float_position       JSONB,
  notify_enabled       BOOLEAN   DEFAULT true,
  avatar_image_id      BIGINT,
  nickname             VARCHAR(20),
  updated_at           TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS settings_owner_id_key ON public.settings (owner_id);

-- ---------------------------------------------------------------------------
-- 7. images —— 图片存储（原图 + 128/256/512 三档缩略图）
--     name 允许重名（不建唯一约束）；id BIGINT 自增，展示零填充 9 位
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.images (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id       TEXT        NOT NULL DEFAULT auth.uid(),
  name           VARCHAR(20) NOT NULL,
  mime_type      VARCHAR(32) NOT NULL,
  size           BIGINT      NOT NULL,
  original_path  TEXT,
  thumb_128_path TEXT,
  thumb_256_path TEXT,
  thumb_512_path TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS images_owner_created_idx ON public.images (owner_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 8. plugins —— 插件元数据（代码包存云 storage，entry_path 关联）
--     owner_id + plugin_id 唯一；permissions 为权限声明 token 数组
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.plugins (
  id           BIGINT       GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id     TEXT         NOT NULL DEFAULT auth.uid(),
  plugin_id    TEXT         NOT NULL,                 -- manifest 里的 id，如 com.example.demo
  name         TEXT         NOT NULL,
  version      TEXT         NOT NULL,                 -- semver，如 1.0.0
  description  TEXT         NOT NULL DEFAULT '',
  author       TEXT,
  repo_url     TEXT,                                   -- GitHub 仓库地址（安装来源）
  permissions  TEXT[]       NOT NULL DEFAULT '{}',     -- 权限声明 token 数组
  entry_path   TEXT         NOT NULL,                  -- storage 代码包路径（含版本）
  enabled      BOOLEAN      NOT NULL DEFAULT false,
  installed_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS plugins_owner_plugin_uniq ON public.plugins (owner_id, plugin_id);
CREATE INDEX IF NOT EXISTS plugins_owner_created_idx ON public.plugins (owner_id, installed_at DESC);

-- ---------------------------------------------------------------------------
-- 9. mind_trees —— 思维树林云端同步（每用户一行，整份树林文档存 JSONB）
--     payload 为 MindForestStore（{version,trees,forests,crossLinks}）整体序列化；
--     owner_id 唯一索引保证每用户一行；本地 localStorage 缓存 + 登录后云端同步。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.mind_trees (
  id         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id   TEXT        NOT NULL DEFAULT auth.uid(),
  payload    JSONB       NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mind_trees_owner_id_key ON public.mind_trees (owner_id);

-- ---------------------------------------------------------------------------
-- 6. RLS 策略（每张表同构执行）
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['records','record_links','code_analyses','qa_sessions','chat_messages','settings','images','plugins','mind_trees']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated, anon', t);

    EXECUTE format('DROP POLICY IF EXISTS %I_select_own ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_select_own ON public.%I FOR SELECT TO authenticated, anon USING (owner_id = auth.uid())', t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I_insert_own ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_insert_own ON public.%I FOR INSERT TO authenticated, anon WITH CHECK (owner_id = auth.uid())', t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I_update_own ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_update_own ON public.%I FOR UPDATE TO authenticated, anon USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', t, t);

    EXECUTE format('DROP POLICY IF EXISTS %I_delete_own ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_delete_own ON public.%I FOR DELETE TO authenticated, anon USING (owner_id = auth.uid())', t, t);
  END LOOP;
END $$;

-- =============================================================================
-- 增量迁移（v2.13）
-- -----------------------------------------------------------------------------
-- 与 docs/v2.13/migration.sql 内容一致（同一份 DDL 的两个存档位）。
-- 范围：R1 检索走索引（pg_trgm + tsvector）、R2 待办「某天」（someday）、
--       R3 循环「按完成日重复」（JSONB 内加键，无 DDL，仅改列注释）、
--       R4 提醒「稍后」（snoozed_until / snooze_count）、
--       R5 周回顾向导进度（settings.review_wizard）、R6 .ics 导出（无 DDL）。
-- 特性：纯增量、全部可空或有默认值、幂等可重跑、不回填数据、不改既有 RLS 策略。
-- 说明：本段是「等价 DDL 存档」，应用代码【不执行任何 DDL】；
--       线上由主理人手工执行（CREATE EXTENSION 需要 migrate 权限）。
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 0) 扩展（必须第一条，先于第 4) 段 trgm 索引；若无权限见 DESIGN §3.3「备而不用」）
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 1) records 增量列（someday 由 DEFAULT false 填充历史行；search_tsv 为 generated 列）
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

-- ---------------------------------------------------------------------------
-- 2) 注释同步（无 DDL）：recurrence 新增 mode 键（R3，JSONB 内键，旧数据缺省即 due）
-- ---------------------------------------------------------------------------
COMMENT ON COLUMN public.records.recurrence IS 'P0-B 循环规则 {freq:daily|weekly|monthly,interval:1..99,weekdays:number[],anchorDay?:1..31,endDate:YYYY-MM-DD|null,mode?:due|completion}；v2.13 起 mode=completion 表示以完成日为下一期基准';

-- ---------------------------------------------------------------------------
-- 3) settings 增量列（R5 周回顾向导断点续；沿用 float_position 的 JSONB 先例）
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS review_wizard JSONB;

COMMENT ON COLUMN public.settings.review_wizard IS 'v2.13 R5 周回顾向导断点续进度（ReviewWizardProgress），空表示无进行中回顾';

-- ---------------------------------------------------------------------------
-- 4) 约束（幂等：用 catalog 判重）
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
-- 5) 索引（trgm：中文/子串主力路径；search_tsv：英文与多词叠加；someday：某天段）
--    命名沿用 records_owner_* 风格；GIN 键里不含 owner_id（不引入 btree_gin）
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
-- 6) 自检（期望 4 / 1 / 4 / 1 / 4）
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
