// 拦截云服务请求，用与真实表结构一致的样例数据渲染真实组件，产出「改前」对照截图
const { chromium } = require('playwright-core');
const { mkdirSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:4173';
const OUT = path.resolve(__dirname, '../../outputs/ui-redesign/raw/shots-before');
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
    type: 'note',
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
  row({ type: 'idea', title: '把周报模板拆成三段', summary: '按「进展 / 阻塞 / 下周」重写，写周报从 40 分钟压到 15 分钟。', tags: ['周报', '模板'], category: '写作' }),
  row({ type: 'note', title: '把待办提醒的三段式去重逻辑写进设计文档', summary: 'due / completion / snooze 三种来源合成同一条 dedupeKey，避免重复弹窗。', tags: ['待办', '设计'], category: '产品' }),
  row({ type: 'material', title: '周五复盘：这周真正推进的只有两件事', summary: 'ICS 导入时区用例、移动端基线量测。其余都是被动响应。', tags: ['复盘'], category: '复盘' }),
  row({ type: 'material', title: '读《Refactoring UI》第 4 章：层级靠对比度', summary: '对比度不是加粗，是同时收窄颜色、字号与间距的取值范围。', tags: ['阅读', '设计'], category: '阅读' }),
  row({ type: 'todo', title: '把 node-ical 换成 ical.js', tags: ['待办'], category: '技术', todo_status: 'done', priority: 'medium', content: '' }),
  row({ type: 'todo', title: '移动端适配验收放到下周一，别跟版本收尾撞车', tags: ['待办'], category: '排期', todo_status: 'pending', priority: 'low' }),
  row({ type: 'idea', title: '快速记录做成不打断当前页的浮层', summary: '现在是跳页，回来就丢了浏览位置。', tags: ['交互'], category: '产品' }),
  row({ type: 'note', title: '搜索加中文分词之前，先确认数据量级', summary: '一万条以内 ilike 够用，别过早引入 pgvector。', tags: ['检索'], category: '技术' }),
  row({ type: 'material', title: '团队周会纪要 10-27', summary: '确认 UI 美化按四个批次搭车发版，不新开节奏。', tags: ['会议'], category: '工作' }),
  row({ type: 'todo', title: '补 ICS 导出里的 VALARM', summary: '导入 Google 日历后收不到提醒，原因是导出没写 VALARM。', tags: ['待办'], category: '技术', todo_status: 'pending', priority: 'high', remind_at: Hp(0.4) }),
  row({ type: 'todo', title: '确认 ical.js 在 Safari 下的时区行为', tags: ['待办'], category: '技术', todo_status: 'pending', priority: 'low', remind_at: Hp(2) }),
  row({ type: 'todo', title: '把 UI 美化拆成 4 个批次挂到 v2.13.x', tags: ['待办'], category: '排期', todo_status: 'pending', priority: 'medium', remind_at: Hp(4) }),
  row({ type: 'todo', title: '量移动端基线（8 页 × 3 档）', tags: ['待办'], category: '技术', todo_status: 'done', priority: 'medium' }),
  row({ type: 'todo', title: '把导入导出的 URL 改成 POST', summary: 'GET query 里的 URL 会被 WAF 拦。', tags: ['待办'], category: '技术', todo_status: 'pending', priority: 'medium', someday: true }),
  row({ type: 'idea', title: '识图结果应该先给结构再给文字', summary: '先出字段 schema，再填空，比自由文本好用。', tags: ['识图'], category: '产品' }),
  row({ type: 'note', title: '提醒的三条通道要能降级', summary: '系统通知 → 应用内 → 站内未读，任一层可用即可。', tags: ['提醒'], category: '技术' }),
  row({ type: 'todo', title: '整理本周截图归档到 docs/qa', tags: ['待办'], category: '技术', todo_status: 'pending', priority: 'low', someday: true }),
  row({ type: 'material', title: '移动端现状量测 375/390/768 三档', summary: '主内容仅 135px，顶栏控件跑到 x=513。', tags: ['基线'], category: '技术' }),
];

const FIXTURES = {
  records: RECORDS,
  settings: [{ id: 1, owner_id: 'ui-capture', theme: 'light', review_wizard: null, created_at: H(100), updated_at: H(90) }],
  plugins: [],
  record_links: [],
  code_analyses: [],
  qa_sessions: [],
  chat_messages: [],
};

