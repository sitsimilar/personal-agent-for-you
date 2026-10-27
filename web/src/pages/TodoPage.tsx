import { useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder'
import BookmarkIcon from '@mui/icons-material/Bookmark'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { InfoRecord, TodoBucket, TodoOrganizeResult } from '@shared/types/domain'
import { recordService } from '@/services/recordService'
import { recurrenceService } from '@/services/recurrenceService'
import { aiService } from '@/services/aiService'
import { pushNotice } from '@/store/noticeStore'
import { describeRecurrence } from '@/lib/recurrence'
import { isSnoozePending } from '@/lib/reminder-schedule'
import { BUCKET_LABELS, bucketCounts, splitByBucket } from '@/lib/todo-segments'
import { friendlyError } from '@/lib/unwrap'
import { categoryColor } from '@shared/constants/categories'
import PageHeader from '@/components/PageHeader'
import RecordDetail from '@/components/RecordDetail'

function formatRemind(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** ISO → 本地 HH:mm（「已推迟至」文案用）；非法返回空串。 */
function formatClock(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

const priorityLabel: Record<string, string> = { high: '高', medium: '中', low: '低' }
const priorityColor: Record<string, 'error' | 'warning' | 'default'> = {
  high: 'error',
  medium: 'warning',
  low: 'default',
}

/** 分段顺序（今天 → 即将 → 某天），与设计文档的展示顺序一致。 */
const BUCKET_ORDER: TodoBucket[] = ['today', 'upcoming', 'someday']

/** 各段空态文案（三段皆空时逐段显示，不渲染空白列表）。 */
const BUCKET_EMPTY_TEXT: Record<TodoBucket, string> = {
  today: '今天没有待办，安心推进其它事',
  upcoming: '暂无即将到期的待办',
  someday: '还没有标记为「某天」的待办',
}

/** 待办视图。 */
export default function TodoPage() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const [records, setRecords] = useState<InfoRecord[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [organizeResult, setOrganizeResult] = useState<TodoOrganizeResult | null>(null)
  const [detail, setDetail] = useState<InfoRecord | null>(null)
  const [todoTotal, setTodoTotal] = useState(0)
  const [todoPage, setTodoPage] = useState(1)
  const [toast, setToast] = useState('')
  /** 当前分段（默认「今天」）。 */
  const [bucket, setBucket] = useState<TodoBucket>('today')
  /** 服务端未完成 / 已完成总数（「共 M 条」用，只发 2 次 head count）。 */
  const [statusCounts, setStatusCounts] = useState<{ pending: number; done: number }>({ pending: 0, done: 0 })
  /** 分段判定基准时刻：随每次加载刷新，保证同一屏内三段划分稳定。 */
  const [nowMs, setNowMs] = useState(() => Date.now())

  const TODO_PAGE_SIZE = 200

  const showToast = (msg: string) => {
    setToast(msg)
    window.setTimeout(() => setToast(''), 3000)
  }

  const load = async (page = 1, append = false) => {
    setLoading(true)
    setError('')
    try {
      const [res, counts] = await Promise.all([
        recordService.listRecords({ type: 'todo', isDeleted: false, page, pageSize: TODO_PAGE_SIZE }),
        recordService.countTodoByStatus(),
      ])
      setRecords((prev) => (append ? [...prev, ...res.records] : res.records))
      setTodoTotal(res.total)
      setTodoPage(page)
      setStatusCounts(counts)
      setNowMs(Date.now())
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setLoading(false)
    }
  }

  const loadMore = () => {
    void load(todoPage + 1, true)
  }

  useEffect(() => {
    load(1)
  }, [])

  /** 已处理的 `?record=` 参数（防清参触发重复处理）。 */
  const handledRecordParam = useRef<string | null>(null)

  // 通知点击 / 外部链接：`/todo?record=<id>` 定位并打开详情（A2）
  useEffect(() => {
    const raw = searchParams.get('record')
    if (!raw) {
      handledRecordParam.current = null
      return
    }
    if (handledRecordParam.current === raw) return
    handledRecordParam.current = raw
    setSearchParams({}, { replace: true })

    const id = Number(raw)
    if (!Number.isInteger(id) || id <= 0) return
    void (async () => {
      try {
        const target = await recordService.getRecord(id)
        if (!target || target.isDeleted) {
          pushNotice('该记录已删除', 'warning')
          return
        }
        setDetail(target)
      } catch {
        pushNotice('该记录已删除', 'warning')
      }
    })()
  }, [searchParams, setSearchParams])

  /** 一键应用合并建议：保留 keep、软删 merge 中其余待办。 */
  const applyMerge = async (g: TodoOrganizeResult['mergeGroups'][number]) => {
    setError('')
    try {
      const keepRec = pending.find((r) => r.title === g.keep)
      const mergeRecs = pending.filter((r) => (g.merge ?? []).includes(r.title) && r.id !== keepRec?.id)
      if (!keepRec || mergeRecs.length === 0) {
        setError('未找到可合并的待办')
        return
      }
      for (const r of mergeRecs) {
        await recordService.softDelete(r.id)
      }
      await load(1)
      showToast(`已合并 ${mergeRecs.length} 条待办`)
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  const toggle = async (r: InfoRecord) => {
    setError('')
    try {
      if (r.todoStatus === 'done') {
        // 取消完成：不回收已生成的下一期，仅提示
        await recordService.updateTodoStatus(r.id, 'pending')
        if (r.recurrenceNextId != null) showToast('下一期已生成，可自行删除')
        await load(1)
        return
      }

      const result = await recurrenceService.completeTodoWithRecurrence(r)
      if (result.duplicated) {
        showToast('该待办已完成，未重复生成')
      } else if (result.ended) {
        showToast('循环已结束，未生成下一期')
      } else if (result.next) {
        showToast(result.writeBackFailed ? '已完成并生成下一期（追溯信息稍后补全）' : '已完成并生成下一期')
      }
      await load(1)
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  /**
   * 切换「某天」标记（R2）：即时写入、无需二次确认。
   * 切换后该待办会立即从原分段消失并出现在新分段（一条待办只有一段归属）。
   */
  const toggleSomeday = async (r: InfoRecord) => {
    setError('')
    const next = !(r.someday === true)
    try {
      await recordService.updateRecord(r.id, { someday: next })
      showToast(next ? '已移到「某天」' : '已移回今天/即将')
      await load(1)
    } catch (err) {
      setError(friendlyError(err))
    }
  }

  const organize = async () => {
    setOrganizing(true)
    setError('')
    setOrganizeResult(null)
    try {
      const result = await aiService.organizeTodos(pending)
      setOrganizeResult(result)
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setOrganizing(false)
    }
  }

  const pending = records.filter((r) => r.todoStatus !== 'done')
  const done = records.filter((r) => r.todoStatus === 'done')
  /** 三段计数（以「已加载集合」为准，恒等于 pending.length）。 */
  const counts = bucketCounts(pending, nowMs)
  /** 三段列表（每条只进一段，不复制）。 */
  const buckets = splitByBucket(pending, nowMs)
  const visible = buckets[bucket]

  /** 加载未完成时提示「已加载 N / 共 M」，避免用户误以为段计数等于全量。 */
  const partial = pending.length < statusCounts.pending

  return (
    <Box sx={{ p: 3, maxWidth: 760, mx: 'auto' }}>
      <PageHeader
        title="待办"
        subtitle="今天 / 即将 / 某天 三段视图，按优先级与截止时间整理"
        action={
          <Stack direction="row" spacing={1} alignItems="center">
            <ToggleButtonGroup
              size="small"
              exclusive
              value={bucket}
              onChange={(_e, next: TodoBucket | null) => {
                if (next) setBucket(next)
              }}
              aria-label="待办分段"
            >
              {BUCKET_ORDER.map((key) => (
                <ToggleButton key={key} value={key} sx={{ px: 1.25, py: 0.25 }}>
                  {BUCKET_LABELS[key]} {counts[key]}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            <Button
              size="small"
              variant="outlined"
              startIcon={<AutoAwesomeIcon />}
              disabled={pending.length === 0 || organizing}
              onClick={() => {
                setOrganizeOpen(true)
                void organize()
              }}
            >
              {organizing ? '整理中…' : '智能整理'}
            </Button>
          </Stack>
        }
      />

      {error && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1 }}>
          <Typography color="error" sx={{ flex: 1 }}>{error}</Typography>
          <Button size="small" startIcon={<RefreshIcon />} onClick={() => load(1)}>
            重试
          </Button>
        </Box>
      )}
      {loading ? (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 8 }}>
          <CircularProgress />
        </Box>
      ) : records.length === 0 ? (
        <Box sx={{ textAlign: 'center', py: 8, color: 'text.secondary' }}>
          <Typography sx={{ mb: 1.5 }}>暂无待办</Typography>
          <Button variant="outlined" startIcon={<AddIcon />} onClick={() => navigate('/')}>
            快速记录
          </Button>
        </Box>
      ) : (
        <>
          {partial && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
              已加载 {pending.length} / 共 {statusCounts.pending} 条未完成待办，分段计数仅统计已加载部分
            </Typography>
          )}

          {visible.length === 0 ? (
            <Box sx={{ textAlign: 'center', py: 6, color: 'text.secondary' }}>
              <Typography variant="body2">{BUCKET_EMPTY_TEXT[bucket]}</Typography>
            </Box>
          ) : (
            <List>
              {visible.map((r) => (
                <ListItem
                  key={r.id}
                  disablePadding
                  secondaryAction={
                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <Tooltip title={r.someday === true ? '取消「某天」' : '标记为「某天」'}>
                        <IconButton
                          size="small"
                          onClick={(e) => {
                            e.stopPropagation()
                            void toggleSomeday(r)
                          }}
                          aria-label={r.someday === true ? '取消某天' : '标记为某天'}
                        >
                          {r.someday === true ? <BookmarkIcon fontSize="small" /> : <BookmarkBorderIcon fontSize="small" />}
                        </IconButton>
                      </Tooltip>
                      <Checkbox
                        edge="end"
                        checked={false}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(r)}
                        inputProps={{ 'aria-label': '标记完成' }}
                      />
                    </Stack>
                  }
                >
                  <ListItemButton onClick={() => setDetail(r)} sx={{ borderRadius: 2 }}>
                    <ListItemText
                      primary={r.title || '（无标题）'}
                      secondary={
                        <Box component="span" sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap', mt: 0.5 }}>
                          {r.category && (
                            <Chip
                              size="small"
                              label={r.category}
                              sx={{ fontSize: 11, bgcolor: `${categoryColor(r.category)}22`, color: categoryColor(r.category) }}
                            />
                          )}
                          {r.priority && (
                            <Chip
                              size="small"
                              label={priorityLabel[r.priority] ?? r.priority}
                              color={priorityColor[r.priority] ?? 'default'}
                              variant="outlined"
                              sx={{ fontSize: 11 }}
                            />
                          )}
                          {r.remindAt && <Typography variant="caption" color="text.secondary">提醒 {formatRemind(r.remindAt)}</Typography>}
                          {/* 只在「推迟时间还没到」时显示：过了就不再残留一条失效的提示 */}
                          {isSnoozePending(r, nowMs) && (
                            <Chip
                              size="small"
                              variant="outlined"
                              color="info"
                              label={`已推迟至 ${formatClock(r.snoozedUntil ?? '')}`}
                              sx={{ fontSize: 11, height: 20 }}
                            />
                          )}
                          {r.recurrence && (
                            <Chip
                              size="small"
                              label={describeRecurrence(r.recurrence, r.remindAt)}
                              variant="outlined"
                              sx={{ fontSize: 11, height: 20 }}
                            />
                          )}
                          {r.recurrenceNextId != null && (
                            <Chip
                              size="small"
                              label={`下一期 #${r.recurrenceNextId}`}
                              variant="outlined"
                              sx={{ fontSize: 11, height: 20 }}
                            />
                          )}
                        </Box>
                      }
                    />
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          )}

          {done.length > 0 && (
            <>
              <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 3, mb: 1 }}>
                已完成（{done.length}）
              </Typography>
              <List>
                {done.map((r) => (
                  <ListItem
                    key={r.id}
                    disablePadding
                    secondaryAction={
                      <Checkbox
                        edge="end"
                        checked={true}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggle(r)}
                        inputProps={{ 'aria-label': '恢复为未完成' }}
                      />
                    }
                  >
                    <ListItemButton onClick={() => setDetail(r)} sx={{ borderRadius: 2, opacity: 0.6 }}>
                      <ListItemText
                        primary={r.title || '（无标题）'}
                        primaryTypographyProps={{ sx: { textDecoration: 'line-through' } }}
                      />
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            </>
          )}
        </>
      )}

      {!loading && records.length < todoTotal && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <Button size="small" variant="outlined" onClick={loadMore}>
            加载更多（剩余 {todoTotal - records.length} 条）
          </Button>
        </Box>
      )}

      {toast && (
        <Box sx={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)' }}>
          <Chip label={toast} color="primary" />
        </Box>
      )}

      <Dialog open={organizeOpen} onClose={() => setOrganizeOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>待办整理建议</DialogTitle>
        <DialogContent dividers>
          {organizing ? (
            <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
              <CircularProgress />
            </Box>
          ) : organizeResult ? (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                {organizeResult.summary || '整理完成'}
              </Typography>

              {organizeResult.mergeGroups.length > 0 && (
                <>
                  <Typography variant="subtitle2" fontWeight={600}>
                    合并建议
                  </Typography>
                  {organizeResult.mergeGroups.map((g, i) => (
                    <Box key={i} sx={{ pl: 1, borderLeft: '3px solid', borderColor: 'warning.main' }}>
                      <Typography variant="body2" fontWeight={600} color="warning.dark">
                        保留：{g.keep}
                      </Typography>
                      {(g.merge ?? []).map((m, j) => (
                        <Typography
                          key={j}
                          variant="caption"
                          color="text.secondary"
                          sx={{ textDecoration: 'line-through', pl: 1 }}
                          display="block"
                        >
                          并入：{m}
                        </Typography>
                      ))}
                      {(g.merge ?? []).length > 0 && (
                        <Button size="small" variant="outlined" onClick={() => void applyMerge(g)} sx={{ mt: 0.5 }}>
                          应用合并
                        </Button>
                      )}
                    </Box>
                  ))}
                </>
              )}

              <Divider />

              <Typography variant="subtitle2" fontWeight={600}>
                整理后清单（按优先级排序）
              </Typography>
              {organizeResult.ordered.length === 0 ? (
                <Typography variant="caption" color="text.secondary">
                  暂无整理结果
                </Typography>
              ) : (
                <List dense disablePadding>
                  {organizeResult.ordered.map((o, i) => (
                    <ListItem
                      key={i}
                      disablePadding
                      secondaryAction={
                        <Chip
                          size="small"
                          label={priorityLabel[o.priority] ?? o.priority}
                          color={priorityColor[o.priority] ?? 'default'}
                          variant="outlined"
                          sx={{ fontSize: 10, height: 18 }}
                        />
                      }
                    >
                      <ListItemText primary={o.title} primaryTypographyProps={{ variant: 'body2' }} />
                    </ListItem>
                  ))}
                </List>
              )}

              <Typography variant="caption" color="text.secondary">
                以上为整理建议，不会自动修改你的待办
              </Typography>
            </Stack>
          ) : (
            <Typography variant="body2" color="text.secondary">
              暂无整理结果
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOrganizeOpen(false)}>关闭</Button>
        </DialogActions>
      </Dialog>

      <RecordDetail
        record={detail}
        open={!!detail}
        onClose={() => setDetail(null)}
        onChanged={load}
        onDeleted={load}
        onOpenRecord={setDetail}
      />
    </Box>
  )
}
