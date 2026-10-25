/* 视觉核验截图: 黑白盘面 + 绘图工具 + 突破单/止盈止损线 (手动运行)
 * NODE_PATH=... node tests/visual_check.js
 *
 * ⚠️ 这个脚本会**真的**下单、画图 —— data/journal.json 与 data/draw.json 都会被改写。
 *    所以开头备份、结尾无条件还原 (放 finally 里, 中途抛错也不留脏数据)。
 *    2026-10-25 之前没这段: 每跑一次就往 data/draw.json 里堆 3 条测试线, 而 e2e 又把它们
 *    当"用户原有存档"备份还原回去, 于是一直清不掉 (累计 9 条)。
 */
const { chromium } = require('playwright');
const { mergeJournal } = require('./archive');
const BASE = 'http://127.0.0.1:8899';
const OUT = p => __dirname + '/../' + p;
const RUN_START = Date.now();

const EMPTY_JOURNAL = { version: 1, trades: [], orders: [] };
const EMPTY_DRAW = { version: 1, byTf: {}, updatedAt: 0 };

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));

  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const n = document.getElementById('dataRangeNote');
    return n && n.textContent && !n.textContent.includes('加载中');
  }, { timeout: 20000 });

  /* ---- 存档备份 (两张都会被动) ---- */
  const backup = await page.evaluate(async ([EJ, ED]) => {
    const get = async (u, empty) => {
      try { const r = await fetch(u, { cache: 'no-store' }); return await r.json(); }
      catch (e) { return empty; }
    };
    const post = (u, body) => fetch(u, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).catch(() => { });
    const j = await get('/api/journal', EJ), d = await get('/api/draw', ED);
    await post('/api/journal', EJ); await post('/api/draw', ED);
    return { j, d };
  }, [EMPTY_JOURNAL, EMPTY_DRAW]);

  const restore = async () => {
    /* 账本走并集 (见 tests/archive.js): 备份 ∪ 创建时间早于本轮开跑的记录。
       直接覆盖会把用户在这期间自己做的交易一起抹掉 (2026-10-25 丢了 3 笔)。 */
    let cur = null;
    try {
      const r = await fetch(BASE + '/api/journal', { cache: 'no-store' });
      if (r.ok) cur = await r.json();
    } catch (e) { }
    const merged = mergeJournal(backup.j, cur, RUN_START);
    await page.evaluate(async ([j, d]) => {
      const post = (u, body) => fetch(u, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch(() => { });
      await post('/api/journal', j); await post('/api/draw', d);
    }, [merged, backup.d]).catch(() => { });
    console.log('存档已还原: journal', merged.trades.length, '笔 /', merged.orders.length, '条挂单');
  };

  try {
    await page.evaluate(() => {
      localStorage.setItem('es_replay_theme', 'light');
      /* 磁盘清了 ≠ 内存干净: boot 时已经把旧存档读进 Draw._all 了, 开始复盘时 restore()
         会把它整桶装回去 (2026-10-25: 清完磁盘还画出 9 条旧线 + 本轮 3 条)。
         图元条数是这个脚本的核对基准, 必须从 0 起算。 */
      Draw._all = { version: 1, byTf: {}, updatedAt: 0 };
      Draw.items = []; Draw.tf = null; Draw._clip = null;
      Draw.undo = []; Draw.redo = [];
      Draw.save = () => ({ });        // 跑测试期间别再把测试线写回磁盘
    });

    await page.click('#startBtn');
    await page.waitForFunction(() => document.getElementById('loadingMask').style.display === 'none', { timeout: 40000 });
    await page.waitForTimeout(600);

    // 推进一段让图表有走势
    for (let i = 0; i < 40; i++) await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const i = App.engine.idx;
      ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: i - 90, to: i + 5 });
    });
    await page.waitForTimeout(300);

    const box = await page.locator('#chartMain').boundingBox();
    const P = (dx, dy) => ({ x: box.x + dx, y: box.y + dy });
    const draw2 = async (a, b) => {
      await page.mouse.click(a.x, a.y); await page.waitForTimeout(80);
      await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
      await page.mouse.move(b.x, b.y, { steps: 6 });
      await page.mouse.click(b.x, b.y); await page.waitForTimeout(120);
    };

    // 趋势线 + 矩形 + 尺子 (照 reference/03 的尺子样式)
    await page.click('#drawBar button[data-tool="trend"]');
    await draw2(P(150, 430), P(400, 230));
    await page.click('#drawBar button[data-tool="rect"]');
    await draw2(P(440, 210), P(660, 340));
    await page.click('#drawBar button[data-tool="measure"]');
    await draw2(P(180, 500), P(520, 310));

    // 右键挂突破单 (在当前价上方约 3 格)
    const yStop = await page.evaluate(() => {
      const b = App.engine.current;
      return Draw.yOf(b.c + 1.25);
    });
    await page.mouse.click(P(700, yStop).x, P(700, yStop).y, { button: 'right' });
    await page.waitForTimeout(200);
    await page.screenshot({ path: OUT('_shot_ctxmenu.png') });
    await page.click('#ctxMenu button[data-act="buyStop"]');
    await page.waitForTimeout(200);

    /* v1.2 起「空仓开新仓必须选 setup」, 点 buyStop 会先弹 setup 弹窗把下单拦住。
       不选就一直是弹窗盖着, 后面的 #btnStepFwd 全被它挡掉 (2026-10-25 踩到:
       报 <div id="setupModal"> intercepts pointer events)。
       这里走真实 UI: 先点「突破」周期, 再点该周期清单里的第一个 setup → 弹窗关闭并执行下单。 */
    await page.click('#setupCycleSeg button[data-cycle="breakout"]');
    await page.waitForTimeout(150);
    await page.click('#setupList [data-setup]');
    await page.waitForTimeout(200);

    // 推进到成交, 让入场/止盈/止损三条线出现
    for (let i = 0; i < 40; i++) {
      if ((await page.evaluate(() => Trading.pos)) !== 0) break;
      await page.click('#btnStepFwd'); await page.waitForTimeout(70);
    }
    await page.mouse.move(5, 5);
    await page.waitForTimeout(2800);        // 等 toast 消失
    await page.screenshot({ path: OUT('_shot_bw_light.png') });

    // 只截图表区, 看清空心/实心与交易线
    await page.locator('#chartArea').screenshot({ path: OUT('_shot_bw_chartarea.png') });

    // 深色
    await page.click('#themeBtn');
    await page.waitForTimeout(600);
    await page.screenshot({ path: OUT('_shot_bw_dark.png') });
    await page.click('#themeBtn');
    await page.waitForTimeout(300);

    const st = await page.evaluate(() => ({
      items: Draw.items.map(i => i.type), pos: Trading.pos,
      tp: Trading.tp, sl: Trading.sl, stops: Trading.stops.length,
      setup: App.pendingSetup, cycle: App.pendingCycle,
      lines: Draw.orderLines().map(o => o.kind),
      candle: { up: ChartMgr.candle.options().upColor, down: ChartMgr.candle.options().downColor },
    }));
    console.log('状态:', JSON.stringify(st));
  } finally {
    await restore();
    await browser.close();
  }
  process.exit(0);
})();
