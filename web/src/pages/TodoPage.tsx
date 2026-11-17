import { useEffect, useRef, useState } from 'react'
import {
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  List,
  ListItem,
  ListItemText,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import AutoAwesomeIcon from '@mui/icons-material/AutoAwesome'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { InfoRecord, TodoBucket, TodoOrganizeResult } from '@shared/types/domain'
import { recordService } from '@/services/recordService'
import { recurrenceService } from '@/services/recurrenceService'
import { aiService } from '@/services/aiService'
import { pushNotice } from '@/store/noticeStore'
import { BUCKET_LABELS, bucketCounts, isImportantTodo, splitByBucket } from '@/lib/todo-segments'
import { friendlyError } from '@/lib/unwrap'
import PageHeader from '@/components/PageHeader'
import RecordDetail from '@/components/RecordDetail'
import PageShell from '@/components/PageShell'
import SkeletonList from '@/components/ui/SkeletonList'
import EmptyState from '@/components/ui/EmptyState'
import GeoMark from '@/components/ui/GeoMark'
import TodoRow from '@/components/TodoRow'
import { useUiSchemeStore } from '@/store/uiSchemeStore'

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
  /**
   * 勾选乐观反馈（仅流畅方案）：点下的一瞬间先把这一行标成"已完成"，
   * 后台落库完成后再由 `load()` 用真实数据替换。落库失败则从集合里移除，视觉自动回滚。
   *
   * 注意这里**不动数据**：`records` 仍是服务端权威列表，只是渲染时叠了一层临时态，
   * 所以不会出现"视觉说完成了、数据没完成"的永久不一致（`load()` 一刷新就对齐）。
   */
  const [optimisticDone, setOptimisticDone] = useState<Set<number>>(() => new Set())
  const scheme = useUiSchemeStore((s) => s.scheme)
  const fluid = scheme === 'fluid'
  const [organizeOpen, setOrganizeOpen] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [organizeResult, setOrganizeResult] = useState<TodoOrganizeResult | null>(null)
  const [detail, setDetail] = useState<InfoRecord | null>(null)
  const [todoTotal, setTodoTotal] = useState(0)
  const [todoPage, setTodoPage] = useState(1)
  const [toast, setToast] = useState('')
  /** 当前分段（默认「今天」）。 */
  const [bucket, setBucket] = useState<TodoBucket>('today')
  /**
   * 只看「重要」（v2.14 P0-2）：`priority='high'` 或今天到期。
   *
   * 故意做成**与界面方案无关**的数据筛选（口径在 `lib/todo-segments.ts` 的纯函数里），
   * 所以 silent / zoned / fluid 三套方案看到的分段计数完全一致。
   */
  const [importantOnly, setImportantOnly] = useState(false)
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
   * 勾选入口（流畅方案下带同帧乐观反馈，其余方案保持原行为）。
   *
   * 之所以包一层而不改 `toggle` 内部：`toggle` 里还挂着循环任务生成下一期、
   * 幂等提示等副作用，乐观层只负责"眼睛先看到"，落库语义一律不动。
   */
  const handleToggleClick = (r: InfoRecord) => {
    if (fluid) {
      setOptimisticDone((prev) => new Set(prev).add(r.id))
    }
    void toggle(r).finally(() => {
      setOptimisticDone((prev) => {
        if (!prev.has(r.id)) return prev
        const next = new Set(prev)
        next.delete(r.id)
        return next
      })
    })
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
  /** 「重要」条数（未筛选时随时可见，让用户知道点下去有多少条）。 */
  const importantCount = pending.filter((r) => isImportantTodo(r, nowMs)).length
  /** 分段与计数一律基于**筛选后**的集合，两处同源故不会互相矛盾。 */
  const visiblePending = importantOnly ? pending.filter((r) => isImportantTodo(r, nowMs)) : pending
  /** 三段计数（以「已加载集合」为准，恒等于 visiblePending.length）。 */
  const counts = bucketCounts(visiblePending, nowMs)
  /** 三段列表（每条只进一段，不复制）。 */
  const buckets = splitByBucket(visiblePending, nowMs)
  const visible = buckets[bucket]

  /** 加载未完成时提示「已加载 N / 共 M」，避免用户误以为段计数等于全量。 */
  const partial = pending.length < statusCounts.pending
  const bucketEmpty = importantOnly ? '当前分段没有「重要」待办（高优先级或今天到期）' : BUCKET_EMPTY_TEXT[bucket]

  return (
    <PageShell tone="list" baseWidth={900}>
      <PageHeader
        title="待办"
        subtitle="今天 / 即将 / 某天 三段视图，按优先级与截止时间整理"
        action={
          // flexWrap：375 档「重要 + 三段切换 + 智能整理」一行放不下，
          // 不换行会顶出 main 内部横向滚动（§八 第 2 项要求 =0，11-09 实测 +7px）
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap justifyContent="flex-end">
            <Chip
              size="small"
              clickable
              variant="outlined"
              label={`重要 ${importantCount}`}
              aria-pressed={importantOnly}
              onClick={() => setImportantOnly((prev) => !prev)}
              sx={{
                borderColor: importantOnly ? 'var(--brand)' : 'var(--line2)',
                bgcolor: importantOnly ? 'var(--brand-soft)' : 'transparent',
                color: importantOnly ? 'primary.main' : 'text.secondary',
                '&:hover': { bgcolor: 'var(--brand-soft)' },
              }}
            />
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
                <ToggleButton key={key} value={key} sx={{ px: 1.25, py: 0.25, gap: 0.75 }}>
                  <Box component="span">{BUCKET_LABELS[key]}</Box>
                  <Box
                    component="span"
                    sx={{ fontSize: 10.5, fontVariantNumeric: 'tabular-nums', opacity: 0.7, lineHeight: 1 }}
                  >
                    {counts[key]}
                  </Box>
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
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mb: 1.5,
            px: 1.5,
            py: 1,
            border: '1px dashed var(--line2)',
            borderRadius: 'var(--r-ctl)',
          }}
        >
          <Typography color="error" sx={{ flex: 1, fontSize: 'var(--fs-meta)' }}>
            {error}
          </Typography>
          <Button size="small" startIcon={<RefreshIcon />} onClick={() => load(1)}>
            重试
          </Button>
        </Box>
      )}

      {loading ? (
        fluid ? (
          <SkeletonList rows={5} rowHeight={60} />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 8 }}>
            <Box className="geo-spinner" />
            <Typography sx={{ fontSize: 'var(--fs-meta)', color: 'text.secondary' }}>正在载入待办</Typography>
          </Box>
        )
      ) : records.length === 0 ? (
        <EmptyState
          title="暂无待办"
          description="想到要做的事，先记下来，再在今天 / 即将 / 某天之间整理。"
          action={
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => navigate('/')}>
              快速记录
            </Button>
          }
        />
      ) : (
        <>
          {partial && (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                mb: 1.5,
                px: 1.5,
                py: 0.75,
                border: 'var(--stroke) solid var(--line)',
                borderRadius: 'var(--r-ctl)',
                bgcolor: 'var(--surface)',
              }}
            >
              <Box
                aria-hidden
                sx={{ width: 'var(--geo-dot)', height: 'var(--geo-dot)', borderRadius: '50%', bgcolor: 'var(--warning)' }}
              />
              <Typography sx={{ fontSize: 'var(--fs-caption)', color: 'text.secondary' }}>
                已加载 {pending.length} / 共 {statusCounts.pending} 条未完成待办，分段计数仅统计已加载部分
              </Typography>
            </Box>
          )}

          {visible.length === 0 ? (
            <EmptyState
              compact
              title={bucketEmpty}
              description={importantOnly ? '「重要」筛选只看高优先级与今天到期的待办。' : undefined}
              action={
                importantOnly ? (
                  <Button size="small" variant="outlined" onClick={() => setImportantOnly(false)}>
                    取消筛选
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Stack spacing={1} data-todo-list="pending">
              {visible.map((r, index) => (
                <TodoRow
                  key={r.id}
                  record={r}
                  nowMs={nowMs}
                  index={index}
                  optimistic={optimisticDone.has(r.id)}
                  onOpen={() => setDetail(r)}
                  onToggle={() => handleToggleClick(r)}
                  onToggleSomeday={() => void toggleSomeday(r)}
                />
              ))}
            </Stack>
          )}

          {done.length > 0 && (
            <>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mt: 3.5, mb: 1.25 }}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, color: 'text.secondary' }}>
                  已完成
                </Typography>
                <Typography component="span" sx={{ fontSize: 'var(--fs-caption)', color: 'text.secondary' }}>
                  {done.length}
                </Typography>
                <Box aria-hidden sx={{ flex: 1, height: 'var(--stroke)', bgcolor: 'var(--line)' }} />
              </Box>
              <Stack spacing={1} data-todo-list="done">
                {done.map((r, index) => (
                  <TodoRow
                    key={r.id}
                    record={r}
                    nowMs={nowMs}
                    index={index}
                    onOpen={() => setDetail(r)}
                    onToggle={() => void toggle(r)}
                  />
                ))}
              </Stack>
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
        <Box
          role="status"
          sx={{
            position: 'fixed',
            bottom: 24,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: (t) => t.zIndex.snackbar,
            px: 2,
            py: 1,
            maxWidth: 'calc(100vw - 32px)',
            borderRadius: 'var(--r-pill)',
            bgcolor: 'var(--ink)',
            color: 'var(--canvas)',
            border: 'var(--stroke) solid var(--line2)',
            boxShadow: 'var(--shadow-hover)',
            fontSize: 'var(--fs-meta)',
            fontWeight: 600,
            pointerEvents: 'none',
            animation: 'page-in var(--motion-enter) var(--motion-ease-enter)',
          }}
        >
          {toast}
        </Box>
      )}

      <Dialog open={organizeOpen} onClose={() => setOrganizeOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25 }}>
            <Box sx={{ color: 'primary.main', display: 'flex' }}>
              <GeoMark size={20} />
            </Box>
            待办整理建议
          </Box>
        </DialogTitle>
        <DialogContent dividers>
          {organizing ? (
            <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 4 }}>
              <Box className="geo-spinner" />
              <Typography sx={{ fontSize: 'var(--fs-meta)', color: 'text.secondary' }}>正在整理…</Typography>
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
                    <Box
                      key={i}
                      sx={{ pl: 1.25, borderLeft: 'var(--stroke-accent) solid', borderColor: 'warning.main' }}
                    >
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
    </PageShell>
  )
}
