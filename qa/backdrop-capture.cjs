// 背景氛围面板截图 + 功能验收：
//   1) 三套主题 × 浅深 × 桌面/窄屏（首页，默认参数）；
//   2) 设置页面板：默认 / 参数拉满 / 全部最低（浅色每组，深色补一组）；
//   3) 交互验收：滑杆改值即时生效、刷新后保留、恢复默认、关闭后渲染层不挂载。
// 用法：node qa/backdrop-capture.cjs [baseUrl] [outDir]
const { chromium } = require('playwright-core');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:5173';
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '../outputs/ui-backdrop-20261116'));
mkdirSync(OUT, { recursive: true });

const ORIGIN = 'https://personal-agent-08495.app.workbuddy.link';
// 与 qa/ui-line-capture.cjs 同一份会话公钥（截图专用，非真实凭据）
const KEY = 'workbuddy-cloud.session.wbpk_r4YfCwqie0lNWyN2IeZ5TO_uPHHM0B4cs1WDMYt41aX9cwBZYmfqyJX';
const sess = {
  accessToken: 'ui-capture-token',
  refreshToken: 'ui-capture-refresh',
  expiresAt: 4102444800000,
  user: { id: 'ui-capture', phone: '+86 10000000000', username: 'ui-capture' },
};

const H = (d) => new Date(Date.now() - d * 3600_000).toISOString();
const Hp = (d) => new Date(Date.now() + d * 3600_000).toISOString();

let seq = 0;
function row(o) {
  seq += 1;
  return {
    id: 1000 + seq,
    owner_id: 'ui-capture',
    type: 'idea',
    title: '',
    content: '',
    url: null,
    file_path: null,
    category: null,
    tags: [],
    summary: null,
    todo_status: null,
    priority: null,
    remind_at: null,
    recurrence: null,
    recurrence_parent_id: null,
    recurrence_next_id: null,
    link_meta: null,
    someday: false,
    snoozed_until: null,
    snooze_count: 0,
    search_tsv: null,
    is_deleted: false,
    deleted_at: null,
    created_at: H(seq * 5),
    updated_at: H(seq * 3),
    ...o,
  };
}

const RECORDS = [
  row({ type: 'idea', title: '把周报模板拆成三段', summary: '按「进展 / 阻塞 / 下周」重写，写周报从 40 分钟压到 15 分钟。', tags: ['周报'], category: '写作' }),
  row({ type: 'todo', title: '把待办提醒的三段式去重逻辑写进设计文档', summary: 'due / completion / snooze 三种来源合成同一条 dedupeKey。', tags: ['待办'], category: '产品', todo_status: 'pending', priority: 'high', remind_at: Hp(3) }),
  row({ type: 'material', title: '周五复盘：这周真正推进的只有两件事', summary: 'ICS 导入时区用例、移动端基线量测。', tags: ['复盘'], category: '复盘' }),
  row({ type: 'material', title: '读《Refactoring UI》第 4 章：层级靠对比度', summary: '对比度不是加粗，是同时收窄颜色、字号与间距的取值范围。', tags: ['阅读'], category: '阅读' }),
  row({ type: 'todo', title: '补 ICS 导出里的 VALARM', summary: '导入 Google 日历后收不到提醒。', tags: ['待办'], category: '技术', todo_status: 'pending', priority: 'medium', remind_at: Hp(0.6) }),
  row({ type: 'idea', title: '识图结果应该先给结构再给文字', summary: '先出字段 schema，再填空。', tags: ['识图'], category: '产品' }),
  row({ type: 'todo', title: '确认 ical.js 在 Safari 下的时区行为', tags: ['待办'], category: '技术', todo_status: 'pending', priority: 'low', remind_at: Hp(6) }),
  row({ type: 'material', title: '团队周会纪要 10-27', summary: 'UI 美化按四个批次搭车发版。', tags: ['会议'], category: '工作' }),
  row({ type: 'todo', title: '整理本周截图归档到 docs/qa', tags: ['待办'], category: '技术', todo_status: 'pending', priority: 'low', someday: true }),
  row({ type: 'idea', title: '提醒的三条通道要能降级', tags: ['提醒'], category: '技术' }),
];

const SETTINGS = [
  {
    id: 1,
    owner_id: 'ui-capture',
    vs_path: null,
    code_upload_enabled: true,
    float_window_enabled: true,
    notify_enabled: false,
    remind_lead_minutes: 0,
    quiet_hours_enabled: false,
    quiet_start: '22:00',
    quiet_end: '08:00',
    review_wizard: null,
    avatar_image_id: null,
    nickname: '司凤',
    updated_at: H(10),
  },
];

const FIXTURES = { records: RECORDS, settings: SETTINGS, plugins: [], record_links: [], code_analyses: [] };

