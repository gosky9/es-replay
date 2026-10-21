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
  zseq: 1,                   // 层叠序: 后画的在上, 点中即置顶 (不吸附固定图层)
  tool: 'cursor',            // cursor|trend|hline|vline|rect|fib|text|measure
  magnet: false,
  hidden: false,
  showBarCount: true,
  draft: null,
  selected: null,
  _drag: null,
  _chipRects: [],           // 交易线上右侧牌子的 ✕ 命中区 (每次 render 重建)
  _circleRects: [],         // 入场行上 TP / SL 两个圆按钮的命中区

  COLOR: '#2962ff',
  BAR_IDX_COLOR: '#f7a600',
  /** 斐波那契级别 (照 reference/06 截图: 1 / 0 / -1 / -2, 价格 = pB + (pA-pB)*级别) */
  FIB: [1, 0, -1, -2],
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
    // 画布位置缓存失效: 窗口尺寸/滚动/窗口移动
    const dropRect = () => { this._rect = null; };
    window.addEventListener('resize', dropRect, { passive: true });
    window.addEventListener('scroll', dropRect, { passive: true, capture: true });
    // 视窗变化(缩放/平移)时重绘, 一帧最多画一次
    ChartMgr.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.paintSoon());
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
    this._rect = null;                 // 尺寸变了, 缓存作废
    this.render();
  },

  /* ---------- 坐标转换 (支持右侧/左侧空白区外推, 与 TradingView 一致) ---------- */
  /** 当前周期一根 K 线多少秒 (日/周/月线也返回, 用于空白天数外推) */
  _barSec() {
    const bars = ChartMgr._lastData;
    if (!bars || !bars.length) return null;
    const m = (typeof TF_MINUTES !== 'undefined' && TF_MINUTES[ChartMgr.tf]) || 0;
    if (m) return m * 60;
    // 兜底: 用最后两根的 epoch 差
    for (let i = bars.length - 1; i >= 1; i--) {
      const d = bars[i].epoch - bars[i - 1].epoch;
      if (d > 0) return d;
    }
    return null;
  },

  /** 'YYYY-MM-DD' → epoch (该 ET 日中午, 只用于范围外外推) */
  _epochOfDateStr(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    if (!m) return null;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], 12) / 1000;
  },

  /** 逻辑索引 → 图表时间 (支持越界外推; 日线及以上返回 'YYYY-MM-DD') */
  timeOfLogical(l) {
    const bars = ChartMgr._lastData;
    if (!bars || !bars.length) return null;
    const n = bars.length;
    const iv = this._barSec();
    if (!iv) return null;
    const i = Math.round(l);
    if (i >= 0 && i < n) return bars[i].t;
    const isStr = typeof bars[0].t === 'string';
    const base = i < 0 ? bars[0] : bars[n - 1];
    const baseL = i < 0 ? 0 : n - 1;
    if (!isStr) return base.t + (i - baseL) * iv;
    return etDateStr(base.epoch + (i - baseL) * iv, base.off);
  },

  /** 图表时间 → 逻辑索引 (数据范围外用 epoch 外推) */
  _logicalOfTime(t) {
    const bars = ChartMgr._lastData;
    if (!bars || !bars.length) return null;
    const n = bars.length;
    const iv = this._barSec();
    if (!iv) return null;
    const isStr = typeof bars[0].t === 'string';
    // 二分精确匹配
    let lo = 0, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const v = bars[mid].t;
      if (v === t) return mid;
      if (v < t) lo = mid + 1; else hi = mid - 1;
    }
    // 落在范围外: 用 epoch 外推
    const last = bars[n - 1], first = bars[0];
    if (isStr) {
      const ep = this._epochOfDateStr(t);
      if (ep == null) return null;
      if (ep > last.epoch) return (n - 1) + (ep - last.epoch) / iv;
      if (ep < first.epoch) return (ep - first.epoch) / iv;
      return null;
    }
    if (t > last.t) return (n - 1) + (t - last.t) / iv;
    if (t < first.t) return (t - first.t) / iv;
    return null;
  },

  xOf(t) {
    if (t == null) return null;
    const ts = ChartMgr.chart.timeScale();
    const x = ts.timeToCoordinate(t);
    if (x != null && isFinite(x)) return x;
    // 落在数据范围外 => 用逻辑坐标外推 (右侧空白区也能画)
    const l = this._logicalOfTime(t);
    if (l == null) return null;
    const lx = ts.logicalToCoordinate(l);
    return (lx == null || !isFinite(lx)) ? null : lx;
  },

  yOf(p) {
    if (p == null || !isFinite(p)) return null;      // 价格缺失时不要拿 null 去换算(否则标签 toFixed 会炸)
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

  /** x → 时间, 右侧/左侧空白区按逻辑坐标外推 (尺子等工具在全图有效) */
  timeAtX(x) {
    const t = this.tOf(x);
    if (t != null) return t;
    const ts = ChartMgr.chart.timeScale();
    const l = ts.coordinateToLogical(x);
    if (l == null || !isFinite(l)) return null;
    return this.timeOfLogical(l);
  },
  pOf(y) { return ChartMgr.candle.coordinateToPrice(y); },

  /** 磁吸: 吸附到最近 bar 的开高低收 */
  snapPrice(x, y) {
    const raw = this.pOf(y);
    if (!this.magnet) return raw;
    const bars = ChartMgr._lastData;
    if (!bars || !bars.length) return raw;
    const t = this.timeAtX(x);
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
  toggleBarCount() {
    this.showBarCount = !this.showBarCount;
    ChartMgr.refreshBarCount();        // 图元内容现算, 只需请求重画一帧
    return this.showBarCount;
  },

  addItem(it) {
    it.id = this.seq++;
    it.z = ++this.zseq;
    it.color = it.color || this.COLOR;
    this.items.push(it);
    return it;
  },

  /** 把某个绘图提到最上层 (点中/新建时) */
  bringToFront(id) {
    const it = this.items.find(i => i.id === id);
    if (!it) return;
    it.z = ++this.zseq;
  },
  removeSelected() {
    if (!this.selected) return false;
    this.pushHistory();
    this.items = this.items.filter(i => i.id !== this.selected);
    this.selected = null;
    this.render();
    return true;
  },
  /** 按 id 删掉单个绘图 (中键点击用), 返回被删的那条 */
  removeById(id) {
    const it = this.items.find(i => i.id === id);
    if (!it) return null;
    this.pushHistory();
    this.items = this.items.filter(i => i.id !== id);
    if (this.selected === id) this.selected = null;
    this.render();
    return it;
  },
  removeAll() {
    const n = this.items.length;
    if (n) this.pushHistory();
    this.items = [];
    this.selected = null;
    this.draft = null;
    this.render();
    return n;
  },
  clearAll() {   // 换会话时静默清空
    this.items = []; this.selected = null; this.draft = null; this._drag = null;
    this.undo = []; this.redo = [];
    this.render();
  },
  count() { return this.items.length; },

  /* ---------- 撤销 / 重做 (顶栏 ↶ ↷) ---------- */
  undo: [], redo: [],
  MAX_UNDO: 60,
  snapshot() { return JSON.parse(JSON.stringify(this.items)); },
  pushHistory() {
    this.undo.push(this.snapshot());
    if (this.undo.length > this.MAX_UNDO) this.undo.shift();
    this.redo.length = 0;
  },

  cancel() {
    this.draft = null;
    this._drag = null;
    this._dragOrder = null;
    if (!['cursor'].includes(this.tool)) this.setTool('cursor');
    this.render();
  },

  /* ---------- 鼠标交互 ---------- */
  _pos(e) {
    // 缓存画布位置: getBoundingClientRect 每次 mousemove 都读会触发 layout,
    // 尺寸变化/滚动时由 resize() 与监听器失效
    let r = this._rect;
    if (!r) { r = this._rect = this.canvas.getBoundingClientRect(); }
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  },

  onDown(e) {
    if (!App.engine || this.hidden) return;
    // 中键: 点中哪个绘图就直接删掉, 不必先左键选中再按 Delete
    if (e.button === 1) {
      const { x, y } = this._pos(e);
      if (x < 0 || y < 0 || x > this.W || y > this.H) return;
      if (this.draft) return;
      const h = this.hitTest(x, y);
      if (!h) return;                      // 空白处放行, 不挡浏览器自己的中键行为
      e.preventDefault(); e.stopPropagation();
      const gone = this.removeById(h.id);
      if (gone && typeof App !== 'undefined' && App.toast) {
        App.toast('已删除' + (App.TOOL_NAME[gone.type] || '绘图'));
      }
      return;
    }
    if (e.button !== 0) return;                    // 右键交给 contextmenu
    const { x, y } = this._pos(e);
    if (x < 0 || y < 0 || x > this.W || y > this.H) return;
    // 只处理主图区域(避开成交量 pane 与时间轴)
    const yMax = this._priceAreaHeight();
    if (y > yMax) return;

    const t = this.timeAtX(x);                     // 右侧空白区也能落点
    if (t == null) return;

    if (this.tool === 'cursor') {
      // 0) 右侧牌子上的 ✕ 优先: 关掉这条线 (挂单/止盈/止损/持仓)
      const ck = this._hitChipClose(x, y);
      if (ck) {
        e.preventDefault(); e.stopPropagation();
        this.closeOrderLine(ck);
        return;
      }
      // 0.5) 入场行上的 TP / SL 圆按钮
      const circ = this._hitCircle(x, y);
      if (circ) {
        e.preventDefault(); e.stopPropagation();
        this.clickBracket(circ);
        return;
      }
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
      this.bringToFront(hit.id);               // 点中即置顶, 工具之间可互相叠压
      const it = this.items.find(i => i.id === hit.id);
      this.pushHistory();                      // 拖动前留快照, 供 ↶ 撤销
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

    if (this.tool === 'hline') { this.pushHistory(); this.addItem({ type: 'hline', a: { t, p }, b: { t, p } }); this.setTool('cursor'); return; }
    if (this.tool === 'vline') { this.pushHistory(); this.addItem({ type: 'vline', a: { t, p }, b: { t, p } }); this.setTool('cursor'); return; }
    if (this.tool === 'text') { this.startTextInput(x, y, t, p); return; }

    if (!this.draft) {
      this.draft = { type: this.tool, a: { t, p }, b: { t, p } };
      this.render();
      if (typeof App !== 'undefined' && App.toast) App.toast('已定第一点 · 移动鼠标, 再点一下完成 (Esc 取消)');
      return;
    }
    this.draft.b = { t, p: this._lockShift(this.draft, p, e.shiftKey) };
    this.finishDraft();
  },

  /** Shift 强制水平 (趋势线: reference/09) */
  _lockShift(draft, p, shift) {
    if (shift && draft && draft.type === 'trend') return draft.a.p;
    return p;
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
      this.pushHistory();
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
      const t = this.timeAtX(x);
      const p = this.snapPrice(x, y);
      this.draft.b = {
        t: t != null ? t : this.draft.b.t,
        p: p != null ? this._lockShift(this.draft, p, e.shiftKey) : this.draft.b.p,
      };
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
      const t = this.timeAtX(x), p = this.snapPrice(x, y);
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
      if (ok && v) { this.pushHistory(); this.addItem({ type: 'text', a: { t, p }, b: { t, p }, text: v }); }
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

  /* ---------- 命中测试 (按层叠序从最上层往下找) ---------- */
  hitTest(x, y) {
    const TH = 6;
    const dist = (ax, ay) => Math.hypot(x - ax, y - ay);
    const ordered = this.items.slice().sort((p, q) => (q.z || 0) - (p.z || 0));
    for (const it of ordered) {
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
  /** 下一帧再画: 缩放/平移时同一帧可能收到多次范围变化, 合并成一次 */
  paintSoon() {
    if (this._paintRaf) return;
    this._paintRaf = requestAnimationFrame(() => { this._paintRaf = 0; this.render(); });
  },

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.W) return;
    ctx.clearRect(0, 0, this.W, this.H);
    if (!App.engine) return;

    // Bar Count 已改为挂在 series 上的图元(见 chart.js), 跟 K 线同帧绘制, 这里不再画
    this.drawOrderLines(ctx);          // 交易线不受"隐藏绘图"影响
    if (this.hidden) return;

    for (const it of this.items.slice().sort((p, q) => (p.z || 0) - (q.z || 0))) {
      this.drawItem(ctx, it, it.id === this.selected);
    }
    if (this.draft) this.drawItem(ctx, this.draft, false, true);
  },

  /* ---------- 交易线: 挂单 / 入场 / 止盈 / 止损 (均可拖动) ---------- */
  orderLines() {
    const out = [];
    if (typeof Trading === 'undefined') return out;
    const mult = Trading.MULT || 50, pos = Trading.pos;
    // 突破挂单: 每张单一条线 + 一个右侧牌子 (买=蓝 / 卖=红)
    for (const s of (Trading.stops || [])) {
      out.push({
        key: 'stop:' + s.id, price: s.price, kind: 'stop', qty: s.qty,
        color: s.side === 'buy' ? '#2962ff' : '#f23645',
        label: s.side === 'buy' ? '突破买' : '突破卖', pl: null, solid: true,
      });
    }
    if (pos !== 0) {
      const n = Math.abs(pos), long = pos > 0;
      const plAt = p => (long ? p - Trading.avg : Trading.avg - p) * n * mult;
      const last = (ChartMgr._lastData || []);
      const cur = last.length ? last[last.length - 1].c : Trading.avg;
      out.push({
        key: 'entry', price: Trading.avg, kind: 'entry', qty: n,
        color: '#2962ff', label: '', pl: plAt(cur), solid: true,
      });
      if (Trading.tp != null) out.push({
        key: 'tp', price: Trading.tp, kind: 'tp', qty: n,
        color: '#089981', label: '', pl: plAt(Trading.tp), solid: false,
      });
      if (Trading.sl != null) out.push({
        key: 'sl', price: Trading.sl, kind: 'sl', qty: n,
        color: '#ff9800', label: '', pl: plAt(Trading.sl), solid: false,
      });
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

  /** 命中右侧牌子上的 ✕ (返回该条线的 key) */
  _hitChipClose(x, y) {
    for (const r of (this._chipRects || [])) {
      if (x >= r.cx0 && x <= r.cx1 && y >= r.y0 && y <= r.y1) return r.key;
    }
    return null;
  },

  /** 命中入场行上的 TP / SL 圆按钮 */
  _hitCircle(x, y) {
    for (const c of (this._circleRects || [])) {
      if (Math.hypot(x - c.x, y - c.y) <= c.r + 2) return c.key;
    }
    return null;
  },

  /** 点 TP / SL 圆: 没设就按默认 2R/1R 挂回来; 已设则提示可以直接拖线 */
  clickBracket(kind) {
    if (typeof Trading === 'undefined' || Trading.pos === 0) return;
    const has = kind === 'tp' ? Trading.tp != null : Trading.sl != null;
    if (has) {
      if (typeof App !== 'undefined') {
        App.toast(`${kind === 'tp' ? '止盈' : '止损'}在 ${(kind === 'tp' ? Trading.tp : Trading.sl).toFixed(2)} · 直接拖那条虚线可改价`);
      }
      return;
    }
    const n = Math.abs(Trading.pos), long = Trading.pos > 0;
    const d = kind === 'tp' ? 12 : 6;
    const px = Math.round((long ? Trading.avg + (kind === 'tp' ? d : -d)
                               : Trading.avg - (kind === 'tp' ? d : -d)) * 4) / 4;
    if (kind === 'tp') Trading.tp = px; else Trading.sl = px;
    Trading.save(); this.render();
    if (typeof App !== 'undefined') App.toast(`已挂${kind === 'tp' ? '止盈' : '止损'} @ ${px.toFixed(2)} (${n}手)`);
  },

  /** 点 ✕ 关掉某一条: 挂单→撤销; 止盈/止损→取消; 入场→平仓 */
  closeOrderLine(key) {
    if (typeof Trading === 'undefined' || !key) return false;
    if (key.indexOf('stop:') === 0) {
      const id = +key.slice(5);
      const n0 = Trading.stops.length;
      Trading.stops = Trading.stops.filter(s => s.id !== id);
      Trading.save(); this.render();
      if (typeof App !== 'undefined') App.toast(n0 > Trading.stops.length ? '已撤销这张挂单' : '挂单已不存在');
      return true;
    }
    if (key === 'tp') {
      Trading.tp = null; Trading.save(); this.render();
      if (typeof App !== 'undefined') App.toast('已取消止盈 (只保留止损)');
      return true;
    }
    if (key === 'sl') {
      Trading.sl = null; Trading.save(); this.render();
      if (typeof App !== 'undefined') App.toast('已取消止损 (只保留止盈)');
      return true;
    }
    if (key === 'entry') {
      if (typeof App !== 'undefined') App.closePosition();
      this.render();
      return true;
    }
    return false;
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

  _axisWidth() {
    try { return ChartMgr.chart.priceScale('right').width() || 60; } catch (e) { return 60; }
  },

  /** 美元盈亏: 0.00 / +275.00 / -212.50 */
  _fmtUsd(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (Math.abs(v) < 0.005) return '0.00 USD';
    return (v > 0 ? '+' : '-') + a + ' USD';
  },

  /** 右侧小牌: [◀ N] | 内容 | ✕   —— 照 reference/10~13 截图 */
  _drawChip(ctx, rightX, cy, o) {
    const H = 22, PAD = 4;
    const bg = ChartMgr.themeColors().bg;
    const pressed = (this._dragOrder === o.key);
    const color = o.color;
    ctx.save();
    ctx.font = '700 11px -apple-system, "Segoe UI", sans-serif';
    const leftTxt = '◀ ' + o.qty;
    const wl = Math.ceil(ctx.measureText(leftTxt).width) + 18;
    ctx.font = '500 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    const midTxt = (o.pl != null) ? this._fmtUsd(o.pl) : (o.label || '');
    const wm = Math.ceil(ctx.measureText(midTxt).width) + 22;
    const wc = 26;
    const W = wl + wm + wc;
    const x0 = rightX - W, y0 = cy - H / 2, y1 = y0 + H;
    const sepX1 = x0 + wl, sepX2 = x0 + wl + wm;

    this.roundRect(ctx, x0, y0, W, H, 4);
    if (o.solid) {
      // 实心款 (入场 / 突破挂单): 白底 + 实色描边 + 实色左块
      // 按住时整块泛蓝调、中段文字转实色 —— 照 reference/15、16 的编辑态
      if (pressed) {
        ctx.fillStyle = ChartMgr.themeColors().bg; ctx.fill();
        ctx.fillStyle = this.alpha(color, .16); ctx.fill();
      } else {
        ctx.fillStyle = bg; ctx.fill();
      }
      ctx.strokeStyle = color; ctx.lineWidth = pressed ? 1.6 : 1; ctx.stroke();
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(x0 + 4, y0); ctx.arcTo(x0, y0, x0, y0 + 4, 4);
      ctx.lineTo(x0, y1 - 4); ctx.arcTo(x0, y1, x0 + 4, y1, 4);
      ctx.lineTo(sepX1, y1); ctx.lineTo(sepX1, y0); ctx.closePath();
      ctx.clip();
      ctx.fillStyle = color; ctx.fillRect(x0, y0, wl, H);
      ctx.restore();
      ctx.fillStyle = '#fff';
      ctx.font = '700 11px -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(leftTxt, x0 + wl / 2, cy + .5);
      ctx.fillStyle = pressed ? color
        : (ChartMgr.theme === 'dark' ? '#9598a1' : '#787b86');
      ctx.font = '500 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(midTxt, sepX1 + wm / 2, cy + .5);
    } else {
      // 虚框款 (止盈 / 止损): 淡色底 + 虚线描边 + 同色文字
      ctx.fillStyle = this.alpha(color, pressed ? .22 : .07); ctx.fill();
      ctx.setLineDash([3, 2.5]);
      ctx.strokeStyle = this.alpha(color, .85); ctx.lineWidth = pressed ? 1.5 : 1;
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = '700 11px -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(leftTxt, x0 + wl / 2, cy + .5);
      ctx.font = '500 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(midTxt, sepX1 + wm / 2, cy + .5);
    }
    // 竖分隔
    ctx.strokeStyle = this.alpha(color, o.solid ? .35 : .45);
    ctx.lineWidth = 1;
    for (const sx of [sepX1, sepX2]) {
      ctx.beginPath(); ctx.moveTo(sx, y0 + PAD); ctx.lineTo(sx, y1 - PAD); ctx.stroke();
    }
    // ✕
    ctx.fillStyle = color;
    ctx.font = '400 13px -apple-system, "Segoe UI", sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('✕', sepX2 + wc / 2, cy + .5);

    this._chipRects.push({ key: o.key, cx0: sepX2, cx1: rightX, y0, y1 });
    ctx.restore();
    return W;
  },

  drawOrderLines(ctx) {
    this._chipRects = [];
    this._circleRects = [];
    const list = this.orderLines();
    if (!list.length) return;
    const t = ChartMgr.themeColors();
    const pos = (typeof Trading !== 'undefined') ? Trading.pos : 0;
    const axisW = this._axisWidth();
    const plotR = Math.max(220, this.W - axisW - 8);

    const yEntry = pos !== 0 ? this.yOf(Trading.avg) : null;
    const yTp = (pos !== 0 && Trading.tp != null) ? this.yOf(Trading.tp) : null;
    const ySl = (pos !== 0 && Trading.sl != null) ? this.yOf(Trading.sl) : null;

    // 1) 盈利/亏损区: 入场→止盈 淡绿, 入场→止损 淡橙
    const zone = (y1, y2, color) => {
      if (y1 == null || y2 == null) return;
      ctx.save();
      ctx.fillStyle = this.alpha(color, .10);
      ctx.fillRect(0, Math.min(y1, y2), plotR, Math.abs(y2 - y1));
      ctx.restore();
    };
    zone(yEntry, yTp, '#089981');
    zone(yEntry, ySl, '#ff9800');

    // 2) 各条价格线
    for (const o of list) {
      const y = this.yOf(o.price);
      if (y == null) continue;
      const pressed = (this._dragOrder === o.key);
      ctx.save();
      ctx.lineWidth = pressed ? 1.6 : 1;
      ctx.strokeStyle = this.alpha(o.color, pressed ? 1 : .8);
      ctx.setLineDash(o.solid ? [] : [4, 4]);
      ctx.beginPath();
      if (o.kind === 'entry') { ctx.moveTo(0, y); ctx.lineTo(this.W, y); }
      else { ctx.moveTo(0, y); ctx.lineTo(plotR, y); }
      ctx.stroke();
      ctx.restore();
    }

    // 3) 右侧竖连接线 + 三个小圆点 (把入场/止盈/止损串起来)
    const ys = [yEntry, yTp, ySl].filter(v => v != null);
    if (ys.length > 1) {
      const connX = plotR - 16;
      ctx.save();
      ctx.strokeStyle = this.alpha('#2962ff', .55); ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(connX, Math.min(...ys)); ctx.lineTo(connX, Math.max(...ys));
      ctx.stroke();
      for (const yy of ys) {
        ctx.beginPath(); ctx.arc(connX, yy, 3.2, 0, Math.PI * 2);
        ctx.fillStyle = t.bg; ctx.fill();
        ctx.strokeStyle = this.alpha('#2962ff', .85); ctx.stroke();
      }
      ctx.restore();
    }
    const chipRight = plotR - 34;

    // 4) 入场行: [做多/做空 pill] [TP 圆] [SL 圆] [牌子]
    if (pos !== 0 && yEntry != null) {
      const dir = pos > 0 ? '#2962ff' : '#f23645';
      const entry = list.find(o => o.key === 'entry');
      // 先量牌子宽度, 才能把 pill / 圆往左排
      const probe = { key: 'entry', qty: entry.qty, color: dir, pl: entry.pl, solid: true, label: '' };
      ctx.font = '700 11px -apple-system, "Segoe UI", sans-serif';
      const wl0 = Math.ceil(ctx.measureText('◀ ' + probe.qty).width) + 18;
      ctx.font = '500 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      const wm0 = Math.ceil(ctx.measureText(this._fmtUsd(probe.pl)).width) + 22;
      const chipW = wl0 + wm0 + 26;
      const chipX = chipRight - chipW;

      const CR = 11;
      const slX = chipX - 52;
      const tpX = slX - 44;
      const pillR = tpX - 24;

      ctx.save();
      // pill
      ctx.font = '600 12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      const pillTxt = pos > 0 ? '做多' : '做空';
      const pillW = ctx.measureText(pillTxt).width + 32, pillH = 26;
      this.roundRect(ctx, pillR - pillW, yEntry - pillH / 2, pillW, pillH, 5);
      ctx.fillStyle = dir; ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(pillTxt, pillR - pillW / 2, yEntry + .5);
      ctx.restore();

      // TP / SL 圆 (不透明底 → 淡色 → 虚线环 → 同色字)
      const circle = (cx, cy, label, color) => {
        ctx.beginPath(); ctx.arc(cx, cy, CR, 0, Math.PI * 2);
        ctx.fillStyle = t.bg; ctx.fill();
        ctx.beginPath(); ctx.arc(cx, cy, CR, 0, Math.PI * 2);
        ctx.fillStyle = this.alpha(color, .09); ctx.fill();
        ctx.save();
        ctx.setLineDash([2.5, 2]); ctx.lineWidth = 1.1;
        ctx.strokeStyle = this.alpha(color, .8); ctx.stroke();
        ctx.restore();
        ctx.fillStyle = this.alpha(color, Trading.tp != null && label === 'TP' || Trading.sl != null && label === 'SL' ? 1 : .45);
        ctx.font = '600 10px -apple-system, "Segoe UI", sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(label, cx, cy + .5);
      };
      circle(tpX, yEntry, 'TP', '#089981');
      circle(slX, yEntry, 'SL', '#ff9800');
      this._circleRects = [
        { key: 'tp', x: tpX, y: yEntry, r: CR },
        { key: 'sl', x: slX, y: yEntry, r: CR },
      ];

      this._drawChip(ctx, chipRight, yEntry, probe);
    }

    // 5) 止盈 / 止损 / 挂单 各自的牌子
    for (const o of list) {
      if (o.kind === 'entry') continue;
      const y = this.yOf(o.price);
      if (y == null) continue;
      // 跟入场行挨得太近就跳开, 免得两块牌子叠在一起
      if (yEntry != null && Math.abs(y - yEntry) < 26) continue;
      this._drawChip(ctx, chipRight, y, o);
    }
  },

  /* Bar Count (当日序号) 已迁到 chart.js 的 series 图元 BarCountPrimitive:
     跟着图表自己的渲染循环画, 不会比 K 线慢一帧。 */

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
      // 照 reference/06 截图: 无填充; 深灰水平线 + 左侧 `级别 (价格)` 灰字 + 两端空心圆手柄
      if (ax == null || ay == null || bx == null || by == null) { ctx.restore(); return; }
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
      const pA = it.a.p, pB = it.b.p;                 // A 锚点=1 级, B 锚点=0 级
      const lvls = it.levels || this.FIB;
      const dark = ChartMgr.theme === 'dark';
      const lineC = dark ? '#b2b5be' : '#434651';
      const txtC = dark ? '#9598a1' : '#787b86';
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = lineC;
      ctx.font = '13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'middle';
      for (const lv of lvls) {
        const price = pB + (pA - pB) * lv;
        const y = this.yOf(price);
        if (y == null) continue;
        ctx.beginPath(); ctx.moveTo(x0, y); ctx.lineTo(x1, y); ctx.stroke();
        const txt = `${lv} (${this._fmtPrice(price)})`;
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = txtC;
        // 标签默认在线的左端外侧; 左边放不下时才挪到左侧内侧右对齐, 避免被画布裁掉
        if (x0 - 12 - tw >= 2) {
          ctx.textAlign = 'right';
          ctx.fillText(txt, x0 - 12, y);
        } else {
          ctx.textAlign = 'left';
          ctx.fillText(txt, 6, y);
        }
      }
      // 两个圆形手柄 (空心圆: 蓝环白芯)
      const knob = (cx, cy) => {
        if (cx == null || cy == null) return;
        ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2);
        ctx.fillStyle = dark ? '#131722' : '#fff'; ctx.fill();
        ctx.strokeStyle = this.COLOR; ctx.lineWidth = 1.6; ctx.stroke();
      };
      knob(ax, ay); knob(bx, by);
      ctx.strokeStyle = it.color || this.COLOR;
      ctx.fillStyle = it.color || this.COLOR;
      if (selected) this.handles(ctx, [[ax, ay], [bx, by]]);
    } else if (it.type === 'text') {
      if (ax == null || ay == null) { ctx.restore(); return; }
      ctx.font = '13px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.fillText(it.text || '', ax + 4, ay + 4);
      if (selected) this.handles(ctx, [[ax, ay]]);
    } else if (it.type === 'measure') {
      if (ax == null || ay == null || bx == null || by == null) { ctx.restore(); return; }
      // 照 reference/03 截图: 淡蓝填充 + 过中心的十字线(顶端/右端带箭头) + 蓝色三行标签
      const BLUE = '#2962ff';
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx);
      const y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      const w = x1 - x0, h = y1 - y0;
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;

      ctx.fillStyle = this.alpha(BLUE, 0.14);
      ctx.fillRect(x0, y0, w, h);
      ctx.strokeStyle = this.alpha(BLUE, 0.32);
      ctx.lineWidth = 1;
      ctx.strokeRect(x0 + 0.5, y0 + 0.5, w, h);

      // 十字轴线 + 箭头
      ctx.strokeStyle = BLUE;
      ctx.lineWidth = 1.2;
      ctx.fillStyle = BLUE;
      const AR = 6;
      // 竖线: 从中心列往下到底边, 顶端箭头向上再伸出 12px
      const vTop = y0 - 12;
      ctx.beginPath(); ctx.moveTo(cx, vTop + AR); ctx.lineTo(cx, y1); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(cx, vTop); ctx.lineTo(cx - 4.2, vTop + AR); ctx.lineTo(cx + 4.2, vTop + AR);
      ctx.closePath(); ctx.fill();
      // 横线: 从左边到中心行, 右端箭头向右再伸出 10px
      const hRight = x1 + 10;
      ctx.beginPath(); ctx.moveTo(x0, cy); ctx.lineTo(hRight - AR, cy); ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(hRight, cy); ctx.lineTo(hRight - AR, cy - 4.2); ctx.lineTo(hRight - AR, cy + 4.2);
      ctx.closePath(); ctx.fill();

      // 标签: 变化值 (百分比) 跳动点数 / N根K线, 时长 / 成交量
      const st = this._rangeStats(it.a.t, it.b.t);
      const dP = it.b.p - it.a.p;
      const pct = it.a.p ? dP / it.a.p * 100 : 0;
      const ticks = Math.round(dP / 0.25);
      const l1 = `${dP >= 0 ? '' : '-'}${Math.abs(dP).toFixed(2)} (${pct >= 0 ? '' : '-'}${Math.abs(pct).toFixed(2)}%) ${Math.abs(ticks)}`;
      const l2 = `${st.bars}根K线, ${st.dur}`;
      const l3 = `成交量 ${st.vol}`;

      ctx.font = '12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      const tw = Math.max(ctx.measureText(l1).width,
                          ctx.measureText(l2).width,
                          ctx.measureText(l3).width) + 18;
      const th = 60;
      const lx = x0, ly = Math.max(2, y0 - 8 - th);
      this.roundRect(ctx, lx, ly, tw, th, 5);
      ctx.fillStyle = BLUE; ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(l1, lx + 9, ly + 14);
      ctx.fillText(l2, lx + 9, ly + 30);
      ctx.fillText(l3, lx + 9, ly + 46);
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

  /** 尺子标签用的统计: 根数 / 时长 / 成交量 (照 reference/03 截图)
     *  按逻辑索引算根数 —— 终点落在右侧空白区时也能给出正确的根数与时长
     */
  _rangeStats(t1, t2) {
    const bars = ChartMgr._lastData || [];
    if (!bars.length) return { bars: 0, dur: '—', vol: '—' };
    const l1 = this._logicalOfTime(t1), l2 = this._logicalOfTime(t2);
    if (l1 == null || l2 == null) return { bars: 0, dur: '—', vol: '—' };
    const n = Math.max(1, Math.round(Math.abs(l2 - l1)) + 1);
    // 成交量只累加真实存在的 bar (空白区没有成交量)
    const lo = Math.max(0, Math.ceil(Math.min(l1, l2) - 0.5));
    const hi = Math.min(bars.length - 1, Math.floor(Math.max(l1, l2) + 0.5));
    let v = 0;
    for (let i = lo; i <= hi; i++) v += (bars[i].v || 0);
    const tfMin = (typeof TF_MINUTES !== 'undefined' && TF_MINUTES[ChartMgr.tf]) || 5;
    const mins = n * tfMin;
    let dur;
    if (mins < 60) dur = `${mins}分钟`;
    else if (mins < 1440) {
      const hh = Math.floor(mins / 60), mm = mins % 60;
      dur = mm ? `${hh}小时${mm}分钟` : `${hh}小时`;
    } else {
      const dd = Math.floor(mins / 1440), hh = Math.round((mins % 1440) / 60);
      dur = hh ? `${dd}天${hh}小时` : `${dd}天`;
    }
    return { bars: n, dur, vol: hi >= lo ? this._fmtVol(v) : '—' };
  },

  _fmtVol(v) {
    if (v >= 1e6) return (v / 1e6).toFixed(2) + ' M';
    if (v >= 1e3) return (v / 1e3).toFixed(2) + ' K';
    return String(Math.round(v));
  },

  /** 价格格式: 千分位 + 两位小数 (照 reference/06 的 `7,151.25`) */
  _fmtPrice(p) {
    if (p == null || !isFinite(p)) return '–';
    return p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  },

  roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  },

  alpha(hex, a) {
    const n = parseInt(hex.replace('#', ''), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  },
};
