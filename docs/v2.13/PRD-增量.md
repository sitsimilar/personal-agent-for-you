# 个人信息管家 · v2.13 增量 PRD

版本基线 **v2.12.2** ｜ 目标版本 **v2.13.0** ｜ 范围：仅 6 项（P0-1 / P1-3 / P1-4 / P1-1 / P0-2 / P1-2）｜ 不含市场调研与竞品分析
依据：`outputs/github-radar/2026-10-27/个人信息管家-GitHub资源日报-2026-10-27.md` 第 4、5 节；执行顺序按第 5 节结论。

---

## 1. 本次目标

**一句话**：把「能弹窗的提醒、只能字面搜索的记录、只有两组的待办、只出 AI 总结的回顾」这四处「已有但不好用」的能力补成可用形态——搜索从全表扫描变成走索引且支持多词，待办从两组分裂成三段并可按完成日续期，提醒可推迟一次，回顾有固定流程，日历能把待办导出成别的日历能认的文件。

- **不新增能力域**，不引入新依赖、不引入新服务端组件；全部改动落在现有 4 个页面（待办 / 回顾 / 日历 / 记录检索）+ 提醒调度链路内。
- 用户可感知变化：搜「周报 模板」能同时命中两词；待办页顶部一眼看到「今天 / 即将 / 某天」；通知弹过之后能点「稍后 10 分钟」；回顾页有一个 5 步向导而不是只有一个「生成」按钮；日历页多一个「导出 .ics」。

---

## 2. 范围与非范围

### 2.1 本期范围（6 项，按执行顺序编号）

| 编号 | 来源优先级 | 名称 | 涉及位置 | 成本 |
| --- | --- | --- | --- | --- |
| R1 | P0-1 | 记录检索走索引 + 多词命中 | `recordService.ts` + `docs/` 迁移 | 中 |
| R2 | P1-3 | 待办三段视图 Today / Upcoming / Someday | `TodoPage.tsx` | 低 |
| R3 | P1-4 | 循环任务「按完成日重复」 | `shared/types/domain.ts` + `lib/recurrence.ts` | 低 |
| R4 | P1-1 | 提醒「稍后」snooze | `reminderService.ts` + `lib/reminder-schedule.ts` | 低 |
| R5 | P0-2 | GTD 引导式周回顾向导（5 步） | `ReviewPage.tsx` + 新建向导组件 | 低 |
| R6 | P1-2 | 日历导出 .ics（VEVENT / VTODO） | 新建 `calendarService.ts` + `CalendarPage.tsx` | 中 |

### 2.2 非范围（本期明确不做，写清是为了防止范围蔓延）

| 不做 | 原因 |
| --- | --- |
| 全部 P2 项：插件 `skills[]` 技能声明、记忆分层 `memory_kind`/`fact_kind`、浏览器剪藏、RSS 订阅抓取、本地文档索引、思维树跨树引用 | 日报 §5 判定为 P2，本次按用户指示只做执行顺序内的 6 项 |
| **CalDAV 服务端**、日历双向同步、订阅 URL、`sync token` 增量同步 | R6 只做「单向导出文件」，不碰服务端与账号授权 |
| **语义向量检索**（含 ParadeDB 扩展、embedding） | 日报已列为 R1 的第 ③ 步，依赖云托管 PG 能否装扩展，本期不评估 |
| cron 表达式提醒（日报 P1-5）、跨时区提醒重构 | 不在本次执行顺序内；`remind_at` 现存 UTC 口径不动 |
| 循环规则在日历视图展开为多期实例、ICS 导出 `RRULE` | 导出只导出实体记录，不做规则展开 |
| 子任务与进度追踪、待办拖拽排序 | 日报未纳入本期优先级表 |
| 新增第三方依赖（分词库、日期库、iCalendar 库、cron 解析库） | 与既有约束一致（`recurrence.ts` 注释已声明零日期库）；.ics 手写文本拼接即可 |
| 版本号变更只到三处 `package.json` + `docs/版本说明.md` | 与既有发版习惯一致 |

---

## 3. 用户故事

