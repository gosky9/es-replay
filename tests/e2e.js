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
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message + ' @ ' + String(e.stack || '').split('\n')[1]));

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

  /* 刚进来: 默认显示 100 根 (用户要求, 原来 180 根太挤) */
  const initBars = await page.evaluate(() => {
    const lr = ChartMgr.visibleRange();
    const n = ChartMgr._lastData.length;
    return Math.round(Math.min(n - 1, lr.to) - Math.max(0, lr.from));
  });
  check('刚进来显示 100 根 K 线', initBars === 100, initBars + ' 根');

  /* 刚进来: K 线靠左 2/3, 右侧 1/3 留白 (不再贴死右边缘) */
  const blankPct = () => page.evaluate(() => {
    const ts = ChartMgr.chart.timeScale();
    const last = ChartMgr._lastData[ChartMgr._lastData.length - 1];
    const x = ts.timeToCoordinate(last.t);
    const plotR = Draw.W - Draw._axisWidth() - 8;
    return x == null ? null : ((plotR - x) / plotR) * 100;
  });
  const blankInit = await blankPct();
  check('刚进来右侧留白约 1/3',
        blankInit != null && blankInit > 28 && blankInit < 38,
        '空白 ' + (blankInit == null ? '—' : blankInit.toFixed(1)) + '%');

  /* 黑白盘面: 白涨(空心) / 黑跌(实心) */
  const bw = await page.evaluate(() => {
    const o = ChartMgr.candle.options();
    return { up: o.upColor, down: o.downColor, border: o.borderUpColor, vis: o.borderVisible };
  });
  check('K线白涨黑跌(空心/实心)', bw.up === '#ffffff' && bw.down === '#131722'
        && bw.border === '#131722' && bw.vis === true, JSON.stringify(bw));

  /* Bar Count: 按当日重置 + 每 2 根显示一次 */
  const bcInfo = await page.evaluate(async () => {
    const bars = App.bars, i = App.engine.idx, firsts = [];
    for (let k = 0; k <= i; k++) {
      if (bars[k].dayNo === 1) {
        const d = new Date((bars[k].epoch + bars[k].off * 3600) * 1000);
        firsts.push(d.getUTCHours() * 60 + d.getUTCMinutes());
      }
    }
    /* 数字现在由 series 图元在图表自己的渲染循环里画, 所以不能靠 Draw.render() 触发,
       要请求重画一帧再等它真的画完(两个 rAF: 一个是库的排帧, 一个是合成帧)。 */
    const calls = [];
    const proto = CanvasRenderingContext2D.prototype;
    const orig = proto.fillText;
    proto.fillText = function (t, x, y) {
      if (/^\d+$/.test(t) && +t > 0 && +t <= 400) calls.push(+t);   // 排除坐标轴年份等纯数字刻度
      return orig.call(this, t, x, y);
    };
    ChartMgr.refreshBarCount();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
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

  /* Bar Count 几何: 照 reference/20 逐像素实测 calibrate
     —— 数字墨迹高 15 device px(=11px 常规字重), 顶端距 K 线低点固定 24.4 CSS px, 水平居中于 K 线 */
  const bcGeo = await page.evaluate(async () => {
    const bars = ChartMgr._lastData, ts = ChartMgr.chart.timeScale();
    const lr = ts.getVisibleLogicalRange();
    const cands = [];
    for (let i = Math.max(0, Math.ceil(lr.from) + 1); i < Math.min(bars.length, lr.to - 1); i++) {
      const b = bars[i];
      if (!b.dayNo || b.dayNo % 2 || b.dayNo > 400) continue;
      const x = ts.logicalToCoordinate(i), y = ChartMgr.candle.priceToCoordinate(b.l);
      if (x != null && y != null && x > 20 && y > 40) cands.push({ n: b.dayNo, x, y });
    }
    const proto = CanvasRenderingContext2D.prototype, orig = proto.fillText, got = [];
    proto.fillText = function (t, x, y) {
      if (/^\d+$/.test(String(t))) got.push({ t: +t, x, y, font: this.font, fill: String(this.fillStyle) });
      return orig.apply(this, arguments);
    };
    ChartMgr.refreshBarCount();
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    proto.fillText = orig;

    const orange = got.filter(g => g.fill === '#ff9800' || g.fill === '#ffab40');
    const c2 = document.createElement('canvas').getContext('2d');
    const rows = [];
    for (const g of orange) {
      const m = cands.find(c => c.n === g.t && Math.abs(c.x - g.x) < 1.5);
      if (!m) continue;
      c2.font = g.font;                                   // 用同一字体量出数字墨迹高
      const capH = c2.measureText('0').actualBoundingBoxAscent;
      // canvas 读回 font 时会把默认字重 400 省掉, 所以没有权重前缀就等于 400
      const wm = /^(\d+)\s/.exec(g.font);
      rows.push({ n: g.t, gap: +(g.y - capH - m.y).toFixed(2), dx: +(g.x - m.x).toFixed(2),
                  font: g.font, weight: wm ? wm[1] : '400' });
    }
    return { rows, n: orange.length };
  });
  const bcR0 = bcGeo.rows[0];
  check('Bar Count 字号 = 11px 常规字重 (实测墨迹高 15 device px, 字干 2 device px)',
        !!bcR0 && /(^|\s)11px/.test(bcR0.font) && bcR0.weight === '400',
        bcR0 ? bcR0.font : '没抓到数字绘制');
  check('Bar Count 数字顶端距 K 线低点 24.4px (reference/20 实测 48.8 device px)',
        bcGeo.rows.length > 2 && bcGeo.rows.every(r => Math.abs(r.gap - 24.4) < 0.8),
        JSON.stringify(bcGeo.rows.map(r => r.gap)));
  check('Bar Count 数字水平居中于 K 线',
        bcGeo.rows.length > 2 && bcGeo.rows.every(r => Math.abs(r.dx) < 0.6),
        JSON.stringify(bcGeo.rows.map(r => r.dx)));

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

  /* 交易线上的牌子按"点"显示 (不是美元): 1 点 = $50, 所以点数 = 价格差 */
  const ptsChip = await page.evaluate(() => {
    const e = Draw.orderLines().find(o => o.key === 'entry');
    const last = ChartMgr._lastData[ChartMgr._lastData.length - 1].c;
    return {
      txt: Draw._fmtPts(e.pts), pts: e.pts, plUsdLeft: e.pl,
      expect: Trading.pos > 0 ? last - Trading.avg : Trading.avg - last,
    };
  });
  check('盈亏牌子显示"点"而不是美元',
        /点$/.test(ptsChip.txt) && !/USD/.test(ptsChip.txt)
        && ptsChip.plUsdLeft === undefined
        && Math.abs(ptsChip.pts - ptsChip.expect) < 1e-9,
        ptsChip.txt + ' / pts=' + ptsChip.pts.toFixed(2));

  /* 配色按国际惯例: 多=绿 / 空=红, 盈=绿 / 亏=红 */
  const cls = await page.evaluate(() => {
    const g = id => getComputedStyle(document.getElementById(id)).backgroundColor;
    // 盈亏/买卖的类名靠样式表决定颜色, 用临时节点取样, 不依赖此刻恰好有盈利和亏损单
    const probe = (html, sel) => {
      const box = document.createElement('div');
      box.innerHTML = html;
      document.body.appendChild(box);
      const c = getComputedStyle(box.querySelector(sel)).color;
      box.remove();
      return c;
    };
    return {
      buy: g('btnBuy'), sell: g('btnSell'),
      pnlUp: probe('<span class="stat-v up">x</span>', '.stat-v.up'),
      pnlDown: probe('<span class="stat-v down">x</span>', '.stat-v.down'),
      sideBuy: probe('<div class="trade-item"><span class="t-side buy">x</span></div>', '.t-side.buy'),
      sideSell: probe('<div class="trade-item"><span class="t-side sell">x</span></div>', '.t-side.sell'),
      legendSell: g('lgSellBtn'),
    };
  });
  const GREEN = 'rgb(8, 153, 129)', RED = 'rgb(242, 54, 69)';
  check('配色国际化(买入绿/卖出红)',
        cls.buy === GREEN && cls.sell === RED && cls.sideBuy === GREEN && cls.sideSell === RED,
        JSON.stringify({ buy: cls.buy, sell: cls.sell }));
  check('配色国际化(盈利绿/亏损红)',
        cls.pnlUp === GREEN && cls.pnlDown === RED, JSON.stringify({ up: cls.pnlUp, down: cls.pnlDown }));

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
  check('周期切换 15m', tfOk && /\/ \d+$/.test(bc4), bc4 + ' | 图例周期 ' + await page.textContent('#lgTf'));

  /* 8.5 换周期后 K 线停在左侧 2/3, 右侧 1/3 留白 */
  const blankAfterTf = await blankPct();
  check('换周期后右侧留白约 1/3',
        blankAfterTf != null && blankAfterTf > 28 && blankAfterTf < 38,
        '空白 ' + (blankAfterTf == null ? '—' : blankAfterTf.toFixed(1)) + '%');

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
  await page.click('#symbolBlock');
  await page.waitForTimeout(120);
  await page.click('#startBtn');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  const t6 = await page.textContent('#replayTime');
  check('自选起点=2024-03-15', t6.startsWith('2024-03-15'), t6);

  /* 11. 随机复盘 + 会话重置 (弹窗现在默认「继续上次」, 这里明确选随机) */
  await page.click('#replayPillBtn');
  await page.waitForTimeout(120);
  await page.click('#modeSeg button[data-mode="random"]');
  await page.click('#startBtn');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  const t7 = await page.textContent('#replayTime');
  check('随机复盘新会话', t7 && t7 !== '--' && !t7.startsWith('2024-03-15'), t7);
  check('新会话重置交易', (await page.textContent('#stPos')) === '0 手', await page.textContent('#stPos'));

  /* 12. 限价单 */
  await page.click('#typeSeg button[data-type="limit"]');
  // 必须先停播: 算完 lp 到点"买入"之间若行情自己走掉几根,
  // 那根最低价的 K 线可能已经播过去了, 限价单就永远不成交(这条原来是偶发 FAIL 的根因)
  await page.evaluate(() => App.engine.pause());
  // 挂单价取"未来 6 根的最低价"向上取整到 0.25 tick —— 保证一定会被回踩成交(不靠运气)
  const lp = await page.evaluate(() => {
    const i = App.engine.idx;
    const fwd = App.engine.bars.slice(i + 1, i + 7);
    if (!fwd.length) return 0;
    const lo = Math.min(...fwd.map(b => b.l));
    return Math.ceil(lo * 4) / 4;
  });
  check('限价单价格有效', lp > 0 && Math.abs(lp * 4 - Math.round(lp * 4)) < 1e-6, '挂单价 ' + lp);
  const tradesBefore = await page.evaluate(() => Trading.trades.length);
  await page.fill('#limitPrice', String(lp));
  await page.click('#btnBuy');
  await page.waitForTimeout(250);
  check('限价挂单', await page.evaluate(() => (App._limits || []).length === 1), '挂单价 ' + lp);
  for (let i = 0; i < 10; i++) {
    if ((await page.evaluate(() => App._limits || [])).length === 0) break;
    await page.click('#btnStepFwd');
    await page.waitForTimeout(70);
  }
  // 判据必须是「有没有成交」而不是「持仓是不是还不为 0」:
  // 开仓会自动挂 bracket(±若干点), 若成交那根 K 线的区间同时扫到自动止损,
  // 会在同一根里开完立刻平掉 → pos 回到 0 但成交确实发生了(偶发 FAIL 的真因)
  const limitFilled = await page.evaluate((n) => {
    const rec = Trading.trades.slice(n);
    return App._limits.length === 0 && rec.length > 0 && rec.some(r => r.type === 'limit');
  }, tradesBefore);
  const limDbg = await page.evaluate((n) => ({
    lim: App._limits.length, pos: Trading.pos, pend: Trading._pendingLimits,
    stops: Trading.stops.length, tp: Trading.tp, sl: Trading.sl, idx: App.engine.idx,
    newTrades: Trading.trades.slice(n).map(r => `${r.type}/${r.side}@${r.price}`),
  }), tradesBefore);
  check('限价成交', limitFilled, '持仓=' + await page.textContent('#stPos') + ' ' + JSON.stringify(limDbg));
  if (await page.evaluate(() => Trading.pos !== 0)) await page.click('#btnClose');
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
  check('收藏横条按钮数(尺子/趋势线/斐波那契/扩展/上箭头/下箭头/水平线/矩形/文字/磁吸/隐藏/清空)', dbarN === 12, String(dbarN) + ' 个');

  // 尺寸对齐 reference/17: TV 截图是 2x, 折半后 条实体高 33.5 / 槽距 34 / 图标墨迹 19.5~23
  const dbarGeo = await page.evaluate(() => {
    const bar = document.getElementById('drawBar').getBoundingClientRect();
    const btns = [...document.querySelectorAll('#drawBar .dbtn')].map(b => b.getBoundingClientRect());
    const svg = document.querySelector('#drawBar .dbtn svg').getBoundingClientRect();
    return {
      h: Math.round(bar.height),
      pitch: btns.length > 1 ? Math.round(btns[1].x - btns[0].x) : 0,
      svg: Math.round(svg.width),
    };
  });
  check('收藏条尺寸对齐 TV(高 34 / 槽距 34 / 图标盒 28)',
    dbarGeo.h === 34 && dbarGeo.pitch === 34 && dbarGeo.svg === 28,
    `高${dbarGeo.h} 槽距${dbarGeo.pitch} 图标${dbarGeo.svg}`);

  // 收藏条顺序: 尺子 / 趋势线 / 斐波那契 / 斐波那契扩展 打头
  const dbarOrder = await page.evaluate(() =>
    [...document.querySelectorAll('#drawBar .dbtn')].map(b => b.dataset.tool));
  check('收藏栏顺序: 尺子/趋势线/斐波那契/扩展/上箭头/下箭头 前六个',
    JSON.stringify(dbarOrder.slice(0, 6)) === JSON.stringify(['measure', 'trend', 'fib', 'fibext', 'arrowup', 'arrowdown']),
    dbarOrder.join(','));

  // 收藏条是方角 + 有投影 (照 reference/18: 圆角 6px, 无描边)
  const dbarSkin = await page.evaluate(() => {
    const cs = getComputedStyle(document.getElementById('drawBar'));
    return { radius: cs.borderRadius, shadow: cs.boxShadow, bw: cs.borderTopWidth };
  });
  check('收藏条方角(6px) + 投影 + 无描边',
    dbarSkin.radius === '6px' && dbarSkin.shadow !== 'none' && dbarSkin.bw === '0px',
    JSON.stringify(dbarSkin));

  // 鼠标扫过 K 线时图例会变, 但收藏条必须钉死在原地
  const box0 = await page.locator('#chartMain').boundingBox();
  const barLeft = () => page.evaluate(() =>
    Math.round(document.getElementById('drawBar').getBoundingClientRect().left * 10) / 10);
  const lefts = new Set();
  for (let i = 0; i < 14; i++) {
    await page.mouse.move(box0.x + 120 + i * 22, box0.y + 320);
    await page.waitForTimeout(16);
    lefts.add(await barLeft());
  }
  await page.mouse.move(box0.x + 5, box0.y + 5);
  await page.waitForTimeout(60);
  check('鼠标扫过 K 线时收藏条不动', lefts.size === 1, [...lefts].join(','));

  const toolGeo = await page.evaluate(() => {
    const svg = document.querySelector('#sideToolbar .tool svg').getBoundingClientRect();
    return { svg: Math.round(svg.width) };
  });
  check('左侧工具栏图标盒 28 (viewBox 56 单位 => 1 单位 0.5px)', toolGeo.svg === 28, String(toolGeo.svg));

  // 图标不是手画的: 23 个由 trace_icons.py 从 reference/17 的墨迹描出(实心轮廓 + evenodd),
  // 斐波那契回撤(4 横线 + 2 圆环, 见 reference/19) 和斐波那契扩展按像素坐标描成描边矢量
  const traced = await page.evaluate(() => {
    const side = [...document.querySelectorAll('#sideToolbar .tool')]
      .filter(b => b.dataset.tool !== 'brush')
      .map(b => b.querySelector('svg'));
    const all = [...document.querySelectorAll('#drawBar .dbtn svg'), ...side];
    const viewOk = all.every(s => s && s.getAttribute('viewBox') === '0 0 56 56');
    const filled = all.filter(s => s.querySelector('path[fill-rule="evenodd"]')).length;
    const stroked = all.filter(s => s.getAttribute('stroke') === 'currentColor').length;
    return { n: all.length, viewOk, filled, stroked };
  });
  check('27 个图标都按原图像素标定(viewBox 56: 23 描轮廓 + 4 描边)',
    traced.viewOk && traced.n === 27 && traced.filled === 23 && traced.stroked === 4,
    `${traced.n} 个 viewBox ok=${traced.viewOk} 描轮廓${traced.filled} 描边${traced.stroked}`);

  /* 斐波那契回撤图标: reference/19 里 tooltip "Fib retracement" 箭头 x=465 正对的那个 ——
     4 条等距横线 + 2 个空心圆环, 不是菱形。坐标全部从截图量出来(1 device px = 1 viewBox 单位) */
  const fibGlyph = await page.evaluate(() => {
    const s = document.querySelector('#drawBar .dbtn[data-tool="fib"] svg');
    if (!s) return null;
    const lines = [...s.querySelectorAll('path')].map(p => {
      const m = /^M([\d.]+) ([\d.]+)h([\d.]+)$/.exec(p.getAttribute('d') || '');
      return m ? { x: +m[1], y: +m[2], len: +m[3] } : null;
    });
    const circles = [...s.querySelectorAll('circle')].map(c =>
      ({ cx: +c.getAttribute('cx'), cy: +c.getAttribute('cy'), r: +c.getAttribute('r') }));
    return { lines, circles, sw: s.getAttribute('stroke-width') };
  });
  const fy = fibGlyph ? fibGlyph.lines.map(l => l && l.y) : [];
  check('斐波那契图标 = 4 条横线 + 2 个空心圆环 (reference/19 的 Fib retracement)',
    !!fibGlyph && fibGlyph.lines.length === 4 && fibGlyph.lines.every(Boolean)
    && fibGlyph.circles.length === 2 && fibGlyph.sw === '2',
    fibGlyph ? `${fibGlyph.lines.length} 线 ${fibGlyph.circles.length} 环 sw=${fibGlyph.sw}` : '没有 fib 图标');
  check('斐波那契图标 4 条横线等距(10.5) 且两端圆环落在第 2/第 4 条线上',
    fy.length === 4 && Math.abs(fy[1] - fy[0] - 10.5) < 0.01 && Math.abs(fy[2] - fy[1] - 10.5) < 0.01
    && Math.abs(fy[3] - fy[2] - 10.5) < 0.01
    && !!fibGlyph && fibGlyph.circles.every(c => Math.abs(c.cy - (c.cx > 28 ? fy[1] : fy[3])) < 0.01),
    fibGlyph ? `y=${JSON.stringify(fy)} 环=${JSON.stringify(fibGlyph.circles)}` : 'none');

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
  await page.click('#sideToolbar button[data-tool="cursor"]');
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
  await page.click('#indicatorBtn');
  await page.waitForTimeout(120);
  await page.click('#indBarCount');
  await page.waitForTimeout(120);
  check('关闭 Bar Count 后隐藏图例行',
        (await page.evaluate(() => Draw.showBarCount)) === false
        && (await page.evaluate(() => document.getElementById('lgBarRow').classList.contains('hidden-row'))));
  await page.click('#indBarCount');
  await page.waitForTimeout(120);

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

  /* 拖右侧价格轴上下: 交易线要跟着实时走, 不能只在松手后跳一下。
     判据: 鼠标还按着(mouseup 之前)绘图层就已经重绘过多次, 而且 TP/SL 的屏幕 y 同步位移
     (两者位移量必须一样 = 整块平移), 而价格本身不能被改动。 */
  const areaBox = await page.locator('#chartArea').boundingBox();
  const freeY = await page.evaluate(() => {
    const ys = Draw.orderLines().map(o => Draw.yOf(o.price)).filter(v => v != null && isFinite(v));
    let best = 200, bestD = -1;
    for (let y = 110; y < Draw._priceAreaHeight() - 70; y += 8) {
      const d = ys.length ? Math.min(...ys.map(v => Math.abs(v - y))) : 999;
      if (d > bestD) { bestD = d; best = y; }
    }
    return { y: best, d: Math.round(bestD) };
  });
  const axisPos = { x: areaBox.x + areaBox.width - 22, y: areaBox.y + freeY.y };  // 价格轴上、避开交易线的高度
  const follow0 = await page.evaluate(() => {
    Draw._rc = 0;
    if (!Draw._wrapped) {
      const orig = Draw.render.bind(Draw);
      Draw.render = function () { Draw._rc++; return orig(); };
      Draw._wrapped = true;
    }
    return { tp: Draw.yOf(Trading.tp), sl: Draw.yOf(Trading.sl), tpP: Trading.tp, slP: Trading.sl };
  });
  await page.mouse.move(axisPos.x, axisPos.y);
  await page.mouse.down();
  await page.mouse.move(axisPos.x, axisPos.y + 70, { steps: 10 });
  await page.waitForTimeout(80);
  const followMid = await page.evaluate(() => ({
    rc: Draw._rc, tp: Draw.yOf(Trading.tp), sl: Draw.yOf(Trading.sl), tpP: Trading.tp, slP: Trading.sl,
  }));
  await page.mouse.up();
  await page.waitForTimeout(120);
  const dTP = followMid.tp - follow0.tp, dSL = followMid.sl - follow0.sl;
  check('按住价格轴上下拖时交易线实时跟随(松手前就已重绘, 屏幕 y 跟着变)',
        freeY.d > 20 && followMid.rc >= 3 && Math.abs(dTP) + Math.abs(dSL) > 2
        && followMid.tpP === follow0.tpP && followMid.slP === follow0.slP,
        `重绘 ${followMid.rc} 次 · 空档 ${freeY.d}px · TP Δ${dTP.toFixed(1)} SL Δ${dSL.toFixed(1)}`);
  // 注: 拖价格轴在 lightweight-charts 里是"纵向缩放"而不是平移, 所以 TP/SL 的位移量不一定相等
  // 把价格轴恢复成自动缩放, 免得影响后面的用例
  await page.evaluate(() => ChartMgr.chart.priceScale('right').applyOptions({ autoScale: true }));

  /* 上/下键: 在当前 K 线的 最高价+1tick / 最低价−1tick 挂突破单 */
  const keyStop0 = await page.evaluate(() => {
    if (App.engine.playing) App.engine.pause();
    Trading.clearStops(); Draw.render();
    const c = App.engine.current;
    return { h: c.h, l: c.l, tick: Trading.TICK };
  });
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(140);
  const upStop = await page.evaluate(() => ({
    stops: Trading.stops.map(s => ({ side: s.side, price: s.price, qty: s.qty })),
    lines: Draw.orderLines().map(o => o.kind),
  }));
  check('↑ 键在当前 K 最高价上方 1 tick 挂上破买单',
        upStop.stops.length === 1 && upStop.stops[0].side === 'buy'
        && Math.abs(upStop.stops[0].price - (keyStop0.h + keyStop0.tick)) < 1e-9
        && upStop.lines.some(k => String(k).startsWith('stop')),
        `H=${keyStop0.h} +${keyStop0.tick} → ` + JSON.stringify(upStop.stops));

  // 覆盖式: 再按两次 ↑, 同方向只应剩最新一张 (不堆叠)
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(90);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(140);
  const upStop2 = await page.evaluate(() => ({
    n: Trading.stops.length,
    buys: Trading.stops.filter(s => s.side === 'buy').map(s => s.price),
    h: App.engine.current.h,
  }));
  check('连按 ↑ 是覆盖式: 同方向只保留最新一张 (不堆叠)',
        upStop2.n === 1 && upStop2.buys.length === 1
        && Math.abs(upStop2.buys[0] - (upStop2.h + keyStop0.tick)) < 1e-9,
        `${upStop2.n} 张 · buy=${JSON.stringify(upStop2.buys)} H=${upStop2.h}`);

  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(140);
  const dnStop = await page.evaluate(() => Trading.stops.map(s => ({ side: s.side, price: s.price })));
  const sellOne = dnStop.find(s => s.side === 'sell');
  check('↓ 键在当前 K 最低价下方 1 tick 挂下破卖单',
        dnStop.length === 2 && !!sellOne
        && Math.abs(sellOne.price - (keyStop0.l - keyStop0.tick)) < 1e-9,
        `L=${keyStop0.l} −${keyStop0.tick} → ` + JSON.stringify(dnStop));
  await page.evaluate(() => { Trading.clearStops(); Draw.render(); });

  /* 成交大箭头 (照用户截图: 买=K 线下方青绿朝上 / 卖=K 线上方红色朝下), 直接读绘图层像素 */
  const markPix = await page.evaluate(async () => {
    if (App.engine.playing) App.engine.pause();
    // 造一对买卖标记, 保证两个形态都在
    const cur = App.engine.current;
    Trading.fill('buy', 1, cur.c, 'market', cur.epoch, cur.off);
    App.addMarker('buy', cur.c);
    Trading.fill('sell', 1, cur.c, 'market', cur.epoch, cur.off);
    App.addMarker('sell', cur.c);
    App.renderTrading();
    // 前面用例把视窗拖来拖去, 先对准最新一段, 否则标记可能落在画布外。
    // 改完可见范围要等库重排一帧, 否则 xOf() 拿到的还是老坐标, 读到的是上一帧的画布
    const i = App.engine.idx;
    ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: i - 60, to: i + 8 });
    const raf = () => new Promise(r => requestAnimationFrame(r));
    await raf(); await raf();
    Draw.render();

    const c = document.getElementById('drawLayer');
    const k = c.width / parseFloat(c.style.width || c.width);
    const ctx = c.getContext('2d');
    const hit = (cx, cy, col) => {
      const x = Math.round(cx * k), y = Math.round(cy * k);
      const n = Math.max(6, Math.round(8 * k));
      if (x - n < 0 || y - n < 0 || x + n > c.width || y + n > c.height) return -1;   // 画布外
      const d = ctx.getImageData(x - n, y - n, n * 2, n * 2).data;
      let c0 = 0;
      for (let i2 = 0; i2 < d.length; i2 += 4) {
        if (Math.abs(d[i2] - col[0]) < 12 && Math.abs(d[i2 + 1] - col[1]) < 12 && Math.abs(d[i2 + 2] - col[2]) < 12) c0++;
      }
      return c0;
    };
    const out = [];
    const seen = new Set();
    for (const m of ChartMgr.markers) {
      const b = ChartMgr.barByTime(m.time);
      if (!b) continue;
      const buy = m.shape === 'arrowUp';
      const col = buy ? [112, 204, 189] : [204, 47, 60];
      const ye = Draw.yOf(buy ? b.l : b.h);
      const cy = buy ? ye + Draw.MARK_GAP + Draw.MARK.h / 2 : ye - Draw.MARK_GAP - Draw.MARK.h / 2;
      const x = Draw.xOf(b.t);
      const key = (buy ? 'b' : 's') + m.time;
      if (seen.has(key)) continue;
      seen.add(key);
      const n = hit(x, cy, col);
      // 量包围盒: 大箭头 33×38, 库自带的小三角只有 ~10px, 用尺寸把两者分开
      const bx = Math.round(x * k), by = Math.round(cy * k), pad = Math.round(Draw.MARK.w * k);
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      if (bx - pad >= 0 && by - pad >= 0 && bx + pad < c.width && by + pad < c.height) {
        const S = pad * 2, d = ctx.getImageData(bx - pad, by - pad, S, S).data;
        for (let yy = 0; yy < S; yy++) for (let xx = 0; xx < S; xx++) {
          const o = (yy * S + xx) * 4;
          if (Math.abs(d[o] - col[0]) < 12 && Math.abs(d[o + 1] - col[1]) < 12 && Math.abs(d[o + 2] - col[2]) < 12) {
            if (xx < x0) x0 = xx; if (xx > x1) x1 = xx;
            if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
          }
        }
      }
      out.push({
        buy, n,
        w: x1 >= x0 ? Math.round((x1 - x0 + 1) / k) : 0,
        h: y1 >= y0 ? Math.round((y1 - y0 + 1) / k) : 0,
      });
    }
    return { marks: out, nMarks: ChartMgr.markers.length };
  });
  check('成交标记在绘图层画成大箭头 16.5×19 (买=#70ccbd 朝上 / 卖=#cc2f3c 朝下)',
        markPix.nMarks >= 2 && markPix.marks.length >= 2
        && markPix.marks.filter(m => m.buy).length >= 1 && markPix.marks.filter(m => !m.buy).length >= 1
        && markPix.marks.every(m => m.n > 90 && Math.abs(m.w - 16.5) <= 2 && Math.abs(m.h - 19) <= 2),
        JSON.stringify(markPix));

  /* 上/下箭头也是绘图工具: 点一下落一个, 位置就是点下去的地方 */
  await page.evaluate(() => { Draw.clearAll(); Draw.setTool('arrowup'); });
  const dArea = await page.locator('#chartArea').boundingBox();
  await page.mouse.click(dArea.x + 380, dArea.y + 300);
  await page.waitForTimeout(200);
  const arrowItem = await page.evaluate(() => {
    const it = Draw.items.find(i => i.type === 'arrow');
    if (!it) return null;
    const px = Draw._px(it.a);
    const c = document.getElementById('drawLayer');
    const k = c.width / parseFloat(c.style.width || c.width);
    const d = c.getContext('2d')
      .getImageData(Math.round(px.x * k) - 3, Math.round((px.y + 12) * k) - 3, 7, 7).data;
    let hit = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 112) < 14 && Math.abs(d[i + 1] - 204) < 14 && Math.abs(d[i + 2] - 189) < 14) hit++;
    }
    return { dir: it.dir, tool: Draw.tool, hit, n: Draw.items.length };
  });
  check('上箭头工具: 点一下落一个朝上的箭头, 放完自动回光标',
        !!arrowItem && arrowItem.dir === 1 && arrowItem.tool === 'cursor'
        && arrowItem.n === 1 && arrowItem.hit > 0,
        JSON.stringify(arrowItem));
  await page.evaluate(() => Draw.clearAll());

  // 统计与交易记录 (要在下面清空之前判)
  check('交易记录已生成', (await page.evaluate(() => Trading.trades.length)) >= 1,
        await page.textContent('#stWin'));

  /* 16. 每条交易线各自一块右侧牌子 + ✕ 单独关掉 + 按住高亮 */
  const chipKeys = await page.evaluate(() => ({
    keys: Draw._chipRects.map(r => r.key),
    x0s: Draw._chipRects.map(r => Math.round(r.cx0)),
    W: Draw.W,
  }));
  check('入场/止盈/止损 各一块右侧牌子',
        ['entry', 'tp', 'sl'].every(k => chipKeys.keys.includes(k)), JSON.stringify(chipKeys.keys));
  check('所有牌子都在右侧(不在最左侧)', chipKeys.x0s.every(v => v > chipKeys.W * 0.7),
        JSON.stringify(chipKeys.x0s) + ' / W=' + chipKeys.W);

  const tpY2 = await page.evaluate(() => Draw.yOf(Trading.tp));
  const areaL = (await page.locator('#chartArea').boundingBox()).x;
  const areaT = (await page.locator('#chartArea').boundingBox()).y;
  await page.mouse.move(areaL + 240, areaT + tpY2);
  await page.mouse.down();
  await page.waitForTimeout(100);
  const dragOn = await page.evaluate(() => Draw._dragOrder);
  await page.mouse.up();
  await page.waitForTimeout(100);
  const dragOff = await page.evaluate(() => Draw._dragOrder);
  check('按住交易线时有高亮态, 松开恢复', dragOn === 'tp' && dragOff === null, dragOn + ' → ' + dragOff);

  // 点止盈牌的 ✕ → 只关掉止盈
  const clickChip = async key => {
    const r = await page.evaluate(k => {
      const x = (Draw._chipRects || []).find(v => v.key === k);
      return x ? { x: (x.cx0 + x.cx1) / 2, y: (x.y0 + x.y1) / 2 } : null;
    }, key);
    if (!r) return false;
    await page.mouse.click(areaL + r.x, areaT + r.y);
    await page.waitForTimeout(150);
    return true;
  };
  const closedTp = await clickChip('tp');
  const st1 = await page.evaluate(() => ({ tp: Trading.tp, sl: Trading.sl, pos: Trading.pos }));
  check('点止盈牌 ✕ 只关掉止盈(止损与持仓保留)',
        closedTp && st1.tp === null && st1.sl != null && st1.pos !== 0, JSON.stringify(st1));

  const closedSl = await clickChip('sl');
  const st2 = await page.evaluate(() => ({ tp: Trading.tp, sl: Trading.sl, pos: Trading.pos }));
  check('点止损牌 ✕ 只关掉止损(持仓保留)',
        closedSl && st2.sl === null && st2.pos !== 0, JSON.stringify(st2));

  // 点灰掉的 TP 圆 → 按默认 2R 挂回来
  const circ = await page.evaluate(() => {
    const c = (Draw._circleRects || []).find(v => v.key === 'tp');
    return c ? { x: c.x, y: c.y } : null;
  });
  if (circ) {
    await page.mouse.click(areaL + circ.x, areaT + circ.y);
    await page.waitForTimeout(150);
  }
  const st3 = await page.evaluate(() => ({ tp: Trading.tp }));
  check('点 TP 圆按钮可把止盈按默认点位挂回来', st3.tp != null, JSON.stringify(st3));

  // 突破挂单的牌子也在右侧
  const stopChip = await page.evaluate(() => {
    Trading.reset();
    const b = ChartMgr._lastData[ChartMgr._lastData.length - 1];
    Trading.placeStop('buy', 1, b.c + 2);
    Draw.render();
    const r = Draw._chipRects.find(x => x.key.indexOf('stop:') === 0);
    return r ? { key: r.key, x0: Math.round(r.cx0), W: Draw.W } : null;
  });
  check('突破挂单牌子在最右侧(不再贴左边)',
        !!stopChip && stopChip.x0 > stopChip.W * 0.7, JSON.stringify(stopChip));
  await page.evaluate(() => { Trading.reset(); });

  await page.evaluate(() => { Trading.reset(); Draw.clearAll(); });

  /* 16. 主题切换 */
  await page.click('#themeBtn');
  await page.waitForTimeout(400);
  const theme1 = await page.evaluate(() => document.body.dataset.theme);
  const bg1 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const darkCandle = await page.evaluate(() => {
    const o = ChartMgr.candle.options();
    return { up: o.upColor, down: o.downColor, downBorder: o.borderDownColor };
  });
  check('切换到深色主题', theme1 === 'dark' && bg1 === 'rgb(19, 23, 34)', theme1 + ' / ' + bg1);
  check('深色下也是白涨黑跌 (原来镜像成了黑涨白跌)',
        darkCandle.up === '#d1d4dc' && darkCandle.down === '#131722'
        && darkCandle.downBorder === '#d1d4dc',
        JSON.stringify(darkCandle));
  await page.screenshot({ path: SHOT_DARK });
  await page.click('#themeBtn');
  await page.waitForTimeout(400);
  check('切回浅色主题', (await page.evaluate(() => document.body.dataset.theme)) === 'light');

  /* 17. 1:1 复刻项: 顶栏周期 / 右上角 / 回放条位置 / 状态条 / 尺子标签 / 占位工具 / 撤销重做 / 网格 */
  const tfLabels = await page.evaluate(() =>
    [...document.querySelectorAll('#tfGroup button[data-tf]')].map(b => b.textContent.trim()));
  check('顶栏 12 个英文周期, 顺序 12h 紧跟 4h',
        tfLabels.join(',') === '1m,2m,5m,10m,15m,1h,4h,12h,D,3D,W,M', tfLabels.join(' '));

  const tbRight = await page.evaluate(() => ({
    layout: !!document.getElementById('layoutBtn'),
    cmp: !!document.getElementById('compareBtn'),
  }));
  check('右上角的分屏 / Xe-XAU 已删掉', !tbRight.layout && !tbRight.cmp, JSON.stringify(tbRight));

  for (const tf of ['2m', '3d', '1M']) {
    await page.click('#tfGroup button[data-tf="' + tf + '"]');
    await waitLoaded(page);
    await page.waitForTimeout(400);
    const ok = await page.evaluate(t => App.tf === t && App.bars.length > 100
      && App.engine.total > 0, tf);
    check('周期可用 ' + tf, ok, await page.evaluate(() => App.bars.length + ' 根'));
  }
  // 日/周/月线的时间是 "YYYY-MM-DD" 字符串, 格式化函数不能拿它当数字乘 1000 (曾显示 NaN月)
  const axisFmt = await page.evaluate(() => {
    const f = ChartMgr.chart.options().timeScale.tickMarkFormatter;
    const out = [];
    for (const t of ['2018-09-14', '2024-03-15']) for (const k of [0, 1, 2]) out.push(f(t, k));
    return out;
  });
  check('日线时间轴刻度不出现 NaN', axisFmt.every(s => !/NaN/.test(s)), axisFmt.join(' | '));
  await page.click('#tfGroup button[data-tf="5m"]');
  await waitLoaded(page);
  await page.waitForTimeout(400);

  // 回放条: 原来浮在图表底部居中, 现在钉在底栏左下角, 不浮动
  const rbBox = await page.evaluate(() => {
    const bar = document.getElementById('replayBar');
    const fw = document.getElementById('bottomBar').getBoundingClientRect();
    const r = bar.getBoundingClientRect();
    const cs = getComputedStyle(bar);
    return {
      parent: bar.parentElement.id, pos: cs.position, shadow: cs.boxShadow,
      inFooter: r.top >= fw.top - 1 && Math.abs(r.bottom - fw.bottom) <= 6,
      fromLeft: Math.round(r.left - fw.left),
      hidden: bar.classList.contains('hidden'),
    };
  });
  check('回放条钉在底栏左下角(不浮动 / 无阴影)',
        rbBox.parent === 'bottomBar' && rbBox.pos === 'static' && rbBox.shadow === 'none'
        && rbBox.inFooter && rbBox.fromLeft <= 12 && !rbBox.hidden,
        JSON.stringify(rbBox));
  check('底栏只剩状态条(区间按钮已删)',
        await page.evaluate(() => !document.getElementById('rangeGroup')
          && !document.getElementById('replayTradeBtn')), '');

  // 右下状态条
  const st = await page.evaluate(() => ({
    clock: document.getElementById('statusClock').textContent,
    tz: document.getElementById('statusTz').textContent,
    ses: document.getElementById('statusSession').textContent,
    adj: document.getElementById('statusAdj').textContent,
  }));
  check('右下状态条 时间/时区/时段/复权', /^\d{2}:\d{2}:\d{2}$/.test(st.clock)
        && /^UTC[+-]\d+/.test(st.tz) && st.ses === 'RTH' && st.adj === 'B-ADJ', JSON.stringify(st));

  // 尺子三行标签 (变化值/百分比/tick · 根数/时长 · 成交量)
  const stats = await page.evaluate(() => {
    const bars = ChartMgr._lastData;
    const a = bars[10], b = bars[30];
    Draw.items.push({ id: 9999, type: 'measure', a: { t: a.t, p: a.c }, b: { t: b.t, p: b.c }, color: '#2962ff' });
    const s = Draw._rangeStats(a.t, b.t);
    const r = { bars: s.bars, dur: s.dur, vol: s.vol,
                dP: +(b.c - a.c).toFixed(2), ticks: Math.round((b.c - a.c) / 0.25) };
    Draw.items = Draw.items.filter(i => i.id !== 9999);
    return r;
  });
  check('尺子统计: 21 根 / 时长 / 成交量 / tick',
        stats.bars === 21 && /分钟|小时/.test(stats.dur) && /K|M/.test(stats.vol),
        JSON.stringify(stats));

  // 占位工具: 点击只提示"还没做", 不改变当前工具
  await page.click('#sideToolbar button[data-tool="gannbox"]');
  await page.waitForTimeout(150);
  const ph = await page.evaluate(() => ({
    toast: document.getElementById('toast').textContent,
    tool: Draw.tool,
  }));
  check('未实现工具点击提示"还没做"', /还没做/.test(ph.toast) && ph.tool === 'cursor', JSON.stringify(ph));

  /* ===== 本轮 7 条要求 ===== */
  // 右侧留出空白区: 视窗 [n-60, n+40]
  await page.evaluate(() => {
    const n = ChartMgr._lastData.length;
    ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: n - 60, to: n + 40 });
  });
  await page.waitForTimeout(250);
  const cvGeo = await page.evaluate(() => {
    const a = document.getElementById('chartArea').getBoundingClientRect();
    const n = ChartMgr._lastData.length;
    const ts = ChartMgr.chart.timeScale();
    return {
      left: a.left, top: a.top,
      xLast: ts.logicalToCoordinate(n - 1), xBlank: ts.logicalToCoordinate(n + 26),
      y: Math.round(Draw._priceAreaHeight() * 0.5),
      lastT: ChartMgr._lastData[n - 1].t,
    };
  });

  /* ① 尺子/绘图在右侧空白区也有效 */
  await page.evaluate(() => App.applyTool('measure'));
  await page.mouse.move(cvGeo.left + cvGeo.xLast - 160, cvGeo.top + cvGeo.y - 50);
  await page.mouse.down(); await page.mouse.up();
  await page.mouse.move(cvGeo.left + cvGeo.xBlank, cvGeo.top + cvGeo.y + 50, { steps: 5 });
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(150);
  const blank = await page.evaluate(() => {
    const it = Draw.items.find(i => i.type === 'measure');
    return it ? { bT: it.b.t, xb: Draw.xOf(it.b.t) } : null;
  });
  check('尺子在右侧空白区也能落点并反算坐标',
        !!blank && blank.bT > cvGeo.lastT && Math.abs(blank.xb - cvGeo.xBlank) <= 6,
        blank ? `bT>lastT=${blank.bT > cvGeo.lastT} Δx=${Math.round(blank.xb - cvGeo.xBlank)}` : '未生成');

  /* ② 趋势线 Shift 强制水平 */
  await page.evaluate(() => { Draw.removeAll(); App.applyTool('trend'); });
  await page.mouse.move(cvGeo.left + 280, cvGeo.top + 200);
  await page.mouse.down(); await page.mouse.up();
  await page.keyboard.down('Shift');
  await page.mouse.move(cvGeo.left + 560, cvGeo.top + 320, { steps: 6 });
  await page.mouse.down(); await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(150);
  const shiftD = await page.evaluate(() => {
    const it = Draw.items.find(i => i.type === 'trend');
    return it ? Math.abs(it.a.p - it.b.p) : null;
  });
  check('趋势线按住 Shift 强制水平', shiftD != null && shiftD < 1e-9, String(shiftD));

  /* ③ 画到一半右键 = 取消划线, 不弹挂单菜单 */
  await page.evaluate(() => { Draw.removeAll(); App.applyTool('measure'); });
  await page.mouse.move(cvGeo.left + 380, cvGeo.top + 260);
  await page.mouse.down(); await page.mouse.up();
  const hadDraft = await page.evaluate(() => !!Draw.draft);
  await page.mouse.click(cvGeo.left + 500, cvGeo.top + 300, { button: 'right' });
  await page.waitForTimeout(150);
  const rc = await page.evaluate(() => ({
    draft: !!Draw.draft, tool: Draw.tool,
    menu: getComputedStyle(document.getElementById('ctxMenu')).display,
  }));
  check('画到一半右键优先取消划线(不弹挂单菜单)',
        hadDraft && !rc.draft && rc.tool === 'cursor' && rc.menu === 'none', JSON.stringify(rc));

  /* ④ "还没做" 提示贴按钮 */
  const gb = await page.locator('#sideToolbar button[data-tool="gannfan"]').boundingBox();
  await page.click('#sideToolbar button[data-tool="gannfan"]');
  await page.waitForTimeout(180);
  const tPos = await page.evaluate(() => {
    const r = document.getElementById('toast').getBoundingClientRect();
    return { cx: r.left + r.width / 2, top: r.top };
  });
  check('"还没做"提示贴在所点按钮附近(不再固定左下角)',
        Math.abs(tPos.cx - (gb.x + gb.width / 2)) < 60 && Math.abs(tPos.top - (gb.y + gb.height)) < 60,
        `toast=${Math.round(tPos.cx)},${Math.round(tPos.top)} btn=${Math.round(gb.x + gb.width / 2)},${Math.round(gb.y + gb.height)}`);

  /* ⑤ 收藏工具条可拖动 */
  const dbBefore = await page.locator('#drawBar').boundingBox();
  const gp = await page.locator('#drawBar .db-grip').boundingBox();
  await page.mouse.move(gp.x + gp.width / 2, gp.y + gp.height / 2);
  await page.mouse.down();
  await page.mouse.move(gp.x + 180, gp.y + 130, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(150);
  const dbAfter = await page.locator('#drawBar').boundingBox();
  check('收藏工具条可拖动移动',
        Math.abs(dbAfter.x - dbBefore.x) > 100 && Math.abs(dbAfter.y - dbBefore.y) > 70,
        `Δ=${Math.round(dbAfter.x - dbBefore.x)},${Math.round(dbAfter.y - dbBefore.y)}`);
  await page.evaluate(() => {
    const b = document.getElementById('drawBar');
    b.style.left = '0px'; b.style.top = '0px';
    localStorage.removeItem('es_replay_drawbar');
  });

  /* ⑥ 绘图可互相层叠: 后画在上, 点中置顶 */
  const zBefore = await page.evaluate(() => {
    Draw.removeAll(); Draw.setTool('cursor');
    const bars = ChartMgr._lastData, b = bars[bars.length - 25];
    Draw.addItem({ type: 'hline', a: { t: b.t, p: b.c }, b: { t: b.t, p: b.c } });
    Draw.addItem({ type: 'hline', a: { t: b.t, p: b.c + 12 }, b: { t: b.t, p: b.c + 12 } });
    Draw.render();
    return { z: Draw.items.map(i => i.z), y: Draw.yOf(b.c) };
  });
  await page.mouse.click(cvGeo.left + 420, cvGeo.top + zBefore.y);
  await page.waitForTimeout(150);
  const zAfter = await page.evaluate(() => Draw.items.map(i => i.z));
  check('绘图可互相层叠(后画在上 / 点中置顶)',
        zBefore.z[1] > zBefore.z[0] && zAfter[0] > zAfter[1],
        JSON.stringify(zBefore.z) + ' → ' + JSON.stringify(zAfter));

  /* ⑦ 斐波那契照截图: 1/0/-1/-2 级别 + 千分位价格标签 */
  const fibInfo = await page.evaluate(() => {
    Draw.removeAll();
    const it = Draw.addItem({ type: 'fib', a: { t: ChartMgr._lastData[5].t, p: 100 },
                              b: { t: ChartMgr._lastData[20].t, p: 96 } });
    Draw.render();
    return { levels: (it.levels || Draw.FIB).slice(), fmt: Draw._fmtPrice(7151.25) };
  });
  check('斐波那契照截图(级别 1/0/-1/-2, 价格千分位)',
        JSON.stringify(fibInfo.levels) === '[1,0,-1,-2]' && fibInfo.fmt === '7,151.25',
        JSON.stringify(fibInfo));
  await page.evaluate(() => Draw.clearAll());

  // 撤销 / 重做
  await page.click('#drawBar button[data-tool="hline"]');
  const boxU = await page.locator('#chartMain').boundingBox();
  await page.mouse.click(boxU.x + 200, boxU.y + 200);
  await page.waitForTimeout(150);
  const nBeforeUndo = await page.evaluate(() => Draw.count());
  await page.click('#undoBtn');
  await page.waitForTimeout(150);
  const nAfterUndo = await page.evaluate(() => Draw.count());
  await page.click('#redoBtn');
  await page.waitForTimeout(150);
  const nAfterRedo = await page.evaluate(() => Draw.count());
  check('撤销 / 重做绘图', nBeforeUndo === 1 && nAfterUndo === 0 && nAfterRedo === 1,
        `${nBeforeUndo} → ${nAfterUndo} → ${nAfterRedo}`);
  await page.evaluate(() => Draw.clearAll());

  // 网格开关
  await page.click('#gridBtn');
  await page.waitForTimeout(200);
  const gridOn = await page.evaluate(() => !!ChartMgr.chart.options().grid.vertLines.visible);
  await page.click('#gridBtn');
  await page.waitForTimeout(200);
  const gridOff2 = await page.evaluate(() => !!ChartMgr.chart.options().grid.vertLines.visible);
  check('网格开关 (默认关)', gridOn === true && gridOff2 === false);

  /* ⑧ 收藏条里有斐波那契按钮, 点两下就能画出来 */
  const hasFibBtn = !!(await page.$('#drawBar button[data-tool="fib"]'));
  await page.click('#drawBar button[data-tool="fib"]');
  const fibTool = await page.evaluate(() => Draw.tool);
  const cvF = await page.locator('#chartMain').boundingBox();
  const yF = await page.evaluate(() => Draw.yOf(ChartMgr._lastData[ChartMgr._lastData.length - 1].c));
  await page.mouse.click(cvF.x + 300, cvF.y + yF - 55);
  await page.waitForTimeout(120);
  await page.mouse.move(cvF.x + 620, cvF.y + yF + 55);
  await page.waitForTimeout(80);
  await page.mouse.click(cvF.x + 620, cvF.y + yF + 55);
  await page.waitForTimeout(200);
  const fibDrawn = await page.evaluate(() => ({ types: Draw.items.map(i => i.type), tool: Draw.tool }));
  check('收藏条有斐波那契按钮, 两点画出斐波那契',
        hasFibBtn && fibTool === 'fib' && fibDrawn.types.includes('fib') && fibDrawn.tool === 'cursor',
        `btn=${hasFibBtn} tool=${fibTool} items=${JSON.stringify(fibDrawn.types)}`);

  /* ⑧b 斐波那契扩展: 按 reference/18 三次点击 A→B→C, 级别 = pC + k*(pB-pA), 只画 0/1/2 */
  await page.evaluate(() => { Draw.clearAll(); Draw.setTool('cursor'); });
  const hasExtBtn = !!(await page.$('#drawBar button[data-tool="fibext"]'));
  await page.click('#drawBar button[data-tool="fibext"]');
  const extTool = await page.evaluate(() => Draw.tool);
  // 用图表高度比例定位三个点, 避免价格高低把点推到画布外
  const hArea = await page.evaluate(() => Draw._priceAreaHeight());
  const exY = f => Math.round(hArea * f);
  await page.mouse.click(cvF.x + 260, cvF.y + exY(0.25));   // A
  await page.waitForTimeout(110);
  await page.mouse.click(cvF.x + 430, cvF.y + exY(0.62));   // B
  await page.waitForTimeout(110);
  await page.mouse.move(cvF.x + 640, cvF.y + exY(0.38));    // 预览 C
  await page.waitForTimeout(90);
  const draftC = await page.evaluate(() => !!(Draw.draft && Draw.draft.stage === 2));
  await page.mouse.click(cvF.x + 640, cvF.y + exY(0.38));   // C
  await page.waitForTimeout(200);
  const ext = await page.evaluate(() => {
    const it = Draw.items.find(i => i.type === 'fibext');
    if (!it) return null;
    const lv = it.levels || Draw.FIBEXT;
    const px = lv.map(k => it.c.p + (it.b.p - it.a.p) * k);
    return {
      levels: lv, nPts: [it.a, it.b, it.c].filter(Boolean).length,
      tool: Draw.tool, px,
      // 相邻级别价差必须完全相等 (这就是 pC + k*(pB-pA) 的定义)
      stepsEqual: Math.abs((px[1] - px[0]) - (px[2] - px[1])) < 1e-9,
      step: px[1] - px[0], ab: it.b.p - it.a.p,
    };
  });
  check('斐波那契扩展: 三点画出 + 级别 0/1/2',
        hasExtBtn && extTool === 'fibext' && draftC && !!ext && ext.nPts === 3
        && JSON.stringify(ext.levels) === '[0,1,2]' && ext.tool === 'cursor',
        `btn=${hasExtBtn} tool=${extTool} stage2=${draftC} ` + JSON.stringify(ext && ext.levels));
  check('扩展级别价差 = A→B 的 1 个单位 (pC + k*(pB-pA))',
        !!ext && ext.stepsEqual && Math.abs(ext.step - ext.ab) < 1e-9,
        ext ? `step=${ext.step.toFixed(4)} AB=${ext.ab.toFixed(4)}` : 'none');

  /* 画完不留锚点圈 (照 reference/20: 画好的扩展只有虚线 + 级别横线; reference/18 是画到一半才带圈)
     用 arc() 调用次数当判据, 比读像素稳: 不受坐标轴/网格干扰 */
  const arcProbe = await page.evaluate(() => {
    const proto = CanvasRenderingContext2D.prototype, origArc = proto.arc;
    const countArcs = () => {
      let n = 0;
      proto.arc = function (...a) { n++; return origArc.apply(this, a); };
      try { Draw.render(); } finally { proto.arc = origArc; }
      return n;
    };
    const keepItems = Draw.items, keepSel = Draw.selected, keepDraft = Draw.draft;
    const keepPos = (typeof Trading !== 'undefined') ? Trading.pos : undefined;
    if (typeof Trading !== 'undefined') Trading.pos = 0;      // 排除 TP/SL 圆环干扰
    const bars = ChartMgr._lastData;
    const b0 = bars[bars.length - 30], b1 = bars[bars.length - 20], b2 = bars[bars.length - 10];
    const geo = [
      { t: b0.t, p: b0.l }, { t: b1.t, p: b1.h }, { t: b2.t, p: b2.l },
    ];
    Draw.items = []; Draw.selected = null; Draw.draft = null;
    Draw.addItem({ type: 'fibext', a: geo[0], b: geo[1], c: geo[2], levels: Draw.FIBEXT.slice() });
    const done = countArcs();
    Draw.draft = { type: 'fibext', a: geo[0], b: geo[1], c: geo[2], stage: 2 };
    const draft = countArcs();
    Draw.draft = null;
    Draw.items = [];
    Draw.addItem({ type: 'fib', a: geo[0], b: geo[1], levels: Draw.FIB.slice() });
    const fibDone = countArcs();
    Draw.draft = { type: 'fib', a: geo[0], b: geo[1] };
    const fibDraft = countArcs();
    Draw.draft = null;
    Draw.items = keepItems; Draw.selected = keepSel; Draw.draft = keepDraft;
    if (typeof Trading !== 'undefined') Trading.pos = keepPos;
    Draw.render();
    return { done, draft, fibDone, fibDraft };
  });
  check('斐波那契扩展画完不画锚点圈 (只有虚线 + 级别横线), 画的过程中有 3 个圈',
        arcProbe.done === 0 && arcProbe.draft === 3,
        `画完=${arcProbe.done} 进行中=${arcProbe.draft}`);
  check('斐波那契回撤画完也不画锚点圈, 画的过程中有 2 个圈',
        arcProbe.fibDone === 0 && arcProbe.fibDraft === 2,
        `画完=${arcProbe.fibDone} 进行中=${arcProbe.fibDraft}`);

  // 三个锚点都能单独拖动
  const extDrag = await page.evaluate(() => {
    const it = Draw.items.find(i => i.type === 'fibext');
    if (!it) return null;
    const cpx = Draw._px(it.c);
    return { p0: it.c.p, a0: it.a.p, b0: it.b.p, cx: cpx.x, cy: cpx.y };
  });
  if (!extDrag) {
    check('扩展的 C 锚点可单独拖动(其余两点不动)', false, '没有 fibext 图元可拖');
  } else {
    await page.mouse.move(cvF.x + extDrag.cx, cvF.y + extDrag.cy);
    await page.mouse.down();
    await page.mouse.move(cvF.x + extDrag.cx, cvF.y + extDrag.cy + 45);
    await page.mouse.up();
    await page.waitForTimeout(180);
    const extAfter = await page.evaluate(() => {
      const it = Draw.items.find(i => i.type === 'fibext');
      return { c: it.c.p, a: it.a.p, b: it.b.p };
    });
    check('扩展的 C 锚点可单独拖动(其余两点不动)',
          Math.abs(extAfter.c - extDrag.p0) > 0.5
          && Math.abs(extAfter.a - extDrag.a0) < 1e-9
          && Math.abs(extAfter.b - extDrag.b0) < 1e-9,
          `C ${extDrag.p0.toFixed(2)} → ${extAfter.c.toFixed(2)}`);
  }
  await page.evaluate(() => Draw.clearAll());

  /* ⑨ 中键点中绘图直接删掉, 不必先左键选中再按 Delete */
  const midGeo = await page.evaluate(() => {
    Draw.clearAll(); Draw.setTool('cursor');
    const bars = ChartMgr._lastData, b = bars[bars.length - 12];
    Draw.addItem({ type: 'hline', a: { t: b.t, p: b.c }, b: { t: b.t, p: b.c } });
    Draw.render();
    return { n: Draw.count(), y: Draw.yOf(b.c), sel: Draw.selected };
  });
  await page.mouse.move(cvGeo.left + 420, cvGeo.top + midGeo.y);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(200);
  const midAfter = await page.evaluate(() => ({ n: Draw.count(), sel: Draw.selected }));
  check('中键点中绘图直接删掉(不必先选中)',
        midGeo.n === 1 && midGeo.sel == null && midAfter.n === 0,
        `${midGeo.n} → ${midAfter.n}`);

  /* 中键点空白处不能误删 */
  await page.evaluate(() => {
    const bars = ChartMgr._lastData, b = bars[bars.length - 12];
    Draw.addItem({ type: 'hline', a: { t: b.t, p: b.c - 40 }, b: { t: b.t, p: b.c - 40 } });
    Draw.render();
  });
  await page.mouse.move(cvGeo.left + 420, cvGeo.top + 26);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.up({ button: 'middle' });
  await page.waitForTimeout(150);
  check('中键点空白处不误删绘图', (await page.evaluate(() => Draw.count())) === 1);

  /* ⑩ 复盘中途误点「选择随机K线」: 先暂停, 点 ✕ 关掉后原样续播 */
  await page.evaluate(() => {
    Draw.clearAll();
    const bars = ChartMgr._lastData, b = bars[bars.length - 5];
    Draw.addItem({ type: 'trend', a: { t: b.t, p: b.c },
                   b: { t: bars[bars.length - 1].t, p: b.c + 5 } });
    Draw.render();
    App.engine.play();
  });
  await page.waitForTimeout(100);
  await page.click('#rbPickBtn');
  await page.waitForTimeout(250);
  const stOpen = await page.evaluate(() => ({
    modal: getComputedStyle(document.getElementById('startModal')).display,
    playing: !!App.engine.playing,
  }));
  await page.click('#startModalClose');
  await page.waitForTimeout(300);
  const stClosed = await page.evaluate(() => ({
    modal: getComputedStyle(document.getElementById('startModal')).display,
    playing: !!App.engine.playing, n: Draw.count(),
  }));
  check('复盘中途点「选择随机K线」→ 弹窗暂停, 点 ✕ 关掉原样续播',
        stOpen.modal === 'flex' && stOpen.playing === false &&
        stClosed.modal === 'none' && stClosed.playing === true && stClosed.n === 1,
        JSON.stringify({ stOpen, stClosed }));
  await page.evaluate(() => { App.engine.pause(); Draw.clearAll(); });

  /* ⑪ 纵向拖动: 不必先去右侧价格轴上拉一下, 直接上下拖就能动 */
  const panGeo = await page.locator('#chartMain').boundingBox();
  const priceRange = () => page.evaluate(() => {
    const p = ChartMgr.candle.priceScale().getVisibleRange();
    return p ? [+p.from.toFixed(2), +p.to.toFixed(2)] : null;
  });
  const autoOn = () => page.evaluate(() => ChartMgr.chart.priceScale('right').options().autoScale);
  const wasAuto = await autoOn();
  const pr0 = await priceRange();
  const pcx = panGeo.x + panGeo.width * 0.5, pcy = panGeo.y + panGeo.height * 0.55;
  await page.mouse.move(pcx, pcy);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) { await page.mouse.move(pcx, pcy - i * 9); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(200);
  const pr1 = await priceRange();
  const autoAfter = await autoOn();
  check('不用先拉价格轴, 直接上下拖就能纵向平移',
        wasAuto === true && autoAfter === false && pr0 && pr1 && Math.abs(pr1[0] - pr0[0]) > 0.2,
        `auto ${wasAuto}→${autoAfter} · ${JSON.stringify(pr0)}→${JSON.stringify(pr1)}`);

  // 纯横向拖不应把价格轴踢出自动缩放
  await page.evaluate(() => ChartMgr.chart.priceScale('right').applyOptions({ autoScale: true }));
  await page.waitForTimeout(120);
  await page.mouse.move(pcx, pcy);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) { await page.mouse.move(pcx - i * 10, pcy); await page.waitForTimeout(16); }
  await page.mouse.up();
  await page.waitForTimeout(200);
  check('纯横向拖动不会关掉自动缩放', (await autoOn()) === true, 'autoScale=' + await autoOn());
  await page.evaluate(() => ChartMgr.chart.priceScale('right').applyOptions({ autoScale: true }));

  /* 18. 记住上次位置: 重开回放默认回到上次那个时间 */
  const resumeSaved = await page.evaluate(() => {
    const idx = Math.max(0, App.engine.idx - 37);
    App.engine.seek(idx);
    App.savePos();
    return new Promise(r => setTimeout(() => r({
      idx: App.engine.idx, tf: App.tf,
      time: document.getElementById('replayTime').textContent.trim(),
    }), 450));
  });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const n = document.getElementById('dataRangeNote');
    return n && n.textContent && !n.textContent.includes('加载中');
  }, { timeout: 20000 });
  const resumeModal = await page.evaluate(() => ({
    active: (document.querySelector('#modeSeg button.active') || {}).dataset?.mode,
    note: document.getElementById('resumeNote').textContent.trim(),
    rowShown: getComputedStyle(document.getElementById('resumeRow')).display !== 'none',
  }));
  check('重开时弹窗默认「继续上次」, 并显示上次时间',
        resumeModal.active === 'resume' && resumeModal.rowShown
        && resumeModal.note.includes(resumeSaved.time.slice(0, 16)),
        JSON.stringify(resumeModal) + ' vs ' + resumeSaved.time);
  await page.click('#startBtn');
  await waitLoaded(page);
  await page.waitForTimeout(600);
  const resumed = await page.evaluate(() => ({
    idx: App.engine.idx, tf: App.tf,
    time: document.getElementById('replayTime').textContent.trim(),
  }));
  check('继续上次落在同一根 K 线上',
        resumed.idx === resumeSaved.idx && resumed.tf === resumeSaved.tf,
        `idx ${resumeSaved.idx}→${resumed.idx} · ${resumeSaved.time} / ${resumed.time}`);

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
