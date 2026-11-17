import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { Box, Button, Chip, Divider, Grid, Pagination, Stack, Typography, useMediaQuery } from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import type { InfoRecord, RecordType } from '@shared/types/domain'
import { useRecordStore } from '@/store/recordStore'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import RecordCard from '@/components/RecordCard'
import RecordDetail from '@/components/RecordDetail'
import PageHeader from '@/components/PageHeader'
import PageShell from '@/components/PageShell'
import SkeletonList from '@/components/ui/SkeletonList'
import EmptyState from '@/components/ui/EmptyState'
import type { OfflineRecordSummary } from '@/lib/offline-db'
import { readOnlineStatus } from '@/lib/pwa'
import { compactListMediaQuery, resolveRecordListDensityFromMatch } from '@/lib/shell-layout'

const TYPE_LABEL: Record<RecordType, string> = {
  idea: '想法',
  material: '资料',
  todo: '待办',
}

interface RecordsPageProps {
  /** 记录类型筛选（props 优先于 URL searchParams，供整合版悬浮窗内嵌使用）。 */
  type?: RecordType
  /** 分类标签筛选（props 优先）。 */
  category?: string
  /** 关键词筛选（props 优先）。 */
  keyword?: string
}

/** 想法 / 资料 / 分类标签视图。 */
const RECORD_TYPES: readonly string[] = ['idea', 'material', 'todo']

/** 列表错峰延迟（尾部封顶到第 8 项）。 */
function staggerStyle(index: number): CSSProperties {
  return { '--i': Math.min(index, 8) } as CSSProperties
}

