/**
 * 设备注册表（多端同时在线）。
 *
 * 解决的问题：一个账号在 **Android 手机 + Windows 桌面端** 同时登录时，
 * 旧实现里两端各自持有一份会话，但「谁在线、还有几台、要不要踢掉某一台」
 * 全是黑盒。本模块把「设备」变成一等公民：
 *
 * - **登录时注册**：`(owner_id, device_id)` 唯一，写入平台 / 标签 / 版本；
 * - **运行期心跳**：前台每分钟一次，只更新 `last_seen_at`（单列写入，代价极小）；
 * - **可被远端注销**：任一设备可把另一台的 `revoked_at` 打上；被注销端在
 *   下一次心跳读到后**自行登出**（云 SDK 没有「按会话踢人」的管理接口，
 *   我们不伪造服务端能力，只做「本端主动退出」）。
 *
 * 三条工程约束：
 * 1. **表不存在不能拖垮登录**：`devices` 是 v2.15 新表，旧库没执行迁移时
 *    PostgREST 报 `42P01`，这里把它降级为「注册表不可用」，登录照常。
 * 2. **不抛错给 UI**：所有方法返回 `boolean` / 空数组，调用方无需 try。
 * 3. **不做时钟比较**：`last_seen_at` 由服务端 `now()` 生成，避免两端系统时间
 *    不一致导致「在线设备」排序错乱（手机时间被手动改过是常态）。
 */
import { cloud } from '@/lib/cloud'
import { getDeviceIdentity, type PlatformKind } from '@/lib/platform'
import type { DevicesRow } from '@/lib/database.types'

/** 设备注册表是否可用（表不存在 / 无权限时置 false，之后不再发请求）。 */
let registryAvailable = true

/** 心跳写入的最小间隔（毫秒）：前台高频切换标签页时不该每切一次就写一次库。 */
export const HEARTBEAT_MIN_INTERVAL_MS = 55_000

let lastHeartbeatAt = 0

/** 注册表当前是否可用（设置页据此决定是否展示设备卡片）。 */
export function isRegistryAvailable(): boolean {
  return registryAvailable
}

/** 测试用：重置内部状态。 */
export function resetRegistryState(): void {
  registryAvailable = true
  lastHeartbeatAt = 0
}

/** 读错误码（云 SDK 的 PostgREST 错误把 code 放在 `code` 或 `error.code`）。 */
function readErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return ''
  const e = error as { code?: unknown; error?: { code?: unknown }; message?: unknown }
  const code = e.code ?? e.error?.code
  if (typeof code === 'string') return code
  if (typeof code === 'number') return String(code)
  const message = typeof e.message === 'string' ? e.message : ''
  // 部分网关会把 PG 错误码拼进 message
  return /42P01|undefined_table/i.test(message) ? '42P01' : ''
}

/** 错误是否「表/列不存在」（可安全降级）。 */
export function isMissingTableError(error: unknown): boolean {
  return readErrorCode(error) === '42P01'
}

/** 当前应用版本（构建期注入；测试环境可能没有，回落空串）。 */
function appVersion(): string {
  try {
    return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : ''
  } catch {
    return ''
  }
}

/** 列表返回的条目（`revoked` 语义外置，UI 不必关心时间格式）。 */
export interface DeviceEntry {
  deviceId: string
  platform: PlatformKind
  label: string
  appVersion: string
  lastSeenAt: string
  createdAt: string
  revoked: boolean
  /** 是否是当前这台设备。 */
  current: boolean
}

/** 把行归一成 UI 结构（脏数据一律兜底，不让一张坏行炸掉整张卡片）。 */
export function toDeviceEntry(row: DevicesRow, currentDeviceId: string): DeviceEntry {
  const platform = (['desktop', 'android', 'ios', 'web'] as const).includes(
    row.platform as PlatformKind,
  )
    ? (row.platform as PlatformKind)
    : 'web'
  return {
    deviceId: row.device_id,
    platform,
    label: row.label || '',
    appVersion: row.app_version || '',
    lastSeenAt: row.last_seen_at || '',
    createdAt: row.created_at || '',
    revoked: Boolean(row.revoked_at),
    current: row.device_id === currentDeviceId,
  }
}