function applyFilters(rows, search) {
  if (!search) return rows;
  let out = rows.slice();
  const type = search.match(/[?&]type=eq\.([a-z]+)/);
  if (type) out = out.filter((r) => r.type === type[1]);
  const st = search.match(/[?&]todo_status=eq\.([a-z]+)/);
  if (st) out = out.filter((r) => r.todo_status === st[1]);
  if (/[?&]is_deleted=eq\.false/.test(search)) out = out.filter((r) => !r.is_deleted);
  if (/order=created_at\.desc/.test(search)) out.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const lim = search.match(/[?&]limit=(\d+)/);
  if (lim) out = out.slice(0, Number(lim[1]));
  const off = search.match(/[?&]offset=(\d+)/);
  if (off) out = out.slice(Number(off[1]));
  return out;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'content-range,content-location',
};

const BACKDROPS = ['off', 'orbit', 'starfield', 'terrain'];
const VIEWPORTS = [
  ['desktop', { width: 1440, height: 960 }],
  ['narrow', { width: 390, height: 844 }],
];

/** 参数预设：default 用主题推荐值；其余三项写死到安全边界。 */
const PRESETS = {
  default: null,
  min: { speed: 0, intensity: 0, blur: 0, opacity: 0 },
  max: { speed: 100, intensity: 100, blur: 4, opacity: 100 },
  // 线条最重的一档：其余拉满、模糊回到 0（最大模糊会把线化成雾，单看 max 图会像“关掉了”）
  maxline: { speed: 100, intensity: 100, blur: 0, opacity: 100 },
};

async function mockRoutes(ctx) {
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('http://127.0.0.1')) return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    if (!url.startsWith(ORIGIN)) return route.abort();
    const rest = url.slice(ORIGIN.length);

    if (rest.includes('/llm/models')) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ models: [] }) });
    }
    if (rest.includes('/version.json')) {
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ version: '2.13.0' }) });
    }
    const m = rest.match(/\/database\/rest\/([a-z_]+)/i);
    if (m) {
      const table = m[1];
      const q = rest.split('?')[1] || '';
      if (req.method() === 'PATCH' || req.method() === 'POST') {
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify([SETTINGS[0]]) });
      }
      const rows = applyFilters(FIXTURES[table] ?? [], '?' + q);
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
        body: JSON.stringify(rows),
      });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '[]' });
  });
}

async function newCtx(browser, viewport, mode, backdrop, preset) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'zh-CN', colorScheme: mode });
  await ctx.addInitScript(
    ([k, s, bk, bv, pv]) => {
      try {
        localStorage.setItem(k, JSON.stringify(s));
        localStorage.setItem('pa.ui.scheme', JSON.stringify({ v: 1, scheme: 'silent' }));
        // 只在没有值时写入：功能验收里 reload 后要保留用户刚改的参数
        if (!localStorage.getItem(bk)) {
          const payload = { v: 2, backdrop: bv };
          if (pv) payload.params = { [bv]: pv, orbit: pv, starfield: pv, terrain: pv };
          localStorage.setItem(bk, JSON.stringify(payload));
        }
      } catch {}
    },
    [KEY, sess, 'pa.ui.backdrop', backdrop, preset],
  );
  await mockRoutes(ctx);
  return ctx;
}