| 编号 | 用户故事 |
| --- | --- |
| R1 | 作为记录攒了上千条的人，我希望搜索「周报 模板」时两个词都参与匹配、并且结果不卡顿，以便我不必靠回忆原话去猜关键词。 |
| R1 | 作为长期使用者，我希望搜索行为和以前一致（原来能搜到的现在还能搜到），以便升级后不用重新学习搜索习惯。 |
| R2 | 作为每天看板的人，我希望待办页顶部直接分成「今天 / 即将 / 某天」，以便我不用从上往下翻，一眼知道今天该干什么。 |
| R2 | 作为收藏型使用者，我希望能把「不知道什么时候做」的待办标成「某天」，以便它不污染今天的清单、但也不会丢掉。 |
| R3 | 作为习惯打卡的人，我希望「按完成日重复」——我今天晚了两天才完成，下一期就从今天算，以便节奏跟着我的实际行为走而不是越拖越偏。 |
| R4 | 作为开会中被提醒打断的人，我希望点「稍后 10 分钟」把这条提醒推后，以便它不消失、也不再当场烦我。 |
| R5 | 作为做周回顾的人，我希望有一个固定 5 步的向导带我走完「清收件箱 → 定下一步 → 等待中 → 项目体检 → 定下周焦点」，以便回顾不只是看一段 AI 总结。 |
| R5 | 作为回顾到一半被打断的人，我希望退出后能接着上次那一步继续，以便不用重走一遍。 |
| R6 | 作为同时用 Google 日历 / Outlook 的人，我希望把待办导出成 `.ics` 导进去，以便我在日历里看到它们的截止时间。 |

---

## 4. 需求池

> 优先级口径：P0 = 本期必须交付且阻塞发布；P1 = 本期交付，允许在 P0 完成后顺延一个小版本。
> 「验收」列均为可执行判定，落地时对应 `qa/*.test.ts` 用例并在 `qa/run-tests.mjs` 注册。

### R1（P0-1）记录检索：走索引 + 多词命中

| 项 | 内容 |
| --- | --- |
| 需求描述 | 现状：`recordService.applyKeyword()` 用 `query.or('title.ilike.%kw%,content.ilike.%kw%')` 做子串匹配，`docs/db-setup.sql` 只有 `records_tags_gin_idx`，无任何全文/三元组索引，记录量上去即全表扫描。本期：①为 `title`/`content` 建 `pg_trgm` 索引，使现有 `ILIKE '%kw%'` 走索引；②新增 generated `search_tsv` 列 + GIN 索引，支持空格分隔多词的 AND 语义；③`search()` / `searchCandidates()` 的 SQL 形态收敛到一个内部函数，两条路径共享。 |
| 边界 | 只改「关键词怎么匹配」，不改返回字段、排序语义（仍 `created_at DESC`）、分页、`LIMITS` 上限、`tags` 命中逻辑（`tags.cs.{kw}` 保留）。空关键词行为不变。不引入相关度排序（`ts_rank` 排序留待后续，本期结果仍按时间倒序）。 |
| 关键交互 | 无 UI 变化。用户在记录页 / 全局搜索框输入即可；输入含空格时按多词处理，单字/单词时行为与现状一致。搜索框不加任何新开关。 |
| 验收 | ①**性能**：迁移前先在 1 千、1 万条种子数据下记录基线 p50/p95（日报 §8 第 5 条要求）；迁移后同数据量 `search()` p95 < 200ms。②**多词**：入库标题「周报模板整理」与「周报 · 模板说明」两条，搜「周报 模板」两条都命中；搜「周报 不存在的词」返回 0 条（AND 生效）。③**回归**：`qa/recordService-crud.test.ts`、`qa/p0-c-domain-resolution-regression.test.ts` 全绿；`searchCandidates()` 对同一关键词的结果集合与迁移前一致（允许顺序差异）。④**中文兜底**：搜「周报」在内容为「今天写周报」的记录上仍命中（子串路径不可丢）。 |
| 风险与取舍 | ①**中文在 `simple` 配置下几乎不分词**：PG 默认 parser 把连续非 ASCII 字母当成一个 token，`to_tsvector('simple','今天写周报模板')` 只产生一个词元，因此 `tsvector` 路径**对无空格中文命中率接近 0**。结论：`pg_trgm` 的 `ILIKE` 是中文主力路径，`tsvector` 只服务英文与用户显式打空格的多词场景，**两者取并集（OR），不得用 `textSearch` 替换 `ilike`**。日报原建议「改成 `.textSearch()`」需修正为「保留 ilike + 叠加 tsvector」。②`pg_trgm` 是扩展：若云托管 PG 不允许 `CREATE EXTENSION`，退化方案为「只加 tsvector + 多词，中文维持现状」，此时性能验收降到 1 万条 p95 < 500ms 并显式告知用户。③`escapeLike()` 的转义规则在 tsvector 路径上不适用（`websearch_to_tsquery` 有自己的语法），需要单独的清洗函数，防止用户输入 `&`、`|`、`!` 触发语法错误。④三词以上、词长 < 2 的查询 `pg_trgm` 无法用索引（trigram 最小 3 字符），接受召回全表但受 `LIMITS.search` 上限保护。 |
| 成本 | 中（1 份迁移 SQL + 1 处 service 函数 + 2 处调用点 + 种子数据性能脚本） |

### R2（P1-3）待办三段视图：Today / Upcoming / Someday

