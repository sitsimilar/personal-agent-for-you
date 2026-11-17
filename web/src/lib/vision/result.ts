/**
 * 机器视觉模块 · 结果解析与校验
 * ============================================================================
 * 模型输出永远不可信：可能带 markdown 围栏、少字段、把数组写成字符串、
 * 把 confidence 写成 "0.8"（字符串）甚至 "高"。
 *
 * 这一层的职责就一条：**任何输入都不抛异常**，最差也能降级成一段纯文本
 * （structured=false），前端据此换一种展示，而不是白屏。
 *
 * 校验策略：逐字段 narrow（typeof 判断 + 夹取），缺省填安全默认值；
 * 不做 schema 库校验（体积换不来收益），但保持与 types.ts 的契约一致。
 */

import { parseJsonLoose } from '@shared/utils/llm'
import type { SceneKind, VisionBlock, VisionResult, VisionStatus } from './types'

/** 允许的场景值（用于拒绝模型自造的类别）。 */
const SCENES: SceneKind[] = [
  'code',
  'error',
  'ui',
  'chat',
  'table',
  'chart',
  'document',
  'diagram',
  'photo',
  'handwriting',
  'unknown',
]

/** 允许的块类型。 */
const BLOCK_TYPES: VisionBlock['type'][] = ['title', 'paragraph', 'table', 'figure', 'formula', 'code', 'list', 'text']

/**
 * 解析模型输出。
 *
 * @param raw           模型原始文本
 * @param fallbackScene 前置分类器的判断（模型没给 scene 时用它）
 */
export function parseVisionResult(raw: string, fallbackScene: SceneKind = 'unknown'): VisionResult {
  const text = (raw ?? '').trim()
  const parsed = parseJsonLoose<Record<string, unknown>>(text)

  // ---- 降级路径：不是 JSON，或 JSON 里没有任何有用字段 ----
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return degrade(text, fallbackScene)
  }

  const scene = SCENES.includes(parsed.scene as SceneKind) ? (parsed.scene as SceneKind) : fallbackScene
  const blocks = normalizeBlocks(parsed.blocks)
  const understanding = asObject(parsed.understanding)
  const localization = asObject(parsed.localization)
  const solution = asObject(parsed.solution)
  const coverageIn = asObject(parsed.coverage)

  const missing = asStringArray(coverageIn.missing).slice(0, 20)
  const unreadable = asStringArray(coverageIn.unreadable).slice(0, 20)
  const expected = typeof coverageIn.expected === 'number' && Number.isFinite(coverageIn.expected) ? Math.max(0, coverageIn.expected) : null
  const ratio = expected && expected > 0 ? Math.min(1, (missing.length + unreadable.length) / expected) : 0

  const needMoreInfo = asStringArray(parsed.needMoreInfo).slice(0, 3)
  const summary = asString(understanding.summary)
  const transcribed = asStringArray(understanding.transcribed).slice(0, 20)
  const evidence = asStringArray(understanding.evidence).slice(0, 12)

  // 模型完全没给内容 → 视为不可读，避免前端展示一个空壳
  const empty = !summary && transcriptionEmpty(transcribed) && blocks.length === 0
  let status: VisionStatus = normalizeStatus(parsed.status) ?? (empty ? 'unreadable' : ratio > 0.3 ? 'partial' : 'ok')

  // 一致性修正：自评 ok 但缺了过半字段 → 降到 partial（模型常过度自信）
  if (status === 'ok' && ratio > 0.5) status = 'partial'
  if (status === 'ok' && empty) status = 'unreadable'

  return {
    schemaVersion: 2,
    scene,
    status,
    coverage: { expected, missing, unreadable, ratio: round2(ratio) },
    blocks,
    understanding: {
      summary,
      evidence,
      transcribed,
    },
    localization: {
      file: asNullableString(localization.file),
      line: asNullableNumber(localization.line),
      symbol: asNullableString(localization.symbol),
      reason: asString(localization.reason),
      confidence: clamp01(asNumber(localization.confidence)),
    },
    solution: {
      steps: asStringArray(solution.steps).slice(0, 12),
      patch: asNullableString(solution.patch),
      verification: asStringArray(solution.verification).slice(0, 10),
      boundaries: asStringArray(solution.boundaries).slice(0, 8),
    },
    needMoreInfo,
    raw: text,
    structured: true,
  }
}

