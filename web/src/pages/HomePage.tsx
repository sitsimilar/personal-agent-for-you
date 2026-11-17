import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Box, Button, Grid, Pagination, Stack, Typography } from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import AddIcon from '@mui/icons-material/Add'
import type { InfoRecord } from '@shared/types/domain'
import { useRecordStore } from '@/store/recordStore'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import { recordService } from '@/services/recordService'
import RecordCard from '@/components/RecordCard'
import RecordDetail from '@/components/RecordDetail'
import RecordCreateDialog from '@/components/RecordCreateDialog'
import PageHeader from '@/components/PageHeader'
import PageShell from '@/components/PageShell'
import SkeletonList from '@/components/ui/SkeletonList'
import MetricTile from '@/components/ui/MetricTile'
import EmptyState from '@/components/ui/EmptyState'

interface HomeStats {
  weekNew: number
  todoPending: number
  streak: number
}

/** 列表错峰延迟：第 n 项 26ms，尾部封顶到第 8 项（避免长列表末尾等待过久）。 */
function staggerStyle(index: number): CSSProperties {
  return { '--i': Math.min(index, 8) } as CSSProperties
}

/** 全部信息页（工作台）。 */
export default function HomePage() {
  const records = useRecordStore((s) => s.records)
  const total = useRecordStore((s) => s.total)
  const loading = useRecordStore((s) => s.loading)
  const error = useRecordStore((s) => s.error)
  const filter = useRecordStore((s) => s.filter)
  const load = useRecordStore((s) => s.load)
  const setFilter = useRecordStore((s) => s.setFilter)
  const resetFilter = useRecordStore((s) => s.resetFilter)
  const [detail, setDetail] = useState<InfoRecord | null>(null)
  const [stats, setStats] = useState<HomeStats | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const skipFirstLoad = useRef(true)

  // 进入「全部信息」页时清除残留筛选（type/category/keyword），确保展示全部信息（含最新记录）
  useEffect(() => {
    resetFilter()
  }, [resetFilter])

  useEffect(() => {
    // 挂载首帧跳过（filter 尚为旧值，resetFilter 会触发一次正确加载），避免双重请求
    if (skipFirstLoad.current) {
      skipFirstLoad.current = false
      return
    }
    load()
  }, [load, filter])

  useEffect(() => {
    recordService
      .stats()
      .then(setStats)
      .catch(() => setStats(null))
  }, [])

  const pageSize = filter.pageSize ?? 20
  const pageCount = Math.max(1, Math.ceil(total / pageSize))

  /** 当前界面方案（决定是否走分区布局 / 骨架屏）。 */
  const scheme = useUiSchemeStore((s) => s.scheme)
  const zoned = scheme === 'zoned'
  const fluid = scheme === 'fluid'

  /**
   * 分区方案下的右栏（bento 副栏）。
   *
   * 只放"看一眼就够"的汇总，不放任何需要操作的东西 —— 副栏一旦出现按钮，
   * 主区的视觉权重就守不住了。数据全部复用已有的 `stats`，不新增接口。
   */
  const renderAside = () => (
    <Stack spacing={2}>
      <Typography
        component="div"
        sx={{
          fontSize: 'var(--fs-caption)',
          fontWeight: 700,
          letterSpacing: 'var(--tracking-label)',
          color: 'text.secondary',
        }}
      >
        概览
      </Typography>
      <MetricTile label="本周新增" value={stats?.weekNew ?? 0} unit="条" glyph="square" />
      <MetricTile label="待办未完成" value={stats?.todoPending ?? 0} unit="条" glyph="circle" />
      <MetricTile label="连续记录" value={stats?.streak ?? 0} unit="天" glyph="lines" />
    </Stack>
  )

  return (
    <PageShell tone="board" aside={zoned ? renderAside() : undefined}>
      <PageHeader title="全部信息" subtitle={`想法、资料、待办都在这里 · 共 ${total} 条`} />

      {/* 分区方案下统计卡进右栏（bento），主区专注记录列表；其余方案维持顶部三卡 */}
      {!zoned && (
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={6} sm={4}>
            <MetricTile label="本周新增" value={stats?.weekNew ?? 0} unit="条" glyph="square" />
          </Grid>
          <Grid item xs={6} sm={4}>
            <MetricTile label="待办未完成" value={stats?.todoPending ?? 0} unit="条" glyph="circle" />
          </Grid>
          <Grid item xs={6} sm={4}>
            <MetricTile label="连续记录" value={stats?.streak ?? 0} unit="天" glyph="lines" />
          </Grid>
        </Grid>
      )}

      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, mb: 1.5 }}>
        <Typography variant="subtitle1" fontWeight={700}>
          最近记录
        </Typography>
        <Typography component="span" sx={{ fontSize: 'var(--fs-caption)', color: 'text.secondary' }}>
          {records.length} / {total}
        </Typography>
        <Box aria-hidden sx={{ flex: 1, height: 'var(--stroke)', bgcolor: 'var(--line)' }} />
      </Box>

      {loading ? (
        fluid ? (
          <SkeletonList rows={4} rowHeight={120} avatar />
        ) : (
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 8 }}>
            <Box className="geo-spinner" />
            <Typography sx={{ fontSize: 'var(--fs-meta)', color: 'text.secondary' }}>正在载入记录</Typography>
          </Box>
        )
      ) : error ? (
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
      ) : records.length === 0 ? (
        <EmptyState
          title="还没有记录"
          description="从这里开始记录你的第一条信息。想法、资料、待办都可以先收进来，之后再整理。"
          action={
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreateOpen(true)}>
              快速记录
            </Button>
          }
        />
      ) : (
        <>
          {/* 分区方案下主区只占 2/3 宽，列数同步收一档，避免卡片被压成窄条 */}
          <Grid container spacing={2}>
            {records.map((r, index) => (
              <Grid
                item
                xs={12}
                sm={6}
                md={zoned ? 6 : 4}
                lg={zoned ? 4 : 3}
                key={r.id}
                className="stagger-item"
                style={staggerStyle(index)}
              >
                <RecordCard record={r} onClick={() => setDetail(r)} />
              </Grid>
            ))}
          </Grid>
          <Box sx={{ display: 'flex', justifyContent: 'center', mt: 3 }}>
            <Pagination
              count={pageCount}
              page={filter.page ?? 1}
              onChange={(_e, page) => setFilter({ page })}
              color="primary"
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

      <RecordCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false)
          load()
        }}
      />
    </PageShell>
  )
}
