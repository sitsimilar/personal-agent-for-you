import { useEffect, useRef, useState, type MouseEvent } from 'react'
import {
  AppBar,
  Avatar,
  Box,
  Button,
  Collapse,
  Divider,
  Drawer,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Select,
  Toolbar,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material'
import AddIcon from '@mui/icons-material/Add'
import MenuIcon from '@mui/icons-material/Menu'
import FolderIcon from '@mui/icons-material/Folder'
import LogoutIcon from '@mui/icons-material/Logout'
import SettingsIcon from '@mui/icons-material/Settings'
import ExpandLessIcon from '@mui/icons-material/ExpandLess'
import ExpandMoreIcon from '@mui/icons-material/ExpandMore'
import DownloadIcon from '@mui/icons-material/Download'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore, useCurrentUser } from '@/store/authStore'
import { useRecordStore } from '@/store/recordStore'
import { useProfileStore } from '@/store/profileStore'
import { useUiShellStore } from '@/store/uiShellStore'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import { resolveUiSchemeFeatures } from '@/lib/ui-scheme'
import {
  DRAWER_WIDTH,
  bottomNavPadding,
  isBottomNavVisible,
  isCompactTopBar,
  permanentDrawerMediaQuery,
  resolveDrawerModeFromMatch,
} from '@/lib/shell-layout'
import { NAV_GROUPS, type NavCountKey as CountKey } from '@/lib/nav'
import {
  SEARCH_INPUT_ID,
  SHORTCUTS,
  createSequenceState,
  disabledShortcutIds,
  isEditableTarget,
  resolveShortcut,
} from '@/lib/shortcuts'
import { runViewTransition } from '@/lib/view-transition'
import { authService } from '@/services/authService'
import { profileService } from '@/services/profileService'
import { recordService } from '@/services/recordService'
import { PRESET_CATEGORIES } from '@shared/constants/categories'
import SearchBar from './SearchBar'
import ContextMenu from './ContextMenu'
import RecordCreateDialog from './RecordCreateDialog'
import RecordDetail from './RecordDetail'
import TitleBar, { TITLE_BAR_HEIGHT } from './TitleBar'
import NoticeHost from './NoticeHost'
import ReminderScheduler from './ReminderScheduler'
import SchemeSwitcher from './SchemeSwitcher'
import CommandPalette from './CommandPalette'
import ShortcutHelpDialog from './ShortcutHelpDialog'
import MobileBottomNav from './MobileBottomNav'

/* 侧栏骨架（P0-4）：宽度与断点常量全部来自 `@/lib/shell-layout`（唯一事实源）。 */

/** 是否处于桌面悬浮窗 companion 模式（该模式不挂提醒调度，避免双窗口重复提醒）。 */
function isCompanionMode(): boolean {
  try {
    return new URLSearchParams(window.location.search).get('mode') === 'companion'
  } catch {
    return false
  }
}

interface LayoutProps {
  /** 是否桌面主窗口模式（由 App 传入 ?desktop=1 检测结果） */
  desktopMain?: boolean
}

/** 搜索范围下拉（命令栏左侧）。 */
const SCOPE_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'idea', label: '想法' },
  { value: 'material', label: '资料' },
  { value: 'todo', label: '待办' },
]

type CountsValue = { all: number; idea: number; material: number; todoPending: number }
/** 导航徽标计数缓存（60s 内复用，避免每次切页 4 条 count 查询）。 */
let countsCache: { value: CountsValue; ts: number } | null = null
const COUNTS_TTL_MS = 60_000

