/**
 * 机器视觉模块 · 编排层（浏览器侧）
 * ============================================================================
 * 把「解码 → 特征 → 分类 → 质检 → 预处理 → 编码」串成一次批处理。
 *
 * 关键取舍：
 * - **串行处理每张图**：并发编码 5 张 4K 图会瞬时占用数百 MB 显存/内存，
 *   在 Electron 窗口里表现为主线程卡顿；串行的代价只是总耗时线性增长（每张 40~90ms）。
 * - **批内去重**：用户常常把同一张图拖两次，或截了同一窗口的两个时刻。
 *   用感知哈希判同一张图，直接丢后面的，省一次模型调用。
 * - **失败不连坐**：单张图解码/编码失败只跳过它，其他照常送；
 *   只有一张都准备不出来时才抛错。
 */

import { classifyScene, dominantScene, SCENE_LABEL } from './classify'
import { blobToDataUrl, decodeSource, encodeWithBudget, readRGBA, releaseBitmap } from './codec'
import { extractFeatures } from './features'
import { hashDistance, perceptualHashOfGray, SAME_IMAGE_DISTANCE } from './phash'
import { perImageBudget, planPreprocess } from './plan'
import { assessQuality } from './quality'
import type { PreparedBundle, PreparedImage, SceneKind } from './types'
import type { PromptImageInfo } from './prompt'

/** 一次最多几张图（与 P1-11「多图 ≤5」一致）。 */
export const MAX_IMAGES = 5

/** 逐图准备失败时记录的原因（返回给 UI，不抛给用户看堆栈）。 */
export interface PrepareFailure {
  name: string
  reason: string
}

/** 准备结果：成功项 + 失败项。 */
export interface PrepareOutcome {
  bundle: PreparedBundle
  failures: PrepareFailure[]
}

/**
 * 批量准备。
 *
 * @param inputs  File/Blob/dataURL/URL 混合数组（顺序即图1、图2…）
 * @param now     时间戳注入点（测试可固定，缓存 key 用）
 */
