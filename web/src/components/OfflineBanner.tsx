import { useEffect, useState } from 'react'
import { Alert, Box } from '@mui/material'
import { readOnlineStatus, subscribeOnlineStatus } from '@/lib/pwa'

/**
 * 离线条幅（P1-9）。
 *
 * 只在断网时出现，告诉用户「你看到的是离线壳，数据可能不是最新的」——
 * 没有这条提示，离线缓存会被误认为实时数据（比不缓存更危险）。
 * 放在 `<main>` 内页面上方、页面转场 key 之外：切页不会让条幅闪一下。
 */
export default function OfflineBanner() {
  const [online, setOnline] = useState<boolean>(() => readOnlineStatus())

  useEffect(() => subscribeOnlineStatus(setOnline), [])

  if (online) return null

  return (
    <Box sx={{ px: { xs: 2, sm: 3 }, pt: 1 }}>
      <Alert severity="warning" role="status" sx={{ py: 0.25 }}>
        当前离线：显示的是本地缓存内容，恢复网络后会自动刷新。
      </Alert>
    </Box>
  )
}
