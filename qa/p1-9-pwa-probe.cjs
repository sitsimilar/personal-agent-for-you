// PWA 离线壳探针（P1-9）。只读：不改产品代码、不写库。
// 用法：先 `cd web && npx vite build`（或 npm run build:web），再
//        node server.js 起在 4199（本脚本自己起），最后 node qa/p1-9-pwa-probe.cjs
// 为什么用 127.0.0.1：Service Worker 只在安全上下文注册，http://127.0.0.1 与 localhost 例外，
// 换成局域网 IP（如 192.168.x.x）会静默拿不到 navigator.serviceWorker。
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { readdirSync } = require('node:fs');
const path = require('node:path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.PWA_PROBE_PORT || 4199);
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(__dirname, '..');

function waitFor(url, timeoutMs = 20000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const res = await fetch(url);
        if (res.ok) return resolve(true);
      } catch {
        /* 还没起来 */
      }
      if (Date.now() - started > timeoutMs) return reject(new Error(`timeout waiting ${url}`));
      setTimeout(tick, 300);
    };
    tick();
  });
}

async function main() {
  const server = spawn(process.execPath, [path.join(REPO_ROOT, 'server.js')], {
    cwd: REPO_ROOT,
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore',
  });
  const out = { checks: {}, notes: [] };
  try {
    await waitFor(`${BASE}/version.json`);

    const browser = await chromium.launch({
      executablePath: EDGE,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    // 启动壳里任何未捕获异常都算回归（离线壳最怕「白屏但没报错」）
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

    await page.goto(`${BASE}/`, { waitUntil: 'load' });

    // 1. manifest 必须被注入且可访问
    const manifestHref = await page.getAttribute('link[rel="manifest"]', 'href');
    out.checks.manifestLinked = Boolean(manifestHref);
    const manifestRes = await page.request.get(`${BASE}${manifestHref || '/manifest.webmanifest'}`);
    const manifest = await manifestRes.json().catch(() => ({}));
    out.checks.manifestStatus = manifestRes.status();
    out.checks.manifestDisplay = manifest.display || null;
    out.checks.manifestTheme = manifest.theme_color || null;

    // 2. SW 注册并接管。`ready` 只保证「有激活的 SW」，首次安装时状态可能还在 activating，
    //    必须再等状态收敛，否则会误报失败（首轮 5 项红就是这么来的）。
    const swReady = await page
      .evaluate(async () => {
        if (!('serviceWorker' in navigator)) return { supported: false };
        const reg = await navigator.serviceWorker.ready.catch(() => null);
        if (!reg) return { supported: true, state: 'missing' };
        const waitActivated = (worker, timeoutMs = 10000) => {
          if (!worker) return Promise.resolve('missing');
          if (worker.state === 'activated') return Promise.resolve(worker.state);
          return new Promise((resolve) => {
            const timer = setTimeout(() => resolve(worker.state), timeoutMs);
            worker.addEventListener('statechange', () => {
              if (worker.state === 'activated') {
                clearTimeout(timer);
                resolve(worker.state);
              }
            });
          });
        };
        const state = await waitActivated(reg.active || reg.installing || reg.waiting);
        return { supported: true, scope: reg.scope, state, scriptURL: reg.active && reg.active.scriptURL };
      })
      .catch((e) => ({ error: String(e) }));
    out.checks.sw = swReady;

    // 3. Cache Storage：不得有 .cloud / api 条目；条目总数不得超 25
    await page.waitForTimeout(1500);
    const cacheInfo = await page
      .evaluate(async () => {
        const names = await caches.keys();
        const urls = [];
        for (const n of names) {
          const cache = await caches.open(n);
          for (const req of await cache.keys()) urls.push(req.url);
        }
        return { names, urls, total: urls.length };
      })
      .catch((e) => ({ error: String(e) }));
    out.checks.caches = cacheInfo;
    const urls = cacheInfo.urls || [];
    out.checks.noCloudEntries = !urls.some((u) => u.includes('.cloud'));
    out.checks.noApiEntries = !urls.some((u) => /\/api\//.test(u));
    out.checks.noWelcomeEntries = !urls.some((u) => u.includes('/welcome'));
    out.checks.entryCountOk = (cacheInfo.total || 0) <= 25;

    // 4. 断网重进：应用壳必须还能渲染（有 #root 内容 / 标题还在）
    await context.setOffline(true);
    let offlineShell = { ok: false };
    try {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      const state = await page.evaluate(() => ({
        hasRoot: !!document.getElementById('root'),
        rootChars: (document.getElementById('root')?.textContent || '').length,
        title: document.title,
        controlled: !!navigator.serviceWorker.controller,
      }));
      offlineShell = { ok: !!state.hasRoot, ...state };
    } catch (e) {
      offlineShell = { ok: false, error: String(e) };
    }
    out.checks.offlineShell = offlineShell;
    await context.setOffline(false);

    // 5. /welcome/ 不被导航回退吞掉：断网时它应该失败或不返回应用壳
    const welcomeRes = await page.request.get(`${BASE}/welcome/`);
    out.checks.welcome = { status: welcomeRes.status(), contentType: welcomeRes.headers()['content-type'] || '' };

    // 6. 离线库真机路径（Node 里没有 IndexedDB，只能在浏览器里验）：
    //    写入 → 计数 → 按时间倒序读 → 500 上限淘汰 → 清空。
    //    为什么直接 import 构建产物：走产品同一份编译后的代码，不是另写一份等价实现。
    const chunk = readdirSync(path.join(REPO_ROOT, 'web', 'dist', 'assets')).find(
      (f) => f.startsWith('offline-db-') && f.endsWith('.js'),
    );
    if (chunk) {
      out.checks.offlineDb = await page.evaluate(async (file) => {
        const m = await import(`/assets/${file}`);
        const mk = (id, day) => ({
          id,
          type: 'idea',
          title: `记录${id}`,
          content: '正'.repeat(300),
          tags: [],
          isDeleted: false,
          createdAt: new Date(Date.UTC(2026, 4, day)).toISOString(),
          updatedAt: new Date(Date.UTC(2026, 4, day)).toISOString(),
        });
        await m.clearOfflineCache();
        await m.cacheRecords([mk(1, 1), mk(2, 2), mk(3, 3)]);
        const small = await m.readCachedRecords(2);
        const countSmall = await m.countCachedRecords();
        // 500 上限：再灌 520 条，最终应为 500
        const bulk = Array.from({ length: 520 }, (_, i) => mk(1000 + i, 1 + (i % 28)));
        await m.cacheRecords(bulk);
        const countBulk = await m.countCachedRecords();
        await m.clearOfflineCache();
        const afterClear = await m.countCachedRecords();
        return {
          countSmall,
          newestTitle: small.rows[0]?.title,
          rows: small.rows.length,
          snippetLen: small.rows[0]?.snippet.length || 0,
          countBulk,
          afterClear,
        };
      }, chunk);
    }

    await browser.close();
    out.checks.pageErrors = pageErrors;
  } finally {
    server.kill();
  }

  const db = out.checks.offlineDb || {};
  const pass =
    out.checks.manifestLinked &&
    out.checks.manifestDisplay === 'standalone' &&
    out.checks.manifestTheme === '#5B54D9' &&
    out.checks.sw &&
    out.checks.sw.state === 'activated' &&
    out.checks.noCloudEntries &&
    out.checks.noApiEntries &&
    out.checks.noWelcomeEntries &&
    out.checks.entryCountOk &&
    out.checks.offlineShell &&
    out.checks.offlineShell.ok &&
    db.countSmall === 3 &&
    db.newestTitle === '记录3' &&
    db.rows === 2 &&
    db.snippetLen === 121 &&
    db.countBulk === 500 &&
    db.afterClear === 0 &&
    (out.checks.pageErrors || []).length === 0;
  console.log(JSON.stringify({ pass, ...out }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(2);
});
