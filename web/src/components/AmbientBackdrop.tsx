import { useEffect, useRef } from 'react'
import { Box } from '@mui/material'
import { useUiSchemeStore } from '@/store/uiSchemeStore'
import type { BackdropParams } from '@/lib/backdrop'

/**
 * 背景氛围装饰层（「线构」令牌体系的可关闭底纹）。
 *
 * ## 挂载位置
 * 由 `Layout` 挂在壳层最外层（`z-index: 0`，内容区 `z-index: 1` 压在上面），
 * 只在登录后的主界面出现：登录页与启动页保持干净，不参与首屏竞争。
 *
 * ## 参数从哪来
 * 主题与四个参数由 `store/uiSchemeStore` 持有，并已编译成 `--bd-*` 变量：
 * 轨道线纯 CSS 消费这些变量；Canvas 两套则读取计算后的颜色与线宽。
 * 组件本身**不写 CSS 变量**，只负责结构与帧循环，避免两处状态源。
 *
 * ## 三条实现纪律
 * 1. **不抢主线程**：`orbit` 是纯 CSS（只动 transform），`terrain` 只画一次再用 CSS 平移，
 *    `starfield` 是 30fps 上限的 Canvas 2D，页面隐藏 / 减弱动效 / 速度为 0 时立即停帧；
 * 2. **不碰内容**：整层 `pointer-events: none` + `aria-hidden`，不参与命中测试与朗读；
 * 3. **颜色只读令牌**：JS 只读 `--bd-*` 计算值，不写死色值，深浅色切换由 `data-theme` 驱动。
 *
 * 关闭（`off`）时**不挂载**任何渲染节点：这是「一键关掉」在性能上的真实含义。
 */

const REDUCED_QUERY = '(prefers-reduced-motion: reduce)'

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia?.(REDUCED_QUERY).matches ?? false
  } catch {
    return false
  }
}

/** 从根元素读取背景专用令牌（由 `lib/backdrop-style.ts` 按参数合成后写入）。 */
function readBackdropColors() {
  const cs = getComputedStyle(document.documentElement)
  const pick = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  return {
    dot: pick('--bd-dot', 'rgba(90, 90, 110, 0.5)'),
    line: pick('--bd-line', 'rgba(90, 90, 110, 0.14)'),
    accent: pick('--bd-accent', 'rgba(91, 84, 217, 0.18)'),
    stroke: Math.max(0.6, Number.parseFloat(pick('--bd-stroke-w', '1px')) || 1),
  }
}

export default function AmbientBackdrop() {
  const backdrop = useUiSchemeStore((s) => s.backdrop)
  const params = useUiSchemeStore((s) => s.backdropParams[s.backdrop])
  if (backdrop === 'off') return null

  return (
    <Box className="bd-layer" aria-hidden="true">
      {backdrop === 'orbit' ? <OrbitLayer /> : <CanvasLayer mode={backdrop} params={params} />}
    </Box>
  )
}

/**
 * 轨道线：同心圆 + 两个沿轨道缓慢移动的点 + 极细十字定位线。
 *
 * 全部是 `div` 与 CSS 关键帧，**没有帧循环**：浏览器只做合成层旋转。
 * 速度、线宽、模糊、透明度都由 `--bd-*` 变量驱动，组件不感知参数。
 */
function OrbitLayer() {
  return (
    <Box className="bd-orbit">
      <span className="bd-ring bd-ring-a" />
      <span className="bd-ring bd-ring-b" />
      <span className="bd-ring bd-ring-c" />
      <span className="bd-ring bd-ring-d" />
      <span className="bd-track bd-track-a">
        <i className="bd-node" />
      </span>
      <span className="bd-track bd-track-b">
        <i className="bd-node bd-node-sm" />
      </span>
      <span className="bd-track bd-track-c">
        <i className="bd-sat bd-sat-a" />
        <i className="bd-sat bd-sat-b" />
        <i className="bd-sat bd-sat-c" />
      </span>
      <span className="bd-cross bd-cross-v" />
      <span className="bd-cross bd-cross-h" />
    </Box>
  )
}

interface Star {
  x: number
  y: number
  r: number
  phase: number
  speed: number
  alpha: number
}

