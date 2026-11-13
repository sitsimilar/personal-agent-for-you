import { useEffect, useState } from 'react'
import { Box, Button, Card, CardContent, Chip, Divider, Stack, Typography } from '@mui/material'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import RadioButtonUncheckedIcon from '@mui/icons-material/RadioButtonUnchecked'
import RestartAltIcon from '@mui/icons-material/RestartAlt'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import { pushNotice } from '@/store/noticeStore'
import {
  DEFAULT_UI_SCHEME,
  UI_SCHEME_ORDER,
  getUiSchemeMeta,
  getUiSchemeName,
  summarizeUiSchemeChange,
  type UiScheme,
} from '@/lib/ui-scheme'

/**
 * 设置页「界面方案」卡片 —— 方案选择的**主入口**（顶栏调色板图标是快捷入口）。
 *
 * ## 交互约定（三方案共用，避免"每个方案一套行为"）
 * 1. **点选即生效，不弹确认框**：切换是纯呈现变更、可随时撤销，加确认框只会让用户多点一次；
 * 2. **立即给撤销**：切换后底部提示保留 6 秒「撤销」，比"先问一遍"更省事也更安全；
 * 3. **说清会变什么**：未选中项直接写"切换后：xxx 会变"，选中项展开四条改动要点；
 * 4. **不隐藏代价**：跨维度切换（会挪按钮）时提示会点名"按钮位置变了"，而不是含糊地说"界面更新"。
 *
 * ## 默认值
 * 出厂默认是「静默化」（`DEFAULT_UI_SCHEME`）：不动布局、不动交互、不动入口位置。
 * 「恢复默认方案」会把它写回本机与账号，按钮旁的说明明确了这一点，防止误以为只影响本机。
 */
export default function UiSchemeCard() {
  const scheme = useUiSchemeStore((s) => s.scheme)
  const source = useUiSchemeStore((s) => s.source)
  const cloudSynced = useUiSchemeStore((s) => s.cloudSynced)
  const setScheme = useUiSchemeStore((s) => s.setScheme)
  const resetToDefault = useUiSchemeStore((s) => s.resetToDefault)

  // hash 直达：从顶栏「查看详细差异」跳过来时滚到本卡片
  useEffect(() => {
    const scroll = () => {
      if (window.location.hash !== '#ui-scheme') return
      document.getElementById('ui-scheme')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
    scroll()
    window.addEventListener('hashchange', scroll)
    return () => window.removeEventListener('hashchange', scroll)
  }, [])

  const [justChanged, setJustChanged] = useState<UiScheme | null>(null)

  const pick = (next: UiScheme) => {
    if (next === scheme) return
    const { previous } = setScheme(next)
    const summary = summarizeUiSchemeChange(previous, next)
    setJustChanged(next)
    pushNotice(`已切换到「${getUiSchemeName(next)}」· ${summary.notes[0]}`, 'info', {
      label: '撤销',
      onAction: () => {
        useUiSchemeStore.getState().setScheme(previous)
        setJustChanged(null)
      },
    })
  }

  const handleReset = () => {
    if (scheme === DEFAULT_UI_SCHEME) return
    const { previous } = resetToDefault()
    pushNotice(`已恢复默认方案「${getUiSchemeName(DEFAULT_UI_SCHEME)}」`, 'info', {
      label: '撤销',
      onAction: () => {
        useUiSchemeStore.getState().setScheme(previous)
      },
    })
  }

  const syncLabel =
    source === 'cloud'
      ? '已与账号同步（换设备也会沿用）'
      : cloudSynced
        ? '已保存到账号'
        : '仅本机生效（未登录或云端暂不可用）'

  return (
    <Card variant="outlined" id="ui-scheme" sx={{ mb: 2 }}>
      <CardContent>
        <Typography variant="subtitle2" gutterBottom>
          界面方案
        </Typography>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5 }}>
          三选一，点选即时生效。只改变呈现方式与操作反馈，<b>不改动任何数据</b>，随时可以换回来。
        </Typography>

        <Stack spacing={1.25}>
          {UI_SCHEME_ORDER.map((id) => {
            const meta = getUiSchemeMeta(id)
            const active = id === scheme
            return (
              <Box
                key={id}
                role="radio"
                aria-checked={active}
                tabIndex={0}
                onClick={() => pick(id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    pick(id)
                  }
                }}
                sx={{
                  border: '1px solid',
                  borderColor: active ? 'primary.main' : 'divider',
                  bgcolor: active ? 'rgba(91,84,217,0.03)' : 'transparent',
                  borderRadius: 2,
                  p: 1.5,
                  cursor: 'pointer',
                  transition: 'border-color 140ms ease, background-color 140ms ease',
                  '&:hover': { borderColor: active ? 'primary.main' : 'text.disabled' },
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
                }}
              >
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  {active ? (
                    <CheckCircleIcon sx={{ fontSize: 18, color: 'primary.main' }} />
                  ) : (
                    <RadioButtonUncheckedIcon sx={{ fontSize: 18, color: 'text.disabled' }} />
                  )}
                  <Typography sx={{ fontSize: 14, fontWeight: 600 }}>{meta.name}</Typography>
                  <Chip size="small" label={`影响：${meta.impact}`} sx={{ height: 19, fontSize: 10.5 }} />
                  <Chip
                    size="small"
                    label={`风险 ${meta.risk}`}
                    color={meta.risk === '低' ? 'success' : 'warning'}
                    variant="outlined"
                    sx={{ height: 19, fontSize: 10.5 }}
                  />
                  {meta.recommended && (
                    <Chip size="small" label="出厂默认" color="primary" variant="outlined" sx={{ height: 19, fontSize: 10.5 }} />
                  )}
                  {active && justChanged === id && (
                    <Chip size="small" label="刚刚切换" color="primary" sx={{ height: 19, fontSize: 10.5 }} />
                  )}
                  <Typography sx={{ fontSize: 11.5, color: 'text.secondary', ml: 'auto' }}>
                    {active ? '当前使用中' : `切换后：${meta.noticeable}`}
                  </Typography>
                </Box>

                <Typography sx={{ fontSize: 12.5, color: 'text.secondary', mt: 0.75 }}>
                  {meta.tagline}
                </Typography>

                {active && (
                  <Box
                    sx={{
                      display: 'grid',
                      gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' },
                      gap: 0.75,
                      mt: 1.25,
                    }}
                  >
                    {meta.changes.map((c) => (
                      <Box key={c.title} sx={{ display: 'flex', gap: 0.75, minWidth: 0 }}>
                        <Box
                          sx={{
                            width: 4,
                            height: 4,
                            borderRadius: '50%',
                            bgcolor: 'primary.main',
                            mt: '7px',
                            flex: 'none',
                          }}
                        />
                        <Typography sx={{ fontSize: 11.5, color: 'text.secondary', lineHeight: 1.6 }}>
                          <b style={{ color: 'var(--ink2)' }}>{c.title}</b>
                          <span>：{c.detail}</span>
                        </Typography>
                      </Box>
                    ))}
                  </Box>
                )}
              </Box>
            )
          })}
        </Stack>

        <Divider sx={{ my: 2 }} />

        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <Button
            size="small"
            variant="outlined"
            startIcon={<RestartAltIcon />}
            onClick={handleReset}
            disabled={scheme === DEFAULT_UI_SCHEME}
          >
            恢复默认方案
          </Button>
          <Typography sx={{ fontSize: 11.5, color: 'text.secondary' }}>
            出厂默认「{getUiSchemeName(DEFAULT_UI_SCHEME)}」，恢复后会同时写回本机与账号 · 当前：{syncLabel}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  )
}
