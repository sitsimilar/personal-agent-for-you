// 三套界面方案的对照截图：同一份样例数据，只改 localStorage 里的方案，逐方案截 3 页。
// 用法：node qa/ui-scheme-capture.cjs [baseUrl] [outDir]
const { chromium } = require('playwright-core');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:4188';
const OUT = path.resolve(process.argv[3] || __dirname, '../../outputs/ui-redesign/raw/schemes');
mkdirSync(OUT, { recursive: true });

const ORIGIN = 'https://personal-agent-08495.app.workbuddy.link';
const KEY = `workbuddy-cloud.session.${process.env.UB_PUBKEY || ''}`;
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
    notify_enabled: true,
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

const SCHEMES = ['silent', 'zoned', 'fluid'];
const PAGES = [
  ['home', '/'],
  ['todo', '/todo'],
  ['settings', '/settings'],
];

(async () => {
  const b = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  const report = [];

  for (const scheme of SCHEMES) {
    const ctx = await b.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1, locale: 'zh-CN' });
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
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ models: [] }) });
      }
      if (rest.includes('/version.json')) {
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify({ version: '2.13.0' }) });
      }
      const m = rest.match(/\/database\/rest\/([a-z_]+)/i);
      if (m) {
        const table = m[1];
        const q = rest.split('?')[1] || '';
        // settings 的 PATCH 要回写成功（方案云同步）
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

    for (const [name, route] of PAGES) {
      await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2600);
      await page.screenshot({ path: path.join(OUT, `${scheme}__${name}.png`) });

      const probe = await page.evaluate(() => {
        const main = document.querySelector('main');
        const drawer = document.querySelector('.MuiDrawer-paper');
        const cs = (el) => (el ? getComputedStyle(el) : null);
        // 内容容器 = main 里第一个设了 max-width 的 div（PageShell 的 Box）
        const shell = main
          ? Array.from(main.querySelectorAll('div')).find((el) => {
              const mw = getComputedStyle(el).maxWidth;
              return mw && mw !== 'none' && el.getBoundingClientRect().width > 0;
            })
          : null;
        const header = main?.querySelector('h6, .MuiTypography-h6, .MuiBox-root > .MuiTypography-root');
        return {
          scheme: document.documentElement.dataset.scheme ?? '(unset)',
          contentWidth: shell ? Math.round(shell.getBoundingClientRect().width) : null,
          contentMaxWidth: shell ? cs(shell).maxWidth : null,
          mainScrollOverflow: main ? main.scrollWidth - main.clientWidth : null,
          headerFontSize: header ? cs(header).fontSize : null,
          drawerWidth: drawer ? Math.round(drawer.getBoundingClientRect().width) : null,
          motionEnter: getComputedStyle(document.documentElement).getPropertyValue('--motion-enter').trim(),
          contentMax: getComputedStyle(document.documentElement).getPropertyValue('--content-max').trim(),
          topBarButtons: document.querySelectorAll('.MuiAppBar-root button').length,
          hasPaletteHint: !!Array.from(document.querySelectorAll('.MuiChip-label')).find((n) => n.textContent === 'Ctrl K'),
        };
      });
      report.push({ scheme, page: name, ...probe });
    }
    await ctx.close();
  }

  await b.close();
  console.log(JSON.stringify(report, null, 1));
})();