/** 确定性伪随机（同一屏刷新不会「换一片星空」）。 */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeStars(width: number, height: number, count: number): Star[] {
  const rand = mulberry32(20261116)
  const stars: Star[] = []
  for (let i = 0; i < count; i += 1) {
    stars.push({
      x: rand() * width,
      y: rand() * height,
      r: 0.6 + rand() * 1.3,
      phase: rand() * Math.PI * 2,
      speed: 0.6 + rand() * 1.6,
      alpha: 0.35 + rand() * 0.5,
    })
  }
  return stars
}

/** 近邻连线只算一次（星点不动），避免每帧 O(n²)。 */
function makeLinks(stars: Star[], maxDist: number): Array<[number, number]> {
  const links: Array<[number, number]> = []
  for (let i = 0; i < stars.length; i += 1) {
    for (let j = i + 1; j < stars.length; j += 1) {
      const dx = stars[i].x - stars[j].x
      const dy = stars[i].y - stars[j].y
      if (dx * dx + dy * dy <= maxDist * maxDist) links.push([i, j])
    }
  }
  return links
}

/** 2D value noise（自写，避免为一个底纹引入 simplex-noise 依赖）。 */
function hash2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453
  return n - Math.floor(n)
}

function noise2(x: number, y: number): number {
  const xi = Math.floor(x)
  const yi = Math.floor(y)
  const xf = x - xi
  const yf = y - yi
  const u = xf * xf * (3 - 2 * xf)
  const v = yf * yf * (3 - 2 * yf)
  const a = hash2(xi, yi)
  const b = hash2(xi + 1, yi)
  const c = hash2(xi, yi + 1)
  const d = hash2(xi + 1, yi + 1)
  return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v
}

function fbm(x: number, y: number): number {
  let sum = 0
  let amp = 0.5
  let freq = 1
  for (let i = 0; i < 3; i += 1) {
    sum += amp * noise2(x * freq, y * freq)
    freq *= 2
    amp *= 0.5
  }
  return sum
}

/**
 * Canvas 层：`starfield` 与 `terrain` 共用同一套尺寸 / 主题 / 可见性管理。
 *
 * - 尺寸：DPR 上限 1.5（再高对 1px 星点没有收益，只增加填充率）；
 * - 主题：`MutationObserver` 监听 `data-theme`，换深浅色时重取令牌并重画；
 * - 可见性：`visibilitychange` 暂停星野帧循环（后台标签页不烧电）；
 * - 参数：速度 = 0 或减弱动效时**不启动** rAF；强度变化只重画一帧，不重建画布。
 */
