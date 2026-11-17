// 「线构 · Line Geometry」视觉升级对照截图（v2.14）。
// 用法：先 `npm run dev`（web 目录，默认 5173），再 `node qa/ui-line-capture.cjs [baseUrl] [outDir]`
// 截图全部基于真实页面 + 路由拦截的样例数据，不需要登录或后端。
const { chromium } = require('playwright-core');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:5173';
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '../outputs/ui-line-20261116'));
mkdirSync(OUT, { recursive: true });

const ORIGIN = 'https://personal-agent-08495.app.workbuddy.link';
const PUB =
  process.env.UB_PUBKEY ||
  'wbpk_r4YfCwqie0lNWyN2IeZ5TO_uPHHM0B4cs1WDMYt41aX9cwBZYmfqyJX';
const KEY = `workbuddy-cloud.session.${PUB}`;
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
  row({
    type: 'idea',
    title: '把周报模板拆成三段',
    summary: '按「进展 / 阻塞 / 下周」重写，写周报从 40 分钟压到 15 分钟。',
    content: '进展只写三件、阻塞只写真正需要别人配合的、下周只写能承诺的。模板放进快捷记录，每周五直接填。',
    tags: ['周报', '写作'],
    category: '写作',
  }),
  row({
    type: 'todo',
    title: '把待办提醒的三段式去重逻辑写进设计文档',
    summary: 'due / completion / snooze 三种来源合成同一条 dedupeKey。',
    tags: ['待办'],
    category: '产品',
    todo_status: 'pending',
    priority: 'high',
  }),
  row({
    type: 'material',
    title: '周五复盘：这周真正推进的只有两件事',
    summary: 'ICS 导入时区用例、移动端基线量测。其余时间都花在等确认上。',
    tags: ['复盘'],
    category: '复盘',
  }),
  row({
    type: 'material',
    title: '读《Refactoring UI》第 4 章：层级靠对比度',
    summary: '对比度不是加粗，是同时收窄颜色、字号与间距的取值范围。',
    tags: ['阅读', '设计'],
    category: '阅读',
  }),
  row({
    type: 'todo',
    title: '补 ICS 导出里的 VALARM',
    summary: '导入 Google 日历后收不到提醒。',
    tags: ['待办'],
    category: '技术',
    todo_status: 'pending',
    priority: 'medium',
    remind_at: H(1),
  }),
  row({
    type: 'idea',
    title: '识图结果应该先给结构再给文字',
    summary: '先出字段 schema，再填空；不要让模型自由发挥段落。',
    tags: ['识图'],
    category: '产品',
  }),
  row({
    type: 'todo',
    title: '确认 ical.js 在 Safari 下的时区行为',
    tags: ['待办'],
    category: '技术',
    todo_status: 'pending',
    priority: 'low',
    remind_at: H(3),
  }),
  row({
    type: 'material',
    title: '团队周会纪要 10-27',
    summary: 'UI 美化按四个批次搭车发版，不单独开分支。',
    tags: ['会议'],
    category: '工作',
  }),
  row({
    type: 'todo',
    title: '整理本周截图归档到 docs/qa',
    tags: ['待办'],
    category: '技术',
    todo_status: 'pending',
    priority: 'low',
    someday: true,
  }),
  row({
    type: 'idea',
    title: '提醒的三条通道要能降级',
    summary: '站内 → 系统通知 → 邮件，任一条失败都要留痕。',
    tags: ['提醒'],
    category: '技术',
  }),
  row({
    type: 'todo',
    title: '每两周整理一次灵感清单',
    summary: '把「某天」里的想法捞出来，能做的进今天，不能做的归档。',
    tags: ['习惯'],
    category: '产品',
    todo_status: 'pending',
    priority: 'high',
    remind_at: H(2),
    recurrence: { freq: 'weekly', interval: 2, weekdays: [5] },
    recurrence_next_id: 2088,
  }),
  row({
    type: 'todo',
    title: '已完成：把登录页的渐变底换成纯色',
    summary: '渐变在高分屏上会有色带。',
    tags: ['待办'],
    category: '设计',
    todo_status: 'done',
    priority: 'medium',
    remind_at: H(20),
  }),
  row({
    type: 'todo',
    title: '已完成：移动端底部导航补安全区',
    tags: ['待办'],
    category: '技术',
    todo_status: 'done',
    priority: 'low',
    remind_at: H(26),
  }),
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
  const cat = search.match(/[?&]category=eq\.([^&]+)/);
  if (cat) out = out.filter((r) => r.category === decodeURIComponent(cat[1]));
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

