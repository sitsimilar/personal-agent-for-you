/**
 * 界面方案状态（Zustand 单例）。
 *
 * ## 职责边界
 * - 纯逻辑在 `lib/ui-scheme.ts`；本文件只负责**状态、持久化、DOM 副作用**。
 * - DOM 副作用只有一件：把当前方案写到 `<html data-scheme="...">`，
 *   所有令牌差异都由 `index.css` 的 `[data-scheme]` 选择器承担（组件里不写方案判断）。
 *
 * ## 持久化策略（双写 + 三级降级）
 * 1. **本地优先**：`localStorage` 同步读写，保证刷新不闪、离线可用、断网可用；
 * 2. **云端补位**：登录后尝试读 `settings.ui_scheme`，读到且本地未被本次会话修改过则以云端为准
 *    （跨设备一致）；写云端失败**不报错**，只在设置页显示「仅本机生效」；
 * 3. **列缺失兜底**：`settings` 表若尚未执行 `ui_scheme` 迁移，云读写都会失败，
 *    这时整个偏好退化为设备级——功能不受影响，这是刻意选的降级方向（偏好项不值得阻塞用户）。
 *
 * 不变量：**任何情况下 `state.scheme` 都是 `normalizeUiScheme` 的结果**，UI 不需要再判空。
 *
 * ## 背景氛围（v2.14 追加）
 * 背景氛围与界面方案正交，但刻意放在**同一个 store**里：
 * 两者都是「呈现偏好」，共用同一条首帧落地链路（`hydrateLocal` 在 `main.tsx` 渲染前调用）。
 * 区别是背景**只写 localStorage**，不写云端、不碰 `settings` 表 —— 不给数据库加列。
 */

import { create } from 'zustand'
import {
  DEFAULT_UI_SCHEME,
  UI_SCHEME_STORAGE_KEY,
  UI_SCHEME_STORAGE_VERSION,
  normalizeUiScheme,
  resolveUiSchemeFeatures,
  summarizeUiSchemeChange,
  type UiScheme,
  type UiSchemeChangeSummary,
  type UiSchemeFeatures,
} from '@/lib/ui-scheme'
import {
  BACKDROP_STORAGE_KEY,
  BACKDROP_STORAGE_VERSION,
  BACKDROP_DEFAULTS,
  DEFAULT_BACKDROP,
  clampBackdropParam,
  normalizeBackdrop,
  normalizeBackdropPreference,
  type BackdropParamKey,
  type BackdropParams,
  type BackdropPreference,
  type BackdropTheme,
} from '@/lib/backdrop'
import { applyBackdropStyle } from '@/lib/backdrop-style'
import {
  DEFAULT_CONTRAST,
  clampContrast,
  normalizeColorScheme,
  readColorPreference,
  writeColorPreference,
  resolveColorMode,
  type ColorScheme,
} from '@/lib/color-scheme'
import { profileService } from '@/services/profileService'
import type { SettingsRow } from '@/lib/database.types'

/** 方案来源：决定设置页显示「已同步」还是「仅本机」。 */
export type UiSchemeSource = 'default' | 'local' | 'cloud'

interface UiSchemeState {
  /** 当前生效方案（恒为合法值）。 */
  scheme: UiScheme
  /** 来源。 */
  source: UiSchemeSource
  /** 本次会话是否改过（改过则云端加载不再覆盖，避免抢用户的操作）。 */
  dirty: boolean
  /** 云端是否同步成功（列缺失/离线时为 false）。 */
  cloudSynced: boolean
  /** 是否已完成首次本地读取（用于避免首帧误判）。 */
  hydrated: boolean
  /** 上一次方案（撤销用；null 表示没得撤）。 */
  previous: UiScheme | null
  /** settings 行 id（云写入用，由 `hydrateFromCloud` 带出）。 */
  settingsId: number | null
  /** 当前背景氛围（恒为合法值；只存本机）。 */
  backdrop: BackdropTheme
  /** 每套主题各自的参数（用户改过谁就记住谁，切主题不互相污染）。 */
  backdropParams: Record<BackdropTheme, BackdropParams>
  /** 深浅色 override（`system`/`light`/`dark`）。 */
  colorScheme: ColorScheme
  /** 对比度 0.6–1.5（默认 1.0）。 */
  contrast: number
}

