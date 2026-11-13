/**
 * 线上地址拼装（**纯函数**，不依赖 electron / Vite，可被 Node 直接单测）。
 *
 * 背景：发布位开启分享码后，访问必须先带 `?sharecode=XXXX`，平台据此下发 30 天
 * 会话 cookie；缺码时整站（含 `/assets/*`）返回 403「链接不完整」。分享码**可能随
 * 发布更换**，而它被编译进安装包，所以运行期必须允许用本地偏好里的新码覆盖旧码。
 *
 * 这里只放「字符串怎么拼」，不放「怎么问用户要码」——后者在 `main/app-url.ts`。
 */

/** 分享码字符集。平台下发的是大写字母+数字，这里放宽到常见安全字符以防未来变体。 */
const SHARE_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/

/** 从「完整分享链接 / 带参裸域名 / 纯码」里提取 sharecode；取不到返回空串。 */
export function extractShareCode(input: string | null | undefined): string {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) return ''
  // 优先按 URL 解析：用户从平台复制的一般是完整链接，可能还带别的参数或锚点
  try {
    const code = new URL(raw).searchParams.get('sharecode') ?? ''
    if (SHARE_CODE_RE.test(code)) return code
  } catch {
    /* 不是合法 URL（缺 scheme 等），继续按字符串扫描 */
  }
  // 字符串扫描：`?sharecode=X` 与 `&sharecode=X` 都能取
  const matched = /[?&]sharecode=([^&\s#]+)/.exec(raw)
  if (matched && SHARE_CODE_RE.test(matched[1])) return matched[1]
  // 最后一种：整串就是一个码（用户手动粘贴时常见）
  return SHARE_CODE_RE.test(raw) ? raw : ''
}

/** 给 base 设置（传空则清除）sharecode，返回新地址；base 为空返回空串。 */
export function withShareCode(base: string, code: string | null | undefined): string {
  const raw = typeof base === 'string' ? base.trim() : ''
  if (!raw) return ''
  try {
    const url = new URL(raw)
    const value = typeof code === 'string' ? code.trim() : ''
    if (value) url.searchParams.set('sharecode', value)
    else url.searchParams.delete('sharecode')
    return url.toString()
  } catch {
    return raw
  }
}

/** 在 base 上追加查询参数（**保留原有查询串**）；base 为空返回空串。 */
export function appendQuery(base: string, extra?: Record<string, string>): string {
  const raw = typeof base === 'string' ? base.trim() : ''
  if (!raw) return ''
  try {
    const url = new URL(raw)
    for (const [key, value] of Object.entries(extra ?? {})) url.searchParams.set(key, value)
    return url.toString()
  } catch {
    return raw
  }
}

/**
 * 组合出真正要加载的基址：环境变量里的地址 + 本地偏好的分享码覆盖。
 *
 * 空地址返回空串（调用方应走本地兜底页，而不是加载空 URL —— 那样只会白屏）。
 */
export function composeBaseUrl(envBase: string, overrideCode?: string | null): string {
  const base = typeof envBase === 'string' ? envBase.trim() : ''
  if (!base) return ''
  const code = typeof overrideCode === 'string' ? overrideCode.trim() : ''
  return code ? withShareCode(base, code) : base
}
