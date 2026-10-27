# 个人信息管家 · v2.13 增量 · 独立测试报告（QA）

> 报告人：严过关（Yan）· QA 工程师
> 基线：v2.12.2 → v2.13.0（工作区改动，未 commit）
> 上游文档：`docs/v2.13/PRD-增量.md`、`docs/v2.13/DESIGN-增量.md`、`docs/v2.13/migration.sql`
> 结论速览：**功能与设计一致、可发布**；发现 **2 项中低severity + 3 项低 severity** 问题，均非阻塞（详见 §4、§5）。
> **我没有直接采信工程师的「615/615 全绿」**：先独立复跑基线确认一致，再新增 33 条针对性用例（含 7 个已知风险点）独立验证。

---

## 1. 环境与命令

| 项 | 内容 |
| --- | --- |
| 时间 | 2026-10-27（会话内） |
| 平台 | Windows / Git Bash，Node v22.22.2 |
| 项目根 | `D:\司凤项目\personal-agent` |
| 测试入口 | `node qa/run-tests.mjs`（自研 runner：esbuild bundle → `node --test`） |
| 类型检查 | `cd web && npm run typecheck`（`tsc --noEmit`） |
| 真库 | 主理人已执行 `docs/v2.13/migration.sql`；本报告只做**只读**查询（见 §3） |

实际执行与输出：

```text
# 1) 类型检查
$ cd web && npm run typecheck
> tsc --noEmit
（无任何错误，exit 0）

# 2) 基线复跑（未加我的用例前）
$ node qa/run-tests.mjs
1..615
# tests 615  # pass 615  # fail 0  # skipped 0
→ 与工程师声称的 615/615 完全一致（无差异）

# 3) 加入我的 33 条用例后
$ node qa/run-tests.mjs
1..648
# tests 648  # pass 648  # fail 0  # skipped 0  # todo 0
# duration_ms ≈ 6.2s

# 4) 类型检查（加入用例后重跑）
$ cd web && npm run typecheck
（仍无错误）
```

**若与工程师声称不符即报告差异** —— 本次无差异，基线可信。

---

## 2. 用例统计

| 维度 | 数量 |
| --- | --- |
| 基线用例总数（工程师交付） | 615 |
| 本次新增（QA 独立验证） | **33** |
| 合计 | 648 |
| 通过 / 失败 / 跳过 | 648 / 0 / 0 |
| 新增文件 | `qa/v213-qa-edge.test.ts`（已注册到 `qa/run-tests.mjs` 的 `targets`，`alias: webAlias`） |

新增用例分布（按功能）：

| 功能 | 新增条数 | 覆盖重点 |
| --- | --- | --- |
| R1 检索 | 6 | 中文 tsquery 必为 null、单条查询、混合词风险、单字词、`countTodoByStatus` 空数据/出错 |
| R2 三段 | 5 | someday 优先、本地日边界（ms 级）、时区注入生效、计数守恒+不复制、非法 remind_at |
| R3 循环 | 4 | due 不落键、completion 且 remind_at 空、提前完成、**service 链路不丢 mode**（含 due 对照） |
| R4 稍后 | 6 | pruneFired 非法键/不误删 snooze 键、effectiveFireAt 三种边界、同分钟多次 tick、旧两段键、无 remind_at |
| R5 向导 | 6 | 等待中并集去重、空白 category 口径、finish 幂等边界、焦点待办条数、TTL 边界、5 小节标题 |
| R6 ICS | 6 | 超长中文+emoji 折行、75/76 字节边界、转义顺序、二次导出 UID 稳定、无账号标识、源码守门 |

> 其中 6 条是「现状锁定」用例（断言当前真实行为并注明风险编号），用于把 M1/M2/L1/L3 钉成可回归的事实，不掩盖问题——每条都在标题里标了风险号与报告章节。

---

## 3. 六项功能逐项验收