interface UiSchemeActions {
  /** 从 localStorage 读取并应用（启动时调一次，幂等）。 */
  hydrateLocal: () => void
  /** 用云端 settings 行覆盖（仅当本次会话未改过）。 */
  hydrateFromCloud: (row: SettingsRow | null) => void
  /**
   * 只登记 settings 行 id，不动方案值。
   *
   * 为什么需要：设置页保存时可能**新建**一行 settings，此时 store 里记的 id 还是 null，
   * 若不更新，下一次切换方案会再 insert 一条 → 撞 `owner_id` 唯一约束 23505。
   */
  setSettingsId: (id: number | null) => void
  /**
   * 切换方案：立即生效（本地 + DOM），云端异步补写。
   *
   * @param next 目标方案（非法值会回落默认）
   * @returns 变化摘要与被替换掉的旧方案（供撤销）
   */
  setScheme: (next: unknown) => { previous: UiScheme; summary: UiSchemeChangeSummary }
  /** 撤销到上一个方案（没有上一个时返回 false）。 */
  undo: () => boolean
  /** 恢复出厂默认（等价于 `setScheme(DEFAULT_UI_SCHEME)`）。 */
  resetToDefault: () => { previous: UiScheme; summary: UiSchemeChangeSummary }
  /** 当前方案的能力位（选择器函数，避免组件各自 import 特性表）。 */
  features: () => UiSchemeFeatures
  /**
   * 切换背景氛围：立即写 DOM + localStorage，不写云端。
   *
   * @returns 被替换掉的旧值（供撤销提示用）
   */
  setBackdrop: (next: unknown) => BackdropTheme
  /** 改一个背景参数（按当前主题记录；越界值会被夹到安全区间）。 */
  setBackdropParam: (key: BackdropParamKey, value: number) => void
  /** 把当前主题的参数恢复成推荐值。 */
  resetBackdropParams: () => void
  /** 深浅色切换后重算背景颜色（底色 token 变了，需要重新合成 alpha）。 */
  refreshBackdropPalette: () => void
  /** 切换深浅色 override：`system` / `light` / `dark`。立即写 DOM + localStorage。 */
  setColorScheme: (next: unknown) => ColorScheme
  /** 调对比度（0.6–1.5）；立即生效。 */
  setContrast: (value: number) => void
  /** 深浅色 override + 对比度 → 写 `<html data-theme>` 与 `data-contrast`（DOM 副作用集中在此）。 */
  applyColorDOM: () => void
}

export type UiSchemeStore = UiSchemeState & UiSchemeActions

/** 把方案写到 `<html data-scheme>`（所有令牌选择器的开关）。 */
function applyToDocument(scheme: UiScheme): void {
  if (typeof document === 'undefined') return
  document.documentElement.dataset.scheme = scheme
}

/**
 * 把背景主题与参数一起落地：`data-backdrop` + 一组 CSS 变量。
 *
 * 为什么不复用 `applyBackdropToDocument`：参数要编译成线宽/颜色/时长，
 * 逻辑在 `lib/backdrop-style.ts`，这里只负责调用，保证「状态 → 视觉」单一路径。
 * 对比度 multiplier 从当前 state 读——wrapper 内部拿，调用方不用关心。
 */
function applyBackdrop(theme: BackdropTheme, params: BackdropParams): void {
  applyBackdropStyle(theme, params, useUiSchemeStore.getState().contrast)
}

/** 读本地背景偏好（任何异常都当作“没存过”，参数补默认值）。 */
function readLocalBackdrop(): BackdropPreference {
  try {
    const raw = window.localStorage.getItem(BACKDROP_STORAGE_KEY)
    if (!raw) return normalizeBackdropPreference(DEFAULT_BACKDROP, null)
    if (raw.startsWith('{')) {
      // v2 起带 params；v1 只有 backdrop —— 缺的参数逐项补推荐值
      const parsed = JSON.parse(raw) as { v?: number; backdrop?: unknown; params?: unknown }
      return normalizeBackdropPreference(parsed?.backdrop, parsed?.params)
    }
    return normalizeBackdropPreference(raw, null)
  } catch {
    return normalizeBackdropPreference(DEFAULT_BACKDROP, null)
  }
}

