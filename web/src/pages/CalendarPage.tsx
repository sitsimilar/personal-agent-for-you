import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import {
  Box,
  Button,
  Card,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Grid,
  IconButton,
  List,
  ListItemButton,
  ListItemText,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import AddIcon from '@mui/icons-material/Add'
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined'
import UploadFileOutlinedIcon from '@mui/icons-material/UploadFileOutlined'
import RefreshIcon from '@mui/icons-material/Refresh'
import type { IcsRange, InfoRecord } from '@shared/types/domain'
import { recordService } from '@/services/recordService'
import { calendarService } from '@/services/calendarService'
import {
  describeIcsImportError,
  importIcs,
  previewIcs,
  type IcsImportPreview,
} from '@/services/icsImportService'
import { resolveViewRange } from '@/lib/calendar-range'
import type { IcsImportDraft } from '@/lib/ics-map'
import { pushNotice } from '@/store/noticeStore'
import { friendlyError } from '@/lib/unwrap'
import { categoryColor } from '@shared/constants/categories'
import RecordDetail from '@/components/RecordDetail'
import RecordCreateDialog from '@/components/RecordCreateDialog'
import PageHeader from '@/components/PageHeader'
import PageShell from '@/components/PageShell'

type ViewMode = 'month' | 'week'

/** 导出范围选项（顺序即展示顺序，默认「当前月」）。 */
const EXPORT_RANGE_OPTIONS: Array<{ value: IcsRange; label: string }> = [
  { value: 'month', label: '当前月' },
  { value: 'week', label: '当前周' },
  { value: 'all', label: '全部' },
]

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function startOfDay(d: Date): Date {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d)
  x.setDate(x.getDate() + n)
  return x
}

/** 周一作为一周起点。 */
function mondayOf(d: Date): Date {
  const x = startOfDay(d)
  const dow = (x.getDay() + 6) % 7
  return addDays(x, -dow)
}

/** 记录创建时间的本地日期 key（用于按天聚合）。 */
function recordDayKey(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : dateKey(d)
}

/** 导入预览里的类型文案（与 `IcsItemKind` 一一对应）。 */
const IMPORT_KIND_LABEL: Record<IcsImportDraft['icsKind'], string> = {
  event: '日程',
  todo: '待办',
  journal: '笔记',
}

/**
 * 排期时刻 → 本地可读文案。
 *
 * 用本地日期而非 UTC：用户判断"这条时间对不对"依据的是自己的墙钟，
 * 直接显示 `...Z` 会让人以为导进来的时间偏了 8 小时。
 *
 * @param iso UTC ISO 或 null
 */
