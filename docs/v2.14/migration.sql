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


-- =====================================================================================
-- 5) v2.15：多端同时在线（设备注册表 + updated_at 自动维护）
-- =====================================================================================
--
-- 背景：同一账号要能在 **Android APK + Windows 桌面端** 同时登录。会话本身天然是多份的
-- （每台设备各持一个 refresh 句柄，服务端不互相吊销），但「谁在线、几台、怎么请某一台下线」
-- 需要一个可查询的载体，于是有 devices 表。
--
-- 与 settings 的关系：**不复用 settings 的 JSONB 桶**。settings 是"单行账户配置"，
-- 多设备并发写同一行必然互覆盖；devices 天然一行一台，各自只写自己的 last_seen_at，
-- 没有写冲突。
--
-- 幂等：全部 IF NOT EXISTS / DROP ... IF EXISTS 守卫，可重复执行。

CREATE TABLE IF NOT EXISTS public.devices (
  id           BIGSERIAL PRIMARY KEY,
  owner_id     TEXT NOT NULL DEFAULT auth.uid(),
  -- 客户端 localStorage 里的稳定随机 ID（卸载重装会变 → 视为新设备）
  device_id    TEXT NOT NULL,
  -- 机器可读平台：desktop / android / ios / web（web/src/lib/platform.ts 的值域）
  platform     TEXT NOT NULL DEFAULT 'web',
  -- 人类可读标签：'Windows · 桌面端' / 'Android · 手机'
  label        TEXT NOT NULL DEFAULT '',
  app_version  TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 由客户端心跳写入（ISO 串，服务端不生成）→ 见下方说明为什么不用 now()
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 非空 = 已被其它设备「请下线」；该设备下次心跳读到即自行登出
  revoked_at   TIMESTAMPTZ
);

COMMENT ON TABLE public.devices IS
  '多端在线的设备注册表：(owner_id, device_id) 唯一，一行一台设备。';
COMMENT ON COLUMN public.devices.revoked_at IS
  '被其它设备注销的时刻。非空时被注销端在下一次心跳（≤60s）读到后自行 signOut；'
  '重新验证码登录会把该列清空（「请下线」不是「封禁」）。';

-- 唯一键：同一账号同一台设备只允许一行（重复登录是 update，不是 insert）
CREATE UNIQUE INDEX IF NOT EXISTS devices_owner_device_uniq
  ON public.devices (owner_id, device_id);

-- 设备列表按最近活跃倒序分页
CREATE INDEX IF NOT EXISTS devices_owner_seen_idx
  ON public.devices (owner_id, last_seen_at DESC);

-- 两道门的第一道：先给角色授权（漏 GRANT 会得到形似策略失效的 42501）
GRANT SELECT, INSERT, UPDATE, DELETE ON public.devices TO authenticated, anon;
GRANT USAGE, SELECT ON SEQUENCE public.devices_id_seq TO authenticated, anon;

-- 第二道门：行级策略按 owner_id 隔离（与 records / settings 同一套写法）
DROP POLICY IF EXISTS devices_select_own ON public.devices;
CREATE POLICY devices_select_own ON public.devices
  FOR SELECT USING (owner_id = auth.uid());

DROP POLICY IF EXISTS devices_insert_own ON public.devices;
CREATE POLICY devices_insert_own ON public.devices
  FOR INSERT WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS devices_update_own ON public.devices;
CREATE POLICY devices_update_own ON public.devices
  FOR UPDATE USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS devices_delete_own ON public.devices;
CREATE POLICY devices_delete_own ON public.devices
  FOR DELETE USING (owner_id = auth.uid());

-- -------------------------------------------------------------------------------------
-- updated_at 自动维护
-- -------------------------------------------------------------------------------------
-- 真库实测：public 下**一个触发器都没有**，`records.updated_at` 只有 `DEFAULT now()`，
-- 于是它永远等于创建时间，UPDATE 不会推进。后果：
--   1. 多端并发时无法判断「谁后写」（LWW 失效，冲突时只能靠 id 顺序瞎猜）；
--   2. `listByUpdatedSince`（项目健康检查）与离线库按 updatedAt 淘汰全部失真；
--   3. 增量同步（拿 updated_at 做游标）永远拉不到改动。
-- 用 BEFORE UPDATE 触发器兜住所有写入路径（含未来新增的），比在每个 service 里手写
-- `updated_at: now()` 可靠——后者漏一处就永久静默失真。
CREATE OR REPLACE FUNCTION public.pa_touch_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS records_touch_updated_at ON public.records;
CREATE TRIGGER records_touch_updated_at
  BEFORE UPDATE ON public.records
  FOR EACH ROW EXECUTE FUNCTION public.pa_touch_updated_at();

DROP TRIGGER IF EXISTS settings_touch_updated_at ON public.settings;
CREATE TRIGGER settings_touch_updated_at
  BEFORE UPDATE ON public.settings
  FOR EACH ROW EXECUTE FUNCTION public.pa_touch_updated_at();
