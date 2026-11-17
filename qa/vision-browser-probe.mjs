/**
 * 机器视觉 · 浏览器编码探针（真实管线，不是模拟）
 * ============================================================================
 * 为什么要用浏览器：
 * 体积压缩率、canvas 编码耗时只能由真实编码器给出。Node 里没有 JPEG/WebP 编码器，
 * 用"理论压缩比"估算等于编数据。这里用 esbuild 把生产代码打成 IIFE，
 * 在无头 Edge 里生成 3 张合成截图并跑 `prepareVisionInput`，拿真实字节数。
 *
 * 为什么用 --dump-dom 而不是 CDP：
 * 免装 puppeteer/ws，只依赖系统自带 Edge；`--virtual-time-budget` 给出足够时间让
 * Promise 跑完，脚本把结果写进 DOM，再从 stdout 里抠 JSON。
 *
 * 运行：node qa/vision-browser-probe.mjs
 * 产出：outputs/qa/vision/encode-probe-YYYY-MM-DD.json
 */

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, '..', 'outputs', 'qa', 'vision')
mkdirSync(outDir, { recursive: true })

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
const esbuild = require(resolve(root, 'web', 'node_modules', 'esbuild', 'lib', 'main.js'))

// ---- 1. 把生产管线打成 IIFE（只打 pipeline，避免牵连 @shared 别名）----
const bundlePath = resolve(outDir, 'vision-pipeline.iife.js')
esbuild.buildSync({
  entryPoints: [resolve(root, 'web', 'src', 'lib', 'vision', 'pipeline.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'VisionPipeline',
  target: 'chrome110',
  outfile: bundlePath,
  logLevel: 'silent',
})

// ---- 2. 生成探针页面 ----
const html = `<!doctype html>
<meta charset="utf-8" />
<body>
<pre id="out">PENDING</pre>
<script src="vision-pipeline.iife.js"></script>
<script>
// 任何未捕获错误都写进 #out，否则页面停在 PENDING 时无法定位原因。
window.onerror = function (msg, src, line) {
  finished = true;
  document.getElementById('out').textContent = 'zzVBEG' + 'INzz' + JSON.stringify([
    { name: 'javascript-error', ok: false, error: msg + ' @' + line },
  ]) + 'zzVE' + 'NDzz';
};
window.addEventListener('unhandledrejection', function (e) {
  finished = true;
  document.getElementById('out').textContent = 'zzVBEG' + 'INzz' + JSON.stringify([
    { name: 'unhandled-rejection', ok: false, error: String(e.reason && e.reason.stack || e.reason) },
  ]) + 'zzVE' + 'NDzz';
});
/** 在 canvas 上画一张"代码截图"（真实文本，产生真实熵）。 */
function codeShot(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#1e2028'; x.fillRect(0, 0, w, h);
  const fs = Math.round(h / 34);
  x.font = fs + 'px Consolas, monospace';
  const colors = ['#c586c0', '#98c379', '#abb2bf', '#e5c07b', '#61afef'];
  for (let i = 0, y = fs * 2; y < h - fs; i++, y += Math.round(fs * 1.5)) {
    let px = fs;
    for (let j = 0; px < w - fs * 2; j++) {
      const s = ['const', 'value', '=', 'compute(', 'index', ')', 'return', 'result'][(i + j) % 8];
      x.fillStyle = colors[(i * 3 + j) % colors.length];
      x.fillText(s, px, y);
      px += x.measureText(s + ' ').width;
    }
  }
  return c;
}
/** 画一张"界面截图"。 */
function uiShot(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.fillStyle = '#f6f7f9'; x.fillRect(0, 0, w, h);
  x.fillStyle = '#fff'; x.fillRect(0, 0, w, h * 0.07);
  x.fillStyle = '#5b54d9'; x.fillRect(w * 0.03, h * 0.02, w * 0.08, h * 0.03);
  for (let i = 0; i < 6; i++) {
    x.fillStyle = '#fff';
    x.fillRect(w * 0.03, h * (0.12 + i * 0.14), w * 0.94, h * 0.11);
    x.fillStyle = '#3c4046';
    x.fillRect(w * 0.05, h * (0.145 + i * 0.14), w * 0.3, h * 0.012);
    x.fillStyle = '#8c9198';
    x.fillRect(w * 0.05, h * (0.17 + i * 0.14), w * 0.6, h * 0.01);
  }
  return c;
}
/** 画一张"照片"（渐变 + 噪声）。 */
function photoShot(w, h) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#2b3a67'); g.addColorStop(0.5, '#c06c4a'); g.addColorStop(1, '#f2d7a0');
  x.fillStyle = g; x.fillRect(0, 0, w, h);
  const img = x.getImageData(0, 0, w, h);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 38;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  x.putImageData(img, 0, 0);
  return c;
}

const CASES = [
  { name: '代码 4K', make: codeShot, w: 3840, h: 2160 },
  { name: '界面 2K', make: uiShot, w: 2560, h: 1440 },
  { name: '照片 12MP', make: photoShot, w: 3024, h: 4032 },
];

// --virtual-time-budget 只有在"有挂起的定时器"时才会推进虚拟时钟；
// 纯 Promise/canvas 回调链会让时钟立刻走完、直接 dump，因此这里挂一个心跳保活。
let finished = false;
(function keepAlive() {
  if (!finished) setTimeout(keepAlive, 4);
})();

(async () => {
  const results = [];
  for (const cs of CASES) {
    const canvas = cs.make(cs.w, cs.h);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
    const file = new File([blob], cs.name + '.png', { type: 'image/png' });
    const t0 = performance.now();
    let row = { name: cs.name, srcW: cs.w, srcH: cs.h, pngBytes: blob.size };
    try {
      const { bundle } = await VisionPipeline.prepareVisionInput([file]);
      const img = bundle.images[0];
      row = Object.assign(row, {
        ok: true,
        outW: img.width,
        outH: img.height,
        outBytes: img.bytes,
        format: img.plan.format,
        quality: img.plan.quality,
        scene: img.scene,
        verdict: img.quality.verdict,
        score: img.quality.score,
        issues: img.quality.issues.map((i) => i.code),
        prepMs: Math.round(performance.now() - t0),
        pipelinePrepMs: bundle.metrics.prepMs,
        deduped: bundle.metrics.deduped,
        reasons: img.plan.reasons,
        // 诊断字段：裁剪框 / 缩放系数 / 分析图尺寸，用来解释「为什么缩成这样」
        crop: img.plan.crop,
        scale: Number(img.plan.scale.toFixed(4)),
        anaW: img.features.width,
        anaH: img.features.height,
        sto: Number(img.features.scaleToOriginal.toFixed(3)),
        // 完整特征（诊断分类误判时最有用；四舍五入到 4 位，够用又不刷屏）
        feat: Object.fromEntries(
          Object.entries(img.features).map(([k, v]) => [
            k,
            typeof v === 'number' ? Number(v.toFixed(4)) : v,
          ]),
        ),
      });
    } catch (e) {
      row = Object.assign(row, { ok: false, error: String(e && e.message || e) });
    }
    results.push(row);
  }
  // 标记用拼接方式生成：源码里不存在连续的完整标记，避免正则匹配到脚本源码本身。
  finished = true;
  const A = 'zzVBEG' + 'INzz';
  const B = 'zzVE' + 'NDzz';
  document.getElementById('out').textContent = A + JSON.stringify(results) + B;
})();
</script>
</body>`

const htmlPath = resolve(outDir, 'probe.html')
writeFileSync(htmlPath, html, 'utf-8')

// ---- 3. 用 CDP 驱动无头 Edge ----
// 为什么不用 --dump-dom：它的 --virtual-time-budget 靠虚拟时钟推进，一旦页面在跑
// 重负载（12MP 噪点、4K PNG 编码），虚拟时钟会被提前耗完，dump 出来的还是 PENDING；
// 而且虚拟时间会让 performance.now() 失真。CDP 用真实时钟轮询，耗时可采信。
const htmlUrl = 'file:///' + htmlPath.replace(/\\/g, '/')
const profileDir = mkdtempSync(join(tmpdir(), 'vision-probe-'))
const edge = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--allow-file-access-from-files',
    '--disable-extensions',
    // 每个探针用独立 profile，避免复用上一个实例的进程/缓存（否则 createTarget 会打到旧实例）
    `--user-data-dir=${profileDir}`,
    '--remote-debugging-port=0',
    'about:blank',
  ],
  { stdio: 'ignore' },
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 等 DevToolsActivePort 出现（端口由浏览器随机分配后写在该文件里）。 */
async function waitForDevTools(dir, timeoutMs) {
  const file = join(dir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const lines = readFileSync(file, 'utf-8').trim().split(/\r?\n/)
      if (lines.length >= 2) return { port: Number(lines[0]), wsPath: lines[1] }
    }
    await sleep(120)
  }
  throw new Error('Edge 未在 ' + timeoutMs + 'ms 内打开调试端口')
}

