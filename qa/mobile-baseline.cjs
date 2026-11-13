// 移动端基线量测（P0-4 对照值）。只读：不改产品代码、不写库。
// 用法：node qa/mobile-baseline.cjs [baseUrl]
// 输出：outputs/qa/mobile-baseline/<date>/shots/*.png + measure-<date>.json
const { chromium } = require('playwright-core');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://localhost:4173';
const DATE = new Date().toISOString().slice(0, 10);
// 从 qa/ 上溯一级就是仓库根；写成 '../../outputs' 会跳出仓库，
// 产物落到 司凤项目/outputs/qa/... 而不是仓库内的 personal-agent/outputs/...（11-09 发现，11-10 修）
const REPO_ROOT = path.resolve(__dirname, '..');
const OUT = path.join(REPO_ROOT, 'outputs', 'qa', 'mobile-baseline', DATE);
const SHOTS = path.join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });

const PUB = process.env.UB_PUBKEY || '';
const SESSION_KEY = `workbuddy-cloud.session.${PUB}`;

const ROUTES = [
  ['home', '/'],
  ['todo', '/todo'],
  ['records', '/records'],
  ['calendar', '/calendar'],
  ['review', '/review'],
  ['mindtree', '/mindtree'],
  ['learning', '/learning-goal'],
  ['plugins', '/plugins'],
];

const VIEWPORTS = [
  ['375x667', 375, 667],
  ['390x844', 390, 844],
  ['768x1024', 768, 1024],
  // P0-4 下半增补：1200 档用于对照「桌面端信息密度不降低」（仍应是多列 + 常驻侧栏）
  ['1200x900', 1200, 900],
];

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function fakeSession() {
  return {
    accessToken: 'baseline-fake-token',
    refreshToken: 'baseline-fake-refresh',
    expiresAt: 4102444800000,
    user: { id: 'baseline-user', phone: '+86 10000000000', username: 'baseline' },
  };
}

// 页面内测量：横向溢出、主内容宽度占比、触摸目标
const measureInPage = () => {
  const vw = document.documentElement.clientWidth;
  const docScrollWidth = Math.max(
    document.documentElement.scrollWidth,
    document.body ? document.body.scrollWidth : 0
  );

  // 找出真正撑破视口的元素（右边界超出视口 > 1px，且自身不是 fixed 覆盖层）
  const offenders = [];
  const all = document.querySelectorAll('body *');
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    if (r.right > vw + 1 || r.left < -1) {
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
      const parent = el.parentElement;
      let parentOk = false;
      if (parent) {
        const pr = parent.getBoundingClientRect();
        parentOk = pr.right <= vw + 1 && pr.left >= -1;
      }
      if (!parentOk) continue; // 只记“最外层越界者”，避免祖先链刷屏
      offenders.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className && String(el.className).slice(0, 80)) || '',
        left: Math.round(r.left),
        right: Math.round(r.right),
        width: Math.round(r.width),
        text: (el.textContent || '').trim().slice(0, 40),
      });
    }
  }

  // 主内容区：优先 <main>，退化为 Outlet 容器，再退化 body
  const mainEl = document.querySelector('main') || document.querySelector('[data-main]');
  let mainWidth = 0;
  let mainSelector = 'none';
  let mainScrollOverflow = null;
  if (mainEl) {
    mainWidth = mainEl.getBoundingClientRect().width;
    mainSelector = 'main';
    // §八 第 2 项：整页 scrollWidth 恒等于 clientWidth（溢出被 main 的 overflow:auto 吞掉），
    // 必须单独量 main 内部横向溢出，否则永远是假绿灯。
    mainScrollOverflow = Math.round(mainEl.scrollWidth - mainEl.clientWidth);
  }

  // 触摸目标：可见可交互元素的实际矩形
  const sel = 'button, a[href], input:not([type="hidden"]), textarea, select, [role="button"], [role="tab"], [role="menuitem"], [contenteditable="true"]';
  const targets = [];
  for (const el of document.querySelectorAll(sel)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (r.bottom < -50 || r.top > window.innerHeight + 2000) continue;
    const label = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').trim().slice(0, 30);
    targets.push({
      tag: el.tagName.toLowerCase(),
      label,
      w: Math.round(r.width),
      h: Math.round(r.height),
      small: r.width < 44 || r.height < 44,
    });
  }
  const smallTargets = targets.filter((t) => t.small);

  // 底部导航（P0-4 下半）：存在性 / 矩形 / FAB 矩形 / 是否重叠 / 导航内触摸目标
  const navEl = document.querySelector('nav[aria-label="底部导航"]');
  let bottomNav = { hasBottomNav: false, bottomNavRect: null, fabRect: null, fabOverlapsNav: null, bottomNavSmallTargets: null };
  if (navEl) {
    const nr = navEl.getBoundingClientRect();
    const fab = document.querySelector('[aria-label="新建记录"]');
    const fr = fab ? fab.getBoundingClientRect() : null;
    const overlaps = fr
      ? !(fr.bottom <= nr.top || fr.top >= nr.bottom || fr.right <= nr.left || fr.left >= nr.right)
      : null;
    const navSmall = [...navEl.querySelectorAll('button, [role="button"]')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
    }).length;
    bottomNav = {
      hasBottomNav: true,
      bottomNavRect: { top: Math.round(nr.top), bottom: Math.round(nr.bottom), height: Math.round(nr.height) },
      fabRect: fr ? { top: Math.round(fr.top), bottom: Math.round(fr.bottom), left: Math.round(fr.left), width: Math.round(fr.width), height: Math.round(fr.height) } : null,
      fabOverlapsNav: overlaps,
      bottomNavSmallTargets: navSmall,
    };
  }

  return {
    viewportWidth: vw,
    docScrollWidth,
    horizontalOverflow: docScrollWidth - vw,
    offenders: offenders.slice(0, 8),
    offenderCount: offenders.length,
    mainSelector,
    mainWidth: Math.round(mainWidth),
    mainRatio: mainWidth ? +(mainWidth / vw).toFixed(3) : null,
    mainScrollOverflow,
    targetCount: targets.length,
    smallTargetCount: smallTargets.length,
    smallTargets: smallTargets.slice(0, 10),
    ...bottomNav,
  };
};

