/* 视觉核验截图: 绘图工具 + Bar Count + 无网格 (临时脚本)
 * NODE_PATH=... node tests/visual_check.js
 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8899';

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

  // 固定到 2024-03-15 09:35 附近, 方便对照
  await page.evaluate(() => { App.mode = 'custom'; });
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('loadingMask').style.display === 'none', { timeout: 40000 });
  await page.waitForTimeout(600);

  // 推进一段, 让图表有走势
  for (let i = 0; i < 40; i++) { await page.keyboard.press('ArrowRight'); }
  await page.waitForTimeout(400);
  await page.evaluate(() => ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: 340, to: 460 }));
  await page.waitForTimeout(300);

  const box = await page.locator('#chartMain').boundingBox();
  const P = (dx, dy) => ({ x: box.x + dx, y: box.y + dy });
  const drag = async (a, b) => {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 8 });
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };

  // 趋势线
  await page.click('#drawBar button[data-tool="trend"]');
  await drag(P(180, 420), P(430, 220));
  // 斐波那契
  await page.click('#drawBar button[data-tool="fib"]');
  await drag(P(470, 200), P(700, 330));
  // 矩形
  await page.click('#drawBar button[data-tool="rect"]');
  await drag(P(730, 380), P(860, 470));
  // 尺子
  await page.click('#drawBar button[data-tool="measure"]');
  await drag(P(200, 500), P(560, 300));

  await page.mouse.move(5, 5);
  await page.waitForTimeout(3000);      // 等 toast 自然消失, 截图干净
  await page.screenshot({ path: __dirname + '/../_shot_draw_light.png' });

  // 深色
  await page.click('#themeBtn');
  await page.waitForTimeout(500);
  await page.screenshot({ path: __dirname + '/../_shot_draw_dark.png' });
  await page.click('#themeBtn');
  await page.waitForTimeout(300);

  // 只截图表区放大看 Bar Count 序号
  const el = await page.locator('#chartArea');
  await el.screenshot({ path: __dirname + '/../_shot_chartarea.png' });

  const st = await page.evaluate(() => ({
    items: Draw.items.map(i => i.type), barCount: Draw.showBarCount, tool: Draw.tool,
  }));
  console.log('绘图状态:', JSON.stringify(st));
  await browser.close();
})();
