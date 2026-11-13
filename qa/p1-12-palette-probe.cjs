// 命令面板 P1-12 上半 · 真实浏览器探针（只读：不改产品代码、不写库）。
//
// 用法：
//   1) 先起静态服务：cd web && npx vite preview --port 4173
//   2) node qa/p1-12-palette-probe.cjs [baseUrl]
//   环境变量 UB_PUBKEY = web/.env 里的 VITE_CLOUD_PUBLISHABLE_KEY（用于注入假会话键名）
//
// 为什么需要它：
//   验收句里有两条**只能在浏览器里量**——「任意页面 Ctrl+K **2 帧内**出面板」与
//   「↑↓ + Enter 可跳转」。单测只能钉住纯函数与源码接线（见 `qa/p1-12-command-palette.test.ts`），
//   真正的帧数必须用 rAF 计时。
//
// 判定口径（写死，避免自欺）：
//   - 帧数 = 从 keydown 到 `[role="listbox"]` 出现在 DOM 的 rAF 次数，≤ 2 算过；
//   - 跳转 = 按 Enter 后 `location.pathname` 变成目标路由（不是「看起来高亮了」）。
const { chromium } = require('playwright-core');

const BASE = process.argv[2] || 'http://localhost:4173';
const PUB = process.env.UB_PUBKEY || '';
const SESSION_KEY = `workbuddy-cloud.session.${PUB}`;
const SCHEME_KEY = 'pa.ui.scheme';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function fakeSession() {
  return {
    accessToken: 'palette-probe-token',
    refreshToken: 'palette-probe-refresh',
    expiresAt: 4102444800000,
    user: { id: 'palette-probe-user', phone: '+86 10000000000', username: 'probe' },
  };
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  process.stdout.write(`[palette-probe] ${ok ? 'PASS' : 'FAIL'} ${name} — ${JSON.stringify(detail)}\n`);
}