/** 极简 CDP 客户端：按 id 配对请求/响应，支持 flatten 模式的 sessionId。 */
function connectCdp(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let seq = 0
    ws.addEventListener('message', (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      const slot = pending.get(msg.id)
      if (!slot) return
      pending.delete(msg.id)
      if (msg.error) slot.rej(new Error(msg.error.message))
      else slot.res(msg.result)
    })
    ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连接失败')))
    ws.addEventListener('open', () =>
      res({
        send(method, params, sessionId) {
          const id = ++seq
          return new Promise((rs, rj) => {
            pending.set(id, { res: rs, rej: rj })
            ws.send(JSON.stringify({ id, method, params: params || {}, sessionId }))
          })
        },
        close: () => ws.close(),
      }),
    )
  })
}

let results
try {
  const { port, wsPath } = await waitForDevTools(profileDir, 20_000)
  const cdp = await connectCdp(`ws://127.0.0.1:${port}${wsPath}`)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Page.navigate', { url: htmlUrl }, sessionId)

  // 轮询页面输出，直到出现完整标记；120s 上限（4K/12MP 编码在 CI 机器上留足余量）。
  const deadline = Date.now() + 120_000
  let text = ''
  while (Date.now() < deadline) {
    await sleep(300)
    try {
      const r = await cdp.send(
        'Runtime.evaluate',
        {
          expression: 'document.getElementById("out").textContent',
          returnByValue: true,
        },
        sessionId,
      )
      text = (r.result && r.result.value) || ''
    } catch {
      // 页面还在导航，上下文未就绪，下一轮再试
      continue
    }
    if (text.includes('zzVENDzz')) break
  }
  cdp.close()

  const m = text.match(/zzVBEGINzz([\s\S]*?)zzVENDzz/)
  if (!m) {
    throw new Error('页面未产出结果，最后内容：' + text.slice(0, 300))
  }
  results = JSON.parse(m[1])
} catch (err) {
  console.error('CDP 探针失败：', err.message)
  process.exit(1)
} finally {
  // 清理是尽力而为：Edge 退出前可能还占着 profile 里的 Crashpad 文件（Windows 上会 EBUSY）。
  edge.kill()
  await sleep(600)
  try {
    rmSync(profileDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 })
  } catch {
    /* 临时目录残留不影响结论，系统会自行回收 */
  }
}