/** 写本地背景偏好（失败静默：隐私模式下 localStorage 会抛）。 */
function writeLocalBackdrop(pref: BackdropPreference): void {
  try {
    window.localStorage.setItem(
      BACKDROP_STORAGE_KEY,
      JSON.stringify({ v: BACKDROP_STORAGE_VERSION, backdrop: pref.theme, params: pref.params }),
    )
  } catch {
    /* 忽略 */
  }
}

/** 读本地存储（任何异常都当作“没存过”）。 */
function readLocal(): UiScheme {
  try {
    const raw = window.localStorage.getItem(UI_SCHEME_STORAGE_KEY)
    if (!raw) return DEFAULT_UI_SCHEME
    // 兼容两种格式：纯字符串（v1 之前）与 JSON `{v, scheme}`
    if (raw.startsWith('{')) {
      const parsed = JSON.parse(raw) as { v?: number; scheme?: unknown }
      return normalizeUiScheme(parsed?.scheme)
    }
    return normalizeUiScheme(raw)
  } catch {
    return DEFAULT_UI_SCHEME
  }
}

/** 写本地存储（失败静默：隐私模式下 localStorage 会抛）。 */
function writeLocal(scheme: UiScheme): boolean {
  try {
    window.localStorage.setItem(
      UI_SCHEME_STORAGE_KEY,
      JSON.stringify({ v: UI_SCHEME_STORAGE_VERSION, scheme }),
    )
    return true
  } catch {
    return false
  }
}

/** 云端补写（失败静默，只更新 `cloudSynced`）。 */
async function pushCloud(scheme: UiScheme, settingsId: number | null): Promise<boolean> {
  try {
    await profileService.save(settingsId, { ui_scheme: scheme })
    return true
  } catch {
    return false
  }
}