/** 降级结果：保留原文，其他字段留空，前端按纯文本展示。 */
function degrade(raw: string, scene: SceneKind): VisionResult {
  return {
    schemaVersion: 2,
    scene,
    status: raw ? 'partial' : 'unreadable',
    coverage: { expected: null, missing: [], unreadable: [], ratio: 0 },
    blocks: [],
    understanding: { summary: raw, evidence: [], transcribed: [] },
    localization: { file: null, line: null, symbol: null, reason: '', confidence: 0 },
    solution: { steps: [], patch: null, verification: [], boundaries: [] },
    needMoreInfo: [],
    raw,
    structured: false,
  }
}

/** 块归一化：过滤非法类型、补 order、text 统一成 string|null。 */
function normalizeBlocks(input: unknown): VisionBlock[] {
  if (!Array.isArray(input)) return []
  return input
    .filter((b): b is Record<string, unknown> => !!b && typeof b === 'object')
    .map((b, i) => {
      const type = BLOCK_TYPES.includes(b.type as VisionBlock['type']) ? (b.type as VisionBlock['type']) : 'text'
      return {
        type,
        // order 缺失或非数字时退化为数组下标，保证阅读顺序始终可用
        order: typeof b.order === 'number' && Number.isFinite(b.order) ? b.order : i,
        text: asNullableString(b.text),
        rows: asNullableNumber(b.rows),
        cols: asNullableNumber(b.cols),
      }
    })
    .sort((a, b) => a.order - b.order)
    .slice(0, 60)
}

/** 把结果渲染成 Markdown（复制到剪贴板 / 落记录用）。 */
export function toMarkdown(r: VisionResult): string {
  const lines: string[] = []
  lines.push(`### 识别结果（${r.scene} · ${r.status}）`)
  if (r.understanding.summary) lines.push('', `**结论**：${r.understanding.summary}`)
  if (r.understanding.transcribed.length) {
    lines.push('', '**图内文本**')
    r.understanding.transcribed.forEach((t) => lines.push(`- \`${t}\``))
  }
  if (r.understanding.evidence.length) {
    lines.push('', '**依据**')
    r.understanding.evidence.forEach((t) => lines.push(`- ${t}`))
  }
  const loc = r.localization
  if (loc.reason || loc.file || loc.line) {
    lines.push('', '**问题定位**')
    const where = [loc.file, loc.line ? `第 ${loc.line} 行` : null, loc.symbol].filter(Boolean).join(' · ')
    if (where) lines.push(`- 位置：${where}`)
    if (loc.reason) lines.push(`- 原因：${loc.reason}`)
    if (loc.confidence > 0) lines.push(`- 置信度：${Math.round(loc.confidence * 100)}%`)
  }
  if (r.solution.steps.length) {
    lines.push('', '**解决步骤**')
    r.solution.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`))
  }
  if (r.solution.patch) {
    lines.push('', '**改动建议**', '```diff', r.solution.patch.trim(), '```')
  }
  if (r.solution.verification.length) {
    lines.push('', '**验证**')
    r.solution.verification.forEach((s) => lines.push(`- [ ] ${s}`))
  }
  if (r.solution.boundaries.length) {
    lines.push('', '**适用边界**')
    r.solution.boundaries.forEach((s) => lines.push(`- ${s}`))
  }
  if (r.needMoreInfo.length) {
    lines.push('', '**还需要你补充**')
    r.needMoreInfo.forEach((s) => lines.push(`- ${s}`))
  }
  if (r.coverage.ratio > 0.3) {
    lines.push('', `> 覆盖度告警：缺失/读不清 ${r.coverage.missing.length + r.coverage.unreadable.length} 项，建议换更清晰的图。`)
  }
  return lines.join('\n')
}

// ============================================================================
// 小工具：全部做类型窄化，任何异常输入都返回安全默认值
// ============================================================================

function asObject(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function asNullableString(v: unknown): string | null {
  const s = asString(v)
  return s ? s : null
}

function asNumber(v: unknown): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number.parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  return 0
}

function asNullableNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = asNumber(v)
  return Number.isFinite(n) ? n : null
}

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter(Boolean)
  // 模型偶尔把数组写成换行分隔的字符串，按行拆
  if (typeof v === 'string' && v.trim()) return v.split('\n').map((s) => s.replace(/^[-*\d.、\s]+/, '').trim()).filter(Boolean)
  return []
}

function normalizeStatus(v: unknown): VisionStatus | null {
  return v === 'ok' || v === 'partial' || v === 'unreadable' ? v : null
}

function clamp01(n: number): number {
  return isNaN(n) ? 0 : Math.max(0, Math.min(1, n))
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 转写内容是否为空（"无"/"未见" 也算空）。 */
function transcriptionEmpty(list: string[]): boolean {
  return list.length === 0 || (list.length === 1 && /^(无|未见|没有|none)$/i.test(list[0]))
}