function formatImportWhen(iso: string | null): string {
  if (!iso) return '无时间'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '无时间'
  return `${dateKey(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

interface DayRecords {
  byDay: Map<string, InfoRecord[]>
}

/** 日历页：月/周视图 + 点击日期查看/创建当天记录事项。 */
export default function CalendarPage() {
  const [viewMode, setViewMode] = useState<ViewMode>('month')
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()))
  const [data, setData] = useState<DayRecords>({ byDay: new Map() })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [detail, setDetail] = useState<InfoRecord | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  // .ics 导出弹窗状态（v2.13 R6）
  const [exportOpen, setExportOpen] = useState(false)
  const [exportRange, setExportRange] = useState<IcsRange>('month')
  const [exportIncludeDone, setExportIncludeDone] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportError, setExportError] = useState('')

  // .ics 导入弹窗状态（v2.14 P0-1）：解析结果与原文都在本地，确认导入时再落库
  const [importOpen, setImportOpen] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const [importFileName, setImportFileName] = useState('')
  /** 已选文件的原文（`importIcs` 需要原文重放；解析是纯函数，重放结果必然一致）。 */
  const [importText, setImportText] = useState('')
  const [importPreview, setImportPreview] = useState<IcsImportPreview | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // 视图时间范围（月 = 当月整月；周 = 本周一 ~ 周日），与 .ics 导出共用同一口径
  const range = useMemo((): [Date, Date] => resolveViewRange(viewMode, anchor), [viewMode, anchor])

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [start, end] = range
      const rows = await recordService.listByRange(start.toISOString(), end.toISOString(), 1000)
      const byDay = new Map<string, InfoRecord[]>()
      for (const r of rows) {
        const k = recordDayKey(r.createdAt)
        if (!k) continue
        const arr = byDay.get(k) ?? []
        arr.push(r)
        byDay.set(k, arr)
      }
      setData({ byDay })
    } catch (err) {
      setError(friendlyError(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range])

  const shift = (delta: number) => {
    if (viewMode === 'month') {
      setAnchor((a) => new Date(a.getFullYear(), a.getMonth() + delta, 1))
    } else {
      setAnchor((a) => addDays(a, delta * 7))
    }
  }

  const title = viewMode === 'month' ? `${anchor.getFullYear()} 年 ${anchor.getMonth() + 1} 月` : '本周'

  const selectedRecords = selectedDay ? data.byDay.get(selectedDay) ?? [] : []

  /** 打开导出弹窗：范围默认跟随当前视图（月视图 → 当前月；周视图 → 当前周）。 */
  const openExport = () => {
    setExportRange(viewMode === 'week' ? 'week' : 'month')
    setExportIncludeDone(false)
    setExportError('')
    setExportOpen(true)
  }

  /** 执行导出：取数 → 构造 → 浏览器下载；空集由 service 抛错，这里只展示。 */
  const doExport = async () => {
    setExporting(true)
    setExportError('')
    try {
      const result = await calendarService.buildExport({
        range: exportRange,
        // 区间口径跟着「导出范围」走（用户可能在看月视图却只想导当前周）
        viewMode: exportRange === 'week' ? 'week' : 'month',
        anchor,
        includeDone: exportIncludeDone,
      })
      calendarService.downloadIcs(result.fileName, result.content)
      pushNotice(
        `已导出 ${result.recordCount} 条待办（待办 ${result.todoCount} 项 · 日程 ${result.eventCount} 个）`,
        'success',
      )
      setExportOpen(false)
    } catch (err) {
      setExportError(friendlyError(err))
    } finally {
      setExporting(false)
    }
  }

  /** 打开导入弹窗（每次重置，避免上一次的文件/错误残留）。 */
  const openImport = () => {
    setImportFileName('')
    setImportText('')
    setImportPreview(null)
    setImportError('')
    setImporting(false)
    setImportOpen(true)
  }

  /**
   * 选择文件并本地解析（**不上传**：整个流程只在浏览器里读文本）。
   *
   * 解析放在选文件时立即做，是为了让用户在"确认导入"之前就看到条目数与警告——
   * 导入一旦落库就得逐条删，先看清楚更便宜。
   */
  const onPickImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files && event.target.files[0]
    // 清空 input.value：否则再次选同一个文件不会触发 change（用户会以为按钮点了没反应）
    event.target.value = ''
    if (!file) return
    setImportError('')
    try {
      const text = await file.text()
      const preview = previewIcs(text)
      setImportFileName(file.name)
      setImportText(text)
      setImportPreview(preview)
      if (preview.drafts.length === 0) {
        // 空日历 / 格式不对：解析层已经把原因写进 warnings，这里取第一条展示
        setImportError(preview.warnings[0] ?? '没有可导入的日历条目')
      }
    } catch (err) {
      setImportFileName('')
      setImportText('')
      setImportPreview(null)
      setImportError(friendlyError(err))
    }
  }

  /** 确认导入：查重 → 分批写入 → 提示 → 关弹窗 → 刷新列表。 */
  const doImport = async () => {
    if (!importText) return
    setImporting(true)
    setImportError('')
    try {
      const result = await importIcs(importText)
      pushNotice(`已导入 ${result.created} 条，跳过 ${result.skipped} 条（已存在）`, 'success')
      setImportOpen(false)
      await load()
    } catch (err) {
      // 「迁移未执行」这类文案必须原样展示（friendlyError 会把带路径的文案脱敏掉）
      setImportError(describeIcsImportError(err))
    } finally {
      setImporting(false)
    }
  }

  // 月视图网格：当月 1 号是周几（周一起），前补空白格
  const monthCells = useMemo(() => {
    if (viewMode !== 'month') return []
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1)
    const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate()
    const leading = (first.getDay() + 6) % 7 // 周一 = 0
    const cells: Array<Date | null> = []
    for (let i = 0; i < leading; i++) cells.push(null)
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(anchor.getFullYear(), anchor.getMonth(), d))
    return cells
  }, [viewMode, anchor])

  const weekDays = useMemo(() => {
    if (viewMode !== 'week') return []
    const mon = mondayOf(anchor)
    return Array.from({ length: 7 }, (_, i) => addDays(mon, i))
  }, [viewMode, anchor])

  const isToday = (d: Date) => dateKey(d) === dateKey(new Date())

  const renderDayChip = (d: Date) => {
    const key = dateKey(d)
    const count = data.byDay.get(key)?.length ?? 0
    return (
      <Chip
        size="small"
        label={count > 0 ? `${count} 条` : ''}
        sx={{ height: 16, fontSize: 10, visibility: count > 0 ? 'visible' : 'hidden' }}
      />
    )
  }

  return (
    <PageShell tone="board">
      <PageHeader
        title="日历"
        subtitle="按日期查看与创建记录事项"
        action={
          <Stack
            direction="row"
            spacing={1}
            alignItems="center"
            // 375px 下三个控件并排会紧贴甚至溢出：允许换行而不是撑破页面
            sx={{ flexWrap: 'wrap', justifyContent: 'flex-end', rowGap: 1 }}
          >
            <ToggleButtonGroup
              size="small"
              exclusive
              value={viewMode}
              onChange={(_e, v) => v && setViewMode(v)}
            >
              <ToggleButton value="month">月视图</ToggleButton>
              <ToggleButton value="week">周视图</ToggleButton>
            </ToggleButtonGroup>
            <Button
              size="small"
              variant="outlined"
              startIcon={<UploadFileOutlinedIcon />}
              onClick={openImport}
            >
              导入 .ics
            </Button>
            <Button
              size="small"
              variant="outlined"
              startIcon={<FileDownloadOutlinedIcon />}
              onClick={openExport}
            >
              导出 .ics
            </Button>
          </Stack>
        }
      />

      {/* 标题栏：前后切换 */}
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 2 }}>
        <IconButton size="small" onClick={() => shift(-1)}>
          <ChevronLeftIcon />
        </IconButton>
        <Typography variant="subtitle1" fontWeight={600} sx={{ minWidth: 120, textAlign: 'center' }}>
          {title}
        </Typography>
        <IconButton size="small" onClick={() => shift(1)}>
          <ChevronRightIcon />
        </IconButton>
        <Button size="small" onClick={() => setAnchor(startOfDay(new Date()))}>
          今天
        </Button>
        <Box sx={{ flex: 1 }} />
        {error && (
          <>
            <Typography variant="caption" color="error">{error}</Typography>
            <IconButton size="small" onClick={load} title="重试">
              <RefreshIcon fontSize="small" />
            </IconButton>
          </>
        )}
      </Stack>

      {/* 星期表头 */}
      <Grid container columns={7} sx={{ mb: 0.5 }}>
        {WEEKDAYS.map((w) => (
          <Grid item xs={1} key={w}>
            <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block' }}>
              {w}
            </Typography>
          </Grid>
        ))}
      </Grid>

      {loading && (
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 2 }}>
          <CircularProgress size={22} />
        </Box>
      )}

      {viewMode === 'month' ? (
        <Box sx={{ overflowX: 'auto' }}>
          <Box sx={{ minWidth: 640 }}>
          <Grid container columns={7} spacing={0.5}>
          {monthCells.map((d, i) => (
            <Grid item xs={1} key={i}>
              {d ? (
                <Card
                  variant="outlined"
                  onClick={() => setSelectedDay(dateKey(d))}
                  sx={{
                    minHeight: 64,
                    p: 0.75,
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 0.25,
                    bgcolor: isToday(d) ? 'rgba(91,84,217,0.08)' : undefined,
                    borderColor: isToday(d) ? 'primary.main' : undefined,
                    '&:hover': { boxShadow: 2 },
                  }}
                >
                  <Typography variant="caption" fontWeight={isToday(d) ? 700 : 400}>
                    {d.getDate()}
                  </Typography>
                  {renderDayChip(d)}
                </Card>
              ) : (
                <Box sx={{ minHeight: 64 }} />
              )}
            </Grid>
          ))}
        </Grid>
          </Box>
        </Box>
      ) : (
        <Stack spacing={0.5}>
          {weekDays.map((d) => {
            const key = dateKey(d)
            const recs = data.byDay.get(key) ?? []
            return (
              <Card
                key={key}
                variant="outlined"
                onClick={() => setSelectedDay(key)}
                sx={{ cursor: 'pointer', '&:hover': { boxShadow: 2 } }}
              >
                <Stack direction="row" spacing={1} sx={{ p: 1 }}>
                  <Stack
                    alignItems="center"
                    sx={{
                      width: 44,
                      borderRadius: 2,
                      bgcolor: isToday(d) ? 'primary.main' : 'action.hover',
                      color: isToday(d) ? '#fff' : 'text.primary',
                      py: 0.5,
                    }}
                  >
                    <Typography variant="caption">周{WEEKDAYS[(d.getDay() + 6) % 7]}</Typography>
                    <Typography variant="h6" fontWeight={700}>{d.getDate()}</Typography>
                  </Stack>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    {recs.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">
                        暂无记录
                      </Typography>
                    ) : (
                      recs.slice(0, 4).map((r) => (
                        <Typography key={r.id} variant="body2" noWrap>
                          {r.title || '（无标题）'}
                        </Typography>
                      ))
                    )}
                    {recs.length > 4 && (
                      <Typography variant="caption" color="text.secondary">
                        还有 {recs.length - 4} 条…
                      </Typography>
                    )}
                  </Box>
                </Stack>
              </Card>
            )
          })}
        </Stack>
      )}

      {/* 当天记录 Dialog */}
      <Dialog open={!!selectedDay} onClose={() => setSelectedDay(null)} fullWidth maxWidth="sm">
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <Box sx={{ flex: 1 }}>{selectedDay} 的记录事项</Box>
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
            添加事项
          </Button>
        </DialogTitle>
        <DialogContent dividers>
          {loading ? (
            <Typography variant="body2" color="text.secondary">加载中…</Typography>
          ) : selectedRecords.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              当天暂无记录，点击「添加事项」创建
            </Typography>
          ) : (
            <List dense disablePadding>
              {selectedRecords.map((r) => (
                <ListItemButton key={r.id} onClick={() => setDetail(r)} sx={{ borderRadius: 1 }}>
                  <ListItemText
                    primary={r.title || '（无标题）'}
                    secondary={
                      r.category
                        ? `${r.type === 'todo' ? '待办' : r.type === 'material' ? '资料' : '想法'} · ${r.category}`
                        : r.type === 'todo' ? '待办' : r.type === 'material' ? '资料' : '想法'
                    }
                  />
                  {r.category && (
                    <Box
                      sx={{
                        width: 10,
                        height: 10,
                        borderRadius: '50%',
                        bgcolor: categoryColor(r.category),
                        flexShrink: 0,
                      }}
                    />
                  )}
                </ListItemButton>
              ))}
            </List>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedDay(null)}>关闭</Button>
        </DialogActions>
      </Dialog>

      {/* 详情 */}
      <RecordDetail
        record={detail}
        open={!!detail}
        onClose={() => setDetail(null)}
        onChanged={load}
        onDeleted={load}
        onOpenRecord={setDetail}
      />

      {/* 创建（预填提醒日期为选中日期 09:00） */}
      <RecordCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false)
          load()
        }}
        defaultType="todo"
        defaultRemindAt={selectedDay ? `${selectedDay}T09:00` : undefined}
      />

      {/* .ics 导入（v2.14 P0-1）：本地读取解析 → 预览 → 确认落库；文件不上传 */}
      <Dialog
        open={importOpen}
        onClose={() => (importing ? undefined : setImportOpen(false))}
        fullWidth
        maxWidth="xs"
      >
        <DialogTitle>从日历导入（.ics）</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5} sx={{ maxHeight: '60vh', overflow: 'auto' }}>
            {!importPreview ? (
              <>
                <Typography variant="body2" color="text.secondary">
                  选择从系统日历 / Google Calendar / Outlook 导出的 .ics 文件。
                  <br />
                  文件只在本机读取，不会上传。
                </Typography>
                <Button
                  variant="outlined"
                  startIcon={<UploadFileOutlinedIcon />}
                  onClick={() => fileInputRef.current?.click()}
                >
                  选择 .ics 文件
                </Button>
              </>
            ) : (
              <>
                <Box sx={{ minWidth: 0 }}>
                  <Typography variant="subtitle2" noWrap>
                    {importPreview.calendarName || '未命名的日历'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    {importFileName} · 共 {importPreview.counts.total} 条（日程 {importPreview.counts.event} / 待办{' '}
                    {importPreview.counts.todo} / 笔记 {importPreview.counts.journal}）
                  </Typography>
                  {importPreview.counts.cancelled > 0 && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                      其中 {importPreview.counts.cancelled} 条状态为「已取消」，导入后进回收站
                    </Typography>
                  )}
                </Box>

                <Stack spacing={0.5}>
                  {importPreview.drafts.slice(0, 10).map((draft, index) => (
                    <Stack
                      key={`${draft.externalUid}-${index}`}
                      direction="row"
                      spacing={1}
                      alignItems="center"
                      sx={{ minWidth: 0 }}
                    >
                      <Chip
                        size="small"
                        label={IMPORT_KIND_LABEL[draft.icsKind]}
                        sx={{ height: 18, fontSize: 10, flexShrink: 0 }}
                      />
                      <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                        {draft.title}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
                        {formatImportWhen(draft.remindAt)}
                      </Typography>
                    </Stack>
                  ))}
                  {importPreview.drafts.length > 10 && (
                    <Typography variant="caption" color="text.secondary">
                      还有 {importPreview.drafts.length - 10} 条…
                    </Typography>
                  )}
                </Stack>

                {importPreview.warnings.length > 0 && (
                  <Box component="details">
                    <Typography component="summary" variant="caption" color="text.secondary" sx={{ cursor: 'pointer' }}>
                      解析提示 {importPreview.warnings.length} 条（点开查看）
                    </Typography>
                    {importPreview.warnings.slice(0, 3).map((warning, index) => (
                      <Typography
                        key={index}
                        variant="caption"
                        color="text.secondary"
                        sx={{ display: 'block', mt: 0.5 }}
                      >
                        {warning}
                      </Typography>
                    ))}
                  </Box>
                )}

                <Button
                  size="small"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={importing}
                  sx={{ alignSelf: 'flex-start' }}
                >
                  换一个文件
                </Button>
              </>
            )}

            {/* 隐藏的文件选择器：两条分支共用同一个 ref，故只渲染一份 */}
            <input
              ref={fileInputRef}
              type="file"
              accept=".ics,text/calendar"
              hidden
              onChange={onPickImportFile}
            />

            {importError && (
              <Typography variant="caption" color="error" sx={{ display: 'block' }}>
                {importError}
              </Typography>
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setImportOpen(false)} disabled={importing}>
            取消
          </Button>
          <Button
            variant="contained"
            onClick={doImport}
            disabled={importing || !importPreview || importPreview.drafts.length === 0}
          >
            {importing ? '导入中…' : '确认导入'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* .ics 导出（v2.13 R6）：按提醒时间导出，与日历页按创建时间排布的口径不同 */}
      <Dialog open={exportOpen} onClose={() => (exporting ? undefined : setExportOpen(false))} fullWidth maxWidth="xs">
        <DialogTitle>导出到日历（.ics）</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            导出为 iCalendar 文件，可导入系统日历 / Google Calendar / Outlook。
            <br />
            按提醒时间导出；日历页是按创建时间排布的，两者位置可能不同。
          </Typography>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
            导出范围
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            fullWidth
            value={exportRange}
            onChange={(_e, v) => v && setExportRange(v)}
            sx={{ mb: 2 }}
          >
            {EXPORT_RANGE_OPTIONS.map((opt) => (
              <ToggleButton key={opt.value} value={opt.value}>
                {opt.label}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>

          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={exportIncludeDone}
                onChange={(e) => setExportIncludeDone(e.target.checked)}
              />
            }
            label={<Typography variant="body2">包含已完成待办</Typography>}
          />

          {exportError && (
            <Typography variant="caption" color="error" sx={{ display: 'block', mt: 1 }}>
              {exportError}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setExportOpen(false)} disabled={exporting}>
            取消
          </Button>
          <Button variant="contained" onClick={doExport} disabled={exporting}>
            {exporting ? '导出中…' : '导出'}
          </Button>
        </DialogActions>
      </Dialog>
    </PageShell>
  )
}
