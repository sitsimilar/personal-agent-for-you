/**
 * 中文 → 拼音首字母（命令面板检索用，P1-12 下半）。
 *
 * ## 为什么不装 pinyin 库
 *
 * 完整拼音库（`pinyin-pro` / `pinyin` / `tiny-pinyin`）为了覆盖 2 万+ 汉字，体积
 * 都在 30KB~500KB，而面板只需要**导航文案那几个字**的首字母：用户敲 `db` 想找「待办」、
 * 敲 `sws` 想找「思维树」。为这点需求把一张全量表塞进首屏 chunk 不划算
 * （300KB 阈值与按路由懒加载的约束见计划 §六）。
 *
 * 所以这里是一张**手工维护的窄表**：只覆盖本项目导航/动作文案用到的字。
 *
 * ## 覆盖不足时怎么办（关键设计）
 *
 * 表里没有的字一律映射成 `UNKNOWN_INITIAL`（`?`），**不做跳过**。
 * 跳过会让「接待办」这类词拼出 `jb`（假命中「简报」），而 `?` 永远不会被用户敲出来
 * ——宁可拼音检索失效，也不能返回错的东西。
 *
 * `qa/p1-12-palette-record.test.ts` 有一条用例遍历 `NAV_GROUPS` 的全部 label，
 * 断言它们**不含 `?`**：新增菜单项若用了表外的字，测试会直接红，提醒补表。
 */

/** 表外汉字 / 非汉字（除 ASCII 字母数字）的占位符。 */
export const UNKNOWN_INITIAL = '?'

/**
 * 汉字 → 拼音首字母。
 *
 * 只收「导航标签 + 动作文案 + 常用操作词」用到的字；多音字按**该词里的读音**取
 * （例如「重要」的「重」取 `z`、「重新」也取 `z`，本项目不区分）。
 */
export const PINYIN_INITIALS: Readonly<Record<string, string>> = {
  // 导航标签
  全: 'q', 部: 'b', 信: 'x', 息: 'x', 想: 'x', 法: 'f', 资: 'z', 料: 'l',
  待: 'd', 办: 'b', 日: 'r', 历: 'l', 回: 'h', 顾: 'g', 学: 'x', 习: 'x',
  目: 'm', 标: 'b', 思: 's', 维: 'w', 树: 's', 工: 'g', 具: 'j', 箱: 'x',
  插: 'c', 件: 'j', 收: 's', 站: 'z', 设: 's', 置: 'z',
  // 动作 / 界面方案文案
  快: 'k', 速: 's', 记: 'j', 录: 'l', 新: 'x', 建: 'j', 切: 'q', 换: 'h',
  流: 'l', 畅: 'c', 优: 'y', 先: 'x', 静: 'j', 默: 'm', 化: 'h', 分: 'f',
  区: 'q', 骨: 'g', 架: 'j', 到: 'd', 动: 'd', 作: 'z', 界: 'j', 面: 'm',
  页: 'y', 案: 'a', 方: 'f', 跳: 't', 转: 'z', 打: 'd', 开: 'k',
  // 高频操作词（未来面板命令可能用到）
  搜: 's', 索: 's', 查: 'c', 找: 'z', 通: 't', 知: 'z', 提: 't', 醒: 'x',
  导: 'd', 出: 'c', 入: 'r', 编: 'b', 辑: 'j', 保: 'b', 存: 'c', 删: 's',
  除: 'c', 复: 'f', 制: 'z', 上: 's', 下: 'x', 一: 'y', 二: 'e', 三: 's',
  四: 's', 五: 'w', 六: 'l', 七: 'q', 八: 'b', 九: 'j', 十: 's', 天: 't',
  周: 'z', 月: 'y', 年: 'n', 今: 'j', 明: 'm', 昨: 'z', 早: 'z', 晚: 'w',
  中: 'z', 我: 'w', 的: 'd', 主: 'z', 题: 't', 内: 'n', 容: 'r',
}

/** 是否是「汉字」（CJK 统一表意文字，含扩展 A 与兼容区）。 */
function isCjk(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  )
}

/**
 * 取文本的拼音首字母串。
 *
 * - 汉字 → 表内首字母；表外 → `?`
 * - ASCII 字母数字 → 原字符（小写），这样中英混排的文案也能被英文词命中
 * - 空格 / 标点 / emoji → 跳过（它们不携带检索信息）
 *
 * 纯函数：不读时间、不碰 DOM。`initialLetters('待办') === 'db'`。
 */
export function initialLetters(text: string): string {
  if (typeof text !== 'string' || !text) return ''
  let out = ''
  for (const char of text) {
    if (!char) continue
    const lower = char.toLowerCase()
    if (/[a-z0-9]/.test(lower)) {
      out += lower
      continue
    }
    if (!isCjk(char)) continue // 标点、空格、emoji：跳过
    out += PINYIN_INITIALS[char] ?? UNKNOWN_INITIAL
  }
  return out
}

/**
 * 生成可挂到命令 `keywords` 上的拼音检索词。
 *
 * 返回 `undefined` 的条件（三种情况都不该污染检索）：
 * 1. 首字母串不足 2 个字符（单字缩写无意义，还会与英文单词撞车）；
 * 2. 串里含 `?`（有字不在表内，宁可检索不到）；
 * 3. 输入不是字符串 / 只含标点。
 */
export function pinyinKeyword(text: string): string | undefined {
  const initials = initialLetters(text)
  if (initials.length < 2 || initials.includes(UNKNOWN_INITIAL)) return undefined
  return initials
}

/** 调试用：返回 `{ initials, missing }`，便于补表时确认是哪个字漏了。 */
export function pinyinCoverage(text: string): { initials: string; missing: string[] } {
  const missing: string[] = []
  for (const char of String(text ?? '')) {
    if (!isCjk(char)) continue
    if (!PINYIN_INITIALS[char]) missing.push(char)
  }
  return { initials: initialLetters(text), missing }
}
