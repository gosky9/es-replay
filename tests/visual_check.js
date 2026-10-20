/* 视觉核验截图: 黑白盘面 + 绘图工具 + 突破单/止盈止损线 (手动运行)
 * NODE_PATH=... node tests/visual_check.js
 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8899';
const OUT = p => __dirname + '/../' + p;

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', e => console.log('PAGEERROR:', e.message));

  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const n = document.getElementById('dataRangeNote');
    return n && n.textContent && !n.textContent.includes('加载中');
  }, { timeout: 20000 });
  await page.evaluate(() => localStorage.setItem('es_replay_theme', 'light'));

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
  await page.waitForTimeout(150);

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
    lines: Draw.orderLines().map(o => o.kind),
    candle: { up: ChartMgr.candle.options().upColor, down: ChartMgr.candle.options().downColor },
  }));
  console.log('状态:', JSON.stringify(st));
  await browser.close();
  process.exit(0);
})();