export const deviceRegistry = {
  /**
   * 登录后注册（幂等）：存在则刷新，不存在则插入。
   *
   * `revoked_at` 在**重新登录时清零**——被踢掉的设备重新输验证码登录，
   * 说明人就在这台机器前，继续拦着没有意义（这也解释了「远端注销」的边界：
   * 它是「请这台下线」，不是「封禁这台」）。
   */
  async register(): Promise<boolean> {
    if (!registryAvailable) return false
    const identity = getDeviceIdentity()
    try {
      const existing = await cloud.database
        .from('devices')
        .select('id')
        .eq('device_id', identity.deviceId)
        .limit(1)
        .maybeSingle()
      if (existing.error) throw existing.error

      const payload = {
        device_id: identity.deviceId,
        platform: identity.platform,
        label: identity.label,
        app_version: appVersion(),
        last_seen_at: new Date().toISOString(),
        revoked_at: null,
      }
      if (existing.data) {
        const updated = await cloud.database
          .from('devices')
          .update(payload)
          .eq('device_id', identity.deviceId)
        if (updated.error) throw updated.error
      } else {
        const inserted = await cloud.database.from('devices').insert(payload)
        if (inserted.error) throw inserted.error
      }
      lastHeartbeatAt = Date.now()
      return true
    } catch (error) {
      if (isMissingTableError(error)) registryAvailable = false
      return false
    }
  },

  /**
   * 心跳：只写 `last_seen_at`，并回读 `revoked_at` 判断自己是否被踢。
   *
   * @param force 忽略最小间隔（应用从后台恢复时用：那一刻的「在线」必须准）
   * @returns `'revoked'` 表示本机已被其它设备注销；`'skipped'` 表示节流跳过
   */
  async heartbeat(force = false): Promise<'ok' | 'revoked' | 'failed' | 'skipped'> {
    if (!registryAvailable) return 'failed'
    const now = Date.now()
    if (!force && now - lastHeartbeatAt < HEARTBEAT_MIN_INTERVAL_MS) return 'skipped'
    lastHeartbeatAt = now
    const identity = getDeviceIdentity()
    try {
      const res = await cloud.database
        .from('devices')
        .update({ last_seen_at: new Date().toISOString() })
        .eq('device_id', identity.deviceId)
        .select()
      if (res.error) throw res.error
      const rows = (res.data as DevicesRow[] | null) ?? []
      const self = rows[0]
      if (!self) {
        // 行丢了（换账号 / 库被清）→ 重新注册一次，别让设备从列表里消失
        await deviceRegistry.register()
        return 'ok'
      }
      return self.revoked_at ? 'revoked' : 'ok'
    } catch (error) {
      if (isMissingTableError(error)) registryAvailable = false
      return 'failed'
    }
  },

  /** 列出本账号全部设备（按最近活跃倒序）。失败返回空数组。 */
  async list(): Promise<DeviceEntry[]> {
    if (!registryAvailable) return []
    const identity = getDeviceIdentity()
    try {
      const res = await cloud.database
        .from('devices')
        .select('*')
        .order('last_seen_at', { ascending: false })
        .limit(20)
      if (res.error) throw res.error
      const rows = (res.data as DevicesRow[] | null) ?? []
      return rows.map((row) => toDeviceEntry(row, identity.deviceId))
    } catch (error) {
      if (isMissingTableError(error)) registryAvailable = false
      return []
    }
  },

  /**
   * 注销另一台设备（打 `revoked_at`）。
   *
   * 当前设备不允许走这里——「退出本机」应该走真正的 `signOut`（会向服务端
   * 销毁会话），用注销标记代替会让本地留着一个仍然能用的 refresh token。
   */
  async revoke(deviceId: string): Promise<boolean> {
    if (!registryAvailable) return false
    if (deviceId === getDeviceIdentity().deviceId) return false
    try {
      const res = await cloud.database
        .from('devices')
        .update({ revoked_at: new Date().toISOString() })
        .eq('device_id', deviceId)
        .select()
      if (res.error) throw res.error
      return true
    } catch (error) {
      if (isMissingTableError(error)) registryAvailable = false
      return false
    }
  },
}
