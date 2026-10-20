/* ============ draw.js — 绘图工具层 (TradingView 风格)
 * 覆盖在图表上的 canvas 图层:
 *   趋势线 / 水平线 / 垂直线 / 矩形 / 斐波那契回撤 / 文字 / 测量尺
 *   + Bar Count 序号 (橙色数字, 像 TV 的 Bar Count 指标)
 * 交互在 #chartArea 的 capture 阶段拦截, 不干扰图表自身的缩放/平移/十字光标
 */
const Draw = {
  canvas: null, ctx: null,
  items: [],
  seq: 1,
  tool: 'cursor',            // cursor|trend|hline|vline|rect|fib|text|measure
  magnet: false,
  hidden: false,
  showBarCount: true,
  draft: null,
  selected: null,
  _drag: null,

  COLOR: '#2962ff',
  BAR_IDX_COLOR: '#f7a600',
  FIB: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1],
  MIN_DRAW_PX: 4,

  init() {
    this.canvas = document.getElementById('drawLayer');
    this.ctx = this.canvas.getContext('2d');
    const area = document.getElementById('chartArea');

    // capture 阶段: 绘图工具激活时拦截; 光标模式仅在命中图元时拦截
    area.addEventListener('mousedown', e => this.onDown(e), true);
    area.addEventListener('mousemove', e => this.onMove(e), true);
    area.addEventListener('mouseup', e => this.onUp(e), true);
    area.addEventListener('mouseleave', e => { if (this.draft || this._drag) this.cancel(); });

    this.resize();
    new ResizeObserver(() => this.resize()).observe(area);
    ChartMgr.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.render());
    // 仅在拖拽/绘制中才每帧重绘, 避免鼠标移动时的无谓重绘
    ChartMgr.chart.subscribeCrosshairMove(() => {
      if (this.draft || this._drag) this.render();
    });
  },

  resize() {
    const area = document.getElementById('chartArea');
    const w = area.clientWidth, h = area.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.W = w; this.H = h;
    this.render();
  },

  /* ---------- 坐标转换 ---------- */
  xOf(t) {
    if (t == null) return null;
    const x = ChartMgr.chart.timeScale().timeToCoordinate(t);
    return (x == null || !isFinite(x)) ? null : x;
  },
  yOf(p) {
    const y = ChartMgr.candle.priceToCoordinate(p);
    return (y == null || !isFinite(y)) ? null : y;
  },
  tOf(x) {
    const t = ChartMgr.chart.timeScale().coordinateToTime(x);
    if (t == null) return null;
    if (typeof t === 'object') {
      const p = n => String(n).padStart(2, '0');
      return `${t.year}-${p(t.month)}-${p(t.day)}`;
    }
    return t;
  },
  pOf(y) { return ChartMgr.candle.coordinateToPrice(y); },

  /** 磁吸: 吸附到最近 bar 的开高低收 */
  snapPrice(x, y) {
    const raw = this.pOf(y);
    if (!this.magnet) return raw;
    const bars = ChartMgr._lastData;
    if (!bars || !bars.length) return raw;
    const t = this.tOf(x);
    let best = null, bd = Infinity;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].t === t) { best = bars[i]; break; }
    }
    if (!best) return raw;
    const cands = [best.o, best.h, best.l, best.c];
    let out = raw, md = Infinity;
    for (const c of cands) {
      const d = Math.abs(c - raw);
      if (d < md) { md = d; out = c; }
    }
    return out;
  },

  /* ---------- 工具切换 ---------- */
  setTool(tool) {
    this.tool = tool;
    this.draft = null;
    if (tool !== 'cursor') this.selected = null;   // 选绘图工具时取消选中
    this.render();
    // 画完自动回光标时, 两处工具栏的高亮也要跟着回去
    if (typeof App !== 'undefined' && App && App.syncToolUI) App.syncToolUI();
  },

  toggleMagnet() { this.magnet = !this.magnet; return this.magnet; },
  toggleHide() { this.hidden = !this.hidden; this.render(); return this.hidden; },
  toggleBarCount() { this.showBarCount = !this.showBarCount; this.render(); return this.showBarCount; },

  addItem(it) {
    it.id = this.seq++;
    it.color = it.color || this.COLOR;
    this.items.push(it);
    return it;
  },
  removeSelected() {
    if (!this.selected) return false;
    this.items = this.items.filter(i => i.id !== this.selected);
    this.selected = null;
    this.render();
    return true;
  },
  removeAll() {
    const n = this.items.length;
    this.items = [];
    this.selected = null;
    this.draft = null;
    this.render();
    return n;
  },
  clearAll() {   // 换会话时静默清空
    this.items = []; this.selected = null; this.draft = null; this._drag = null;
    this.render();
  },
  count() { return this.items.length; },

  cancel() {
    this.draft = null;
    this._drag = null;
    this._dragOrder = null;
    if (!['cursor'].includes(this.tool)) this.setTool('cursor');
    this.render();
  },

  /* ---------- 鼠标交互 ---------- */
  _pos(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  },

  onDown(e) {
    if (!App.engine || this.hidden) return;
    if (e.button !== 0) return;                    // 右键交给 contextmenu
    const { x, y } = this._pos(e);
    if (x < 0 || y < 0 || x > this.W || y > this.H) return;
    // 只处理主图区域(避开成交量 pane 与时间轴)
    const yMax = this._priceAreaHeight();
    if (y > yMax) return;

    const t = this.tOf(x);
    if (t == null) return;

    if (this.tool === 'cursor') {
      // 1) 交易线优先: 挂单 / 入场 / 止盈 / 止损 都可以按住拖动
      const ol = this.hitOrder(y);
      if (ol) {
        e.preventDefault(); e.stopPropagation();
        this._dragOrder = ol.key;
        this.render();
        return;
      }
      // 2) 已有绘图
      const hit = this.hitTest(x, y);
      if (!hit) {                              // 未命中: 取消选中并放行给图表(十字光标/拖动/缩放)
        if (this.selected != null) { this.selected = null; this.render(); }
        return;
      }
      e.preventDefault(); e.stopPropagation();
      this.selected = hit.id;
      const it = this.items.find(i => i.id === hit.id);
      this._drag = {
        id: hit.id, part: hit.part, startX: x, startY: y,
        orig: JSON.parse(JSON.stringify(it)),
      };
      this.render();
      return;
    }

    // 绘图工具: TradingView 式两次点击 —— 第一次定起点, 移动后第二次点击完成
    e.preventDefault(); e.stopPropagation();
    const p = this.snapPrice(x, y);
    if (p == null) return;

    if (this.tool === 'hline') { this.addItem({ type: 'hline', a: { t, p }, b: { t, p } }); this.setTool('cursor'); return; }
    if (this.tool === 'vline') { this.addItem({ type: 'vline', a: { t, p }, b: { t, p } }); this.setTool('cursor'); return; }
    if (this.tool === 'text') { this.startTextInput(x, y, t, p); return; }

    if (!this.draft) {
      this.draft = { type: this.tool, a: { t, p }, b: { t, p } };
      this.render();
      if (typeof App !== 'undefined' && App.toast) App.toast('已定第一点 · 移动鼠标, 再点一下完成 (Esc 取消)');
      return;
    }
    this.draft.b = { t, p };
    this.finishDraft();
  },

  /** 第二次点击: 收尾当前草稿 */
  finishDraft() {
    const d = this.draft;
    this.draft = null;
    if (!d) return;
    const x1 = this.xOf(d.a.t), x2 = this.xOf(d.b.t);
    const y1 = this.yOf(d.a.p), y2 = this.yOf(d.b.p);
    let ok = false;
    if (x1 != null && x2 != null && y1 != null && y2 != null) {
      ok = Math.hypot(x2 - x1, y2 - y1) >= this.MIN_DRAW_PX;
    }
    if (ok) {
      // 尺子只保留最新一次测量 (TradingView 的 ruler 也是单实例), 其他类型可累积
      if (d.type === 'measure') this.items = this.items.filter(i => i.type !== 'measure');
      this.addItem({ type: d.type, a: d.a, b: d.b, text: d.text });
    }
    this.setTool('cursor');      // 画完自动回到光标 (TradingView 行为)
  },

  onMove(e) {
    if (!App.engine || this.hidden) return;
    const { x, y } = this._pos(e);

    if (this.draft) {
      e.stopPropagation();
      this.draft.b = { t: this.tOf(x), p: this.snapPrice(x, y) };
      this.render();
      return;
    }

    if (this._dragOrder) {
      e.stopPropagation(); e.preventDefault();
      const p = this.snapPrice(x, y);
      if (p != null) this.applyOrderDrag(this._dragOrder, p);
      this.render();
      return;
    }

    if (this._drag) {
      e.stopPropagation(); e.preventDefault();
      const it = this.items.find(i => i.id === this._drag.id);
      if (!it) return;
      const t = this.tOf(x), p = this.snapPrice(x, y);
      const part = this._drag.part;

      if (it.type === 'hline') { it.a.p = p; it.b.p = p; }
      else if (it.type === 'vline') { it.a.t = t; it.b.t = t; }
      else if (it.type === 'text') { it.a.t = t; it.a.p = p; }
      else if (part === 'a') { it.a = { t, p }; }
      else if (part === 'b') { it.b = { t, p }; }
      else {  // body: 整体平移
        const o = this._drag.orig;
        const dP = p - this.pOf(this._drag.startY);
        if (it.type === 'trend' || it.type === 'rect' || it.type === 'fib') {
          it.a = { t: o.a.t, p: o.a.p + dP };
          it.b = { t: o.b.t, p: o.b.p + dP };
        }
      }
      this.render();
      return;
    }
  },

  onUp(e) {
    if (this._dragOrder) {
      this._dragOrder = null;
      if (typeof Trading !== 'undefined') Trading.save();
      this.render();
      return;
    }
    if (this._drag) { this._drag = null; this.render(); }
    // draft 不在 mouseup 结束: 两次点击才完成
  },

  /** 文字工具: 在点击位置生成内联输入框 (不用 window.prompt, 更接近 TradingView) */
  startTextInput(x, y, t, p) {
    if (this._textInput) this._textInput.remove();
    const area = document.getElementById('chartArea');
    const inp = document.createElement('input');
    inp.className = 'draw-text-input';
    inp.type = 'text';
    inp.placeholder = '输入文字, 回车确认';
    inp.style.left = Math.min(x, (this.W || 600) - 160) + 'px';
    inp.style.top = Math.max(4, y - 12) + 'px';
    area.appendChild(inp);
    this._textInput = inp;
    setTimeout(() => inp.focus(), 0);

    let done = false;
    const commit = ok => {
      if (done) return; done = true;
      const v = (inp.value || '').trim();
      if (inp.parentNode) inp.remove();
      this._textInput = null;
      if (ok && v) this.addItem({ type: 'text', a: { t, p }, b: { t, p }, text: v });
      this.setTool('cursor');
    };
    inp.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter') { ev.preventDefault(); commit(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); commit(false); }
    });
    inp.addEventListener('blur', () => commit(true));
  },

  /** 主图(价格区)底边 y: 取 pane0 真实高度, 避免在成交量 pane 上画 */
  _priceAreaHeight() {
    try {
      const panes = ChartMgr.chart.panes();
      if (panes && panes.length && typeof panes[0].getHeight === 'function') {
        const h = panes[0].getHeight();
        if (h > 0) return h;
      }
    } catch (e) { /* 老版本无 panes() */ }
    return (this.H || 600) * 0.82;
  },

  /* ---------- 命中测试 ---------- */
  hitTest(x, y) {
    const TH = 6;
    const dist = (ax, ay) => Math.hypot(x - ax, y - ay);
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      const ax = this.xOf(it.a.t), ay = this.yOf(it.a.p);
      const bx = this.xOf(it.b.t), by = this.yOf(it.b.p);

      if (it.type === 'hline') {
        if (ay != null && Math.abs(y - ay) < TH) return { id: it.id, part: 'a' };
        continue;
      }
      if (it.type === 'vline') {
        if (ax != null && Math.abs(x - ax) < TH) return { id: it.id, part: 'a' };
        continue;
      }
      if (it.type === 'text') {
        if (ax != null && ay != null &&
            x > ax - 6 && x < ax + 6 + (it.text || '').length * 7 && y > ay - 14 && y < ay + 6) {
          return { id: it.id, part: 'a' };
        }
        continue;
      }
      if (ax == null || ay == null || bx == null || by == null) continue;
      if (dist(ax, ay) < TH + 2) return { id: it.id, part: 'a' };
      if (dist(bx, by) < TH + 2) return { id: it.id, part: 'b' };
      if (it.type === 'trend') {
        if (this._distSeg(x, y, ax, ay, bx, by) < TH) return { id: it.id, part: 'body' };
      } else if (it.type === 'rect' || it.type === 'fib' || it.type === 'measure') {
        const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
        const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
        if (x > x0 - TH && x < x1 + TH && y > y0 - TH && y < y1 + TH) {
          // 靠近边框才算命中, 内部命中给 body 平移
          return { id: it.id, part: 'body' };
        }
      }
    }
    return null;
  },

  _distSeg(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const L2 = dx * dx + dy * dy;
    if (L2 === 0) return Math.hypot(px - x1, py - y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / L2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
  },

  /* ---------- 渲染 ---------- */
  render() {
    const ctx = this.ctx;
    if (!ctx || !this.W) return;
    ctx.clearRect(0, 0, this.W, this.H);
    if (!App.engine) return;

    if (this.showBarCount) this.drawBarNumbers(ctx);
    this.drawOrderLines(ctx);          // 交易线不受"隐藏绘图"影响
    if (this.hidden) return;

    for (const it of this.items) this.drawItem(ctx, it, it.id === this.selected);
    if (this.draft) this.drawItem(ctx, this.draft, false, true);
  },

  /* ---------- 交易线: 挂单 / 入场 / 止盈 / 止损 (均可拖动) ---------- */
  orderLines() {
    const out = [];
    if (typeof Trading === 'undefined') return out;
    for (const s of (Trading.stops || [])) {
      out.push({
        key: 'stop:' + s.id, price: s.price, kind: 'stop',
        label: (s.side === 'buy' ? '突破买 ' : '突破卖 ') + s.qty + '手',
      });
    }
    if (Trading.pos !== 0) {
      out.push({ key: 'entry', price: Trading.avg, kind: 'entry', label: '入场 ' + Trading.avg.toFixed(2) });
      if (Trading.tp != null) out.push({ key: 'tp', price: Trading.tp, kind: 'tp', label: '止盈 ' + Trading.tp.toFixed(2) });
      if (Trading.sl != null) out.push({ key: 'sl', price: Trading.sl, kind: 'sl', label: '止损 ' + Trading.sl.toFixed(2) });
    }
    return out;
  },

  hitOrder(y) {
    for (const o of this.orderLines()) {
      const yy = this.yOf(o.price);
      if (yy != null && Math.abs(y - yy) <= 5) return o;
    }
    return null;
  },

  applyOrderDrag(key, price) {
    price = Math.round(price * 4) / 4;                 // 对齐 0.25 tick
    if (key.indexOf('stop:') === 0) {
      const id = +key.slice(5);
      const s = (Trading.stops || []).find(s => s.id === id);
      if (s) s.price = price;
    } else if (key === 'tp') Trading.tp = price;
    else if (key === 'sl') Trading.sl = price;
  },

  drawOrderLines(ctx) {
    const list = this.orderLines();
    if (!list.length) return;
    const t = ChartMgr.themeColors();
    for (const o of list) {
      const y = this.yOf(o.price);
      if (y == null) continue;
      ctx.save();
      ctx.lineWidth = 1;
      ctx.strokeStyle = t.text;
      ctx.globalAlpha = o.kind === 'entry' ? 0.9 : 0.66;
      ctx.setLineDash(o.kind === 'entry' ? [] : o.kind === 'stop' ? [6, 4]
                     : o.kind === 'tp' ? [2, 3] : [8, 3]);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(this.W, y); ctx.stroke();
      ctx.restore();

      // 左侧标签牌 (拖动提示)
      ctx.save();
      ctx.font = '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      const w = ctx.measureText(o.label).width + 12;
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = t.text;
      ctx.fillRect(6, y - 8, w, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = t.bg;
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(o.label, 12, y);
      ctx.restore();
    }
  },

  /** Bar Count 指标: 当日序号 (RTH 按自然日 / ETH 按 CME 交易日, 每日首根=1)
     *  默认每 2 根显示一次(2/4/6…, 1/3/5 不显示), 缩得太小时再成倍稀疏
     */
  drawBarNumbers(ctx) {
    const bars = ChartMgr._lastData;
    if (!bars || !bars.length) return;
    const r = ChartMgr.visibleRange();
    if (!r) return;
    const from = Math.max(0, Math.floor(r.from));
    const to = Math.min(bars.length - 1, Math.ceil(r.to));
    if (to < from) return;
    let spacing = 7;
    try { spacing = ChartMgr.chart.timeScale().options().barSpacing || 7; } catch (e) {}
    const every = spacing >= 5 ? 2 : spacing >= 3.5 ? 4 : 8;

    const yMax = this._priceAreaHeight();
    const bg = ChartMgr.themeColors().bg;
    ctx.save();
    ctx.font = '500 8px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 3;
    ctx.strokeStyle = bg;                  // 主题色描边, 数字压在 K 线上也能看清
    ctx.fillStyle = this.alpha(ChartMgr.themeColors().text, 0.74);   // 黑白盘面用墨色, 不引入额外色相
    for (let i = from; i <= to; i += 1) {
      const b = bars[i];
      const n = b && b.dayNo ? b.dayNo : 0;
      if (!n || n % every !== 0) continue;
      const x = this.xOf(b.t);
      const yl = this.yOf(b.l);
      if (x == null || yl == null || yl > yMax - 12) continue;
      const s = String(n);
      ctx.strokeText(s, x, yl + 5);
      ctx.fillText(s, x, yl + 5);
    }
    ctx.restore();
  },

  drawItem(ctx, it, selected, isDraft) {
    const ax = this.xOf(it.a.t), ay = this.yOf(it.a.p);
    const bx = this.xOf(it.b.t), by = this.yOf(it.b.p);
    if (ay == null && it.type !== 'vline') return;
    if (ax == null && it.type !== 'hline') return;

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = it.color || this.COLOR;
    ctx.fillStyle = it.color || this.COLOR;
    ctx.setLineDash(isDraft ? [4, 3] : []);

    const W = this.W, H = Math.min(this.H, this._priceAreaHeight());
    const label = (txt, x, y, bg) => {
      ctx.setLineDash([]);
      ctx.font = '11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      const w = ctx.measureText(txt).width + 10;
      ctx.fillStyle = bg || this.COLOR;
      ctx.globalAlpha = 0.92;
      ctx.fillRect(x, y - 8, w, 16);
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(txt, x + 5, y);
      ctx.fillStyle = it.color || this.COLOR;
    };

    if (it.type === 'hline') {
      if (ay == null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(0, ay); ctx.lineTo(W, ay); ctx.stroke();
      label(it.a.p.toFixed(2), W - ctx.measureText(it.a.p.toFixed(2)).width - 24, ay);
      if (selected) this.handles(ctx, [[W * 0.5, ay]]);
    } else if (it.type === 'vline') {
      if (ax == null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(ax, 0); ctx.lineTo(ax, H); ctx.stroke();
      if (selected) this.handles(ctx, [[ax, H * 0.5]]);
    } else if (it.type === 'trend') {
      if (ax == null || ay == null || bx == null || by == null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke();
      const dP = it.b.p - it.a.p;
      const pct = it.a.p ? (dP / it.a.p * 100) : 0;
      label(`${dP >= 0 ? '+' : ''}${dP.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`,
            (ax + bx) / 2 + 8, (ay + by) / 2 - 12);
      if (selected) this.handles(ctx, [[ax, ay], [bx, by]]);
    } else if (it.type === 'rect') {
      if (ax == null || ay == null || bx == null || by == null) { ctx.restore(); return; }
      const x0 = Math.min(ax, bx), y0 = Math.min(ay, by);
      const w = Math.abs(bx - ax), h = Math.abs(by - ay);
      ctx.fillStyle = this.alpha(it.color || this.COLOR, 0.10);
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeRect(x0, y0, w, h);
      ctx.fillStyle = it.color || this.COLOR;
      if (selected) this.handles(ctx, [[ax, ay], [bx, by]]);
    } else if (it.type === 'fib') {
      if (ax == null || ay == null || bx == null || by == null) { ctx.restore(); return; }
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
      const hi = Math.max(it.a.p, it.b.p), lo = Math.min(it.a.p, it.b.p);
      const span = hi - lo;
      // 渐变填充
      const yTop = this.yOf(hi), yBot = this.yOf(lo);
      if (yTop != null && yBot != null) {
        const g = ctx.createLinearGradient(0, yTop, 0, yBot);
        g.addColorStop(0, this.alpha(it.color || this.COLOR, 0.16));
        g.addColorStop(1, this.alpha(it.color || this.COLOR, 0.02));
        ctx.fillStyle = g;
        ctx.fillRect(x0, yTop, x1 - x0, yBot - yTop);
      }
      for (const lv of this.FIB) {
        const price = hi - span * lv;
        const y = this.yOf(price);
        if (y == null) continue;
        ctx.globalAlpha = lv === 0 || lv === 1 ? 1 : 0.85;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        ctx.globalAlpha = 1;
        // 分级标签: 色块底 + 白字 (深浅主题都清晰)
        const txt = `${(lv * 100).toFixed(1)}%  ${price.toFixed(2)}`;
        ctx.font = '10px -apple-system, "Segoe UI", sans-serif';
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = this.alpha(it.color || this.COLOR, 0.88);
        ctx.fillRect(x1 - tw - 12, y - 7, tw + 8, 14);
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        ctx.fillText(txt, x1 - tw - 8, y);
        ctx.fillStyle = it.color || this.COLOR;
      }
      if (selected) this.handles(ctx, [[ax, ay], [bx, by]]);
    } else if (it.type === 'text') {
      if (ax == null || ay == null) { ctx.restore(); return; }
      ctx.font = '13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(it.text || '', ax + 4, ay + 4);
      if (selected) this.handles(ctx, [[ax, ay]]);
    } else if (it.type === 'measure') {
      if (ax == null || ay == null || bx == null || by == null) { ctx.restore(); return; }
      const x0 = Math.min(ax, bx), y0 = Math.min(ay, by);
      const w = Math.abs(bx - ax), h = Math.abs(by - ay);
      const up = it.b.p >= it.a.p;
      const pal = ChartMgr.colors();                   // 黑白盘面下即墨色
      const rc = up ? pal.up : pal.down;
      ctx.fillStyle = this.alpha(rc, 0.07);
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = rc;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(x0, y0, w, h);
      ctx.setLineDash([]);
      const dP = it.b.p - it.a.p;
      const pct = it.a.p ? dP / it.a.p * 100 : 0;
      const bars = this._barsBetween(it.a.t, it.b.t);
      const l1 = `${dP >= 0 ? '+' : ''}${dP.toFixed(2)}  (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`;
      const l2 = `${bars} 根`;
      ctx.font = '12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      const tw = Math.max(ctx.measureText(l1).width, ctx.measureText(l2).width) + 14;
      const bx2 = x0 + w + 6, by2 = y0 + Math.min(h / 2, 20);
      ctx.fillStyle = this.alpha(rc, 0.92);
      ctx.fillRect(bx2, by2 - 10, tw, 34);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(l1, bx2 + 7, by2 + 2);
      ctx.fillText(l2, bx2 + 7, by2 + 17);
      if (selected) this.handles(ctx, [[ax, ay], [bx, by]]);
    }
    ctx.restore();
  },

  handles(ctx, pts) {
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = this.COLOR;
    ctx.lineWidth = 1.5;
    for (const [x, y] of pts) {
      if (x == null || y == null) continue;
      ctx.beginPath();
      ctx.rect(x - 3.5, y - 3.5, 7, 7);
      ctx.fill(); ctx.stroke();
    }
    ctx.restore();
  },

  _barsBetween(t1, t2) {
    const bars = ChartMgr._lastData || [];
    let i1 = -1, i2 = -1;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].t === t1) i1 = i;
      if (bars[i].t === t2) i2 = i;
      if (i1 >= 0 && i2 >= 0) break;
    }
    if (i1 < 0 || i2 < 0) return 0;
    return Math.abs(i2 - i1) + 1;
  },

  alpha(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  },
};