### R1 记录检索走索引 + 多词命中

| 验收标准（PRD §4-R1） | 实测方式 | 结论 |
| --- | --- | --- |
| ② 多词：搜「周报 模板」两条都命中；「周报 不存在的词」返回 0 条（AND 生效） | 单测 `buildKeywordOrFilter` 产出 `and(or(title.ilike.%周报%,…),or(title.ilike.%模板%,…))`；`search()` 只发 1 条查询、无 `textSearch(` | 通过（AND 语义在**全中文/全 ASCII** 场景成立） |
| ②（补充，我方发现）**CJK + ASCII 混合**多词 | `search('周报 report')`：q2 只带 ASCII 子集 → 并集把「不含周报」的记录带回 | **不成立 → 见 M1** |
| ③ 回归：单关键词与 v2.12.2 同形 | 断言过滤器字面量 `title.ilike.%周报%,content.ilike.%周报%,tags.cs.{周报}`；与 `git show HEAD:` 的旧 `applyKeyword` 逐字比对一致（`escapeLike` 规则也一字未改） | 通过（零回归） |
| ④ 中文兜底：搜「周报」仍命中正文含「今天写周报」 | `buildTsQuery('周报')===null` → 只走 ilike；真库 `or=(...)` 与 `textSearch` 均 `err=null` | 通过 |
| 迁移未执行也能跑（`search_tsv` 不存在 42703） | 单测：q2 返回 `error.code=42703` → 静默只用 q1；真库控制组：查不存在列确实报 `DATABASE_42703` | 通过（降级路径真实有效） |
| ① 性能 1 万条 p95 < 200ms | 需要造 1 万条种子数据 = 写库 | **未覆盖**（纪律禁止写生产数据，见 §6） |

### R2 待办三段视图

| 验收标准 | 实测方式 | 结论 |
| --- | --- | --- |
| ① 计数守恒：三段之和 = 未完成总数；三段条数之和与计数一致 | 7 条混合集合（今天/逾期/high 无日期/低优先无日期/someday/字段缺失）：`today 3 + upcoming 3 + someday 1 = 7`；`splitByBucket` 并集 id 无重无漏 | 通过 |
| ② 互斥：今天到期标「某天」→ 从今天消失、某天 +1、总数不变 | 单测 + `set-someday` 后重新分段 | 通过 |
| ③ 撤销：再点一次回到「今天」 | `bucketTodo(someday=false)` 规则可逆；UI `toggleSomeday` 即时 `load(1)` | 通过（逻辑层；UI 未实测） |
| ④ 无 remind_at 且未标某天 → 「即将」 | `bucketTodo({remindAt:null,priority:'medium'})='upcoming'`；`someday:null` 按 false | 通过 |
| ⑤ 已完成段与 v2.12.2 一致 | 代码走查：`done` 分组仍独立渲染在页面最下方（`TodoPage.tsx:400`），不受分段影响 | 通过（走查） |
| 边界：本地日（非 UTC 日） | 同一 UTC 时刻在 tz=480 判 `upcoming`、tz=0 判 `today` → 证明按本地日；`23:59:59.999`→今天、`次日 00:00`→即将 | 通过 |
| PRD 未覆盖项：>200 条时分页计数失真 | 代码走查：「已加载 N / 共 M」提示存在（`TodoPage.tsx:304`），M 来自 2 次 head count | 通过（设计取舍已落实） |

### R3 循环「按完成日重复」

