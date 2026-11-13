-- v2.13.2 UI-1：界面方案偏好（silent / zoned / fluid）
--
-- 执行方式：**由智能体通过云库 SQL 通道逐条执行**（`mode: "migrate"`，一次一条语句）。
--   WorkBuddy 不向用户开放 SQL 控制台，DDL 只能由智能体代跑（详见 `docs/v2.14/migration.sql` 头部说明）。
-- 执行状态：**2026-11-13 已在真库执行完毕并校验通过**（`settings.ui_scheme` text 可空 +
--   `COMMENT` + `settings_ui_scheme_chk` 约束 `NOT VALID`）。本文件仍幂等，可重复跑。
-- 不执行也不会坏：`web/src/store/uiSchemeStore.ts` 在云读写失败时静默退化为
-- 设备级（localStorage），设置页会显示「仅本机生效」。执行后自动变为跨设备同步。

ALTER TABLE public.settings
  ADD COLUMN IF NOT EXISTS ui_scheme text;

COMMENT ON COLUMN public.settings.ui_scheme IS
  '界面方案：silent=静默化 / zoned=分区骨架 / fluid=流畅优先；NULL 表示未选择（按 silent 处理）';

-- 约束用 NOT VALID 加：只校验新写入，不回头扫历史行，避免长表锁。
-- 应用层已用 normalizeUiScheme() 兜底，这里的约束是防"绕过应用直写"。 
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'settings_ui_scheme_chk'
  ) THEN
    ALTER TABLE public.settings
      ADD CONSTRAINT settings_ui_scheme_chk
      CHECK (ui_scheme IS NULL OR ui_scheme IN ('silent', 'zoned', 'fluid'))
      NOT VALID;
  END IF;
END
$$;
