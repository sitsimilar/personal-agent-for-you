// 形象图：命令面板 / 方案卡片 / 顶栏切换浮层
const { chromium } = require('playwright-core');
const { mkdirSync } = require('node:fs');
const path = require('node:path');

const BASE = process.argv[2] || 'http://127.0.0.1:4188';
const OUT = path.resolve(__dirname, '../../outputs/ui-redesign/raw/schemes');
mkdirSync(OUT, { recursive: true });

const ORIGIN = 'https://personal-agent-08495.app.workbuddy.link';
const KEY = `workbuddy-cloud.session.${process.env.UB_PUBKEY || ''}`;
const sess = { accessToken: 't', refreshToken: 'r', expiresAt: 4102444800000, user: { id: 'ui-capture', username: 'ui-capture' } };
const H = (d) => new Date(Date.now() - d * 3600_000).toISOString();
const SETTINGS = [{ id: 1, owner_id: 'ui-capture', nickname: '司凤', notify_enabled: true, remind_lead_minutes: 0, quiet_hours_enabled: false, quiet_start: '22:00', quiet_end: '08:00', code_upload_enabled: true, float_window_enabled: true, vs_path: null, avatar_image_id: null, review_wizard: null, updated_at: H(2) }];
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS', 'access-control-allow-headers': '*', 'access-control-expose-headers': 'content-range' };

const RECORDS = [
  { id: 11, owner_id: 'ui-capture', type: 'idea', title: '把周报模板拆成三段', content: '', url: null, file_path: null, category: '写作', tags: [], summary: '按进展/阻塞/下周重写。', todo_status: null, priority: null, remind_at: null, recurrence: null, recurrence_parent_id: null, recurrence_next_id: null, link_meta: null, someday: false, snoozed_until: null, snooze_count: 0, is_deleted: false, deleted_at: null, created_at: H(5), updated_at: H(3) },
  { id: 12, owner_id: 'ui-capture', type: 'todo', title: '补 ICS 导出里的 VALARM', content: '', url: null, file_path: null, category: '技术', tags: ['待办'], summary: '导入 Google 日历后收不到提醒。', todo_status: 'pending', priority: 'high', remind_at: new Date(Date.now() + 3 * 3600_000).toISOString(), recurrence: null, recurrence_parent_id: null, recurrence_next_id: null, link_meta: null, someday: false, snoozed_until: null, snooze_count: 0, is_deleted: false, deleted_at: null, created_at: H(9), updated_at: H(6) },
];

async function open(browser, scheme, route) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2, locale: 'zh-CN' });
  await ctx.addInitScript(([k, s, sk, sv]) => {
    try { localStorage.setItem(k, JSON.stringify(s)); localStorage.setItem(sk, JSON.stringify({ v: 1, scheme: sv })); } catch {}
  }, [KEY, sess, 'pa.ui.scheme', scheme]);
  const page = await ctx.newPage();
  await ctx.route('**/*', async (r) => {
    const req = r.request();
    const url = req.url();
    if (url.startsWith('http://127.0.0.1')) return r.continue();
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS, body: '' });
    if (!url.startsWith(ORIGIN)) return r.abort();
    const rest = url.slice(ORIGIN.length);
    if (rest.includes('/llm/models')) return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"models":[]}' });
    if (rest.includes('/version.json')) return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"version":"2.13.0"}' });
    if (/\/database\/rest\//.test(rest)) {
      const table = (rest.match(/\/database\/rest\/([a-z_]+)/i) || [])[1];
      const rows = table === 'records' ? RECORDS : SETTINGS;
      return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'content-range': `0-${rows.length - 1}/${rows.length}` }, body: JSON.stringify(rows) });
    }
    return r.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '[]' });
  });
  await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2400);
  return { ctx, page };
}

(async () => {
  const b = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true, args: ['--no-sandbox', '--disable-gpu'] });

  // 1. 命令面板（流畅方案）
  {
    const { ctx, page } = await open(b, 'fluid', '/');
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'shot-palette.png') });
    await ctx.close();
  }

  // 2. 设置页方案卡（分区方案，卡片本体）
  {
    const { ctx, page } = await open(b, 'zoned', '/settings');
    const card = page.locator('#ui-scheme');
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await card.screenshot({ path: path.join(OUT, 'shot-scheme-card.png') });
    await ctx.close();
  }

  // 3. 顶栏切换浮层
  {
    const { ctx, page } = await open(b, 'silent', '/');
    await page.getByRole('button', { name: '切换界面方案' }).click();
    await page.waitForTimeout(500);
    const box = await page.evaluate(() => {
      const el = document.querySelector('.MuiPopover-paper');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, r.x - 20), y: Math.max(0, r.y - 70), w: r.width + 60, h: r.height + 90 };
    });
    if (box) await page.screenshot({ path: path.join(OUT, 'shot-switcher.png'), clip: { x: box.x, y: box.y, width: box.w, height: box.h } });
    await ctx.close();
  }

  await b.close();
  console.log('ok');
})();
