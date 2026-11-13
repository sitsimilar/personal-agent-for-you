import { useState } from 'react'
import { Box, Chip, IconButton, InputAdornment, TextField, Tooltip } from '@mui/material'
import SearchIcon from '@mui/icons-material/Search'
import { useUiShellStore } from '@/store/uiShellStore'

interface SearchBarProps {
  onSearch?: (keyword: string) => void
  placeholder?: string
  /**
   * 是否在输入框尾部显示「Ctrl K」提示（仅流畅方案为 true）。
   *
   * 为什么要跟着方案走：提示是个承诺。命令面板只在流畅方案存在，
   * 在其他方案里显示这个角标就是**骗点击**——用户按了没反应会怀疑软件坏了。
   * 宁可少一个提示，也不要一个假的。
   */
  showPaletteHint?: boolean
  /**
   * 输入框的 DOM id。
   *
   * `/` 快捷键要能**把焦点送进来**，而组件本身拿不到「谁在监听键盘」，
   * 只能让壳层（`Layout`）传一个约定的 id 过来源。同页多实例时不要传同一个 id。
   */
  focusId?: string
}

/** 关键词检索输入框。 */
export default function SearchBar({
  onSearch,
  placeholder,
  showPaletteHint = false,
  focusId,
}: SearchBarProps) {
  const [value, setValue] = useState('')
  const openPalette = useUiShellStore((s) => s.openPalette)

  const submit = () => {
    const kw = value.trim()
    if (!kw) return
    onSearch?.(kw)
  }

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, width: '100%' }}>
      <TextField
        id={focusId}
        size="small"
        fullWidth
        variant="outlined"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
        placeholder={placeholder ?? '输入关键词检索想法、资料、待办'}
        inputProps={{ 'aria-label': '检索关键词' }}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end">
              {showPaletteHint && (
                <Tooltip title="打开命令面板（Ctrl / ⌘ + K）">
                  <Chip
                    label="Ctrl K"
                    size="small"
                    onClick={openPalette}
                    sx={{
                      height: 20,
                      mr: 0.5,
                      fontSize: 10.5,
                      fontFamily: 'inherit',
                      cursor: 'pointer',
                      bgcolor: 'action.hover',
                    }}
                  />
                </Tooltip>
              )}
              <IconButton
                onClick={submit}
                edge="end"
                size="small"
                aria-label="检索"
                // 44×44：触摸目标下限（§八 第 5 项），勿退回 size="small" 的 30×30
                sx={{ minWidth: 44, minHeight: 44 }}
              >
                <SearchIcon fontSize="small" />
              </IconButton>
            </InputAdornment>
          ),
        }}
      />
    </Box>
  )
}
