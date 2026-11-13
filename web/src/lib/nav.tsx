import HomeIcon from '@mui/icons-material/Home'
import LightbulbIcon from '@mui/icons-material/Lightbulb'
import FolderIcon from '@mui/icons-material/Folder'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import AccountTreeIcon from '@mui/icons-material/AccountTree'
import InsightsIcon from '@mui/icons-material/Insights'
import TrackChangesIcon from '@mui/icons-material/TrackChanges'
import CalendarMonthIcon from '@mui/icons-material/CalendarMonth'
import HandymanIcon from '@mui/icons-material/Handyman'
import DeleteIcon from '@mui/icons-material/Delete'
import SettingsIcon from '@mui/icons-material/Settings'
import ExtensionIcon from '@mui/icons-material/Extension'
import type { ReactNode } from 'react'

/**
 * 主导航配置 —— **单一事实来源**。
 *
 * 抽出来的原因：导航同时被三处消费 —— 左侧抽屉、命令面板（流畅方案）、
 * 以及将来的快捷键注册表。写在 `Layout.tsx` 里会导致命令面板 import 整个布局组件，
 * 既拖包体又容易循环依赖。
 *
 * 加菜单只改这里：抽屉与命令面板会同时出现新入口，不会漏。
 */

/** 导航徽标对应的计数键。 */
export type NavCountKey = 'all' | 'idea' | 'material' | 'todoPending'

export interface NavItem {
  label: string
  path: string
  icon: ReactNode
  countKey?: NavCountKey
  /** 命令面板里的补充说明（抽屉里不显示）。 */
  hint?: string
}

export interface NavGroup {
  title: string
  items: NavItem[]
}

export const NAV_GROUPS: NavGroup[] = [
  {
    title: '工作台',
    items: [
      { label: '全部信息', path: '/', icon: <HomeIcon fontSize="small" />, countKey: 'all', hint: '想法、资料、待办' },
      { label: '想法', path: '/records?type=idea', icon: <LightbulbIcon fontSize="small" />, countKey: 'idea' },
      { label: '资料', path: '/records?type=material', icon: <FolderIcon fontSize="small" />, countKey: 'material' },
      { label: '待办', path: '/todo', icon: <CheckCircleIcon fontSize="small" />, countKey: 'todoPending', hint: '今天 / 即将 / 某天' },
      { label: '日历', path: '/calendar', icon: <CalendarMonthIcon fontSize="small" /> },
      { label: '回顾', path: '/review', icon: <InsightsIcon fontSize="small" /> },
      { label: '学习目标', path: '/learning-goal', icon: <TrackChangesIcon fontSize="small" /> },
    ],
  },
  {
    title: '智能能力',
    items: [
      { label: '思维树', path: '/mindtree', icon: <AccountTreeIcon fontSize="small" /> },
      { label: '工具箱', path: '/tools', icon: <HandymanIcon fontSize="small" /> },
    ],
  },
  {
    title: '系统',
    items: [
      { label: '插件', path: '/plugins', icon: <ExtensionIcon fontSize="small" /> },
      { label: '回收站', path: '/recycle', icon: <DeleteIcon fontSize="small" /> },
      { label: '设置', path: '/settings', icon: <SettingsIcon fontSize="small" /> },
    ],
  },
]

/** 拍平后的导航项（命令面板按顺序消费）。 */
export function flatNavItems(): NavItem[] {
  return NAV_GROUPS.flatMap((g) => g.items)
}