export async function prepareVisionInput(
  inputs: Array<File | Blob | string>,
  now: number = Date.now(),
): Promise<PrepareOutcome> {
  const started = performanceNow()
  const list = inputs.slice(0, MAX_IMAGES)
  if (list.length === 0) throw new Error('请先选择至少一张图片')

  const budget = perImageBudget(list.length)
  const prepared: PreparedImage[] = []
  const failures: PrepareFailure[] = []
  const seen: Array<{ hash: string; label: string }> = []
  const sceneVotes: SceneKind[] = []
  let deduped = 0
  let bytesBefore = 0
  let bytesAfter = 0

  for (let i = 0; i < list.length; i++) {
    const label = `图${i + 1}`
    let decoded: Awaited<ReturnType<typeof decodeSource>> | null = null
    try {
      decoded = await decodeSource(list[i], `${label}.png`)

      // ---- 1. 特征（在 512 长边的工作副本上算；4K 与 720p 的成本一致）----
      // sourceWidth/sourceHeight 必须传原图尺寸：工作副本只有 512 长边，
      // 特征层要靠它把行高和内容包围盒换算回原图坐标（否则裁剪框会小 5~8 倍）。
      const rgba = readRGBA(decoded.bitmap, 512)
      const extraction = extractFeatures(rgba, {
        sourceWidth: decoded.meta.width,
        sourceHeight: decoded.meta.height,
      })
      // 复用特征阶段产出的 480 灰度图，避免对整图再做一次灰度转换
      const hash = perceptualHashOfGray({
        data: extraction.gray,
        width: extraction.grayWidth,
        height: extraction.grayHeight,
      })

      // ---- 2. 判重：与已接受的图比较，距离足够小就丢 ----
      const dup = seen.find((s) => hashDistance(s.hash, hash) <= SAME_IMAGE_DISTANCE)
      if (dup) {
        deduped++
        failures.push({ name: label, reason: `与${dup.label}是同一张图，已跳过` })
        continue
      }
      seen.push({ hash, label })

      // ---- 3. 分类 + 质检 ----
      const decision = classifyScene(extraction.features)
      const quality = assessQuality(extraction.features, decoded.meta, decision.scene)
      sceneVotes.push(decision.scene)

      // ---- 4. 预处理计划 + 体积阶梯编码 ----
      const plan = planPreprocess(decoded.meta, extraction.features, quality, decision.scene, extraction.contentBox)
      const encoded = await encodeWithBudget(decoded.bitmap, plan, budget)

      prepared.push({
        label,
        dataUrl: encoded.dataUrl,
        bytes: encoded.blob.size,
        width: encoded.width,
        height: encoded.height,
        meta: decoded.meta,
        originalBytes: decoded.meta.bytes,
        features: extraction.features,
        quality,
        scene: decision.scene,
        sceneScores: decision.scores,
        plan: {
          ...plan,
          // 实际执行可能因体积阶梯被降级，这里回报"真实用的参数"，避免日志说谎
          format: encoded.attempt.format,
          quality: encoded.attempt.quality,
          targetWidth: encoded.width,
          targetHeight: encoded.height,
          reasons: encoded.overBudget ? [...plan.reasons, '体积压不进预算，已尽力压缩'] : plan.reasons,
        },
        phash: hash,
      })
      bytesBefore += decoded.meta.bytes
      bytesAfter += encoded.blob.size
    } catch (err) {
      failures.push({ name: label, reason: err instanceof Error ? err.message : String(err) })
    } finally {
      if (decoded) releaseBitmap(decoded.bitmap)
    }
  }

  if (prepared.length === 0) {
    const why = failures.map((f) => `${f.name}：${f.reason}`).join('；')
    throw new Error(`所有图片都无法处理${why ? `（${why}）` : ''}`)
  }

  const scene = dominantScene(sceneVotes)
  // 指纹：批内哈希 + 实际编码参数。同一批图再次提交可直接命中缓存。
  const fingerprint = `${prepared.map((p) => p.phash).join('')}|${prepared.map((p) => `${p.plan.format}@${p.width}x${p.height}`).join(',')}`

  return {
    bundle: {
      images: prepared,
      scene,
      // 打分表取第一张图的（多图时它最有代表性；完整逐图打分在 images[].sceneScores 里）
      sceneScores: prepared[0].sceneScores,
      fingerprint,
      metrics: {
        bytesBefore,
        bytesAfter,
        prepMs: Math.round(performanceNow() - started),
        deduped,
      },
    },
    failures,
  }
}

/** 把准备结果转成提示词需要的图片描述（含 dataUrl）。 */
export function toPromptImages(bundle: PreparedBundle): Array<PromptImageInfo & { dataUrl: string }> {
  return bundle.images.map((img) => ({
    label: img.label,
    width: img.width,
    height: img.height,
    scene: img.scene,
    issues: img.quality.issues.map((i) => i.code),
    dataUrl: img.dataUrl,
  }))
}

/** 批次摘要（一行，写日志/状态用）。 */
export function summarizeBundle(bundle: PreparedBundle): string {
  const b = bundle.images
  const sizes = b.map((i) => `${i.width}×${i.height}`).join('/')
  const scenes = Array.from(new Set(b.map((i) => SCENE_LABEL[i.scene]))).join('+')
  return `${b.length} 张（${sizes}）· ${scenes} · ${(bundle.metrics.bytesBefore / 1024).toFixed(0)}KB→${(bundle.metrics.bytesAfter / 1024).toFixed(0)}KB · ${bundle.metrics.prepMs}ms`
}

/** performance.now 的安全包装（Node 里也有全局 performance）。 */
function performanceNow(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
}

/** 供外部按 dataUrl 重新编码（例如用户手动调质量）时复用。 */
export { blobToDataUrl }
