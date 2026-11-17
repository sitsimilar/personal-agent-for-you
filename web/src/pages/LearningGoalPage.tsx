import { useEffect, useRef, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Typography } from '@mui/material'
import OpenInNewIcon from '@mui/icons-material/OpenInNew'
import PageHeader from '@/components/PageHeader'
import PageShell from '@/components/PageShell'

/**
 * 学习目标管理台 — 内嵌版（v2.15 新增）。
 *
 * 改造前：点按钮新开窗口 → 数据在线读写、多端同步，但跳转割裂。
 * 改造后：iframe 直接嵌入，所有操作留在应用内；保留"新窗口打开"降级按钮。
 *
 * ## 为什么用 iframe 而不是重写整个功能
 * - 学习目标本体（三张表 + 打卡 + 复盘）部署在资料库空间，数据层不走本应用后端；
 * - 全量重写 = 从零做数据访问层 + 打卡逻辑 + 复盘表单 + 本地/云端同步 ≈ 一周活；
 * - iframe 一进就用，外部功能不受本应用发版节奏影响；
 * - 外部页没设 `X-Frame-Options`，可直接内嵌。
 *
 * ## iframe 安全属性
 * - `sandbox='allow-same-origin allow-scripts allow-forms allow-popups'`
 *   —— 允许同源（外部页走自己存储）、跑脚本、提交表单、弹 window.open（内部链接），
 *     但禁止 `allow-top-navigation`（防止劫持顶层页面）、禁止 `allow-downloads`（禁止静默下载）；
 * - `referrerPolicy='no-referrer'` —— 不泄露来源 URL。
 * - `loading='lazy'` —— 浏览器空闲时才开始加载。
 */
const LEARNING_GOAL_URL = 'https://workbuddy.link/p/rKnqUNYStrnTP0n8SokMDb'

const PAGE_HTML = `学习目标：有终点、有总量的进度追踪 — 完成率 / 连续天数 / 预计完成日。数据存于资料库，多端同步。`

export default function LearningGoalPage() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState(false)
  const [attempt, setAttempt] = useState(0)
  /**
   * onLoad 是否已发生。必须用 ref：effect 闭包捕获的是挂载时的 `ready`（恒为 false），
   * 直接写 `if (!ready)` 会让 15 秒计时器在 iframe 已加载成功后仍误报超时、
   * 弹出错误遮罩盖住页面（stale closure）。
   */
  const loadedRef = useRef(false)

  // 给 iframe 一个超时兜底：15 秒没加载成功，显示网络错误卡片
  useEffect(() => {
    loadedRef.current = false
    setReady(false)
    setError(false)
    const t = setTimeout(() => {
      if (!loadedRef.current) setError(true)
    }, 15000)
    return () => clearTimeout(t)
  }, [attempt])

  const retry = () => setAttempt((a) => a + 1)

  return (
    <PageShell tone="board" baseWidth={1280}>
      <PageHeader
        title="学习目标"
        subtitle={PAGE_HTML}
      />

      <Box
        sx={{
          position: 'relative',
          // 撑满 Layout 剩余高度（PageHeader 约 104px，PageShell padding 24×2px，留给 iframe 剩下的）
          height: { xs: 'calc(100vh - 176px)', md: 'calc(100vh - 184px)' },
          minHeight: 600,
          borderRadius: 'var(--r-md)',
          border: '1px solid',
          borderColor: 'divider',
          overflow: 'hidden',
          bgcolor: 'var(--canvas)',
          // 防止 iframe 捕获焦点时顶栏闪烁
          isolation: 'isolate',
        }}
      >
        {/* iframe 加载中 / 失败遮罩 */}
        {!ready && !error && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 1.5,
              bgcolor: 'var(--canvas)',
            }}
          >
            <CircularProgress size={32} />
            <Typography variant="body2" color="text.secondary">
              正在加载学习目标管理台…
            </Typography>
          </Box>
        )}

        {/* 网络失败兜底 */}
        {error && (
          <Box
            sx={{
              position: 'absolute',
              inset: 0,
              zIndex: 2,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              bgcolor: 'var(--canvas)',
              p: 4,
            }}
          >
            <Alert severity="warning" variant="outlined" sx={{ maxWidth: 520, width: '100%' }}>
              学习目标管理台加载超时（15s）。检查网络后重试，或直接在新窗口打开。
            </Alert>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <Button variant="outlined" onClick={retry}>
                重试
              </Button>
              <Button
                variant="contained"
                startIcon={<OpenInNewIcon />}
                href={LEARNING_GOAL_URL}
                target="_blank"
                rel="noreferrer"
              >
                新窗口打开
              </Button>
            </Box>
          </Box>
        )}

        <iframe
          key={attempt}
          title="学习目标管理台"
          src={LEARNING_GOAL_URL}
          onLoad={() => {
            loadedRef.current = true
            setReady(true)
          }}
          sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
          referrerPolicy="no-referrer"
          loading="lazy"
          allow="clipboard-write"
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            border: 'none',
            background: 'var(--canvas)',
          }}
        />

        {/* 右下角「新窗口打开」小按钮（即使 iframe 成功也留着，方便需要更大工作区时使用） */}
        {ready && (
          <Button
            size="small"
            endIcon={<OpenInNewIcon sx={{ fontSize: 14 }} />}
            href={LEARNING_GOAL_URL}
            target="_blank"
            rel="noreferrer"
            sx={{
              position: 'absolute',
              right: 12,
              bottom: 12,
              zIndex: 3,
              height: 28,
              fontSize: 11.5,
              bgcolor: 'var(--surface, rgba(255,255,255,0.9))',
              backdropFilter: 'blur(8px)',
              border: '1px solid var(--line, rgba(0,0,0,0.08))',
              '&:hover': { bgcolor: 'action.hover' },
            }}
          >
            新窗口打开
          </Button>
        )}
      </Box>
    </PageShell>
  )
}
