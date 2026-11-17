/**
 * 机器视觉测试用合成样本工厂
 * ============================================================================
 * 为什么自己造图而不是找真实截图：
 * - 真实截图无法入库（隐私 + 体积），也没有「标准答案」；
 * - 合成图可以精确控制「行距/是否有长直线/色彩数量」，从而验证**算法在特定信号上
 *   是否按预期响应**，这是单测该管的事。
 *
 * 注意：合成样本只能证明「规则实现符合设计」，不能证明「真实世界准确率」。
 * 后者要靠 P1-15 的 50 张人工标注评测集，报告里必须分开表述。
 */

import type { RGBAImage } from '../web/src/lib/vision/gray'

/** 颜色三元组。 */
export type RGB = [number, number, number]

/** 按像素生成图。 */
export function makeImage(w: number, h: number, fill: (x: number, y: number) => RGB | [number, number, number, number]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = fill(x, y)
      const p = (y * w + x) * 4
      data[p] = c[0]
      data[p + 1] = c[1]
      data[p + 2] = c[2]
      data[p + 3] = c.length === 4 ? (c[3] as number) : 255
    }
  }
  return { data, width: w, height: h }
}

/** 纯色。 */
export function solid(w: number, h: number, c: RGB): RGBAImage {
  return makeImage(w, h, () => c)
}

/** 在图上画实心矩形（就地修改）。 */
export function rect(img: RGBAImage, x0: number, y0: number, rw: number, rh: number, c: RGB): RGBAImage {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y0 + rh); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x0 + rw); x++) {
      const p = (y * img.width + x) * 4
      img.data[p] = c[0]
      img.data[p + 1] = c[1]
      img.data[p + 2] = c[2]
      img.data[p + 3] = 255
    }
  }
  return img
}

/**
 * 代码截图：深色底 + 等宽"文字行"（每 16px 一行、行内若干短横条模拟单词）。
 * 这是最容易判定的正样本：深底 + 强行周期 + 无长直线。
 */
export function codeShot(w = 480, h = 320): RGBAImage {
  const img = solid(w, h, [30, 34, 40])
  const lineH = 16
  for (let y = 12; y < h - 12; y += lineH) {
    let x = 24
    let i = 0
    while (x < w - 40) {
      const wordW = 14 + ((i * 7) % 26)
      // 交替两种"语法高亮"色，模拟关键字/字符串
      const c: RGB = i % 4 === 0 ? [197, 134, 192] : i % 3 === 0 ? [152, 195, 121] : [171, 178, 191]
      rect(img, x, y, wordW, 7, c)
      x += wordW + 7
      i++
    }
  }
  return img
}

/** 文档截图：白底 + 满行文字（更密、无长直线、无彩色）。 */
export function documentShot(w = 480, h = 340): RGBAImage {
  const img = solid(w, h, [252, 252, 252])
  const lineH = 14
  for (let y = 18; y < h - 18; y += lineH) {
    let x = 40
    while (x < w - 40) {
      const wordW = 18 + ((x * 13) % 20)
      rect(img, x, y, Math.min(wordW, w - 40 - x), 6, [40, 40, 40])
      x += wordW + 6
    }
  }
  return img
}

/** 表格：白底 + 横竖长线 + 单元格文字。 */
export function tableShot(w = 480, h = 320): RGBAImage {
  const img = solid(w, h, [255, 255, 255])
  const rows = 8
  const cols = 5
  const top = 24
  const left = 24
  const cw = Math.floor((w - 48) / cols)
  const rh = Math.floor((h - 48) / rows)
  // 网格线：横竖都横跨整幅（axisRatio 的关键信号）
  for (let r = 0; r <= rows; r++) rect(img, left, top + r * rh, cw * cols, 1, [90, 90, 90])
  for (let c = 0; c <= cols; c++) rect(img, left + c * cw, top, 1, rh * rows, [90, 90, 90])
  // 单元格文字
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      rect(img, left + c * cw + 6, top + r * rh + Math.floor(rh / 2) - 3, Math.max(4, cw - 16), 5, [50, 50, 50])
    }
  }
  return img
}