(async () => {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });

  const results = [];
  for (const [vpName, w, h] of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: w, height: h },
      deviceScaleFactor: 2,
      isMobile: w < 700,
      hasTouch: w < 700,
      userAgent: w < 700
        ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
        : undefined,
      locale: 'zh-CN',
    });
    await ctx.addInitScript(
      ([key, sess]) => {
        try { window.localStorage.setItem(key, JSON.stringify(sess)); } catch { /* ignore */ }
      },
      [SESSION_KEY, fakeSession()]
    );

    const page = await ctx.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push('PAGEERROR ' + String(e.message).slice(0, 160)));

    for (const [name, route] of ROUTES) {
      errs.length = 0;
      let m = null;
      let navError = '';
      try {
        await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // 等壳层真正挂载（<main>）而不是死等固定毫秒：启动要过一次会话校验，
        // 网络快时 1s 就绪、慢时要 6~8s；原来的固定 2500ms 会量到「正在加载…」的启动屏，
        // 拿到一堆 main=null 的假数据。超时仍拿不到就继续（记录会在 JSON 里体现为空）。
        await page.waitForSelector('main', { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(600);
        m = await page.evaluate(measureInPage);
      } catch (e) {
        navError = String(e.message).slice(0, 200);
      }
      const shot = path.join(SHOTS, `${vpName}__${name}.png`);
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      const landed = page.url();
      results.push({
        viewport: vpName,
        route,
        name,
        landedUrl: landed,
        redirectedToLogin: /\/login/.test(landed),
        navError,
        jsErrors: errs.slice(0, 5),
        ...(m || {}),
        shot: path.relative(REPO_ROOT, shot).replace(/\\/g, '/'),
      });
      process.stdout.write(
        `[mobile-baseline] ${vpName} ${name} overflow=${m ? m.horizontalOverflow : 'n/a'} mainOverflow=${m ? m.mainScrollOverflow : 'n/a'} ratio=${m ? m.mainRatio : 'n/a'} small=${m ? m.smallTargetCount : 'n/a'} nav=${m && m.hasBottomNav ? 'yes' : 'no'}${m && m.fabOverlapsNav ? ' FAB-OVERLAP' : ''}\n`
      );
    }
    await ctx.close();
  }

  await browser.close();
  const payload = { date: DATE, base: BASE, sessionKeyMasked: SESSION_KEY.replace(/(wbpk_)[A-Za-z0-9]+/, '$1***'), results };
  const outFile = path.join(OUT, `measure-${DATE}.json`);
  writeFileSync(outFile, JSON.stringify(payload, null, 2), 'utf-8');
  process.stdout.write(`[mobile-baseline] written ${outFile}\n`);
})();
