/**
 * 离线记录缓存（P1-9）
 *
 * 只缓存**摘要**：`id / type / title / snippet / updatedAt / dirty`。
 * 不落正文全文、不落附件与签名 URL——离线库是「壳里能看见有哪些记录」，
 * 不是第二个数据库；把正文搬进来等于凭空多一份需要清理的隐私面。
 *
 * ## 为什么不用 Dexie（第 14 期原选型，本日实测后换掉）
 *
 * 计划写的验收线是「Dexie **gzip 增量 ≤25KB**，超限退回手写 IDB 封装」。
 * 实测 `dexie@4.4.7` 单独分块 **99.81kB / gzip 32.64kB**，超线 7.6KB；
 * 而这里需要的只有「按主键批量写、按 updatedAt 取最近 N 条、按 id 删、清空」四件事，
 * 手写 IndexedDB 约 1KB gzip。按既定验收执行 → 去掉依赖，改为原生封装。
 * 唯一要自己补的是 schema 升级：`v1 → v2` 只是**加索引**，`onupgradeneeded` 里补建即可，不重建表、不丢数据。
 *
 * ## 三条硬约束
 * 1. **容量 500 条，按 `updatedAt` 淘汰**，但 `dirty`（本地待同步）条目永不淘汰——
 *    否则离线改过的东西会在联网前被自己的清理逻辑吃掉。
 * 2. **任何异常都静默降级**：隐私模式 / 存储被禁用 / 配额满，都只意味着「没有离线缓存」，
 *    不能让列表页因此报错。
 * 3. **必须动态 `import()`**（调用方负责）：它只服务「离线看一眼」，不该进首屏 chunk。
 */
import type { InfoRecord, RecordType } from '@shared/types/domain'

export const OFFLINE_DB_NAME = 'pa-offline'
/** 当前 schema 版本。v1 = 首版；v2 = 补 `type` 索引（只加索引，不动数据）。 */
export const OFFLINE_DB_VERSION = 2
export const OFFLINE_STORE = 'records'
export const OFFLINE_MAX_RECORDS = 500
/** 离线列表里「数据截至」用的摘要长度上限。 */
export const OFFLINE_SNIPPET_MAX = 120

/** 离线库中的一条记录摘要。 */
export interface OfflineRecordSummary {
  id: number
  type: RecordType
  title: string
  /** 正文摘要（已截断），用于离线列表副标题。 */
  snippet: string
  /** ISO 时间字符串（原样保存；都是 `toISOString()` 形态，字符串比较即时间序）。 */
  updatedAt: string
  /** 1 = 本地有未同步改动（淘汰时必须保留）。 */
  dirty: 0 | 1
}

export interface OfflineSnapshot {
  rows: OfflineRecordSummary[]
  /** 缓存里最新一条记录的 `updatedAt`，用于「数据截至 X」。 */
  latestUpdatedAt: string | null
}

/** 截断正文为单行摘要。 */
export function toSnippet(content: string | null | undefined, max = OFFLINE_SNIPPET_MAX): string {
  const text = String(content ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** `InfoRecord` → 离线摘要（字段口径唯一出口，避免各处自己拼）。 */
export function toOfflineSummary(record: InfoRecord): OfflineRecordSummary {
  return {
    id: record.id,
    type: record.type,
    title: (record.title || '').trim() || '（无标题）',
    snippet: toSnippet(record.content),
    updatedAt: record.updatedAt,
    dirty: 0,
  }
}

/**
 * 选出该淘汰的 id（纯函数，可在 Node 里直接测）。
 *
 * 规则：`dirty` 全留 → 其余按 `updatedAt` 倒序，前 `limit - dirty数` 条保留 → 余下淘汰。
 * 极端情况（脏数据本身超过 limit）宁可超限也不删——「不误删待同步改动」优先于容量上限。
 */
export function selectEvictedIds(
  rows: Array<Pick<OfflineRecordSummary, 'id' | 'updatedAt' | 'dirty'>>,
  limit = OFFLINE_MAX_RECORDS,
): number[] {
  if (limit <= 0) return rows.map((r) => r.id)
  const dirtyCount = rows.filter((r) => r.dirty === 1).length
  const clean = rows.filter((r) => r.dirty !== 1)
  const keepClean = Math.max(0, limit - dirtyCount)
  const sorted = [...clean].sort((a, b) => {
    if (a.updatedAt === b.updatedAt) return b.id - a.id
    return a.updatedAt < b.updatedAt ? 1 : -1 // 新的在前
  })
  return sorted.slice(keepClean).map((r) => r.id)
}

/** 把 ISO 时间格式化成「M-D HH:mm」（本地时区，非法值回落空串）。 */
export function formatSnapshotTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getMonth() + 1}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* ------------------------------ 原生 IndexedDB ------------------------------ */

function idbFactory(): IDBFactory | null {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB
  } catch {
    return null
  }
}