/** 界面：浅灰底 + 顶部导航条 + 卡片分隔线 + 一个主色按钮。 */
export function uiShot(w = 480, h = 340): RGBAImage {
  const img = solid(w, h, [246, 247, 249])
  rect(img, 0, 0, w, 44, [255, 255, 255]) // 顶栏
  rect(img, 0, 44, w, 1, [222, 226, 230]) // 顶栏分隔线（横跨整幅）
  rect(img, 24, 64, w - 48, 96, [255, 255, 255]) // 卡片
  rect(img, 24, 64, w - 48, 1, [230, 232, 236])
  rect(img, 24, 64, 1, 96, [230, 232, 236])
  rect(img, 40, 84, 120, 8, [60, 64, 70]) // 标题
  rect(img, 40, 104, w - 120, 6, [140, 145, 152]) // 正文
  rect(img, 40, 128, 96, 24, [91, 84, 217]) // 主色按钮
  return img
}

/** 图表：白底 + 三根饱和柱 + 坐标轴线。 */
export function chartShot(w = 480, h = 320): RGBAImage {
  const img = solid(w, h, [255, 255, 255])
  const colors: RGB[] = [
    [66, 133, 244],
    [219, 68, 55],
    [244, 180, 0],
  ]
  const baseY = h - 40
  for (let i = 0; i < 3; i++) {
    const bh = 80 + i * 45
    rect(img, 70 + i * 90, baseY - bh, 56, bh, colors[i])
  }
  rect(img, 50, 24, 1, baseY - 24, [120, 120, 120]) // y 轴
  rect(img, 50, baseY, w - 80, 1, [120, 120, 120]) // x 轴
  return img
}

/** 照片：彩色噪声 + 大色块（无行周期、颜色种类多）。 */
export function photoShot(w = 320, h = 240): RGBAImage {
  let seed = 12345
  const rnd = () => {
    // 线性同余，固定种子保证可复现
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  return makeImage(w, h, (x, y) => {
    const base = Math.sin(x / 23) * 60 + Math.cos(y / 17) * 60 + 128
    return [
      Math.max(0, Math.min(255, base + rnd() * 70)),
      Math.max(0, Math.min(255, base * 0.7 + rnd() * 60)),
      Math.max(0, Math.min(255, 220 - base * 0.4 + rnd() * 50)),
    ] as RGB
  })
}

/**
 * 暖色渐变照片：深蓝 → 橙 → 浅黄，加轻微噪点。
 *
 * 这个样本是"误判重灾区"：整幅偏红橙，old 规则（r-g>40 即算红）下 redRatio 高达 0.8，
 * 会被判成"满屏报错"。真实对应场景是日落、暖光室内、食物特写。
 * 噪点刻意保留——手机拍的照片本身有颗粒感，不能靠"磨平"来通过判定。
 */
export function warmGradient(w = 360, h = 480): RGBAImage {
  let seed = 20241114
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff
    return seed / 0x7fffffff
  }
  const stops: Array<{ at: number; c: RGB }> = [
    { at: 0, c: [43, 58, 103] },
    { at: 0.5, c: [192, 108, 74] },
    { at: 1, c: [242, 215, 160] },
  ]
  const lerp = (a: number, b: number, k: number) => a + (b - a) * k
  const mix = (a: RGB, b: RGB, k: number): RGB => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]
  return makeImage(w, h, (x, y) => {
    // 斜向渐变：横向占 6 成、纵向占 4 成，避免与"行/列投影"形成假周期
    const t = Math.min(1, Math.max(0, (x / w) * 0.6 + (y / h) * 0.4))
    let lo = stops[0]
    let hi = stops[stops.length - 1]
    for (let i = 0; i < stops.length - 1; i++) {
      if (t >= stops[i].at && t <= stops[i + 1].at) {
        lo = stops[i]
        hi = stops[i + 1]
        break
      }
    }
    const k = hi.at === lo.at ? 0 : (t - lo.at) / (hi.at - lo.at)
    const c = mix(lo.c, hi.c, k)
    const n = (rnd() - 0.5) * 24
    return [
      Math.max(0, Math.min(255, c[0] + n)),
      Math.max(0, Math.min(255, c[1] + n)),
      Math.max(0, Math.min(255, c[2] + n)),
    ] as RGB
  })
}

