import type { ReactNode } from 'react'
import { Box, ButtonBase, Fab, Typography } from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import HomeIcon from '@mui/icons-material/Home'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import FolderIcon from '@mui/icons-material/Folder'
import PersonIcon from '@mui/icons-material/Person'
import MoreHorizIcon from '@mui/icons-material/MoreHoriz'
import {
  BOTTOM_NAV_HEIGHT,
  BOTTOM_NAV_ITEMS,
  isBottomNavItemActive,
  resolveFabBottomOffset,
  type BottomNavKey,
} from '@/lib/shell-layout'

/**
 * 窄屏底部导航（P0-4 下半）。
 *
 * 为什么独立成组件而不是塞回 `Layout.tsx`：`Layout.tsx` 已经 500+ 行、同时管着抽屉、
 * 顶栏、徽标计数、界面方案、命令面板；底部导航是**只在窄屏出现的一整块 UI**，
 * 混进去会让「这个壳到底有几个导航入口」更难读。
 *
 * 组件只做三件事：
 * 1. 画 4 个常驻项（配置来自 `shell-layout` 的 `BOTTOM_NAV_ITEMS`，不在这里重复写路径）；
 * 2. 画「更多」—— **不自己列菜单**，只是把既有全量抽屉叫起来（菜单数据仍只有
 *    `lib/nav.tsx` 一份，加菜单仍然只改那一处）；
 * 3. 画「新建记录」FAB，一次点击直达既有新建弹窗。
 *
 * 安全区处理：导航自身用 `paddingBottom: env(safe-area-inset-bottom)` 把纸面顶高，
 * 高度用 `calc(56px + env(...))`；FAB 的 `bottom` 由 `resolveFabBottomOffset()`
 * 算出「导航高 + 8px + 安全区」，所以永远不会压在导航上。
 */

/** 图标按 key 映射（纯函数模块里不放 JSX，否则 QA 的 Node 环境 import 不动）。 */
const ICONS: Record<BottomNavKey, ReactNode> = {
  home: <HomeIcon fontSize="small" />,
  todo: <CheckCircleIcon fontSize="small" />,
  records: <FolderIcon fontSize="small" />,
  mine: <PersonIcon fontSize="small" />,
}

interface MobileBottomNavProps {
  /** 当前 `pathname`（活跃判定只看它，忽略 query）。 */
  activePath: string
  /** 点导航项（由 `Layout` 的 `go()` 提供，内部会顺带收起抽屉）。 */
  onNavigate: (path: string) => void
  /** 点「更多」—— 打开既有全量抽屉。 */
  onOpenMore: () => void
  /** 点 FAB —— 打开既有新建弹窗。 */
  onCreate: () => void
  /** 「更多」抽屉是否展开（用于 `aria-expanded`）。 */
  moreOpen?: boolean
}

export default function MobileBottomNav({
  activePath,
  onNavigate,
  onOpenMore,
  onCreate,
  moreOpen = false,
}: MobileBottomNavProps) {
  return (
    <>
      <Box
        component="nav"
        aria-label="底部导航"
        sx={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          height: `calc(${BOTTOM_NAV_HEIGHT}px + env(safe-area-inset-bottom, 0px))`,
          // 纸面顶高、内容留在安全区之上：iPhone 的 Home 指示条会盖住最底部 34px
          pb: 'env(safe-area-inset-bottom, 0px)',
          display: 'flex',
          alignItems: 'stretch',
          bgcolor: 'background.paper',
          borderTop: '1px solid',
          borderColor: 'divider',
          // 与顶栏同级：低于 temporary 抽屉的遮罩（zIndex.drawer = 1200），
          // 抽屉展开时导航被遮住而不是浮在遮罩上面。
          zIndex: (t) => t.zIndex.appBar,
        }}
      >
        {BOTTOM_NAV_ITEMS.map((item) => {
          const active = isBottomNavItemActive(item.path, activePath)
          return (
            <ButtonBase
              key={item.key}
              onClick={() => onNavigate(item.path)}
              aria-label={item.label}
              aria-current={active ? 'page' : undefined}
              sx={{
                flex: 1,
                // 触摸目标下限 44×44：项本身 flex 撑满 56px 高，这里再兜一层
                minWidth: 44,
                minHeight: 44,
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'center',
                gap: '2px',
                color: active ? 'primary.main' : 'text.secondary',
                borderRadius: 0,
              }}
            >
              {ICONS[item.key]}
              <Typography component="span" sx={{ fontSize: 11, lineHeight: 1.2, fontWeight: active ? 600 : 400 }}>
                {item.label}
              </Typography>
            </ButtonBase>
          )
        })}

        <ButtonBase
          onClick={onOpenMore}
          aria-label="更多"
          aria-expanded={moreOpen}
          sx={{
            flex: 1,
            minWidth: 44,
            minHeight: 44,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            gap: '2px',
            color: 'text.secondary',
            borderRadius: 0,
          }}
        >
          <MoreHorizIcon fontSize="small" />
          <Typography component="span" sx={{ fontSize: 11, lineHeight: 1.2 }}>
            更多
          </Typography>
        </ButtonBase>
      </Box>

      {/*
        「新建记录」FAB：紧邻首项、悬在导航条上方 8px（含安全区）。
        为什么不放进导航条里做第 6 个 tab：导航项是「去某个页面」，FAB 是「立刻写」，
        两种语义混在一行会让拇指误触；浮起来同时满足「1 次点击进入新建」。
      */}
      <Fab
        color="primary"
        size="medium"
        aria-label="新建记录"
        onClick={onCreate}
        sx={{
          position: 'fixed',
          left: 12,
          bottom: resolveFabBottomOffset(),
          zIndex: (t) => t.zIndex.appBar,
        }}
      >
        <AddIcon />
      </Fab>
    </>
  )
}
