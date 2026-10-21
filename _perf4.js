const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1500, height: 860 } });
  await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => { const n = document.getElementById('dataRangeNote'); return n && !n.textContent.includes('加载中'); }, { timeout: 20000 });
  await p.click('#startBtn');
  await p.waitForFunction(() => document.getElementById('loadingMask').style.display === 'none', { timeout: 40000 });
  await p.waitForTimeout(800);

  // 统计一次横扫屏幕: setLegend 调用次数 / DOM 写入次数 / render 次数
  await p.evaluate(() => {
    window.__m = { legend: 0, dom: 0, render: 0, mv: 0 };
    const sl = App.setLegend.bind(App);
    App.setLegend = (...a) => { window.__m.legend++; return sl(...a); };
    const R = Draw.render.bind(Draw);
    Draw.render = (...a) => { window.__m.render++; return R(...a); };
    const proto = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
    Object.defineProperty(Node.prototype, 'textContent', {
      configurable: true,
      get() { return proto.get.call(this); },
      set(v) { window.__m.dom++; return proto.set.call(this, v); },
    });
    window.addEventListener('mousemove', () => window.__m.mv++, { capture: true, passive: true });
  });
  const box = await p.locator('#chartMain').boundingBox();
  for (let i = 0; i < 80; i++) {
    // 横向扫过 K 线区 (每帧约 6px)
    await p.mouse.move(box.x + 200 + i * 6, box.y + 300 + (i % 7) * 4);
    await p.waitForTimeout(14);
  }
  console.log('横扫 80 次 mousemove:', JSON.stringify(await p.evaluate(() => window.__m)));

  // 垂直移动(同一条 K 线内上下): 应该几乎不触发图例重算
  await p.evaluate(() => { window.__m = { legend: 0, dom: 0, render: 0, mv: 0 }; });
  for (let i = 0; i < 60; i++) {
    await p.mouse.move(box.x + 500, box.y + 200 + i * 5);
    await p.waitForTimeout(14);
  }
  console.log('同列上下 60 次:', JSON.stringify(await p.evaluate(() => window.__m)));

  // 帧率复核
  const fps = await p.evaluate(() => new Promise(res => {
    const t = []; let stop = false;
    const loop = ts => { t.push(ts); if (!stop) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    setTimeout(() => { stop = true; const d = [];
      for (let i = 1; i < t.length; i++) d.push(t[i] - t[i - 1]);
      d.sort((a, b) => a - b);
      res({ fps: +(1000 / (d.reduce((a, b) => a + b, 0) / d.length)).toFixed(1), max: +d[d.length - 1].toFixed(1) });
    }, 1200);
  }));
  console.log('帧率:', JSON.stringify(fps));
  await b.close(); process.exit(0);
})();
