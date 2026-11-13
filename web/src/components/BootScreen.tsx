import { useState } from 'react'
import { Box, Button, LinearProgress, Typography } from '@mui/material'
import { useAuthStore } from '@/store/authStore'
import { nextBootGreeting } from '@/lib/greeting'

/**
 * 启动专用等待界面：品牌 Logo + 品牌名 + 加载文案 + 不确定进度条。
 * 启动超时/失败时展示可读错误 + 「重试」按钮（重新加载页面触发 bootstrap）。
 *
 * 加载文案不是固定的「正在加载…」，而是按时段从 `lib/greeting.ts` 的文案池里挑一条，
 * 并排除上一次显示过的那条（连续刷新不重复）。挑选逻辑是纯本地的：
 * 这里显示的时候还没登录、也可能没网，不能依赖任何请求。
 */
export default function BootScreen() {
  const bootError = useAuthStore((s) => s.bootError)
  /**
   * 只在挂载时挑一次（`useState` 惰性初始化）：
   * 若放在渲染体里，任何一次重渲染都会换一句，读起来像在闪。
   */
  const [greeting] = useState(() => nextBootGreeting())

  return (
    <Box
      sx={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 2,
        bgcolor: 'background.default',
      }}
    >
      {/* 品牌 Logo（品牌主色方块 + 首字，入场淡入缩放） */}
      <Box
        className="boot-logo-in"
        sx={{
          width: 72,
          height: 72,
          borderRadius: '18px',
          bgcolor: 'primary.main',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 8px 24px rgba(91, 84, 217, 0.28)',
        }}
      >
        <Typography sx={{ color: '#fff', fontWeight: 700, fontSize: 34, lineHeight: 1 }}>
          管
        </Typography>
      </Box>

      <Typography variant="h6" fontWeight={700} color="text.primary">
        个人信息管家
      </Typography>

      {bootError ? (
        <>
          <Typography variant="body2" color="error" sx={{ maxWidth: 320, textAlign: 'center' }}>
            {bootError}
          </Typography>
          <Button variant="contained" size="small" onClick={() => window.location.reload()}>
            重试
          </Button>
        </>
      ) : (
        <>
          {/* 问候语：断网、离线、登录前都能显示（池子在包内，不发请求） */}
          <Typography variant="body2" color="text.secondary" align="center" sx={{ maxWidth: 320 }}>
            {greeting.text}
          </Typography>

          {/* 不确定进度条：加载状态提示 */}
          <LinearProgress
            sx={{
              width: 220,
              height: 4,
              borderRadius: 2,
              '& .MuiLinearProgress-bar': { borderRadius: 2 },
            }}
          />
        </>
      )}
    </Box>
  )
}