export default function RecordsPage(props: RecordsPageProps) {
  const [params, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const rawType = props.type ?? params.get('type') ?? undefined
  const type = rawType && RECORD_TYPES.includes(rawType) ? (rawType as RecordType) : undefined
  const category = props.category ?? params.get('category') ?? undefined
  const keyword = props.keyword ?? params.get('keyword') ?? undefined

  const records = useRecordStore((s) => s.records)
  const total = useRecordStore((s) => s.total)
  const loading = useRecordStore((s) => s.loading)
  const error = useRecordStore((s) => s.error)
  const filter = useRecordStore((s) => s.filter)
  const load = useRecordStore((s) => s.load)
  const setFilter = useRecordStore((s) => s.setFilter)
  const [detail, setDetail] = useState<InfoRecord | null>(null)
  /** 断网兜底：从离线库读到的摘要（只在「加载失败且确实离线」时才有值）。 */
  const [offline, setOffline] = useState<{ rows: OfflineRecordSummary[]; at: string } | null>(null)
  const skipFirstLoad = useRef(true)
  // P1-8 上半：<600px 单列紧凑列表，≥600px 保持多列卡片（判定见 lib/shell-layout.ts）
  const compactList = useMediaQuery(compactListMediaQuery())
  const density = resolveRecordListDensityFromMatch(compactList)
  const scheme = useUiSchemeStore((s) => s.scheme)
  const fluid = scheme === 'fluid'

  // 在线拿到列表 → 顺手落一份离线摘要（失败静默，永不阻塞渲染）。
  // 用动态 `import()`：Dexie 只在「要写离线库」时才加载，不进首屏 chunk。
  useEffect(() => {
    if (error || !records.length) return
    void import('@/lib/offline-db')
      .then((m) => m.cacheRecords(records))
      .catch(() => {})
  }, [records, error])

  // 加载失败 + 确实断网 → 用离线缓存兜住，至少能看到「有哪些记录」
  useEffect(() => {
    if (!error) {
      setOffline(null)
      return
    }
    if (readOnlineStatus()) return
    let cancelled = false
    void import('@/lib/offline-db')
      .then((m) => m.readCachedRecords(20).then((snap) => ({ snap, label: m.formatSnapshotTime(snap.latestUpdatedAt) })))
      .then(({ snap, label }) => {
        if (cancelled || !snap.rows.length) return
        setOffline({ rows: snap.rows, at: label })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [error])

  useEffect(() => {
    setFilter({ type, category, keyword, isDeleted: false, page: 1 })
  }, [type, category, keyword, setFilter])

  useEffect(() => {
    // 挂载首帧跳过（此时 filter 还是旧值，随后 setFilter 会触发一次正确加载），避免双重请求
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false
      return
    }
    load()
  }, [load, filter])

  const pageSize = filter.pageSize ?? 20
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  const title = keyword
    ? `搜索「${keyword}」`
    : category
      ? category
      : type
        ? TYPE_LABEL[type]
        : '全部信息'

  const subtitle = keyword
    ? `搜索「${keyword}」的结果`
    : category
      ? '该分类标签下的记录'
      : type === 'idea'
        ? '随手记下的灵感与待验证的判断'
        : type === 'material'
          ? '收藏的文档、链接与代码片段'
          : '想法、资料、待办都在这里'

  return (
    <PageShell tone="board">
      <PageHeader
        title={title}
        subtitle={`${subtitle} · 共 ${offline ? offline.rows.length : total} 条`}
        action={
          keyword ? (
            <Chip
              size="small"
              label="清除搜索"
              onDelete={() => {
                const next = new URLSearchParams(params)
                next.delete('keyword')
                setSearchParams(next, { replace: true })
              }}
            />
          ) : undefined
        }
      />

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={700}>
          {keyword ? '搜索结果' : category ? '分类记录' : type ? `${TYPE_LABEL[type]}列表` : '记录列表'}
        </Typography>
        <Typography component="span" sx={{ fontSize: 'var(--fs-caption)', color: 'text.secondary' }}>
          {offline ? offline.rows.length : records.length} / {offline ? offline.rows.length : total}
        </Typography>
        <Box aria-hidden sx={{ flex: 1, height: 'var(--stroke)', bgcolor: 'var(--line)' }} />
      </Box>

      {loading ? (
        fluid ? (
          <SkeletonList
            rows={density === 'compact' ? 5 : 4}
            rowHeight={density === 'compact' ? 60 : 120}
            avatar={density !== 'compact'}
          />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 8 }}>
            <Box className="geo-spinner" />
            <Typography sx={{ fontSize: 'var(--fs-meta)', color: 'text.secondary' }}>正在载入记录</Typography>
          </Box>
        )
      ) : error ? (
        offline ? (
          <Box
            sx={{
              border: 'var(--stroke) solid var(--line)',
              borderRadius: 'var(--r-card)',
              bgcolor: 'var(--surface)',
              px: 2,
              py: 1.5,
            }}
          >
            <Typography sx={{ fontSize: 'var(--fs-caption)', color: 'text.secondary', display: 'block', mb: 1 }}>
              离线缓存 · 数据截至 {offline.at}（最近 {offline.rows.length} 条标题，正文不缓存）
            </Typography>
            <Stack divider={<Divider flexItem />}>
              {offline.rows.map((r) => (
                <Box key={r.id} sx={{ py: 1 }}>
                  <Stack direction="row" spacing={1} alignItems="center">
                    <Typography
                      component="span"
                      sx={{
                        flexShrink: 0,
                        fontSize: 'var(--fs-caption)',
                        fontWeight: 700,
                        letterSpacing: 'var(--tracking-label)',
                        color: 'text.secondary',
                      }}
                    >
                      {TYPE_LABEL[r.type]}
                    </Typography>
                    <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0 }}>
                      {r.title}
                    </Typography>
                  </Stack>
                  {r.snippet && (
                    <Typography
                      variant="caption"
                      color="text.secondary"
                      display="block"
                      noWrap
                      sx={{ mt: 0.25 }}
                    >
                      {r.snippet}
                    </Typography>
                  )}
                </Box>
              ))}
            </Stack>
          </Box>
        ) : (
          <Box
            sx={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 1.5,
              py: 7,
              px: 2,
              border: '1px dashed var(--line2)',
              borderRadius: 'var(--r-card)',
            }}
          >
            <Typography color="error" sx={{ fontSize: 'var(--fs-body)' }}>
              {error}
            </Typography>
            <Button variant="outlined" size="small" startIcon={<RefreshIcon />} onClick={load}>
              重试加载
            </Button>
          </Box>
        )
      ) : records.length === 0 ? (
        <EmptyState
          title="没有符合条件的记录"
          description="换个分类或关键词试试，也可以先去全部信息里记录一条。"
          action={
            <Button variant="outlined" startIcon={<AddIcon />} onClick={() => navigate('/')}>
              去全部信息记录
            </Button>
          }
        />
      ) : (
        <>
          {density === 'compact' ? (
            <Stack spacing={1} data-record-list="compact">
              {records.map((r, index) => (
                <Box key={r.id} className="stagger-item" style={staggerStyle(index)}>
                  <RecordCard record={r} compact onClick={() => setDetail(r)} />
                </Box>
              ))}
            </Stack>
          ) : (
            <Grid container spacing={2} data-record-list="grid">
              {records.map((r, index) => (
                <Grid item xs={12} sm={6} md={4} lg={3} key={r.id} className="stagger-item" style={staggerStyle(index)}>
                  <RecordCard record={r} onClick={() => setDetail(r)} />
                </Grid>
              ))}
            </Grid>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
            <Pagination
              count={pageCount}
              page={filter.page ?? 1}
              onChange={(_e, page) => setFilter({ page })}
              color="primary"
              // 窄屏只留「上一页 / 当前页 / 下一页」：20 页时分页器本身就比版心宽
              siblingCount={density === 'compact' ? 0 : 1}
              boundaryCount={1}
              size={density === 'compact' ? 'small' : 'medium'}
            />
          </Box>
        </>
      )}

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
