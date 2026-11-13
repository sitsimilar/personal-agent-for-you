// 界面方案交互验收：切换 / 撤销 / 命令面板 / 默认恢复 是否真的按预期工作。
// 用法：UB_PUBKEY=<公钥> node qa/ui-scheme-interaction.cjs [baseUrl]
const { chromium } = require('playwright-core');

const BASE = process.argv[2] || 'http://127.0.0.1:4188';
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

const base = (o) => ({
  id: 1, owner_id: 'ui-capture', type: 'todo', title: '', content: '', url: null, file_path: null,
  category: null, tags: [], summary: null, todo_status: 'pending', priority: 'medium',
  remind_at: null, recurrence: null, recurrence_parent_id: null, recurrence_next_id: null,
  link_meta: null, someday: false, snoozed_until: null, snooze_count: 0, search_tsv: null,
  is_deleted: false, deleted_at: null, created_at: H(5), updated_at: H(3), ...o,
});

const RECORDS = [
  base({ id: 11, type: 'idea', title: '把周报模板拆成三段', summary: '按进展/阻塞/下周重写。', category: '写作' }),
  base({ id: 12, title: '补 ICS 导出里的 VALARM', remind_at: Hp(3), priority: 'high', category: '技术' }),
  base({ id: 13, title: '确认 ical.js 在 Safari 下的时区行为', priority: 'low', category: '技术' }),
];
const SETTINGS = [{ id: 1, owner_id: 'ui-capture', nickname: '司凤', notify_enabled: true, remind_lead_minutes: 0, quiet_hours_enabled: false, quiet_start: '22:00', quiet_end: '08:00', code_upload_enabled: true, float_window_enabled: true, vs_path: null, avatar_image_id: null, review_wizard: null, updated_at: H(2) }];
const FIXTURES = { records: RECORDS, settings: SETTINGS, plugins: [], record_links: [], code_analyses: [] };
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': '*',
  'access-control-expose-headers': 'content-range,content-location',
};

const schemeOf = (page) => page.evaluate(() => document.documentElement.dataset.scheme || '(unset)');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

async function makePage(browser, scheme) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' });
  await ctx.addInitScript(([k, s, sk, sv]) => {
    try {
      localStorage.setItem(k, JSON.stringify(s));
      localStorage.setItem(sk, JSON.stringify({ v: 1, scheme: sv }));
    } catch {}
  }, [KEY, sess, 'pa.ui.scheme', scheme]);
  const page = await ctx.newPage();
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    if (url.startsWith('http://127.0.0.1')) return route.continue();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    if (!url.startsWith(ORIGIN)) return route.abort();
    const rest = url.slice(ORIGIN.length);
    if (rest.includes('/llm/models'))
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"models":[]}' });
    if (rest.includes('/version.json'))
      return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '{"version":"2.13.0"}' });
    const m = rest.match(/\/database\/rest\/([a-z_]+)/i);
    if (m) {
      if (req.method() !== 'GET')
        return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(SETTINGS) });
      const rows = FIXTURES[m[1]] ?? [];
      return route.fulfill({
        status: 200,
        headers: { ...CORS, 'content-type': 'application/json; charset=utf-8', 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` },
        body: JSON.stringify(rows),
      });
    }
    return route.fulfill({ status: 200, headers: { ...CORS, 'content-type': 'application/json' }, body: '[]' });
  });
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2200);
  return { ctx, page };
}

(async () => {
  const b = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });

  // ---------- 1. 静默方案：Ctrl+K 不应有任何面板出现 ----------
  {
    const { ctx, page } = await makePage(b, 'silent');
    check('静默方案启动后 data-scheme 正确', (await schemeOf(page)) === 'silent', await schemeOf(page));
    check('静默方案搜索框不显示 Ctrl K 角标', !(await page.locator('.MuiChip-label', { hasText: 'Ctrl K' }).count()));
    const before = await page.locator('[role="dialog"]').count();
    await page.keyboard.press('Control+k');
    await page.waitForTimeout(400);
    check('静默方案 Ctrl+K 不弹面板（不拦截浏览器原生快捷键）', (await page.locator('[role="dialog"]').count()) === before);
    await ctx.close();
  }

  // ---------- 2. 顶栏快捷入口：切到分区 → 撤销 ----------
  {
    const { ctx, page } = await makePage(b, 'silent');
    await page.getByRole('button', { name: '切换界面方案' }).click();
    await page.waitForTimeout(300);
    check('快捷入口弹出三个方案', (await page.locator('[role="menuitem"], .MuiListItemButton-root').count()) >= 3);

    await page.getByText('分区骨架', { exact: true }).click();
    await page.waitForTimeout(600);
    check('切到分区骨架后 data-scheme=zoned', (await schemeOf(page)) === 'zoned', await schemeOf(page));

    const topHasCreate = await page.locator('.MuiAppBar-root').getByRole('button', { name: /快速记录/ }).count();
    check('分区方案顶栏不再有「快速记录」（下移到页眉带）', topHasCreate === 0, `count=${topHasCreate}`);
    const bandCreate = await page.locator('main').getByRole('button', { name: /快速记录/ }).count();
    check('分区方案页眉带出现「快速记录」', bandCreate >= 1, `count=${bandCreate}`);

    // 撤销条
    const undo = page.getByRole('button', { name: '撤销' });
    check('切换后出现「撤销」提示', (await undo.count()) >= 1);
    if (await undo.count()) {
      await undo.first().click();
      await page.waitForTimeout(500);
      check('点撤销回到静默方案', (await schemeOf(page)) === 'silent', await schemeOf(page));
    }
    await ctx.close();
  }

  // ---------- 3. 流畅方案：命令面板 ----------
  {
    const { ctx, page } = await makePage(b, 'fluid');
    check('流畅方案启动后 data-scheme=fluid', (await schemeOf(page)) === 'fluid', await schemeOf(page));
    check('流畅方案搜索框显示 Ctrl K 角标', (await page.locator('.MuiChip-label', { hasText: 'Ctrl K' }).count()) > 0);

    await page.keyboard.press('Control+k');
    await page.waitForTimeout(500);
    check('Ctrl+K 打开命令面板', (await page.locator('[role="dialog"]').count()) >= 1);

    const input = page.locator('input[aria-label="命令面板输入"]');
    check('命令面板输入框自动获焦', await input.evaluate((el) => el === document.activeElement).catch(() => false));

    await input.fill('待办');
    await page.waitForTimeout(300);
    const optionCount = await page.locator('[role="option"]').count();
    check('输入关键词后结果被过滤', optionCount > 0 && optionCount < 15, `options=${optionCount}`);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    check('Esc 关闭命令面板', (await page.locator('[role="dialog"]').count()) === 0);
    await ctx.close();
  }

  // ---------- 4. 设置页：恢复默认 ----------
  {
    const { ctx, page } = await makePage(b, 'zoned');
    await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: /恢复默认方案/ }).scrollIntoViewIfNeeded();
    const disabled = await page.getByRole('button', { name: /恢复默认方案/ }).isDisabled();
    check('非默认方案下「恢复默认方案」可点击', disabled === false);
    await page.getByRole('button', { name: /恢复默认方案/ }).click();
    await page.waitForTimeout(600);
    check('恢复默认后回到 silent', (await schemeOf(page)) === 'silent', await schemeOf(page));
    check('恢复后按钮变灰（已是默认）', await page.getByRole('button', { name: /恢复默认方案/ }).isDisabled());
    await ctx.close();
  }

  await b.close();

  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} 通过`);
  process.exit(failed.length === 0 ? 0 : 1);
})();