/** 在真实页面上装好拦截与登录态。 */
async function makePage(browser, { scheme, mode, viewport }) {
  const ctx = await browser.newContext({
    viewport: viewport || { width: 1440, height: 960 },
    deviceScaleFactor: 1,
    locale: 'zh-CN',
    colorScheme: mode,
  });
  await ctx.addInitScript(
    ([k, s, schemeKey, schemeVal]) => {
      try {
        localStorage.setItem(k, JSON.stringify(s));
        localStorage.setItem(schemeKey, JSON.stringify({ v: 1, scheme: schemeVal }));
      } catch {}
    },
    [KEY, sess, 'pa.ui.scheme', scheme],
  );

  const page = await ctx.newPage();
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('http://127.0.0.1')) return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    if (!url.startsWith(ORIGIN)) return route.abort();
    const rest = url.slice(ORIGIN.length);

    if (rest.includes('/llm/models')) {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ models: [] }),
      });
    }
    if (rest.includes('/version.json')) {
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json' },
        body: JSON.stringify({ version: '2.14.0' }),
      });
    }
    const m = rest.match(/\/database\/rest\/([a-z_]+)/i);
    if (m) {
      const table = m[1];
      const q = rest.split('?')[1] || '';
      if (req.method() === 'PATCH' || req.method() === 'POST') {
        return route.fulfill({
          status: 200,
          headers: { ...CORS, 'content-type': 'application/json' },
          body: JSON.stringify([SETTINGS[0]]),
        });
      }
      const rows = applyFilters(FIXTURES[table] ?? [], '?' + q);
      return route.fulfill({
        status: 200,
        headers: {
          ...CORS,
          'content-type': 'application/json; charset=utf-8',
          'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}`,
        },
        body: JSON.stringify(rows),
      });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '[]' });
  });

  return { ctx, page };
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  console.log(`✓ ${name}.png`);
}

async function settle(page) {
  // 等首屏请求、字体与进场动画落定；220ms 进场 + 26ms×8 错峰 ≈ 430ms，留足余量
  await page.waitForTimeout(1800);
  await page.evaluate(() => document.fonts?.ready);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const jobs = [
    {
      scheme: 'zoned',
      mode: 'light',
      tasks: [
        ['home-light', '/'],
        ['home-light-dialog-create', '/', { click: '主要-快速记录' }],
        ['home-light-dialog-detail', '/', { click: '第一张记录卡' }],
      ],
    },
    {
      scheme: 'zoned',
      mode: 'dark',
      tasks: [
        ['home-dark', '/'],
        ['home-dark-dialog-create', '/', { click: '主要-快速记录' }],
        ['home-dark-dialog-detail', '/', { click: '第一张记录卡' }],
        ['sanity-settings-dark', '/settings'],
        ['sanity-calendar-dark', '/calendar'],
      ],
    },
    {
      scheme: 'fluid',
      mode: 'light',
      tasks: [
        ['records-light', '/records'],
        ['todo-light', '/todo'],
        ['todo-empty-light', '/todo', { click: '即将分段' }],
      ],
    },
    {
      scheme: 'fluid',
      mode: 'dark',
      tasks: [
        ['records-dark', '/records'],
        ['todo-dark', '/todo'],
        ['todo-empty-dark', '/todo', { click: '即将分段' }],
      ],
    },
    {
      scheme: 'fluid',
      mode: 'light',
      viewport: { width: 390, height: 844 },
      tasks: [['records-mobile-light', '/records']],
    },
  ];

  for (const job of jobs) {
    const { ctx, page } = await makePage(browser, job);
    for (const [name, route, action] of job.tasks) {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await settle(page);
      if (action?.click === '主要-快速记录') {
        const btn = page.getByRole('button', { name: '快速记录' }).first();
        await btn.click();
        await page.waitForTimeout(500);
      }
      if (action?.click === '第一张记录卡') {
        await page.locator('.MuiCardActionArea-root').first().click();
        await page.waitForTimeout(700);
      }
      if (action?.click === '即将分段') {
        await page.getByRole('button', { name: /^即将/ }).click();
        await page.waitForTimeout(600);
      }
      await shot(page, name);
    }
    await ctx.close();
  }

  await browser.close();
  console.log(`\n输出目录：${OUT}`);
})();