export default function Layout({ desktopMain }: LayoutProps) {
  const navigate = useNavigate()
  const location = useLocation()
  const theme = useTheme()
  const user = useCurrentUser()
  const clear = useAuthStore((s) => s.clear)
  const profileNickname = useProfileStore((s) => s.nickname)
  const profileAvatar = useProfileStore((s) => s.avatarUrl)
  const createOpen = useUiShellStore((s) => s.createOpen)
  const closeCreate = useUiShellStore((s) => s.closeCreate)
  const openCreate = useUiShellStore((s) => s.openCreate)
  const scheme = useUiSchemeStore((s) => s.scheme)
  const hydrateFromCloud = useUiSchemeStore((s) => s.hydrateFromCloud)
  /** 能力位随方案实时变化（每次 render 重算，成本可忽略）。 */
  const features = resolveUiSchemeFeatures(scheme)
  const [categoryOpen, setCategoryOpen] = useState(false)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const [avatarMenu, setAvatarMenu] = useState<HTMLElement | null>(null)
  const [counts, setCounts] = useState<{ all?: number; idea?: number; material?: number; todoPending?: number } | null>(null)

  /**
   * 侧栏形态（P0-4）：>= 768px 常驻占位，< 768px 改为覆盖式抽屉。
   *
   * 判定入口只有两个：`permanentDrawerMediaQuery()`（媒体查询字符串）与
   * `resolveDrawerModeFromMatch()`（布尔 → 模式），两者都由 `lib/shell-layout.ts`
   * 的 `PERMANENT_DRAWER_MIN_WIDTH` 派生 —— 组件里不再出现第二个断点数字。
   */
  const wideEnough = useMediaQuery(permanentDrawerMediaQuery())
  const drawerMode = resolveDrawerModeFromMatch(wideEnough)
  const isPermanentDrawer = drawerMode === 'permanent'
  /**
   * 底部导航与顶栏收敛（P0-4 下半）：都由 `drawerMode` 派生，不引入第二个断点数字。
   * 侧栏常驻时侧栏本身就常显，底部导航不再画；顶栏也保持改造前的完整形态 ——
   * 这正是「桌面端信息密度不降低」的实现口径。
   */
  const bottomNavVisible = isBottomNavVisible(drawerMode)
  const compactTopBar = isCompactTopBar(drawerMode)
  /** 头像菜单是否可点开：分区方案（顶栏精简）与窄屏收敛都必须能进「导出 / 设置 / 退出登录」。 */
  const avatarMenuEnabled = features.slimTopBar || compactTopBar
  /** 窄屏抽屉的展开状态（常驻模式下无意义，切换回常驻时会被清掉）。 */
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // 窄 → 宽：收起残留状态，避免回到常驻模式后又"留"一层遮罩/焦点陷阱
  useEffect(() => {
    if (isPermanentDrawer) setMobileNavOpen(false)
  }, [isPermanentDrawer])

  // 桌面主窗口模式：query 参数 ?desktop=1 或存在 desktopBridge 均视为桌面环境
  const isDesktop = Boolean(desktopMain) || Boolean(window.desktopBridge)
  const topOffset = 64 + (isDesktop ? TITLE_BAR_HEIGHT : 0)

  // 导航徽标计数（60s 缓存；拉不到就省略，不写死）
  useEffect(() => {
    if (countsCache && Date.now() - countsCache.ts < COUNTS_TTL_MS) {
      setCounts(countsCache.value)
      return
    }
    let cancelled = false
    recordService
      .counts()
      .then((c) => {
        countsCache = { value: c, ts: Date.now() }
        if (!cancelled) setCounts(c)
      })
      .catch(() => {
        if (!cancelled) setCounts(null)
      })
    return () => {
      cancelled = true
    }
  }, [location.pathname])

  /**
   * 界面方案：登录后与云端对齐一次。
   *
   * 只在「本次会话没手动改过」时才采用云端值（见 `uiSchemeStore.hydrateFromCloud`），
   * 否则会把用户刚在另一台设备之外做的切换抢回去。
   */
  useEffect(() => {
    let cancelled = false
    profileService
      .getSettings()
      .then((row) => {
        if (!cancelled) hydrateFromCloud(row)
      })
      .catch(() => {
        if (!cancelled) hydrateFromCloud(null)
      })
    return () => {
      cancelled = true
    }
  }, [hydrateFromCloud])

  /**
   * 快捷键统一入口（P1-14）。
   *
   * **只有一个 `keydown` 监听**：先前只有命令面板的 `Ctrl+K` 是自己挂的监听，
   * 每加一个快捷键就再加一个监听，键位之间还会互相抢事件（谁先 preventDefault 谁生效）。
   * 现在全部走 `lib/shortcuts.ts` 的注册表，本组件只负责「把 id 映射成动作」。
   *
   * 三条闸门（顺序不能换）：
   * 1. 能力位缺失 → 该条进 `disabledIds`（不注册 = 按了没反应，但也不会拦截浏览器原生行为）；
   * 2. 可编辑目标 → 除非 `allowInEditable`，否则让位（在输入框里按 `Ctrl+N` 必须是打字，不是新建）；
   * 3. 任一对话框打开 → 整表挂起，只留命令面板开关（`Esc` 由各对话框自理）。
   */
  const shortcutSequence = useRef(createSequenceState())
  const [shortcutHelpOpen, setShortcutHelpOpen] = useState(false)
  const paletteOpen = useUiShellStore((s) => s.paletteOpen)
  const detailRecord = useUiShellStore((s) => s.detailRecord)
  const closeRecordDetail = useUiShellStore((s) => s.closeRecordDetail)
  const openRecordDetail = useUiShellStore((s) => s.openRecordDetail)

  const scope = (() => {
    if (location.pathname === '/todo') return 'todo'
    if (location.pathname.startsWith('/records')) {
      const type = new URLSearchParams(location.search).get('type')
      if (type === 'idea') return 'idea'
      if (type === 'material') return 'material'
    }
    return 'all'
  })()

  const isActive = (path: string) => {
    if (path === '/') return location.pathname === '/'
    return location.pathname + location.search === path
  }

  /**
   * 页面跳转（流畅方案下走 View Transition）。
   *
   * 只覆盖**壳层导航**（左侧抽屉）。页面内部的按钮跳转仍走普通路由 ——
   * 这不是偷懒：View Transition 要求同步提交 DOM，页面内部跳转往往伴随数据加载，
   * 硬套过渡会出现"过渡结束了内容还没来"。宁可不做，也不要半截动画。
   */
  const go = (path: string) => {
    // 窄屏覆盖式抽屉：点任何导航项（含分类折叠区）后先收起，否则内容被遮罩盖住
    setMobileNavOpen(false)
    if (location.pathname + location.search === path) return
    if (features.viewTransitions) runViewTransition(() => navigate(path))
    else navigate(path)
  }

  const handleSearch = (keyword: string) => {
    navigate(`/records?keyword=${encodeURIComponent(keyword)}`)
  }

  const handleScopeChange = (value: string) => {
    if (value === 'all') go('/')
    else if (value === 'idea') go('/records?type=idea')
    else if (value === 'material') go('/records?type=material')
    else if (value === 'todo') go('/todo')
  }

  // 注册表 → 动作。放在 `go` 之后：快捷键的跳转必须复用壳层导航（含窄屏收起抽屉）。
  useEffect(() => {
    const modalOpen = createOpen || paletteOpen || shortcutHelpOpen
    const disabled = new Set(disabledShortcutIds({ commandPalette: features.commandPalette }))
    if (modalOpen) {
      // 挂起除命令面板外的全部条目：对话框有焦点，全局热键此时只会误伤
      for (const spec of SHORTCUTS) {
        if (spec.id !== 'command-palette') disabled.add(spec.id)
      }
    }

    const onKey = (e: KeyboardEvent) => {
      const resolution = resolveShortcut(
        {
          key: e.key,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
          altKey: e.altKey,
          shiftKey: e.shiftKey,
        },
        {
          state: shortcutSequence.current,
          editable: isEditableTarget(e.target),
          disabledIds: [...disabled],
        },
      )
      if (resolution.type !== 'run') return
      e.preventDefault()
      const { id, path } = resolution.shortcut
      if (id === 'command-palette') {
        useUiShellStore.getState().togglePalette()
        return
      }
      if (id === 'create-record') {
        openCreate()
        return
      }
      if (id === 'focus-search') {
        document.getElementById(SEARCH_INPUT_ID)?.focus()
        return
      }
      if (id === 'shortcut-help') {
        setShortcutHelpOpen(true)
        return
      }
      // 导航类：目标路由由注册表给出，这里不再硬编码第二份路径表
      if (path) go(path)
    }

    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    createOpen,
    paletteOpen,
    shortcutHelpOpen,
    features.commandPalette,
    features.viewTransitions,
    location.pathname,
    location.search,
    navigate,
    openCreate,
  ])

  const handleExport = () => {
    // 用 getState 读取当前列表，避免 Layout 订阅 records 导致整壳随列表变化重渲染
    const records = useRecordStore.getState().records
    const blob = new Blob([JSON.stringify(records, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `personal-agent-export-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  const handleContextMenu = (e: MouseEvent<HTMLElement>) => {
    // 桌面环境（主窗口/悬浮窗）由 Electron 原生菜单接管，避免双菜单
    if (window.desktopBridge) return
    e.preventDefault()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  const handleLogout = async () => {
    try {
      await authService.signOut()
    } catch {
      /* 忽略登出错误 */
    }
    clear()
    navigate('/login', { replace: true })
  }

  const userLabel = user?.name || user?.phone || user?.email || '用户'
  const displayName = profileNickname?.trim() || userLabel

  const countOf = (key?: CountKey) => (key && counts ? counts[key] : undefined)

  return (
    <Box sx={{ display: 'flex', height: '100vh' }} onContextMenu={handleContextMenu}>
      {isDesktop && <TitleBar />}
      <AppBar
        position="fixed"
        elevation={0}
        sx={{
          top: isDesktop ? TITLE_BAR_HEIGHT : 0,
          /**
           * 必须是动态值：临时抽屉的 Modal 根层级被 MUI 写死为 `zIndex.drawer`(1200)，
           * 顶栏若固定 `drawer + 1`(1201) 会连按钮一起浮到遮罩与纸面之上 —— 抽屉展开时
           * 顶栏仍可点（可达回归）。常驻模式保持 1201 压在纸面之上，窄屏回落到 appBar(1100)，
           * 让遮罩盖住顶栏、点顶栏区域等于点遮罩（即关闭抽屉）。
           */
          zIndex: isPermanentDrawer ? theme.zIndex.drawer + 1 : theme.zIndex.appBar,
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderBottom: '1px solid',
          borderColor: 'divider',
        }}
      >
        <Toolbar sx={{ gap: 1.5 }}>
          {/* 窄屏：汉堡按钮（44×44 触摸目标，可被辅助技术识别）；宽屏常驻侧栏时不需要 */}
          {!isPermanentDrawer && (
            <IconButton
              aria-label="展开导航"
              aria-expanded={mobileNavOpen}
              onClick={() => setMobileNavOpen(true)}
              sx={{ ml: -0.5, minWidth: 44, minHeight: 44 }}
            >
              <MenuIcon />
            </IconButton>
          )}
          {/*
            窄屏收敛：375 档顶栏一旦保留「标题 + 范围下拉 + 导出 + 退出登录」，
            控件右边界会顶到 x=601（§八 第 4 项门槛是视口宽 - 8）。这里把非必要元素
            全部让位给搜索框，退出登录 / 导出改走头像菜单（窄屏恒可点开，不会无路可走）。
          */}
          {!compactTopBar && (
            <Typography variant="h6" fontWeight={700} noWrap sx={{ mr: 0.5 }}>
              个人信息管家
            </Typography>
          )}
          {!compactTopBar && (
            <Select
              size="small"
              value={scope}
              onChange={(e) => handleScopeChange(e.target.value)}
              sx={{ minWidth: 92, fontSize: 13, flex: 'none' }}
              inputProps={{ 'aria-label': '搜索范围' }}
            >
              {SCOPE_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {o.label}
                </MenuItem>
              ))}
            </Select>
          )}
          {/* minWidth: 0 —— flex 子项默认 minWidth:auto，窄屏会被输入框的最小宽度顶出视口 */}
          <Box sx={{ flex: 1, minWidth: 0, maxWidth: 560 }}>
            <SearchBar
              onSearch={handleSearch}
              showPaletteHint={features.commandPalette}
              focusId={SEARCH_INPUT_ID}
            />
          </Box>

          {/* 界面方案快捷入口：三个方案下都常驻，位置不变（独立入口） */}
          <SchemeSwitcher />

          {/*
            分区方案：顶栏精简 —— 「快速记录」下移到页眉带（PageHeader），
            「导出 / 退出登录」收进头像菜单。其余方案保持改造前的 7 个元素不动。
          */}
          {!features.slimTopBar && !compactTopBar && (
            <Tooltip title="快速记录">
              <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate} sx={{ flex: 'none' }}>
                快速记录
              </Button>
            </Tooltip>
          )}
          {!features.slimTopBar && !compactTopBar && (
            <Tooltip title="导出当前列表为 JSON">
              <Button variant="outlined" startIcon={<DownloadIcon />} onClick={handleExport} sx={{ flex: 'none' }}>
                导出
              </Button>
            </Tooltip>
          )}

          <Tooltip title={displayName}>
            <Avatar
              src={profileAvatar ?? undefined}
              onClick={avatarMenuEnabled ? (e) => setAvatarMenu(e.currentTarget) : undefined}
              sx={{
                bgcolor: 'primary.main',
                width: 34,
                height: 34,
                fontSize: 14,
                ...(avatarMenuEnabled ? { cursor: 'pointer' } : {}),
              }}
            >
              {displayName.slice(0, 1)}
            </Avatar>
          </Tooltip>

          {!features.slimTopBar && !compactTopBar && (
            <Tooltip title="退出登录">
              <IconButton onClick={handleLogout} aria-label="退出登录">
                <LogoutIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Toolbar>
      </AppBar>

      <Menu
        anchorEl={avatarMenu}
        open={!!avatarMenu}
        onClose={() => setAvatarMenu(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { minWidth: 180 } } }}
      >
        <MenuItem
          onClick={() => {
            setAvatarMenu(null)
            handleExport()
          }}
        >
          <DownloadIcon fontSize="small" sx={{ mr: 1 }} />
          导出当前列表
        </MenuItem>
        <MenuItem
          onClick={() => {
            setAvatarMenu(null)
            go('/settings')
          }}
        >
          <SettingsIcon fontSize="small" sx={{ mr: 1 }} />
          设置
        </MenuItem>
        <Divider />
        <MenuItem
          onClick={() => {
            setAvatarMenu(null)
            void handleLogout()
          }}
        >
          <LogoutIcon fontSize="small" sx={{ mr: 1 }} />
          退出登录
        </MenuItem>
      </Menu>

      <Drawer
        variant={drawerMode}
        open={isPermanentDrawer ? true : mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
        ModalProps={{ keepMounted: true }}
        sx={{
          // 只有常驻模式才占布局宽度；覆盖式（< 768px）必须让主内容拿到整屏
          ...(isPermanentDrawer ? { width: DRAWER_WIDTH, flexShrink: 0 } : {}),
          '& .MuiDrawer-paper': { width: DRAWER_WIDTH, boxSizing: 'border-box', pt: `${topOffset}px` },
        }}
      >
        <List component="nav" sx={{ px: 1, flex: 1, overflow: 'auto' }}>
          {NAV_GROUPS.map((group) => (
            <Box key={group.title} sx={{ mb: 1 }}>
              <Typography
                variant="overline"
                sx={{ px: 1.5, pt: 1, pb: 0.5, display: 'block', color: 'text.disabled', fontSize: 10.5, fontWeight: 600, letterSpacing: '0.08em' }}
              >
                {group.title}
              </Typography>
              {group.items.map((item) => {
                const count = countOf(item.countKey)
                const active = isActive(item.path)
                return (
                  <ListItemButton
                    key={item.label}
                    selected={active}
                    onClick={() => go(item.path)}
                    aria-current={active ? 'page' : undefined}
                    sx={{ borderRadius: 2, mb: 0.25 }}
                  >
                    <ListItemIcon sx={{ minWidth: 34 }}>{item.icon}</ListItemIcon>
                    <ListItemText primary={item.label} primaryTypographyProps={{ fontSize: 14 }} />
                    {count !== undefined && (
                      <Typography
                        variant="caption"
                        sx={{
                          color: 'text.secondary',
                          fontSize: 12,
                          minWidth: 20,
                          textAlign: 'center',
                          bgcolor: 'action.hover',
                          borderRadius: 1.5,
                          px: 0.75,
                          py: 0.25,
                        }}
                      >
                        {count}
                      </Typography>
                    )}
                  </ListItemButton>
                )
              })}
            </Box>
          ))}

          <Divider sx={{ my: 1 }} />
          <ListItemButton onClick={() => setCategoryOpen((v) => !v)} sx={{ borderRadius: 2 }}>
            <ListItemIcon sx={{ minWidth: 34 }}>
              <FolderIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText primary="分类标签" primaryTypographyProps={{ fontSize: 14 }} />
            {categoryOpen ? <ExpandLessIcon fontSize="small" /> : <ExpandMoreIcon fontSize="small" />}
          </ListItemButton>
          <Collapse in={categoryOpen} timeout="auto" unmountOnExit>
            <List component="div" disablePadding>
              {PRESET_CATEGORIES.map((c) => (
                <ListItemButton
                  key={c.key}
                  sx={{ pl: 5, borderRadius: 2 }}
                  onClick={() => go(`/records?category=${encodeURIComponent(c.key)}`)}
                >
                  <Box
                    sx={{
                      width: 10,
                      height: 10,
                      borderRadius: '50%',
                      bgcolor: c.color,
                      mr: 1.5,
                      flexShrink: 0,
                    }}
                  />
                  <ListItemText primary={c.label} primaryTypographyProps={{ fontSize: 13 }} />
                </ListItemButton>
              ))}
            </List>
          </Collapse>
        </List>
      </Drawer>

      {/*
        底部导航（P0-4 下半）：只在窄屏出现。`onOpenMore` 打开的就是上面那个
        全量抽屉 —— 「更多」不另存一份菜单，`NAV_GROUPS` 仍是唯一事实源。
      */}
      {bottomNavVisible && (
        <MobileBottomNav
          activePath={location.pathname}
          onNavigate={go}
          onOpenMore={() => setMobileNavOpen(true)}
          onCreate={openCreate}
          moreOpen={mobileNavOpen}
        />
      )}

      {/* minWidth: 0 —— flex 子项默认 minWidth:auto，窄屏会被内容顶宽导致溢出 */}
      <Box
        component="main"
        sx={{
          flex: 1,
          minWidth: 0,
          pt: `${topOffset}px`,
          // 窄屏必须给底部导航让位（含 env(safe-area-inset-bottom)），否则最后一行永远被盖住
          pb: bottomNavVisible ? bottomNavPadding() : 0,
          overflow: 'auto',
          height: '100vh',
        }}
      >
        {/* 页面切换转场：以 pathname 为 key 触发淡入+上移（时长取 --motion-enter），尊重 prefers-reduced-motion */}
        <Box key={location.pathname} className="page-in" sx={{ minHeight: '100%' }}>
          <Outlet />
        </Box>
      </Box>

      <RecordCreateDialog
        open={createOpen}
        onClose={closeCreate}
        onCreated={() => closeCreate()}
      />

      <ContextMenu
        open={!!contextMenu}
        x={contextMenu?.x ?? 0}
        y={contextMenu?.y ?? 0}
        onClose={() => setContextMenu(null)}
      />

      {/* 命令面板只在流畅方案挂载：没挂载 = 快捷键不注册，不会出现"按了没反应" */}
      {features.commandPalette && <CommandPalette />}

      {/**
       * 全局记录详情（P1-12 下半）：命令面板可以在任意页面打开任意一条记录，
       * 所以需要一个不依赖当前页面的宿主。各页面自己的 `<RecordDetail>` 保持不动，
       * 两处互不干扰（同一时刻最多一处有值）。
       */}
      <RecordDetail
        record={detailRecord}
        open={!!detailRecord}
        onClose={closeRecordDetail}
        onChanged={() => void useRecordStore.getState().load()}
        onDeleted={closeRecordDetail}
        onOpenRecord={openRecordDetail}
      />

      {/* 快捷键速查（`?` 打开）：内容由 `lib/shortcuts.ts` 注册表派生 */}
      <ShortcutHelpDialog open={shortcutHelpOpen} onClose={() => setShortcutHelpOpen(false)} />

      {/* 提醒调度（30s 轮询 + 通知点击跳转）与应用内提示宿主 */}
      {!isCompanionMode() && <ReminderScheduler />}
      <NoticeHost />
    </Box>
  )
}
