/**
 * 截图识别面板（机器视觉模块的 UI）
 * ============================================================================
 * 相比上一版，界面上多了四件事：
 * 1. **多图（≤5）+ 拖拽/粘贴**：报错截图 + 界面截图一起给，模型能对照；
 * 2. **预检徽标**：送模型之前就告诉你「图1 判定为代码 · 清晰度 fair · 2.4MB→186KB」，
 *    糊图/眩光图在这里就能拦下，不用等一次失败；
 * 3. **代码框**：把出问题的代码贴进来，模型才能做"图 ↔ 代码"的定位；
 * 4. **三段式结果**：输入理解 / 问题定位 / 解决方案 分栏展示，取代一坨大段文字。
 *
 * 交互约定：
 * - 点「识别」时如果预检结果还在（同一批文件），直接复用，不重复解码；
 * - 任何一步失败都只影响当前操作，不清空已选图片。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  MenuItem,
  Paper,
  Select,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material'
import UploadIcon from '@mui/icons-material/Upload'
import DeleteIcon from '@mui/icons-material/Delete'
import ContentCopyIcon from '@mui/icons-material/ContentCopy'
import { friendlyError } from '@/lib/unwrap'
import { visionService, type VisionCallResult, type VisionMetrics } from '@/services/visionService'
import { MAX_IMAGES, SCENE_LABEL, toMarkdown, type PreparedBundle, type SceneKind, type VisionResult } from '@/lib/vision'

/** 已选图片（保留 File 以便重新预处理；preview 用于缩略图）。 */
interface Item {
  id: string
  file: File
  preview: string
}

/** 单张图允许的最大体积（与 P1-11 的输入约束一致：10MB）。 */
const MAX_FILE_BYTES = 10 * 1024 * 1024

/** 可选场景（用户手动纠正分类）。 */
const SCENE_OPTIONS: SceneKind[] = ['code', 'error', 'ui', 'table', 'chart', 'document', 'diagram', 'chat', 'photo', 'handwriting', 'unknown']

