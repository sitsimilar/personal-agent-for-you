/**
 * 机器视觉模块 · 提示词构造
 * ============================================================================
 * 设计原则（每条都对应旧实现的一个具体缺陷）：
 *
 * 1. **三段式输出**：旧提示词只说"描述截图 → 推测需求 → 给建议"，模型经常混在一起写，
 *    用户看不出"哪句是图里的事实、哪句是猜测"。现在强制拆成
 *    输入理解（understanding）/ 问题定位（localization）/ 解决方案（solution），
 *    每段各自的字段含义固定，前端分栏展示。
 *
 * 2. **场景清单按类注入**：代码截图要读语法、表格要读行列、图表要读坐标轴，
 *    用同一句"识别截图内容"问，模型只会给泛泛描述。场景清单把"该看什么"写死。
 *
 * 3. **证据可回溯**：`transcribed` 要求逐字摘录，`evidence` 要求指明依据，
 *    没把握的写进 `needMoreInfo`。这是抑制幻觉最有效的一条。
 *
 * 4. **代码与图的绑定**：给了用户代码时，定位必须落到真实存在的文件/行/符号；
 *    找不到就写 null 并说明，不许编一个像样的函数名。
 *
 * 5. **省 token**：schema 只描述一次，图片按"图1/图2"引用，不重复贴元信息。
 */

import type { SceneKind } from './types'

/** JSON schema 的紧凑描述（只此一份，不随图片数增长）。 */
const OUTPUT_SCHEMA = `只输出一个 JSON 对象（不要 markdown 围栏、不要前后说明）：
{
  "scene": "code|error|ui|chat|table|chart|document|diagram|photo|handwriting|unknown",
  "status": "ok|partial|unreadable",
  "coverage": { "expected": 0, "missing": [], "unreadable": [] },
  "blocks": [ { "type": "title|paragraph|table|figure|formula|code|list|text", "order": 0, "text": "", "rows": null, "cols": null } ],
  "understanding": { "summary": "", "evidence": [], "transcribed": [] },
  "localization": { "file": null, "line": null, "symbol": null, "reason": "", "confidence": 0 },
  "solution": { "steps": [], "patch": null, "verification": [], "boundaries": [] },
  "needMoreInfo": []
}`

/** 核心规则：与场景无关的硬约束。 */
const CORE_RULES = `你是资深工程师，负责"看图 + 看代码"定位并解决用户的真实问题。遵守：
1. 只写图上或用户代码里能证实的内容；看不清的字用「?」占位，不要猜。
2. "transcribed" 逐字摘录图内关键文本/代码/报错（最多 15 行，按出现顺序）。
3. "evidence" 每条都要指明来源：「图1 第3行红字」「你给的 main.ts 第 42 行」。
4. "localization" 必须落到用户代码中真实存在的文件/行/符号；定位不到就填 null，并在 reason 里说明缺什么，禁止编造标识符。
5. "solution.patch" 给最小改动（unified diff 或该函数改后的完整代码），不要整文件重写。
6. "solution.boundaries" 至少 1 条：这个方案在什么条件下不成立（版本差异/环境/数据形态）。
7. 信息不足以定论时，status 填 partial，并把这些缺口写进 needMoreInfo（最多 3 条）。`

/** 各场景的"该看什么"清单。每类 4~6 条，全部是可核对的具体项。 */
const SCENE_CHECKLIST: Record<SceneKind, string> = {
  code: `本图是代码/终端。重点看：① 语言与框架（从语法、导入、文件名判断）；② 缩进与括号层级是否错位；③ 报错行/高亮行；④ 关键标识符逐字抄录；⑤ 与用户代码的差异（改名/漏参/类型不符）。`,
  error: `本图是报错。重点看：① 错误类型与错误码逐字；② 堆栈首帧（文件:行）；③ 触发操作与输入；④ 报错前后的界面状态；⑤ 是否可复现（图中是否有"重试/再次"痕迹）。`,
  ui: `本图是界面。重点看：① 页面与组件层级；② 控件文案与状态（空/加载/错误/禁用）；③ 数值与单位；④ 明显的对齐/溢出/截断；⑤ 用户当前所在步骤。`,
  chat: `本图是对话。重点看：① 参与者与角色；② 消息先后顺序与引用关系；③ 尚未回答的问题；④ 时间戳/状态标记。`,
  table: `本图是表格。重点看：① 列名逐字与单位；② 行列数；③ 合并单元格；④ 数值格式（千分位/百分号/负数）；⑤ 空值与"—"的区别。blocks 里用 type=table 并填 rows/cols。`,
  chart: `本图是图表。重点看：① 图表类型；② 横纵轴标签与单位；③ 各系列名称与颜色；④ 极值与拐点的大致数值；⑤ 图例与注释。`,
  document: `本图是文档。重点看：① 标题层级；② 段落主旨（每段一句）；③ 编号/项目符号列表；④ 公式与符号；⑤ 页眉页脚/页码。`,
  diagram: `本图是示意图。重点看：① 节点名称逐字；② 箭头方向与连接关系；③ 分组/泳道；④ 图例与标注；⑤ 与用户问题相关的那个节点。`,
  photo: `本图是照片。重点看：① 主体与场景；② 画面内的文字（招牌/标签/屏幕）；③ 与用户问题相关的区域；④ 是否拍到屏幕（摩尔纹/反光）。`,
  handwriting: `本图是手写。重点看：① 逐字转写（不确定的字用「?」）；② 公式/符号；③ 箭头与圈注；④ 行列结构（是否表格）。`,
  unknown: `先判断这是什么（代码/界面/报错/图表/表格/文档/示意图/照片/手写），再按该类要点提取；判不出就在 scene 填 unknown 并说明。`,
}

