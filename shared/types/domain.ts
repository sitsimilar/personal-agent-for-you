/**
 * 领域类型（跨端共享，唯一事实来源）。
 *
 * 注意：领域类型使用 camelCase，而云数据库列使用 snake_case，
 * 二者在 web/src/services/* 中进行映射转换。
 */

export type RecordType = 'idea' | 'material' | 'todo'
export type TodoStatus = 'pending' | 'done'
export type Priority = 'high' | 'medium' | 'low'

/** 循环频率：每天 / 每周 / 每月。 */
export type RecurrenceFreq = 'daily' | 'weekly' | 'monthly'

/** 下一期基准日：按到期日（默认，旧行为）/ 按完成日。 */
export type RecurrenceMode = 'due' | 'completion'

/** 待办循环规则（JSONB 存储，内部键为 camelCase）。 */
export interface RecurrenceRule {
  freq: RecurrenceFreq
  /** 间隔，1..99。 */
  interval: number
  /** 0=周日 … 6=周六，仅 weekly 使用；升序去重。 */
  weekdays?: number[]
  /** 锚定日号 1–31，仅 monthly 使用：短月夹取到月末，但后续期次回到该日（避免逐月漂移）。 */
  anchorDay?: number | null
  /** 'YYYY-MM-DD' 本地日，含当日；null/空表示无限。 */
  endDate?: string | null
  /**
   * v2.13 R3：下一期基准日。
   * 缺省（或非法值）= `'due'`，即按上一期 `remind_at` 推进（旧行为）；
   * `'completion'` = 以完成日为基准推进，时分仍取原 `remind_at` 的本地时分。
   */
  mode?: RecurrenceMode
}

/** 链接元数据（P0-C，由服务端代理抓取后回写）。 */
export interface LinkMeta {
  title?: string | null
  description?: string | null
  image?: string | null
  site?: string | null
  fetchedAt?: string
  status: 'ok' | 'failed'
  errorCode?: string
  /**
   * v2.14 P0-3：订阅条目的外部稳定标识（= `records.external_uid`）。
   * 订阅条目也复用 `linkMeta` 报外链身份：条目来自哪条链接、原始 guid/link 是什么，
   * 与 `recordMeta` 自解释的字段保持同一份值，便于只看一列就能追溯来源。
   */
  externalUid?: string | null
  /**
   * v2.14 P0-3：归属订阅源 id（`settings.feeds[].id`）。
   * 手写记录与 .ics 导入不填；订阅条目的 `status` 固定为 `'ok'`
   * （抓取成功才会产出条目，失败根本没有记录可写）。
   */
  feedId?: string | null
}

/**
 * 正文派生状态 / 导入来源等元数据（JSONB 桶，存 `records.record_meta`）。
 *
 * 与 `LinkMeta` 分工：链接抓取结果（标题/摘要/站点）在 `linkMeta`，
 * 这里只放"这条记录从哪来、原文还留了哪些结构化信息"，两者互不重叠。
 * 全部字段可选：迁移未执行 / 旧数据 / 手写记录都可能是空对象。
 */
export interface RecordMeta {
  /** 来源标识：`'ics-import'`（.ics 导入）| `'feed'`（订阅抓取）。 */
  source?: string
  /** 外部系统稳定标识（与 `externalUid` 同值，冗余一份便于 JSON 内自解释）。 */
  externalUid?: string
  /** iCalendar 组件类型。 */
  icsKind?: 'event' | 'todo' | 'journal'
  /** 循环规则原文（已去 `RRULE:` 前缀，如 `FREQ=WEEKLY;COUNT=6`）。 */
  rrule?: string
  /** 循环例外时刻（UTC ISO 列表）。 */
  exdates?: string[]
  /** `COMPLETED` 时刻（UTC ISO）。 */
  completedAt?: string
  /** 原始 `DTSTART`（UTC ISO）；笔记只记录不排期。 */
  dtstart?: string
  /** 导入时刻（UTC ISO，由 service 注入）。 */
  importedAt?: string
  /**
   * v2.14 P0-3：归属订阅源 id（`settings.feeds[].id`）。
   * 只有 `source === 'feed'` 的记录才会写；用户删掉该订阅后这里仍保留，便于回溯"这条从哪来"。
   */
  feedId?: string
  /** v2.14 P0-3：抓取时该订阅的显示标题（订阅改名后历史记录仍保留当时的名字）。 */
  feedTitle?: string
  /** v2.14 P0-3：源站声明的 guid 原文（无 guid 的源为 null）。 */
  guid?: string | null
  /** v2.14 P0-3：条目发布时间（UTC ISO；源站没给时间或不可解析为 null）。 */
  publishedAt?: string | null
}