// ---- 4. 汇总并落盘 ----
const date = new Date().toISOString().slice(0, 10)
const payload = { date, engine: 'msedge headless(new) + CDP(Runtime.evaluate)', cases: results }
const file = resolve(outDir, `encode-probe-${date}.json`)
writeFileSync(file, JSON.stringify(payload, null, 2), 'utf-8')

const kb = (n) => (n / 1024).toFixed(0) + 'KB'
const pct = (a, b) => ((a / b) * 100).toFixed(1) + '%'
console.log('样本        原图          原体积    送入尺寸        送入体积   压缩到   编码      预处理ms  场景/质量')
for (const r of results) {
  if (!r.ok) {
    console.log(r.name, 'FAILED', r.error)
    continue
  }
  console.log(
    r.name.padEnd(12),
    `${r.srcW}×${r.srcH}`.padEnd(13),
    kb(r.pngBytes).padEnd(9),
    `${r.outW}×${r.outH}`.padEnd(15),
    kb(r.outBytes).padEnd(10),
    pct(r.outBytes, r.pngBytes).padEnd(8),
    String(r.format).replace('image/', '').padEnd(9),
    String(r.prepMs).padEnd(9),
    `${r.scene}/${r.verdict}${r.issues.length ? '(' + r.issues.join(',') + ')' : ''}`,
  )
}
console.log('\n已写入', file)