function CanvasLayer({ mode, params }: { mode: 'starfield' | 'terrain'; params: BackdropParams }) {
  const ref = useRef<HTMLCanvasElement | null>(null)
  const paramsRef = useRef(params)
  paramsRef.current = params

  /** 暴露给参数变化用的轻量控制器（避免每次拖动都重建画布与监听器）。 */
  const ctrl = useRef<{ redraw: () => void; sync: () => void } | null>(null)

  useEffect(() => {
    ctrl.current?.sync()
  }, [params.speed])

  useEffect(() => {
    ctrl.current?.redraw()
  }, [params.intensity])

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const ctx = canvas.getContext('2d', { alpha: true })
    if (!ctx) return

    let colors = readBackdropColors()
    let stars: Star[] = []
    let links: Array<[number, number]> = []
    let linkDist = 130
    let raf = 0
    let lastFrame = 0
    let disposed = false
    let reduce = prefersReducedMotion()

    const drawStatic = () => {
      const w = window.innerWidth
      const h = window.innerHeight
      if (mode === 'terrain') {
        drawTerrain(ctx, w, h, colors)
        return
      }
      drawStars(ctx, stars, links, colors, 0, 0)
    }

    const fit = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
      const w = window.innerWidth
      const h = window.innerHeight
      canvas.width = Math.max(1, Math.round(w * dpr))
      canvas.height = Math.max(1, Math.round(h * dpr))
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      colors = readBackdropColors()
      if (mode === 'starfield') {
        // 面积取样：屏幕越大星点越多，但有上下限，窄屏也不至于稀疏
        const count = Math.max(30, Math.min(110, Math.round((w * h) / 18000)))
        stars = makeStars(w, h, count)
        linkDist = Math.max(96, Math.min(148, w * 0.11))
        links = makeLinks(stars, linkDist)
      }
      drawStatic()
    }

    const stop = () => {
      if (raf) cancelAnimationFrame(raf)
      raf = 0
    }

    const tick = (now: number) => {
      if (disposed) return
      raf = requestAnimationFrame(tick)
      // 后台标签页 / 弹窗遮挡时停笔：回来时时间戳自然跳跃，不需要补帧
      if (document.hidden) return
      if (now - lastFrame < 33) return
      lastFrame = now
      drawStars(ctx, stars, links, colors, now, paramsRef.current.speed)
    }

    /** 按「主题类型 / 减弱动效 / 速度」决定是跑帧还是只画一帧。 */
    const sync = () => {
      stop()
      if (mode === 'terrain' || reduce || paramsRef.current.speed <= 0) {
        colors = readBackdropColors()
        drawStatic()
        return
      }
      raf = requestAnimationFrame(tick)
    }

    const redraw = () => {
      colors = readBackdropColors()
      drawStatic()
    }

    const onVisibility = () => {
      if (document.hidden) stop()
      else sync()
    }

    // 深浅色切换：重取令牌后重画（星野的帧循环继续用新颜色）
    const observer = new MutationObserver(() => {
      colors = readBackdropColors()
      drawStatic()
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })

    const onReducedChange = () => {
      reduce = prefersReducedMotion()
      sync()
    }
    const mq = window.matchMedia?.(REDUCED_QUERY)
    mq?.addEventListener?.('change', onReducedChange)

    let resizeRaf = 0
    const onResize = () => {
      if (resizeRaf) return
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0
        fit()
      })
    }

    ctrl.current = { redraw, sync }
    fit()
    sync()
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      disposed = true
      ctrl.current = null
      stop()
      if (resizeRaf) cancelAnimationFrame(resizeRaf)
      observer.disconnect()
      mq?.removeEventListener?.('change', onReducedChange)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [mode])

  return <canvas ref={ref} className={`bd-canvas bd-canvas-${mode}`} />
}

function drawStars(
  ctx: CanvasRenderingContext2D,
  stars: Star[],
  links: Array<[number, number]>,
  colors: ReturnType<typeof readBackdropColors>,
  now: number,
  speed: number,
): void {
  const w = window.innerWidth
  const h = window.innerHeight
  ctx.clearRect(0, 0, w, h)

  // 连线先画（压在星点下面），整批一条 path，减少状态切换
  if (links.length) {
    ctx.globalAlpha = 0.8
    ctx.strokeStyle = colors.line
    ctx.lineWidth = colors.stroke
    ctx.beginPath()
    for (const [i, j] of links) {
      ctx.moveTo(stars[i].x, stars[i].y)
      ctx.lineTo(stars[j].x, stars[j].y)
    }
    ctx.stroke()
  }

  // 速度 50 = 基线；0 已在外层停帧，这里只防御除零
  const speedFactor = Math.max(0, speed) / 50
  ctx.fillStyle = colors.dot
  for (const s of stars) {
    // 明暗呼吸：周期 8–20s，慢到不构成「闪烁」干扰
    const breath = 0.68 + 0.32 * Math.sin(now * 0.00035 * speedFactor * s.speed + s.phase)
    ctx.globalAlpha = s.alpha * breath
    ctx.beginPath()
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalAlpha = 1
}

/** 等高线：横向分层 + 噪声起伏，像一张摊开的地形图。 */
function drawTerrain(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  colors: ReturnType<typeof readBackdropColors>,
): void {
  ctx.clearRect(0, 0, w, h)
  const step = Math.max(20, h / 24)
  const rows = Math.ceil(h / step) + 2
  ctx.lineWidth = colors.stroke

  for (let row = 0; row < rows; row += 1) {
    const baseY = h * 0.06 + row * step
    ctx.beginPath()
    for (let x = -24; x <= w + 24; x += 14) {
      const n = fbm(x * 0.0017 + row * 0.13, row * 0.42) - 0.5
      const y = baseY + n * step * 2.6 + Math.sin(x * 0.0016 + row * 0.6) * step * 0.18
      if (x === -24) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    // 每 6 条挑一条用品牌色点一下，避免整片灰线太"打印机"
    ctx.strokeStyle = row % 6 === 3 ? colors.accent : colors.line
    ctx.stroke()
  }
}