/** 信息记录主表（统一存放想法/资料/待办）。 */
export interface InfoRecord {
  id: number
  type: RecordType
  title: string
  content: string
  url?: string | null
  /** 云存储对象路径。 */
  filePath?: string | null
  category?: string | null
  tags: string[]
  summary?: string | null
  todoStatus?: TodoStatus | null
  priority?: Priority | null
  remindAt?: string | null
  /** 循环规则（无循环为 null）。 */
  recurrence?: RecurrenceRule | null
  /** 循环链根记录 id（根记录为 null）。 */
  recurrenceParentId?: number | null
  /** 由本条生成的下一期记录 id。 */
  recurrenceNextId?: number | null
  /** 链接元数据（无则 null）。 */
  linkMeta?: LinkMeta | null
  /**
   * v2.13 R2：待办「某天」显式标记。
   * 可选 + 可空是为了兼容「迁移未执行」与旧数据（缺失一律按 false 处理）。
   */
  someday?: boolean | null
  /** v2.13 R4：稍后提醒的到期时刻（ISO UTC），空 = 未推迟；不改 `remindAt`。 */
  snoozedUntil?: string | null
  /** v2.13 R4：已 snooze 次数（去重键第三段），缺失按 0 处理。 */
  snoozeCount?: number
  /**
   * v2.14：外部系统稳定标识（.ics 导入的查重键）。
   * 可选 + 可空以兼容「迁移未执行」与手写记录（缺失一律按 null 处理）。
   */
  externalUid?: string | null
  /** v2.14：正文派生元数据（迁移未执行 / 脏数据一律 null）。 */
  recordMeta?: RecordMeta | null
  /**
   * v2.14 P0-2：父记录 id（自引用）。当前用于 .ics 的 `RELATED-TO;RELTYPE=PARENT`，
   * 即"这条待办属于哪个父任务"。与 `recurrenceParentId`（循环链根，由系统生成）语义不同，
   * 不可互相替代。可选 + 可空以兼容「迁移未执行」与手写记录。
   */
  parentId?: number | null
  isDeleted: boolean
  deletedAt?: string | null
  createdAt: string
  updatedAt: string
}

/** 智能关联（记录 ↔ 记录）。 */
export interface RecordLink {
  id: number
  sourceId: number
  targetId: number
  score: number
  reason?: string | null
}

/** 代码分析问题条目。 */
export interface CodeIssue {
  severity: 'error' | 'warning' | 'suggestion'
  title: string
  description: string
  suggestion: string
  /** 大白话版标题（面向普通用户，与 title 内容一致、仅表达风格不同）。 */
  titlePlain?: string
  /** 大白话版描述。 */
  descriptionPlain?: string
  /** 大白话版建议。 */
  suggestionPlain?: string
  file?: string
  line?: number
}

/** 用户设置（云端共享，跨端一致）。 */
export interface UserSettings {
  vsPath?: string | null
  codeUploadEnabled: boolean
  floatWindowEnabled: boolean
  floatPosition?: unknown
  notifyEnabled: boolean
  /** 提醒提前量（分钟）：0/5/10/15/30/60。 */
  remindLeadMinutes: number
  /** 免打扰开关。 */
  quietHoursEnabled: boolean
  /** 免打扰起始（本地墙钟 HH:mm）。 */
  quietStart: string
  /** 免打扰结束（本地墙钟 HH:mm），可跨零点。 */
  quietEnd: string
  /** v2.13 R5 周回顾向导断点续进度（空 = 无进行中回顾）。 */
  reviewWizard?: ReviewWizardProgress | null
}

/** 新建记录入参。 */
export interface RecordCreateInput {
  type: RecordType
  title?: string
  content?: string
  url?: string | null
  filePath?: string | null
  category?: string | null
  tags?: string[]
  todoStatus?: TodoStatus | null
  priority?: Priority | null
  remindAt?: string | null
  /** 循环规则（仅待办使用）。 */
  recurrence?: RecurrenceRule | null
  /** 循环链根记录 id（生成下一期时传入）。 */
  recurrenceParentId?: number | null
  /** v2.13 R2：「某天」显式标记（缺省由数据库默认 false 填充）。 */
  someday?: boolean | null
  /** v2.13 R4：稍后提醒到期时刻（ISO UTC）。 */
  snoozedUntil?: string | null
  /** v2.13 R4：snooze 次数（去重键第三段）。 */
  snoozeCount?: number
  /** v2.14：外部系统稳定标识（.ics 导入时传入，手写记录不传）。 */
  externalUid?: string | null
  /** v2.14：正文派生元数据（导入来源等）。 */
  recordMeta?: RecordMeta | null
  /** v2.14 P0-2：父记录 id（.ics `RELATED-TO;RELTYPE=PARENT` 回填用，手写记录不传）。 */
  parentId?: number | null
}