/** 按查询串做最小过滤，让计数看起来合理 */
function applyFilters(rows, search) {
  if (!search) return rows;
  let out = rows.slice();
  const type = search.match(/[?&]type=eq\.([a-z]+)/);
  if (type) out = out.filter((r) => r.type === type[1]);
  const st = search.match(/[?&]todo_status=eq\.([a-z]+)/);
  if (st) out = out.filter((r) => r.todo_status === st[1]);
  if (/[?&]is_deleted=eq\.false/.test(search)) out = out.filter((r) => !r.is_deleted);
  const gte = search.match(/[?&]created_at=gte\.([^&]+)/);
  if (gte) {
    const t = new Date(decodeURIComponent(gte[1])).getTime();
    out = out.filter((r) => new Date(r.created_at).getTime() >= t);
  }
  const lte = search.match(/[?&]created_at=lte\.([^&]+)/);
  if (lte) {
    const t = new Date(decodeURIComponent(lte[1])).getTime();
    out = out.filter((r) => new Date(r.created_at).getTime() <= t);
  }
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

(async () => {
  const b = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, locale: 'zh-CN' });
  await ctx.addInitScript(([k, s]) => {
    try { localStorage.setItem(k, JSON.stringify(s)); } catch {}
  }, [KEY, sess]);

  const page = await ctx.newPage();
  const seen = [];
  const stats = {};

  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('http://127.0.0.1')) return route.continue();

    // 预检
    if (req.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS, body: '' });
    }
    if (!url.startsWith(ORIGIN)) return route.abort();

    const rest = url.slice(ORIGIN.length);
    seen.push(req.method() + ' ' + rest);

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
        body: JSON.stringify({ version: '2.13.0' }),
      });
    }

    const m = rest.match(/\/database\/rest\/([a-z_]+)/i);
    if (m) {
      const table = m[1];
      const q = rest.split('?')[1] || '';
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

  const ROUTES = [
    ['home', '/'],
    ['todo', '/todo'],
    ['records', '/records'],
    ['calendar', '/calendar'],
    ['review', '/review'],
    ['plugins', '/plugins'],
  ];

  for (const [name, route] of ROUTES) {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2800);
    await page.screenshot({ path: path.join(OUT, `1440__${name}.jpg`), type: 'jpeg', quality: 80 });

    const st = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('body *')).filter((e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      });
      const bg = new Set(); const border = new Set(); const radius = new Set();
      const shadow = new Set(); const fs = new Set(); const fw = new Set();
      for (const e of els) {
        const cs = getComputedStyle(e);
        if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') bg.add(cs.backgroundColor);
        if (parseFloat(cs.borderTopWidth) > 0) border.add(cs.borderTopColor + '/' + cs.borderTopWidth);
        if (cs.borderRadius && cs.borderRadius !== '0px') radius.add(cs.borderRadius);
        if (cs.boxShadow && cs.boxShadow !== 'none') shadow.add(cs.boxShadow.slice(0, 60));
        fs.add(cs.fontSize);
        fw.add(cs.fontWeight);
      }
      const primary = els.filter((e) => {
        const cs = getComputedStyle(e);
        return cs.backgroundColor === 'rgb(91, 84, 217)' || cs.color === 'rgb(91, 84, 217)';
      }).length;
      // 主内容区宽度策略
      const main = document.querySelector('main');
      const mr = main ? main.getBoundingClientRect() : null;
      let innerW = null;
      if (main) {
        const cand = Array.from(main.querySelectorAll('*'))
          .map((e) => ({ w: e.getBoundingClientRect().width, r: e.getBoundingClientRect() }))
          .filter((o) => o.w > 200 && o.w < mr.width);
        innerW = cand.length ? Math.round(Math.max(...cand.map((o) => o.w))) : null;
      }
      return {
        elements: els.length,
        distinctBg: bg.size,
        distinctBorder: border.size,
        distinctRadius: radius.size,
        distinctShadow: shadow.size,
        distinctFontSize: fs.size,
        fontSizes: Array.from(fs).sort((a, b) => parseFloat(a) - parseFloat(b)),
        fontWeights: Array.from(fw).sort(),
        primaryUsages: primary,
        radiusList: Array.from(radius).slice(0, 12),
        shadowList: Array.from(shadow).slice(0, 4),
        mainWidth: mr ? Math.round(mr.width) : null,
        innerContentWidth: innerW,
      };
    });
    stats[name] = st;
    console.log(
      name.padEnd(9),
      `el=${st.elements} bg=${st.distinctBg} radius=${st.distinctRadius} shadow=${st.distinctShadow} fs=${st.distinctFontSize} primary=${st.primaryUsages} main=${st.mainWidth} inner=${st.innerContentWidth}`,
    );
  }

  writeFileSync(path.join(OUT, 'visual-stats-before.json'), JSON.stringify(stats, null, 1), 'utf-8');
  writeFileSync(path.join(OUT, '_requests.log'), [...new Set(seen)].join('\n'), 'utf8');
  console.log('unique requests:', new Set(seen).size);

  await b.close();
})();