| 项 | 内容 |
| --- | --- |
| 需求描述 | `TodoPage.tsx` 现只有 `pending` / `done` 两组（第 183–184 行 `filter`）。本期在**未完成区**顶部加三段切换：**今天**（`remind_at` 落在本地今日 00:00–23:59，或无 `remind_at` 但 `priority=high`）、**即将**（`remind_at` > 今日 24:00）、**某天**（`someday=true`，或 `remind_at` 为空且 `someday=false`）。已完成分组保持不变，仍在最下方独立展示。 |
| 边界 | 只做视图分段，**不改数据归属**：一条待办任何时刻只属于一段，不复制、不重复展示。`someday` 为新增用户显式标记，必须可撤销。不做拖拽在段间移动（用「某天」开关替代）。不做子任务进度。 |
| 关键交互 | ①分段用 MUI `ToggleButtonGroup`（与日历页月/周视图、回顾页范围选择同款），置于待办页筛选行、与「整理」按钮同一行右侧；每段按钮文案带计数，如「今天 8」。②待办卡片操作区新增「某天」图标按钮（`BookmarkBorderIcon` / 选中态 `BookmarkIcon`），点击即切换 `someday`，即时反馈、无需二次确认。③默认落在「今天」段。④三段都为空时给一句空态文案，不显示空白区块。 |
| 验收 | ①**计数守恒**：三段计数之和 = 未完成待办总数，且三段列表条数之和与计数一致（无重复、无遗漏）。②**互斥**：把一条今天到期的待办标记「某天」→ 它从「今天」消失、「某天」+1，总数不变。③**撤销**：再点一次「某天」→ 回到「今天」。④无 `remind_at` 且未标 `某天` 的待办出现在「即将」段（不消失）。⑤「已完成」段内容与 v2.12.2 一致（回归）。 |
| 风险与取舍 | ①**分页导致计数失真**：`TodoPage` 以 `TODO_PAGE_SIZE=200` 分页加载，用户待办 > 200 时前端只持有部分数据，三段计数会少于真实值。取舍：本期计数以「已加载集合」为准，并在加载未完成时于计数旁显示「已加载 N / 共 M」（M 取现有 `recordService.counts()` 的 `todoPending`）；若架构师认为不可接受，则改为 3 次服务端 head count（成本 +0.5 人日）。②与 `priority` 的关系做了隐式规则（无 `remind_at` 的高优先级算「今天」），这条规则是为避免「最该做的事反而沉到即将」；若产品上不接受，退化为纯 `remind_at` 判定。③日期边界按**本地日**判定（沿用 `recordService` 里已有的 `localDayKey` 口径），不接受 UTC 日，否则 08:00 前的待办会错段。 |
| 成本 | 低（1 个页面 + 1 个字段 + 1 处映射） |

### R3（P1-4）循环任务「按完成日重复」

| 项 | 内容 |
| --- | --- |
| 需求描述 | 现状 `RecurrenceRule`（`shared/types/domain.ts:16`）为 `freq` / `interval` / `weekdays` / `anchorDay` / `endDate`，`computeNext()` 永远以「上一期 `remind_at`」为基准推进。本期新增 `mode: 'due' \| 'completion'`，默认 `'due'`（保持旧行为）；`'completion'` 时以**完成时刻**为基准推进，`remind_at` 只决定「时分」。 |
| 边界 | 只加一个 JSONB 内键，**不改表结构、不加列**（`recurrence` 已是 JSONB）。不改 `endDate` 语义（仍按推进后的本地日比较）。不改完成链的父子关系与幂等（`recurrence_next_id` 逻辑不动）。不为历史数据回填 `mode`。 |
| 关键交互 | ①新建/编辑待办的「重复」区，在频率/间隔下方加一行单选：「从到期日算下一期（默认）」/「从完成那天算下一期」。②详情页循环描述文案跟随：`completion` 时展示为「每 2 天（按完成日）」，与现有 `describeRecurrence()` 输出风格一致。③已有循环待办打开编辑时默认选中「从到期日算」，不改变原规则。 |
| 验收 | ①**核心**：`mode='completion'`、`freq=daily`、`interval=2`，一条 `remind_at=今天 09:00` 的待办在**今天晚 2 天**（即实际完成日为今天+2）完成 → 新一期 `remind_at` = 完成日 + 2 天 09:00（时分取自原 `remind_at`）；`mode='due'` 同样场景 → 新一期 = 原 `remind_at` + 2 天，与 v2.12.2 完全一致。②`qa/recurrence.test.ts` 新增 `completion` 模式用例 ≥ 5 条（daily / weekly 含 `weekdays` / monthly 含 `anchorDay=31` 短月夹取 / 带 `endDate` 越界不生成 / `remind_at` 为空）。③旧数据（无 `mode` 键）走 `normalizeRecurrenceRule()` 后仍为 `due`，既有回归全绿。④完成时刻在 23:50 完成、原 `remind_at` 时分 09:00 时，新一期为 09:00 而非 23:50。 |
| 风险与取舍 | ①**「时分取谁」是隐含契约**：本期取原 `remind_at` 的时分（保持习惯类待办「早上 9 点提醒」的语义），代价是「当天完成太晚时下一期仍是早上」。若用户期望「完成时刻 + interval 的同一钟点」，需在 UI 上另做说明——列为待确认问题 4。②`completion` 模式下若 `remind_at` 为空，仅有完成时刻可用，按现有 `computeNext()` 的「无 remindAt 分支」返回 `null`，即下一期无提醒时间——需要在 UI 上提示，否则用户以为规则失效。③`weekly + completion` 时 `weekdays` 与「完成日 + N 周」可能冲突（例如选周一三五，但从周三完成算起），本期规则：`weekdays` 优先（沿用现有 `advanceWeekly` 逻辑），`mode` 只影响基准日。 |
| 成本 | 低（1 个类型 + 1 个归一函数 + 1 个分支 + 1 处 UI 单选） |