export default function ScreenshotPanel() {
  const [items, setItems] = useState<Item[]>([])
  const [code, setCode] = useState('')
  const [context, setContext] = useState('')
  const [question, setQuestion] = useState('')
  const [sceneOverride, setSceneOverride] = useState<SceneKind | ''>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [outcome, setOutcome] = useState<VisionCallResult | null>(null)
  /** 预检结果（只在文件集合未变时有效，key 用 id 串）。 */
  const [preview, setPreview] = useState<{ key: string; bundle: PreparedBundle; notes: string[] } | null>(null)
  const [preparing, setPreparing] = useState(false)
  const fileRef = useRef<HTMLInputElement | null>(null)
  /** 卸载时要用最新的 items 释放 URL，闭包里的 items 会停留在首帧，故用 ref 同步。 */
  const itemsRef = useRef<Item[]>(items)
  itemsRef.current = items

  const idsKey = useMemo(() => items.map((i) => i.id).join(','), [items])

  // ---- 文件接入：文件选择 / 拖拽 / 粘贴三条路径统一走这里 ----
  const addFiles = (files: File[]) => {
    setError('')
    setNotice('')
    const room = MAX_IMAGES - items.length
    if (room <= 0) {
      setError(`一次最多分析 ${MAX_IMAGES} 张图`)
      return
    }
    const accepted: Item[] = []
    const rejected: string[] = []
    for (const f of files.slice(0, room)) {
      // 只校验"看起来是图片"，真实格式由解码阶段按魔数判定（扩展名不可信）
      if (!f.type.startsWith('image/') && !/\.(png|jpe?g|webp|gif|bmp|avif|heic|tiff?)$/i.test(f.name)) {
        rejected.push(`${f.name}：不是图片`)
        continue
      }
      if (f.size > MAX_FILE_BYTES) {
        rejected.push(`${f.name}：超过 10MB`)
        continue
      }
      accepted.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, file: f, preview: URL.createObjectURL(f) })
    }
    if (accepted.length > 0) setItems((prev) => [...prev, ...accepted])
    if (rejected.length > 0) setError(rejected.join('；'))
    if (files.length > room) setNotice(`只接收了前 ${room} 张（上限 ${MAX_IMAGES} 张）`)
  }

  const removeItem = (id: string) => {
    setItems((prev) => {
      const target = prev.find((i) => i.id === id)
      if (target) URL.revokeObjectURL(target.preview)
      return prev.filter((i) => i.id !== id)
    })
    setOutcome(null)
  }

  // ---- 预检：文件集合变化后 350ms 跑一次（防抖，避免连续拖 3 张时跑 3 次）----
  useEffect(() => {
    if (items.length === 0) {
      setPreview(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      setPreparing(true)
      try {
        const r = await visionService.prepare(items.map((i) => i.file))
        if (cancelled) return
        setPreview({ key: idsKey, bundle: r.bundle, notes: r.failures.map((f) => `${f.name}：${f.reason}`) })
      } catch (err) {
        if (!cancelled) setPreview(null)
        void err
      } finally {
        if (!cancelled) setPreparing(false)
      }
    }, 350)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [idsKey, items])

  // ---- 粘粘贴支持：截图后直接 Ctrl+V ----
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
    // 不写依赖数组：监听本身很便宜（一次 add/remove），换来 onPaste 永远闭包到最新 items
  })

  // ---- 组件卸载时释放缩略图 URL ----
  // 只在卸载时执行一次：逐项删除时由 removeItem 负责释放，避免重复 revoke。
  useEffect(() => {
    return () => itemsRef.current.forEach((i) => URL.revokeObjectURL(i.preview))
  }, [])

  const analyze = async () => {
    if (items.length === 0 || busy) return
    setBusy(true)
    setError('')
    setNotice('')
    setOutcome(null)
    try {
      const request = {
        images: items.map((i) => i.file),
        code,
        context,
        question,
        sceneOverride: sceneOverride || undefined,
      }
      // 预检结果与当前文件集合一致 → 复用，省一次解码/压缩
      const r =
        preview && preview.key === idsKey
          ? { ...(await visionService.analyzeBundle(preview.bundle, request, 0)), failures: [], bundle: preview.bundle }
          : await visionService.analyze(request)
      setOutcome(r as VisionCallResult)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  const copyMarkdown = async () => {
    if (!outcome) return
    try {
      await navigator.clipboard.writeText(toMarkdown(outcome.result))
      setNotice('已复制为 Markdown')
    } catch {
      setError('复制失败（浏览器未授予剪贴板权限）')
    }
  }

  const bundle = outcome?.bundle ?? preview?.bundle ?? null
  const notes = outcome?.failures.map((f) => `${f.name}：${f.reason}`) ?? preview?.notes ?? []

  return (
    <Box
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        addFiles(Array.from(e.dataTransfer.files ?? []))
      }}
    >
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />

      {/* ---- 选图区 ---- */}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button size="small" variant="outlined" startIcon={<UploadIcon />} onClick={() => fileRef.current?.click()} className="companion-no-drag">
          {items.length ? '继续添加' : '上传截图'}
        </Button>
        <Typography variant="caption" color="text.secondary">
          可拖拽或直接 Ctrl+V 粘贴，最多 {MAX_IMAGES} 张
        </Typography>
        {preparing && <CircularProgress size={14} />}
      </Stack>

      {/* ---- 缩略图 + 预检徽标 ---- */}
      {items.length > 0 && (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {items.map((it) => {
            const img = bundle?.images.find((b) => b.label === `图${items.findIndex((x) => x.id === it.id) + 1}`)
            return (
              <Paper key={it.id} variant="outlined" sx={{ p: 0.75, width: 132, position: 'relative' }}>
                <Box
                  component="img"
                  src={it.preview}
                  alt={it.file.name}
                  sx={{ width: '100%', height: 78, objectFit: 'cover', borderRadius: 0.5, bgcolor: 'grey.100' }}
                />
                <Stack direction="row" spacing={0.25} alignItems="center" sx={{ mt: 0.5 }}>
                  <Typography variant="caption" noWrap sx={{ flex: 1, fontSize: 11 }} title={it.file.name}>
                    {it.file.name}
                  </Typography>
                  <Tooltip title="移除">
                    <IconButton size="small" onClick={() => removeItem(it.id)} sx={{ p: 0.25 }}>
                      <DeleteIcon sx={{ fontSize: 14 }} />
                    </IconButton>
                  </Tooltip>
                </Stack>
                {img && (
                  <Stack direction="row" spacing={0.25} flexWrap="wrap" useFlexGap sx={{ mt: 0.25 }}>
                    <Chip size="small" label={SCENE_LABEL[img.scene]} sx={{ height: 16, fontSize: 10 }} />
                    <Tooltip title={img.quality.issues.map((i) => i.message).join('；') || '未发现质量问题'}>
                      <Chip
                        size="small"
                        label={`${img.quality.verdict} ${img.quality.score}`}
                        color={img.quality.verdict === 'good' ? 'success' : img.quality.verdict === 'fair' ? 'warning' : 'error'}
                        sx={{ height: 16, fontSize: 10 }}
                      />
                    </Tooltip>
                  </Stack>
                )}
              </Paper>
            )
          })}
        </Stack>
      )}

      {/* ---- 质量问题提示（有才显示）---- */}
      {bundle &&
        bundle.images.flatMap((img) =>
          img.quality.issues.map((issue) => (
            <Alert key={`${img.label}-${issue.code}`} severity={img.quality.verdict === 'poor' ? 'error' : 'warning'} sx={{ py: 0.25 }}>
              <Typography variant="caption">
                {img.label}：{issue.message} {issue.advice}
              </Typography>
            </Alert>
          )),
        )}

      {/* ---- 代码 / 上下文 / 问题 ---- */}
      <TextField
        size="small"
        fullWidth
        multiline
        minRows={2}
        maxRows={8}
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="把相关代码贴进来（可选）：模型会按图里的报错定位到具体行，并给最小改动"
        inputProps={{ style: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: 12 } }}
      />
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        <TextField size="small" fullWidth value={context} onChange={(e) => setContext(e.target.value)} placeholder="补充上下文（可选），如：这是登录页，点提交后报错" />
        <TextField size="small" fullWidth value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="你的问题（可选），如：为什么一直提示 401？" />
      </Stack>

      <Stack direction="row" spacing={1} alignItems="center">
        <Select
          size="small"
          value={sceneOverride}
          onChange={(e) => setSceneOverride(e.target.value as SceneKind | '')}
          displayEmpty
          sx={{ minWidth: 128, height: 32, fontSize: 13 }}
        >
          <MenuItem value="">自动判定场景</MenuItem>
          {SCENE_OPTIONS.map((s) => (
            <MenuItem key={s} value={s} sx={{ fontSize: 13 }}>
              {SCENE_LABEL[s]}
            </MenuItem>
          ))}
        </Select>
        <Button size="small" variant="contained" onClick={analyze} disabled={items.length === 0 || busy} className="companion-no-drag">
          {busy ? '识别中…' : '识别'}
        </Button>
        {outcome && (
          <Button size="small" variant="text" startIcon={<ContentCopyIcon />} onClick={copyMarkdown}>
            复制
          </Button>
        )}
      </Stack>

      {error && (
        <Typography variant="caption" color="error">
          {error}
        </Typography>
      )}
      {notice && (
        <Typography variant="caption" color="text.secondary">
          {notice}
        </Typography>
      )}
      {notes.length > 0 && (
        <Typography variant="caption" color="warning.main">
          {notes.join('；')}
        </Typography>
      )}

      {outcome && <ResultView result={outcome.result} metrics={outcome.metrics} bundle={outcome.bundle} />}
    </Box>
  )
}