(async () => {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, locale: 'zh-CN' });
  await ctx.addInitScript(
    ([sessKey, sess, schemeKey]) => {
      try {
        window.localStorage.setItem(sessKey, JSON.stringify(sess));
        // 命令面板是「流畅优先」方案的能力位，默认 silent 方案下 Ctrl+K 不注册（设计如此）
        window.localStorage.setItem(schemeKey, JSON.stringify({ v: 1, scheme: 'fluid' }));
      } catch {
        /* ignore */
      }
    },
    [SESSION_KEY, fakeSession(), SCHEME_KEY],
  );

  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)));

  // 每个页面都要验「任意页面能开」：抽三个不同壳层状态（首页 / 带 query 的记录页 / 设置页）
  for (const route of ['/', '/records?type=idea', '/settings']) {
    await page.goto(BASE + route, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('main', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(500);

    // rAF 计时器：从 Ctrl+K 按下起数帧，直到 listbox 出现
    await page.evaluate(() => {
      window.__paletteProbe = { frames: -1, ms: -1 };
      window.addEventListener(
        'keydown',
        (e) => {
          if (!(e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey))) return;
          const t0 = performance.now();
          let frames = 0;
          const tick = () => {
            frames += 1;
            if (document.querySelector('[role="listbox"]')) {
              window.__paletteProbe = { frames, ms: Math.round(performance.now() - t0) };
              return;
            }
            if (frames > 180) return; // 3s 还没出来就算失败（frames 保持 -1）
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        },
        true, // capture：先于应用监听记录起点
      );
    });

    await page.keyboard.press('Control+K');
    await page.waitForTimeout(400);
    const probe = await page.evaluate(() => window.__paletteProbe);
    const visible = await page.isVisible('[role="listbox"]');
    record(`${route} · Ctrl+K 开面板`, visible && probe.frames > 0 && probe.frames <= 2, {
      frames: probe.frames,
      ms: probe.ms,
      visible,
    });

    // 关掉，避免污染下一个页面
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  }

  // ↑↓ + Enter 跳转（在记录页上做，落地路由要变）
  await page.goto(BASE + '/records?type=idea', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);

  /** 开面板并等到输入框真正拿到焦点（否则方向键会落在 body 上，测出假失败）。 */
  const openPalette = async () => {
    await page.keyboard.press('Control+K');
    await page.waitForSelector('[role="listbox"]', { timeout: 5000 });
    await page.waitForFunction(
      () => document.activeElement?.getAttribute('aria-label') === '命令面板输入',
      { timeout: 3000 },
    );
  };
  const selectedText = () =>
    page.evaluate(
      () => document.querySelector('[role="option"][aria-selected="true"]')?.textContent || '',
    );

  const beforeEnter = page.url();
  await openPalette();
  const focusMs = await page.evaluate(() => performance.now()); // 仅用于日志对齐，不参与判定
  await page.keyboard.press('ArrowDown'); // 无高亮 → 第 1 条（动作组：快速记录）
  const firstActive = await selectedText();
  record('↓ 从无高亮落在第 1 条（动作组）', firstActive.includes('快速记录'), {
    firstActive,
    openAt: Math.round(focusMs),
  });

  // Esc 关掉，换一个干净的面板验过滤 + 跳转
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  await openPalette();
  await page.locator('input[aria-label="命令面板输入"]').fill('待办');
  await page.waitForTimeout(200);
  const filtered = await page.$$eval('[role="option"]', (els) =>
    els.map((e) => (e.textContent || '').trim()),
  );
  const cleared = await page.evaluate(
    () => document.querySelector('[role="option"][aria-selected="true"]') === null,
  );
  record(
    '输入即过滤（16 → 命中项），且高亮复位为无',
    filtered.length > 0 && filtered.length < 16 && cleared,
    { filtered, cleared },
  );

  await page.keyboard.press('ArrowUp'); // 无高亮 ↑ → 最后一条 = 跳转到「待办」
  const lastActive = await selectedText();
  record('↑ 从无高亮落在最后一条（跳转组）', lastActive.includes('跳转到「待办」'), { lastActive });

  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const afterEnter = page.url();
  record('Enter 执行高亮项并跳转', !/\/records/.test(afterEnter) && /\/todo/.test(afterEnter), {
    beforeEnter,
    afterEnter,
  });
  const stillOpen = await page.isVisible('[role="listbox"]').catch(() => false);
  record('执行后自动关闭面板', !stillOpen, { stillOpen });

  // Esc 关闭且不跳转
  await openPalette();
  const urlBeforeEsc = page.url();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  const closedByEsc = !(await page.isVisible('[role="listbox"]').catch(() => false));
  record('Esc 关闭且不执行高亮项', closedByEsc && page.url() === urlBeforeEsc, {
    closedByEsc,
    sameUrl: page.url() === urlBeforeEsc,
  });

  // 11-13 新增：面板内输入不得冒泡成全局快捷键（G→T 跳待办 / ? 开速查 / / 聚焦检索）
  await page.goto(BASE + '/settings', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('main', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400);
  await openPalette();
  const urlBeforeTyping = page.url();
  await page.keyboard.type('gt?', { delay: 40 });
  await page.waitForTimeout(500);
  const afterTyping = page.url();
  const paletteStillOpen = await page.isVisible('[role="listbox"]').catch(() => false);
  const keywordValue = await page.inputValue('input[aria-label="命令面板输入"]');
  const helpOpen = await page.isVisible('#shortcut-help-title').catch(() => false);
  record('面板内输入不触发全局快捷键（G→T / ? / 均被输入框吃掉）', afterTyping === urlBeforeTyping && paletteStillOpen && keywordValue === 'gt?' && !helpOpen, {
    before: urlBeforeTyping,
    after: afterTyping,
    keywordValue,
    paletteStillOpen,
    helpOpen,
  });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);

  record('全程无页面级 JS 错误', errors.length === 0, { errors: errors.slice(0, 3) });

  await browser.close();

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(
    `\n[palette-probe] ${results.length - failed.length}/${results.length} 通过${failed.length ? ' · 失败：' + failed.map((f) => f.name).join(' / ') : ''}\n`,
  );
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  process.stderr.write('[palette-probe] 探针异常：' + String(e && e.message) + '\n');
  process.exit(2);
});
