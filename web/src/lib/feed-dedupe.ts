/**
 * 订阅条目去重键 + 内容指纹（纯函数，浏览器 / Node 同构，零依赖）。
 *
 * 为什么单独成文件（而不是塞进 `services/feedService.ts`）：
 * 桌面端 P2-29 的 feedPoller 要复用同一套去重逻辑，两边各写一份必然分叉；
 * 这里只放不碰网络、不碰数据库的纯函数，谁都能引、谁都测得动。
 *
 * 三条口径（2026-10-31 雷达 §13.1 / 11-01 §14.1 定死，不重新论证）：
 * 1. 去重键 = `guid || link || sha1(title+published)`，**不允许按 link 单键**；
 * 2. 用 link 当键之前**必须剥掉跟踪参数**（`utm_*` / `fbclid` 等），否则同一篇文章
 *    从不同渠道进来会被当成两条；
 * 3. 内容指纹（`contentHash`）用于「内容没变就只更新 `last_checked_at`」这一路，
 *    与去重键是两件事，不能互相替代。
 */

/** 跟踪参数前缀（`utm_` 开头的一律剥）。 */
const TRACKING_PREFIXES = ['utm_', 'at_', 'pk_', 'mtm_']

/** 逐字匹配的跟踪参数（来源渠道标识，不参与内容定位）。 */
const TRACKING_KEYS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'yclid',
  'msclkid',
  'twclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'spm',
  'scm',
  'ref_src',
  'ref_url',
  '__twitter_impression',
  'share_source',
])

/** 是否是跟踪参数（`utm_source` / `fbclid` 这类）。 */
export function isTrackingParam(name: string): boolean {
  const key = name.toLowerCase()
  if (TRACKING_KEYS.has(key)) return true
  return TRACKING_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/**
 * 剥掉 URL 上的跟踪参数。
 *
 * - 非法 URL 原样返回（去重键仍可用，只是不剥参数）；
 * - 参数按名字排序后重建：同一条链接参数顺序不同也算同一条；
 * - 保留 hash（有些站点用 `#/post/1` 定位内容，剥了就撞车）。
 */
export function stripTrackingParams(rawUrl: string): string {
  const input = String(rawUrl || '').trim()
  if (!input) return ''

  let url: URL
  try {
    url = new URL(input)
  } catch {
    return input
  }

  const kept: Array<[string, string]> = []
  url.searchParams.forEach((value, name) => {
    if (!isTrackingParam(name)) kept.push([name, value])
  })

  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])))

  const search = kept.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')
  // 用 URL 自带序列化保留 protocol/host/path 的原始大小写，只替换 query
  const rebuilt = `${url.protocol}//${url.host}${url.pathname}${search ? `?${search}` : ''}${url.hash}`
  return rebuilt
}

/**
 * 同步 SHA-1（十六进制小写）。
 *
 * 为什么不用 `crypto.subtle`：它是异步的，而 `buildDedupeKey` 必须是同步纯函数
 * （调用方要在 map 里直接算键）。SHA-1 在这里只做「无 guid 时的稳定短标识」，
 * 不承担任何安全职责——用它是为了让多个实现（Web / 桌面 / 未来插件）算出同一个值。
 */
export function sha1Hex(input: string): string {
  const bytes = new TextEncoder().encode(String(input))
  const bitLength = bytes.length * 8
  // 补位：原文 + 0x80 + 若干 0，长度 ≡ 56 (mod 64)，末尾 8 字节写大端比特长度
  const total = (((bytes.length + 8) >> 6) + 1) * 64
  const block = new Uint8Array(total)
  block.set(bytes)
  block[bytes.length] = 0x80

  const view = new DataView(block.buffer)
  view.setUint32(total - 8, Math.floor(bitLength / 0x1_0000_0000))
  view.setUint32(total - 4, bitLength >>> 0)

  let h0 = 0x67452301
  let h1 = 0xefcdab89
  let h2 = 0x98badcfe
  let h3 = 0x10325476
  let h4 = 0xc3d2e1f0

  const w = new Uint32Array(80)
  for (let offset = 0; offset < total; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4)
    for (let i = 16; i < 80; i += 1) {
      const n = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]
      w[i] = ((n << 1) | (n >>> 31)) >>> 0
    }

    let a = h0
    let b = h1
    let c = h2
    let d = h3
    let e = h4

    for (let i = 0; i < 80; i += 1) {
      let f: number
      let k: number
      if (i < 20) {
        f = (b & c) | (~b & d)
        k = 0x5a827999
      } else if (i < 40) {
        f = b ^ c ^ d
        k = 0x6ed9eba1
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d)
        k = 0x8f1bbcdc
      } else {
        f = b ^ c ^ d
        k = 0xca62c1d6
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0
      e = d
      d = c
      c = ((b << 30) | (b >>> 2)) >>> 0
      b = a
      a = temp
    }

    h0 = (h0 + a) >>> 0
    h1 = (h1 + b) >>> 0
    h2 = (h2 + c) >>> 0
    h3 = (h3 + d) >>> 0
    h4 = (h4 + e) >>> 0
  }

  return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('')
}

/** FNV-1a 32 位（十六进制），仅作 `crypto.subtle` 缺席时的指纹兜底。 */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 内容指纹（`settings.feed_state[id].lastHash`）。
 *
 * 优先 SHA-256（`crypto.subtle`）；无 subtle 的环境（老内核 / 非安全上下文）降级为
 * `fnv:` 前缀的 FNV-1a。两种值**不互相比较**——指纹只在本机内前后比较，
 * 环境降级最多导致多抓一次，不会产生重复条目（重复由去重键拦）。
 */
export async function contentHash(input: string): Promise<string> {
  const text = String(input || '')
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', new TextEncoder().encode(text))
      return Array.from(new Uint8Array(digest))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    } catch {
      /* 落到下面的兜底 */
    }
  }
  return `fnv:${fnv1a32(text)}`
}

/** 去重键输入。 */
export interface DedupeInput {
  /** 源站声明的稳定标识（RSS `guid` / Atom `id`）。 */
  guid?: string | null
  /** 条目链接。 */
  link?: string | null
  /** 标题（guid / link 都缺时才用）。 */
  title?: string | null
  /** 发布时间原文或 ISO（guid / link 都缺时才用）。 */
  publishedAt?: string | null
}

/**
 * 生成条目去重键：`guid → link（剥跟踪参数）→ sha1(title+published)`。
 *
 * 返回空串表示「三个来源都拿不到」——这类条目**不应入库**（无稳定键就无法去重，
 * 每次抓取都会新增一条），由调用方丢弃并计入 `skipped`。
 */
export function buildDedupeKey(input: DedupeInput): string {
  const guid = String(input.guid ?? '').trim()
  if (guid) return guid

  const link = stripTrackingParams(String(input.link ?? ''))
  if (link) return link

  const title = String(input.title ?? '').trim()
  const published = String(input.publishedAt ?? '').trim()
  if (!title && !published) return ''
  return sha1Hex(`${title}|${published}`)
}
