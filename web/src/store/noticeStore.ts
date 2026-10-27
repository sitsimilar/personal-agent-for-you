import { create } from 'zustand'

/** 应用内提示级别（与 MUI Alert severity 对齐）。 */
export type NoticeSeverity = 'info' | 'success' | 'warning' | 'error'

/** 一条应用内提示。 */
export interface NoticeItem {
  id: number
  message: string
  severity: NoticeSeverity
  /** v2.13 R4：可选的动作按钮文案（如「稍后 10 分钟」），无则不渲染按钮。 */
  actionLabel?: string
  /** 动作回调（点击后自动关闭该提示）。 */
  onAction?: () => void
}

/** 提示的可选动作（v2.13 R4 起用于应用内通道的「稍后 10 分钟」）。 */
export interface NoticeAction {
  label: string
  onAction: () => void
}

interface NoticeState {
  notices: NoticeItem[]
  push: (message: string, severity?: NoticeSeverity, action?: NoticeAction) => number
  dismiss: (id: number) => void
  clear: () => void
}

/** 自动消失时长（ms）。 */
const AUTO_DISMISS_MS = 6_000

let seq = 0

/**
 * 应用内提示队列（Zustand 单例）。
 *
 * 用途：① 通知通道降级（桌面失败 / Web 权限被拒）时的可见提示；
 * ② 循环任务状态、记录已被删除等轻量操作反馈复用同一队列；
 * ③ v2.13 R4：通知降级提示条带「稍后 10 分钟」动作（一步可达）。
 */
export const useNoticeStore = create<NoticeState>((set, get) => ({
  notices: [],

  push: (message, severity = 'info', action) => {
    const text = (message ?? '').trim()
    if (!text) return -1
    const id = ++seq
    const item: NoticeItem = { id, message: text, severity }
    if (action && action.label) {
      item.actionLabel = action.label
      item.onAction = action.onAction
    }
    set({ notices: [...get().notices, item] })
    if (typeof window !== 'undefined') {
      window.setTimeout(() => {
        // 超时后若仍存在则移除（用户已手动关闭时是无害的空操作）
        if (get().notices.some((n) => n.id === id)) {
          set({ notices: get().notices.filter((n) => n.id !== id) })
        }
      }, AUTO_DISMISS_MS)
    }
    return id
  },

  dismiss: (id) => set({ notices: get().notices.filter((n) => n.id !== id) }),
  clear: () => set({ notices: [] }),
}))

/** 组件外推送提示（service 层使用）。 */
export function pushNotice(message: string, severity: NoticeSeverity = 'info', action?: NoticeAction): number {
  return useNoticeStore.getState().push(message, severity, action)
}
