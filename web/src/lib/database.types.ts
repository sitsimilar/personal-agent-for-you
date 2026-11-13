/**
 * Database 泛型类型（供 createWorkBuddyCloud<Database> 强类型）。
 *
 * 列名与数据库 snake_case 完全一致。Row 用于 .select('*') 返回类型；
 * Insert / Update 采用宽松映射，避免与 PostgREST 默认值语义冲突。
 */

export interface RecordsRow {
  id: number
  owner_id: string
  type: 'idea' | 'material' | 'todo'
  title: string
  content: string
  url: string | null
  file_path: string | null
  category: string | null
  tags: string[]
  summary: string | null
  todo_status: 'pending' | 'done' | null
  priority: 'high' | 'medium' | 'low' | null
  remind_at: string | null
  /** P0-B 循环规则（JSONB，脏数据按 null 处理）。 */
  recurrence: unknown
  /** P0-B 循环链根记录 id。 */
  recurrence_parent_id: number | null
  /** P0-B 由本条生成的下一期记录 id。 */
  recurrence_next_id: number | null
  /** P0-C 链接元数据（JSONB）。 */
  link_meta: unknown
  /**
   * v2.13 R2 待办「某天」显式标记。
   * 用 `?` 是「迁移未执行也兼容」：缺列时 `select('*')` 不返回该键，映射层回落 false。
   */
  someday?: boolean | null
  /** v2.13 R4 稍后提醒到期时刻（UTC）；空 = 未推迟。 */
  snoozed_until?: string | null
  /** v2.13 R4 已 snooze 次数（去重键第三段）。 */
  snooze_count?: number | null
  /** v2.13 R1 检索用 generated tsvector（只读，应用永不写入）。 */
  search_tsv?: string | null
  /**
   * v2.14 外部系统稳定标识（.ics 导入查重键）。
   * 用 `?` 是「迁移未执行也兼容」：缺列时 `select('*')` 不返回该键，映射层回落 null。
   */
  external_uid?: string | null
  /** v2.14 正文派生元数据（JSONB，脏数据按 null 处理）。 */
  record_meta?: unknown
  /**
   * v2.14 P0-2 父记录 id（自引用，对应 .ics 的 `RELATED-TO;RELTYPE=PARENT`）。
   * 用 `?` 是「迁移未执行也兼容」：缺列时不返回该键，映射层回落 null。
   */
  parent_id?: number | null
  is_deleted: boolean
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export interface RecordLinksRow {
  id: number
  owner_id: string
  source_id: number
  target_id: number
  score: number
  reason: string | null
  created_at: string
}

export interface CodeAnalysesRow {
  id: number
  owner_id: string
  solution_name: string
  solution_path: string | null
  project_name: string | null
  issues: unknown
  summary: string | null
  status: 'pending' | 'analyzing' | 'done' | 'failed'
  created_at: string
}

export interface SettingsRow {
  id: number
  owner_id: string
  vs_path: string | null
  code_upload_enabled: boolean
  float_window_enabled: boolean
  float_position: unknown
  notify_enabled: boolean
  /** P0-A 提醒提前量（分钟）。 */
  remind_lead_minutes: number
  /** P0-A 免打扰开关。 */
  quiet_hours_enabled: boolean
  /** P0-A 免打扰起始（本地墙钟 HH:mm）。 */
  quiet_start: string
  /** P0-A 免打扰结束（本地墙钟 HH:mm）。 */
  quiet_end: string
  /** v2.13 R5 周回顾向导进度（JSONB；`?` 兼容迁移未执行）。 */
  review_wizard?: unknown
  /**
   * v2.14 P0-3 订阅源配置（JSONB 数组）。
   * 用 `?` 是「迁移未执行也兼容」：缺列时 `select('*')` 不返回该键，
   * `feedService.loadFeedConfig` 按空数组处理，只在**写**的时候提示去执行迁移。
   */
  feeds?: unknown
  /** v2.14 P0-3 订阅运行时状态（JSONB 对象；`?` 同上，缺失按空对象处理）。 */
  feed_state?: unknown
  /**
   * 界面方案（v2.13.1 UI-1）：`silent` | `zoned` | `fluid`。
   *
   * 用 `?` 是「迁移未执行也兼容」：缺列时 `select('*')` 不返回该键，
   * 方案层自动退化为设备级（localStorage），不会报错阻塞设置页。
   */
  ui_scheme?: string | null
  avatar_image_id: number | null
  nickname: string | null
  updated_at: string
}

export interface ImagesRow {
  id: number
  owner_id: string
  name: string
  mime_type: string
  size: number
  original_path: string | null
  thumb_128_path: string | null
  thumb_256_path: string | null
  thumb_512_path: string | null
  created_at: string
  updated_at: string
}

export interface PluginsRow {
  id: number
  owner_id: string
  plugin_id: string
  name: string
  version: string
  description: string
  author: string | null
  repo_url: string | null
  permissions: string[]
  entry_path: string
  enabled: boolean
  installed_at: string
  updated_at: string
}

export interface MindTreesRow {
  id: number
  owner_id: string
  /** 整份思维树林文档（MindForestStore 序列化），JSONB。 */
  payload: unknown
  updated_at: string
}

interface TableDef<Row> {
  Row: Row
  Insert: Record<string, unknown>
  Update: Record<string, unknown>
  Relationships: []
}

export interface Database {
  Tables: {
    records: TableDef<RecordsRow>
    record_links: TableDef<RecordLinksRow>
    code_analyses: TableDef<CodeAnalysesRow>
    settings: TableDef<SettingsRow>
    images: TableDef<ImagesRow>
    plugins: TableDef<PluginsRow>
    mind_trees: TableDef<MindTreesRow>
  }
  Views: Record<string, never>
  Functions: Record<string, never>
}
