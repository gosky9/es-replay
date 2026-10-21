const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1500, height: 860 } });
  await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => { const n = document.getElementById('dataRangeNote'); return n && !n.textContent.includes('加载中'); }, { timeout: 20000 });
  await p.click('#startBtn');
  await p.waitForFunction(() => document.getElementById('loadingMask').style.display === 'none', { timeout: 40000 });
  await p.waitForTimeout(800);

  // 1) 单次 render 耗时 + 内部各段耗时
  const r = await p.evaluate(() => {
    const t = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      Draw.render();
      t.push(performance.now() - t0);
    }
    t.sort((a, b) => a - b);
    const avg = t.reduce((a, b) => a + b, 0) / t.length;

    // 分段: bar 序号 / 交易线
    const seg = {};
    const t1 = performance.now(); for (let i = 0; i < 20; i++) Draw.drawBarNumbers(Draw.ctx); seg.barNumbers = (performance.now() - t1) / 20;
    const t2 = performance.now(); for (let i = 0; i < 20; i++) Draw.drawOrderLines(Draw.ctx); seg.orderLines = (performance.now() - t2) / 20;
    return {
      avg: +avg.toFixed(2), p50: +t[20].toFixed(2), max: +t[t.length - 1].toFixed(2),
      seg: { barNumbers: +seg.barNumbers.toFixed(2), orderLines: +seg.orderLines.toFixed(2) },
      bars: ChartMgr._lastData.length,
      canvas: [Draw.W, Draw.H],
    };
  });
  console.log('render 耗时(ms):', JSON.stringify(r));

  // 2) 统计 timeToCoordinate 调用次数 / 一次 render
  const calls = await p.evaluate(() => {
    let n = 0;
    const orig = ChartMgr.candle.timeToCoordinate.bind(ChartMgr.candle);
    ChartMgr.candle.timeToCoordinate = t => { n++; return orig(t); };
    Draw.render();
    ChartMgr.candle.timeToCoordinate = orig;
    return n;
  });
  console.log('一次 render 里 timeToCoordinate 调用次数 =', calls);

  // 3) 鼠标平移时的真实帧率
  const box = await p.locator('#chartMain').boundingBox();
  await p.evaluate(() => {
    window.__frames = [];
    const loop = t => { window.__frames.push(t); if (window.__frames.length < 100000) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    // 统计 render 次数
    window.__renders = 0;
    const R = Draw.render.bind(Draw);
    Draw.render = (...a) => { window.__renders++; return R(...a); };
  });
  const t0 = Date.now();
  await p.mouse.move(box.x + 600, box.y + 400);
  for (let i = 0; i < 60; i++) {
    await p.mouse.move(box.x + 600 + i * 6, box.y + 400 + (i % 10) * 3);
    await p.waitForTimeout(16);
  }
  const stat = await p.evaluate(() => {
    const f = window.__frames.slice(-90);
    const d = [];
    for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
    d.sort((a, b) => a - b);
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    return { avgFrame: +avg.toFixed(1), p95: +d[Math.floor(d.length * .95)].toFixed(1), max: +d[d.length - 1].toFixed(1),
             renders: window.__renders, frames: f.length };
  });
  console.log('鼠标移动 1s:', JSON.stringify(stat), ' 耗时', Date.now() - t0, 'ms');

  // 4) 滚轮缩放时的帧率
  await p.evaluate(() => { window.__renders = 0; window.__frames = []; });
  for (let i = 0; i < 25; i++) { await p.mouse.wheel(0, i % 2 ? 120 : -120); await p.waitForTimeout(20); }
  const stat2 = await p.evaluate(() => {
    const f = window.__frames.slice(-40); const d = [];
    for (let i = 1; i < f.length; i++) d.push(f[i] - f[i - 1]);
    d.sort((a, b) => a - b);
    return { avgFrame: +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1),
             max: +d[d.length - 1].toFixed(1), renders: window.__renders };
  });
  console.log('滚轮缩放:', JSON.stringify(stat2));
  await b.close(); process.exit(0);
})();
