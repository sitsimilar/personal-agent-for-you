import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Chip, CircularProgress, Dialog, Divider, InputBase, Typography } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import AddIcon from '@mui/icons-material/Add'
import PaletteOutlinedIcon from '@mui/icons-material/PaletteOutlined'
import KeyboardReturnIcon from '@mui/icons-material/KeyboardReturn'
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined'
import { useNavigate } from 'react-router-dom'
import type { InfoRecord } from '@shared/types/domain'
import { useUiShellStore } from '@/store/uiShellStore'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import { flatNavItems, type NavItem } from '@/lib/nav'
import {
  PALETTE_INITIAL_ACTIVE,
  applyRecentOrder,
  buildNavCommands,
  buildRecordCommands,
  filterCommands,
  groupCommands,
  moveActive,
  resolvePaletteKey,
  shouldSearchRecords,
  type PaletteCommand,
  type PaletteGroup,
} from '@/lib/palette'
import { readRecentIds, rememberRecentId } from '@/lib/palette-recent'
import { recordService } from '@/services/recordService'
import { UI_SCHEME_ORDER, getUiSchemeMeta, getUiSchemeName } from '@/lib/ui-scheme'

/**
 * 命令面板（仅「流畅优先」方案挂载，`features.commandPalette`）。
 *
 * ## 定位
 * 它不是"另一个搜索框"——搜索框检索**内容**，命令面板跳转**位置与动作**。
 * 11-13 起面板也接了记录检索（`recordService.search()`），但只作为「快速打开刚才想到的那条」
 * 的入口：输入 ≥2 个字才查、最多列 5 条、命中后直接开详情弹窗，不承担分页/筛选。
 *
 * ## 单一事实源
 * 「跳转」这一类**不手写**：由 `buildNavCommands(flatNavItems())` 从 `NAV_GROUPS` 派生，
 * 加菜单只改 `lib/nav.tsx`，抽屉与面板同时出现新入口。纯逻辑在 `lib/palette.ts`，
 * 本组件只留「状态 + 渲染 + 把命令跑起来」。
 *
 * ## 两个 provider，两段式
 * 1. **本地（同步）**：跳转 / 动作 / 换方案，打开即就绪，不依赖任何异步；
 * 2. **记录（异步）**：输入变化后 debounce 180ms 打一次 `search()`，请求带序号，
 *    只有最新一次可写回 —— 否则「先敲 '周报' 再敲 '周报模板'」会被慢请求的回包覆盖。
 *
 * ## 键盘契约（必须稳定，否则用户会误触）
 * - `↑ / ↓` 移动高亮（循环，到头回绕；从无高亮往下落在第 1 条、往上落在最后一条）
 * - `Enter` 执行高亮项
 * - `Esc` 关闭（不执行任何动作）
 * - 打开后输入框自动获焦，**默认不高亮任何项**，必须先按方向键或输入才产生高亮，
 *   这样"随手按 Enter"不会误触发第一个命令。
 * - 面板内的按键**不冒泡成全局快捷键**：`Layout` 的唯一 keydown 入口在面板打开时
 *   挂起除「开/关面板」外的全部条目，输入框本身又是可编辑目标（`isEditableTarget`）。
 *
 * ## 关于「2 帧内出面板」
 * 打开走 `uiShellStore.togglePalette()`（在 `Layout` 的唯一 keydown 入口里**同步**调用，
 * 不 debounce、不包 setTimeout）。`paletteOpen` 一变即触发本组件重渲染并挂 `<Dialog>`，
 * 也就是同一个事件轮次内提交、下一帧即可见 —— 面板里**没有任何异步加载**（命令全在内存里），
 * 所以「按了键却要等一会儿才出来」的形态在这里不会发生。记录检索是**打开之后**才发起的，
 * 回包只会往列表尾部追加一组，不影响面板本身何时可见。
 */

/** 记录检索的 debounce（毫秒）：敲字期间不打请求，停手 180ms 才查一次。 */
const RECORD_SEARCH_DEBOUNCE_MS = 180

/** 组件里的命令：纯逻辑层的描述 + 渲染用的图标 + 执行用的闭包。 */
interface Command extends PaletteCommand<NavItem | InfoRecord | undefined> {
  group: PaletteGroup
  icon: React.ReactNode
  run: () => void
}