/** 给模型的批次元信息（图片尺寸、质量问题）——帮助它理解"为什么看不清"。 */
export interface PromptImageInfo {
  label: string
  width: number
  height: number
  scene: SceneKind
  /** 质量问题码（如 ['blurry']），空数组表示无问题。 */
  issues: string[]
}

/**
 * 构造 system prompt。
 *
 * @param scene    主导场景（用于注入清单）
 * @param hasCode  用户是否提供了代码（决定是否强调定位规则）
 */
export function buildSystemPrompt(scene: SceneKind, hasCode: boolean): string {
  const parts = [CORE_RULES, '', SCENE_CHECKLIST[scene] ?? SCENE_CHECKLIST.unknown]
  if (hasCode) {
    parts.push(
      '',
      '用户同时提供了代码。定位时必须：① 先在图里找到报错/异常表现；② 在代码里找到对应的行；③ 说明两者的因果关系；④ 补丁与代码原有风格一致（缩进/命名/错误处理）。',
    )
  } else {
    parts.push('', '用户没有提供代码。localization 的 file/line/symbol 一律填 null，把定位写在 reason 里（"问题出在图中第几行的哪个部分"）。')
  }
  parts.push('', OUTPUT_SCHEMA)
  return parts.join('\n')
}

/**
 * 构造 user 内容（多模态数组）。
 *
 * 顺序很重要：**先文字后图片**。视觉模型对"最后出现的图"注意力最高，
 * 而我们的问题是"结合图与代码"，所以把约束与代码放在前面、图片放后面，
 * 让模型在读完约束后再看图。
 *
 * @param images 已归一化的图片（label 用于正文引用，如「图1」）
 * @param code   用户代码（可选）
 * @param context 用户补充说明（可选）
 * @param question 用户具体问题（可选）
 */
export function buildUserContent(
  images: Array<PromptImageInfo & { dataUrl: string }>,
  code?: string,
  context?: string,
  question?: string,
): Array<Record<string, unknown>> {
  const content: Array<Record<string, unknown>> = []

  const meta = images
    .map((i) => `${i.label}：${i.width}×${i.height}，判定为${i.scene}${i.issues.length ? `，质量问题：${i.issues.join('、')}` : ''}`)
    .join('；')
  content.push({ type: 'text', text: `【图片】${meta}` })

  if (context?.trim()) {
    content.push({ type: 'text', text: `【用户描述】${context.trim().slice(0, 2000)}` })
  }
  if (question?.trim()) {
    content.push({ type: 'text', text: `【用户问题】${question.trim().slice(0, 1000)}` })
  }
  if (code?.trim()) {
    // 代码上限 12000 字符：够放下一个文件的核心片段，又不至于挤掉图片的 token
    const trimmed = code.trim().slice(0, 12000)
    content.push({ type: 'text', text: `【用户代码】\n${trimmed}` })
  }
  content.push({
    type: 'text',
    text: `请按 ${images.map((i) => i.label).join('、')} 的顺序分析，输出约定的 JSON。`,
  })

  // 图片放最后：模型对末尾的图注意力最高
  for (const img of images) {
    content.push({ type: 'text', text: `${img.label}：` })
    content.push({ type: 'image_url', image_url: { url: img.dataUrl } })
  }
  return content
}

/**
 * 解析失败时的补救指令：只要求"把上一次的回答改成纯 JSON"，不重新看图。
 * 这样比重跑一次便宜，也避免两次回答不一致。
 */
export function buildJsonRepairPrompt(raw: string): string {
  return `你上一次的输出不是合法 JSON。请把下面的内容**改写为**约定的 JSON 对象，不要新增或删除事实，不要加任何解释：
---
${raw.slice(0, 6000)}
---`
}

/** 场景清单的纯文本导出版（用于文档/测试断言）。 */
export function sceneChecklistText(scene: SceneKind): string {
  return SCENE_CHECKLIST[scene] ?? SCENE_CHECKLIST.unknown
}