### R4（P1-1）提醒「稍后」snooze

| 项 | 内容 |
| --- | --- |
| 需求描述 | 现状 `reminderService` 弹出即写去重键 `dedupeKey(recordId, remindAt)`，之后同一条记录同一次 `remind_at` 永不再弹，无任何推迟手段。本期新增 `snooze(recordId, minutes)`：写入 `snoozed_until`，到期后重新弹一次，且同一记录可连续 snooze，每次都弹且只弹一次。 |
| 边界 | 仅对待办（`type='todo'` 且 `todo_status='pending'`）生效。snooze 选项固定三档：**10 分钟 / 30 分钟 / 1 小时**（都 < `STALE_MS` 12 小时，见风险 ①）。snooze **不改 `remind_at`**，只写 `snoozed_until`。snooze 不进入「已完成」、不影响循环推进。不做自定义分钟输入。 |
| 关键交互 | ①**通知本体仍只有「点击打开记录」**（原因见风险 ②）：点通知 → 打开该记录详情 → 详情底部出现操作条「稍后 10 分钟 / 30 分钟 / 1 小时」，同时右上角 toast 提示该条已提醒过。②应用内通知通道（降级态）的提示条上直接带「稍后 10 分钟」按钮，一步可达。③待办列表卡片上，`snoozed_until` 有值且未到期时显示一个「已推迟至 HH:mm」的 Chip。④snooze 后该记录在待办页不改变所属分段（仍算「今天」）。 |
| 验收 | ①**不重弹**：点「稍后 10 分钟」后 10 分钟内（覆盖 ≥ 20 个 30s tick）不再弹同一条。②**到期重弹且只弹一次**：第 10 分钟后的第一个 tick 重弹，之后继续 20 个 tick 内不再弹；去重键含 snooze 序号（如 `123\|2026-10-27T09:00:00.000Z\|snooze#1`）。③**连续**：连续 snooze 3 次，3 次都各自只弹一次，总弹次 = 4（首次 + 3 次重弹），无重复轰炸。④**跨重启**：snooze 后关闭应用、10 分钟内重开 → 不弹；超过 10 分钟重开 → 补弹一次（`snoozed_until` 已入库）。⑤**不影响其他**：snooze 一条不影响同日其他待办的正常弹窗；`qa/p0-a-reminder-service.test.ts`、`qa/p0-a-reminder-schedule-adversarial.test.ts` 回归全绿。 |
| 风险与取舍 | ①**与 `dedupeKey` / `pruneFired` 的冲突（必须处理）**：`pruneFired()` 用 `key.indexOf('\|')` 切出 ISO 再 `Date.parse()` 校验，直接把 `#snooze1` 拼在 ISO 后面会让 `Date.parse` 返回 `NaN`，该键在下一次写入时被**立即清理**，表现为「每 30s 弹一次」的轰炸。因此键结构改动必须同步改 `pruneFired` 的解析（按 `\|` 切三段，第三段单独解析）或把序号放进独立段，并在 `qa/` 加一条「snooze 键不被 prune 掉」的用例。②**通知动作按钮的现实约束**：`notification.ts` 三通道中，Web 的 `new Notification()` 不支持 `actions`（需 `ServiceWorkerRegistration.showNotification`），桌面 `new Notification` 在 Windows 下也不支持按钮（需 ToastXML）。所以「通知上直接点稍后」本期**不做**，走「点通知 → 详情页稍后」的两步路径。这不是取舍偏好，是平台硬约束；若必须一步到位，需引入 ServiceWorker 或第三方 Toast 库，属非范围。③**`STALE_MS` 边界**：`listReminderCandidates()` 按 `remind_at ∈ [now-12h, now+lead]` 拉候选，snooze 1 小时后 `remind_at` 已是 1 小时前，仍在窗内；但若做「明天再提醒」，`remind_at` 会早于 `now-12h` 而被 `shouldFire()` 判 `drop`。故本期上限 1 小时，`24h 内可 snooze` 需同时改候选窗口，列为非范围。④`clock` 回拨 / 系统时间跳变时 `snoozed_until` 可能落在过去，此时按「立即弹一次」处理，不累积。 |
| 成本 | 低（1 个 service 方法 + 1 个纯函数分支 + 2 处 UI + 1 列） |

