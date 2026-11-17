/**
 * 视觉识别服务（机器视觉模块的门面）
 * ============================================================================
 * 一次调用的完整链路：
 *
 *   输入(File/Blob/dataURL/URL ×≤5)
 *     → [本地] 解码/EXIF 纠正/魔数嗅探      codec.ts
 *     → [本地] 特征 + 场景分类 + 质检        features/classify/quality.ts
 *     → [本地] 裁剪/缩放/转码 + 体积阶梯     plan.ts / codec.ts
 *     → [本地] 批内去重 + 指纹               phash.ts / pipeline.ts
 *     → [网络] 视觉模型（结构化 JSON）        本文件
 *     → [本地] 解析/校验/降级                result.ts
 *     → 结果缓存（同图同代码同问题不再调模型）
 *
 * 与旧实现的差异（可直接对照验收）：
 * 1. 旧：原图 base64 直传，无尺寸上限 → 大图必然拖慢甚至超网关。新：长边 ≤1600、单张 ≤1.5MB 硬预算。
 * 2. 旧：单一提示词，不看场景 → 表格/图表只能得到泛泛描述。新：按场景注入清单，强制三段式输出。
 * 3. 旧：任何失败都只报"识别失败"。新：错误分四类（输入/模型/网络/解析），可重试的自动重试 1 次。
 * 4. 旧：无缓存。新：指纹命中直接返回（省一次 3~8s 的调用）。
 */

import { cloud } from '@/lib/cloud'
import { collectStream } from '@shared/utils/llm'
import { friendlyError } from '@/lib/unwrap'
import {
  buildJsonRepairPrompt,
  buildSystemPrompt,
  buildUserContent,
  parseVisionResult,
  prepareVisionInput,
  toMarkdown,
  toPromptImages,
  type PreparedBundle,
  type PrepareFailure,
  type SceneKind,
  type VisionRequest,
  type VisionResult,
} from '@/lib/vision'
import { onServiceError } from './authExpired'
import { getModelId } from './llm-model'

/** 结果缓存：schema 变更时改版本号，旧缓存自然失效。 */
const CACHE_KEY = 'personal-agent.vision-cache.v2'
/** 缓存条数上限（每条含一段结果文本，约 2~6KB，20 条 ≈ 100KB，localStorage 可承受）。 */
const CACHE_MAX = 20
/** 缓存有效期：同一天内重复问同一张图很有价值，隔天价值骤降。 */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
/** 可重试错误的重试间隔。 */
const RETRY_DELAY_MS = 900
/** 最多重试次数（规范：同一通道连续失败 2 次即停，这里只重试 1 次）。 */
const MAX_RETRY = 1

/** 单次调用的观测指标（写日志/UI 展示，便于回答"到底快了多少"）。 */
export interface VisionMetrics {
  /** 本地预处理耗时（含解码、特征、编码）。 */
  prepMs: number
  /** 模型往返耗时（不含重试等待）。 */
  llmMs: number
  /** 端到端耗时。 */
  totalMs: number
  /** 送入前原始字节。 */
  bytesBefore: number
  /** 送入后字节。 */
  bytesAfter: number
  /** 是否命中缓存。 */
  cacheHit: boolean
  /** 触发了几次重试。 */
  retries: number
  /** 是否走了一次 JSON 修复调用。 */
  repaired: boolean
  /** 实际使用的模型 id。 */
  model: string
  /** 批次场景。 */
  scene: SceneKind
}

/** 调用结果。 */
export interface VisionCallResult {
  result: VisionResult
  metrics: VisionMetrics
  /** 准备阶段被跳过的图（重复/解码失败），UI 应提示但不阻断。 */
  failures: PrepareFailure[]
  /** 准备后的批次（含每张图的质量与场景，供 UI 展示"图1 偏糊"）。 */
  bundle: PreparedBundle
}

/** 缓存条目（localStorage 序列化形态）。 */
interface CacheEntry {
  key: string
  ts: number
  result: VisionResult
  model: string
}

/** 内存缓存（同一会话内避免反复读 localStorage）。 */
const memoryCache = new Map<string, CacheEntry>()

/**
 * 分析入口（一步到位：准备 + 调用）。
 *
 * @param request 图片 + 可选代码/上下文/问题
 * @throws 输入不可用 / 没有视觉模型 / 网络失败（均为中文可上屏文案）
 */
