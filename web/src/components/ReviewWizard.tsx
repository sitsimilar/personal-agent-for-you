import { useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  List,
  ListItem,
  ListItemText,
  Stack,
  Step,
  StepLabel,
  Stepper,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
  useMediaQuery,
} from '@mui/material'
import type {
  InfoRecord,
  ReviewWizardInboxItem,
  ReviewWizardProgress,
  ReviewWizardStep,
} from '@shared/types/domain'
import { recordService } from '@/services/recordService'
import { reviewWizardService, type WizardStepData } from '@/services/reviewWizardService'
import {
  FOCUS_COUNT,
  REVIEW_NOTE_SECTIONS,
  STALE_DAYS,
  isProgressExpired,
} from '@/lib/review-wizard'
import { friendlyError } from '@/lib/unwrap'

interface ReviewWizardProps {
  open: boolean
  onClose: () => void
  /** 完成回调：参数为落库后的回顾记录 id。 */
  onFinished?: (recordId: number) => void
}

/** Stepper 的 5 个标签（与正文小节标题同源）。 */
const STEP_LABELS = REVIEW_NOTE_SECTIONS

/** 步骤号 → 索引（Stepper 从 0 开始）。 */
function stepIndex(step: ReviewWizardStep): number {
  return step - 1
}

/**
 * GTD 周回顾向导（v2.13 R5）。
 *
 * 5 步固定流程，每步只做一件事；「下一步」始终可点（允许跳过），
 * 每次切步与「暂时离开」都会把整份进度写进 `settings.review_wizard`（断点续）。
 * AI 建议在第 5 步触发，失败只降级成一句 `Alert`，绝不阻断流程。
 */