async function shotPanel(page, name) {
  await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const card = page.locator('#ui-backdrop');
  await card.scrollIntoViewIfNeeded();
  // 元素截图遇到 position:fixed 的顶栏/底部导航时，拼接图会被它们穿插；
  // 截图前把所有 fixed 元素藏掉，卡片自身的位置与尺寸不变。
  await page.evaluate(() => {
    document.querySelectorAll('body *').forEach((el) => {
      if (getComputedStyle(el).position === 'fixed') el.style.visibility = 'hidden';
    });
  });
  await page.waitForTimeout(200);
  await card.screenshot({ path: path.join(OUT, name) });
}

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const report = { themeShots: [], panelShots: [], functional: {}, errors: [] };

  /* ---------- 1. 主题效果截图（默认参数） ---------- */
  for (const [sizeName, viewport] of VIEWPORTS) {
    for (const mode of ['light', 'dark']) {
      for (const backdrop of BACKDROPS) {
        const ctx = await newCtx(browser, viewport, mode, backdrop, null);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => report.errors.push(`theme ${backdrop}/${mode}/${sizeName}: ${e.message}`));
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        await page.screenshot({ path: path.join(OUT, `${backdrop}__home__${sizeName}__${mode}.png`) });

        const probe = await page.evaluate(() => {
          const layer = document.querySelector('.bd-layer');
          const canvas = document.querySelector('.bd-canvas');
          const track = document.querySelector('.bd-track');
          const main = document.querySelector('main');
          const rootStyle = getComputedStyle(document.documentElement);
          return {
            dataset: document.documentElement.dataset.backdrop ?? '(unset)',
            layer: !!layer,
            canvas: !!canvas,
            canvasSize: canvas ? `${canvas.width}x${canvas.height}` : null,
            trackDuration: track ? getComputedStyle(track).animationDuration : null,
            trackPlayState: track ? getComputedStyle(track).animationPlayState : null,
            layerOpacity: layer ? getComputedStyle(layer).opacity : null,
            layerBlur: layer ? getComputedStyle(layer.firstElementChild || layer).filter : null,
            layerPointerEvents: layer ? getComputedStyle(layer).pointerEvents : null,
            bdVars: {
              dot: rootStyle.getPropertyValue('--bd-dot').trim(),
              stroke: rootStyle.getPropertyValue('--bd-stroke-w').trim(),
            },
            mainScrollWidth: main ? main.scrollWidth : null,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
          };
        });
        report.themeShots.push({ backdrop, sizeName, mode, ...probe });
        await ctx.close();
      }
    }
  }

  /* ---------- 2. 面板截图：默认 / 拉满 / 最低 ---------- */
  // 面板比一屏高：给一个足够高的视口，避免元素截图时跨屏拼接
  const PANEL_VIEWPORT = {
    desktop: { width: 1440, height: 1100 },
    narrow: { width: 390, height: 2400 },
  };
  for (const backdrop of ['orbit', 'starfield', 'terrain']) {
    for (const [presetName, preset] of [
      ['default', PRESETS.default],
      ['max', PRESETS.max],
      ['min', PRESETS.min],
    ]) {
      const ctx = await newCtx(browser, PANEL_VIEWPORT.desktop, 'light', backdrop, preset);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => report.errors.push(`panel ${backdrop}/${presetName}: ${e.message}`));
      await shotPanel(page, `panel__${backdrop}__${presetName}__desktop__light.png`);
      report.panelShots.push({ backdrop, presetName, size: 'desktop', mode: 'light' });
      await ctx.close();
    }
  }

  for (const [sizeName, viewport] of [
    ['desktop', PANEL_VIEWPORT.desktop],
    ['narrow', PANEL_VIEWPORT.narrow],
  ]) {
    const ctx = await newCtx(browser, viewport, 'dark', 'starfield', PRESETS.default);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => report.errors.push(`panel dark/${sizeName}: ${e.message}`));
    await shotPanel(page, `panel__starfield__default__${sizeName}__dark.png`);
    report.panelShots.push({ backdrop: 'starfield', presetName: 'default', size: sizeName, mode: 'dark' });
    await ctx.close();
  }

  const narrowCtx = await newCtx(browser, PANEL_VIEWPORT.narrow, 'light', 'orbit', PRESETS.default);
  const narrowPage = await narrowCtx.newPage();
  await shotPanel(narrowPage, 'panel__orbit__default__narrow__light.png');
  report.panelShots.push({ backdrop: 'orbit', presetName: 'default', size: 'narrow', mode: 'light' });
  await narrowCtx.close();

  // 「怎么进」的页面级截图：保留侧栏与卡片位置，不隐藏 fixed 元素
  {
    const ctx = await newCtx(browser, PANEL_VIEWPORT.desktop, 'light', 'orbit', PRESETS.default);
    const page = await ctx.newPage();
    await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1500);
    await page.locator('#ui-backdrop').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'settings__backdrop-card__desktop__light.png') });
    await ctx.close();
  }

  /* ---------- 2.5 参数拉满 / 拉到最低的实际背景对照（首页） ---------- */
  for (const backdrop of ['orbit', 'starfield', 'terrain']) {
    for (const [presetName, preset] of [
      ['max', PRESETS.max],
      ['min', PRESETS.min],
    ]) {
      for (const mode of ['light', 'dark']) {
        const ctx = await newCtx(browser, { width: 1440, height: 960 }, mode, backdrop, preset);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => report.errors.push(`extreme ${backdrop}/${presetName}/${mode}: ${e.message}`));
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1800);
        await page.screenshot({ path: path.join(OUT, `params__${backdrop}__${presetName}__home__desktop__${mode}.png`) });
        await ctx.close();
      }
    }
  }

  /* ---------- 2.6 「线最重」与「模糊单参数」对照 ---------- */
  // 模糊拉到 4px 时线条会化成薄雾，这是模糊的物理结果，不是参数失效；
  // 所以额外给两档：maxline（模糊 0，其余拉满）与模糊 0/2/4px 的单参数对照。
  for (const backdrop of ['orbit', 'starfield', 'terrain']) {
    for (const [presetName, preset] of [['maxline', PRESETS.maxline]]) {
      for (const mode of ['light', 'dark']) {
        const ctx = await newCtx(browser, { width: 1440, height: 960 }, mode, backdrop, preset);
        const page = await ctx.newPage();
        page.on('pageerror', (e) => report.errors.push(`maxline ${backdrop}/${mode}: ${e.message}`));
        await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(1800);
        await page.screenshot({ path: path.join(OUT, `params__${backdrop}__${presetName}__home__desktop__${mode}.png`) });
        await ctx.close();
      }
    }
  }

  for (const backdrop of ['orbit', 'terrain']) {
    for (const blur of [0, 2, 4]) {
      const preset = { speed: 50, intensity: 100, blur, opacity: 100 };
      const ctx = await newCtx(browser, { width: 1440, height: 960 }, 'light', backdrop, preset);
      const page = await ctx.newPage();
      page.on('pageerror', (e) => report.errors.push(`blur ${backdrop}/${blur}: ${e.message}`));
      await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1800);
      await page.screenshot({ path: path.join(OUT, `blur__${backdrop}__${blur}px__home__desktop__light.png`) });
      await ctx.close();
    }
  }

  /* ---------- 3. 交互验收 ---------- */
  {
    const ctx = await newCtx(browser, { width: 1440, height: 960 }, 'light', 'orbit', PRESETS.default);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => report.errors.push(`functional: ${e.message}`));
    await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1600);
    await page.locator('#ui-backdrop').scrollIntoViewIfNeeded();

    const sliderLabels = async () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll('#ui-backdrop .MuiSlider-root input')).map((el) =>
          el.getAttribute('aria-label'),
        ),
      );

    const opacity = page.locator('#ui-backdrop [aria-label^="透明度"]');
    await opacity.focus();
    await opacity.press('End');
    await page.waitForTimeout(320);
    const afterMax = await page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const raw = localStorage.getItem('pa.ui.backdrop');
      return {
        layerOpacity: root.getPropertyValue('--bd-layer-opacity').trim(),
        stored: raw ? JSON.parse(raw).params?.orbit?.opacity : null,
        label: document.querySelector('#ui-backdrop [aria-label^="透明度"]')?.getAttribute('aria-label'),
      };
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1600);
    await page.locator('#ui-backdrop').scrollIntoViewIfNeeded();
    const afterReload = await page.evaluate(() => ({
      label: document.querySelector('#ui-backdrop [aria-label^="透明度"]')?.getAttribute('aria-label'),
      cssOpacity: getComputedStyle(document.documentElement).getPropertyValue('--bd-layer-opacity').trim(),
    }));

    await page.getByRole('button', { name: '恢复默认', exact: true }).click();
    await page.waitForTimeout(300);
    const afterRestore = await page.evaluate(() => ({
      label: document.querySelector('#ui-backdrop [aria-label^="透明度"]')?.getAttribute('aria-label'),
      cssOpacity: getComputedStyle(document.documentElement).getPropertyValue('--bd-layer-opacity').trim(),
    }));

    // 切主题：参数随之换成该主题的推荐值
    await page.locator('#ui-backdrop').getByText('星野', { exact: true }).first().click();
    await page.waitForTimeout(400);
    const afterThemeSwitch = await sliderLabels();

    // 关闭：渲染层不挂载、滑杆禁用
    await page.locator('#ui-backdrop').getByText('关闭', { exact: true }).first().click();
    await page.waitForTimeout(400);
    const afterOff = await page.evaluate(() => ({
      dataset: document.documentElement.dataset.backdrop,
      hasLayer: !!document.querySelector('.bd-layer'),
      disabledSliders: document.querySelectorAll('#ui-backdrop .Mui-disabled.MuiSlider-root').length,
    }));

    report.functional = { afterMax, afterReload, afterRestore, afterThemeSwitch, afterOff };
    await ctx.close();
  }

  /* ---------- 4. 减弱动效 ---------- */
  {
    const ctx = await browser.newContext({
      viewport: { width: 1440, height: 960 },
      reducedMotion: 'reduce',
      colorScheme: 'light',
    });
    await ctx.addInitScript(([k, s]) => {
      localStorage.setItem(k, JSON.stringify(s));
      localStorage.setItem('pa.ui.backdrop', JSON.stringify({ v: 2, backdrop: 'terrain' }));
    }, [KEY, sess]);
    await mockRoutes(ctx);
    const page = await ctx.newPage();
    await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, 'reduced-motion__terrain__desktop__light.png') });
    report.reducedMotion = await page.evaluate(() => {
      const canvas = document.querySelector('.bd-canvas-terrain');
      return {
        dataset: document.documentElement.dataset.backdrop,
        animation: canvas ? getComputedStyle(canvas).animationName : null,
      };
    });
    await ctx.close();
  }

  await browser.close();
  console.log(JSON.stringify(report, null, 1));
})().catch((e) => {
  console.error('FATAL', e.message);
  process.exit(1);
});
