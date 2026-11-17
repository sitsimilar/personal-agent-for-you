import { Box, Checkbox, IconButton, Typography } from '@mui/material'
import CheckIcon from '@mui/icons-material/Check'
import BookmarkBorderIcon from '@mui/icons-material/BookmarkBorder'
import BookmarkIcon from '@mui/icons-material/Bookmark'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import RepeatIcon from '@mui/icons-material/Repeat'
import type { InfoRecord } from '@shared/types/domain'
import { categoryColor } from '@shared/constants/categories'
import { describeRecurrence } from '@/lib/recurrence'
import { isSnoozePending } from '@/lib/reminder-schedule'

interface TodoRowProps {
  record: InfoRecord
  /** 勾选乐观态是否包含本行（流畅方案）。 */
  optimistic?: boolean
  /** 分段判定基准时刻（由页面统一给出，组件不读 Date.now()）。 */
  nowMs: number
  /** 列表序号（用于错峰，内部最多取 8）。 */
  index?: number
  onOpen?: () => void
  onToggle?: () => void
  onToggleSomeday?: () => void
}

/** ISO → `MM-DD HH:mm`（非法返回空串，不渲染半截时间）。 */
function formatRemind(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** ISO → 本地 HH:mm（「已推迟至」文案用）。 */
function formatClock(iso: string): string {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return ''
  return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

/** 未选中态：18×18 细描边方块（几何母题，不用浏览器原生圆点）。 */
function BoxIcon() {
  return (
    <Box
      component="span"
      sx={{
        width: 18,
        height: 18,
        display: 'block',
        borderRadius: '4px',
        border: 'var(--stroke-strong) solid var(--line-strong)',
        transition: 'border-color var(--motion-fast) var(--motion-ease-standard)',
      }}
    />
  )
}

/** 选中态：品牌色实心方块 + 对勾。 */
function BoxCheckedIcon() {
  return (
    <Box
      component="span"
      sx={{
        width: 18,
        height: 18,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '4px',
        bgcolor: 'var(--brand)',
        color: 'var(--surface)',
      }}
    >
      <CheckIcon sx={{ fontSize: 14 }} />
    </Box>
  )
}

/**
 * 待办行（线构版）。
 *
 * 版式：`勾选框 · 优先级竖线 · 标题+元信息 · 收藏 · 进入`。
 * 只用描边与一条 2px 竖线表达优先级，不铺底色 —— 待办页一屏十几行，
 * 任何一行铺色都会把"重要"的权重稀释掉。
 *
 * 组件是**纯展示**：勾选 / 收藏 / 打开全部回调给页面，
 * 数据与落库语义仍由 `TodoPage` 的原有逻辑负责。
 */
export default function TodoRow({
  record,
  optimistic = false,
  nowMs,
  index = 0,
  onOpen,
  onToggle,
  onToggleSomeday,
}: TodoRowProps) {
  const done = record.todoStatus === 'done'
  const finished = done || optimistic
  const recurrenceLabel = record.recurrence ? describeRecurrence(record.recurrence, record.remindAt) : ''
  const remindLabel = formatRemind(record.remindAt)
  const snoozeLabel = isSnoozePending(record, nowMs) ? formatClock(record.snoozedUntil ?? '') : ''
  const priorityTone =
    record.priority === 'high'
      ? 'var(--danger)'
      : record.priority === 'medium'
        ? 'var(--warning)'
        : 'var(--line2)'

  return (
    <Box
      role="button"
      tabIndex={0}
      className="stagger-item"
      style={{ ['--i' as string]: Math.min(index, 8) }}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen?.()
        }
      }}
      sx={{
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        pl: 1,
        pr: 1.25,
        py: 1,
        minHeight: 60,
        border: 'var(--stroke) solid var(--line)',
        borderRadius: 'var(--r-card)',
        bgcolor: 'var(--surface)',
        cursor: 'pointer',
        // 已完成仍要可读：0.68 是"退后一层"而不是"看不见"
        opacity: finished ? 0.68 : 1,
        transition:
          'border-color var(--motion-fast) var(--motion-ease-standard), opacity var(--motion-exit) var(--motion-ease-exit), transform var(--motion-press) var(--motion-ease-standard)',
        '&:hover': { borderColor: 'var(--line-strong)' },
        '&:active': { transform: 'scale(0.995)' },
        '&:focus-visible': { outline: 'var(--stroke-accent) solid var(--focus-ring)', outlineOffset: 2 },
      }}
    >
      <Checkbox
        checked={finished}
        onChange={() => onToggle?.()}
        onClick={(e) => e.stopPropagation()}
        icon={<BoxIcon />}
        checkedIcon={<BoxCheckedIcon />}
        inputProps={{ 'aria-label': done ? '恢复为未完成' : '标记完成' }}
        sx={{ p: 0.5, flex: 'none' }}
      />

      {/* 优先级只用一条 2px 竖线表达；无优先级时是发丝线，不抢视线 */}
      <Box
        aria-hidden
        sx={{
          width: 'var(--stroke-accent)',
          height: 26,
          borderRadius: 'var(--r-pill)',
          bgcolor: priorityTone,
          flex: 'none',
        }}
      />

      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          noWrap
          sx={{
            fontSize: 'var(--fs-body)',
            fontWeight: 600,
            lineHeight: 1.4,
            textDecoration: finished ? 'line-through' : 'none',
            color: finished ? 'text.secondary' : 'text.primary',
            transition: 'color var(--motion-exit) var(--motion-ease-exit)',
          }}
        >
          {record.title || '（无标题）'}
        </Typography>

        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            gap: 1,
            mt: 0.5,
            minWidth: 0,
            color: 'text.secondary',
            fontSize: 'var(--fs-caption)',
          }}
        >
          {record.category && (
            <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
              <Box
                aria-hidden
                sx={{
                  width: 'var(--geo-dot)',
                  height: 'var(--geo-dot)',
                  borderRadius: '50%',
                  bgcolor: categoryColor(record.category),
                  flex: 'none',
                }}
              />
              <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {record.category}
              </Box>
            </Box>
          )}
          {remindLabel && <Box component="span">提醒 {remindLabel}</Box>}
          {snoozeLabel && <Box component="span">已推迟至 {snoozeLabel}</Box>}
          {record.someday === true && <Box component="span">某天</Box>}
          {recurrenceLabel && (
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }}>
              <RepeatIcon sx={{ fontSize: 12 }} />
              {recurrenceLabel}
            </Box>
          )}
          {record.recurrenceNextId != null && <Box component="span">下一期 #{record.recurrenceNextId}</Box>}
        </Box>
      </Box>

      {onToggleSomeday && (
        <IconButton
          size="small"
          onClick={(e) => {
            e.stopPropagation()
            onToggleSomeday()
          }}
          aria-label={record.someday === true ? '取消某天' : '标记为某天'}
          sx={{
            flex: 'none',
            color: record.someday === true ? 'primary.main' : 'text.disabled',
            '&:hover': { color: 'primary.main' },
          }}
        >
          {record.someday === true ? <BookmarkIcon fontSize="small" /> : <BookmarkBorderIcon fontSize="small" />}
        </IconButton>
      )}

      <ChevronRightIcon aria-hidden sx={{ fontSize: 18, color: 'text.disabled', flex: 'none' }} />
    </Box>
  )
}
