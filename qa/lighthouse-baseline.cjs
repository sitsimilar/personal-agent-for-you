// Lighthouse 基线（含登录态）：单进程内 拉起 Edge → 注入会话 → 跑 LH → 关浏览器。
// 用法：UB_PUBKEY=xxx node qa/lighthouse-baseline.cjs <baseUrl> <route> <outJson>
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const { mkdtempSync } = require('node:fs');
const os = require('node:os');
const { chromium } = require('playwright-core');

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
const ROUTE = process.argv[3] || '/todo';
const OUT = path.resolve(process.argv[4] || 'outputs/qa/lighthouse/2026-10-30.json');
const PUB = process.env.UB_PUBKEY || '';
const SESSION_KEY = `workbuddy-cloud.session.${PUB}`;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 9333;

const sess = {
  accessToken: 'baseline-fake-token',
  refreshToken: 'baseline-fake-refresh',
  expiresAt: 4102444800000,
  user: { id: 'baseline-user', phone: '+86 10000000000', username: 'baseline' },
};

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

async function waitCdp(deadlineMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadlineMs) {
    try { return await getJson(`http://127.0.0.1:${PORT}/json/version`); } catch { await new Promise((r) => setTimeout(r, 400)); }
  }
  throw new Error('CDP 未就绪');
}

(async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'ub-lh-'));
  const edge = spawn(EDGE, [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--no-sandbox', '--disable-gpu',
    'about:blank',
  ], { stdio: 'ignore', detached: false });

  try {
    const ver = await waitCdp();
    process.stdout.write(`[lh] cdp ready ${ver.Browser}\n`);

    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const ctx = browser.contexts()[0];
    const page = await ctx.newPage();
    await page.goto(BASE + ROUTE, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(([k, s]) => localStorage.setItem(k, JSON.stringify(s)), [SESSION_KEY, sess]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    const sealed = await page.evaluate(() => ({
      path: location.pathname,
      mains: document.querySelectorAll('main').length,
      loginForm: !!document.querySelector('input[type="tel"]'),
    }));
    process.stdout.write(`[lh] seeded ${JSON.stringify(sealed)}\n`);
    await page.close();
    await browser.close();

    const args = [
      '--yes', 'lighthouse', BASE + ROUTE,
      `--port=${PORT}`,
      '--only-categories=accessibility,performance',
      '--output=json', `--output-path=${OUT}`,
      '--chrome-flags=--no-sandbox --headless=new',
      '--quiet',
    ];
    const lh = spawn('npx', args, { stdio: ['ignore', 'pipe', 'pipe'], shell: true });
    let err = '';
    lh.stderr.on('data', (d) => (err += d.toString()));
    const code = await new Promise((r) => lh.on('close', r));
    process.stdout.write(`[lh] lighthouse exit=${code}${err ? ' stderr=' + err.slice(0, 200) : ''}\n`);
  } finally {
    try { edge.kill('SIGKILL'); } catch { /* ignore */ }
  }
})();
