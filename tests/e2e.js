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

  /* 2. 随机复盘 (默认 5m / RTH) */
  await page.click('#startBtn');
  await waitLoaded(page);
  await page.waitForTimeout(700);
  const t1 = await page.textContent('#replayTime');
  const bc1 = await page.textContent('#barCount');
  check('回放时间显示', t1 && t1 !== '--', t1);
  check('Bar count 显示', /^\d+ \/ \d+$/.test(bc1), bc1);
  check('回放条已显示', await page.isVisible('#replayBar'));

  const defaults = await page.evaluate(() => ({
    tf: App.tf, session: App.session,
    mtf: document.getElementById('modalTf').value,
    mses: document.getElementById('modalSession').value,
    activeTf: (document.querySelector('#tfGroup button.active') || {}).dataset?.tf,
    activeSes: (document.querySelector('#sessionSeg button.active') || {}).dataset?.session,
  }));
  check('默认 5m + RTH', defaults.tf === '5m' && defaults.session === 'rth'
        && defaults.mtf === '5m' && defaults.mses === 'rth'
        && defaults.activeTf === '5m' && defaults.activeSes === 'rth', JSON.stringify(defaults));

  /* 黑白盘面: 白涨(空心) / 黑跌(实心) */
  const bw = await page.evaluate(() => {
    const o = ChartMgr.candle.options();
    return { up: o.upColor, down: o.downColor, border: o.borderUpColor, vis: o.borderVisible };
  });
  check('K线白涨黑跌(空心/实心)', bw.up === '#ffffff' && bw.down === '#131722'
        && bw.border === '#131722' && bw.vis === true, JSON.stringify(bw));

  /* Bar Count: 按当日重置 + 每 2 根显示一次 */
  const bcInfo = await page.evaluate(() => {
    const bars = App.bars, i = App.engine.idx, firsts = [];
    for (let k = 0; k <= i; k++) {
      if (bars[k].dayNo === 1) {
        const d = new Date((bars[k].epoch + bars[k].off * 3600) * 1000);
        firsts.push(d.getUTCHours() * 60 + d.getUTCMinutes());
      }
    }
    const calls = [];
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    proto.fillText = function (t, x, y) { if (/^\d+$/.test(t)) calls.push(+t); return orig.call(this, t, x, y); };
    Draw.render();
    proto.fillText = orig;
    return {
      firsts: firsts.slice(0, 8), nFirst: firsts.length,
      calls, allEven: calls.every(n => n % 2 === 0),
    };
  });
  check('Bar Count 当日首根重置为 1 (RTH 09:30)', bcInfo.nFirst > 1 && bcInfo.firsts.every(m => m === 570),
        '首根 ET 分钟 ' + JSON.stringify(bcInfo.firsts));
  check('Bar Count 每 2 根显示(只出现偶数)', bcInfo.calls.length > 3 && bcInfo.allEven,
        JSON.stringify(bcInfo.calls.slice(0, 10)));

  /* 时间戳 = ET 墙钟编码(假UTC), 与浏览器时区无关 */
  const tzOk = await page.evaluate(() => {
    const b = App.bars[0];
    return b.t - b.epoch === b.off * 3600;
  });
  check('图表时间戳按 ET 编码(不随本机时区漂移)', tzOk);

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

  /* 8. 周期切换 (顶栏快捷按钮) —— 默认已是 5m, 这里切到 15m 再验证 */
  await page.click('#tfGroup button[data-tf="15m"]');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  const bc4 = await page.textContent('#barCount');
  const tfOk = await page.evaluate(() => App.tf === '15m' && App.engine.total > 0);
  check('周期切换 15m', tfOk && /\/ \d+$/.test(bc4), bc4 + ' | 顶部标记 ' + await page.textContent('#symMeta'));

  /* 9. 时段切换 ETH → RTH */
  await page.click('#sessionSeg button[data-session="eth"]');
  await waitLoaded(page);
  await page.waitForTimeout(400);
  const ethOk = await page.evaluate(() => App.session === 'eth');
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
  check('时段切换 ETH→RTH', ethOk && rthOk && /\/ \d+$/.test(bc5), bc5 + ' @ ' + t5);
  await page.click('#tfGroup button[data-tf="5m"]');
  await waitLoaded(page);
  await page.waitForTimeout(400);

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
  check('限价单价格有效', lp > 0 && Math.abs(lp * 4 - Math.round(lp * 4)) < 1e-6, '挂单价 ' + lp);
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
  // TradingView 式两点绘制: 点第一点 → 移动 → 点第二点
  const draw2 = async (a, b) => {
    await page.mouse.click(a.x, a.y);
    await page.waitForTimeout(90);
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
    await page.mouse.move(b.x, b.y, { steps: 5 });
    await page.waitForTimeout(60);
    await page.mouse.click(b.x, b.y);
    await page.waitForTimeout(120);
  };

  // 趋势线
  await page.click('#drawBar button[data-tool="trend"]');
  const toolActive = await page.evaluate(() =>
    Draw.tool === 'trend'
    && document.querySelector('#drawBar button[data-tool="trend"]').classList.contains('active'));
  check('选中趋势线工具(两处联动)', toolActive);

  await page.mouse.click(P(260, 150).x, P(260, 150).y);
  await page.waitForTimeout(120);
  const afterFirst = await page.evaluate(() => ({ n: Draw.count(), draft: !!Draw.draft, tool: Draw.tool }));
  await page.mouse.move(P(400, 220).x, P(400, 220).y, { steps: 5 });
  await page.waitForTimeout(60);
  await page.mouse.click(P(460, 260).x, P(460, 260).y);
  await page.waitForTimeout(150);
  const afterTrend = await page.evaluate(() => ({
    n: Draw.count(), type: Draw.items[0] && Draw.items[0].type, tool: Draw.tool,
  }));
  check('第一点只起稿不落图', afterFirst.n === 0 && afterFirst.draft === true && afterFirst.tool === 'trend',
        JSON.stringify(afterFirst));
  check('第二点完成趋势线 + 回到光标',
        afterTrend.n === 1 && afterTrend.type === 'trend' && afterTrend.tool === 'cursor',
        JSON.stringify(afterTrend));

  // 尺子 (只保留最新一次)
  await page.click('#drawBar button[data-tool="measure"]');
  await draw2(P(520, 200), P(700, 320));
  const m1 = await page.evaluate(() => Draw.items.filter(i => i.type === 'measure').length);
  await page.click('#drawBar button[data-tool="measure"]');
  await draw2(P(560, 220), P(760, 300));
  const m2 = await page.evaluate(() => ({
    measures: Draw.items.filter(i => i.type === 'measure').length,
    total: Draw.count(),
  }));
  check('尺子测量创建', m1 === 1, '第一次测量 ' + m1 + ' 个');
  check('尺子只保留最新一个', m2.measures === 1 && m2.total === 2, JSON.stringify(m2));

  // 水平线 (单击完成) + 隐藏/显示
  await page.click('#drawBar button[data-tool="hline"]');
  await page.mouse.click(P(300, 400).x, P(300, 400).y);
  await page.waitForTimeout(150);
  check('水平线创建(单击完成)', await page.evaluate(() => Draw.items.some(i => i.type === 'hline')));
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
  const dayNoNow = await page.evaluate(() => App.bars[App.engine.idx].dayNo);
  check('Bar Count 默认开启 + 图例当日序号', bcOn === true && +lgBar === dayNoNow,
        'lgBarIdx=' + lgBar + ' / dayNo=' + dayNoNow);
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
  await draw2(P(300, 160), P(500, 300));
  const beforeTf = await page.evaluate(() => Draw.count());
  await page.click('#tfGroup button[data-tf="15m"]');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  check('换周期清空绘图', beforeTf === 1 && (await page.evaluate(() => Draw.count())) === 0,
        '切换前 ' + beforeTf + ' → 切换后 ' + await page.evaluate(() => Draw.count()));
  await page.click('#tfGroup button[data-tf="5m"]');
  await waitLoaded(page);
  await page.waitForTimeout(400);

  /* 15. 右键突破单 + 拖动交易线 + 止盈止损 */
  // (a) 纯逻辑: 止盈/止损/跳空成交
  const logic = await page.evaluate(() => {
    const mk = (o, h, l, c) => ({ o, h, l, c, epoch: 0, off: 0, t: 0 });
    const R = {};
    Trading.reset();
    Trading.fill('buy', 1, 100, 'market', 0, 0);
    R.longBracket = [Trading.tp, Trading.sl];
    let ev = Trading.checkBar(mk(101, 113, 100, 112), 0, 0);
    R.tp = [ev.map(e => e.kind).join(), Trading.pos, Trading.realized];

    Trading.reset();
    Trading.fill('buy', 1, 100, 'market', 0, 0);
    ev = Trading.checkBar(mk(100, 101, 93, 94), 0, 0);
    R.sl = [ev.map(e => e.kind).join(), Trading.pos, Trading.realized];

    Trading.reset();
    Trading.fill('sell', 1, 100, 'market', 0, 0);
    R.shortBracket = [Trading.tp, Trading.sl];
    ev = Trading.checkBar(mk(99, 100, 87, 88), 0, 0);
    R.shortTp = [ev.map(e => e.kind).join(), Trading.pos, Trading.realized];

    Trading.reset();
    Trading.placeStop('buy', 1, 100);
    ev = Trading.checkBar(mk(105, 108, 104, 106), 0, 0);   // 跳空高开按开盘价成交
    R.gapFill = [ev.map(e => e.type).join(), Trading.pos, Trading.avg];

    Trading.reset();
    Trading.placeStop('sell', 1, 100);
    ev = Trading.checkBar(mk(105, 108, 101, 106), 0, 0);   // 未跌破不触发
    R.notFilled = [ev.length, Trading.stops.length];
    Trading.reset();
    return R;
  });
  check('开仓自动挂 12/6 点止盈止损',
        logic.longBracket[0] === 112 && logic.longBracket[1] === 94
        && logic.shortBracket[0] === 88 && logic.shortBracket[1] === 106,
        '多 ' + JSON.stringify(logic.longBracket) + ' / 空 ' + JSON.stringify(logic.shortBracket));
  check('止盈触发平仓 +12点', logic.tp[0] === 'tp' && logic.tp[1] === 0 && logic.tp[2] === 600, JSON.stringify(logic.tp));
  check('止损触发平仓 -6点', logic.sl[0] === 'sl' && logic.sl[1] === 0 && logic.sl[2] === -300, JSON.stringify(logic.sl));
  check('空头止损位在上方', logic.shortTp[0] === 'tp' && logic.shortTp[2] === 600, JSON.stringify(logic.shortTp));
  check('突破单跳空按开盘价成交', logic.gapFill[1] === 1 && logic.gapFill[2] === 105, JSON.stringify(logic.gapFill));
  check('突破单未触及不成交', logic.notFilled[0] === 0 && logic.notFilled[1] === 1, JSON.stringify(logic.notFilled));

  // (b) UI: 右键挂单 → 拖动改价 → 推进成交 → 拖止损线
  await page.evaluate(() => { Trading.reset(); Draw.clearAll(); });
  const plan = await page.evaluate(() => {
    const i = App.engine.idx;
    const fwd = App.bars.slice(i + 1, i + 6);
    const hi = Math.max(...fwd.map(b => b.h));
    return { hi, y: Draw.yOf(hi) };
  });
  await page.mouse.click(P(420, plan.y - 2).x, P(420, plan.y - 2).y, { button: 'right' });
  await page.waitForTimeout(180);
  check('右键弹出菜单', (await page.evaluate(() => document.getElementById('ctxMenu').style.display)) === 'block');
  await page.click('#ctxMenu button[data-act="buyStop"]');
  await page.waitForTimeout(150);
  const stopState = await page.evaluate(() => ({ stops: Trading.stops, kinds: Draw.orderLines().map(o => o.kind) }));
  check('右键挂突破买单', stopState.stops.length === 1 && stopState.kinds.includes('stop'), JSON.stringify(stopState.stops));

  // 拖动挂单线改价 (按住挂单线上方 0px 处向下拖 30px)
  const before = await page.evaluate(() => Trading.stops[0].price);
  await page.mouse.move(P(500, plan.y - 2).x, P(500, plan.y - 2).y);
  await page.mouse.down();
  await page.mouse.move(P(560, plan.y + 12).x, P(560, plan.y + 12).y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const afterDrag = await page.evaluate(() => Trading.stops[0] ? Trading.stops[0].price : null);
  check('拖动挂单线改价', afterDrag != null && afterDrag < before, before + ' → ' + afterDrag);

  // 推进直到成交
  let filled = false;
  for (let i = 0; i < 12; i++) {
    await page.click('#btnStepFwd');
    await page.waitForTimeout(70);
    if ((await page.evaluate(() => Trading.pos)) !== 0) { filled = true; break; }
  }
  const afterFill = await page.evaluate(() => ({
    pos: Trading.pos, avg: Trading.avg, tp: Trading.tp, sl: Trading.sl,
    kinds: Draw.orderLines().map(o => o.kind),
  }));
  check('突破单成交并出现止盈止损线', filled && afterFill.kinds.includes('entry')
        && afterFill.kinds.includes('tp') && afterFill.kinds.includes('sl'), JSON.stringify(afterFill));

  // 拖动止损线
  const slY = await page.evaluate(() => Draw.yOf(Trading.sl));
  const slBefore = await page.evaluate(() => Trading.sl);
  await page.mouse.move(P(700, slY).x, P(700, slY).y);
  await page.mouse.down();
  await page.mouse.move(P(700, slY + 36).x, P(700, slY + 36).y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const slAfter = await page.evaluate(() => Trading.sl);
  check('拖动止盈止损线调整', slAfter !== slBefore && Math.abs(slAfter - slBefore) > 0.5,
        slBefore + ' → ' + slAfter);

  // 统计与交易记录
  check('交易记录已生成', (await page.evaluate(() => Trading.trades.length)) >= 1,
        await page.textContent('#stWin'));
  await page.evaluate(() => { Trading.reset(); Draw.clearAll(); });

  /* 16. 主题切换 */
  await page.click('#themeBtn');
  await page.waitForTimeout(400);
  const theme1 = await page.evaluate(() => document.body.dataset.theme);
  const bg1 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const darkCandle = await page.evaluate(() => {
    const o = ChartMgr.candle.options();
    return { up: o.upColor, down: o.downColor };
  });
  check('切换到深色主题', theme1 === 'dark' && bg1 === 'rgb(19, 23, 34)', theme1 + ' / ' + bg1);
  check('深色下黑白盘面镜像', darkCandle.up === '#131722' && darkCandle.down === '#d1d4dc',
        JSON.stringify(darkCandle));
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
