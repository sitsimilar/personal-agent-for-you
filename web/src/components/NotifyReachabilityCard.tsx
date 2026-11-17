import { useEffect, useState } from 'react'
import { Box, Button, Card, CardContent, Chip, Stack, Typography } from '@mui/material'
import {
  promptInstall,
  readNotifyReachability,
  subscribeInstallPrompt,
  type NotifyReachability,
} from '@/lib/pwa'
import { pushNotice } from '@/store/noticeStore'

const LEVEL_LABEL: Record<NotifyReachability['level'], string> = {
  ok: '可达',
  warn: '受限',
  limited: '仅应用内',
}

const LEVEL_COLOR: Record<NotifyReachability['level'], 'success' | 'warning' | 'default'> = {
  ok: 'success',
  warn: 'warning',
  limited: 'default',
}

/**
 * 通知可达性（P1-9 · 第 14 期 kukuroo 增补）。
 *
 * 为什么要三态文案而不是一句「请开启通知」：
 * iOS 的 Safari **标签页内根本不发通知**，只有「添加到主屏幕」并从图标打开才允许；
 * 把它和 Android Chrome 的标签页混为一谈，用户会以为自己开了权限却没收到，判定成产品坏了。
 * 判定逻辑全在 `resolveNotifyReachability`（纯函数），这里只负责展示与安装引导。
 */
export default function NotifyReachabilityCard() {
  const [reach, setReach] = useState<NotifyReachability>(() => readNotifyReachability())
  const [canInstall, setCanInstall] = useState(false)
  const [installing, setInstalling] = useState(false)

  useEffect(() => subscribeInstallPrompt(setCanInstall), [])

  // 切回页面时重算：用户可能刚去系统设置放开了权限
  useEffect(() => {
    const refresh = () => setReach(readNotifyReachability())
    document.addEventListener('visibilitychange', refresh)
    return () => document.removeEventListener('visibilitychange', refresh)
  }, [])

  const handleInstall = async () => {
    setInstalling(true)
    try {
      const outcome = await promptInstall()
      if (outcome === 'unavailable') {
        pushNotice('浏览器未提供安装入口，请在浏览器菜单里选择「添加到主屏幕」', 'info')
      }
    } finally {
      setInstalling(false)
      setReach(readNotifyReachability())
    }
  }

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
          <Typography variant="subtitle2">通知可达性</Typography>
          <Chip size="small" label={LEVEL_LABEL[reach.level]} color={LEVEL_COLOR[reach.level]} />
        </Stack>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {reach.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
          {reach.detail}
        </Typography>
        {reach.action === 'install' && (
          <Box sx={{ mt: 1.5 }}>
            {canInstall ? (
              <Button size="small" variant="outlined" onClick={handleInstall} disabled={installing}>
                {installing ? '正在唤起…' : '安装到主屏'}
              </Button>
            ) : (
              <Typography variant="caption" color="text.secondary">
                {reach.kind === 'ios-tab'
                  ? 'iOS：Safari 分享按钮 → 「添加到主屏幕」，再从主屏图标打开。'
                  : '浏览器菜单 → 「安装应用 / 添加到主屏幕」。'}
              </Typography>
            )}
          </Box>
        )}
      </CardContent>
    </Card>
  )
}