export default function CommandPalette() {
  const open = useUiShellStore((s) => s.paletteOpen)
  const close = useUiShellStore((s) => s.closePalette)
  const openCreate = useUiShellStore((s) => s.openCreate)
  const openRecordDetail = useUiShellStore((s) => s.openRecordDetail)
  const setScheme = useUiSchemeStore((s) => s.setScheme)
  const navigate = useNavigate()
  const [keyword, setKeyword] = useState('')
  const [active, setActive] = useState(PALETTE_INITIAL_ACTIVE)
  const [records, setRecords] = useState<InfoRecord[]>([])
  const [recordsLoading, setRecordsLoading] = useState(false)
  const [recentIds, setRecentIds] = useState<string[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  /** 请求序号：只有最新一次检索的结果可以写回（防慢请求回包覆盖新关键词的结果）。 */
  const requestSeq = useRef(0)

  // 每次打开都重置：不复用上次的关键词与高亮，避免"上次搜的词还在"
  useEffect(() => {
    if (open) {
      setKeyword('')
      setActive(PALETTE_INITIAL_ACTIVE)
      setRecords([])
      setRecordsLoading(false)
      requestSeq.current += 1 // 作废上一次的未完成请求
      setRecentIds(readRecentIds(typeof window === 'undefined' ? null : window.localStorage))
      /**
       * 焦点必须**立即**给输入框，然后 60ms 再确认一次。
       *
       * 只有延后那一次会留一个「盲窗」：面板已在第 1 帧出现，但焦点还在 body，
       * 这时按 `↓` 落在 body 上、面板收不到 —— 实测（`qa/p1-12-palette-probe.cjs`）
       * 开面板后 20ms 内按 `↓` 会静默丢键。立即 focus 覆盖这个窗口，
       * 延后那次只是兜底（Fade 动画结束时若被 MUI 的焦点管理改走，这里拉回来）。
       */
      inputRef.current?.focus()
      const t = window.setTimeout(() => inputRef.current?.focus(), 60)
      return () => window.clearTimeout(t)
    }
    return undefined
  }, [open])

  /** 记录 provider：够长才查、debounce、带序号防覆盖。 */
  useEffect(() => {
    if (!open) return undefined
    const kw = keyword.trim()
    if (!shouldSearchRecords(kw)) {
      requestSeq.current += 1 // 关键词太短：作废在途请求，避免结果回填到空关键词上
      setRecords([])
      setRecordsLoading(false)
      return undefined
    }
    const seq = ++requestSeq.current
    setRecordsLoading(true)
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const rows = await recordService.search(kw)
          if (seq === requestSeq.current) setRecords(rows)
        } catch {
          // 检索失败不该让面板变红：保持本地命令可用，只是没有记录分组
          if (seq === requestSeq.current) setRecords([])
        } finally {
          if (seq === requestSeq.current) setRecordsLoading(false)
        }
      })()
    }, RECORD_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [open, keyword])

  const commands = useMemo<Command[]>(() => {
    const navCommands = buildNavCommands(flatNavItems()).map<Command>((cmd) => ({
      ...cmd,
      icon: cmd.source?.icon,
      run: () => {
        if (cmd.path) navigate(cmd.path)
      },
    }))
    const actionCommands: Command[] = [
      {
        id: 'act:create',
        label: '快速记录',
        hint: '新建想法 / 资料 / 待办',
        group: '动作',
        icon: <AddIcon fontSize="small" />,
        run: openCreate,
      },
      ...UI_SCHEME_ORDER.map<Command>((id) => ({
        id: `act:scheme:${id}`,
        label: `切换到「${getUiSchemeName(id)}」`,
        hint: getUiSchemeMeta(id).tagline,
        group: '界面方案',
        icon: <PaletteOutlinedIcon fontSize="small" />,
        run: () => setScheme(id),
      })),
    ]
    // 记录：命中判定在云端，这里只负责「长什么样 + 打开它」
    const recordCommands = buildRecordCommands(records).map<Command>((cmd) => ({
      ...cmd,
      icon: <DescriptionOutlinedIcon fontSize="small" />,
      run: () => {
        if (cmd.source) openRecordDetail(cmd.source)
      },
    }))
    return [...actionCommands, ...navCommands, ...recordCommands]
  }, [navigate, openCreate, setScheme, records, openRecordDetail])

  const results = useMemo(
    () => applyRecentOrder(filterCommands(commands, keyword), recentIds),
    [commands, keyword, recentIds],
  )

  /** 跑一条命令：先关面板，再记「最近使用」（关面板不能等写存储）。 */
  const runCommand = (cmd: Command) => {
    close()
    setRecentIds((prev) =>
      rememberRecentId(
        typeof window === 'undefined' ? null : window.localStorage,
        cmd.id,
        prev,
      ),
    )
    cmd.run()
  }

  const runActive = () => {
    if (active < 0 || active >= results.length) return
    runCommand(results[active])
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const action = resolvePaletteKey(e.key)
    if (action.type === 'none') return
    e.preventDefault()
    if (action.type === 'next') setActive((i) => moveActive(i, results.length, 1))
    else if (action.type === 'prev') setActive((i) => moveActive(i, results.length, -1))
    else if (action.type === 'run') runActive()
    else close()
  }

  const groups = useMemo(() => groupCommands(results), [results])

  /** 输入框与高亮项的无障碍关联（读屏需要知道「当前选的是哪一条」）。 */
  const optionId = (index: number) => `palette-option-${index}`

  return (
    <Dialog
      open={open}
      onClose={close}
      fullWidth
      maxWidth="sm"
      PaperProps={{
        sx: {
          borderRadius: 'var(--r-pop)',
          mt: 10,
          alignSelf: 'flex-start',
          overflow: 'hidden',
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, px: 2, py: 1.5 }}>
        <SearchIcon fontSize="small" sx={{ color: 'text.disabled' }} />
        <InputBase
          inputRef={inputRef}
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value)
            setActive(PALETTE_INITIAL_ACTIVE)
          }}
          onKeyDown={handleKeyDown}
          placeholder="跳转到页面、执行动作，或输入 2 个字搜记录…"
          sx={{ flex: 1, fontSize: 14 }}
          inputProps={{
            'aria-label': '命令面板输入',
            role: 'combobox',
            'aria-expanded': true,
            'aria-controls': 'palette-listbox',
            'aria-activedescendant': active >= 0 ? optionId(active) : undefined,
          }}
        />
        {recordsLoading && <CircularProgress size={14} thickness={5} sx={{ flex: 'none' }} />}
        <Chip size="small" label="Esc" sx={{ height: 20, fontSize: 10.5 }} />
      </Box>
      <Divider />

      <Box
        id="palette-listbox"
        role="listbox"
        aria-label="命令列表"
        sx={{ maxHeight: 400, overflowY: 'auto', py: 1 }}
      >
        {results.length === 0 ? (
          <Typography sx={{ px: 2, py: 3, fontSize: 13, color: 'text.secondary', textAlign: 'center' }}>
            没有匹配的命令。试试「待办」「快速记录」「静默化」，或输入 2 个字以上搜记录。
          </Typography>
        ) : (
          groups.map((group) => (
            <Box key={group.name} sx={{ mb: 0.5 }} role="group" aria-label={group.name}>
              <Typography
                sx={{
                  px: 2,
                  py: 0.5,
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: '0.08em',
                  color: 'text.disabled',
                }}
              >
                {group.name}
              </Typography>
              {group.items.map(({ cmd, index }) => (
                <Box
                  key={cmd.id}
                  id={optionId(index)}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => runCommand(cmd)}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    px: 2,
                    py: 0.75,
                    cursor: 'pointer',
                    bgcolor: index === active ? 'rgba(91,84,217,0.08)' : 'transparent',
                    color: index === active ? 'primary.main' : 'text.primary',
                  }}
                >
                  <Box sx={{ width: 20, display: 'flex', justifyContent: 'center', flex: 'none' }}>
                    {cmd.icon}
                  </Box>
                  <Typography sx={{ fontSize: 13, flex: 'none' }}>{cmd.label}</Typography>
                  {cmd.hint && (
                    <Typography
                      sx={{ fontSize: 11.5, color: 'text.secondary', ml: 'auto', minWidth: 0 }}
                      noWrap
                    >
                      {cmd.hint}
                    </Typography>
                  )}
                  {index === active && (
                    <KeyboardReturnIcon sx={{ fontSize: 14, ml: cmd.hint ? 0.5 : 'auto', flex: 'none' }} />
                  )}
                </Box>
              ))}
            </Box>
          ))
        )}
      </Box>
    </Dialog>
  )
}