/** 记录列表筛选条件。 */
export interface RecordListFilter {
  type?: RecordType
  category?: string
  keyword?: string
  page?: number
  pageSize?: number
  /** 默认查询未删除记录；回收站传 true。 */
  isDeleted?: boolean
}

/** 记录分页结果。 */
export interface RecordListResult {
  records: InfoRecord[]
  total: number
}

/**
 * v2.13 R2：待办三段视图的分段标识。
 * 三值互斥且完备（每条未完成待办恰好属于且只属于一段）。
 */
export type TodoBucket = 'today' | 'upcoming' | 'someday'

/** v2.13 R2：三段计数（`total` 恒等于传入集合条数，可单测守恒）。 */
export interface TodoBucketCounts {
  today: number
  upcoming: number
  someday: number
  total: number
}

/* ------------------------- v2.13 R5 周回顾向导 ------------------------- */

/** 向导步骤号（1..5）。 */
export type ReviewWizardStep = 1 | 2 | 3 | 4 | 5

/** 向导第 1 步单条记录的处理决定。 */
export interface ReviewWizardInboxItem {
  recordId: number
  /** assign = 归到某分类；archive = 归档（保持无分类）；skip = 暂不处理。 */
  decision: 'assign' | 'archive' | 'skip'
  category?: string | null
}

/** 向导第 2 步「下一步行动」（只写进回顾正文，不创建待办）。 */
export interface ReviewWizardNextAction {
  /** 所属分类（本项目以 category 近似「项目」）。 */
  category: string
  text: string
}

/** 向导第 3 步「等待中」的处理决定。 */
export interface ReviewWizardWaitingItem {
  recordId: number
  decision: 'keep' | 'delete' | 'skip'
}

/** 向导第 4 步「项目健康」确认项。 */
export interface ReviewWizardHealthItem {
  category: string
  /** 用户是否已确认「知道它搁置了」。 */
  acknowledged: boolean
}

/**
 * 向导进度（存 `settings.review_wizard`，JSONB）。
 * `weekStart` 用于跨周失效；`updatedAt` 用于 24h 过期判定；`completedAt` 用于落库幂等。
 */
export interface ReviewWizardProgress {
  version: 1
  step: ReviewWizardStep
  /** 本周一的本地日 'YYYY-MM-DD'。 */
  weekStart: string
  startedAt: string
  updatedAt: string
  completedAt?: string | null
  completedRecordId?: number | null
  inbox: ReviewWizardInboxItem[]
  nextActions: ReviewWizardNextAction[]
  waiting: ReviewWizardWaitingItem[]
  health: ReviewWizardHealthItem[]
  /** 下周三件事（最多 3 条，空串表示未填）。 */
  focus: string[]
  aiFailed?: boolean
}

/* ------------------------- v2.13 R6 .ics 导出 ------------------------- */

/** .ics 导出范围：当前月 / 当前周 / 全部。 */
export type IcsRange = 'month' | 'week' | 'all'

/** 关联打分结果（LLM 输出）。 */
export interface RelateResultItem {
  targetId: number
  score: number
  reason?: string
}

/** 选区分析问题类别。 */
export type SelectionIssueCategory = 'syntax' | 'defect' | 'style'

/** 选区分析问题条目。 */
export interface SelectionIssue {
  category: SelectionIssueCategory
  title: string
  description: string
  suggestion: string
  line?: number
  snippet?: string
}

/** 选区分析结果。 */
export interface SelectionAnalysisResult {
  summary: string
  issues: SelectionIssue[]
}

/** 后续行动建议项（R-16）。 */
export interface ActionItem {
  title: string
  detail?: string
  priority?: Priority
}

/** 阶段回顾结果（R-15 + R-16 合并）。 */
export interface ReviewResult {
  summary: string
  actions: ActionItem[]
}

/** 重点提取的关键点（R-17）。 */
export interface KeyPoint {
  point: string
  detail?: string
}

/** 待办合并分组（R-18）。 */
export interface TodoMergeGroup {
  keep: string
  merge: string[]
}

/** 待办整理后的排序项（R-18）。 */
export interface TodoOrganizeItem {
  title: string
  priority: Priority
}

/** 待办整理结果（R-18）。 */
export interface TodoOrganizeResult {
  summary: string
  mergeGroups: TodoMergeGroup[]
  ordered: TodoOrganizeItem[]
}

/** 速查库条目类别：关键字 / 运算符 / 函数 / 语法结构。 */
export type CheatCategory = 'keyword' | 'operator' | 'function' | 'syntax'

/** C++ 速查库条目类别：基础语法 / 标准库组件与容器 / STL 算法 / 内存与智能指针 / 移动语义 / Lambda / 模板泛型 / 并发多线程 / 现代 C++ 特性 / 标准库函数 / 常见陷阱。 */
export type CppCheatCategory =
  | 'syntax'
  | 'stl'
  | 'algorithm'
  | 'memory'
  | 'move'
  | 'lambda'
  | 'template'
  | 'concurrency'
  | 'modern'
  | 'function'
  | 'pitfall'

