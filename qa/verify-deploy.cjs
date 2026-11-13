// 发布后线上验证：确认 /version.json 不再触发 CORS，且更新检测正常。
const { chromium } = require('playwright-core');

const BASE = 'https://personal-agent-08495.app.workbuddy.link';

(async () => {
  const browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: ['--no-sandbox', '--disable-gpu'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  const failed = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('requestfailed', (r) => failed.push(((r.failure() && r.failure().errorText) || '') + ' ' + r.url().slice(0, 160)));

  const versionRequests = [];
  page.on('response', (r) => {
    if (r.url().includes('/version.json')) versionRequests.push(r.status() + ' ' + r.url());
  });

  await page.goto(BASE + '/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);

  const corsErrors = consoleErrors.filter((t) => /CORS|Access-Control-Allow-Origin/i.test(t));
  const versionCors = failed.filter((t) => /version\.json/.test(t));

  console.log('VERSION_REQUESTS: ' + JSON.stringify(versionRequests));
  console.log('CORS_CONSOLE_ERRORS: ' + corsErrors.length);
  console.log('VERSION_FAILED: ' + JSON.stringify(versionCors));
  console.log('ALL_CONSOLE_ERRORS: ' + JSON.stringify(consoleErrors.slice(0, 5)));
  console.log('TITLE_SNIPPET: ' + (await page.evaluate(() => document.body.innerText.slice(0, 120))).replace(/\n/g, ' | '));

  await page.screenshot({ path: 'D:/司凤项目/personal-agent/qa/ux-shots/verify-after-deploy.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', e.message); process.exit(1); });