async function analyze(request: VisionRequest): Promise<VisionCallResult> {
  const t0 = now()
  if (!request.images || request.images.length === 0) throw new Error('请先选择至少一张图片')

  // ---- 1. 本地准备（这一步失败是「输入问题」，不重试）----
  const { bundle, failures } = await prepareVisionInput(request.images)
  const prepMs = Math.round(now() - t0)

  // ---- 2~6. 交给「已准备批次」的调用（UI 分两步走时也复用它，避免重复解码）----
  const call = await analyzeBundle(bundle, request, prepMs)
  return { ...call, failures, bundle }
}

/**
 * 对已经准备好的批次发起模型调用。
 *
 * 拆出来是为了让 UI 能先「预检」再「识别」：预检阶段已经解码/分类/压缩过，
 * 识别阶段直接复用，重复点击不会重复解码（旧界面每次点都要重读文件）。
 */
async function analyzeBundle(
  bundle: PreparedBundle,
  request: VisionRequest,
  prepMs = 0,
): Promise<Omit<VisionCallResult, 'failures' | 'bundle'>> {
  const t0 = now()
  const scene: SceneKind = request.sceneOverride ?? bundle.scene

  // ---- 模型（拿不到视觉模型是「配置问题」，不重试）----
  const model = await getModelId('vision')

  // ---- 缓存 ----
  const key = cacheKey(bundle, request, scene, model)
  const cached = readCache(key)
  if (cached) {
    return {
      result: cached.result,
      metrics: {
        prepMs,
        llmMs: 0,
        totalMs: Math.round(now() - t0),
        bytesBefore: bundle.metrics.bytesBefore,
        bytesAfter: bundle.metrics.bytesAfter,
        cacheHit: true,
        retries: 0,
        repaired: false,
        model: cached.model,
        scene,
      },
    }
  }

  // ---- 组消息 ----
  const hasCode = !!request.code?.trim()
  const systemPrompt = buildSystemPrompt(scene, hasCode)
  const userContent = buildUserContent(toPromptImages(bundle), request.code, request.context, request.question)

  // SDK 的类型只声明了 content: string，这里用窄类型表达多模态消息（与 aiService 一致）
  type MultimodalChatInput = {
    model: string
    messages: Array<{ role: string; content: string | Array<Record<string, unknown>> }>
    stream: boolean
  }
  const create = cloud.llm.chat.completions.create as unknown as (
    args: MultimodalChatInput,
  ) => Promise<AsyncIterable<unknown>> & AsyncIterable<unknown>

  // ---- 调用（含 1 次重试）----
  const llmStart = now()
  let raw = ''
  let retries = 0
  for (let attempt = 0; ; attempt++) {
    try {
      const stream = await create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        stream: true,
      })
      raw = await collectStream(stream)
      break
    } catch (err) {
      if (attempt < MAX_RETRY && isTransient(err)) {
        retries++
        await delay(RETRY_DELAY_MS)
        continue
      }
      throw wrapError(err)
    }
  }
  const llmMs = Math.round(now() - llmStart)

  // ---- 解析；不合法就做一次「只修格式」的补救（不重新看图，省 token）----
  let result = parseVisionResult(raw, scene)
  let repaired = false
  if (!result.structured) {
    repaired = true
    try {
      const fixStream = await create({
        model,
        messages: [
          { role: 'system', content: buildSystemPrompt(scene, hasCode) },
          { role: 'user', content: buildJsonRepairPrompt(raw) },
        ],
        stream: true,
      })
      const fixed = await collectStream(fixStream)
      const second = parseVisionResult(fixed, scene)
      if (second.structured) result = second
    } catch {
      // 修复失败就保留纯文本降级结果——用户至少能看到内容，不阻断
    }
  }

  // 模型自评的场景优先于前置分类器（它看过图）；parseVisionResult 已保证只有合法值才会生效。
  writeCache(key, { key, ts: Date.now(), result, model })

  return {
    result,
    metrics: {
      prepMs,
      llmMs,
      totalMs: Math.round(now() - t0),
      bytesBefore: bundle.metrics.bytesBefore,
      bytesAfter: bundle.metrics.bytesAfter,
      cacheHit: false,
      retries,
      repaired,
      model,
      scene,
    },
  }
}

/** 便捷方法：只要 Markdown 文本（用于复制、落记录、旧调用方迁移）。 */
async function analyzeMarkdown(request: VisionRequest): Promise<{ markdown: string; metrics: VisionMetrics; failures: PrepareFailure[] }> {
  const r = await analyze(request)
  return { markdown: toMarkdown(r.result), metrics: r.metrics, failures: r.failures }
}