export default function ReviewWizard({ open, onClose, onFinished }: ReviewWizardProps) {
  const isMobile = useMediaQuery('(max-width:600px)')

  const [progress, setProgress] = useState<ReviewWizardProgress | null>(null)
  const [settingsId, setSettingsId] = useState<number | null>(null)
  const [data, setData] = useState<WizardStepData | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  /** 上次回顾已过期（>24h 或跨周）：先问用户是否重新开始。 */
  const [expired, setExpired] = useState(false)
  const [ai, setAi] = useState<{ summary: string | null; failed: boolean }>({ summary: null, failed: false })
  const [aiLoading, setAiLoading] = useState(false)

  /** 第 5 步的 AI 建议（失败不抛错、不阻断）。 */
  const loadAi = async (weekRecords: InfoRecord[]) => {
    setAiLoading(true)
    try {
      const result = await reviewWizardService.suggest(weekRecords)
      setAi({ summary: result.summary, failed: result.failed })
    } catch {
      setAi({ summary: null, failed: true })
    } finally {
      setAiLoading(false)
    }
  }

  /** 载入进度 + 收集数据（打开弹窗、以及「重新开始」后都会走）。 */
  const bootstrap = async (forceNew = false) => {
    setLoading(true)
    setError('')
    try {
      const now = Date.now()
      let current: ReviewWizardProgress
      let sid: number | null
      if (forceNew) {
        const loaded = await reviewWizardService.load()
        sid = loaded.settingsId
        current = reviewWizardService.start(now)
        const savedId = await reviewWizardService.save(current, sid)
        sid = savedId
        setExpired(false)
      } else {
        const loaded = await reviewWizardService.load()
        sid = loaded.settingsId
        if (loaded.progress) {
          current = loaded.progress
          setExpired(isProgressExpired(loaded.progress, now))
        } else {
          current = reviewWizardService.start(now)
          sid = await reviewWizardService.save(current, sid)
        }
      }
      setSettingsId(sid)
      setProgress(current)
      const snapshot = await reviewWizardService.collect(current, now)
      setData(snapshot)
      if (current.step === 5) void loadAi(snapshot.weekRecords)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!open) return
    void bootstrap(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  /** 写进度（每次切步 / 离开都写，带新的 updatedAt）。 */
  const persist = async (next: ReviewWizardProgress) => {
    const stamped: ReviewWizardProgress = { ...next, updatedAt: new Date().toISOString() }
    setProgress(stamped)
    try {
      const id = await reviewWizardService.save(stamped, settingsId)
      setSettingsId(id)
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  /** 单步内就地修改（不落库，切步时统一保存）。 */
  const patchLocal = (partial: Partial<ReviewWizardProgress>) => {
    if (!progress) return
    setProgress({ ...progress, ...partial })
  }

  const goTo = async (step: ReviewWizardStep) => {
    if (!progress) return
    setError('')
    await persist({ ...progress, step })
    if (step === 5 && data && !aiLoading) void loadAi(data.weekRecords)
  }

  const leave = async () => {
    if (progress) await persist(progress)
    onClose()
  }

  /** 第 3 步：等待中的处理决定（就地改，完成时才真正删除）。 */
  const setWaitingDecision = (recordId: number, decision: 'keep' | 'delete' | 'skip') => {
    if (!progress) return
    const exists = progress.waiting.some((w) => w.recordId === recordId)
    const waiting = exists
      ? progress.waiting.map((w) => (w.recordId === recordId ? { ...w, decision } : w))
      : [...progress.waiting, { recordId, decision }]
    patchLocal({ waiting })
  }

  /** 第 1 步：收件箱处理决定。 */
  const setInboxDecision = (
    recordId: number,
    decision: ReviewWizardInboxItem['decision'],
    category?: string | null,
  ) => {
    if (!progress) return
    const exists = progress.inbox.some((i) => i.recordId === recordId)
    const item: ReviewWizardInboxItem = { recordId, decision, category: category ?? null }
    const inbox = exists ? progress.inbox.map((i) => (i.recordId === recordId ? item : i)) : [...progress.inbox, item]
    patchLocal({ inbox })
  }

  /** 第 2 步：某分类的下一步行动文本。 */
  const setNextAction = (category: string, text: string) => {
    if (!progress) return
    const exists = progress.nextActions.some((a) => a.category === category)
    const nextActions = exists
      ? progress.nextActions.map((a) => (a.category === category ? { ...a, text } : a))
      : [...progress.nextActions, { category, text }]
    patchLocal({ nextActions })
  }

  /** 第 4 步：确认某分类的搁置状态。 */
  const setAcknowledged = (category: string, acknowledged: boolean) => {
    if (!progress) return
    const exists = progress.health.some((h) => h.category === category)
    const health = exists
      ? progress.health.map((h) => (h.category === category ? { ...h, acknowledged } : h))
      : [...progress.health, { category, acknowledged }]
    patchLocal({ health })
  }

  /** 第 5 步：修改第 N 个焦点。 */
  const setFocus = (index: number, text: string) => {
    if (!progress) return
    const focus = Array.from({ length: FOCUS_COUNT }, (_, i) => (i === index ? text : progress.focus[i] ?? ''))
    patchLocal({ focus })
  }

  /** 完成：应用第 3 步删除决定 → 落回顾记录 + 焦点待办 → 清空进度。 */
  const finish = async () => {
    if (!progress) return
    setBusy(true)
    setError('')
    try {
      for (const item of progress.waiting) {
        if (item.decision === 'delete') await recordService.softDelete(item.recordId)
      }
      const stats = {
        inbox: data?.inbox.length ?? 0,
        waiting: data?.waiting.length ?? 0,
        stale: data?.staleCategories ?? [],
        aiSummary: ai.summary,
        aiFailed: ai.failed,
      }
      // settingsId 用于落库后立刻回写 completedRecordId（幂等：重试不会重复建回顾记录）
      const recordId = await reviewWizardService.finish({ ...progress, aiFailed: ai.failed }, stats, settingsId)
      await reviewWizardService.clear(settingsId)
      onFinished?.(recordId)
      onClose()
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  const step: ReviewWizardStep = progress?.step ?? 1
  const waitingList = data?.waiting ?? []
  const inboxList = data?.inbox ?? []
  const categoryList = data?.categories ?? []
  const staleList = data?.staleCategories ?? []

  return (
    <Dialog open={open} onClose={leave} fullWidth maxWidth="md" fullScreen={isMobile}>
      <DialogTitle>周回顾（5 步）</DialogTitle>
      <DialogContent dividers>
        <Stepper activeStep={stepIndex(step)} alternativeLabel={!isMobile} orientation={isMobile ? 'vertical' : 'horizontal'}>
          {STEP_LABELS.map((label) => (
            <Step key={label}>
              <StepLabel>{label}</StepLabel>
            </Step>
          ))}
        </Stepper>

        {expired && (
          <Alert
            severity="warning"
            sx={{ mt: 2 }}
            action={
              <Button color="inherit" size="small" onClick={() => void bootstrap(true)}>
                重新开始
              </Button>
            }
          >
            上次回顾已过期（超过 24 小时或已跨周），可继续在原进度上修改，或重新开始。
          </Alert>
        )}

        {loading && (
          <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
            正在准备本周期数据…
          </Typography>
        )}

        {!loading && progress && (
          <Box sx={{ mt: 2 }}>
            {step === 1 && (
              <Stack spacing={1.5}>
                <Typography variant="body2" color="text.secondary">
                  本周期新增且无分类、无标签的记录（{inboxList.length} 条）。逐条归入分类或归档即可。
                </Typography>
                {inboxList.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    收件箱已经清空，可以直接进入下一步。
                  </Typography>
                ) : (
                  <List dense disablePadding>
                    {inboxList.map((record) => {
                      const item = progress.inbox.find((i) => i.recordId === record.id)
                      return (
                        <Box key={record.id} sx={{ py: 0.5 }}>
                          <ListItem disablePadding>
                            <ListItemText
                              primary={record.title || '（无标题）'}
                              secondary={record.content?.slice(0, 60) || undefined}
                              secondaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                            />
                            <ToggleButtonGroup
                              size="small"
                              exclusive
                              value={item?.decision ?? null}
                              onChange={(_e, v: ReviewWizardInboxItem['decision'] | null) => {
                                if (v) setInboxDecision(record.id, v, item?.category ?? null)
                              }}
                            >
                              <ToggleButton value="assign">归入分类</ToggleButton>
                              <ToggleButton value="archive">归档</ToggleButton>
                              <ToggleButton value="skip">跳过</ToggleButton>
                            </ToggleButtonGroup>
                          </ListItem>
                          {item?.decision === 'assign' && (
                            <TextField
                              size="small"
                              label="分类"
                              value={item.category ?? ''}
                              onChange={(e) => setInboxDecision(record.id, 'assign', e.target.value)}
                              sx={{ mt: 0.5, maxWidth: 240 }}
                            />
                          )}
                        </Box>
                      )
                    })}
                  </List>
                )}
                <Typography variant="caption" color="text.secondary">
                  小提示：这一步只记录你的决定，正文会写明各决定的条数。
                </Typography>
              </Stack>
            )}

            {step === 2 && (
              <Stack spacing={1.5}>
                <Typography variant="body2" color="text.secondary">
                  为本周期涉及的分类各写一条「下一步行动」（只写进回顾正文，不会创建待办）。
                </Typography>
                {categoryList.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    本周期还没有分类记录，可跳过本步。
                  </Typography>
                ) : (
                  categoryList.map((category) => (
                    <TextField
                      key={category}
                      size="small"
                      label={category}
                      placeholder="下一步做什么？"
                      value={progress.nextActions.find((a) => a.category === category)?.text ?? ''}
                      onChange={(e) => setNextAction(category, e.target.value)}
                    />
                  ))
                )}
              </Stack>
            )}

            {step === 3 && (
              <Stack spacing={1.5}>
                <Typography variant="body2" color="text.secondary">
                  被标记「某天」或已逾期的待办（{waitingList.length} 条）。保留的留在待办里，删除的会在完成时移入回收站。
                </Typography>
                {waitingList.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    没有搁置或逾期的待办，可跳过本步。
                  </Typography>
                ) : (
                  <List dense disablePadding>
                    {waitingList.map((todo) => {
                      const decision = progress.waiting.find((w) => w.recordId === todo.id)?.decision ?? 'skip'
                      return (
                        <ListItem
                          key={todo.id}
                          disablePadding
                          secondaryAction={
                            <ToggleButtonGroup
                              size="small"
                              exclusive
                              value={decision}
                              onChange={(_e, v: 'keep' | 'delete' | 'skip' | null) => {
                                if (v) setWaitingDecision(todo.id, v)
                              }}
                            >
                              <ToggleButton value="keep">保留</ToggleButton>
                              <ToggleButton value="delete">删除</ToggleButton>
                              <ToggleButton value="skip">跳过</ToggleButton>
                            </ToggleButtonGroup>
                          }
                        >
                          <ListItemText
                            primary={todo.title || '（无标题）'}
                            secondary={todo.someday ? '标记为某天' : '已逾期'}
                            secondaryTypographyProps={{ variant: 'caption', color: 'text.secondary' }}
                          />
                        </ListItem>
                      )
                    })}
                  </List>
                )}
              </Stack>
            )}

            {step === 4 && (
              <Stack spacing={1.5}>
                <Typography variant="body2" color="text.secondary">
                  超过 {STALE_DAYS} 天没有更新的分类（{staleList.length} 个）。确认后打个勾，代表你知道它搁置了。
                </Typography>
                {staleList.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    所有分类都在 {STALE_DAYS} 天内更新过，很健康。
                  </Typography>
                ) : (
                  <List dense disablePadding>
                    {staleList.map((category) => {
                      const ack = progress.health.find((h) => h.category === category)?.acknowledged === true
                      return (
                        <ListItem key={category} disablePadding>
                          <FormControlLabel
                            control={
                              <Checkbox
                                size="small"
                                checked={ack}
                                onChange={(e) => setAcknowledged(category, e.target.checked)}
                              />
                            }
                            label={`${category}（超过 ${STALE_DAYS} 天未更新）`}
                          />
                        </ListItem>
                      )
                    })}
                  </List>
                )}
              </Stack>
            )}

            {step === 5 && (
              <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">
                  写下下周最重要的三件事，完成后会各创建一条高优先级待办。
                </Typography>
                {Array.from({ length: FOCUS_COUNT }, (_, i) => (
                  <TextField
                    key={i}
                    size="small"
                    label={`焦点 ${i + 1}`}
                    value={progress.focus[i] ?? ''}
                    onChange={(e) => setFocus(i, e.target.value)}
                  />
                ))}

                <Divider />

                {aiLoading ? (
                  <Typography variant="body2" color="text.secondary">
                    正在生成建议…
                  </Typography>
                ) : ai.failed ? (
                  <Alert severity="warning">本次未能生成建议，不影响回顾记录的生成。</Alert>
                ) : ai.summary ? (
                  <Alert severity="info">
                    <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                      {ai.summary}
                    </Typography>
                  </Alert>
                ) : (
                  <Alert severity="info">本周期记录较少，本次没有额外建议。</Alert>
                )}
              </Stack>
            )}
          </Box>
        )}

        {error && (
          <Typography color="error" variant="body2" sx={{ mt: 2 }}>
            {error}
          </Typography>
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={leave} sx={{ mr: 'auto' }} disabled={busy}>
          暂时离开
        </Button>
        <Button
          variant="outlined"
          disabled={step === 1 || busy}
          onClick={() => void goTo((step - 1) as ReviewWizardStep)}
        >
          上一步
        </Button>
        {step < 5 ? (
          <Button variant="contained" disabled={busy} onClick={() => void goTo((step + 1) as ReviewWizardStep)}>
            下一步
          </Button>
        ) : (
          <Button variant="contained" disabled={busy} onClick={finish}>
            {busy ? '生成中…' : '生成回顾记录'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