/** 速查库单条条目（结构化，便于维护与扩展）。 */
export interface CheatEntry {
  /** 唯一标识（稳定，勿改动）。 */
  id: string
  /** 名称（关键字/运算符/函数名/语法名）。 */
  name: string
  category: CheatCategory
  /** 用途说明。 */
  description: string
  /** 语法格式。 */
  syntax: string
  /** 使用示例。 */
  example: string
  /** 常见注意事项 / 易错点（可选）。 */
  notes?: string
  /** 附加搜索关键词（可选）。 */
  tags?: string[]
}

/** C++ 速查库单条条目（与 CheatEntry 同构，类别语义不同）。 */
export interface CppCheatEntry {
  /** 唯一标识（稳定，勿改动）。 */
  id: string
  /** 名称（语法/库/算法/概念/函数名）。 */
  name: string
  category: CppCheatCategory
  /** 用途说明。 */
  description: string
  /** 语法格式（或函数签名 / 引入方式）。 */
  syntax: string
  /** 使用示例。 */
  example: string
  /** 常见注意事项 / 易错点（可选）。 */
  notes?: string
  /** 附加搜索关键词（可选）。 */
  tags?: string[]
  /** 所在头文件（可选，如 <iomanip>）。 */
  header?: string
  /** 参数含义说明（可选）。 */
  params?: string
  /** 返回值说明（可选）。 */
  returns?: string
}

/** 思维树维度 key。 */
export type MindTreeDimensionKey = 'concept' | 'premise' | 'feasibility' | 'counter' | 'action'

/** 思维树单个维度（一个分支窗口）。 */
export interface MindTreeDimension {
  key: string
  label: string
  questions: string[]
}

/** 思维树分支生成结果（AI 输出）。 */
export interface MindTreeGenerateResult {
  dimensions: MindTreeDimension[]
}

/** 思维树节点（根/分支/思考点通用）。 */
export interface MindTreeNode {
  id: string
  text: string
  /** 所属维度 key（concept/premise/...，根的直接子节点与延伸子节点用；展示时经 dimensionLabel 转换）。 */
  dimension?: string
  collapsed: boolean
  /** 是否正在生成子分支。 */
  loading: boolean
  children: MindTreeNode[]
  /** 节点备注（可编辑文本，仅本地持久化）。 */
  note?: string
}

/** 思维树（单棵）：name 即主题/标题（原单树文档的 topic 字段已并入 name）。 */
export interface MindTree {
  id: string
  name: string
  root: MindTreeNode
  createdAt: string
  updatedAt: string
}

/** 思维树林：多棵思维树的组群（仅引用 treeId，树本体独立发展）。 */
export interface MindForest {
  id: string
  /** 用户自定义名称。 */
  name: string
  treeIds: string[]
  createdAt: string
  updatedAt: string
}

/** 交叉节点定位（跨树端点）。 */
export interface CrossNodeRef {
  treeId: string
  nodeId: string
}

/** 交叉关系：两条（跨树）节点的关联。 */
export interface CrossLink {
  id: string
  forestId: string
  a: CrossNodeRef
  b: CrossNodeRef
  /** suggested = AI 建议待确认；confirmed = 用户已确认，节点据此显示交叉徽标。 */
  status: 'suggested' | 'confirmed'
  reason?: string
  createdAt: string
}

/** AI 交叉建议候选（未落库原始形态，由 suggestCrossLinks 返回）。 */
export interface CrossLinkSuggestion {
  a: CrossNodeRef
  b: CrossNodeRef
  reason: string
}

/** 交叉节点渲染所需的「伙伴节点」信息（由 store 派生）。 */
export interface CrossPartner {
  treeId: string
  treeName: string
  nodeId: string
  nodeText: string
  reason?: string
}

/** 思维树林持久化文档（localStorage，key: personal-agent.mindforest.v1）。 */
export interface MindForestStore {
  version: 1
  trees: MindTree[]
  forests: MindForest[]
  crossLinks: CrossLink[]
}

/** 插件（camelCase 领域类型，service 层从 PluginsRow 映射）。 */
export interface Plugin {
  id: number
  pluginId: string
  name: string
  version: string
  description: string
  author?: string | null
  repoUrl?: string | null
  permissions: string[]
  entryPath: string
  enabled: boolean
  installedAt: string
  updatedAt: string
}

/** 插件安装入参（manifest 校验后 + 拉取到的入口源码）。 */
export interface PluginInstallInput {
  pluginId: string
  name: string
  version: string
  description: string
  author?: string | null
  repoUrl?: string | null
  permissions: string[]
  /** 入口源码（单文件自包含 ESM，安装时上传到云 storage）。 */
  sourceCode: string
}