/** 报错截图：深色终端 + 一大段红色错误行。 */
export function errorShot(w = 480, h = 300): RGBAImage {
  const img = solid(w, h, [22, 24, 28])
  for (let y = 16; y < h - 16; y += 15) {
    const isError = y > 90 && y < 160
    let x = 20
    while (x < w - 30) {
      const wordW = 16 + ((x * 7) % 22)
      rect(img, x, y, Math.min(wordW, w - 30 - x), 6, isError ? [230, 70, 70] : [160, 168, 180])
      x += wordW + 6
    }
  }
  return img
}

/**
 * 模糊：迭代 3 次 3×3 均值滤波，近似高斯 σ≈1.2。
 * 用来验证「锐度判据对糊图敏感」——这是识别前质量门禁的核心能力。
 */
export function blur(img: RGBAImage, passes = 3): RGBAImage {
  let src = img
  for (let p = 0; p < passes; p++) {
    const out: RGBAImage = { data: new Uint8ClampedArray(src.data.length), width: src.width, height: src.height }
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        let r = 0
        let g = 0
        let b = 0
        let n = 0
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const sx = Math.min(src.width - 1, Math.max(0, x + dx))
            const sy = Math.min(src.height - 1, Math.max(0, y + dy))
            const sp = (sy * src.width + sx) * 4
            r += src.data[sp]
            g += src.data[sp + 1]
            b += src.data[sp + 2]
            n++
          }
        }
        const dp = (y * src.width + x) * 4
        out.data[dp] = r / n
        out.data[dp + 1] = g / n
        out.data[dp + 2] = b / n
        out.data[dp + 3] = 255
      }
    }
    src = out
  }
  return src
}

/** 过曝：把 35% 的区域打成纯白（模拟屏幕反光）。 */
export function glare(img: RGBAImage): RGBAImage {
  return rect(img, 0, 0, Math.floor(img.width * 0.35), img.height, [255, 255, 255])
}

/** 元信息工厂（quality 需要）。 */
export function metaOf(img: RGBAImage, name = 'test.png', bytes = 200_000) {
  return {
    name,
    format: 'png' as const,
    bytes,
    width: img.width,
    height: img.height,
    hasAlpha: false,
    orientation: 1,
  }
}

/**
 * 报错弹窗：浅色页面 + 白色卡片 + 一条红色告警条 + 若干行说明文字。
 * 与「深色终端的红字」不同，这里的红色是一整块填充，redRatio 明显更高，
 * 是 error 类真正该覆盖的形态（终端红字会被判成 code，两边清单都含报错读取项，可接受）。
 */
export function errorDialog(w = 480, h = 320): RGBAImage {
  const img = solid(w, h, [238, 240, 244])
  rect(img, 40, 40, w - 80, h - 80, [255, 255, 255]) // 卡片
  rect(img, 40, 40, w - 80, 44, [222, 60, 60]) // 红色告警条
  rect(img, 56, 54, 140, 10, [255, 255, 255]) // 告警标题（白字块）
  // 正文若干行
  for (let i = 0; i < 6; i++) {
    rect(img, 64, 104 + i * 26, w - 160 - (i % 3) * 30, 8, [70, 74, 82])
  }
  rect(img, w - 148, h - 84, 88, 28, [222, 60, 60]) // 危险操作按钮
  return img
}

/**
 * 整数倍面积平均降采样（模拟"同一张图被压缩/缩小后重传"）。
 * phash 的缩放不变性必须用**同一份内容**去验，不能重新生成一张"同款"图——
 * 后者的排版细节不同，哈希本来就该不同。
 */
export function downscale(img: RGBAImage, factor: number): RGBAImage {
  const f = Math.max(1, Math.floor(factor))
  const w = Math.max(1, Math.floor(img.width / f))
  const h = Math.max(1, Math.floor(img.height / f))
  const out: RGBAImage = { data: new Uint8ClampedArray(w * h * 4), width: w, height: h }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let dy = 0; dy < f; dy++) {
        for (let dx = 0; dx < f; dx++) {
          const sp = ((y * f + dy) * img.width + (x * f + dx)) * 4
          r += img.data[sp]
          g += img.data[sp + 1]
          b += img.data[sp + 2]
        }
      }
      const n = f * f
      const dp = (y * w + x) * 4
      out.data[dp] = r / n
      out.data[dp + 1] = g / n
      out.data[dp + 2] = b / n
      out.data[dp + 3] = 255
    }
  }
  return out
}