/** 三段式结果展示。 */
function ResultView({ result, metrics, bundle }: { result: VisionResult; metrics: VisionMetrics; bundle: PreparedBundle }) {
  const r = result
  const compression = bundle.metrics.bytesAfter / Math.max(1, bundle.metrics.bytesBefore)
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <Divider />
      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
        <Chip size="small" label={`场景 ${SCENE_LABEL[r.scene]}`} />
        <Chip
          size="small"
          label={r.status === 'ok' ? '识别完整' : r.status === 'partial' ? '部分可读' : '不可读'}
          color={r.status === 'ok' ? 'success' : r.status === 'partial' ? 'warning' : 'error'}
        />
        {r.coverage.ratio > 0.3 && <Chip size="small" color="warning" label={`缺 ${r.coverage.missing.length + r.coverage.unreadable.length} 项`} />}
        {metrics.cacheHit && <Chip size="small" label="缓存命中" />}
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto !important' }}>
          {metrics.prepMs}ms 预处理 · {metrics.llmMs}ms 模型 · {Math.round(compression * 100)}% 体积
          {metrics.retries > 0 ? ` · 重试 ${metrics.retries}` : ''}
        </Typography>
      </Stack>

      {!r.structured && (
        <Alert severity="info" sx={{ py: 0.25 }}>
          <Typography variant="caption">模型没有按结构返回，下面是原文（可点「复制」后手动整理）</Typography>
        </Alert>
      )}

      <Section title="① 输入理解">
        {r.understanding.summary ? <Typography variant="body2">{r.understanding.summary}</Typography> : <Muted text="未给出结论" />}
        {r.understanding.transcribed.length > 0 && (
          <Box sx={{ mt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              图内文本
            </Typography>
            <Box component="pre" sx={{ m: 0, p: 0.75, bgcolor: 'grey.50', borderRadius: 0.5, fontSize: 11, overflow: 'auto', maxHeight: 160 }}>
              {r.understanding.transcribed.join('\n')}
            </Box>
          </Box>
        )}
        {r.understanding.evidence.length > 0 && (
          <Box sx={{ mt: 0.5 }}>
            {r.understanding.evidence.map((e, i) => (
              <Typography key={i} variant="caption" display="block" color="text.secondary">
                · {e}
              </Typography>
            ))}
          </Box>
        )}
      </Section>

      <Section title="② 问题定位">
        {r.localization.file || r.localization.line || r.localization.symbol ? (
          <Typography variant="body2" sx={{ fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }}>
            {[r.localization.file, r.localization.line ? `第 ${r.localization.line} 行` : null, r.localization.symbol]
              .filter(Boolean)
              .join(' · ')}
          </Typography>
        ) : (
          <Muted text="未定位到具体位置" />
        )}
        {r.localization.reason && <Typography variant="caption" display="block" color="text.secondary">{r.localization.reason}</Typography>}
        {r.localization.confidence > 0 && (
          <Typography variant="caption" color={r.localization.confidence < 0.5 ? 'warning.main' : 'text.secondary'}>
            置信度 {Math.round(r.localization.confidence * 100)}%
            {r.localization.confidence < 0.5 ? '（偏低，建议补代码或局部截图）' : ''}
          </Typography>
        )}
      </Section>

      <Section title="③ 解决方案">
        {r.solution.steps.length > 0 ? (
          <Box component="ol" sx={{ m: 0, pl: 2.5 }}>
            {r.solution.steps.map((s, i) => (
              <Typography key={i} component="li" variant="body2" sx={{ mb: 0.25 }}>
                {s}
              </Typography>
            ))}
          </Box>
        ) : (
          <Muted text="未给出步骤" />
        )}
        {r.solution.patch && (
          <Box component="pre" sx={{ m: 0, mt: 0.5, p: 0.75, bgcolor: 'grey.50', borderRadius: 0.5, fontSize: 11, overflow: 'auto', maxHeight: 220 }}>
            {r.solution.patch}
          </Box>
        )}
        {r.solution.verification.length > 0 && (
          <Box sx={{ mt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              验证
            </Typography>
            {r.solution.verification.map((v, i) => (
              <Typography key={i} variant="caption" display="block">
                ☐ {v}
              </Typography>
            ))}
          </Box>
        )}
        {r.solution.boundaries.length > 0 && (
          <Box sx={{ mt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              适用边界
            </Typography>
            {r.solution.boundaries.map((b, i) => (
              <Typography key={i} variant="caption" display="block" color="text.secondary">
                · {b}
              </Typography>
            ))}
          </Box>
        )}
      </Section>

      {r.needMoreInfo.length > 0 && (
        <Alert severity="info" sx={{ py: 0.25 }}>
          <Typography variant="caption">还需要你补充：{r.needMoreInfo.join('；')}</Typography>
        </Alert>
      )}
    </Box>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box>
      <Typography variant="caption" sx={{ fontWeight: 600, color: 'text.secondary' }}>
        {title}
      </Typography>
      <Box sx={{ pl: 0.25 }}>{children}</Box>
    </Box>
  )
}

function Muted({ text }: { text: string }) {
  return (
    <Typography variant="caption" color="text.disabled">
      {text}
    </Typography>
  )
}