### R5（P0-2）GTD 引导式周回顾向导（5 步）

| 项 | 内容 |
| --- | --- |
| 需求描述 | `ReviewPage.tsx` 现只有「选范围 → `aiService.generateReview(records)` → 展示总结与建议」。本期在页内新增向导入口，5 步固定流程：①**清空收件箱**（列出本周期内新增且无分类/无标签的记录，逐条分配或归档）→ ②**确定下一步行动**（为本周期涉及的项目/分类各补一条 `next_action`）→ ③**等待中 / 搁置**（列出被标记「某天」的待办与超期未完成的待办，逐条决定保留或删除）→ ④**项目健康检查**（`updated_at` 超 14 天的分类/记录标黄并提示）→ ⑤**下周三件事**（用户填 3 条焦点，落为新的高优先级待办）。走完后落 1 条 `type='note'` 的回顾记录，正文含 5 个小节标题。 |
| 边界 | **判定规则全部在前端本地完成**（超期、无分类、14 天未更新都是本地计算），AI 只做「摘要 + 建议」且**可整步失败**。不做项目实体（项目仍以 `category`/`tags` 近似）。不做周期自定义（固定按自然周，周一至周日）。不替代原有「AI 阶段总结」，两者并存：总结按钮保留，向导是新增入口。 |
| 关键交互 | ①`ReviewPage` 顶部卡片新增「开始周回顾（5 步）」按钮，与现有范围选择并列；已有进行中进度时按钮文案为「继续周回顾（第 3/5 步）」。②向导用 MUI `Dialog` 全屏（`fullScreen` on mobile，桌面 `maxWidth="md"`），顶部 `Stepper` 显示 5 步，底部「上一步 / 下一步 / 暂时离开」。③每步只做一件事，单步内列表可勾选处理；「下一步」始终可点（允许跳过），不强制清空。④「暂时离开」立即保存进度，再次进入从该步继续。⑤第 5 步完成 → 「生成回顾记录」→ 落库 → 跳回回顾页并展开该条记录。 |
| 验收 | ①**走完**：5 步可完整走完，落库恰好 1 条 `type='note'` 记录，正文含 5 个二级小节标题（清空收件箱 / 下一步行动 / 等待中 / 项目健康 / 下周焦点）。②**断点续**：走到第 3 步点「暂时离开」→ 关闭页面重新进入 → 按钮显示「继续（第 3/5 步）」且已填内容不丢（进度存 `settings`）。③**AI 失败不中断**：断网或 AI 报错时，5 步仍可全部走完、记录照常落库，仅「建议」区块显示「本次未能生成建议」。④**规则正确**：构造一条 `updated_at` 为 20 天前的记录 → 第 4 步标黄；构造一条今天新增且 `category` 与 `tags` 均空的记录 → 第 1 步出现。⑤**不重复**：同一天走两次向导产生 2 条记录（不合并），标题带日期便于区分。⑥「AI 阶段总结」原功能回归通过。 |
| 风险与取舍 | ①**进度存哪里**：`settings` 表单行存 JSONB（`float_position` 已有先例），跨端一致；但会与「设置」产生耦合，且并发两端同时走向导会互相覆盖。取舍：本期单端假设，进度带 `updatedAt`，读到时若超过 24h 则提示「上次回顾已过期，是否重新开始」。②**周期口径**：现有回顾页按 `created_at` 在区间内取记录（`listByRange`），新向导的「本周期新增」沿用同一口径，避免同一页出现两套日期语义。③**「等待中」与 R2 的 `someday` 重叠**：第 3 步读 `someday=true` 的待办；R2 未交付时该步为空集，向导仍需可用（空态 + 「跳过本步」）。这是 R5 排在 R2 之后的依赖原因，执行顺序已满足。④第 5 步落 3 条高优先级待办会改变待办总数，属预期副作用，需在完成提示里说明「已创建 3 条待办」。 |
| 成本 | 低（1 个新建组件 + 1 个入口 + 1 列 + 1 个 service 读写） |

### R6（P1-2）日历导出 .ics（VEVENT / VTODO）

