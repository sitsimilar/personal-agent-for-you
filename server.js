// 个人信息管家 · 部署用极简静态服务器（纯 Node，无第三方依赖）
// 职责：确保 web/dist 已构建，然后用 Node 原生 http 服务 web/dist，带 SPA 回退。
// 依赖安装已在部署的 installCmd 阶段完成；此处仅在 dist 缺失时兜底构建。
const { execSync } = require('child_process')
const http = require('http')
const fs = require('fs')
const path = require('path')
const { handleLinkPreview } = require('./server/link-preview')
const { handleFeedFetch } = require('./server/feed-fetch')

const root = __dirname
const webDir = path.join(root, 'web')
const distDir = path.join(webDir, 'dist')

// 当前部署版本号（根 package.json 的 version），用于 /version.json 更新源端点。
const appVersion = (() => {
  try {
    return require(path.join(root, 'package.json')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

// 若尚未构建则先构建（依赖已安装；用 vite build 跳过 tsc 类型检查，避免沙箱残留孤儿文件报错）
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  try {
    execSync('./node_modules/.bin/vite build', { cwd: webDir, stdio: 'inherit' })
  } catch (e) {
    console.error('web build failed:', e && e.message ? e.message : e)
    process.exit(1)
  }
}

const PORT = Number(process.env.PORT) || 3000

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json',
}

http
  .createServer((req, res) => {
    // 链接元数据代理（P0-C）：必须在静态托管/SPA 回退**之前**判定，
    // 且只用 pathname 匹配（不能先 decodeURIComponent，避免把 %2F 变成路径分隔符）。
    let apiPath = ''
    try {
      apiPath = new URL(req.url || '/', 'http://x').pathname
    } catch {
      apiPath = ''
    }
    if (apiPath === '/api/link-preview') {
      handleLinkPreview(req, res)
      return
    }
    // 订阅抓取代理（P0-3）：同样必须在静态托管之前判定，原因与 link-preview 一致
    // （跨域 + 条件请求头都要服务端代发）。
    if (apiPath === '/api/feed-fetch') {
      handleFeedFetch(req, res)
      return
    }

    let urlPath
    try {
      urlPath = decodeURIComponent((req.url || '/').split('?')[0])
    } catch {
      urlPath = '/'
    }
    if (urlPath === '/') urlPath = '/index.html'
    // 官网宣传页挂在同域 /welcome/（构建时由 web/public/welcome 原样拷入 dist）
    if (urlPath === '/welcome') urlPath = '/welcome/index.html'

    // 更新源端点：返回当前部署版本号（供客户端更新检测比较）
    if (urlPath === '/version.json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      })
      res.end(JSON.stringify({ version: appVersion }))
      return
    }

    let file = path.join(distDir, urlPath)
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      // /welcome/ 下缺失的文件回落到宣传页自身，不要串进应用外壳
      file = urlPath === '/welcome/index.html' || urlPath.startsWith('/welcome/')
        ? path.join(distDir, 'welcome', 'index.html')
        : path.join(distDir, 'index.html') // SPA 回退
    }
    const ext = path.extname(file).toLowerCase()
    const type = MIME[ext] || 'application/octet-stream'
    const size = fs.statSync(file).size
    // html 每次回源校验，其余静态资源（含 vite 带 hash 的产物）缓存一天。
    // PWA（P1-9）：sw.js 与 manifest 必须 no-cache——缓存住 sw.js 会让 autoUpdate 永远拿不到新壳，
    // 缓存住 manifest 会让改过 theme_color / 图标的旧清单长期不生效。
    const isSw = path.basename(file) === 'sw.js'
    const cache =
      ext === '.html' || isSw || ext === '.webmanifest'
        ? 'no-cache'
        : 'public, max-age=86400'

    // Range 支持：宣传片的 mp4 走这里。缺了它 iOS Safari 会直接拒绝播放，
    // 桌面 Chrome 能播但进度条拖不动（每次都从 0 重下）。
    const range = req.headers.range
    if (range && size) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim())
      if (m) {
        let start
        let end
        if (m[1] === '') {
          const n = parseInt(m[2], 10) || 0
          start = Math.max(0, size - n)
          end = size - 1
        } else {
          start = parseInt(m[1], 10)
          end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1)
        }
        if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + size })
          res.end()
          return
        }
        res.writeHead(206, {
          'Content-Type': type,
          'Content-Range': 'bytes ' + start + '-' + end + '/' + size,
          'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': cache,
        })
        fs.createReadStream(file, { start, end }).pipe(res)
        return
      }
    }

    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cache,
    })
    fs.createReadStream(file).pipe(res)
  })
  .listen(PORT, '0.0.0.0', () => {
    console.log('personal-agent serving on 0.0.0.0:' + PORT)
  })
