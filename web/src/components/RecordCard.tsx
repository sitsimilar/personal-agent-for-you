import { Box, Card, CardActionArea, CardContent, Chip, Typography } from '@mui/material'
import LightbulbIcon from '@mui/icons-material/Lightbulb'
import FolderIcon from '@mui/icons-material/Folder'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import LinkIcon from '@mui/icons-material/Link'
import RepeatIcon from '@mui/icons-material/Repeat'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import type { InfoRecord } from '@shared/types/domain'
import { categoryColor, tagColor } from '@shared/constants/categories'
import { describeRecurrence, nextInstanceLabel } from '@/lib/recurrence'
import { isHttpUrl, prettyHost } from '@/services/linkPreviewService'
import { COMPACT_ROW_MIN_HEIGHT } from '@/lib/shell-layout'
import LinkCover from './LinkCover'

const TYPE_META: Record<string, { label: string; icon: React.ReactElement }> = {
  idea: { label: '想法', icon: <LightbulbIcon fontSize="small" /> },
  material: { label: '资料', icon: <FolderIcon fontSize="small" /> },
  todo: { label: '待办', icon: <CheckCircleIcon fontSize="small" /> },
}

function formatTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  return d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

interface RecordCardProps {
  record: InfoRecord
  onClick?: () => void
  /**
   * 紧凑变体（P1-8 上半）：窄屏一行一条，只保留「类型图标 + 标题 + 时间/分类 + 状态」。
   *
   * 不在这里用 `useMediaQuery` 自己判宽度 —— 密度由 `RecordsPage` 按纯函数统一决定，
   * 卡片是被动渲染的。
   */
  compact?: boolean
}

/**
 * 记录卡片（线构版）。
 *
 * 两种密度共用同一份数据与同一个点击入口，差别只在版式：
 * - `grid`（默认，≥600px）：类型字形 + 摘要 + 标签的多列卡片，悬停出现右上切角；
 * - `compact`（<600px）：单行，56px 高，标题一行省略，第二行「时间 · 分类」，右侧状态。
 *
 * 类型不用彩色胶囊，而用 26px 方形字形块（1px 描边 + 品牌色 8% 底）——
 * 卡片上只保留一个强调点，分类与标签降级成圆点 + 文字，扫描时先看到标题。
 */