export const useUiSchemeStore = create<UiSchemeStore>((set, get) => ({
  scheme: DEFAULT_UI_SCHEME,
  source: 'default',
  dirty: false,
  cloudSynced: false,
  hydrated: false,
  previous: null,
  settingsId: null,
  backdrop: DEFAULT_BACKDROP,
  backdropParams: { ...BACKDROP_DEFAULTS },
  colorScheme: 'system',
  contrast: DEFAULT_CONTRAST,

  hydrateLocal: () => {
    if (get().hydrated) return
    const scheme = readLocal()
    const pref = readLocalBackdrop()
    const color = readColorPreference()
    applyToDocument(scheme)
    // 深浅色先写 DOM（`data-theme`），背景合成依赖它的底色 token
    get().setColorScheme(color.scheme)
    get().setContrast(color.contrast)
    applyBackdrop(pref.theme, pref.params[pref.theme])
    set({
      scheme,
      backdrop: pref.theme,
      backdropParams: pref.params,
      colorScheme: color.scheme,
      contrast: color.contrast,
      source: scheme === DEFAULT_UI_SCHEME ? 'default' : 'local',
      hydrated: true,
      previous: null,
    })
  },

  hydrateFromCloud: (row) => {
    if (!row) {
      set({ settingsId: null, cloudSynced: false })
      return
    }
    const settingsId = row.id ?? null
    // 本次会话用户已经手动改过 → 不覆盖，但仍记下 settingsId 供后续写入
    if (get().dirty) {
      set({ settingsId })
      return
    }
    const cloudScheme = normalizeUiScheme(row.ui_scheme)
    const hasCloudValue = typeof row.ui_scheme === 'string' && row.ui_scheme.trim() !== ''
    if (!hasCloudValue) {
      // 云端没存过：把本机当前值当作初始值回写一次，完成首次对齐（失败不打扰）
      set({ settingsId, cloudSynced: false })
      void pushCloud(get().scheme, settingsId).then((ok) => set({ cloudSynced: ok }))
      applyToDocument(get().scheme)
      return
    }
    const scheme = cloudScheme
    applyToDocument(scheme)
    set({ scheme, source: 'cloud', settingsId, cloudSynced: true })
  },

  setSettingsId: (id) => {
    if (get().settingsId === id) return
    set({ settingsId: id })
  },

  setScheme: (next) => {    const previous = get().scheme
    const scheme = normalizeUiScheme(next)
    const summary = summarizeUiSchemeChange(previous, scheme)

    applyToDocument(scheme)
    writeLocal(scheme)
    set({ scheme, source: 'local', dirty: true, previous, hydrated: true })

    if (scheme !== previous) {
      void pushCloud(scheme, get().settingsId).then((ok) => set({ cloudSynced: ok }))
    }
    return { previous, summary }
  },

  undo: () => {
    const prev = get().previous
    if (!prev) return false
    get().setScheme(prev)
    set({ previous: null })
    return true
  },

  resetToDefault: () => get().setScheme(DEFAULT_UI_SCHEME),

  features: () => resolveUiSchemeFeatures(get().scheme),

  setBackdrop: (next) => {
    const previous = get().backdrop
    const backdrop = normalizeBackdrop(next)
    const params = get().backdropParams
    applyBackdrop(backdrop, params[backdrop])
    writeLocalBackdrop({ theme: backdrop, params })
    set({ backdrop })
    return previous
  },

  setBackdropParam: (key, value) => {
    const theme = get().backdrop
    const params = get().backdropParams
    const current = params[theme]
    const nextValue = clampBackdropParam(key, value, current[key])
    if (nextValue === current[key]) return

    const nextForTheme: BackdropParams = { ...current, [key]: nextValue }
    const nextParams = { ...params, [theme]: nextForTheme }
    applyBackdrop(theme, nextForTheme)
    writeLocalBackdrop({ theme, params: nextParams })
    set({ backdropParams: nextParams })
  },

  resetBackdropParams: () => {
    const theme = get().backdrop
    const nextForTheme: BackdropParams = { ...BACKDROP_DEFAULTS[theme] }
    const nextParams = { ...get().backdropParams, [theme]: nextForTheme }
    applyBackdrop(theme, nextForTheme)
    writeLocalBackdrop({ theme, params: nextParams })
    set({ backdropParams: nextParams })
  },

  refreshBackdropPalette: () => {
    const { backdrop, backdropParams } = get()
    applyBackdrop(backdrop, backdropParams[backdrop])
  },

  /** 深浅色 override + 对比度 → 写 `<html data-theme>` 与 `data-contrast`。 */
  applyColorDOM: () => {
    const root = document.documentElement
    const { colorScheme, contrast } = get()
    // 系统色 = 当前 matchMedia 的结果（`system` 模式才会变）
    let systemDark = false
    try {
      systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false
    } catch {
      systemDark = false
    }
    const effective = resolveColorMode(colorScheme, systemDark)
    root.dataset.theme = effective
    root.style.colorScheme = effective
    // 对比度档位（JS 算好乘数，CSS 里 [data-contrast] 选择器只做色板微调）
    if (contrast >= 1.3) root.dataset.contrast = 'enhance'
    else if (contrast <= 0.8) root.dataset.contrast = 'dimmed'
    else root.removeAttribute('data-contrast')
    // 对比度也影响背景 alpha 预算 —— 直接重新合成
    get().refreshBackdropPalette()
  },

  setColorScheme: (next) => {
    const previous = get().colorScheme
    const scheme = normalizeColorScheme(next)
    if (scheme === previous) return scheme
    set({ colorScheme: scheme })
    get().applyColorDOM()
    writeColorPreference({ scheme, contrast: get().contrast })
    return previous
  },

  setContrast: (value) => {
    const contrast = clampContrast(value)
    if (contrast === get().contrast) return
    set({ contrast })
    get().applyColorDOM()
    writeColorPreference({ scheme: get().colorScheme, contrast })
  },
}))

/** 组件外取能力位（service / 事件回调里用）。 */
export function currentUiFeatures(): UiSchemeFeatures {
  return resolveUiSchemeFeatures(useUiSchemeStore.getState().scheme)
}

/** 组件外切换方案（命令面板 / 快捷键里用）。 */
export function switchUiScheme(next: unknown): { previous: UiScheme; summary: UiSchemeChangeSummary } {
  return useUiSchemeStore.getState().setScheme(next)
}
