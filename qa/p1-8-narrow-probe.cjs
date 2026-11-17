// P1-8 上半探针：窄屏单列列表 / 宽屏多列卡片 + 375 档无横向溢出。
// 只读：不改产品代码、不写库。用法：
//   cd web && npx vite build   （或 npm run build:web）
//   node qa/p1-8-narrow-probe.cjs
//
// 为什么要拦网络：记录列表要真数据才画得出来，而探针不能碰真库。
// 这里用 playwright 的 route 直接 fulfill `/.cloud/database/rest/records`，
// 返回 20 行固定假数据 + `content-range` 头（SDK 靠它算 total）。
// 其余 `.cloud` 请求一律回空数组，避免启动期的账号/设置请求把页面卡在骨架。
const { chromium } = require('playwright-core');
const { spawn } = require('node:child_process');
const { readFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = Number(process.env.P18_PROBE_PORT || 4198);
const BASE = `http://127.0.0.1:${PORT}`;
const REPO_ROOT = path.resolve(__dirname, '..');
/** 截图落仓库内 outputs（与 mobile-baseline 同约定），11-19 走查可直接对照。 */
const SHOTS = path.join(REPO_ROOT, 'outputs', 'qa', 'p1-8', new Date().toISOString().slice(0, 10));
mkdirSync(SHOTS, { recursive: true });

/** 从 web/.env 取 publishable key（会话 key 里要用它）；取不到就空串，页面会走“未配置”分支。 */
function readPubKey() {
  if (process.env.UB_PUBKEY) return process.env.UB_PUBKEY;
  try {
    const env = readFileSync(path.join(REPO_ROOT, 'web', '.env'), 'utf8');
    const m = env.match(/^VITE_CLOUD_PUBLISHABLE_KEY=(.+)$/m);
    return m ? m[1].trim() : '';
  } catch {
    return '';
  }
}

const PUB = readPubKey();
const SESSION_KEY = `workbuddy-cloud.session.${PUB}`;

/**
 * 四档宽度：[标签, 宽, 高, 期望密度]。
 *
 * 599 / 600 是 P1-8 的分界（`COMPACT_LIST_MAX_WIDTH`），必须真浏览器里也一致：
 * 纯函数单测验的是判定，这里验的是**媒体查询字符串在 MUI `useMediaQuery` 里真的生效**。
 * 375 是计划写的验收档，1280 用来对照「宽屏信息密度不降」。
 */
const VIEWPORTS = [
  ['375x667', 375, 667, 'compact'],
  ['599x800', 599, 800, 'compact'],
  ['600x800', 600, 800, 'grid'],
  ['1280x900', 1280, 900, 'grid'],
];

function fakeSession() {
  return {
    accessToken: 'probe-fake-token',
    refreshToken: 'probe-fake-refresh',
    expiresAt: 4102444800000,
    user: { id: 'probe-user', phone: '+86 10000000000', username: 'probe' },
  };
}

/** 20 行假记录：标题长度刻意掺入超长串，用来验 375 档「单行省略、不撑破版心」。 */
function rows() {
  const now = Date.now();
  const long = '这是一条特别长的标题用来验证窄屏下是否会撑破版心的边界情况';
  return Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    type: i % 3 === 0 ? 'todo' : i % 3 === 1 ? 'idea' : 'material',
    title: i === 0 ? long : `探针记录 ${String(i + 1).padStart(2, '0')}`,
    content: null,
    url: null,
    file_path: null,
    category: i % 2 === 0 ? '效率工具' : null,
    tags: i % 4 === 0 ? ['标签甲', '标签乙'] : [],
    summary: i % 3 === 1 ? '摘要文本用于宽屏卡片展示，窄屏不渲染。' : null,
    todo_status: i % 3 === 0 ? (i % 6 === 0 ? 'done' : 'pending') : null,
    priority: i % 3 === 0 ? 'high' : null,
    remind_at: null,
    recurrence: null,
    recurrence_parent_id: null,
    recurrence_next_id: null,
    link_meta: null,
    someday: false,
    snoozed_until: null,
    snooze_count: 0,
    external_uid: null,
    record_meta: null,
    parent_id: null,
    is_deleted: false,
    deleted_at: null,
    created_at: new Date(now - i * 3600_000).toISOString(),
    updated_at: new Date(now - i * 3600_000).toISOString(),
  }));
}

