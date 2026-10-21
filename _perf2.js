const { chromium } = require('playwright');
const fps = `(() => new Promise(res => {
  const t = []; let stop = false;
  const loop = ts => { t.push(ts); if (!stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  setTimeout(() => {
    stop = true;
    const d = []; for (let i = 1; i < t.length; i++) d.push(t[i] - t[i-1]);
    d.sort((a,b)=>a-b);
    const avg = d.reduce((a,b)=>a+b,0)/d.length;
    res({ fps: +(1000/avg).toFixed(1), p95: +d[Math.floor(d.length*.95)].toFixed(1),
          max: +d[d.length-1].toFixed(1), frames: d.length });
  }, 1500);
}))()`;
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1500, height: 860 } });
  await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => { const n = document.getElementById('dataRangeNote'); return n && !n.textContent.includes('加载中'); }, { timeout: 20000 });
  await p.click('#startBtn');
  await p.waitForFunction(() => document.getElementById('loadingMask').style.display === 'none', { timeout: 40000 });
  await p.waitForTimeout(800);

  console.log('① 空闲（不播放）:', JSON.stringify(await p.evaluate(fps)));

  // renderTrading 单次耗时
  const rt = await p.evaluate(() => {
    // 先塞 30 条交易记录
    for (let i = 0; i < 30; i++) Trading.trades.push({ side: i % 2 ? 'buy' : 'sell', qty: 1, price: 3000 + i, pnl: (i % 2 ? 50 : -25), epoch: 1500000000 + i * 60, off: -4, type: 'market', time: '2024-03-15 09:' + String(10 + i).padStart(2, '0') });
    const t = [];
    for (let i = 0; i < 20; i++) { const t0 = performance.now(); App.renderTrading(); t.push(performance.now() - t0); }
    t.sort((a, b) => a - b);
    return { avg: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(2), max: +t[t.length - 1].toFixed(2) };
  });
  console.log('② renderTrading 30 笔交易耗时(ms):', JSON.stringify(rt));

  // 播放中帧率
  await p.click('#btnPlay');
  await p.waitForTimeout(300);
  console.log('③ 播放中:', JSON.stringify(await p.evaluate(fps)));
  await p.click('#btnPlay');
  await p.waitForTimeout(200);

  // 按住拖动视窗(?): 拖时间轴平移
  const box = await p.locator('#chartMain').boundingBox();
  await p.mouse.move(box.x + 500, box.y + box.height - 30);
  await p.mouse.down();
  const before = Date.now();
  const pr = p.evaluate(fps);
  for (let i = 0; i < 40; i++) { await p.mouse.move(box.x + 500 + i * 8, box.y + box.height - 30); await p.waitForTimeout(16); }
  console.log('④ 拖动时间轴平移:', JSON.stringify(await pr), '耗时', Date.now() - before, 'ms');
  await p.mouse.up();

  // 滚轮缩放
  const pr2 = p.evaluate(fps);
  for (let i = 0; i < 40; i++) { await p.mouse.wheel(0, i % 2 ? 100 : -100); await p.waitForTimeout(16); }
  console.log('⑤ 滚轮缩放:', JSON.stringify(await pr2));
  await b.close(); process.exit(0);
})();
