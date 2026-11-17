#!/usr/bin/env node
/**
 * QA 测试一键编译 + 运行脚本（Node + esbuild JS API + node:test）。
 * 用 JS API 传 alias 可避免 Git Bash/MSYS 对 `@/lib/cloud` 之类参数的路径改写。
 * 运行：node qa/run-tests.mjs
 */
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const distDir = resolve(root, 'qa', 'dist')
mkdirSync(distDir, { recursive: true })

// esbuild 位于 web/node_modules（ESM 源码，用 require 拉取 CJS 入口）
const esbuild = require(resolve(root, 'web', 'node_modules', 'esbuild', 'lib', 'main.js'))
const { build } = esbuild

const electronAlias = { electron: resolve(root, 'qa', 'mocks', 'electron.ts') }
const webAlias = {
  '@/lib/cloud': resolve(root, 'qa', 'mocks', 'cloud.ts'),
  '@': resolve(root, 'web', 'src'),
  '@shared': resolve(root, 'shared'),
}

const targets = [
  { entry: 'qa/llm.test.ts', out: 'qa/dist/llm.test.cjs', alias: {} },
  { entry: 'qa/constants.test.ts', out: 'qa/dist/constants.test.cjs', alias: {} },
  { entry: 'qa/cheatsheet.test.ts', out: 'qa/dist/cheatsheet.test.cjs', alias: {} },
  { entry: 'qa/cpp-cheatsheet.test.ts', out: 'qa/dist/cpp-cheatsheet.test.cjs', alias: {} },
  { entry: 'qa/solution-reader.test.ts', out: 'qa/dist/solution-reader.test.cjs', alias: {} },
  { entry: 'qa/analysis-exporter.test.ts', out: 'qa/dist/analysis-exporter.test.cjs', alias: electronAlias },
  { entry: 'qa/floating-geometry.test.ts', out: 'qa/dist/floating-geometry.test.cjs', alias: {} },
  { entry: 'qa/store.test.ts', out: 'qa/dist/store.test.cjs', alias: electronAlias },
  { entry: 'qa/analysis-orchestrator.test.ts', out: 'qa/dist/analysis-orchestrator.test.cjs', alias: electronAlias },
  { entry: 'qa/selection-analyzer.test.ts', out: 'qa/dist/selection-analyzer.test.cjs', alias: electronAlias },
  { entry: 'qa/main-window.test.ts', out: 'qa/dist/main-window.test.cjs', alias: electronAlias },
  { entry: 'qa/aiService-selection.test.ts', out: 'qa/dist/aiService-selection.test.cjs', alias: webAlias },
  { entry: 'qa/aiService-p1.test.ts', out: 'qa/dist/aiService-p1.test.cjs', alias: webAlias },
  { entry: 'qa/recordService-listByRange.test.ts', out: 'qa/dist/recordService-listByRange.test.cjs', alias: webAlias },
  { entry: 'qa/recordService-crud.test.ts', out: 'qa/dist/recordService-crud.test.cjs', alias: webAlias },
  { entry: 'qa/aiService-classify.test.ts', out: 'qa/dist/aiService-classify.test.cjs', alias: webAlias },
  { entry: 'qa/recordStore-race.test.ts', out: 'qa/dist/recordStore-race.test.cjs', alias: webAlias },
  { entry: 'qa/mindtree.test.ts', out: 'qa/dist/mindtree.test.cjs', alias: webAlias },
  { entry: 'qa/mindforest-store.test.ts', out: 'qa/dist/mindforest-store.test.cjs', alias: webAlias },
  { entry: 'qa/mindforest-cross.test.ts', out: 'qa/dist/mindforest-cross.test.cjs', alias: webAlias },
  { entry: 'qa/mindforest-cloud.test.ts', out: 'qa/dist/mindforest-cloud.test.cjs', alias: webAlias },
  { entry: 'qa/errors.test.ts', out: 'qa/dist/errors.test.cjs', alias: {} },
  { entry: 'qa/auth-expired-sdk.test.ts', out: 'qa/dist/auth-expired-sdk.test.cjs', alias: {} },
  { entry: 'qa/update-service.test.ts', out: 'qa/dist/update-service.test.cjs', alias: webAlias },
  { entry: 'qa/update-service-check.test.ts', out: 'qa/dist/update-service-check.test.cjs', alias: webAlias },
  { entry: 'qa/image-service.test.ts', out: 'qa/dist/image-service.test.cjs', alias: webAlias },
  { entry: 'qa/profile-service.test.ts', out: 'qa/dist/profile-service.test.cjs', alias: webAlias },
  { entry: 'qa/cpp-runner.test.ts', out: 'qa/dist/cpp-runner.test.cjs', alias: {} },
  { entry: 'qa/toolchain.test.ts', out: 'qa/dist/toolchain.test.cjs', alias: electronAlias },
  { entry: 'qa/cdb-parse.test.ts', out: 'qa/dist/cdb-parse.test.cjs', alias: {} },
  { entry: 'qa/provision.test.ts', out: 'qa/dist/provision.test.cjs', alias: electronAlias },
  { entry: 'qa/recurrence.test.ts', out: 'qa/dist/recurrence.test.cjs', alias: {} },
  { entry: 'qa/p2-7-next-instance.test.ts', out: 'qa/dist/p2-7-next-instance.test.cjs', alias: {} },
  { entry: 'qa/recurrence-service.test.ts', out: 'qa/dist/recurrence-service.test.cjs', alias: webAlias },
  { entry: 'qa/reminder-schedule.test.ts', out: 'qa/dist/reminder-schedule.test.cjs', alias: {} },
  { entry: 'qa/link-preview.test.ts', out: 'qa/dist/link-preview.test.cjs', alias: {} },
  // P0 对抗性测试（QA 独立补充）
  { entry: 'qa/p0-a-reminder-schedule-adversarial.test.ts', out: 'qa/dist/p0-a-reminder-schedule-adversarial.test.cjs', alias: {} },
  { entry: 'qa/p0-a-reminder-service.test.ts', out: 'qa/dist/p0-a-reminder-service.test.cjs', alias: webAlias },
  { entry: 'qa/p0-a-notification-provider.test.ts', out: 'qa/dist/p0-a-notification-provider.test.cjs', alias: webAlias },
  { entry: 'qa/p0-a-notification-chain.test.ts', out: 'qa/dist/p0-a-notification-chain.test.cjs', alias: {} },
  { entry: 'qa/p0-a-permission-probe.test.ts', out: 'qa/dist/p0-a-permission-probe.test.cjs', alias: webAlias },
  { entry: 'qa/p0-a-desktop-notifier.test.ts', out: 'qa/dist/p0-a-desktop-notifier.test.cjs', alias: electronAlias },
  { entry: 'qa/p0-b-recurrence-adversarial.test.ts', out: 'qa/dist/p0-b-recurrence-adversarial.test.cjs', alias: {} },
  { entry: 'qa/p0-b-recurrence-service-adversarial.test.ts', out: 'qa/dist/p0-b-recurrence-service-adversarial.test.cjs', alias: webAlias },
  { entry: 'qa/p0-c-link-preview-http.test.ts', out: 'qa/dist/p0-c-link-preview-http.test.cjs', alias: {} },
  { entry: 'qa/p0-c-transport-post.test.ts', out: 'qa/dist/p0-c-transport-post.test.cjs', alias: {} },
  { entry: 'qa/p0-c-domain-resolution-regression.test.ts', out: 'qa/dist/p0-c-domain-resolution-regression.test.cjs', alias: {} },
  { entry: 'qa/p0-c-server-smoke.test.ts', out: 'qa/dist/p0-c-server-smoke.test.cjs', alias: {} },
  { entry: 'qa/p0-e-frontend-safety.test.ts', out: 'qa/dist/p0-e-frontend-safety.test.cjs', alias: webAlias },
  // v2.13 第一批（T01 地基 / T02 R1 检索 / T03 R2 三段视图 / T04 R3 completion 模式）
  { entry: 'qa/v213-foundation.test.ts', out: 'qa/dist/v213-foundation.test.cjs', alias: webAlias },
  { entry: 'qa/v213-search.test.ts', out: 'qa/dist/v213-search.test.cjs', alias: webAlias },
  { entry: 'qa/todo-segments.test.ts', out: 'qa/dist/todo-segments.test.cjs', alias: webAlias },
  { entry: 'qa/recurrence-completion.test.ts', out: 'qa/dist/recurrence-completion.test.cjs', alias: {} },
  // v2.13 第二批（T05 R4 snooze / T06 R5 周回顾向导 / T07 R6 ICS 导出）
  { entry: 'qa/v213-reminder-snooze.test.ts', out: 'qa/dist/v213-reminder-snooze.test.cjs', alias: webAlias },
  { entry: 'qa/v213-review-wizard.test.ts', out: 'qa/dist/v213-review-wizard.test.cjs', alias: webAlias },
  { entry: 'qa/v213-ics.test.ts', out: 'qa/dist/v213-ics.test.cjs', alias: webAlias },
  // v2.13 QA 独立验证（边界 / 对抗 / 现状锁定）
  { entry: 'qa/v213-qa-edge.test.ts', out: 'qa/dist/v213-qa-edge.test.cjs', alias: webAlias },
  // v2.13.2 UI 方案内核（三方案归一化 / 能力矩阵 / 变化摘要）
  { entry: 'qa/ui-scheme.test.ts', out: 'qa/dist/ui-scheme.test.cjs', alias: webAlias },
  // 日历互通 P0-1 上半（.ics 解析层：时区四类判定 / 循环展开 / VTODO）
  { entry: 'qa/ics-parse.test.ts', out: 'qa/dist/ics-parse.test.cjs', alias: webAlias },
  // 日历互通 P0-1 上半 · QA 独立对抗性验证（Windows 名 / DST / 覆盖跨天 / 容错 / 纯函数 / 性能）
  { entry: 'qa/ics-parse-adversarial.test.ts', out: 'qa/dist/ics-parse-adversarial.test.cjs', alias: webAlias },
  // 日历互通 P0-1 下半（纯映射层 / 导入落库链路）
  { entry: 'qa/ics-map.test.ts', out: 'qa/dist/ics-map.test.cjs', alias: webAlias },
  { entry: 'qa/ics-import.test.ts', out: 'qa/dist/ics-import.test.cjs', alias: webAlias },
  // 日历互通 P0-2（.ics 导出补 VALARM/RRULE/RELATED-TO/TRANSP + parent_id 回填 + 待办「重要」筛选）
  { entry: 'qa/p0-2-ics-export.test.ts', out: 'qa/dist/p0-2-ics-export.test.cjs', alias: webAlias },
  // 订阅源入库 P0-3 上半（OPML 容错导入 / fetchFeed 状态机 / 服务端抓取代理）
  { entry: 'qa/p0-d-feed-opml.test.ts', out: 'qa/dist/p0-d-feed-opml.test.cjs', alias: webAlias },
  { entry: 'qa/p0-d-feed-fetch.test.ts', out: 'qa/dist/p0-d-feed-fetch.test.cjs', alias: webAlias },
  { entry: 'qa/p0-d-feed-server.test.ts', out: 'qa/dist/p0-d-feed-server.test.cjs', alias: {} },
  // 订阅源入库 P0-3 下半（纯函数层：合并/调度/草稿/OPML 导出；服务层：查重落库/一轮 tick）
  { entry: 'qa/p0-d-feed-store.test.ts', out: 'qa/dist/p0-d-feed-store.test.cjs', alias: webAlias },
  { entry: 'qa/p0-d-feed-upsert.test.ts', out: 'qa/dist/p0-d-feed-upsert.test.cjs', alias: webAlias },
  // 订阅源入库 P0-3 下半 · QA 独立对抗性验证（304 阶梯 / 三态机 / persistError / 三闸 / url 边界 / 特殊字符往返）
  { entry: 'qa/p0-d-feed-adversarial.test.ts', out: 'qa/dist/p0-d-feed-adversarial.test.cjs', alias: webAlias },
  // 订阅源入库 P0-3 下半 · QA 隔离验证（提醒链路 ↔ 订阅抓取：异常不外溢 / 不插队 / quiet 透传）
  {
    entry: 'qa/p0-d-feed-reminder-isolation.test.ts',
    out: 'qa/dist/p0-d-feed-reminder-isolation.test.cjs',
    alias: { ...webAlias, '@/services/feedService': resolve(root, 'qa', 'mocks', 'feedService.ts') },
  },
  // 机器视觉模块（特征 / 分类 / 质检 / 感知哈希 / 预处理阶梯 / 提示词 / 结果解析 / 重试策略）
  { entry: 'qa/vision-features.test.ts', out: 'qa/dist/vision-features.test.cjs', alias: webAlias },
  { entry: 'qa/vision-classify.test.ts', out: 'qa/dist/vision-classify.test.cjs', alias: webAlias },
  { entry: 'qa/vision-quality.test.ts', out: 'qa/dist/vision-quality.test.cjs', alias: webAlias },
  { entry: 'qa/vision-phash.test.ts', out: 'qa/dist/vision-phash.test.cjs', alias: webAlias },
  { entry: 'qa/vision-plan.test.ts', out: 'qa/dist/vision-plan.test.cjs', alias: webAlias },
  { entry: 'qa/vision-prompt.test.ts', out: 'qa/dist/vision-prompt.test.cjs', alias: webAlias },
  { entry: 'qa/vision-result.test.ts', out: 'qa/dist/vision-result.test.cjs', alias: webAlias },
  { entry: 'qa/vision-service.test.ts', out: 'qa/dist/vision-service.test.cjs', alias: webAlias },
  // 移动端骨架 P0-4 上半（侧栏断点切换纯函数 + Layout 源码约束）
  { entry: 'qa/p0-f-shell-layout.test.ts', out: 'qa/dist/p0-f-shell-layout.test.cjs', alias: webAlias },
  // 移动端骨架 P0-4 上半 · QA 独立对抗性验证（纯函数性 / 单一事实源 / 小数入参 / 阈值扫描 / 夹取）
  { entry: 'qa/p0-f-shell-layout-adversarial.test.ts', out: 'qa/dist/p0-f-shell-layout-adversarial.test.cjs', alias: webAlias },
  // 移动端骨架 P0-4 下半（底部导航纯函数 / 安全区留白 / FAB 偏移 / 活跃判定 / 12 页可达 / 源码约束）
  { entry: 'qa/p0-f-bottom-nav.test.ts', out: 'qa/dist/p0-f-bottom-nav.test.cjs', alias: webAlias },
  // 加载问候语 P0-5（时段边界 / 排除上一条 / 空池兜底 / 连续 10 次不重复 / 存储降级）
  { entry: 'qa/greeting.test.ts', out: 'qa/dist/greeting.test.cjs', alias: webAlias },
  // 快捷键注册表 P1-14（规范化 / 输入框闸门 / 序列键 / 作用域与冲突检测 / 文档一致性）
  { entry: 'qa/shortcuts.test.ts', out: 'qa/dist/shortcuts.test.cjs', alias: webAlias },
  // 命令面板 P1-12 上半（跳转命令派生 / 过滤 / 分组 / 键盘契约 / 同步开面板）
  { entry: 'qa/p1-12-command-palette.test.ts', out: 'qa/dist/p1-12-command-palette.test.cjs', alias: webAlias },
  // 命令面板 P1-12 下半（记录 provider / 拼音首字母 / 三层排序 / 最近使用 / 全局详情宿主）
  { entry: 'qa/p1-12-palette-record.test.ts', out: 'qa/dist/p1-12-palette-record.test.cjs', alias: webAlias },
  // 桌面端线上地址拼装与分享码自愈（发布位开启分享码后新增）
  { entry: 'qa/desktop-app-url.test.ts', out: 'qa/dist/desktop-app-url.test.cjs', alias: electronAlias },
  // PWA 可安装 + 离线壳（P1-9：manifest / workbox 白名单 / 导航回退 / 可达性三态 / 离线库淘汰）
  { entry: 'qa/p1-9-pwa.test.ts', out: 'qa/dist/p1-9-pwa.test.cjs', alias: webAlias },
  // P1-8 上半：窄屏列表降级（密度纯函数 + 卡片接线，纯模块不需要云 mock）
  { entry: 'qa/p1-8-compact-list.test.ts', out: 'qa/dist/p1-8-compact-list.test.cjs', alias: {} },
  // APK 可安装性：签名统一 / v3 / minSdk / manifest 关键项
  { entry: 'qa/apk-installability.test.ts', out: 'qa/dist/apk-installability.test.cjs', alias: {} },
  // v2.15：Android APK + 多端同时在线（设备注册表 / 会话守护 / 壳工程配置）
  { entry: 'qa/device-sessions.test.ts', out: 'qa/dist/device-sessions.test.cjs', alias: webAlias },
  { entry: 'qa/otp-guard.test.ts', out: 'qa/dist/otp-guard.test.cjs', alias: webAlias },
]

// 云服务配置已参数化为 import.meta.env.VITE_*；测试环境无 Vite 注入，
// 用 esbuild define 把 import.meta.env 替换为空值对象（配合源码里的 ?? 兜底）。
const importMetaEnvDefine = {
  'import.meta.env': JSON.stringify({
    VITE_CLOUD_ENDPOINT: '',
    VITE_OAUTH_RELAY_BASE_URL: '',
    VITE_CLOUD_PUBLISHABLE_KEY: '',
    VITE_WEB_APP_URL: '',
  }),
}

console.log('==> 编译测试文件（esbuild bundle）')
for (const t of targets) {
  await build({
    entryPoints: [resolve(root, t.entry)],
    outfile: resolve(root, t.out),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    alias: t.alias,
    define: { ...importMetaEnvDefine, ...(t.define ?? {}) },
    minify: t.minify ?? false,
    logLevel: 'warning',
    target: 'node20',
  })
  console.log(`  built ${t.out}`)
}

const files = targets.map((t) => resolve(root, t.out))
console.log('==> 运行 node:test')
execFileSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