| 项 | 内容 |
| --- | --- |
| 需求描述 | `CalendarPage.tsx` 现只有 `ViewMode='month' \| 'week'`，无任何 ICS 能力。本期新建 `web/src/services/calendarService.ts`，在浏览器端纯文本拼装 iCalendar 并触发下载，导出范围由用户在弹窗里选。**不引入服务端、不做订阅 URL**。 |
| 边界 | 只导出 `type='todo'` 的记录，其他类型（idea / material）本期不入 `.ics`。映射规则：每条待办出 1 个 `VTODO`（有 `remind_at` 时带 `DUE`，`todo_status` → `STATUS`：`pending`→`NEEDS-ACTION`、`done`→`COMPLETED`）；`remind_at` 非空的待办**额外**出 1 个 `VEVENT`（`DTSTART` 取 `remind_at`，`DURATION:PT30M`）。不导出 `RRULE`（循环规则不展开，见非范围）。不做往返导入、不做增量同步。 |
| 关键交互 | ①`CalendarPage` 顶部工具条（现为「月视图 / 周视图」+ 左右翻页 + 今天 + 刷新）末尾新增「导出 .ics」按钮（`FileDownloadOutlinedIcon`）。②点击弹小 `Dialog`：范围（当前月 / 当前周 / 全部，默认当前月）、是否包含已完成（默认不含）；底部「导出」。③确认后浏览器直接下载 `personal-agent-YYYYMMDD.ics`，并用 toast 提示「已导出 N 条（事件 M / 待办 K）」。④导出使用当前视图 `anchor` 与 `viewMode` 作为「当前月/周」的基准。⑤文件名与内容不含任何账号标识。 |
| 验收 | ①**可导入**：导出的 `.ics` 在 Google Calendar 与 Outlook 各成功导入一次（人工验证，记录截图到 `docs/v2.13/`）。②**UID 稳定**：同一记录二次导出 `UID` 完全相同（`record-{id}@personal-agent`），重复导入不产生重复事件。③**状态映射**：已完成待办导出为 `VTODO` 且 `STATUS=COMPLETED`；未完成导出 `STATUS=NEEDS-ACTION`。④**时区**：`DTSTART` / `DUE` 一律用 UTC 形式（`20261027T090000Z`），并带 `X-WR-TIMEZONE:Asia/Shanghai`；导入后在 UTC+8 环境显示为本地同一时刻（与待办页显示的提醒时间一致）。⑤**转义**：标题含 `,` `;` `\` 或换行时，导出内容按 RFC 5545 转义，导入后标题完整、不串行。⑥**空集**：范围内无待办时按钮禁用或提示「当前范围没有可导出的待办」，不下载空文件。 |
| 风险与取舍 | ①**导出语义与视图语义不一致**：日历页现有数据是**按 `created_at` 派生**的 `DayRecords`，而 `.ics` 的 `DTSTART`/`DUE` 用 `remind_at`。同一屏里「看到的位置」和「导出的时间」不是同一口径，容易让用户困惑。取舍：本期接受此差异（导出按钮的弹窗里用一句副标题说明「按提醒时间导出」），并把「日历视图按 `remind_at` 排布」列为后续需求，不在本期改。②**时区处理**：用 UTC 形式而非 `TZID` 形式，避免依赖日历端是否认识 `Asia/Shanghai`；代价是用户在别的时区导入会显示为对应本地时间（对跨时区用户其实是正确行为）。若产品要求「固定在东八区钟面」，需改 `TZID` + 内嵌 `VTIMEZONE`，成本翻倍——列待确认问题 5。③**循环待办只导 1 条**：带 `recurrence` 的待办导出后日历里不会重复出现，与待办页「完成一次生成下一期」的表现不一致；本期接受（导出是快照），并在弹窗说明。④**`DURATION` 固定 30 分钟**是拍脑袋默认，用户不可配；若被质疑，退化为「`VEVENT` 用 `DTSTART` + 30min」不变，仅调常量。⑤生成逻辑是纯函数（入参 `InfoRecord[]` → 字符串），必须可单测，不得在函数内读 `Date.now()`（`DTSTAMP` 由入参注入），否则测试不可重放。 |
| 成本 | 中（1 个 service + 1 个弹窗 + 1 个按钮 + 1 个测试文件） |

---

## 5. UI 设计要点（文字描述，不出图）

| 位置 | 新增控件 | 一致性要求 |
| --- | --- | --- |
| `TodoPage` 筛选行 | `ToggleButtonGroup` 三段（今天 / 即将 / 某天）+ 计数徽标 | 与 `CalendarPage` 第 175 行、`ReviewPage` 第 147 行的 `ToggleButtonGroup` 同款尺寸与形态（`size="small"`、`exclusive`）；计数用 `Typography` 内联，不用 `Badge`（避免与导航徽标混淆）。 |
| `TodoPage` 卡片操作区 | 「某天」图标按钮（`BookmarkBorderIcon` / `BookmarkIcon`）+ 「已推迟至 HH:mm」Chip | 图标按钮沿用现有卡片操作区 `IconButton size="small"`；Chip 用现有 `priorityColor` 同款 `size="small" variant="outlined"`，颜色取 `info`。 |
| `RecordDetail` 底部（由 R4 触发） | 操作条：稍后 10 分钟 / 30 分钟 / 1 小时 | 用 `ButtonGroup` + `size="small" variant="outlined"`，与详情页既有按钮组同宽；仅当 `type='todo'` 且 `todo_status='pending'` 时渲染。 |
| 应用内提示条（降级通道） | 「稍后 10 分钟」文字按钮 | `noticeStore` 现有提示条样式，不新增组件类型；按钮右对齐。 |
| `ReviewPage` 顶部卡片 | 「开始周回顾（5 步）」/「继续周回顾（第 N/5 步）」按钮 | 与同卡片内「自定义」范围按钮同一行右侧，`variant="contained"` 主操作色；已有进度时文案带步数。 |
| 周回顾向导 `Dialog` | `Stepper`（5 步）+ 单步内容区 + 底部三按钮 | 横向 `Stepper`，`alternativeLabel` 在桌面、竖排在 < 600px；按钮顺序「暂时离开（text）/ 上一步（outlined）/ 下一步（contained）」；AI 建议区用 `Alert severity="info"`，失败降级为 `severity="warning"` 一句话，不弹 `Dialog`。 |
| `CalendarPage` 工具条 | 「导出 .ics」按钮 | 放在现有工具条最右（刷新按钮右侧），`size="small" startIcon={<FileDownloadOutlinedIcon/>}`；导出弹窗用 `Dialog` + `FormControl` 两个（范围 / 含已完成），宽度 `maxWidth="xs"`。 |

统一约束：不新增自定义主题色，不引入新图标库（`@mui/icons-material` 已在用），不改变页面 `PageHeader` 结构，所有新文案中文、无英文兜底词。

---

## 6. 数据影响

> 迁移 SQL 落 `docs/v2.13/migration.sql`，并在 `docs/db-setup.sql` 末尾追加「增量迁移（v2.13）」段；**应用代码不执行 DDL**，线上由主理人手工执行。写法沿用 `docs/p0-2026-10/migration.sql`：纯增量、`IF NOT EXISTS`、幂等可重跑、不改既有 RLS 策略。

| 变更 | 名称（建议，**待架构师确认**） | 类型 / 默认 | 用途 | 旧数据兼容 |
| --- | --- | --- | --- | --- |
| `records` 新列 | `someday` | `BOOLEAN NOT NULL DEFAULT false` | R2「某天」显式标记 | 不回填，历史待办全部为 false（= 出现在今天/即将，与现状一致） |
| `records` 新列 | `snoozed_until` | `TIMESTAMPTZ`（可空） | R4 推迟到期时刻 | 空 = 未推迟，调度逻辑走原路径 |
| `records` 新列 | `snooze_count` | `INT NOT NULL DEFAULT 0` | R4 去重键序号，跨重启不丢 | 0 = 从未 snooze |
| `records` 新列 | `search_tsv` | `tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title,'') \|\| ' ' \|\| coalesce(content,''))) STORED` | R1 多词检索 | generated 列自动为存量行计算值，无需回填、无需写入代码 |
| `records` 新索引 | `records_title_trgm_idx` / `records_content_trgm_idx` | `USING GIN (title gin_trgm_ops)` / `(content gin_trgm_ops)` | R1 让现有 `ILIKE '%kw%'` 走索引 | 仅索引，无行为变化 |
| `records` 新索引 | `records_search_tsv_idx` | `USING GIN (search_tsv)` | R1 多词 | 同上 |
| `recurrence` JSONB 内新键 | `mode: 'due' \| 'completion'` | 缺省视为 `'due'` | R3 | **不需要 DDL**（JSONB 内加键），仅 `normalizeRecurrenceRule()` 归一 + 列注释更新 |
| `settings` 新列 | `review_wizard` | `JSONB`（可空） | R5 向导断点续 | 空 = 无进行中回顾；沿用 `float_position JSONB` 既有先例 |

类型同步三处（与 `docs/p0-2026-10/PRD-P0.md` §5 同规矩）：`shared/types/domain.ts`（`InfoRecord` / `RecordCreateInput` / `RecurrenceRule`）、`web/src/lib/database.types.ts`（`RecordsRow` / `SettingsRow`）、`web/src/services/recordService.ts`（`mapRecord` 与 `toSnake` 双向映射）。

兼容与回滚硬要求：

1. **新列全部可空或有默认值**，读取缺失一律按默认处理（`someday=false`、`snoozed_until=null`、`snooze_count=0`、`review_wizard=null`），旧行为不变。
2. **不回填、不搬迁数据**；`search_tsv` 是 generated 列，由 PG 自动计算，不产生一次性大更新。
3. **查询不按新列过滤**：`listRecords` / `counts` / `listByRange` 的既有查询条件一个都不加 `someday` 条件（否则旧界面会漏数），分段只在前端内存里做。
4. **回滚**：退代码后新列闲置；已有 `snoozed_until` 的记录退回后按普通提醒处理（可能多弹一次），`someday` 记录回到普通待办，`review_wizard` 进度丢弃，均无需数据清理。
5. **扩展依赖**：`CREATE EXTENSION IF NOT EXISTS pg_trgm` 需在迁移 SQL 顶部执行；若云库无权限，迁移文件必须提供「注释掉 trgm 段仍可执行」的分段结构，并在执行说明里写清取舍（见 R1 风险 ②）。
6. **不发新依赖**：`package.json` / `web/package.json` / `desktop/package.json` 只改 `version` 到 `2.13.0`，`dependencies` 零新增。

---

## 7. 待确认问题

| # | 问题 | 我的默认假设（不给答复即按此开工） | 需谁拍板 |
| --- | --- | --- | --- |
| 1 | **R1 的 `tsvector` 是否保留？** 中文在 `simple` 配置下基本不分词，`textSearch` 路径对中文命中率极低；日报原文的「改 `.textSearch()`」在中文场景不成立。 | 保留 `ilike` 为主路径 + `pg_trgm` 索引解决性能；`tsvector` 只叠加英文/显式空格多词的 OR 命中。若实测中文零收益，允许只交付 trgm 索引，tsvector 留列不用。 | 架构师 |
| 2 | **云托管 PG 能否 `CREATE EXTENSION pg_trgm`？** 若不能，R1 的性能验收标准要整体降档。 | 假设可装（trgm 属常见扩展）。执行前先在库上试跑 `CREATE EXTENSION IF NOT EXISTS pg_trgm` 确认。 | 架构师 / 主理人执行迁移时 |
| 3 | **R2 三段计数走服务端还是前端？** 分页 200/页导致前端计数可能少于真实值。 | 先按前端已加载集合计数 + 显示「已加载 N / 共 M」；若认为会误导用户，改服务端 3 次 head count（+0.5 人日）。 | 架构师 |
| 4 | **R3「按完成日重复」的新一期时分取谁？** 取原 `remind_at` 时分（保持「早 9 点提醒」）还是完成时刻时分？ | 取原 `remind_at` 时分；`remind_at` 为空时新一期无提醒时间并在 UI 提示。 | 用户 / 架构师 |
| 5 | **R6 的 `.ics` 时区形式：UTC（`...Z`）还是 `TZID=Asia/Shanghai` + 内嵌 `VTIMEZONE`？** | 用 UTC + `X-WR-TIMEZONE:Asia/Shanghai`（兼容性最好、实现成本最低）；不做 `VTIMEZONE`。 | 架构师 |
| 6 | **R4 是否必须「通知上直接点稍后」？** 平台硬约束下当前做不到（Web `new Notification` 无 `actions`；桌面 Windows `new Notification` 无按钮），需两步路径。 | 接受两步路径（点通知 → 详情页稍后）。若必须一步到位，需引入 ServiceWorker 或 Toast 库，属于新增依赖 + 跨版本改造。 | 用户 / 架构师 |
| 7 | **R4 的 `dedupeKey` 键结构改法**：把 snooze 序号拼进第三段（`id\|iso\|snooze#n`）还是放独立键前缀？两者都必须同步改 `pruneFired()` 的解析，否则键被立即清理导致 30s 一次轰炸。 | 用 `id\|iso\|snooze#n` 三段式，`pruneFired()` 按第一、二段解析时间、忽略第三段；同时补一条单测钉死「snooze 键不被 prune」。 | 架构师 |
| 8 | **R5 向导进度存 `settings` 还是 localStorage？** 前者跨端一致、与设置耦合；后者无服务端压力、但不跨端。 | 存 `settings.review_wizard`（JSONB，沿用 `float_position` 先例），带 `updatedAt`，超 24h 提示重新开始。 | 架构师 |
| 9 | **R1 是否保留 `ilike` 作为兜底？** 我的结论是**必须保留**（中文唯一可靠路径），但要确认产品能接受「检索是子串语义 + 多词 AND 的混合，而非相关度排序」。 | 保留 `ilike`；本期不做 `ts_rank` 排序，结果仍按 `created_at DESC`。 | 用户 / 架构师 |

---

## 8. 变更记录

- 2026-10-27：首版。基于 GitHub 资源日报（2026-10-27）§4/§5 的落地路线，按用户指示只做执行顺序内的 6 项；P2 六项与 CalDAV 服务端、语义向量检索全部列为非范围。
