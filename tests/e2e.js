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
/* v1.1: 下单前必须打标 (setup + 市场周期) —— 测试里直接预置, 免得每次都走弹窗 */
const giveSetup = (page, id = 'feel', cycle = 'range') => page.evaluate(([i, c]) => {
  App.pendingSetup = i; App.pendingCycle = c; App.syncSetupUI();
}, [id, cycle]);

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

  /* 账本会真的写进 data/journal.json —— 先备份, 跑完还原, 别污染真实练习记录 */
  const journalBackup = await page.evaluate(async () => {
    try { const r = await fetch('/api/journal', { cache: 'no-store' }); return await r.json(); }
    catch (e) { return { version: 1, trades: [], orders: [] }; }
  });
  await page.evaluate(async () => {
    await fetch('/api/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, trades: [], orders: [] }) });
  });

  /* 绘图存档 (data/draw.json) 同样会真的落盘 —— 备份 + 清空,
     否则上一轮留下的线会让本轮所有 Draw.count() 断言失真 */
  const drawBackup = await page.evaluate(async () => {
    try { const r = await fetch('/api/draw', { cache: 'no-store' }); return await r.json(); }
    catch (e) { return { version: 1, byTf: {}, updatedAt: 0 }; }
  });
  await page.evaluate(async () => {
    await fetch('/api/draw', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: 1, byTf: {}, updatedAt: 0 }) });
  });
  check('开始弹窗显示', await page.isVisible('#startModal'));
  check('还没开始复盘时底栏日号条是隐藏的', await page.evaluate(() =>
    document.getElementById('dayStrip').classList.contains('hidden')
    && getComputedStyle(document.getElementById('dayStrip')).opacity === '0'));

  const theme0 = await page.evaluate(() => document.body.dataset.theme);
  const bg0 = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  check('默认浅色主题(TradingView 默认)', theme0 === 'light' && bg0 === 'rgb(255, 255, 255)', theme0 + ' / ' + bg0);

  await page.evaluate(() => {
    localStorage.clear();
    // 磁盘清了不代表内存干净: boot 时已经把旧存档读进 Draw._all 了, 这里一并作废
    Draw._all = { version: 1, byTf: {}, updatedAt: 0 };
    Draw.items = []; Draw.tf = null; Draw._clip = null;
  });

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
      // 只收 Bar Count: 它固定用橙色画 (#ff9800 浅色 / #ffab40 深色)。
      // 不能只按「纯数字」判定 —— 时间轴的日刻度现在不带「日」字了(2026-10-22 用户要求),
      // 裸数字会被一起收进来, 里面混着奇数日期, 断言就假失败。
      const cs = String(this.fillStyle || '');
      const isBc = /^#ff(9800|ab40)$/i.test(cs)
                || cs === 'rgb(255, 152, 0)' || cs === 'rgb(255, 171, 64)';
      if (isBc && /^\d+$/.test(t) && +t > 0) calls.push(+t);
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

  /* 光标形状 (用户 2026-10-23 指出原版图表里鼠标是系统十字指针, 不是普通箭头):
     主图 = crosshair (由 #chartArea 继承下来); 右侧价格轴 = ns-resize (库自己设的上下双箭头,
     不能被十字盖掉, 否则拖动价格轴就没提示了)。 */
  const curInfo = await page.evaluate(() => {
    const box = document.getElementById('chartMain');
    const cvs = [...box ? box.querySelectorAll('canvas') : []];
    const mainCv = cvs.slice().sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
    return {
      area: getComputedStyle(document.getElementById('chartArea')).cursor,
      main: mainCv ? getComputedStyle(mainCv).cursor : '?',
      rect: box ? { x: box.getBoundingClientRect().x, y: box.getBoundingClientRect().y,
        w: box.getBoundingClientRect().width, h: box.getBoundingClientRect().height } : null,
    };
  });
  check('图表区鼠标是系统十字指针 (与 TradingView 一致)',
        curInfo.area === 'crosshair' && curInfo.main === 'crosshair',
        `area=${curInfo.area} main=${curInfo.main}`);

  /* 价格轴的 ns-resize 是库按 hover 位置动态设的, 要先真的把鼠标移上去再读 */
  let axisCur = '?';
  if (curInfo.rect) {
    const rr = curInfo.rect;
    await page.mouse.move(rr.x + rr.w - 28, rr.y + rr.h * 0.45);
    await page.waitForTimeout(160);
    axisCur = await page.evaluate(() => {
      const box = document.getElementById('chartMain');
      const cvs = [...box.querySelectorAll('canvas')];
      const ax = cvs.filter(c => c.width > 0 && c.width < 120)[0];
      return ax ? getComputedStyle(ax).cursor : '?';
    });
    await page.mouse.move(rr.x + rr.w * 0.45, rr.y + rr.h * 0.45);
    await page.waitForTimeout(80);
  }
  check('鼠标移到右侧价格轴时是上下双箭头 (不被十字盖掉)', axisCur === 'ns-resize', axisCur);

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
  /* 开仓前在绘制层上挂个 fillRect 探针: 用户 2026-10-23 要求去掉「入场→止盈 / 入场→止损」
     那两块贯穿全宽的淡色底, 判据 = 持仓期间没有任何宽度 > 200px 的填充
     (牌子/圆点/小方块都远小于这个宽度, 不会被误count) */
  const probeOk = await page.evaluate(() => {
    window.__fills = [];
    const ctx = Draw.ctx;
    if (!ctx.__probe) {
      const orig = ctx.fillRect.bind(ctx);
      ctx.fillRect = function (x, y, w, h) {
        window.__fills.push([Math.round(x), Math.round(y), Math.round(w), Math.round(h)]);
        return orig(x, y, w, h);
      };
      ctx.__probe = true;
    }
    ctx.fillRect(0, 100, 600, 30);            // 正对照: 探针确实是活的
    const n = window.__fills.length;
    window.__fills = [];
    return n >= 1;
  });
  await giveSetup(page);
  await page.click('#btnBuy');
  await page.waitForTimeout(250);
  const wideFills = await page.evaluate(() => {
    Draw.render();                            // 强制重画一帧, 把交易线画出来
    return window.__fills.filter(f => f[2] > 200 && f[3] > 4);
  });
  check('开仓后盘面没有贯穿全宽的盈亏底色 (色区已去掉, 但线上/牌子还在)',
        probeOk && wideFills.length === 0,
        `探针=${probeOk} 宽填充=${JSON.stringify(wideFills)} 持仓=${await page.textContent('#stPos')}`);

  check('买入开仓', (await page.textContent('#stPos')).includes('多'),
        await page.textContent('#stPos') + ' 记录' + await page.textContent('#tradeCount'));
  /* 这里数的是"当前这根 K 线上的箭头", 不是 markers 总长度 ——
     v1.2.7 起 ChartMgr.markers 里还会有从账本重建出来的历史箭头 (见 rebuildMarkers),
     总数取决于账本里攒了多少笔, 拿它当断言等于让用例依赖历史数据。 */
  const mkNow = await page.evaluate(() => {
    const cur = App.engine.current;
    const isDay = (App.tf === '1d' || App.tf === '1w');
    const t = isDay ? etDateStr(cur.epoch, cur.off) : chartTime(cur.epoch, cur.off);
    return { atNow: ChartMgr.markers.filter(m => m.time === t).length, total: ChartMgr.markers.length };
  });
  check('成交标记', mkNow.atNow === 1, JSON.stringify(mkNow));
  const NUM = /^[+-]?\d+(\.\d+)?$/;   // 纯数字: 不带「点」「手」「$」
  check('浮动盈亏只显示数字(无 $ / 无「点」)', NUM.test((await page.textContent('#stFloat')).trim()),
        await page.textContent('#stFloat'));

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
  check('已实现盈亏只显示数字(无 $ / 无「点」)', NUM.test(real.trim()) && real !== '-',
        real + ' / 合计 ' + await page.textContent('#stTotal'));
  // 再开平一次, 让列表有两行, 好验"逐行对齐"
  await giveSetup(page);
  await page.click('#btnBuy');
  await page.waitForTimeout(200);
  await page.click('#btnClose');
  await page.waitForTimeout(300);

  /* 交易记录改成一笔交易一行: Setup / 方向 / R / 时间·周期·点数 */
  const trRows = await page.evaluate(() =>
    [...document.querySelectorAll('#tradeList .trade-item')].map(r => ({
      setup: r.querySelector('.t-setup').textContent.trim(),
      side: r.querySelector('.t-side').textContent.trim(),
      r: r.querySelector('.t-r').textContent.trim(),
      sub: [...r.querySelector('.t-sub').children].map(c => c.textContent.trim()),
      topLeft: Math.round(r.querySelector('.t-top').getBoundingClientRect().left),
      rRight: Math.round(r.querySelector('.t-r').getBoundingClientRect().right),
    })));
  check('交易记录一笔交易一行', trRows.length > 0 && trRows.every(r => r.setup && r.sub.length === 3),
        trRows.length + ' 行 · ' + JSON.stringify(trRows[0] || null));
  check('交易记录方向是 多/空 (不带手数)', trRows.every(r => /^[多空]$/.test(r.side)),
        JSON.stringify(trRows.map(r => r.side)));
  check('交易记录盈亏用 R (数字+R, 无美元符号)',
        trRows.every(r => r.r === '–' || /^[+-]?\d+(\.\d+)?R$/.test(r.r)),
        JSON.stringify(trRows.map(r => r.r)));
  check('交易记录逐行左对齐 + R 右对齐',
        trRows.length > 1 && trRows.every(r => Math.abs(r.topLeft - trRows[0].topLeft) <= 1
                                              && Math.abs(r.rRight - trRows[0].rRight) <= 1),
        JSON.stringify(trRows.map(r => [r.topLeft, r.rRight])));
  check('交易记录带 Setup 名', trRows.every(r => r.setup.length > 0), JSON.stringify(trRows.map(r => r.setup)));
  check('胜率统计', /笔/.test(await page.textContent('#stWin')), await page.textContent('#stWin'));

  /* ---- 交易记录面板: 本场全部 + 历史最近 10 场 (用户 2026-10-24) ----
     造 12 个历史场次, 而且**故意让练习时间和行情时间反着来**:
     场次越新, 里面那笔的 exitEpoch 越小。这样只要实现偷懒按 exitEpoch 排, 顺序就立刻不对。
     全程只改内存不 save(), 跑完把 trades 数组还原。

     注意先要把账本缩到「只有本场」: data/journal.json 是历次 e2e 和手工练习攒下来的,
     里面有多少历史场次完全不可控 —— 多几个旧场次就会把 历史1/历史2 挤出"最近 10 场",
     断言跟着假失败 (本用例最初就是这么红的)。把变量掐死, 这条才测的是排序逻辑本身。 */
  const hist = await page.evaluate(() => {
    const now = Date.now();
    const saved = Journal.data.trades.slice();
    const mine = saved.filter(t => t.sessionId === App.sessionId);
    Journal.data.trades = mine.slice();          // 只留本场
    for (let i = 1; i <= 12; i++) {
      Journal.data.trades.push({
        id: 'T-hist-' + i,
        // 场次 id 按真实规则造: 'S' + base36(毫秒) + 3 位随机码; i 越大越新 (每场差 10 分钟)
        sessionId: 'S' + (now - (13 - i) * 600000).toString(36) + 'zz' + String.fromCharCode(97 + i),
        setupId: 'feel', setupName: '历史' + i, cycle: 'range',
        side: i % 2 ? 'long' : 'short', tf: '5m', session: 'rth',
        entryTime: '2020-03-0' + ((i % 9) + 1) + ' 10:00 ET',
        entryPrice: 3000, exitPrice: 3001,
        exitEpoch: 1600000000 - i * 1000,       // 场次越新, 行情时间越早 —— 反着的
        qty: 1, points: 1, riskPoints: 1, r: 1, usd: 50,
        exitTime: '2020-03-0' + ((i % 9) + 1) + ' 10:30 ET', exitReason: 'tp',
      });
    }
    App._tradeSig = null;
    App.renderTrading();
    const rows = [...document.querySelectorAll('#tradeList .trade-item')];
    const vis = App.visibleTrades();
    const nJournal = Journal.data.trades.length;
    const out = {
      myRows: mine.length,
      rows: rows.length,
      curRows: rows.filter(r => r.classList.contains('is-current')).length,
      rowNames: rows.map(r => (r.querySelector('.t-setup').textContent || '').trim()),
      visible: vis.length,
      names: vis.map(t => t.setupName || ''),
      curBoxShadow: (() => {
        const cur = rows.find(r => r.classList.contains('is-current'));
        const bg = cur ? getComputedStyle(cur).boxShadow : '';
        return bg.indexOf('rgb(41, 98, 255)') >= 0;      // --accent #2962ff
      })(),
      // 只清显示: 列表空了, 账本长度一毫不变
      beforeLen: nJournal,
      btnBefore: document.getElementById('btnResetTrades').textContent,
    };
    App.clearTradeView();
    out.afterClearRows = document.querySelectorAll('#tradeList .trade-item').length;
    out.afterClearLen = Journal.data.trades.length;
    out.afterClearBtn = document.getElementById('btnResetTrades').textContent;
    out.afterClearEmpty = (document.querySelector('#tradeList .trade-empty') || {}).textContent || '';
    App.restoreTradeView();
    out.afterRestoreRows = document.querySelectorAll('#tradeList .trade-item').length;
    out.afterRestoreBtn = document.getElementById('btnResetTrades').textContent;
    // 换场次后隐藏集合要自动清空, 否则按钮会卡在「恢复显示 (N)」但列表里没有可恢复的东西
    const sid0 = App.sessionId;
    App.clearTradeView();
    out.hiddenAfterClear = App._hiddenTradeIds.size;
    App.sessionId = 'S' + Date.now().toString(36) + 'xyz';
    App._tradeSig = null;
    App.renderTrading();
    out.afterSidChangeBtn = document.getElementById('btnResetTrades').textContent;
    App.sessionId = sid0;
    Journal.data.trades = saved;                 // 还原, 不 save()
    App._hiddenTradeIds = new Set();
    App._tradeSig = null;
    App.renderTrading();
    return out;
  });

  /* 12 个假场次里只取最近 10 个 (历史3~历史12), 加上本场那几笔 */
  check('交易记录 = 本场全部 + 历史最近 10 场 (12 场里只取 10 场)',
        hist.visible === hist.myRows + 10 && hist.rows === hist.myRows + 10
        && hist.names.includes('历史12') && hist.names.includes('历史3')
        && !hist.names.includes('历史1') && !hist.names.includes('历史2'),
        `可见 ${hist.visible} 笔 / ${hist.rows} 行 (本场 ${hist.myRows}) / 名称 ${JSON.stringify(hist.names)}`);

  /* 列表倒序渲染: 开头是本场那几笔 (练习时间最新), 紧跟其后才是历史里最新的 历史12。
     如果实现偷懒按 exitEpoch 排, 本场之后会变成 历史3 (它的行情时间最大) —— 这条就是抓它的。 */
  check('列表按「练习时间」排而不是行情时间 (本场在最上, 历史里最新的紧跟其后)',
        hist.rowNames.slice(0, hist.myRows).every(n => n === '感觉')
        && hist.rowNames[hist.myRows] === '历史12',
        `本场 ${hist.myRows} 行 + 其后 = ${JSON.stringify(hist.rowNames.slice(0, hist.myRows + 1))}`);

  check('本场的记录左边有蓝竖条, 历史场次没有',
        hist.curRows === hist.myRows && hist.curBoxShadow === true,
        `本场行 ${hist.curRows} 行 (账本 ${hist.myRows}), 竖条色命中 = ${hist.curBoxShadow}`);

  check('「清空列表」只切显示: 列表清空但账本一笔不少',
        hist.afterClearRows === 0 && hist.afterClearLen === hist.beforeLen
        && /隐藏/.test(hist.afterClearEmpty),
        `清空后 ${hist.afterClearRows} 行 / 账本 ${hist.afterClearLen} 笔 (原 ${hist.beforeLen}) / 「${hist.afterClearEmpty.slice(0, 20)}」`);

  check('清空后按钮变成「恢复显示 N」, 点一下全回来',
        /恢复显示/.test(hist.afterClearBtn) && hist.afterRestoreRows === hist.rows
        && /清空列表/.test(hist.afterRestoreBtn),
        `${hist.afterClearBtn} → 恢复后 ${hist.afterRestoreRows} 行 / 按钮 ${hist.afterRestoreBtn}`);

  check('换场次后隐藏集合自动清空 (按钮不会卡在「恢复显示」)',
        hist.hiddenAfterClear > 0 && /清空列表/.test(hist.afterSidChangeBtn),
        `清空时藏了 ${hist.hiddenAfterClear} 笔, 换场次后按钮 = ${hist.afterSidChangeBtn}`);

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

  /* 10b. 底栏日号条 = 「上周一~周五」+ 竖线 + 「本周一~周五」固定 10 格 (用户 2026-10-24)。
         核心是「位置即周几」: 一组第一格永远是周一、第五格永远是周五。
         判据用符号串: *数字 = 有日报(深色500可点), 数字 = 无日报(灰), c = 休市(居中横杠),
         f = 还没走到(靠下横杠), | = 两周之间的竖线。 */
  const stripDump = () => page.evaluate(() => {
    const kids = [...document.getElementById('dayStrip').children];
    return {
      hidden: document.getElementById('dayStrip').classList.contains('hidden'),
      seq: kids.map(c => {
        if (c.classList.contains('ds-sep')) return '|';
        if (c.classList.contains('ds-cell')) return c.classList.contains('future') ? 'f' : 'c';
        return (getComputedStyle(c).fontWeight === '500' ? '*' : '') + c.textContent;
      }).join(' '),
      days: kids.filter(c => c.classList.contains('ds-day')).map(c => {
        const st = getComputedStyle(c);
        return {
          t: c.textContent, tag: c.tagName, w: st.fontWeight, color: st.color, cur: st.cursor,
          has: c.classList.contains('has-report'),
          href: c.getAttribute('href') || '', target: c.getAttribute('target') || '',
          rel: c.getAttribute('rel') || '',
        };
      }),
      gaps: kids.filter(c => c.classList.contains('ds-cell')).map(c => {
        const bar = c.querySelector('.ds-bar');
        const r = bar.getBoundingClientRect();
        return { kind: c.classList.contains('future') ? 'f' : 'c',
          bg: getComputedStyle(bar).backgroundColor,
          top: +r.top.toFixed(1), h: +r.height.toFixed(1), w: +r.width.toFixed(1) };
      }),
      at: document.getElementById('replayTime').textContent,
    };
  });
  const seekTo = (date, hh = 11) => page.evaluate(([d, h]) => {
    App.engine.pause();
    let best = -1;
    App.engine.bars.forEach((b, i) => {
      if (etDateStr(b.epoch, b.off) === d && etParts(b.epoch, b.off).hh === h) best = i;
    });
    if (best > 0) App.engine.seek(best);
    return best;
  }, [date, hh]);

  await page.click('#replayPillBtn');
  await page.waitForTimeout(120);
  await page.click('#modeSeg button[data-mode="custom"]');
  await page.fill('#startDate', '2015-04-27');
  await page.fill('#startTime', '09:35');
  await page.click('#startBtn');
  await waitLoaded(page);
  await page.waitForTimeout(500);

  /* (1) 今天=2015-05-01 周五: 上周 4/20~24 全有日报, 本周 27 28 没日报、29 30 1 有 */
  await seekTo('2015-05-01');
  await page.waitForTimeout(250);
  const strip = await stripDump();
  check('日号条 = 上周 5 格 + 竖线 + 本周 5 格 (位置即周几)',
        !strip.hidden && strip.seq === '*20 *21 *22 *23 *24 | 27 28 *29 *30 *1',
        `[${strip.at}] 实际 "${strip.seq}"`);
  check('日号条: 有日报=深色+500字重+新标签链接; 没日报=灰色400不可点',
        strip.days.length === 10
        && strip.days.filter(d => d.has).every(d => d.tag === 'A' && d.w === '500'
             && d.color === 'rgb(19, 23, 34)' && d.target === '_blank'
             && /^https:\/\//.test(d.href) && /noopener/.test(d.rel) && d.cur === 'pointer')
        && strip.days.filter(d => !d.has).every(d => d.tag === 'SPAN' && d.w === '400'
             && d.color === 'rgb(120, 123, 134)' && !d.href && d.cur === 'auto'),
        JSON.stringify(strip.days.map(d => d.t + ':' + d.tag + ':' + d.w)));

  /* (2) 今天=2015-12-28 周一: 上周五 12/25 圣诞休市(当时没有 K 线) → 居中横杠;
         本周 12/29~1/1 还没走到 → 靠下横杠。
         注意必须另起一段: 上一段的加载窗口只到 6 月中旬, 里面没有 12 月。 */
  await page.click('#replayPillBtn');
  await page.waitForTimeout(120);
  await page.click('#modeSeg button[data-mode="custom"]');
  await page.fill('#startDate', '2015-12-14');
  await page.fill('#startTime', '09:35');
  await page.click('#startBtn');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  await seekTo('2015-12-28');
  await page.waitForTimeout(250);
  const strip2 = await stripDump();
  check('日号条: 休市=居中横杠, 还没走到=靠下横杠 (位置 + 深浅双区分)',
        strip2.seq === '*21 *22 *23 24 c | *28 f f f f', `[${strip2.at}] 实际 "${strip2.seq}"`);
  const closed = strip2.gaps.find(g => g.kind === 'c');
  const fut = strip2.gaps.find(g => g.kind === 'f');
  check('未到的横杠比休市低约 6px, 而且颜色更淡',
        !!closed && !!fut && (fut.top - closed.top) >= 4
        && fut.bg !== closed.bg && fut.w === 9 && closed.w === 9,
        closed && fut
          ? `休市 top=${closed.top} ${closed.bg} / 未到 top=${fut.top} ${fut.bg}`
          : '没找到横杠');

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
  await giveSetup(page);
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

  /* 画一半鼠标滑出画布: 不许自动取消, 线条停在边界, 移回来继续 (用户 2026-10-22 要求)
     原来 mouseleave 里直接 cancel(), 手一抖滑出去整条就废了。 */
  {
    const cbox = await page.locator('#drawLayer').boundingBox();
    const dSt = () => page.evaluate(() => ({
      draft: !!Draw.draft, tool: Draw.tool,
      bx: Draw.draft ? +Draw.xOf(Draw.draft.b.t).toFixed(1) : null,
      W: +Draw.W.toFixed(1),
    }));
    await page.click('#drawBar button[data-tool="measure"]');
    await page.mouse.click(cbox.x + 420, cbox.y + 250);
    await page.waitForTimeout(120);
    const d0 = await dSt();
    // 甩到画布右侧外面 (画布右边界之外)
    const outX = Math.min(cbox.x + cbox.width + 200, 1590);
    await page.mouse.move(outX, cbox.y + 140, { steps: 8 });
    await page.waitForTimeout(140);
    const d1 = await dSt();
    check('画一半鼠标滑出画布不取消, 线条停在右边界',
      d0.draft && d1.draft && d1.tool === 'measure' && Math.abs(d1.bx - d1.W) < 4,
      JSON.stringify(d1));
    // 移回来: 第二点重新跟手
    await page.mouse.move(cbox.x + 620, cbox.y + 330, { steps: 10 });
    await page.waitForTimeout(140);
    const d2 = await dSt();
    check('鼠标移回画布后继续跟随', d2.draft && Math.abs(d2.bx - 620) < 8, JSON.stringify(d2));
    // 从上方边界滑出也要保持绘制中
    await page.mouse.move(cbox.x + 620, Math.max(cbox.y - 60, 2), { steps: 6 });
    await page.waitForTimeout(140);
    const d3 = await dSt();
    check('鼠标从上方滑出画布也不取消', d3.draft, JSON.stringify(d3));
    // 回来点第二下, 仍能正常完成
    await page.mouse.move(cbox.x + 620, cbox.y + 330, { steps: 6 });
    await page.waitForTimeout(80);
    await page.mouse.click(cbox.x + 620, cbox.y + 330);
    await page.waitForTimeout(150);
    const d4 = await page.evaluate(() => ({
      draft: !!Draw.draft, tool: Draw.tool,
      measures: Draw.items.filter(i => i.type === 'measure').length, total: Draw.count(),
    }));
    check('滑出过画布的一次绘制仍能正常完成',
      !d4.draft && d4.tool === 'cursor' && d4.measures === 1 && d4.total === 2, JSON.stringify(d4));
  }

  /* 拖动既有图元时滑出画布松开: 必须清掉 _drag, 否则回来动鼠标会"隔空拖图" */
  {
    const cbox = await page.locator('#drawLayer').boundingBox();
    const n0 = await page.evaluate(() => Draw.count());
    await page.click('#drawBar button[data-tool="hline"]');
    await page.mouse.click(cbox.x + 400, cbox.y + 300);
    await page.waitForTimeout(150);
    await page.click('#sideToolbar button[data-tool="cursor"]');
    await page.mouse.move(cbox.x + 400, cbox.y + 300);
    await page.mouse.down();
    await page.waitForTimeout(80);
    const dragging = await page.evaluate(() => !!Draw._drag);
    await page.mouse.move(Math.min(cbox.x + cbox.width + 200, 1590), cbox.y + 260, { steps: 10 });
    await page.waitForTimeout(120);
    await page.mouse.up();
    await page.waitForTimeout(150);
    const g1 = await page.evaluate(() => {
      const it = Draw.items.filter(i => i.type === 'hline').pop();
      return { drag: !!Draw._drag, p: it ? it.a.p : null };
    });
    await page.mouse.move(cbox.x + 300, cbox.y + 500, { steps: 8 });
    await page.waitForTimeout(130);
    const g2 = await page.evaluate(() => Draw.items.filter(i => i.type === 'hline').pop().a.p);
    check('拖图元时在画布外松开不会粘住鼠标',
      dragging && !g1.drag && g1.p === g2,
      `拖拽中=${dragging} 松开后drag=${g1.drag} 松开价=${g1.p && g1.p.toFixed(2)} 再移动=${g2.toFixed(2)}`);
    // 清掉这条临时线, 后面用例仍按原来的图元数量断言
    await page.evaluate(() => {
      const it = Draw.items.filter(i => i.type === 'hline').pop();
      if (it) Draw.removeById(it.id);
    });
    await page.waitForTimeout(80);
    check('临时水平线已清理(不影响后续计数)', (await page.evaluate(() => Draw.count())) === n0, `${n0}`);
  }

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

  /* ---------- v1.2.9 绘图存档: 按周期分桶 (用户 2026-10-24) ----------
     原行为「换周期就清空」；现在是「各周期各存各的: 切走看不到, 切回来原样还在」。 */
  await page.click('#drawBar button[data-tool="trend"]');
  await draw2(P(300, 160), P(500, 300));
  const beforeTf = await page.evaluate(() => ({
    n: Draw.count(), type: Draw.items[0] && Draw.items[0].type,
    a: Draw.items[0] && Draw.items[0].a, b: Draw.items[0] && Draw.items[0].b,
  }));
  await page.click('#tfGroup button[data-tf="15m"]');
  await waitLoaded(page);
  await page.waitForTimeout(500);
  check('换周期后看不到别的周期画的线',
        beforeTf.n === 1 && (await page.evaluate(() => Draw.count())) === 0,
        `5m 上 ${beforeTf.n} 根 → 15m 上 ${await page.evaluate(() => Draw.count())} 根`);

  // 在 15m 上另画一根水平线, 再切回 5m: 两根各归各的桶
  await page.click('#drawBar button[data-tool="hline"]');
  await page.mouse.click(P(420, 380).x, P(420, 380).y);
  await page.waitForTimeout(150);
  const in15 = await page.evaluate(() => Draw.count());
  await page.click('#tfGroup button[data-tf="5m"]');
  await waitLoaded(page);
  await page.waitForTimeout(700);
  const back5 = await page.evaluate(() => ({
    n: Draw.count(), type: Draw.items[0] && Draw.items[0].type,
    a: Draw.items[0] && Draw.items[0].a, b: Draw.items[0] && Draw.items[0].b,
  }));
  check('切回原周期, 那根趋势线原样回来 (锚点一点没变)',
        in15 === 1 && back5.n === 1 && back5.type === 'trend'
        && JSON.stringify(back5.a) === JSON.stringify(beforeTf.a)
        && JSON.stringify(back5.b) === JSON.stringify(beforeTf.b),
        `15m 上 ${in15} 根 → 5m 上 ${back5.n} 根 ${back5.type}`);

  /* 存档双写: localStorage 即时 + data/draw.json 落盘 (写磁盘节流 800ms, 等它写完再比) */
  await page.waitForFunction(async () => {
    try {
      const r = await fetch('/api/draw', { cache: 'no-store' });
      const o = await r.json();
      return !!(o && o.byTf && (o.byTf['5m'] || []).length && (o.byTf['15m'] || []).length);
    } catch (e) { return false; }
  }, { timeout: 8000 }).catch(() => { });
  const store = await page.evaluate(async () => {
    const ls = JSON.parse(localStorage.getItem('es_replay_draw') || 'null');
    let disk = null;
    try { const r = await fetch('/api/draw', { cache: 'no-store' }); disk = await r.json(); } catch (e) { }
    const pick = (o, k) => (o && o.byTf && o.byTf[k] ? o.byTf[k].length : -1);
    return { ls5m: pick(ls, '5m'), ls15m: pick(ls, '15m'), disk5m: pick(disk, '5m'), disk15m: pick(disk, '15m') };
  });
  check('存档按周期分桶, localStorage 与磁盘两边都有',
        store.ls5m === 1 && store.ls15m === 1 && store.disk5m === 1 && store.disk15m === 1,
        JSON.stringify(store));

  /* ---------- v1.2.9 拖动: 任意方向 (原来只算价格增量, 横向不动) ---------- */
  await page.click('#sideToolbar button[data-tool="cursor"]');
  const dragBefore = await page.evaluate(() => {
    const it = Draw.items.filter(i => i.type === 'trend').pop();
    const pa = Draw._px(it.a), pb = Draw._px(it.b);
    const r = Draw.canvas.getBoundingClientRect();
    return {
      id: it.id, at: it.a.t, bt: it.b.t, ap: it.a.p, bp: it.b.p,
      ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y,
      mx: r.left + (pa.x + pb.x) / 2, my: r.top + (pa.y + pb.y) / 2,
    };
  });
  await page.mouse.move(dragBefore.mx, dragBefore.my);
  await page.mouse.down();
  await page.mouse.move(dragBefore.mx - 80, dragBefore.my + 40, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(220);
  const dragAfter = await page.evaluate(id => {
    const it = Draw.items.find(i => i.id === id);
    if (!it) return null;
    const pa = Draw._px(it.a), pb = Draw._px(it.b);
    return { at: it.a.t, bt: it.b.t, ap: it.a.p, bp: it.b.p, ax: pa.x, bx: pb.x };
  }, dragBefore.id);
  const dxA = dragAfter ? dragAfter.ax - dragBefore.ax : NaN;
  const dxB = dragAfter ? dragAfter.bx - dragBefore.bx : NaN;
  check('趋势线能左右拖 (两个端点一起横移, 不再只上下)',
        !!dragAfter && dragAfter.at !== dragBefore.at && dragAfter.bt !== dragBefore.bt
        && Math.abs(dxA + 80) < 6 && Math.abs(dxB + 80) < 6,
        `Δx A=${dxA.toFixed(1)} B=${dxB.toFixed(1)}`);
  check('左右拖的同时上下位移还在 (整体平移, 两端等量)',
        !!dragAfter && dragAfter.ap < dragBefore.ap && dragAfter.bp < dragBefore.bp
        && Math.abs((dragAfter.ap - dragBefore.ap) - (dragAfter.bp - dragBefore.bp)) < 0.01,
        `Δp A=${(dragAfter.ap - dragBefore.ap).toFixed(2)} B=${(dragAfter.bp - dragBefore.bp).toFixed(2)}`);

  /* ---------- v1.2.9 复制: 选中 → Ctrl+C → Ctrl+V ---------- */
  const selPt = await page.evaluate(() => {
    const it = Draw.items.filter(i => i.type === 'trend').pop();
    const pa = Draw._px(it.a), pb = Draw._px(it.b);
    const r = Draw.canvas.getBoundingClientRect();
    return { mx: r.left + (pa.x + pb.x) / 2, my: r.top + (pa.y + pb.y) / 2 };
  });
  await page.mouse.click(selPt.mx, selPt.my);
  await page.waitForTimeout(120);
  check('点中趋势线进入选中态 (复制的起点)',
        (await page.evaluate(() => Draw.selected)) != null,
        'selected=' + await page.evaluate(() => Draw.selected));

  await page.keyboard.press('Control+c');
  const copied = await page.evaluate(() =>
    Draw._clip ? { type: Draw._clip.type, hasId: 'id' in Draw._clip } : null);
  check('Ctrl+C 把选中图元放进剪贴板 (摘掉 id, 免得和原图撞)',
        !!copied && copied.type === 'trend' && !copied.hasId, JSON.stringify(copied));

  await page.keyboard.press('Control+v');
  await page.waitForTimeout(220);
  const pasteRes = await page.evaluate(() => {
    const arr = Draw.items.filter(i => i.type === 'trend');
    const a = arr[0], b = arr[arr.length - 1];
    const pa = a && Draw._px(a.a), pb = b && Draw._px(b.a);
    return {
      n: arr.length, selIsNew: Draw.selected === b.id,
      dx: (pa && pb) ? pb.x - pa.x : null, dp: b.a.p - a.a.p,
      ids: arr.map(i => i.id),
    };
  });
  check('Ctrl+V 粘出一份副本, 粘完自动选中新那份',
        pasteRes.n === 2 && pasteRes.selIsNew, JSON.stringify(pasteRes));
  check('副本落在原图右下方 (3 根 K 线 / 2.5 点)',
        pasteRes.dx != null && pasteRes.dx > 20 && Math.abs(pasteRes.dp + 2.5) < 0.01,
        `Δx=${pasteRes.dx && pasteRes.dx.toFixed(1)}px Δp=${pasteRes.dp && pasteRes.dp.toFixed(2)}`);
  check('副本是独立图元 (自己的 id), 不是共享同一个对象',
        new Set(pasteRes.ids).size === 2, JSON.stringify(pasteRes.ids));

  /* ---------- v1.2.9 快捷键: Ctrl 组合绝不能再落进单键分支 ----------
     原来 Ctrl+C 的 e.key 就是 'c', 会直接 closePosition() —— 想复制一根线结果平了仓。 */
  const keyProbe = await page.evaluate(() => {
    const hit = { close: 0, buy: 0, sell: 0, restart: 0 };
    const oClose = App.closePosition, oOrder = App.placeOrder;
    const oRestart = App.engine && App.engine.restart;
    try {
      App.closePosition = () => { hit.close++; };
      App.placeOrder = side => { if (side === 'buy') hit.buy++; else hit.sell++; };
      if (App.engine) App.engine.restart = () => { hit.restart++; };
      const fire = (key, ctrl) => document.dispatchEvent(
        new KeyboardEvent('keydown', { key, ctrlKey: !!ctrl, bubbles: true, cancelable: true }));
      fire('c', true); fire('s', true); fire('b', true); fire('r', true);
    } finally {
      App.closePosition = oClose; App.placeOrder = oOrder;
      if (App.engine && oRestart) App.engine.restart = oRestart;
    }
    return hit;
  });
  check('Ctrl+C / S / B / R 不再误触平仓·下单·重开始',
        keyProbe.close === 0 && keyProbe.buy === 0 && keyProbe.sell === 0 && keyProbe.restart === 0,
        JSON.stringify(keyProbe));

  const plainProbe = await page.evaluate(() => {
    const hit = { buy: 0, sell: 0, restart: 0 };
    const oOrder = App.placeOrder;
    const oRestart = App.engine && App.engine.restart;
    try {
      App.placeOrder = side => { if (side === 'buy') hit.buy++; else hit.sell++; };
      if (App.engine) App.engine.restart = () => { hit.restart++; };
      ['b', 's', 'r'].forEach(key => document.dispatchEvent(
        new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));
    } finally {
      App.placeOrder = oOrder;
      if (App.engine && oRestart) App.engine.restart = oRestart;
    }
    return hit;
  });
  check('B / S / R 三个单键已按用户要求去掉',
        plainProbe.buy === 0 && plainProbe.sell === 0 && plainProbe.restart === 0,
        JSON.stringify(plainProbe));

  await page.click('#tfGroup button[data-tf="5m"]');
  await waitLoaded(page);
  await page.waitForTimeout(400);

  /* 15. 右键突破单 + 拖动交易线 + 止盈止损 */
  // (a) 纯逻辑: 止损=前5根极值外1tick / 止盈=2R / 下一根就扫到2R→改挂入场K线另一侧
  const logic = await page.evaluate(() => {
    const mk = (o, h, l, c, epoch) => ({ o, h, l, c, epoch: epoch || 0, off: 0, t: 0 });
    const R = {};
    // v1.1 新增的 risk_locked 只是「R 的分母已锁定」通知, 不属于止盈止损事件
    const clean = (xs) => xs.filter(e => e.type !== 'risk_locked').map(e => e.kind || e.type);
    // 前 5 根: 最低 99, 最高 100.5 → 做多入场 100, 止损 99-0.25=98.75, 风险 1.25, 止盈 102.5
    const prev = [mk(100, 100.5, 99.5, 100), mk(100, 100.5, 99, 100), mk(100, 100.5, 99.2, 100),
                  mk(100, 100.5, 99.4, 100), mk(100, 100.5, 99.1, 100)];

    Trading.reset();
    // 入场那根是大 K 线 (h=103), 后面"改挂另一侧"要用到
    Trading.fill('buy', 1, 100, 'market', 0, 0, { bar: mk(100, 103, 99.5, 102.5, 0), prev });
    R.longBracket = [Trading.tp, Trading.sl];
    // 入场当根不判止盈止损 (哪怕这一根自己就穿过了 2R)
    R.entrySkip = Trading.checkBar(mk(101, 120, 90, 119, 0), 0, 0).map(e => e.kind || e.type);
    R.afterSkipPos = Trading.pos;
    // 开仓后第一根就扫到 2R(102.5) → 改挂入场K线另一侧(103), 不平仓
    const ev1 = Trading.checkBar(mk(101, 103, 100, 102.8, 60), 60, 0);
    R.extend = { ev: ev1.filter(e => e.type !== 'risk_locked').map(e => e.type + ':' + (e.kind || '')), tp: Trading.tp, pos: Trading.pos };
    // 再下一根摸到新止盈 103 → 正常平仓, (103-100)*50 = 150
    const ev2 = Trading.checkBar(mk(102, 104, 101, 103.5, 120), 120, 0);
    R.extendExit = { ev: clean(ev2), pos: Trading.pos, realized: Trading.realized };

    // 止损: 前 5 根最低 99 → 98.75, 下一根跌到 97 触发, (98.75-100)*50 = -62.5
    Trading.reset();
    Trading.fill('buy', 1, 100, 'market', 0, 0, { bar: mk(100, 100.5, 99.8, 100, 0), prev });
    const ev3 = Trading.checkBar(mk(99, 99.5, 97, 97.5, 60), 60, 0);
    R.slExit = { ev: clean(ev3), pos: Trading.pos, realized: Trading.realized };

    // 空头: 前 5 根最高 100.5 → 止损 100.75, 风险 0.75, 止盈 98.5
    Trading.reset();
    Trading.fill('sell', 1, 100, 'market', 0, 0, { bar: mk(100, 100.5, 99.5, 100, 0), prev });
    R.shortBracket = [Trading.tp, Trading.sl];
    const ev4 = Trading.checkBar(mk(99, 100.4, 98.2, 98.6, 60), 60, 0);
    R.shortTp = { ev: clean(ev4), pos: Trading.pos, realized: Trading.realized };

    Trading.reset();
    Trading.placeStop('buy', 1, 100);
    const ev5 = Trading.checkBar(mk(105, 108, 104, 106), 0, 0);   // 跳空高开按开盘价成交
    R.gapFill = [ev5.map(e => e.type).join(), Trading.pos, Trading.avg];

    Trading.reset();
    Trading.placeStop('sell', 1, 100);
    const ev6 = Trading.checkBar(mk(105, 108, 101, 106), 0, 0);   // 未跌破不触发
    R.notFilled = [ev6.length, Trading.stops.length];
    Trading.reset();
    return R;
  });
  check('开仓止损=前5根极值外1tick, 止盈=2R',
        Math.abs(logic.longBracket[1] - 98.75) < 1e-9 && Math.abs(logic.longBracket[0] - 102.5) < 1e-9
        && Math.abs(logic.shortBracket[1] - 100.75) < 1e-9 && Math.abs(logic.shortBracket[0] - 98.5) < 1e-9,
        '多 TP/SL ' + JSON.stringify(logic.longBracket) + ' / 空 ' + JSON.stringify(logic.shortBracket));
  check('入场当根不判止盈止损', logic.entrySkip.length === 0 && logic.afterSkipPos === 1,
        JSON.stringify(logic.entrySkip) + ' pos=' + logic.afterSkipPos);
  check('下一根就扫到 2R → 止盈改挂入场K线另一侧, 不平仓',
        logic.extend.ev.join() === 'tp_extend:' && Math.abs(logic.extend.tp - 103) < 1e-9 && logic.extend.pos === 1,
        JSON.stringify(logic.extend));
  check('改挂之后摸到新止盈才平仓',
        logic.extendExit.ev.join() === 'tp' && logic.extendExit.pos === 0
        && Math.abs(logic.extendExit.realized - 150) < 1e-6, JSON.stringify(logic.extendExit));
  check('止损按前5根极值触发平仓', logic.slExit.ev.join() === 'sl' && logic.slExit.pos === 0
        && Math.abs(logic.slExit.realized + 62.5) < 1e-6, JSON.stringify(logic.slExit));
  check('空头止盈在下方', logic.shortTp.ev.join() === 'tp' && Math.abs(logic.shortTp.realized - 75) < 1e-6,
        JSON.stringify(logic.shortTp));
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
  await giveSetup(page);
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
  await giveSetup(page);
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
  await giveSetup(page);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(90);
  await giveSetup(page);
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

  await giveSetup(page);
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

  /* ---- 入场 / 出场 靠颜色区分 (用户 2026-10-24: 原来两者同色, 分不清 → 出场改灰 #787b86) ----
     判据是 Trading.fill() 的 closed: >0 说明这次成交平掉了仓位。
     下面用真实下单接口把「哪种成交算出场」的四个分支都过一遍:
       回合  开 1 手 → 手动平          = 入场 + 出场
       加仓  开 1 手 → 同向再开 1 手   = 入场 + 入场   (加仓不是出场)
       减仓  开 2 手 → 反向卖 1 手     = 入场 + 出场   (还有 1 手在场, 仍是出场)
       突破  持仓中反向突破单成交      = 入场 + 出场   (Trading.checkBar 传来的 closed) */
  const mkKinds = await page.evaluate(() => {
    const fmt = () => ChartMgr.markers.map(m => (m.isExit ? 'E' : 'N') + (m.shape === 'arrowUp' ? 'b' : 's')).join(' ');
    const flat = () => { if (Trading.pos !== 0) App.closePosition(); };
    const run = seeds => {
      flat(); ChartMgr.setMarkers([]);
      App.orderType = 'market';
      const q = document.getElementById('orderQty');
      for (const [n, s] of seeds) { q.value = String(n); App._doPlaceOrder(s); }
      const out = fmt();
      flat();
      return out;
    };
    const round = run([[1, 'buy'], [1, 'sell']]);
    const add = run([[1, 'buy'], [1, 'buy']]);
    const trim = run([[2, 'buy'], [1, 'sell']]);

    // 持仓中反向突破单成交 → 这笔成交是平仓 (靠 checkBar 事件带过来的 closed 判定)
    flat(); ChartMgr.setMarkers([]);
    const q = document.getElementById('orderQty');
    q.value = '1'; App._doPlaceOrder('buy');
    const b = App.engine.current;
    Trading.placeStop('sell', 1, b.l, { tp: null, sl: null, placeTf: ChartMgr.tf });
    // 造一根当根同高的假 K 线喂给交易检查: 刚好扫到这张卖单, 又碰不到止盈/止损
    App.runTradeChecks({ epoch: b.epoch + 60, off: b.off, o: b.c, h: b.h, l: b.l, c: b.c });
    const stop = fmt();
    flat(); Trading.clearStops();
    return { round, add, trim, stop };
  });
  check('成交种类判对: 开→平=入场+出场 / 加仓=入场+入场 / 减仓=入场+出场 / 反手突破单=入场+出场',
        mkKinds.round === 'Nb Es' && mkKinds.add === 'Nb Nb'
        && mkKinds.trim === 'Nb Es' && mkKinds.stop === 'Nb Es',
        JSON.stringify(mkKinds));

  /* 像素验收: 入场那枚还是青绿, 出场那枚是灰 #787b86 (120,123,134)。
     中间隔一根 K 线再平, 免得两枚箭头贴在一起互相污染取样窗。 */
  const mkColor = await page.evaluate(async () => {
    const raf = () => new Promise(r => requestAnimationFrame(r));
    if (App.engine.playing) App.engine.pause();
    if (Trading.pos !== 0) App.closePosition();
    ChartMgr.setMarkers([]);
    App.orderType = 'market';
    const q = document.getElementById('orderQty');
    q.value = '1';
    App._doPlaceOrder('buy');                    // 入场
    App.engine.step(1);                          // 换下一根
    if (Trading.pos !== 0) App.closePosition();  // 出场 (若上一根已被止盈止损扫掉, 这里就是空操作)

    const i = App.engine.idx;
    ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: i - 60, to: i + 8 });
    await raf(); await raf();
    Draw.render();

    const c = document.getElementById('drawLayer');
    const k = c.width / parseFloat(c.style.width || c.width);
    const ctx = c.getContext('2d');
    const countAt = (cx, cy, col) => {
      const x = Math.round(cx * k), y = Math.round(cy * k);
      const n = Math.max(6, Math.round(8 * k));
      if (x - n < 0 || y - n < 0 || x + n > c.width || y + n > c.height) return -1;
      const d = ctx.getImageData(x - n, y - n, n * 2, n * 2).data;
      let c0 = 0;
      for (let j = 0; j < d.length; j += 4) {
        if (Math.abs(d[j] - col[0]) < 12 && Math.abs(d[j + 1] - col[1]) < 12 && Math.abs(d[j + 2] - col[2]) < 12) c0++;
      }
      return c0;
    };
    const TEAL = [112, 204, 189], RED = [204, 47, 60], GRAY = [120, 123, 134];
    const out = [];
    for (const m of ChartMgr.markers) {
      const b = ChartMgr.barByTime(m.time);
      if (!b) { out.push({ miss: m.time }); continue; }
      const buy = m.shape === 'arrowUp';
      const ye = Draw.yOf(buy ? b.l : b.h);
      const cy = buy ? ye + Draw.MARK_GAP + Draw.MARK.h / 2 : ye - Draw.MARK_GAP - Draw.MARK.h / 2;
      const x = Draw.xOf(b.t);
      out.push({
        exit: !!m.isExit, buy, pos: m.position, time: m.time,
        teal: countAt(x, cy, TEAL), red: countAt(x, cy, RED), gray: countAt(x, cy, GRAY),
      });
    }
    return out;
  });
  check('入场箭头仍是青绿 #70ccbd, 出场箭头画成灰 #787b86',
        mkColor.length === 2
        && mkColor[0].exit === false && mkColor[0].teal > 90 && mkColor[0].gray < 30
        && mkColor[1].exit === true && mkColor[1].gray > 90 && mkColor[1].teal < 30 && mkColor[1].red < 30,
        JSON.stringify(mkColor));

  /* 手动平空仓时的箭头方向: 曾经有个 bug —— addMarker 在 fill 之后才读 Trading.pos,
     而那时仓位已经归零, 于是平空仓也画成"买"(K 下朝上)。这里把空仓那条路径钉死。 */
  const shortExit = await page.evaluate(() => {
    if (Trading.pos !== 0) App.closePosition();
    ChartMgr.setMarkers([]);
    App.orderType = 'market';
    const q = document.getElementById('orderQty');
    q.value = '1';
    App._doPlaceOrder('sell');            // 开空
    App.closePosition();                  // 平空 → 应该是"买"方向 (K 下, 朝上), 但必须是灰的
    const m = ChartMgr.markers[1] || {};
    return { shape: m.shape, position: m.position, isExit: !!m.isExit };
  });
  check('平空仓的出场箭头方向正确 (买/朝上/在 K 线下方) 且为灰色',
        shortExit.shape === 'arrowUp' && shortExit.position === 'belowBar' && shortExit.isExit === true,
        JSON.stringify(shortExit));

  /* ---- v1.2.7 从账本重建盘面箭头 ----
     用户 2026-10-24: 「右侧列表确实显示了, 但中间没显示上下箭头」。
     原因是箭头只活在内存 (addMarker 往 ChartMgr.markers 里塞), 刷新就没; 列表是从账本读的。
     这里验四件事: ① 账本能还原两端 ② 窗口外的不乱摆 ③ 刷新后 (流水没了) 仍在 ④ 持仓中的入场不丢。 */
  const rb = await page.evaluate(() => {
    const q = document.getElementById('orderQty');
    /* 账本里可能已有几十笔 (历次 e2e + 手工练习), 重建会把它们全带进来。
       所以断言必须"按这一笔"定位 —— 用「时间 + 价格」挑出来, 不能数 ChartMgr.markers 的总数。 */
    const pick = (wall, price, isExit) => {
      const t = App._wallSec(wall);
      return ChartMgr.markers.filter(m => m.time === t && m.price === price && !!m.isExit === isExit);
    };
    const info = arr => arr.map(m => ({
      shape: m.shape, position: m.position, price: m.price,
      hit: !!ChartMgr.barByTime(m.time),
    }));
    if (Trading.pos !== 0) App.closePosition();

    // 造一笔真交易进账本 (空单: 入场朝下红, 出场朝上灰)
    /* 注意不能用 trades[trades.length-1] 取"刚那笔": Journal.addTrade 内部按 exitEpoch 排序,
       取末位拿到的是"行情时间最晚的那笔", 可能是本场次更早、甚至别的窗口里的交易。
       用 id 差集取新增的那一条, 跟账本里已有什么完全无关。 */
    const hadIds = new Set(Journal.data.trades.map(x => x.id));
    ChartMgr.setMarkers([]);
    App.orderType = 'market';
    App.pendingSetup = 'feel'; App.pendingCycle = 'range';
    q.value = '1';
    App._doPlaceOrder('sell');
    App.closePosition();
    const t = Journal.data.trades.find(x => !hadIds.has(x.id));
    if (!t) {
      const empty = { ent: [], ex: [] };
      return { err: '这段没造出账本记录 (下单被拦了?)', rec: {}, rebuilt: empty, outOfWin: empty, afterReload: empty, openAtNow: [] };
    }
    const rec = {
      side: t.side, entryTime: t.entryTime, exitTime: t.exitTime,
      entryPrice: t.entryPrice, exitPrice: t.exitPrice,
      entryEpoch: t.entryEpoch, exitEpoch: t.exitEpoch,
    };

    /* ① 干净重建: 清掉内存箭头 + 清掉本场成交流水, 只剩账本一条路径 */
    ChartMgr.setMarkers([]); Trading.trades.length = 0; App._mkSig = null;
    App.rebuildMarkers();
    const rebuilt = { ent: info(pick(t.entryTime, t.entryPrice, false)), ex: info(pick(t.exitTime, t.exitPrice, true)) };

    /* ② 把这笔挪到 1999 年 (窗口外): 两个箭头还在数组里, 但一根 K 线都对不上 ——
          drawTradeMarkers 靠 barByTime 返 null 跳过, 所以不会画到别的 K 线上 */
    const saved = Journal.data.trades.slice();
    const OUT_T = ['1999-01-04 10:00 ET', '1999-01-04 10:30 ET'];
    Journal.data.trades = saved.map(x => (x.id === t.id
      ? { ...x, entryTime: OUT_T[0], exitTime: OUT_T[1], entryEpoch: 915098400, exitEpoch: 915100200 }
      : x));
    ChartMgr.setMarkers([]); App._mkSig = null;
    App.rebuildMarkers();
    const outOfWin = {
      ent: info(pick(OUT_T[0], t.entryPrice, false)),
      ex: info(pick(OUT_T[1], t.exitPrice, true)),
    };
    Journal.data.trades = saved;

    /* ③ 刷新后的等效路径: 没有成交流水时 refreshMarkers 必须走账本重建 */
    ChartMgr.setMarkers([]); App._mkSig = null;
    App.refreshMarkers();
    const afterReload = { ent: info(pick(t.entryTime, t.entryPrice, false)), ex: info(pick(t.exitTime, t.exitPrice, true)) };

    /* ④ 持仓中 (这一笔还没写进账本) 也要有入场箭头 —— 切周期时它还在手上。
         做法跟真实切周期一样: 清空盘面 + 清空成交流水, 再走一次重建。 */
    ChartMgr.setMarkers([]); Trading.trades.length = 0; App._mkSig = null;
    q.value = '1';
    App.pendingSetup = 'feel'; App.pendingCycle = 'range';   // setup 用完即清, 第二单要重新选
    App._doPlaceOrder('buy');
    ChartMgr.setMarkers([]); Trading.trades.length = 0; App._mkSig = null;
    App.rebuildMarkers();
    const cur = App.engine.current;
    const tNow = chartTime(cur.epoch, cur.off);
    const openAtNow = ChartMgr.markers
      .filter(m => m.time === tNow && !m.isExit && m.shape === 'arrowUp')
      .map(m => m.price);
    App.closePosition();
    ChartMgr.setMarkers([]); App._mkSig = null;

    return { rec, rebuilt, outOfWin, afterReload, openAtNow };
  });

  check('账本记了入场时间戳 entryEpoch (刷新后重建箭头不用反解时区)',
        typeof rb.rec.entryEpoch === 'number' && rb.rec.entryEpoch > 0
        && rb.rec.entryEpoch <= rb.rec.exitEpoch
        && Math.abs(rb.rec.exitEpoch - rb.rec.entryEpoch) < 86400,
        JSON.stringify({ entryEpoch: rb.rec.entryEpoch, exitEpoch: rb.rec.exitEpoch }) + (rb.err ? ' · ' + rb.err : ''));

  /* 用 >= 1 而不是 == 1: 同一根 K 线、同一价位上完全可能有两笔一模一样的交易
     (这套用例里就有好几笔"市价开 → 立刻平"落在同一根上), 那本来就该画两个箭头。 */
  check('从账本重建: 空单的入场(红/朝下/K上) + 出场(灰/朝上/K下) 两端都摆回来, 价格取自账本',
        rb.rebuilt.ent.length >= 1
        && rb.rebuilt.ent.every(m => m.shape === 'arrowDown' && m.position === 'aboveBar' && m.hit === true)
        && rb.rebuilt.ex.length >= 1
        && rb.rebuilt.ex.every(m => m.shape === 'arrowUp' && m.position === 'belowBar' && m.hit === true),
        JSON.stringify(rb.rebuilt));

  check('窗口外的交易不进盘面 (数组里留着, 但一根 K 线都对不上 → 不会被画到别处)',
        rb.outOfWin.ent.length === 1 && rb.outOfWin.ent[0].hit === false
        && rb.outOfWin.ex.length === 1 && rb.outOfWin.ex[0].hit === false,
        JSON.stringify(rb.outOfWin));

  check('刷新后 (成交流水清空) 箭头仍由账本重建, 不用重新下单',
        rb.afterReload.ent.length >= 1 && rb.afterReload.ent.every(m => m.hit === true)
        && rb.afterReload.ex.length >= 1 && rb.afterReload.ex.every(m => m.hit === true),
        JSON.stringify(rb.afterReload));

  check('持仓中还没写进账本的那一笔, 入场箭头也在 (切周期不丢)',
        rb.openAtNow.length >= 1,
        JSON.stringify({ 本根K线的入场买箭头: rb.openAtNow }));

  /* 上面几段把仓位都平干净了, 而后面「交易线右侧牌子」用例是接着一笔**持仓中**的交易做的。
     原来那个状态是靠早期突破单成交后一直持有留下的, 这里补一笔市价开仓把 tp/sl 挂回来。
     tp/sl 要按当前可见价格区间拉开: 市价单的自动括号有时只有 2 个点, 而 draw.js 有
     「牌子离入场线不到 26px 就跳过」的去重叠逻辑, 太近会导致 tp/sl 两块牌子都不出来。 */
  await page.evaluate(() => {
    if (Trading.pos === 0) {
      App.orderType = 'market';
      document.getElementById('orderQty').value = '1';
      App._doPlaceOrder('buy');        // 空仓开多 → setAutoBrackets 自动挂 tp/sl
    }
    const vis = App.visibleBars() || [];
    if (vis.length) {
      const hi = Math.max(...vis.map(b => b.h)), lo = Math.min(...vis.map(b => b.l));
      const span = Math.max(hi - lo, 8);
      // 0.16 / 0.10 是量出来的: 再远一点止损牌就掉到时间轴那条带里, 点 ✕ 会点不中
      Trading.tp = Math.round((Trading.avg + span * 0.16) * 100) / 100;
      Trading.sl = Math.round((Trading.avg - span * 0.10) * 100) / 100;
      Trading.save();
    }
    App.renderTrading(); Draw.render();
  });

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
  // 用户 2026-10-22: 最下面那条时间轴的「xx日」不要那个「日」字
  check('时间轴日刻度不带「日」字 (只出数字)', axisFmt.every(s => !/日/.test(s)), axisFmt.join(' | '));
  check('图例品种名只写 ES', (await page.textContent('.lg-name')).trim().startsWith('ES ·'),
        await page.textContent('.lg-name'));
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

  /* 19. 日报跳转 (data/reports.json + 时间轴下划线 + 点击新标签页)
   *  关键口径 (用户 2026-10-22): 有日报的日期数字下加短下划线; 整条时间轴都能点;
   *  下划线只画在"库真正显示了日期数字刻度"的那几天 (日内图日刻度隔天稀疏, 不是每天都有) */
  await page.fill('#gotoInput', '2024-03-15 11:00');
  await page.click('#gotoBtn');
  await page.waitForTimeout(1200);
  await page.evaluate(() => App.engine.pause());
  await page.click('#tfGroup button[data-tf="1h"]');      // 切 1h: 一个窗口覆盖多天
  await page.waitForTimeout(1400);
  await page.evaluate(() => App.engine.pause());
  await page.waitForTimeout(400);

  check('日报索引已加载 (2928 天)', (await page.evaluate(() => Reports.ready() && Reports.size())) > 2500,
        await page.evaluate(() => String(Reports.size())));

  const repMark = await page.evaluate(() => {
    const marks = Draw.reportMarks();
    const tickDates = (ChartMgr._dayTickTimes || []).map(chartDateStr);
    return {
      n: marks.length,
      dates: marks.map(m => m.date),
      allInTicks: marks.every(m => tickDates.includes(m.date)),   // 下划线必须全落在日刻度上
      allHaveReport: marks.every(m => Reports.has(m.date)),
      xInRange: marks.every(m => m.x > 0 && m.x < Draw.W),
    };
  });
  check('1h 窗口有时间轴日报下划线', repMark.n >= 3, 'n=' + repMark.n + ' ' + repMark.dates.join(','));
  check('下划线只画在库显示日期数字的刻度下 (不落在 12:30 等时分刻度下)', repMark.allInTicks,
        JSON.stringify(repMark.dates));
  check('下划线日期全部有日报', repMark.allHaveReport);
  check('下划线 x 在画布内', repMark.xInRange);

  // 点击有日报的那天 → 新标签页打开正确 URL
  const repTarget = await page.evaluate(() => {
    const m = Draw.reportMarks().find(m => m.x > 60 && m.x < Draw.W - 120);
    return m && { x: Math.round(m.x), d: m.date, url: m.url };
  });
  if (repTarget) {
    const cb = await page.locator('#drawLayer').boundingBox();
    const axisY = cb.y + await page.evaluate(() => Draw._priceAreaHeight()) + 14;
    const popupP = page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null);
    await page.mouse.click(cb.x + repTarget.x, axisY);
    const popup = await popupP;
    check('点日期数字 → 新标签页打开该日日报', !!popup && popup.url() === repTarget.url,
          repTarget.d + ' → ' + (popup ? popup.url() : '没弹'));
    if (popup) await popup.close();

    /* 回来之后不能卡在"鼠标一直按着"的状态:
       mouseup 若被 stopPropagation 拦住, 图表(document 冒泡阶段监听)收不到,
       不按键光移鼠标图表就跟着平移 —— 用户 2026-10-22 报的 bug */
    await page.bringToFront();
    const lrA = await page.evaluate(() => {
      const r = ChartMgr.chart.timeScale().getVisibleLogicalRange();
      return [Math.round(r.from * 100) / 100, Math.round(r.to * 100) / 100];
    });
    await page.mouse.move(cb.x + 600, cb.y + 300);
    await page.mouse.move(cb.x + 820, cb.y + 300);
    await page.waitForTimeout(260);
    const lrB = await page.evaluate(() => {
      const r = ChartMgr.chart.timeScale().getVisibleLogicalRange();
      return [Math.round(r.from * 100) / 100, Math.round(r.to * 100) / 100];
    });
    check('点完日报回来, 图表没卡在按下状态(不按键移鼠标不跟着平移)',
          lrA[0] === lrB[0] && lrA[1] === lrB[1], JSON.stringify(lrA) + ' → ' + JSON.stringify(lrB));

    // 双击同一天只开一个 (600ms 去抖); 先等过去抖窗口
    await page.waitForTimeout(800);
    await page.evaluate(() => {
      window.__opens = [];
      window.__openOrig = window.open;
      window.open = u => { window.__opens.push(u); return null; };
    });
    await page.mouse.move(cb.x + repTarget.x, axisY);
    await page.mouse.down(); await page.mouse.up();
    await page.mouse.down(); await page.mouse.up();
    await page.waitForTimeout(350);
    const nDbl = await page.evaluate(() => { window.open = window.__openOrig; return window.__opens.length; });
    check('双击同一天只打开一次(不重复开标签页)', nDbl === 1, 'window.open × ' + nDbl);

    // 拖动时间轴 40px → 不该误开日报
    await page.evaluate(() => {
      window.__opens = [];
      window.__openOrig = window.open;
      window.open = u => { window.__opens.push(u); return null; };
    });
    await page.mouse.move(cb.x + repTarget.x, axisY);
    await page.mouse.down();
    await page.mouse.move(cb.x + repTarget.x + 40, axisY, { steps: 5 });
    await page.mouse.up();
    await page.waitForTimeout(300);
    const nDrag = await page.evaluate(() => { window.open = window.__openOrig; return window.__opens.length; });
    check('拖动时间轴缩放不误开日报', nDrag === 0, 'window.open × ' + nDrag);

    // 点一个无日报的日子 → 不弹
    const emptyDay = await page.evaluate(() => {
      const bars = ChartMgr._lastData, ts = ChartMgr.chart.timeScale();
      for (let i = 1; i < bars.length; i++) {
        const d = etDateStr(bars[i].epoch, bars[i].off);
        if (etDateStr(bars[i - 1].epoch, bars[i - 1].off) === d || Reports.has(d)) continue;
        const x = ts.logicalToCoordinate(i);
        if (x == null || x < 30 || x > Draw.W - 90) continue;
        return { x: Math.round(x), d };
      }
      return null;
    });
    if (emptyDay) {
      const p2P = page.context().waitForEvent('page', { timeout: 2200 }).catch(() => null);
      await page.mouse.click(cb.x + emptyDay.x, axisY);
      const p2 = await p2P;
      check('点无日报的日期 → 不弹', !p2, emptyDay.d);
      if (p2) await p2.close();
    }
  }

  // 切回 5m, 恢复后面的截图状态
  await page.click('#tfGroup button[data-tf="5m"]');
  await page.waitForTimeout(600);

  /* 20. 价格行为 setup 打标 / 账本 / 统计 (v1.1) */
  const load0 = await page.evaluate(() => ({
    setups: Setups.loaded, n: Setups.list.length, cycles: Setups.cycles.length,
    groups: Setups.groups.length, journal: Journal.loaded,
    feel: !!Setups.byId('feel'), top10: Setups.list.filter(s => s.group === 'top10').length,
  }));
  check('setup 清单载入 (内置 22+ / 5 组 / 4 周期 / 有「感觉」)',
        load0.setups && load0.n >= 22 && load0.cycles === 4 && load0.groups >= 5 && load0.feel && load0.top10 === 10,
        JSON.stringify(load0));
  check('账本载入', load0.journal);

  // 没选 setup 就下单 → 必须弹窗, 且不能下单
  await page.evaluate(() => {
    App.pendingSetup = null; App.pendingCycle = null; App.syncSetupUI();
    Trading.reset(); App._limits = [];
  });
  const posBefore = await page.evaluate(() => Trading.pos);
  await page.click('#btnBuy');
  await page.waitForTimeout(250);
  check('未选 setup 就下单 → 弹窗拦下',
        (await page.isVisible('#setupModal')) && (await page.evaluate(() => Trading.pos)) === posBefore,
        'pos=' + await page.evaluate(() => Trading.pos));

  /* 弹窗可拖动 (2026-10-23 用户要求: 弹窗会挡 K 线, 要能挪开对照着看) */
  const dragInfo = await page.evaluate(() => {
    const m = document.querySelector('#setupModal .modal');
    return { cursor: getComputedStyle(m).cursor, bound: !!m._dragBound };
  });
  check('下单弹窗可拖动 (光标提示 move)', dragInfo.cursor === 'move' && dragInfo.bound,
        `cursor=${dragInfo.cursor} bound=${dragInfo.bound}`);

  const dRect = await page.evaluate(() => {
    const b = document.querySelector('#setupModal .modal').getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width };
  });
  const dx0 = dRect.x + dRect.w / 2, dy0 = dRect.y + 46;
  await page.mouse.move(dx0, dy0);
  await page.mouse.down();
  await page.mouse.move(dx0 + 80, dy0 + 50, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(140);
  const dTf = await page.evaluate(() => document.querySelector('#setupModal .modal').style.transform || '');
  check('按住标题/空白处真的能把弹窗拖走 (80,50)',
        /translate\(\s*80px\s*,\s*50px\s*\)/.test(dTf), dTf || '(空)');
  /* 还原, 免得影响后面按坐标点弹窗里的东西 */
  await page.evaluate(() => { document.querySelector('#setupModal .modal').style.transform = ''; });
  /* 弹窗 (v1.2): 左 = 全局参考库, 右 = 当前周期的清单 */
  const libN = await page.evaluate(() => document.querySelectorAll('#setupLib [data-lib]').length);
  check('弹窗左栏列出全局库全部 setup', libN === 23, libN + ' 个');
  const perCycle = await page.evaluate(() => Setups.cycles.map(c => ({
    name: c.name, ids: Setups.forCycle(c.id).map(s => s.id),
  })));
  check('4 个周期清单各自独立: 都含「感觉」, 数量不一样',
        perCycle.length === 4 && perCycle.every(c => c.ids.includes('feel'))
        && new Set(perCycle.map(c => c.ids.length)).size > 1,
        perCycle.map(c => c.name + ':' + c.ids.length).join(' '));
  check('一个 setup 可以同属多个周期 (H2/L2 = 突破 + 宽通道)',
        await page.evaluate(() => Setups.inCycle('h2l2', 'breakout') && Setups.inCycle('h2l2', 'broad')));
  const curEmpty = await page.evaluate(() => document.querySelectorAll('#setupList [data-setup]').length);
  check('没选周期时右栏为空 (逼着先选周期)', curEmpty === 0, curEmpty + ' 个');

  // 周期没选就直调 chooseSetup → 守卫仍然拦
  const guard1 = await page.evaluate(() => {
    App._setupTempCycle = null;
    App.chooseSetup('mtr');
    return { modal: document.getElementById('setupModal').style.display, pos: Trading.pos };
  });
  check('没选市场周期直接选 setup → 被拦 (守卫生效)',
        guard1.modal === 'flex' && guard1.pos === posBefore, JSON.stringify(guard1));

  // 选周期 → 右栏只出现该周期的清单
  await page.click('#setupCycleSeg button[data-cycle="tight"]');
  await page.waitForTimeout(200);
  const curN = await page.evaluate(() =>
    [...document.querySelectorAll('#setupList [data-setup]')].map(e => e.dataset.setup));
  check('右栏只列本月期 (窄通道 4 个, 不含宽通道用的 M2B)',
        curN.length === 4 && curN.includes('h1l1') && !curN.includes('m2b'), curN);

  // 左栏点一个本周期没有的 → 只加进右栏, 不下单
  await page.click('#setupLib [data-lib="h2l2"]');
  await page.waitForTimeout(250);
  const added = await page.evaluate(() => ({
    inCur: !!document.querySelector('#setupList [data-setup="h2l2"]'),
    pos: Trading.pos, modal: document.getElementById('setupModal').style.display,
  }));
  check('左栏点 setup → 只加进右栏, 不下单',
        added.inCur && added.pos === posBefore && added.modal === 'flex', JSON.stringify(added));

  // 右栏点 × → 从本周期移出, 库里还在
  await page.click('#setupList [data-rm="h2l2"]');
  await page.waitForTimeout(250);
  const removed = await page.evaluate(() => ({
    inCur: !!document.querySelector('#setupList [data-setup="h2l2"]'),
    inLib: !!document.querySelector('#setupLib [data-lib="h2l2"]'),
  }));
  check('右栏 × → 从本周期移出 (库里还留着)', !removed.inCur && removed.inLib, JSON.stringify(removed));

  // 再加回来, 后面要用这一单验证 R 锁定
  await page.click('#setupLib [data-lib="h2l2"]');
  await page.waitForTimeout(250);

  // 选周期 + setup → 下单, 两个维度写到这一笔上
  await page.click('#setupList [data-setup="h2l2"]');
  await page.waitForTimeout(300);
  const opened = await page.evaluate(() => ({
    pos: Trading.pos, setup: Trading._posSetupId, cycle: Trading._posCycle,
    pending: App.pendingSetup, panel: document.getElementById('setupPickText').textContent,
    cycleActive: (document.querySelector('#cycleSeg button.active') || {}).dataset?.cycle,
    modal: document.getElementById('setupModal').style.display,
  }));
  check('选完 setup → 立刻执行这笔下单',
        opened.pos !== 0 && opened.setup === 'h2l2' && opened.cycle === 'tight' && opened.modal === 'none',
        JSON.stringify(opened));
  check('setup 用完即清 (每单都要重新选)', opened.pending === null && opened.panel === '未选择',
        JSON.stringify({ pending: opened.pending, panel: opened.panel }));
  check('市场周期留在面板上 (阶段内不常变)', opened.cycleActive === 'tight', opened.cycleActive);

  // 进入下一根 → 锁定初始风险; 之后再挪止损不改分母
  await page.click('#btnStepFwd');
  await page.waitForTimeout(250);
  const lock1 = await page.evaluate(() => ({
    locked: Trading._riskLocked, risk: Trading.riskPoints, initSl: Trading.initSl, initTp: Trading.initTp,
  }));
  check('进入下一根锁定初始风险 (R 的分母)',
        lock1.locked && lock1.risk > 0 && lock1.initSl != null, JSON.stringify(lock1));
  await page.evaluate(() => { Trading.sl = Trading.sl - 4; Trading._slMoved = true; Trading.save(); });
  const lock2 = await page.evaluate(() => Trading.riskPoints);
  check('锁定后再挪止损不改 R 分母', lock2 === lock1.risk, lock1.risk + ' → ' + lock2);

  // 平仓 → 账本记一笔, R = 点数 ÷ 初始风险
  await page.click('#btnClose');
  await page.waitForTimeout(400);
  const jrec = await page.evaluate(() => {
    const t = Journal.data.trades.filter(x => x.sessionId === App.sessionId);
    return t[t.length - 1];
  });
  check('平仓后账本自动记一笔 (含 setup / 周期 / R)',
        !!jrec && jrec.setupId === 'h2l2' && jrec.cycle === 'tight' && jrec.riskPoints > 0
        && Math.abs(jrec.r - jrec.points / jrec.riskPoints) < 0.01,
        JSON.stringify(jrec && { setup: jrec.setupName, cycle: jrec.cycle, r: jrec.r,
          pts: jrec.points, risk: jrec.riskPoints, reason: jrec.exitReason }));
  check('账本落盘到 data/journal.json', await page.evaluate(async () => {
    const r = await fetch('/api/journal', { cache: 'no-store' });
    const d = await r.json();
    return Array.isArray(d.trades) && d.trades.length > 0;
  }));

  // 突破挂单: 挂上就带 tp/sl, 拖挂单价 tp/sl 按相对距离跟随
  const stopGeo = await page.evaluate(() => {
    Trading.clearStops(); Trading.save();
    App.pendingSetup = 'mm'; App.pendingCycle = 'broad';
    const cur = App.engine.current;
    App._doStopOrderAtBarEdge('buy');
    const s = Trading.stops[0];
    const before = { price: s.price, tp: s.tp, sl: s.sl };
    const np = Math.round((s.price + 2) * 4) / 4;
    Draw.applyOrderDrag('stop:' + s.id, np);
    const after = { price: s.price, tp: s.tp, sl: s.sl };
    const lines = Draw.orderLines().filter(o => String(o.key).indexOf('stop:') === 0).map(o => o.key);
    return { before, after, lines, setup: s.setupId, cycle: s.cycle, np };
  });
  check('挂突破单时机械性挂好 tp/sl (2R)',
        stopGeo.before.tp != null && stopGeo.before.sl != null && stopGeo.setup === 'mm'
        && Math.abs((stopGeo.before.tp - stopGeo.before.price) / (stopGeo.before.price - stopGeo.before.sl) - 2) < 0.02,
        JSON.stringify(stopGeo.before));
  check('拖挂单价 → tp/sl 按相对距离一起走',
        Math.abs(stopGeo.after.tp - stopGeo.before.tp - 2) < 1e-9
        && Math.abs(stopGeo.after.sl - stopGeo.before.sl - 2) < 1e-9,
        JSON.stringify({ before: stopGeo.before, after: stopGeo.after }));
  check('待成交的挂单显示三条线 (挂单价 / 止盈 / 止损)',
        stopGeo.lines.length === 3, JSON.stringify(stopGeo.lines));

  // 持仓中换行情被拦
  await page.evaluate(() => {
    App.pendingSetup = 'feel'; App.pendingCycle = 'range';
    const cur = App.engine.current;
    Trading.fill('buy', 1, cur.c, 'market', cur.epoch, cur.off,
                 { bar: cur, prev: App.prevBars(5), setupId: 'feel', cycle: 'range' });
    App.consumeSetup();
  });
  check('持仓中', (await page.evaluate(() => Trading.pos)) !== 0);
  await page.click('#replayPillBtn');
  await page.waitForTimeout(250);
  check('持仓时点「选择随机K线」被拦 (请先平仓)',
        !(await page.isVisible('#startModal')), (await page.textContent('#toast')));
  await page.evaluate(() => { Trading.reset(); App._limits = []; });

  // 统计页签
  await page.click('#sideTabs button[data-tab="stats"]');
  await page.waitForTimeout(300);
  const statsUI = await page.evaluate(() => ({
    shown: document.getElementById('statsPane').style.display !== 'none',
    listHidden: document.getElementById('tradeList').style.display === 'none',
    txt: document.getElementById('statsPane').textContent,
    secs: [...document.querySelectorAll('#statsPane .stats-sec-h b')].map(e => e.textContent),
    weak: document.querySelectorAll('#statsPane .stats-row.weak').length,
    tools: document.querySelectorAll('#statsPane .stats-tools button').length,
  }));
  check('统计页签切换 (列表隐藏 / 统计显示)', statsUI.shown && statsUI.listHidden);
  check('统计含 综合 / 按 Setup / 按市场周期',
        statsUI.secs.includes('综合') && statsUI.secs.includes('按 Setup') && statsUI.secs.includes('按市场周期'),
        JSON.stringify(statsUI.secs));
  check('样本不足的组标 *', statsUI.weak > 0 && statsUI.txt.includes('参考价值有限'), statsUI.weak + ' 组');
  check('统计页有导出/导入入口', statsUI.tools === 4, statsUI.tools + ' 个');
  const csvHead = await page.evaluate(() => Journal.tradesCSV().split('\r\n')[0]);
  check('交易 CSV 表头含 Setup / 市场周期 / R',
        csvHead.includes('Setup') && csvHead.includes('市场周期') && csvHead.includes('R'), csvHead.slice(0, 40));
  check('CSV 数字不带正号 (Excel 不当文本)',
        await page.evaluate(() => {
          const rows = Journal.tradesCSV().split('\r\n').slice(1).filter(Boolean);
          return rows.every(r => !/,"[+-]\d/.test(r) && !/(^|,)\+\d/.test(r));
        }));
  await page.click('#sideTabs button[data-tab="trades"]');
  await page.waitForTimeout(150);
  check('切回交易记录页签', await page.evaluate(() =>
    document.getElementById('statsPane').style.display === 'none'
    && document.getElementById('tradeList').style.display !== 'none'));

  // 面板宽度没变
  check('右侧面板宽度仍 288px',
        (await page.evaluate(() => document.getElementById('sidePanel').getBoundingClientRect().width)) === 288);

  await page.evaluate(() => { Trading.reset(); Draw.clearAll(); App._limits = []; App.pendingSetup = null; });

  /* 15. 截图 + 错误汇总 */
  await page.click('#btnRestart');
  await page.waitForTimeout(500);
  await page.evaluate(() => document.getElementById('toast').classList.remove('show'));
  await page.screenshot({ path: SHOT });
  await page.evaluate(async (bk) => {
    await fetch('/api/journal', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bk) });
  }, journalBackup);
  check('截图保存', true, SHOT);

  /* 16. 持仓的会话归属 (v1.1.1 回归)
   *   用户报: 上一段做到一半关页面, 重开后图表是空的但 pos 还留着,
   *   没价可平仓 → guardFlat 把「开始复盘」「结束复盘」全堵死, 根本没法用。 */
  const staleSave = sid => ({
    trades: [], pos: 1, avg: 5000, realized: 0, stops: [], tp: 5050, sl: 4980,
    entryBar: { h: 5010, l: 4990 }, _entryEpoch: 1700000000, _tpGuard: false,
    _entryPrice: 5000, _entryTime: '', _entrySide: 'long',
    _posSetupId: 'feel', _posCycle: 'range', _addOns: 0, _maxQty: 1,
    _closeQty: 0, _closeSum: 0, _pnlSum: 0, _exitKind: null,
    _tpMoved: false, _slMoved: false, riskPoints: 20, initTp: 5050, initSl: 4980,
    _riskLocked: true, _sessionId: sid,
  });

  // 16a 存档属于别的场次 → 必须丢弃, 且开始复盘的入口要能走通
  await page.evaluate(s => {
    localStorage.setItem('es_replay_session', 'S_E2E_NEW');
    localStorage.setItem('es_replay_trading', JSON.stringify(s));
  }, staleSave('S_E2E_OLD'));
  await page.reload({ waitUntil: 'networkidle' });
  await waitLoaded(page);
  const ownA = await page.evaluate(() => ({
    pos: Trading.pos, sid: App.sessionId, left: localStorage.getItem('es_replay_trading'),
  }));
  check('跨场残留持仓被丢弃 (不再堵住开始复盘)',
        ownA.pos === 0 && ownA.left === null, JSON.stringify(ownA));
  check('丢弃残留不改写本场 sessionId', ownA.sid === 'S_E2E_NEW', ownA.sid);
  await page.click('#startBtn');
  const canStart = await page.waitForFunction(() =>
    document.getElementById('loadingMask').style.display === 'none'
    && !!App.engine && App.bars.length > 0, { timeout: 90000 })
    .then(() => true).catch(() => false);
  check('重开后点「开始」能真的进到回放', canStart);

  // 16b 存档 sessionId 与当前一致 → 保留 (这才是「继续上次」)
  const curSid = await page.evaluate(() => App.sessionId);
  await page.evaluate(s => localStorage.setItem('es_replay_trading', JSON.stringify(s)),
    staleSave(curSid));
  await page.reload({ waitUntil: 'networkidle' });
  await waitLoaded(page);
  const ownB = await page.evaluate(() => {
    const pos0 = Trading.pos;
    const g = App.guardFlat('换一段行情');   // 图表还没建, 没有价可平
    return { pos0, g, after: Trading.pos };
  });
  check('同场持仓保留 (继续上次的语义)', ownB.pos0 === 1, ownB.pos0);
  check('图表未加载时 guardFlat 放行, 死不回去', ownB.g === true, ownB.g);
  check('放行的同时清掉无处可平的残留持仓', ownB.after === 0, ownB.after);
  // 图表已加载 + 有持仓时仍要拦 (这条本来是对的, 别改坏)
  await page.click('#startBtn');
  await page.waitForFunction(() => document.getElementById('loadingMask').style.display === 'none'
    && !!App.engine && App.bars.length > 0, { timeout: 90000 });
  await giveSetup(page);
  await page.click('#btnBuy');
  await page.waitForFunction(() => Trading.pos !== 0, { timeout: 10000 });
  const ownC = await page.evaluate(() => {
    const ok = App.guardFlat('换一段行情');
    return { ok, pos: Trading.pos, toast: document.getElementById('toast').textContent };
  });
  check('图表已加载 + 有持仓: 仍然拦住 (防止悄悄丢掉这一笔)', ownC.ok === false, ownC.ok);
  check('拦的时候指出平仓按钮在哪', /平仓/.test(ownC.toast), ownC.toast);
  await page.evaluate(() => { Trading.reset(); App._limits = []; App.pendingSetup = null; });

  /* 17. setup 管理弹窗 (v1.2: 分组可自定义 / 每个 setup 带适用周期) */
  await page.evaluate(() => { App.openManageModal(); });
  await page.waitForTimeout(300);
  const mg = await page.evaluate(() => ({
    groupRows: document.querySelectorAll('#manageGroupRows .mgrow').length,
    setupRows: document.querySelectorAll('#manageList .manage-row').length,
    cyc: document.querySelectorAll('#manageList .manage-row:first-child .manage-cyc label').length,
    hasGroupAdd: !!document.getElementById('manageGroupAdd'),
    hasNewGroupSel: !!document.getElementById('manageNewGroup'),
  }));
  check('管理弹窗: 分组可改名 / 删除 / 新增', mg.groupRows === 5 && mg.hasGroupAdd, mg.groupRows);
  check('管理弹窗: 每个 setup 一行 + 4 个适用周期勾选',
        mg.setupRows === 23 && mg.cyc === 4, [mg.setupRows, mg.cyc]);
  check('管理弹窗: 新增 setup 时可选分组', mg.hasNewGroupSel);
  await page.evaluate(() => Setups.renameGroup('flag', '旗形测试'));
  await page.evaluate(() => { App.closeManageModal(); App.openSetupModal(() => { }); });
  await page.waitForTimeout(250);
  check('组改名立刻反映到下单弹窗', (await page.textContent('#setupLib')).includes('旗形测试'));
  await page.evaluate(() => {
    Setups.renameGroup('flag', '旗形');
    App.closeSetupModal(false);
    localStorage.removeItem('es_replay_setups');   // 别把测试改动留给用户的下一场
  });

  /* ================= v1.2.8 未走完的那根 K 线 =================
     用户 2026-10-24:「5分钟显露出一半时, 我去看日线, 日线好像已经把今日的完成了」
     数据是预处理按周期聚合好的完整 K 线, 切周期时锚点落在那根中间 → 那根含未来。
     修法: 历史用预聚合值, 只有当前这根按"已知时刻(playhead)"用 1m 现算, 切周期不改 playhead。
     下面用独立的 1m 聚合(不复用 App.aggMinutes)算出"应该是什么", 再跟图上的比。 */
  const live = await page.evaluate(async () => {
    const r2 = x => Math.round(x * 100) / 100;
    /* 独立的 1m 聚合: 故意不走 App.aggMinutes, 免得实现错了测试跟着错 */
    const agg1m = async (from, to) => {
      const d = await DataLoader.loadRange('rth', '1m', from, to);
      let h = -Infinity, l = Infinity, c = null, n = 0;
      for (let i = 0; i < d.count; i++) {
        const t = d.time[i];
        if (t < from || t >= to) continue;
        if (d.high[i] > h) h = d.high[i];
        if (d.low[i] < l) l = d.low[i];
        c = d.close[i]; n++;
      }
      return n ? { h: r2(h), l: r2(l), c: r2(c), n } : null;
    };
    if (Trading.pos !== 0) App.closePosition();

    // 回到 5m, 跳到 2024-01-16 12:00 (窗口外 → 新开一段, 状态干净)
    if (App.tf !== '5m') { await App.switchTf('5m'); }
    document.getElementById('gotoInput').value = '2024-01-16 12:00';
    await App.gotoTime();
    await new Promise(r => setTimeout(r, 1500));
    if (!App.engine) return { err: '跳转后没有 engine' };

    const cur = App.engine.current;
    const anchor = { time: etTimeStr(cur.epoch, cur.off), epoch: cur.epoch, playhead: App.playhead };
    const partEnd = App.playhead;                       // 已知时刻 = 12:05
    const ref5 = await agg1m(cur.epoch, partEnd);

    // ① 切日线
    await App.switchTf('1d');
    await new Promise(r => setTimeout(r, 1200));
    const d = App.engine.current;
    const weekEnd = App.bars[App.engine.idx + 1] ? App.bars[App.engine.idx + 1].epoch : d.epoch + 86400;
    const refDayPart = await agg1m(d.epoch, partEnd);
    const refDayFull = await agg1m(d.epoch, weekEnd);
    const day = {
      bar: etTimeStr(d.epoch, d.off), h: r2(d.h), l: r2(d.l), c: r2(d.c),
      part: refDayPart, full: refDayFull,
      playheadSame: App.playhead === anchor.playhead,
      isLive: !!App._live,
    };

    // ② 再切周线: playhead 不能被"从日线反推"污染
    await App.switchTf('1w');
    await new Promise(r => setTimeout(r, 1200));
    const w = App.engine.current;
    const wkEnd = App.bars[App.engine.idx + 1] ? App.bars[App.engine.idx + 1].epoch : w.epoch + 604800;
    const refWkPart = await agg1m(w.epoch, partEnd);
    const refWkFull = await agg1m(w.epoch, wkEnd);
    const week = {
      bar: etTimeStr(w.epoch, w.off), h: r2(w.h), l: r2(w.l), c: r2(w.c),
      part: refWkPart, full: refWkFull,
      playheadSame: App.playhead === anchor.playhead,
    };

    // ③ 切回 5m: 应该回到 12:00, 不能退到日线的 09:30
    await App.switchTf('5m');
    await new Promise(r => setTimeout(r, 1200));
    const back = {
      bar: etTimeStr(App.engine.current.epoch, App.engine.current.off),
      playheadSame: App.playhead === anchor.playhead,
      isLive: !!App._live,                              // 5m 那根是走完的, 不该被现算
    };

    // ④ 日线推进一根: 上一根必须恢复成预聚合的完整值
    await App.switchTf('1d');
    await new Promise(r => setTimeout(r, 1200));
    const d2 = App.engine.current;
    const d2End = App.bars[App.engine.idx + 1] ? App.bars[App.engine.idx + 1].epoch : d2.epoch + 86400;
    const refD2Full = await agg1m(d2.epoch, d2End);
    const oldIdx = App.engine.idx;
    const liveBefore = { c: r2(d2.c), live: !!App._live };
    App.engine.pause();
    App.engine.step(1);
    await new Promise(r => setTimeout(r, 900));
    const oldBar = App.bars[oldIdx];
    const drawnOld = ChartMgr._lastData[oldIdx];
    const step = {
      推进前: liveBefore,
      推进后: {
        c: r2(oldBar.c), drawnC: drawnOld ? r2(drawnOld.c) : null,
        应恢复成: refD2Full, liveCleared: !App._live,
      },
    };

    // ⑤ 交易引擎读到的"当前价"必须是部分 close, 不是全天收盘
    await App.switchTf('5m');
    await new Promise(r => setTimeout(r, 1000));
    App.playhead = anchor.playhead;
    await App.switchTf('1d');
    await new Promise(r => setTimeout(r, 1200));
    const d3 = App.engine.current;
    const trade = {
      当前价: r2(d3.c), 部分收盘: refDayPart.c, 全天收盘: refDayFull.c, isLive: !!App._live,
    };

    return { anchor, ref5, day, week, back, step, trade };
  });

  const near = (a, b) => Math.abs(a - b) < 0.01;
  check('5m 走到 12:00 切日线: 那根日线只到 12:05, 不再是全天完整值',
        !live.err && live.day.isLive
        && near(live.day.h, live.day.part.h) && near(live.day.l, live.day.part.l) && near(live.day.c, live.day.part.c)
        && (!near(live.day.c, live.day.full.c) || !near(live.day.l, live.day.full.l)),
        JSON.stringify(live.day || live.err));

  check('日线再切周线: 已知时刻不漂移 (不能从日线反推出「当天走完」)',
        !live.err && live.week.playheadSame
        && near(live.week.h, live.week.part.h) && near(live.week.l, live.week.part.l) && near(live.week.c, live.week.part.c)
        && !near(live.week.c, live.week.full.c),
        JSON.stringify(live.week || live.err));

  check('切回 5m 时间不倒流 (回到 12:00, 不是日线那根的 09:30)',
        !live.err && live.back.bar === live.anchor.time && live.back.playheadSame && !live.back.isLive,
        JSON.stringify(live.back || live.err));

  check('大周期推进一根后, 上一根恢复成完整的预聚合值 (图上也是)',
        !live.err && live.step.推进前.live
        && near(live.step.推进后.c, live.step.推进后.应恢复成.c)
        && near(live.step.推进后.drawnC, live.step.推进后.应恢复成.c)
        && !near(live.step.推进后.c, live.step.推进前.c)
        && live.step.推进后.liveCleared,
        JSON.stringify(live.step || live.err));

  check('大周期上的「当前价」是部分收盘, 不是全天收盘 (市价单不再用未来价成交)',
        !live.err && live.trade.isLive
        && near(live.trade.当前价, live.trade.部分收盘)
        && !near(live.trade.当前价, live.trade.全天收盘),
        JSON.stringify(live.trade || live.err));

  /* ================= v1.2.9 刷新 / 退出回放之后绘图还在 =================
     用户 2026-10-24:「不小心点退出回放或者刷新了, 再进来我画的趋势线就没了」。
     原来这条链路有三处会清: 没持久化 + loadAndBuild 里无条件 clearAll + closeReplay 里再清一次。 */
  /* 上面 v1.2.8 的用例把周期留在了日线, 而这一轮画好的线在 5m 桶里 —— 先切回来 */
  await page.click('#tfGroup button[data-tf="5m"]');
  await waitLoaded(page);
  await page.waitForTimeout(700);
  /* 中途的绘图用例(中键删除 / 清空全部)已经把线删光了, 这里现画一条 ——
     要测的是"刷新后还在", 不是"翻旧账" */
  const boxR = await page.locator('#chartMain').boundingBox();
  const PR = (dx, dy) => ({ x: boxR.x + dx, y: boxR.y + dy });
  await page.click('#drawBar button[data-tool="trend"]');
  await page.mouse.click(PR(300, 200).x, PR(300, 200).y);
  await page.waitForTimeout(90);
  await page.mouse.move(PR(400, 260).x, PR(400, 260).y, { steps: 6 });
  await page.mouse.move(PR(500, 320).x, PR(500, 320).y, { steps: 6 });
  await page.waitForTimeout(60);
  await page.mouse.click(PR(500, 320).x, PR(500, 320).y);
  await page.waitForTimeout(250);
  /* 推进一步让 savePos 记下"当前在 5m" —— 刷新后开始弹窗是按它恢复周期的,
     不推进的话存的还是上一个用例留下的 1d, 刷新后自动跳到日线桶(空的) */
  await page.evaluate(() => App.engine.step(1));
  await page.waitForTimeout(350);

  const beforeReload = await page.evaluate(async () => {
    Draw.save();
    await new Promise(r => setTimeout(r, 1100));     // 等写磁盘的节流窗口
    return { n: Draw.count(), tf: Draw.tf, items: Draw.snapshot() };
  });
  await page.reload({ waitUntil: 'networkidle' });
  await waitLoaded(page);
  await page.waitForTimeout(300);
  await page.click('#startBtn');
  const reloadOk = await page.waitForFunction(() =>
    document.getElementById('loadingMask').style.display === 'none' && !!App.engine && App.bars.length > 0,
    { timeout: 90000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(700);
  const reloaded = await page.evaluate(() => ({ n: Draw.count(), tf: Draw.tf, items: Draw.snapshot() }));
  check('刷新页面 + 重新开始复盘: 画的东西原样回来',
        reloadOk && beforeReload.n > 0 && reloaded.n === beforeReload.n
        && reloaded.tf === beforeReload.tf
        && JSON.stringify(reloaded.items) === JSON.stringify(beforeReload.items),
        `刷新前 ${beforeReload.n} 根(${beforeReload.tf}) → 刷新后 ${reloaded.n} 根(${reloaded.tf})`);

  const afterClose = await page.evaluate(() => {
    const n0 = Draw.count();
    const flat = Trading.pos === 0;
    if (flat) App.closeReplay();
    return { n0, flat, closed: !App.engine, n1: Draw.count() };
  });
  check('退出回放不清空绘图 (原来这里 Draw.clearAll())',
        afterClose.flat && afterClose.closed && afterClose.n1 === afterClose.n0 && afterClose.n1 > 0,
        JSON.stringify(afterClose));

  await page.click('#startBtn');
  const restartOk = await page.waitForFunction(() =>
    document.getElementById('loadingMask').style.display === 'none' && !!App.engine,
    { timeout: 90000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(700);
  const afterRestart = await page.evaluate(() => ({ n: Draw.count(), tf: Draw.tf }));
  check('退出回放再点开始, 线还在 (不用刷新)',
        restartOk && afterRestart.n === afterClose.n1 && afterRestart.n > 0,
        JSON.stringify(afterRestart));

  /* 把真实的绘图存档还回去, 别把测试画的线留给用户 */
  await page.evaluate(async bak => {
    try {
      await fetch('/api/draw', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bak) });
      localStorage.removeItem('es_replay_draw');
    } catch (e) { }
  }, drawBackup);

  check('无 console 错误', errors.length === 0, errors.slice(0, 3).join(' ; '));

  await browser.close();
  const fails = results.filter(r => !r.ok).length;
  console.log(`\n==== ${results.length - fails}/${results.length} 通过 ====`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('E2E 异常:', e); process.exit(2); });
