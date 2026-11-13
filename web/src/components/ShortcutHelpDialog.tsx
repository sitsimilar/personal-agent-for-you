import {
  Box,
  Chip,
  Dialog,
  DialogContent,
  DialogTitle,
  Divider,
  IconButton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import { SHORTCUTS, type ShortcutGroup } from '@/lib/shortcuts'

/**
 * 快捷键速查浮层（`?` 打开）。
 *
 * 内容**全部来自注册表**（`lib/shortcuts.ts`），一张表都没手写：
 * 加一条快捷键只需要改注册表 + 跑一次 `npm run shortcuts:doc`，
 * 这个浮层与 `docs/SHORTCUTS.md` 会同时更新，不会出现「帮助里写着、按了没有」。
 *
 * 分组顺序也照抄注册表的 `GROUP_ORDER` 语义（记录 → 导航 → 通用），
 * 与文档一致，用户在两个地方看到的结构相同。
 */

const GROUP_ORDER: readonly ShortcutGroup[] = ['记录', '导航', '通用']

interface ShortcutHelpDialogProps {
  open: boolean
  onClose: () => void
}

export default function ShortcutHelpDialog({ open, onClose }: ShortcutHelpDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="shortcut-help-title">
      <DialogTitle id="shortcut-help-title" sx={{ display: 'flex', alignItems: 'center', gap: 1, pr: 5 }}>
        快捷键速查
        <Chip label={`${SHORTCUTS.length} 条`} size="small" sx={{ height: 20, fontSize: 11 }} />
      </DialogTitle>
      <IconButton
        aria-label="关闭快捷键速查"
        onClick={onClose}
        sx={{ position: 'absolute', right: 8, top: 8, minWidth: 44, minHeight: 44 }}
      >
        <CloseIcon fontSize="small" />
      </IconButton>
      <DialogContent sx={{ pt: 0 }}>
        {GROUP_ORDER.map((group) => {
          const rows = SHORTCUTS.filter((s) => s.group === group)
          if (rows.length === 0) return null
          return (
            <Box key={group} sx={{ mb: 1.5 }}>
              <Typography variant="overline" color="text.disabled" sx={{ fontSize: 10.5, fontWeight: 600 }}>
                {group}
              </Typography>
              <Table size="small" aria-label={`${group}快捷键`}>
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 150, py: 0.5 }}>按键</TableCell>
                    <TableCell sx={{ py: 0.5 }}>动作</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((spec) => (
                    <TableRow key={spec.id}>
                      <TableCell sx={{ py: 0.5 }}>
                        <Typography
                          component="kbd"
                          variant="caption"
                          sx={{
                            fontFamily: 'inherit',
                            fontSize: 11.5,
                            px: 0.75,
                            py: 0.25,
                            borderRadius: 1,
                            bgcolor: 'action.hover',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {spec.keys}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ py: 0.5, fontSize: 13 }}>{spec.label}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
          )
        })}
        <Divider sx={{ my: 1 }} />
        <Typography variant="caption" color="text.secondary" component="p" sx={{ m: 0 }}>
          输入框内只保留「命令面板」一项；任一对话框打开时全局快捷键整体挂起。
        </Typography>
      </DialogContent>
    </Dialog>
  )
}
