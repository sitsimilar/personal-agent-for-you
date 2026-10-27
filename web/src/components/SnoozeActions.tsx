import { useState } from 'react'
import { Box, Button, ButtonGroup, Tooltip, Typography } from '@mui/material'
import SnoozeIcon from '@mui/icons-material/Snooze'
import CheckIcon from '@mui/icons-material/Check'
import type { InfoRecord } from '@shared/types/domain'
import { recordService } from '@/services/recordService'
import { SNOOZE_OPTIONS, reminderService } from '@/services/reminderService'
import { friendlyError } from '@/lib/unwrap'

interface SnoozeActionsProps {
  /** 当前记录（仅 `type='todo'` 且 `todoStatus='pending'` 时由调用方渲染）。 */
  record: InfoRecord
  /** 写库成功后回调（详情页用于刷新列表/详情）。 */
  onChanged?: () => void
}

/** 推迟时长的中文文案。 */
const SNOOZE_LABEL: Record<number, string> = {
  10: '稍后 10 分钟',
  30: '稍后 30 分钟',
  60: '稍后 1 小时',
}

/**
 * 提醒「稍后」操作条（v2.13 R4）。
 *
 * 平台硬约束：Web `new Notification()` 与 Windows `new Notification` 都不支持动作按钮，
 * 所以「点通知 → 打开详情 → 在这里点稍后」是主路径（见 PRD §7 问题 6）。
 * 三个时长都小于候选窗口（12 小时），推迟后仍在 `listReminderCandidates()` 的区间内。
 */
export default function SnoozeActions({ record, onChanged }: SnoozeActionsProps) {
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [failed, setFailed] = useState(false)

  /**
   * 没有 `remind_at` 的待办永远不会进提醒候选窗口（`listReminderCandidates` 按
   * `remind_at` 过滤），点「稍后」是空操作，因此直接禁用而不是让它静默无效。
   */
  const noRemind = !record.remindAt

  const run = async (task: () => Promise<void>, okText: string) => {
    if (busy) return
    setBusy(true)
    setMessage('')
    setFailed(false)
    try {
      await task()
      setMessage(okText)
      onChanged?.()
    } catch (err) {
      setFailed(true)
      setMessage(friendlyError(err))
    } finally {
      setBusy(false)
    }
  }

  const snooze = (minutes: number) => {
    void run(async () => {
      await reminderService.snooze(record.id, minutes)
    }, `已推迟到 ${minutes} 分钟后提醒`)
  }

  const complete = () => {
    void run(async () => {
      await recordService.updateTodoStatus(record.id, 'done')
    }, '已标记完成')
  }

  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <Tooltip title={noRemind ? '该待办没有提醒时间，无法推迟' : ''}>
          {/* span 包一层：disabled 按钮不触发鼠标事件，否则 Tooltip 不显示 */}
          <span>
            <ButtonGroup size="small" variant="outlined" disabled={busy || noRemind}>
              {SNOOZE_OPTIONS.map((minutes) => (
                <Button key={minutes} startIcon={<SnoozeIcon />} onClick={() => snooze(minutes)}>
                  {SNOOZE_LABEL[minutes] ?? `稍后 ${minutes} 分钟`}
                </Button>
              ))}
            </ButtonGroup>
          </span>
        </Tooltip>
        <Button size="small" variant="contained" startIcon={<CheckIcon />} disabled={busy} onClick={complete}>
          标记完成
        </Button>
      </Box>
      {message && (
        <Typography variant="caption" color={failed ? 'error' : 'text.secondary'} display="block" sx={{ mt: 0.5 }}>
          {message}
        </Typography>
      )}
    </Box>
  )
}
