const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true });
  const p = await b.newPage({ viewport: { width: 1500, height: 860 } });
  await p.goto('http://127.0.0.1:8899/index.html', { waitUntil: 'networkidle' });
  await p.waitForFunction(() => { const n = document.getElementById('dataRangeNote'); return n && !n.textContent.includes('加载中'); }, { timeout: 20000 });
  await p.click('#startBtn');
  await p.waitForFunction(() => document.getElementById('loadingMask').style.display === 'none', { timeout: 40000 });
  await p.waitForTimeout(800);

  await p.evaluate(() => {
    window.__long = [];
    try {
      new PerformanceObserver(l => l.getEntries().forEach(e => window.__long.push(Math.round(e.duration))))
        .observe({ entryTypes: ['longtask'] });
    } catch (e) { window.__longErr = e.message; }
    // 统计 mousemove 处理总耗时
    window.__mv = { n: 0, t: 0 };
    window.addEventListener('mousemove', () => {
      const t0 = performance.now();
      requestAnimationFrame(() => { window.__mv.t += performance.now() - t0; });
      window.__mv.n++;
    }, { capture: true, passive: true });
  });

  // 全屏扫一遍鼠标
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    const x = 100 + (i * 11) % 1300, y = 80 + (i * 7) % 700;
    await p.mouse.move(x, y);
    await p.waitForTimeout(12);
  }
  const r = await p.evaluate(() => ({ long: window.__long.slice(), mv: window.__mv, err: window.__longErr || null }));
  console.log('扫屏 1.4s:', JSON.stringify(r), ' 实际', Date.now() - t0, 'ms');

  // 画布尺寸 / dpr
  const layers = await p.evaluate(() => {
    const out = {};
    document.querySelectorAll('canvas').forEach((c, i) => {
      out['canvas' + i] = { css: [c.clientWidth, c.clientHeight], px: [c.width, c.height], id: c.parentElement?.id || c.id };
    });
    out.dpr = window.devicePixelRatio;
    return out;
  });
  console.log('画布:', JSON.stringify(layers, null, 1));
  await b.close(); process.exit(0);
})();