| 验收标准 | 实测方式 | 结论 |
| --- | --- | --- |
| ① completion：完成日 + interval，时分取原 remind_at | 纯函数：10-14 到期、10-12 完成 → 下一期 10-14 09:00；23:50 完成 → 新一期仍 09:00；**service 链路**（`completeTodoWithRecurrence`）：到期日=昨天、今天完成 → 下一期 = 完成日+2 天 09:00 | 通过（含 service 层，证明 `mode` 没被 service 丢掉） |
| ① due：与 v2.12.2 完全一致 | 同一 service 场景下 due → 原 `remind_at` + 2 天；纯函数 due 分支回归 | 通过 |
| ③ 旧数据（无 mode）走 due、normalize 后仍为 due | `normalizeRecurrenceRule({mode:'due'|'garbage'})` → **不落 mode 键**（`Object.hasOwn === false`） | 通过（JSONB 不被污染） |
| ④ 23:50 完成 → 新一期 09:00 而非 23:50 | 单测 | 通过 |
| completion 且 `remind_at` 为空 | `nextRemindIso=null`，`ruleEnded` 仅由 endDate 决定，不抛错 | 通过 |
| 待确认点 4（时分取谁） | 取原 `remind_at` 时分 —— 与 PRD 默认假设一致；**提前完成会早于原到期日**属设计后果，见 L5 | 通过（附说明） |

### R4 提醒「稍后」snooze

| 验收标准 | 实测方式 | 结论 |
| --- | --- | --- |
| ① 不重弹：snooze 后 10 分钟内不再弹 | 调度 tick + 假 localStorage：10:05 tick 不发 | 通过 |
| ② 到期重弹且只弹一次：键含 snooze 序号 | 10:10 弹 `id|iso|1`；随后同分钟 3 次 tick 不再弹 | 通过 |
| ③ 连续 3 次：总弹次 = 4 | 4 轮 × 每轮 3 次 tick（间隔 1s，模拟 30s 轮询+可见性补发）→ 恰好 4 次，键 `…|0..3` | 通过 |
| **风险①：snooze 键不被 `pruneFired` 误删** | `pruneFired` 后 token 0/1/3 与旧两段键全部留存；反证：旧写法 `slice(indexOf('|')+1)` 会得到 `remind_at|3` → `NaN` → 被清（即「30s 轰炸」成因） | 通过（守门断言钉死） |
| **风险①：非法键清理而非抛错** | 空 recordId / 缺段 / 空第二段 / 非 ISO 第二段 / 非数字时间戳 → 全部静默清理，只留合法键，不抛错 | 通过 |
| **风险②：旧两段键兼容不重弹** | localStorage 只放 `id|remind_at`（旧键）→ tick 后不弹；反之 token>0 时旧键不得挡住新一轮（否则推后再也弹不出来） | 通过（两个方向都测） |
| **风险②：`effectiveFireAt` 有 snoozed 不再减提前量** | lead=10/60 均直接返回 `snoozed_until`；`remind_at` 为空时返回 `snoozed_until` 而非 NaN；两者皆空 → NaN | 通过 |
| ④ 跨重启 | `snoozed_until`/`snooze_count` 已入库；键在 localStorage | 通过（逻辑层；未做真进程重启） |
| ⑤ 不影响其他待办 / p0-a 回归 | `qa/p0-a-*.test.ts` 全绿 | 通过 |
| 补充：`remind_at` 为空时 snooze | 永不弹 | **见 L1** |

### R5 GTD 周回顾向导

| 验收标准 | 实测方式 | 结论 |
| --- | --- | --- |
| ① 走完 5 步落 1 条记录、正文含 5 小节 | `buildReviewNoteBody` 断言 5 个 `##` 标题（含 AI 失败分支）；`finish` 落 `type='idea'` | 通过 |
| ⚠ `records.type` CHECK 只允许 idea/material/todo | `__dbInserts` 断言 `type === 'idea'` | 通过（符合 DESIGN §0-D4/§9-9 决议） |
| ③ AI 失败不阻断 | `suggest()` 吞异常返回 `failed=true`；`finish` 照常落库、正文写降级文案 | 通过 |
| ④ 规则正确：20 天未更新标黄 / 今天新增且无分类无标签进第 1 步 | `pickStaleCategories` 按分类内 `max(updatedAt)`；`pickInbox`；`pickWaiting` 并集去重 | 通过 |
| ⑤ 同一天走两次产生 2 条 | 分离会话 = 2 条（预期）；**但同一 progress 连调两次也落 2 条 → 见 M2** | 部分通过 |
| ⑥ AI 阶段总结回归 | 既有用例全绿 | 通过 |
| 第 2 步 next_action 不建待办（DESIGN §0-D4） | `finish` 只建 1 条回顾 + ≤3 条焦点待办，`nextActions` 仅进正文 | 通过 |
| 断点续（进度存 `settings.review_wizard`） | 单测：`save` 走 `profileService.save`（不直连 settings）、`load` 归一脏数据、`clear` 置空；真库确认 `settings.review_wizard` 列存在 | 通过（逻辑层） |