/**
 * 预检：只做本地准备（解码/分类/质检/压缩），不调模型。
 * UI 用它在用户点击"识别"之前展示「图1 判定为代码 · 偏糊」这类提示。
 */
async function prepare(images: Array<File | Blob | string>): Promise<{ bundle: PreparedBundle; failures: PrepareFailure[] }> {
  if (!images || images.length === 0) throw new Error('请先选择至少一张图片')
  return prepareVisionInput(images)
}

/** 清缓存（设置页"清空识别缓存"用）。 */
function clearCache(): void {
  memoryCache.clear()
  try {
    localStorage.removeItem(CACHE_KEY)
  } catch {
    /* 隐私模式下 localStorage 不可写，忽略 */
  }
}

// ============================================================================
// 内部：缓存与错误分类
// ============================================================================

/** 指纹：批次哈希 + 代码 + 上下文 + 问题 + 场景 + 模型。任何一项变了都要重新问。 */
function cacheKey(bundle: PreparedBundle, req: VisionRequest, scene: SceneKind, model: string): string {
  const code = req.code?.trim() ?? ''
  const payload = [bundle.fingerprint, scene, model, req.context?.trim() ?? '', req.question?.trim() ?? '', code].join('\u0001')
  return `v2:${fnv1a(payload)}:${code.length}`
}

/** FNV-1a 32 位：短、稳定、够用（只做缓存 key，不做安全用途）。 */
function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** 读缓存：内存优先，其次 localStorage；过期即删。 */
function readCache(key: string): CacheEntry | null {
  const mem = memoryCache.get(key)
  if (mem && Date.now() - mem.ts < CACHE_TTL_MS) return mem
  if (mem) memoryCache.delete(key)

  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const list = JSON.parse(raw) as CacheEntry[]
    if (!Array.isArray(list)) return null
    const hit = list.find((e) => e?.key === key)
    if (!hit || typeof hit.ts !== 'number' || Date.now() - hit.ts >= CACHE_TTL_MS) {
      // 顺手清理过期条目，避免缓存无限增长
      const alive = list.filter((e) => e && typeof e.ts === 'number' && Date.now() - e.ts < CACHE_TTL_MS)
      localStorage.setItem(CACHE_KEY, JSON.stringify(alive.slice(0, CACHE_MAX)))
      return null
    }
    memoryCache.set(key, hit)
    return hit
  } catch {
    return null
  }
}

/** 写缓存：内存 + localStorage（LRU 截断到 CACHE_MAX）。 */
function writeCache(key: string, entry: CacheEntry): void {
  memoryCache.set(key, entry)
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const list = raw ? (JSON.parse(raw) as CacheEntry[]) : []
    const filtered = Array.isArray(list) ? list.filter((e) => e?.key !== key && e && typeof e.ts === 'number') : []
    const next = [entry, ...filtered].slice(0, CACHE_MAX)
    localStorage.setItem(CACHE_KEY, JSON.stringify(next))
  } catch {
    /* 写不进去只影响下次命中率，不影响本次结果 */
  }
}

/**
 * 判断是否「可重试」的瞬时错误。
 *
 * 判据：网络层（fetch/timeout/ECONN/socket）+ 服务端 5xx + 429。
 * 明确**不重试**：401/403（会话或权限问题，重试只会再来一次失败）、
 * 输入类错误（"请先选择图片"/"无法识别格式"）、配置类错误（"没有支持图像的模型"）。
 */
export function isTransient(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  if (/(401|403|unauthor|forbidden|invalid.?token|未登录|无权限)/i.test(msg)) return false
  if (/(请先选择|无法识别|不支持|没有支持图像|图片尺寸无效|格式)/.test(msg)) return false
  return /(timeout|timed out|network|fetch failed|ECONN|ETIMEDOUT|EAI_AGAIN|socket|429|5\d\d|server error|服务繁忙|超时)/i.test(msg)
}

/** 统一错误包装（中文可上屏 + 触发会话失效跳转）。 */
function wrapError(err: unknown): Error {
  onServiceError(err)
  if (err instanceof Error && err.message && /[\u4e00-\u9fa5]/.test(err.message)) return err
  return new Error(friendlyError(err))
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now())

export const visionService = { analyze, analyzeBundle, analyzeMarkdown, prepare, clearCache, isTransient }