const measure = () => {
  const main = document.querySelector('main');
  const compact = [...document.querySelectorAll('[data-density="compact"]')];
  const grid = [...document.querySelectorAll('[data-density="grid"]')];
  const first = compact[0] || grid[0] || null;
  const lefts = new Set(grid.slice(0, 12).map((el) => Math.round(el.getBoundingClientRect().left)));
  return {
    viewport: document.documentElement.clientWidth,
    docOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    mainOverflow: main ? Math.round(main.scrollWidth - main.clientWidth) : null,
    compactCount: compact.length,
    gridCount: grid.length,
    firstHeight: first ? Math.round(first.getBoundingClientRect().height) : 0,
    gridColumns: lefts.size,
    listMode: document.querySelector('[data-record-list]')?.getAttribute('data-record-list') || null,
  };
};

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
  const checks = {};
  const notes = [];
  try {
    await waitFor(`${BASE}/version.json`);

    const browser = await chromium.launch({
      executablePath: EDGE,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
    });

    for (const [label, width, height, expect] of VIEWPORTS) {
      const ctx = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        isMobile: width < 700,
        hasTouch: width < 700,
        locale: 'zh-CN',
      });
      await ctx.addInitScript(
        ([key, sess]) => {
          try {
            window.localStorage.setItem(key, JSON.stringify(sess));
          } catch {
            /* ignore */
          }
        },
        [SESSION_KEY, fakeSession()],
      );

      const page = await ctx.newPage();
      const pageErrors = [];
      page.on('pageerror', (e) => pageErrors.push(String(e.message).slice(0, 200)));

      // 记录列表：20 行 + content-range（SDK 用 `0-19/20` 算 count）
      await page.route('**/.cloud/**', async (route) => {
        const url = route.request().url();
        if (/\/rest\/records/.test(url)) {
          const items = rows();
          await route.fulfill({
            status: 200,
            headers: {
              'content-type': 'application/json',
              'content-range': '0-19/20',
              'access-control-expose-headers': 'content-range',
            },
            body: JSON.stringify(items),
          });
          return;
        }
        await route.fulfill({
          status: 200,
          headers: { 'content-type': 'application/json', 'content-range': '*/0' },
          body: '[]',
        });
      });

      await page.goto(`${BASE}/records`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('[data-density="compact"], [data-density="grid"]', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(400);

      const m = await page.evaluate(measure);
      checks[label] = { ...m, pageErrors: pageErrors.slice(0, 3) };
      await page.screenshot({ path: path.join(SHOTS, `${label}.png`), fullPage: false }).catch(() => {});

      if (expect === 'compact') {
        // 交互：点第一行进详情，验证降级后仍能打开（不是只剩个摆设）
        const opened = await page
          .locator('[data-density="compact"]')
          .first()
          .click({ timeout: 5000 })
          .then(async () => {
            await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
            const text = (await page.locator('[role="dialog"]').first().innerText()).slice(0, 40);
            await page.keyboard.press('Escape');
            return text;
          })
          .catch((e) => `CLICK_FAIL ${String(e.message).slice(0, 80)}`);
        checks[label].detailOpened = opened;
      }
      await ctx.close();
    }

    await browser.close();
  } finally {
    server.kill();
  }

  const problems = [];
  for (const [label, width, , expect] of VIEWPORTS) {
    const m = checks[label] || {};
    if (m.listMode !== expect) problems.push(`${label}: 密度应为 ${expect}，实际 ${m.listMode}`);
    if (m.docOverflow !== 0) problems.push(`${label}: 整页横向溢出 ${m.docOverflow}px`);
    if (m.mainOverflow !== 0) problems.push(`${label}: main 内横向溢出 ${m.mainOverflow}px`);
    if ((m.pageErrors || []).length) problems.push(`${label}: 页面异常 ${JSON.stringify(m.pageErrors)}`);

    if (expect === 'compact') {
      if (m.compactCount !== 20 || m.gridCount !== 0) {
        problems.push(`${label}: 紧凑行应 20 条、网格卡应 0 条，实际 ${m.compactCount}/${m.gridCount}`);
      }
      // 行高落在 [44, 96]：低于 44 点不中，高于 96 说明又变回卡片了
      if (!(m.firstHeight >= 44 && m.firstHeight <= 96)) {
        problems.push(`${label}: 紧凑行高 ${m.firstHeight}px 不在 44~96 区间`);
      }
    } else {
      if (m.gridCount !== 20 || m.compactCount !== 0) {
        problems.push(`${label}: 网格卡应 20 条、紧凑行应 0 条，实际 ${m.gridCount}/${m.compactCount}`);
      }
      // 600 档两列（sm=6），900 以上至少三列 —— 宽屏密度不许降
      const minColumns = width >= 900 ? 3 : 2;
      if (m.gridColumns < minColumns) {
        problems.push(`${label}: 只有 ${m.gridColumns} 列，少于期望 ${minColumns} 列`);
      }
      if (m.firstHeight < 150) problems.push(`${label}: 卡片高度 ${m.firstHeight}px，信息密度疑似被砍`);
    }
  }

  const opened = checks['375x667']?.detailOpened;
  if (typeof opened !== 'string' || opened.startsWith('CLICK_FAIL')) {
    problems.push(`375: 点紧凑行打不开详情（${String(opened)}）`);
  }

  const pass = problems.length === 0;
  console.log(JSON.stringify({ pass, problems, checks, notes }, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
