/**
 * 壳层 UI 状态（跨组件开关）。
 *
 * 为什么单独抽一个 store：
 * 「快速记录」按钮在**分区方案**下从顶栏移到了页眉带（`PageHeader`），在**流畅方案**下
 * 又会被命令面板再次触发。三处都要能打开同一个对话框，若继续用 Layout 的局部 state，
 * 就得靠 ref / context 层层下传。抽成单例后：
 * - `Layout` 只管渲染 `<RecordCreateDialog>`，开关由 store 驱动；
 * - `PageHeader` / `CommandPalette` 直接调 `openCreate()`；
 * - 关闭与「创建成功」后的刷新回调统一走 `onCreated` 订阅（组件各自按需监听）。
 *
 * 注意：这里只放**壳层**状态。记录数据仍在 `recordStore`，不要混。
 */

import { create } from 'zustand'
import type { InfoRecord } from '@shared/types/domain'

interface UiShellState {
  /** 「快速记录」对话框是否打开。 */
  createOpen: boolean
  /** 命令面板是否打开（仅流畅方案会渲染它，但状态放这里便于快捷键统一处理）。 */
  paletteOpen: boolean
  /**
   * 全局记录详情（P1-12 下半）。
   *
   * 记录详情原本是**页面级**状态（首页 / 待办 / 日历 / 回顾各挂一份 `<RecordDetail>`），
   * 命令面板要在「任意页面」打开任意一条记录，就得有个不依赖当前页面的宿主。
   * 由 `Layout` 渲染唯一一份，各页面的本地详情保持不动（两处互不干扰：同时最多一处非空）。
   */
  detailRecord: InfoRecord | null
  openCreate: () => void
  closeCreate: () => void
  openPalette: () => void
  closePalette: () => void
  togglePalette: () => void
  openRecordDetail: (record: InfoRecord | null) => void
  closeRecordDetail: () => void
}

export const useUiShellStore = create<UiShellState>((set, get) => ({
  createOpen: false,
  paletteOpen: false,
  detailRecord: null,
  openCreate: () => set({ createOpen: true }),
  closeCreate: () => set({ createOpen: false }),
  openPalette: () => set({ paletteOpen: true }),
  closePalette: () => set({ paletteOpen: false }),
  togglePalette: () => set({ paletteOpen: !get().paletteOpen }),
  openRecordDetail: (record) => set({ detailRecord: record ?? null }),
  closeRecordDetail: () => set({ detailRecord: null }),
}))

/** 组件外打开快速记录（命令面板 / 快捷键）。 */
export function openCreateDialog(): void {
  useUiShellStore.getState().openCreate()
}
