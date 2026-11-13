import { clipboard, dialog } from 'electron'
import { request } from 'node:https'
import { WEB_APP_URL } from '../shared/ipc-contract'
import { appendQuery, composeBaseUrl, extractShareCode } from '../shared/app-url'
import { store } from './store'

/**
 * 主进程侧的「线上地址是否真的能打开」判定与自愈。
 *
 * 为什么需要：发布位开启分享码后，缺码时整站返回 **403「链接不完整」**，
 * 而分享码可能每次发布都换。码被编译进安装包 → 换码后老安装包会白屏。
 * 所以加载前先探一次，403 就引导用户粘贴新分享链接（读剪贴板，无需输入框），
 * 落进 preferences.json 后重试；实在修不好就走本地兜底页（至少能看能点「重试」）。
 *
 * 探测失败（超时 / 断网）**不算不可用**：那种情况交给 Electron 自己加载，
 * 否则离线启动会被误判成「链接失效」。
 */

/** 线上地址探测超时（ms）。宁可短，避免窗口迟迟不出现。 */
const PROBE_TIMEOUT_MS = 6000

/** 最多让用户重试几次粘贴分享链接。 */
const REPAIR_ATTEMPTS = 2

/**
 * 最近一次可达性结论（`null` = 尚未判定）。
 *
 * 悬浮窗靠快捷键反复唤起，**不能每次都探一次**（几百毫秒延迟会明显变卡），
 * 所以复用主窗口启动时得出的结论；重新判定走「重试」按钮。
 */
let lastReachable: boolean | null = null

/** 读最近一次可达性结论（供悬浮窗这类hot path 直接复判）。 */
export function appReachableState(): boolean | null {
  return lastReachable
}

/** 当前生效基址：环境变量地址 + 本地偏好里的分享码覆盖（空码则原样用）。 */
export function resolveBaseUrl(): string {
  return composeBaseUrl(WEB_APP_URL, store.get('webShareCode'))
}

/** 真正要加载的地址（基址 + 窗口专属参数）。空串表示未配置，调用方走兜底页。 */
export function appUrl(extra?: Record<string, string>): string {
  return appendQuery(resolveBaseUrl(), extra)
}

/** GET 一次只取状态码；超时/网络错误返回 null（不抛错）。 */
export function probeHttpStatus(target: string, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false
    const done = (value: number | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    try {
      const req = request(target, { method: 'GET', headers: { 'user-agent': 'personal-agent-desktop' } }, (res) => {
        res.resume() // 只要状态码，丢弃响应体（避免占用连接）
        done(typeof res.statusCode === 'number' ? res.statusCode : null)
      })
      req.setTimeout(timeoutMs, () => {
        req.destroy()
        done(null)
      })
      req.on('error', () => done(null))
      req.end()
    } catch {
      done(null)
    }
  })
}

/** 读剪贴板里的分享码；剪贴板不可用或没有码时返回空串（不抛错）。 */
export function readShareCodeFromClipboard(): string {
  try {
    return extractShareCode(clipboard.readText())
  } catch {
    return ''
  }
}

/** 403/401 时引导用户粘贴新分享链接；成功修好返回 true。 */
async function repairShareCode(): Promise<boolean> {
  for (let attempt = 0; attempt < REPAIR_ATTEMPTS; attempt += 1) {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      title: '应用链接已失效',
      message: '线上应用的分享码可能已更新，安装包里带的是旧码。',
      detail:
        '请先在 WorkBuddy 打开「个人信息管家」应用并复制它的分享链接（形如 https://...?sharecode=XXXXXXXX），' +
        '然后点下面的按钮，本机会自动读取剪贴板并重试。',
      buttons: ['从剪贴板读取链接', '稍后再说'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (response !== 0) return false

    const code = readShareCodeFromClipboard()
    if (!code) {
      await dialog.showMessageBox({
        type: 'info',
        title: '剪贴板里没有分享码',
        message: '没找到形如 ?sharecode=XXXXXXXX 的内容，请重新复制分享链接后再试。',
        buttons: ['知道了'],
        noLink: true,
      })
      continue
    }

    store.set('webShareCode', code)
    const status = await probeHttpStatus(appUrl())
    // null = 探测本身失败，交给后续真实加载去判定，不在这里判死
    if (status === null || (status >= 200 && status < 400)) return true
  }
  return false
}

/**
 * 加载前确认线上地址可用。
 *
 * 返回 `ok=false` 时调用方**必须**走本地兜底页——用坏地址硬加载就是白屏。
 */
export async function ensureAppReachable(): Promise<{ ok: boolean; url: string }> {
  const initial = appUrl()
  if (!initial) {
    lastReachable = false
    return { ok: false, url: '' }
  }

  const status = await probeHttpStatus(initial)
  if (status === null || (status >= 200 && status < 400)) {
    lastReachable = true
    return { ok: true, url: initial }
  }

  const repaired = await repairShareCode()
  lastReachable = repaired
  return repaired ? { ok: true, url: appUrl() } : { ok: false, url: initial }
}