### R6 日历导出 .ics

| 验收标准 | 实测方式 | 结论 |
| --- | --- | --- |
| ② UID 稳定：`record-{id}@personal-agent` | 两次导出（不同 DTSTAMP）**除 DTSTAMP 外逐字节一致**；VEVENT 用 `record-{id}-event@` | 通过 |
| ③ 状态映射 | `pending→NEEDS-ACTION`、`done→COMPLETED`（带 `COMPLETED:` 时间） | 通过 |
| ④ 时区：UTC 形式 + `X-WR-TIMEZONE:Asia/Shanghai` | `toIcsUtc` 覆盖 `+08:00` 输入 → `…Z`；头部断言 | 通过 |
| ⑤ 转义：`,` `;` `\` 换行 | `icsEscape` 顺序（先 `\`）正确，且**折行后展开可完整还原**（不二次转义） | 通过 |
| ⑤ 折行：75 **字节**（非字符） | 120 字中文 + emoji 标题：每个物理行 ≤ 75 字节、续行以单空格开头、无裸 LF/CR、展开后 `SUMMARY:` 与转义原文完全一致、emoji 未被拆断；边界 75 不折 / 76 折 | 通过 |
| ⑥ 空集不下载 | `buildExport` 抛「当前范围没有可导出的待办」 | 通过 |
| 风险 ⑤：纯函数不读 `Date.now()` | 源码守门：**先剥注释再查**，且额外断言无「无参 `new Date()`」 | 通过（比工程师版本更严） |
| ① 可导入（Google/Outlook） | 需要人工在两端导入 | **未覆盖**（人工步骤，见 §6） |
| ⑤ 内容不含账号标识 | 断言除 `@personal-agent` 外无其它域名、无 `owner_id` | 通过 |

### 真库只读冒烟（`@tencent-ai/workbuddy-cloud-sdk`，未用 curl）

| 检查 | 结果 |
| --- | --- |
| `select someday,snoozed_until,snooze_count,search_tsv` | `err=null` → **4 个新列全部存在** |
| `or('and(or(..title.ilike..),or(..content.ilike..))')` 嵌套逻辑树 | `err=null` → DESIGN §9-1 风险已消除，第一级方案成立 |
| `textSearch('search_tsv','weekly',{websearch,simple})` | `err=null` → tsvector 叠加路径语法与列均可用 |
| `textSearch('search_tsv','weekly report')`（空格 AND） | `err=null` |
| `select count exact + todo_status=pending` | `count=0` → `countTodoByStatus` 走的是真实 count 通道，空库返回 0（不是 undefined） |
| `settings.review_wizard` | `err=null` → 列存在 |
| `remind_at` 区间 + `order/limit`（导出取数形态） | `err=null` |
| 控制组：查 `no_such_column_v213` | `DATABASE_42703` → 证明上面 7 条 `err=null` 不是 RLS/权限造成的假阳性 |

> 说明：匿名会话下 RLS 返回 0 行，因此上述只验证**结构/语法**，不验证真实数据的匹配语义与索引使用情况（`EXPLAIN` 无法经 PostgREST 执行）。

---

## 4. 问题清单（按严重度）

### M1 · 中 · R1「词间 AND」在 CJK+ASCII 混合查询下被并集破坏

- **位置**：`web/src/lib/search.ts:109-113`（`buildTsQuery` 只保留 ASCII 词）+ `web/src/services/recordService.ts:158-174`（q1 与 q2 按 id 并集）。
- **现象**：关键词 `周报 report` → q1 = 「同时含两词」；q2 用 `textSearch(search_tsv, 'report')` 只按 ASCII 子集查 → 并集把**不含「周报」**的记录带回。
- **最小复现**：`qa/v213-qa-edge.test.ts:156`（第 2 条查询只返回含 `report` 的行 → 最终结果含该行）。
  ```
  search('周报 report')  // q1=[] ; q2=[{id:9,title:'weekly report 归档'}] → 返回 [9]
  ```
- **与文档关系**：PRD §4-R1 验收② 要求「AND 生效」；DESIGN §1.1/§2-9 明确写的是「与 q1 结果按 id 并集合并」。**属设计层缺口**，实现忠于设计。
- **建议修法（一行收敛）**：`buildTsQuery` 仅在「**全部**词都通过 `isTsTerm`」时返回非 null（即 tsvector 查询不丢词），否则返回 null 只走 ilike。
- **影响面**：召回偏宽（假阳性），不会漏召回；全中文 / 全 ASCII 场景不受影响。

### M2 · 中低 · R5 `finish()` 幂等不完整（同一 progress 连调两次落 2 条回顾记录）

- **位置**：`web/src/services/reviewWizardService.ts:146-169`、调用方 `web/src/components/ReviewWizard.tsx:216-240`。
- **现象**：只在入口检查 `progress.completedRecordId != null`；落库后既不写 `completedAt`，也不把新 id 回写到 progress（DESIGN §1.5 要求「前后各校验一次」）。UI 也没回写。
- **最小复现**：`qa/v213-qa-edge.test.ts:626`（同一 progress 调两次 → `__dbInserts` 里 2 条 `type='idea'`）。
- **真实触发路径**：回顾记录已创建 → 紧接着创建焦点待办失败（网络抖动）→ `finish` 抛错、进度不清空 → 用户再点「生成回顾记录」→ 第二条回顾记录。
- **缓解因素**：UI 的 `busy` 状态挡住了普通双击；正常路径下不出现。
- **建议修法**：`finish` 内 `progress.completedRecordId = created.id`（或先写 `completedAt` 占位）再建焦点待办，失败重试时即命中幂等分支。

### L1 · 低 · R4 对「无提醒时间」的待办点「稍后」是空操作

- **位置**：`web/src/services/reminderService.ts:364-372`（`snooze()` 未校验 `remindAt`）、`:189`（`handleCandidate` 对 `!record.remindAt` 直接 return）；且 `listReminderCandidates` 按 `remind_at` 区间取数，该类记录永远不会成为候选。
- **现象**：用户对没有提醒时间的待办点「稍后 10 分钟」→ 写入 `snoozed_until`、Chip 显示「已推迟至 …」→ 永远不会再弹，且 Chip 长期残留（叠加 L2）。
- **建议**：`SnoozeActions` 在 `!record.remindAt` 时不渲染该按钮组（或 `snooze()` 明确抛「该待办没有提醒时间」）。

### L2 · 低 · R2/R4「已推迟至」Chip 未判是否未到期（与 PRD 关键交互③不符）

- **位置**：`web/src/pages/TodoPage.tsx:366`（`{r.snoozedUntil && …}`）。
- **PRD 原文**：R4 关键交互 ③「`snoozed_until` 有值**且未到期**时显示一个「已推迟至 HH:mm」的 Chip」。
- **现象**：snooze 到期后 `snoozed_until` 仍在库里（只有完成/改 `remind_at` 才复位），Chip 会长期显示「已推迟至 09:10」而时间早已过去。
- **建议一行修**：`{r.snoozedUntil && Date.parse(r.snoozedUntil) > nowMs && (…)}`（`nowMs` 已是页面 state）。

### L3 · 信息级 · R5 空白 `category` 记录两步都看不到

- **位置**：`web/src/lib/review-wizard.ts:232`（`!r.category`，`'   '` 为 truthy → 不进收件箱）vs `pickCategories`（trim 后跳过空串）。
- **影响**：category 为纯空白的记录既不在第 1 步「收件箱」也不在第 2 步「分类清单」。
- **实际风险极低**：写入路径（`toSnake`/`createRecord`）存 `''` 或 `null`，纯空白值不会产生。

### L4 · 信息级 · R1 超过 5 个词时静默截断

- `splitTerms` 上限 `MAX_TERMS=5`，第 6 个词起被丢弃（AND 语义随之放宽）。有 `LIMITS.search` 兜底，属可接受的防爆策略，仅记录。

### L5 · 信息级 · R3 completion 模式「提前完成」会让新一期早于原到期日

- 原到期 10-14，若 10-10 就完成 → 新一期 10-12（早于原到期 10-14）。这是「基准日取完成日」的必然结果（PRD §4-R3 的核心语义），但与直觉可能不符，建议在 UI 文案或版本说明里点一句。

---

## 5. 智能路由判定

| 判定 | 内容 |
| --- | --- |
| **Engineer（小改，非阻塞）** | M1（一行收敛 `buildTsQuery`，需架构确认「按设计接受」还是修）、M2（`finish` 回写 `completedRecordId`）、L2（Chip 加 `> nowMs` 判断）。L1 建议同批处理（SnoozeActions 隐藏/禁用）。 |
| **QA（我自己）** | 1 处：我最初把「焦点待办条数」断言写成 3 条（实际是「过滤空白后仍剩 3 条 + slice(0,3)」= 3 条待办 + 1 条回顾 = 4 次插入），已按真实行为修正断言，非源码问题。 |
| **NoOne（无需处理）** | 其余全部：648/648 通过，L3/L4/L5 仅记录。 |
| 阻塞发布? | **否**。M1 是召回偏宽（假阳性）、M2 需要「创建焦点待办失败 + 用户重试」才触发、L2 是展示文案长期残留。三者都不产生数据丢失或功能不可用。 |

---

## 6. 未覆盖项与原因

| 未覆盖 | 原因 | 建议由谁做 |
| --- | --- | --- |
| R1 性能验收（1 千 / 1 万条 p95 与 `EXPLAIN` 索引命中） | 需要写 1 万条种子数据；本次纪律明确「不写生产数据、不执行 DDL」，PostgREST 也无法执行 `EXPLAIN` | 主理人在隔离库或用本地 PG 复现 |
| `.ics` 在 Google Calendar / Outlook 各导入一次 | 需人工账号操作 | 主理人（PRD 要求截图存 `docs/v2.13/`） |
| 真库数据的多词命中语义 / 索引命中 | 匿名会话 RLS 返回 0 行，只能验结构与语法 | 有真实数据的登录态环境 |
| UI 交互实测（三段切换、向导弹窗、导出弹窗、Toast、Chip 位置） | `qa/` 是纯 Node 环境，无 React 渲染栈（无 jsdom/RTL，未引入新依赖） | 只做了静态代码走查（控件、文案、disabled 条件、计数来源均已核对存在） |
| 跨进程重启补弹、系统时间回拨实测 | 需要真实进程/时钟跳变 | 手动验收（逻辑已单测覆盖） |
| pg_trgm 是否真的被规划器使用 | 同第 1 行 | 本次报告无法判定，**不能声称「已走索引」** |

---

## 7. 附：本次新增用例清单（`qa/v213-qa-edge.test.ts`）

```text
R1 中文（含多词）tsquery 必为 null
R1 search("周报 模板") 只发 1 条查询、无 textSearch(
R1 [现状锁定·M1] CJK+ASCII 混合词：tsvector 叠加只带 ASCII 子集 → 并集破坏 AND
R1 单字/两字中文不触发 tsvector 第二条查询
R1 countTodoByStatus 无数据返回 0（count=null）
R1 countTodoByStatus 出错时抛错（不静默返回 0）
R2 someday 优先于 high 与今日到期
R2 本地日边界：23:59:59.999 → 今天；次日 00:00 → 即将
R2 同一时刻换时区即换段（证明本地日口径）
R2 混合集合三段计数守恒 + splitByBucket 不复制不遗漏
R2 非法 remind_at 兜底不抛错
R3 due/非法 mode 归一后不留键
R3 completion 且 remind_at 为空 → 无提醒时间；endDate 已过 → ruleEnded
R3 [现状锁定] completion 提前完成 → 新一期可早于原到期日（L5）
R3 service 链路不丢 mode（completion vs due 对照）
R4 pruneFired 清理非法键而不抛错
R4 pruneFired 不误删 snooze 键（token 0/1/3 + 旧两段键）
R4 effectiveFireAt：snoozed 优先且不减提前量 / remind_at 空 / 双空
R4 连续 3 次 snooze、同分钟多次 tick → 总弹次 4、键全留存
R4 升级兼容：localStorage 只有旧两段键时不重弹
R4 [现状锁定·L1] remind_at 空 + snoozed_until 有值 → 永不弹
R5 pickWaiting 并集去重
R5 [现状锁定·L3] 空白 category 两步都看不到
R5 [现状锁定·M2] finish 幂等只在 completedRecordId 已存在时生效
R5 finish 只按非空焦点建待办（≤3 条）+ 第 2 步不建待办
R5 进度过期边界：恰好 24h 不过期 / 跨周过期 / 非法 updatedAt
R5 回顾正文始终含 5 个二级标题（含 AI 失败）
R6 超长中文+emoji 标题：≤75 字节/行、无裸 LF、展开无损、emoji 不拆断
R6 foldLine 边界：75 不折 / 76 折且续行含前导空格 / 中文 25 字 vs 26 字
R6 转义顺序在折行后可还原
R6 二次导出除 DTSTAMP 外逐字节一致（UID 稳定）
R6 导出内容不含账号标识（仅 @personal-agent）
R6 源码守门：ics.ts 无 Date.now() 且无无参 new Date()
```

---

## 8. 结论

1. **工程师的「615/615 全绿」经独立复跑确认成立**，类型检查零错误；我新增 33 条后为 **648/648**。
2. 6 项功能的**可测部分全部符合设计与 PRD 验收**；7 个已知风险点中，`pruneFired` 误删 snooze 键、旧两段键兼容、`effectiveFireAt` 二次提前、中文 tsquery 必须为 null、三段互斥完备、completion 基准日、ICS 75 字节折行/CRLF/转义/UID 稳定 **全部实测通过**（含真库结构冒烟）。
3. 新发现 1 项中（M1，设计层缺口）、1 项中低（M2，幂等不完整）、3 项低/信息级，**均不阻塞发布**，建议作为 v2.13.1 的小修一并处理（合计约 20 行以内）。
4. **我认为最脆弱的一处**：`buildTsQuery` 的「部分词进入 tsvector 路径」（M1）。它的危险在于**静默**——全中文和全英文搜索都正常，只有「中英混搜」时才悄悄放宽 AND 语义，回归测试和人工验收都极容易漏过；而它恰好落在本次最高优先级（P0-1）的验收条款上。其次脆弱的是 M2 的 `finish` 幂等，因为它依赖调用方契约、单测很容易写成「已存在的 completedRecordId」这种过于友好的前置条件（工程师原用例正是如此）。
