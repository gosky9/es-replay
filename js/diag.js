/**
 * 手感自测角标 —— 只在 URL 带 ?diag=1 时加载。
 *
 * 为什么需要它: headless 里测得「光标偏差 0px / 4317Hz 输入零掉帧 / 单事件 0.55ms /
 * 12M px 画布零掉帧」, 但实机仍觉得不顺。headless 用软件渲染且 rAF 钉死 60Hz,
 * 真实 GPU / 驱动 / 显示器下的表现只能在实际浏览器里取数。
 *
 * 采集 (v2: 全部带时间维度, 用来区分「移动中」和「加载/切换时」):
 *   1. FPS 与掉帧数, 且拆成 移动中 / 静止 两档
 *   2. mousemove 频率 (鼠标回报率)
 *   3. 事件 → 光标回调延迟 (跟手感的本质延迟)
 *   4. 光标位置偏差 (有没有吸附/取整)
 *   5. 每帧绘制调用数 (fillText / stroke / fill) —— 光栅化负载规模
 *   6. 长任务(>50ms) 及其发生时间点 —— 主线程被谁堵住
 */
(function () {
  if (!/[?&]diag=1/.test(location.search)) return;

  const CAP = 1200;
  const S = {
    delta: [],   // {t, d} 帧
    moveT: [],   // mousemove 时间戳
    lat: [],     // 事件 → crosshair 延迟
    dev: [],     // 光标与鼠标距离
    long: [],    // {t, d} 长任务
    base: null,  // 清零时的基准 {text, stroke, fill, frames}
  };
  const push = (a, v) => { a.push(v); if (a.length > CAP) a.shift(); };

  /* ---------- 绘制调用计数 ---------- */
  const C2D = CanvasRenderingContext2D.prototype;
  const cnt = { text: 0, stroke: 0, fill: 0 };
  ['fillText', 'stroke', 'fill'].forEach(k => {
    const orig = C2D[k];
    cnt[k === 'fillText' ? 'text' : k] = 0;
    C2D[k] = function () {
      cnt[k === 'fillText' ? 'text' : k]++;
      return orig.apply(this, arguments);
    };
  });

  /* ---------- 长任务 ---------- */
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        push(S.long, { t: e.startTime, d: e.duration });
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) { /* 无 longtask 支持 */ }

  /* ---------- mousemove ---------- */
  let lastEv = null;
  document.addEventListener('mousemove', e => {
    lastEv = { t: e.timeStamp, x: e.clientX, y: e.clientY };
    push(S.moveT, e.timeStamp);
  }, true);

  /* ---------- 帧 (顺便采样当前光标 x, 用来算"动帧率") ---------- */
  let curX = -1, curY = -1;
  (function tick() {
    const t = performance.now();
    if (S._last) push(S.delta, { t, d: t - S._last, x: curX, y: curY });
    S._last = t;
    requestAnimationFrame(tick);
  })();

  /* ---------- crosshair ---------- */
  let hooked = false;
  const hook = () => {
    if (hooked || typeof ChartMgr === 'undefined' || !ChartMgr.chart) return;
    hooked = true;
    ChartMgr.chart.subscribeCrosshairMove(p => {
      if (!lastEv || !p || !p.point) return;
      const main = document.getElementById('chartMain');
      if (!main) return;
      const r = main.getBoundingClientRect();
      curX = p.point.x; curY = p.point.y;
      push(S.lat, performance.now() - lastEv.t);
      push(S.dev, Math.hypot(p.point.x - (lastEv.x - r.left), p.point.y - (lastEv.y - r.top)));
    });
  };
  const ht = setInterval(() => { hook(); if (hooked) clearInterval(ht); }, 300);
  hook();

  /* ---------- 统计 ---------- */
  const stat = a => {
    if (!a.length) return { p50: NaN, p95: NaN, max: NaN };
    const s = a.slice().sort((x, y) => x - y);
    return {
      p50: s[Math.floor((s.length - 1) * 0.5)],
      p95: s[Math.floor((s.length - 1) * 0.95)],
      max: s[s.length - 1],
    };
  };
  const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');

  /* 某个时刻之前最后一个 mousemove 的时间 (二分, 数组递增) */
  const lastMoveBefore = t => {
    let lo = 0, hi = S.moveT.length - 1, r = -Infinity;
    while (lo <= hi) {
      const m = (lo + hi) >> 1;
      if (S.moveT[m] <= t) { r = S.moveT[m]; lo = m + 1; } else hi = m - 1;
    }
    return r;
  };
  const isMoving = t => (t - lastMoveBefore(t)) < 150;   // 150ms 内有移动 = 移动中

  const canvasInfo = () => {
    try {
      const list = [...document.querySelectorAll('#chartMain canvas')];
      const big = list.map(c => ({ w: c.width, h: c.height })).sort((a, b) => b.w * b.h - a.w * a.h)[0];
      return { w: big.w, h: big.h, total: list.reduce((s, c) => s + c.width * c.height, 0), n: list.length };
    } catch (e) { return null; }
  };

  const snapshot = () => {
    const ds = S.delta.map(x => x.d);
    const d = stat(ds);
    const lat = stat(S.lat);
    const dev = stat(S.dev);
    const fps = Number.isFinite(d.p50) && d.p50 > 0 ? 1000 / d.p50 : NaN;

    const drops = S.delta.filter(x => x.d > 20);
    const dropMoving = drops.filter(x => isMoving(x.t)).length;
    const dropIdle = drops.length - dropMoving;
    const frameMoving = S.delta.filter(x => isMoving(x.t)).length;

    /* 回报率: 只统计"连续移动"段 (相邻间隔 < 50ms), 否则中间的停顿会把频率算低 */
    let hz = NaN;
    const gaps = [];
    for (let i = 1; i < S.moveT.length; i++) {
      const g = S.moveT[i] - S.moveT[i - 1];
      if (g > 0 && g < 50) gaps.push(g);
    }
    if (gaps.length > 5) hz = 1000 / (gaps.reduce((a, b) => a + b, 0) / gaps.length);

    /* 动帧率: 移动中的帧里, 光标位置真的变了的比例。100% = 每帧都在动;
       明显低于 100% 说明"停一下跳两下" —— 输入频率低于屏幕刷新率的典型形态。 */
    let moveFrames = 0, moveChanged = 0, stillRun = 0, stillMax = 0;
    for (let i = 1; i < S.delta.length; i++) {
      const a = S.delta[i - 1], b = S.delta[i];
      if (!isMoving(b.t)) continue;
      if (a.x < 0 || b.x < 0) continue;
      moveFrames++;
      /* x 和 y 都要比: 只看 x 的话上下移动会被误判成"光标没动" */
      if (Math.hypot(b.x - a.x, b.y - a.y) > 0.01) { moveChanged++; stillRun = 0; }
      else { stillRun++; stillMax = Math.max(stillMax, stillRun); }
    }
    const moveRate = moveFrames > 10 ? moveChanged / moveFrames : NaN;

    /* 每帧绘制调用 = 清零以来的增量 / 清零以来的帧数。
       不能用"最近 500ms"的窗口: 鼠标停下后不再重绘, 窗口里必然是 0。 */
    let per = { text: NaN, stroke: NaN, fill: NaN };
    if (S.base) {
      const frames = S.delta.length - S.base.frames;
      if (frames > 2) {
        per = {
          text: (cnt.text - S.base.text) / frames,
          stroke: (cnt.stroke - S.base.stroke) / frames,
          fill: (cnt.fill - S.base.fill) / frames,
        };
      }
    }

    return {
      fps, dropTotal: drops.length, dropMoving, dropIdle, frameMoving, total: S.delta.length,
      hz, lat, dev, per, moveRate, stillMax, moveFrames,
      longN: S.long.length,
      longMax: S.long.length ? Math.max.apply(null, S.long.map(x => x.d)) : 0,
      longList: S.long.slice(-6),
      canvas: canvasInfo(),
    };
  };

  const buildReport = () => {
    const s = snapshot();
    const c = s.canvas;
    const lines = [
      '== ES 复盘 手感自测 ==',
      `视窗 ${innerWidth}x${innerHeight} @ DPR ${devicePixelRatio}`,
      c ? `canvas ${c.w}×${c.h} · ${c.n} 层合计 ${(c.total / 1e6).toFixed(2)}M px` : 'canvas 未就绪',
      '',
      `FPS p50 ${f(s.fps)} (帧 ${s.total})`,
      `帧间隔 p50 ${f(stat(S.delta.map(x => x.d)).p50, 2)} · p95 ${f(stat(S.delta.map(x => x.d)).p95, 2)}`
        + ` · max ${f(stat(S.delta.map(x => x.d)).max, 2)}`,
      `掉帧>20ms 共 ${s.dropTotal} 次 → 移动中 ${s.dropMoving} / 静止 ${s.dropIdle}`
        + ` (移动帧 ${s.frameMoving})`,
      `鼠标回报率 ${f(s.hz, 0)} Hz (只算连续段) · mousemove ${S.moveT.length} 个`,
      `动帧率 ${Number.isFinite(s.moveRate) ? (s.moveRate * 100).toFixed(1) + '%' : '—'}`
        + ` (移动帧 ${s.moveFrames}) · 最长连续静止 ${s.stillMax} 帧`,
      `事件→光标延迟 p50 ${f(s.lat.p50, 2)} p95 ${f(s.lat.p95, 2)} max ${f(s.lat.max, 2)} ms`,
      `光标偏差 p50 ${f(s.dev.p50, 3)} p95 ${f(s.dev.p95, 3)} max ${f(s.dev.max, 3)} px`
        + ` · >5px 的帧 ${S.dev.filter(v => v > 5).length} / ${S.dev.length}`,
      `每帧绘制: fillText ${f(s.per.text)} · stroke ${f(s.per.stroke)} · fill ${f(s.per.fill)}`,
      `长任务 ${s.longN} 次 · 最长 ${f(s.longMax, 0)} ms`,
    ];
    if (s.longList.length) {
      lines.push('  长任务时间点(相对页面加载): ' + s.longList
        .map(x => `${(x.t / 1000).toFixed(1)}s/${x.d.toFixed(0)}ms`).join('  '));
    }
    try {
      const r = ChartMgr.visibleRange();
      lines.push(`可见 K 线 ${Math.round(r.to - r.from)}`);
    } catch (e) { /* 未就绪 */ }
    return lines.join('\n');
  };
  window.__diagReport = buildReport;

  /* ---------- 面板 ---------- */
  const css = `
  #diagBox{position:fixed;right:12px;top:64px;z-index:9999;width:224px;padding:10px 12px;
    background:rgba(19,23,34,.93);color:#d1d4dc;border:1px solid #2a2e39;border-radius:8px;
    font:11px/1.5 "SF Mono",Consolas,monospace;box-shadow:0 6px 22px rgba(0,0,0,.4)}
  #diagBox h4{margin:0 0 6px;font-size:11px;font-weight:600;color:#fff;display:flex;
    justify-content:space-between;align-items:center;letter-spacing:.02em}
  #diagBox .row{display:flex;justify-content:space-between;gap:8px}
  #diagBox .row span{color:#787b86}
  #diagBox .row b{font-weight:600;color:#e6e9ef}
  #diagBox .warn b{color:#ff9800}
  #diagBox .bad b{color:#ef5350}
  #diagBox .ok b{color:#26a69a}
  #diagBox .sep{height:1px;background:#2a2e39;margin:6px 0}
  #diagBox button{background:#2a2e39;color:#d1d4dc;border:none;border-radius:4px;
    padding:2px 6px;font-size:10px;cursor:pointer;margin-left:4px}
  #diagBox button:hover{background:#363a45}
  #diagBox .sw{display:grid;grid-template-columns:1fr 1fr;gap:3px 6px;margin-top:2px}
  #diagBox .sw label{display:flex;align-items:center;gap:4px;color:#a6a9b4;cursor:pointer;font-size:10px}
  #diagBox .sw i{font-style:normal}
  #diagBox .sw input{margin:0;width:11px;height:11px;accent-color:#26a69a;cursor:pointer}
  #diagBox .tip{color:#5d606b;font-size:10px;margin-top:6px;line-height:1.45}
  `;
  const st = document.createElement('style');
  st.textContent = css;
  document.head.appendChild(st);

  const box = document.createElement('div');
  box.id = 'diagBox';
  box.innerHTML = `
    <h4><i>手感自测</i><span><button id="dgReset">清零</button><button id="dgCopy">复制</button></span></h4>
    <div class="row" id="dgFps"><span>FPS</span><b>—</b></div>
    <div class="row" id="dgDrop"><span>掉帧 移动/静止</span><b>—</b></div>
    <div class="row" id="dgHz"><span>鼠标回报率</span><b>—</b></div>
    <div class="sep"></div>
    <div class="row" id="dgLat"><span>事件→光标 延迟</span><b>—</b></div>
    <div class="row" id="dgDev"><span>光标偏差</span><b>—</b></div>
    <div class="row" id="dgMove"><span>动帧率</span><b>—</b></div>
    <div class="row" id="dgDraw"><span>每帧 fillText</span><b>—</b></div>
    <div class="sep"></div>
    <div class="row" id="dgLong"><span>长任务</span><b>—</b></div>
    <div class="sep"></div>
    <div class="sw">
      <label><input type="checkbox" data-sw="draw" checked><i>绘图层</i></label>
      <label><input type="checkbox" data-sw="bc" checked><i>BarCount</i></label>
      <label><input type="checkbox" data-sw="ema" checked><i>EMA</i></label>
      <label><input type="checkbox" data-sw="legend" checked><i>图例</i></label>
      <label><input type="checkbox" data-sw="grid" checked><i>网格</i></label>
    </div>
    <div class="tip">先点「清零」，移动 15 秒点「复制」。<br>
      觉得顿就逐个勾掉上面的层，看勾掉哪个变顺 —— 那就是元凶。</div>`;
  document.body.appendChild(box);

  /* ---------- 图层开关: 一边移动一边关，用体感做二分法 ---------- */
  const origOnLegend = (typeof App !== 'undefined' && App.onLegend) ? App.onLegend.bind(App) : null;
  const applySwitch = (key, on) => {
    try {
      if (key === 'draw') {
        const el = document.getElementById('drawLayer');
        if (el) el.style.display = on ? '' : 'none';
      } else if (key === 'bc') {
        if (typeof Draw === 'undefined') return;
        Draw.showBarCount = on;
        ChartMgr.refreshBarCount();
      } else if (key === 'ema') {
        ChartMgr.setEmaEnabled(on);
      } else if (key === 'legend') {
        if (!origOnLegend) return;
        App.onLegend = on ? origOnLegend : function () {};
      } else if (key === 'grid') {
        ChartMgr.chart.applyOptions({
          grid: { vertLines: { visible: on }, horzLines: { visible: on } },
        });
      }
    } catch (e) { /* 图表还没就绪 */ }
  };
  box.querySelectorAll('[data-sw]').forEach(cb => {
    cb.onchange = () => applySwitch(cb.dataset.sw, cb.checked);
  });

  const $id = x => document.getElementById(x);
  const set = (id, val, cls) => {
    const el = $id(id);
    if (!el) return;
    el.querySelector('b').textContent = val;
    el.className = 'row' + (cls ? ' ' + cls : '');
  };

  S.base = { text: 0, stroke: 0, fill: 0, frames: 0 };

  setInterval(() => {
    const s = snapshot();
    set('dgFps', f(s.fps, 1), s.fps >= 55 ? 'ok' : (s.fps >= 45 ? 'warn' : 'bad'));
    set('dgDrop', `${s.dropMoving} / ${s.dropIdle}`,
      s.dropMoving === 0 ? 'ok' : (s.dropMoving < 5 ? 'warn' : 'bad'));
    set('dgHz', f(s.hz, 0) + ' Hz', s.hz > 200 ? 'ok' : '');
    set('dgLat', `p50 ${f(s.lat.p50)} · max ${f(s.lat.max)}`,
      s.lat.p50 <= 20 ? 'ok' : (s.lat.p50 <= 34 ? 'warn' : 'bad'));
    set('dgDev', `${f(s.dev.max, 2)} px`, s.dev.max < 1 ? 'ok' : 'warn');
    set('dgMove', Number.isFinite(s.moveRate)
      ? (s.moveRate * 100).toFixed(0) + '% · 静止' + s.stillMax + '帧'
      : '—', s.moveRate >= 0.98 ? 'ok' : (s.moveRate >= 0.85 ? 'warn' : 'bad'));
    set('dgDraw', f(s.per.text, 0) + ' 次', '');
    set('dgLong', `${s.longN} 次 · max ${f(s.longMax, 0)}ms`, s.longN === 0 ? 'ok' : 'bad');
  }, 500);

  $id('dgReset').onclick = () => {
    S.delta.length = S.lat.length = S.dev.length = S.moveT.length = S.long.length = 0;
    S._last = 0;
    S.base = { text: cnt.text, stroke: cnt.stroke, fill: cnt.fill, frames: 0 };
  };

  $id('dgCopy').onclick = () => {
    const txt = buildReport();
    (navigator.clipboard ? navigator.clipboard.writeText(txt) : Promise.reject())
      .then(() => { $id('dgCopy').textContent = '已复制'; setTimeout(() => { $id('dgCopy').textContent = '复制'; }, 1200); })
      .catch(() => { console.log(txt); alert(txt); });
  };
})();
