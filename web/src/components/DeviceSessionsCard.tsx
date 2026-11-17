import { useCallback, useEffect, useState } from 'react'
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material'
import RefreshIcon from '@mui/icons-material/Refresh'
import DesktopWindowsIcon from '@mui/icons-material/DesktopWindows'
import PhoneAndroidIcon from '@mui/icons-material/PhoneAndroid'
import PhoneIphoneIcon from '@mui/icons-material/PhoneIphone'
import LanguageIcon from '@mui/icons-material/Language'
import { deviceRegistry, isRegistryAvailable, type DeviceEntry } from '@/services/deviceRegistry'
import { formatLastSeen, isDeviceOnline } from '@/lib/device-time'
import { platformName, type PlatformKind } from '@/lib/platform'
import { pushNotice } from '@/store/noticeStore'

/** 平台图标（Android 用机器人、iOS 用手机、桌面端用显示器、网页用地球）。 */
function PlatformIcon({ platform }: { platform: PlatformKind }) {
  const common = { fontSize: 'small' as const }
  if (platform === 'desktop') return <DesktopWindowsIcon {...common} />
  if (platform === 'android') return <PhoneAndroidIcon {...common} />
  if (platform === 'ios') return <PhoneIphoneIcon {...common} />
  return <LanguageIcon {...common} />
}

/**
 * 已登录设备（多端同时在线）。
 *
 * 这张卡片存在的意义是**把「同一账号多端在线」从黑盒变成可见状态**：
 * - 用户能确认「手机和电脑都还在线」，而不是怀疑登录被挤掉；
 * - 换设备/丢手机时能主动把另一台请下线（不需要改密码）；
 * - 当前设备标「本机」，避免用户把自己点下线。
 *
 * 远端注销的边界必须说明白：云 SDK 没有「按会话踢人」的管理接口，这里做的是
 * **让对方下一次心跳时自行登出**（≤1 分钟生效），不是在服务端立刻吊销令牌。
 * 这个差别必须写进文案，否则用户以为「点了就断」。
 */
export default function DeviceSessionsCard() {
  const [devices, setDevices] = useState<DeviceEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [revoking, setRevoking] = useState<string | null>(null)
  const [available, setAvailable] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    const rows = await deviceRegistry.list()
    setDevices(rows)
    setAvailable(isRegistryAvailable())
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 回到前台刷新一次：用户在另一台设备上操作过的结果要能及时看到
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const revoke = async (entry: DeviceEntry) => {
    setRevoking(entry.deviceId)
    try {
      const okDone = await deviceRegistry.revoke(entry.deviceId)
      if (okDone) {
        pushNotice(`已通知「${entry.label || platformName(entry.platform)}」退出登录`, 'success')
        await load()
      } else {
        pushNotice('注销失败，请稍后重试', 'error')
      }
    } finally {
      setRevoking(null)
    }
  }

  if (!available) return null

  return (
    <Card variant="outlined" sx={{ mb: 2 }}>
      <CardContent>
        <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
          <Typography variant="subtitle2">已登录设备</Typography>
          <Chip size="small" label={`${devices.length} 台`} />
          <Box sx={{ flex: 1 }} />
          <Tooltip title="刷新">
            <span>
              <IconButton size="small" onClick={() => void load()} disabled={loading}>
                {loading ? <CircularProgress size={16} /> : <RefreshIcon fontSize="small" />}
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
          同一账号可在多台设备同时在线，记录与设置实时同步；「退出该设备」会在对方下次联网时生效（约 1 分钟内）。
        </Typography>

        <Stack spacing={1}>
          {devices.map((entry) => {
            const online = isDeviceOnline(entry.lastSeenAt)
            const name = entry.label || platformName(entry.platform)
            return (
              <Stack
                key={entry.deviceId}
                direction="row"
                alignItems="center"
                spacing={1}
                sx={{ py: 0.5, borderTop: '1px solid', borderColor: 'divider' }}
              >
                <PlatformIcon platform={entry.platform} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" alignItems="center" spacing={0.75}>
                    <Typography variant="body2" noWrap sx={{ fontWeight: entry.current ? 600 : 400 }}>
                      {name}
                    </Typography>
                    {entry.current && <Chip size="small" label="本机" color="primary" />}
                    {entry.revoked && <Chip size="small" label="已退出" />}
                  </Stack>
                  <Typography variant="caption" color="text.secondary">
                    {online ? '在线' : '离线'} · {formatLastSeen(entry.lastSeenAt)}
                    {entry.appVersion ? ` · v${entry.appVersion}` : ''}
                  </Typography>
                </Box>
                {!entry.current && !entry.revoked && (
                  <Button
                    size="small"
                    color="inherit"
                    disabled={revoking === entry.deviceId}
                    onClick={() => void revoke(entry)}
                  >
                    退出该设备
                  </Button>
                )}
              </Stack>
            )
          })}
          {!loading && devices.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              暂无设备记录（多端在线功能需要先执行 v2.15 迁移）。
            </Typography>
          )}
        </Stack>
      </CardContent>
    </Card>
  )
}