let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const factory = idbFactory()
    if (!factory) {
      resolve(null)
      return
    }
    let req: IDBOpenDBRequest
    try {
      req = factory.open(OFFLINE_DB_NAME, OFFLINE_DB_VERSION)
    } catch {
      resolve(null)
      return
    }
    req.onupgradeneeded = () => {
      const db = req.result
      const store = db.objectStoreNames.contains(OFFLINE_STORE)
        ? req.transaction?.objectStore(OFFLINE_STORE)
        : db.createObjectStore(OFFLINE_STORE, { keyPath: 'id' })
      if (!store) return
      // 缺哪个补哪个：v0→v2 全建，v1→v2 只补 type（加索引不需要回填数据）
      if (!store.indexNames.contains('updatedAt')) store.createIndex('updatedAt', 'updatedAt')
      if (!store.indexNames.contains('dirty')) store.createIndex('dirty', 'dirty')
      if (!store.indexNames.contains('type')) store.createIndex('type', 'type')
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => resolve(null)
    req.onblocked = () => resolve(null)
  })
  return dbPromise
}

/** 在一个事务里跑同步的 store 操作，等 `transaction.oncomplete` 再 resolve。 */
function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => T,
  fallback: T,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve) => {
        if (!db) {
          resolve(fallback)
          return
        }
        let result: T = fallback
        try {
          const tx = db.transaction(OFFLINE_STORE, mode)
          result = run(tx.objectStore(OFFLINE_STORE))
          tx.oncomplete = () => resolve(result)
          tx.onerror = () => resolve(fallback)
          tx.onabort = () => resolve(fallback)
        } catch {
          resolve(fallback)
        }
      }),
  )
}

/** 读取全部摘要（淘汰计算用；上限 500 + 本批，量级可控）。 */
function readAll(): Promise<OfflineRecordSummary[]> {
  return withStore<OfflineRecordSummary[]>(
    'readonly',
    (store) => {
      const out: OfflineRecordSummary[] = []
      store.openCursor().onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
        if (!cursor) return
        out.push(cursor.value as OfflineRecordSummary)
        cursor.continue()
      }
      return out
    },
    [],
  )
}

/** 写入离线缓存，返回写入条数（失败返回 0；调用方不必 await）。 */
export async function cacheRecords(records: InfoRecord[]): Promise<number> {
  if (!records.length) return 0
  const summaries = records.map(toOfflineSummary)
  try {
    await withStore<number>(
      'readwrite',
      (store) => {
        summaries.forEach((row) => store.put(row))
        return summaries.length
      },
      0,
    )
    const all = await readAll()
    const evicted = selectEvictedIds(all, OFFLINE_MAX_RECORDS)
    if (evicted.length) await deleteIds(evicted)
    return summaries.length
  } catch {
    return 0
  }
}

function deleteIds(ids: number[]): Promise<void> {
  return withStore<void>(
    'readwrite',
    (store) => {
      ids.forEach((id) => store.delete(id))
    },
    undefined,
  )
}

/** 读离线缓存（按 `updatedAt` 倒序取最近 `limit` 条）。 */
export async function readCachedRecords(limit = 20): Promise<OfflineSnapshot> {
  const max = Math.max(1, Math.floor(limit))
  const rows = await withStore<OfflineRecordSummary[]>(
    'readonly',
    (store) => {
      const out: OfflineRecordSummary[] = []
      const index = store.index('updatedAt')
      index.openCursor(null, 'prev').onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result
        if (!cursor || out.length >= max) return
        out.push(cursor.value as OfflineRecordSummary)
        cursor.continue()
      }
      return out
    },
    [],
  )
  return { rows, latestUpdatedAt: rows[0]?.updatedAt ?? null }
}

/** 离线缓存条目数（设置页 / QA 巡检用）。 */
export async function countCachedRecords(): Promise<number> {
  const db = await openDb()
  if (!db) return 0
  return new Promise<number>((resolve) => {
    try {
      const req = db.transaction(OFFLINE_STORE, 'readonly').objectStore(OFFLINE_STORE).count()
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(0)
    } catch {
      resolve(0)
    }
  })
}

/** 清空离线缓存（退出登录时调用，避免换账号后看到上一个人的标题）。 */
export function clearOfflineCache(): Promise<void> {
  return withStore<void>(
    'readwrite',
    (store) => {
      store.clear()
    },
    undefined,
  )
}
