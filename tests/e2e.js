/* ES 复盘练习 · 端到端自测 (Playwright + 系统 Chrome)
 * 运行: NODE_PATH=C:/Users/gosky9/.workbuddy/binaries/node/workspace/node_modules \
 *       node tests/e2e.js
 * 前置: server.py 已在 127.0.0.1:8899 运行
 */
const { chromium } = require('playwright');

const BASE = 'http://127.0.0.1:8899';
const SHOT = __dirname + '/../_shot_main.png';
const SHOT_DARK = __dirname + '/../_shot_dark.png';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log((ok ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : ''));
}
const num = s => +(String(s).split('/')[0].trim());
const waitLoaded = page => page.waitForFunction(
  () => document.getElementById('loadingMask').style.display === 'none', { timeout: 40000 });

(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  /* 1. 加载 */
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const n = document.getElementById('dataRangeNote');
    return n && n.textContent && !n.textContent.includes('加载中') && !n.textContent.includes('失败');
  }, { timeout: 20000 });
  check('meta.json 加载', true, (await page.textContent('#dataRangeNote')).slice(0, 56));
  check('开始弹窗显示', await page.isVisible('#startModal'));

  const theme0 = await page.evaluate(() => document.body.dataset.theme);
  const bg0 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('默认浅色主题(TradingView 默认)', theme0 === 'light' && bg0 === 'rgb(255, 255, 255)', theme0 + ' / ' + bg0);

  await page.evaluate(() => localStorage.clear());

  /* 2. 随机复盘 (默认 ETH 1m) */
  await page.click('#startBtn');
  await waitLoaded(page);
  await page.waitForTimeout(700);
  const t1 = await page.textContent('#replayTime');
  const bc1 = await page.textContent('#barCount');
  check('回放时间显示', t1 && t1 !== '--', t1);
  check('Bar count 显示', /^\d+ \/ \d+$/.test(bc1), bc1);
  check('回放条已显示', await page.isVisible('#replayBar'));

  const dim = await page.evaluate(() => {
    const c = document.querySelector('#chartMain canvas');
    return c ? { w: c.clientWidth, h: c.clientHeight } : null;
  });
  check('图表 canvas 尺寸', !!dim && dim.w > 1000 && dim.h > 500, JSON.stringify(dim));

  /* 3. 无 TradingView logo */
  const hasLogo = await page.evaluate(() =>
    !!document.querySelector('#chartMain a[href*="tradingview" i], #chartMain a[href*="TradingView"]'));
  check('左下角无 TradingView logo', !hasLogo);

  /* 4. EMA20 */
  const emaOk = await page.evaluate(() => {
    const b = App.bars;
    return b.length > 100 && App.engine.idx > 50 && b[50].ema != null && isFinite(b[50].ema);
  });
  check('EMA20 因果计算', emaOk);

  /* 5. 播放 / 单步 */
  await page.click('#btnPlay');
  await page.waitForTimeout(2500);
  const bc2 = await page.textContent('#barCount');
  await page.click('#btnPlay');
  await page.waitForTimeout(450);          // 等残留 tick 结束, 避免读数漂移
  const bc2b = await page.textContent('#barCount');
  await page.click('body');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const bc3 = await page.textContent('#barCount');
  check('播放推进', num(bc2) > num(bc1), bc1 + ' → ' + bc2);
  check('键盘单步', num(bc3) === num(bc2b) + 1, bc2b + ' → ' + bc3);

  /* 6. 视窗保持 —— 用户拖动到中间后点下一根, 视窗不能被重置 */
  await page.evaluate(() => ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: 20, to: 140 }));
  await page.waitForTimeout(150);
  const dragged = await page.evaluate(() => ChartMgr.visibleRange());
  await page.click('#btnStepFwd');
  await page.waitForTimeout(300);
  const afterStep = await page.evaluate(() => ChartMgr.visibleRange());
  const kept = afterStep && dragged &&
    Math.abs(afterStep.from - dragged.from) < 1.5 && Math.abs(afterStep.to - dragged.to) < 1.5;
  check('拖动后步进不重置视窗', kept,
        '拖动 [' + dragged.from.toFixed(1) + ',' + dragged.to.toFixed(1) + '] → 步进后 [' +
        afterStep.from.toFixed(1) + ',' + afterStep.to.toFixed(1) + ']');

  // 反向: 跟随态(视窗右端贴着最新 bar)下连续步进, 新 bar 必须始终留在视窗内
  const N = await page.evaluate(() => App.engine.idx + 1);
  await page.evaluate(n => ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: n - 20, to: n + 2 }), N);
  await page.waitForTimeout(150);
  let allVisible = true, detail = [];
  for (let i = 0; i < 8; i++) {
    await page.click('#btnStepFwd');
    await page.waitForTimeout(120);
    const st = await page.evaluate(() => {
      const r = ChartMgr.visibleRange();
      const last = App.engine.idx + 1;
      return { right: r ? r.to : null, last };
    });
    const ok = st.right != null && st.right >= st.last - 0.6;
    if (!ok) allVisible = false;
    if (i % 3 === 0) detail.push('右端 ' + Number(st.right).toFixed(1) + ' / 最新 ' + st.last);
  }
  check('跟随态下新 bar 始终可见', allVisible, detail.join(' | '));

  /* 7. 下单 / 盈亏 / 平仓 */
  await page.click('#btnBuy');
  await page.waitForTimeout(250);
  check('买入开仓', (await page.textContent('#stPos')).includes('多'),
        await page.textContent('#stPos') + ' 记录' + await page.textContent('#tradeCount'));
  check('成交标记', (await page.evaluate(() => ChartMgr.markers.length)) === 1);
  check('浮动盈亏', /\$/.test(await page.textContent('#stFloat')), await page.textContent('#stFloat'));

  await page.click('#btnClose');
  await page.waitForTimeout(250);
  check('平仓归零', (await page.textContent('#stPos')) === '0 手', await page.textContent('#stPos'));
  const real = await page.textContent('#stReal');
  check('已实现盈亏', /\$/.test(real) && real !== '-', real + ' / 合计 ' + await page.textContent('#stTotal'));
  check('胜率统计', /笔/.test(await page.textContent('#stWin')), await page.textContent('#stWin'));

  /* 8. 周期切换 (顶栏快捷按钮) */
  await page.click('#tfGroup button[data-tf="5m"]');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  const bc4 = await page.textContent('#barCount');
  const tfOk = await page.evaluate(() => App.tf === '5m' && App.engine.total > 0);
  check('周期切换 5m', tfOk && /\/ \d+$/.test(bc4), bc4 + ' | 顶部标记 ' + await page.textContent('#symMeta'));

  /* 9. 时段切换 RTH */
  await page.click('#sessionSeg button[data-session="rth"]');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  const bc5 = await page.textContent('#barCount');
  const t5 = await page.textContent('#replayTime');
  const rthOk = await page.evaluate(() => {
    const b = App.bars[App.engine.idx];
    const d = new Date((b.epoch + b.off * 3600) * 1000);
    const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
    return mins >= 570 && mins < 960;
  });
  check('时段切换 RTH', rthOk && /\/ \d+$/.test(bc5), bc5 + ' @ ' + t5);

  /* 10. 自选复盘 2024-03-15 09:35 ET */
  await page.click('#customBtn');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  const t6 = await page.textContent('#replayTime');
  check('自选起点=2024-03-15', t6.startsWith('2024-03-15'), t6);

  /* 11. 随机复盘 + 会话重置 */
  await page.click('#randomBtn');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  const t7 = await page.textContent('#replayTime');
  check('随机复盘新会话', t7 && t7 !== '--' && !t7.startsWith('2024-03-15'), t7);
  check('新会话重置交易', (await page.textContent('#stPos')) === '0 手', await page.textContent('#stPos'));

  /* 12. 限价单 */
  await page.click('#typeSeg button[data-type="limit"]');
  // 挂单价取"未来 6 根的最低价"向上取整到 0.25 tick —— 保证一定会被回踩成交(不靠运气)
  const lp = await page.evaluate(() => {
    const i = App.engine.idx;
    const fwd = App.bars.slice(i + 1, i + 7);
    if (!fwd.length) return 0;
    const lo = Math.min(...fwd.map(b => b.l));
    return Math.ceil(lo * 4) / 4;
  });
  check('限价低于当前价(买挂单)', lp > 0 && lp <= await page.evaluate(() => App.engine.current.c) + 0.25, '挂单价 ' + lp);
  await page.fill('#limitPrice', String(lp));
  await page.click('#btnBuy');
  await page.waitForTimeout(250);
  check('限价挂单', await page.evaluate(() => (App._limits || []).length === 1), '挂单价 ' + lp);
  for (let i = 0; i < 10; i++) {
    if ((await page.evaluate(() => App._limits || [])).length === 0) break;
    await page.click('#btnStepFwd');
    await page.waitForTimeout(70);
  }
  const limitFilled = await page.evaluate(() => App._limits.length === 0 && Trading.pos !== 0);
  check('限价成交', limitFilled, '持仓=' + await page.textContent('#stPos'));
  if (limitFilled) await page.click('#btnClose');
  await page.click('#typeSeg button[data-type="market"]');

  /* 13. Go to 跳转 */
  await page.fill('#gotoInput', '2024-03-15 11:00');
  await page.click('#gotoBtn');
  await page.waitForTimeout(1200);
  const t8 = await page.textContent('#replayTime');
  check('Go to 跳转到指定时间', t8.startsWith('2024-03-15 11:'), t8);

  /* 14. 绘图工具 (收藏横条 + 尺子 + 删除 + Bar Count) */
  const gridOff = await page.evaluate(() => {
    const o = ChartMgr.chart.options();
    return !!(o.grid && o.grid.vertLines && o.grid.vertLines.visible === false
              && o.grid.horzLines && o.grid.horzLines.visible === false);
  });
  check('背景无网格线', gridOff);

  check('收藏工具横条可见', await page.isVisible('#drawBar'));
  const dbarN = await page.evaluate(() => document.querySelectorAll('#drawBar button[data-tool]').length);
  check('收藏横条按钮数', dbarN >= 11, String(dbarN) + ' 个');

  const box = await page.locator('#chartMain').boundingBox();
  const P = (dx, dy) => ({ x: box.x + dx, y: box.y + dy });
  const drag = async (a, b) => {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(120);
  };

  // 趋势线
  await page.click('#drawBar button[data-tool="trend"]');
  const toolActive = await page.evaluate(() =>
    Draw.tool === 'trend'
    && document.querySelector('#drawBar button[data-tool="trend"]').classList.contains('active'));
  check('选中趋势线工具(两处联动)', toolActive);
  await drag(P(260, 150), P(460, 260));
  const afterTrend = await page.evaluate(() => ({
    n: Draw.count(), type: Draw.items[0] && Draw.items[0].type, tool: Draw.tool,
  }));
  check('画趋势线 + 画完回到光标',
        afterTrend.n === 1 && afterTrend.type === 'trend' && afterTrend.tool === 'cursor',
        JSON.stringify(afterTrend));

  // 尺子 (只保留最新一次)
  await page.click('#drawBar button[data-tool="measure"]');
  await drag(P(520, 200), P(700, 320));
  const m1 = await page.evaluate(() => Draw.items.filter(i => i.type === 'measure').length);
  await page.click('#drawBar button[data-tool="measure"]');
  await drag(P(560, 220), P(760, 300));
  const m2 = await page.evaluate(() => ({
    measures: Draw.items.filter(i => i.type === 'measure').length,
    total: Draw.count(),
  }));
  check('尺子测量创建', m1 === 1, '第一次测量 ' + m1 + ' 个');
  check('尺子只保留最新一个', m2.measures === 1 && m2.total === 2, JSON.stringify(m2));

  // 水平线 + 隐藏/显示
  await page.click('#drawBar button[data-tool="hline"]');
  await drag(P(300, 400), P(302, 401));
  check('水平线创建', await page.evaluate(() => Draw.items.some(i => i.type === 'hline')));
  await page.click('#drawBar button[data-tool="hide"]');
  const hid1 = await page.evaluate(() => Draw.hidden);
  await page.click('#drawBar button[data-tool="hide"]');
  const hid2 = await page.evaluate(() => Draw.hidden);
  check('隐藏/显示绘图切换', hid1 === true && hid2 === false);

  // 选中并删除 (Delete)
  await page.click('#drawBar button[data-tool="cursor"]');
  await page.mouse.click(P(360, 205).x, P(360, 205).y);   // 趋势线中点
  const sel = await page.evaluate(() => Draw.selected);
  check('点击选中已有绘图', sel != null, 'selected=' + sel);
  await page.keyboard.press('Delete');
  await page.waitForTimeout(150);
  check('Delete 删除选中绘图', await page.evaluate(() => Draw.count() === 2), '剩余 ' + await page.evaluate(() => Draw.count()));

  // Bar Count (先把鼠标移出图表, 让图例回到"最新一根"的静态值)
  await page.mouse.move(5, 5);
  await page.waitForTimeout(200);
  const bcOn = await page.evaluate(() => Draw.showBarCount);
  const lgBar = await page.textContent('#lgBarIdx');
  const lgEma = await page.textContent('#lgEma');
  const idxNow = await page.evaluate(() => App.engine.idx + 1);
  check('Bar Count 默认开启 + 图例序号', bcOn === true && +lgBar === idxNow, 'lgBarIdx=' + lgBar + ' / idx+1=' + idxNow);
  check('图例 EMA 值', /^\d+\.\d{2}$/.test(lgEma), lgEma);
  await page.click('#drawBar button[data-tool="barcount"]');
  await page.waitForTimeout(120);
  check('关闭 Bar Count 后隐藏图例行',
        (await page.evaluate(() => Draw.showBarCount)) === false
        && (await page.evaluate(() => document.getElementById('lgBarRow').classList.contains('hidden-row'))));
  await page.click('#drawBar button[data-tool="barcount"]');

  // 一键删除全部绘图
  await page.click('#drawBar button[data-tool="trash"]');
  await page.waitForTimeout(120);
  check('一键删除全部绘图', (await page.evaluate(() => Draw.count())) === 0);

  // 换周期后绘图清空 (时间轴刻度变了, 锚点失效)
  await page.click('#drawBar button[data-tool="trend"]');
  await drag(P(300, 160), P(500, 300));
  const beforeTf = await page.evaluate(() => Draw.count());
  await page.click('#tfGroup button[data-tf="15m"]');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  check('换周期清空绘图', beforeTf === 1 && (await page.evaluate(() => Draw.count())) === 0,
        '切换前 ' + beforeTf + ' → 切换后 ' + await page.evaluate(() => Draw.count()));
  await page.click('#tfGroup button[data-tf="1m"]');
  await waitLoaded(page);
  await page.waitForTimeout(400);

  /* 15. 主题切换 */
  await page.click('#themeBtn');
  await page.waitForTimeout(400);
  const theme1 = await page.evaluate(() => document.body.dataset.theme);
  const bg1 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('切换到深色主题', theme1 === 'dark' && bg1 === 'rgb(19, 23, 34)', theme1 + ' / ' + bg1);
  await page.screenshot({ path: SHOT_DARK });
  await page.click('#themeBtn');
  await page.waitForTimeout(400);
  check('切回浅色主题', (await page.evaluate(() => document.body.dataset.theme)) === 'light');

  /* 15. 截图 + 错误汇总 */
  await page.click('#btnRestart');
  await page.waitForTimeout(500);
  await page.screenshot({ path: SHOT });
  check('截图保存', true, SHOT);
  check('无 console 错误', errors.length === 0, errors.slice(0, 3).join(' ; '));

  await browser.close();
  const fails = results.filter(r => !r.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} 通过 ====`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E 异常:', e); process.exit(2); });
