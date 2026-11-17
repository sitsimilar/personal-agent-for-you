/**
 * 模型选择（从 aiService 抽出，避免「视觉服务 ↔ aiService」互相 import 成环）
 * ============================================================================
 * 规则与原来完全一致，只是把「按偏好挑模型 + 15 分钟缓存」搬到独立模块：
 * - auto   ：取第一个可用模型（质量优先，默认）；
 * - fast   ：按 速度/适用性 打分排序（跳过 thinking 与图像模型）；
 * - vision ：取第一个声明 supportsImages 的模型。
 *
 * 缓存的意义：每次调用都列一次模型要多一次网络往返（~200ms），
 * 15 分钟 TTL 足够覆盖一次会话；模型被禁用后靠 TTL 自愈，不需要重启。
 */

import { cloud } from '@/lib/cloud'

/** 模型选择偏好。 */
export type ModelPreference = 'auto' | 'fast' | 'vision'

/** 缓存 TTL：过期自动重取。 */
const MODEL_CACHE_TTL_MS = 15 * 60 * 1000

interface ModelCacheEntry {
  id: string
  ts: number
}

const cachedModels = new Map<ModelPreference, ModelCacheEntry>()
const pendingModels = new Map<ModelPreference, Promise<string>>()

/**
 * 模型速度/适用性打分（越小越快），用于 fast 偏好下排序。
 * 判据只看 id/name 里的关键词——SDK 没有给出统一的性能元数据，
 * 关键词法在实践中最稳（见计划里对模型动态发现的约定：不写死模型 id）。
 */
export function modelSpeedRank(m: { id: string; name?: string }): number {
  const s = `${m.id} ${m.name ?? ''}`.toLowerCase()
  if (/thinking|reason|image|vision/.test(s)) return 99 // 慢（推理）/不适用（纯文本任务）
  if (/flash/.test(s)) return 0 // 最快
  if (/turbo|turbos|air|lite|mini|fast|quick/.test(s)) return 1
  if (/pro|max|ultra|opus|sonnet/.test(s)) return 3 // 强但慢
  return 2
}

/** 清空缓存（偏好切换后必须清，否则仍用旧偏好选的模型）。 */
export function clearModelCache(): void {
  cachedModels.clear()
  pendingModels.clear()
}

/**
 * 动态取模型 id（不写死）。
 *
 * @throws 没有可用模型 / 没有支持图像的模型时抛出中文错误
 */
export function getModelId(pref: ModelPreference = 'auto'): Promise<string> {
  const hit = cachedModels.get(pref)
  if (hit && Date.now() - hit.ts < MODEL_CACHE_TTL_MS) return Promise.resolve(hit.id)
  if (hit) cachedModels.delete(pref) // 过期清缓存

  const pending = pendingModels.get(pref)
  if (pending) return pending

  const p = (async () => {
    const models = await cloud.llm.models.list()
    const enabled = models.filter((m) => m.disabled !== true)
    if (enabled.length === 0) throw new Error('当前没有可用的 AI 模型，请稍后再试')

    let chosen = enabled[0]
    if (pref === 'fast') {
      const ranked = [...enabled].sort((a, b) => modelSpeedRank(a) - modelSpeedRank(b))
      chosen = ranked[0]
    } else if (pref === 'vision') {
      // supportsImages 不在 SDK 的公开类型里，按可选字段读，缺失即视为不支持
      const vision = enabled.find((m) => (m as { supportsImages?: boolean }).supportsImages === true)
      if (!vision) throw new Error('当前没有支持图像识别的模型，请稍后再试')
      chosen = vision
    }
    cachedModels.set(pref, { id: chosen.id, ts: Date.now() })
    return chosen.id
  })().catch((err) => {
    pendingModels.delete(pref)
    throw err
  })

  pendingModels.set(pref, p)
  return p
}