export default function RecordCard({ record, onClick, compact = false }: RecordCardProps) {
  const meta = TYPE_META[record.type] ?? TYPE_META.idea
  const recurrenceLabel = record.recurrence ? describeRecurrence(record.recurrence, record.remindAt) : ''
  // P2-7：循环且未完成时给出「下次实例」；已完成的不再展示（本期已结束，下一期由完成动作生成）
  const nextInstance =
    record.recurrence && record.todoStatus !== 'done'
      ? nextInstanceLabel(record.recurrence, record.remindAt)
      : ''
  const hostLabel = record.linkMeta?.site || prettyHost(record.url)
  const done = record.type === 'todo' && record.todoStatus === 'done'

  /** 类型字形：26×26 线框方块（grid）/ 32×32（compact），只做一处品牌色底。 */
  const glyph = (size: number) => (
    <Box
      aria-hidden
      sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: 'var(--r-ctl)',
        border: 'var(--stroke) solid var(--line2)',
        bgcolor: 'var(--brand-soft)',
        color: 'primary.main',
      }}
    >
      <Box sx={{ display: 'flex', '& svg': { fontSize: 16 } }}>{meta.icon}</Box>
    </Box>
  )

  if (compact) {
    // 副行只放两段：时间 + 分类（无分类用首个标签），再多一行就会把标题挤下去
    const metaLine = [formatTime(record.createdAt), record.category || record.tags[0] || '']
      .filter(Boolean)
      .join(' · ')

    return (
      <Card
        variant="outlined"
        data-density="compact"
        className="geo-frame press"
        sx={{
          borderColor: 'var(--line)',
          borderRadius: 'var(--r-card)',
          boxShadow: 'var(--shadow-card)',
          bgcolor: 'var(--surface)',
          transition: 'border-color var(--motion-fast) var(--motion-ease-standard)',
          '&:hover': { borderColor: 'var(--line-strong)' },
        }}
      >
        <CardActionArea
          onClick={onClick}
          sx={{
            borderRadius: 'inherit',
            '& .MuiCardActionArea-focusHighlight': { bgcolor: 'var(--brand)' },
          }}
        >
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 1.25,
              px: 1.5,
              // 56px = 44 触摸下限 + 上下各 6px 呼吸；触摸目标不因降级而缩水
              minHeight: COMPACT_ROW_MIN_HEIGHT,
              py: 0.5,
              minWidth: 0,
            }}
          >
            {glyph(32)}

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="body2" fontWeight={600} noWrap sx={{ letterSpacing: 'var(--tracking-tight)' }}>
                {record.title || '（无标题）'}
              </Typography>
              <Box
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.5,
                  mt: 0.25,
                  color: 'text.secondary',
                  fontSize: 'var(--fs-caption)',
                  minWidth: 0,
                }}
              >
                {record.category && (
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
                )}
                <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {metaLine}
                </Box>
              </Box>
            </Box>

            {done && (
              <Chip
                size="small"
                label="已完成"
                color="success"
                variant="outlined"
                sx={{ flexShrink: 0, height: 22, fontSize: 11 }}
              />
            )}
            {record.recurrence && (
              <Box component="span" aria-label="循环" sx={{ display: 'inline-flex', color: 'text.disabled', flexShrink: 0 }}>
                <RepeatIcon sx={{ fontSize: 16 }} />
              </Box>
            )}
            <ChevronRightIcon sx={{ fontSize: 20, color: 'text.disabled', flexShrink: 0 }} />
          </Box>
        </CardActionArea>
      </Card>
    )
  }

  return (
    <Card
      variant="outlined"
      className="geo-frame card-lift"
      data-density="grid"
      sx={{
        height: '100%',
        bgcolor: 'var(--surface)',
        borderColor: 'var(--line)',
        borderRadius: 'var(--r-card)',
        boxShadow: 'var(--shadow-card)',
        transition: 'border-color var(--motion-fast) var(--motion-ease-standard), box-shadow var(--motion-move) var(--motion-ease-spring)',
        '&:hover': { borderColor: 'var(--line-strong)' },
      }}
    >
      <CardActionArea
        onClick={onClick}
        sx={{
          height: '100%',
          borderRadius: 'inherit',
          '& .MuiCardActionArea-focusHighlight': { bgcolor: 'var(--brand)' },
        }}
      >
        <CardContent sx={{ height: '100%', display: 'flex', flexDirection: 'column', gap: 1, p: 2, '&:last-child': { pb: 2 } }}>
          <LinkCover record={record} />

          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
            {glyph(26)}
            <Typography
              component="span"
              sx={{
                fontSize: 'var(--fs-caption)',
                fontWeight: 700,
                letterSpacing: 'var(--tracking-label)',
                color: 'text.secondary',
                flex: 'none',
              }}
            >
              {meta.label}
            </Typography>
            {record.url && (
              <Box component="span" aria-label="含链接" sx={{ color: 'text.disabled', display: 'inline-flex' }}>
                <LinkIcon sx={{ fontSize: 14 }} />
              </Box>
            )}
            <Box sx={{ flex: 1 }} />
            <Typography component="span" sx={{ fontSize: 'var(--fs-caption)', color: 'text.secondary', flex: 'none' }}>
              {formatTime(record.createdAt)}
            </Typography>
          </Box>

          <Typography
            variant="subtitle1"
            fontWeight={600}
            sx={{ lineHeight: 1.35, letterSpacing: 'var(--tracking-tight)', mt: 0.25 }}
          >
            {record.title || '（无标题）'}
          </Typography>

          {(done || recurrenceLabel) && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
              {done && (
                <Chip size="small" label="已完成" color="success" variant="outlined" sx={{ fontSize: 11, height: 22 }} />
              )}
              {recurrenceLabel && (
                <Chip
                  size="small"
                  icon={<RepeatIcon fontSize="small" />}
                  label={recurrenceLabel}
                  variant="outlined"
                  sx={{ fontSize: 11, height: 22, '& .MuiChip-icon': { fontSize: 13 } }}
                />
              )}
            </Box>
          )}

          {nextInstance && (
            <Typography
              sx={{ fontSize: 'var(--fs-caption)', color: 'text.secondary' }}
              title={`下次实例：${nextInstance}`}
            >
              下次 {nextInstance}
            </Typography>
          )}

          {record.summary && (
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
              {record.summary.length > 90 ? `${record.summary.slice(0, 90)}…` : record.summary}
            </Typography>
          )}
          {!record.summary && record.content && (
            <Typography variant="body2" color="text.secondary" sx={{ lineHeight: 1.55 }}>
              {record.content.length > 90 ? `${record.content.slice(0, 90)}…` : record.content}
            </Typography>
          )}

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, mt: 'auto', pt: 0.5, alignItems: 'center' }}>
            {record.category && (
              <Box
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                  fontSize: 'var(--fs-caption)',
                  color: 'text.secondary',
                  mr: 0.5,
                }}
              >
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
                {record.category}
              </Box>
            )}
            {record.tags.slice(0, 3).map((tag) => (
              <Box
                key={tag}
                sx={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                  fontSize: 'var(--fs-caption)',
                  color: 'text.secondary',
                  mr: 0.5,
                  minWidth: 0,
                }}
              >
                <Box
                  aria-hidden
                  sx={{ width: 5, height: 5, borderRadius: '50%', bgcolor: tagColor(tag), flex: 'none' }}
                />
                <Box
                  component="span"
                  sx={{ maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {tag}
                </Box>
              </Box>
            ))}
            {record.type === 'todo' && record.priority && (
              <Chip
                size="small"
                label={record.priority === 'high' ? '高优先级' : record.priority === 'medium' ? '中优先级' : '低优先级'}
                color={record.priority === 'high' ? 'error' : record.priority === 'medium' ? 'warning' : 'default'}
                variant="outlined"
                sx={{ fontSize: 11, height: 22 }}
              />
            )}
            {isHttpUrl(record.url) && hostLabel && (
              <Chip
                size="small"
                icon={<LinkIcon fontSize="small" />}
                label={hostLabel}
                variant="outlined"
                sx={{
                  fontSize: 11,
                  height: 22,
                  maxWidth: 180,
                  '& .MuiChip-label': { overflow: 'hidden', textOverflow: 'ellipsis' },
                }}
              />
            )}
          </Box>
        </CardContent>
      </CardActionArea>
    </Card>
  )
}
