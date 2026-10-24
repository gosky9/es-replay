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
  /** 成交标记的大箭头 (照用户 2026-10-22 截图逐像素实测: 包围盒 33×38, 杆 19 宽 × 18 高) */
  /* 成交标记的大箭头 —— 照 reference/21 (1263×915) 逐像素实测:
     包围盒 33×38 **device px**, 而那张图是 2x (同图 Bar Count 数字墨迹 15 device,
     和 reference/20 标定时完全一致) ⇒ 实际 **16.5 × 19 CSS px**, 杆 9.5 宽 × 9 高。
     一开始按 device px 当 CSS 用, 画出来整整大一倍, 这里改回来。 */
  MARK: { w: 16.5, h: 19, stemW: 9.5, stemH: 9 },
  MARK_UP: '#70ccbd',       // 买 (在 K 线下方, 箭头朝上) — 截图 rgb(112,204,189)
  MARK_DOWN: '#cc2f3c',     // 卖 (在 K 线上方, 箭头朝下) — 截图 rgb(204,47,60)
  /* 出场 (平仓) 用灰 —— 用户 2026-10-24 拍板:
     方向 (朝上=买 / 朝下=卖) + 位置 (K 下 / K 上) 已经两重编码了"买还是卖",
     颜色这一层就空出来专门标"开还是收": 入场保留青绿/红, 出场一律灰。
     好处是不跟涨跌色打架 (红/绿在这套界面里已经被 K 线阴阳、盈亏占满了),
     且"灰 = 收尾"层级上和入场天然分得开。取的是同项目 --text-dim 的 #787b86,
     和盘面其它次要文字同色, 不引入新的色相。 */
  MARK_EXIT: '#787b86',
  // 尖端到 K 线高/低点: 截两个样本量到 21 device (红) / 6 device (绿), 差别较大,
  // 取中间偏小 8 device = 4 CSS (太远了会飘, 太近了压到影线)
  MARK_GAP: 4,
  /** 斐波那契级别 (照 reference/06 截图: 1 / 0 / -1 / -2, 价格 = pB + (pA-pB)*级别) */
  FIB: [1, 0, -1, -2],
  /** 斐波那契扩展级别 (照 reference/18 截图: 只画 0 / 1 / 2, 价格 = pC + k*(pB-pA)) */
  FIBEXT: [0, 1, 2],
  MIN_DRAW_PX: 4,

  /* ---------- 持久化 (用户 2026-10-24) ----------
     「画的东西除非我删掉, 否则一直保留」—— 原来刷新/退出回放/切周期全丢, 因为这个对象
     一行持久化都没有 (对比 trading.js 存持仓、journal.js 存账本)。

     **按周期(tf)分桶存**, 是用户拍板的行为: 5m 上画的线只在 5m 出现, 切到日线看不到,
     切回 5m 还在。没有选"存绝对时刻、跨周期都显示"的原因:
       日内的锚点 t 是 chartTime(epoch, off) = 秒, 日/周/月线的 t 是 'yyyy-MM-dd' 字符串,
       两套口径硬混必须做双向换算, 而且 1m 上画的一小段切到日线会被压成一个点 —— 划不来。
     RTH/ETH 不算换周期: 同一根 bar 在两种时段下 t 完全一样, 切时段不丢。

     双写: localStorage (同步, 立刻生效) + data/draw.json (落盘, 清缓存也不丢)。
     没有 server.py (直接开 file://) 时 fetch 会失败, 静默降级成纯 localStorage。 */
  STORE: 'es_replay_draw',
  tf: null,                  // 当前 items 属于哪个周期 (由 App 在 loadAndBuild 里设)
  _all: null,                // 全量存档 { version, byTf:{tf:[...]}, updatedAt }
  _saveTimer: 0,             // 写磁盘的节流句柄
  _clip: null,               // 复制的图元 (Ctrl+C/Ctrl+V, 只在本次页面内有效)
  COPY_DL: 3,                // 粘贴副本向右偏移几根 K 线
  COPY_DP: -2.5,             // 粘贴副本向下偏移多少点 (ES 2.5 点 = 10 个 tick)

  init() {
    this.canvas = document.getElementById('drawLayer');
    this.ctx = this.canvas.getContext('2d');
    const area = document.getElementById('chartArea');

    // capture 阶段: 绘图工具激活时拦截; 光标模式仅在命中图元时拦截
    area.addEventListener('mousedown', e => this.onDown(e), true);
    // mousemove / mouseup 挂在 document 上, 而不是 #chartArea:
    //   原来 mouseleave 里直接 cancel() —— 画一半鼠标一滑出画布就整条作废。
    //   用户 2026-10-22 要求「不要自动取消, 假装鼠标停在边上, 回来继续画」, 所以改成:
    //   越界时把坐标夹到画布边界(onMove 里 _clamp), 移回来接着画;
    //   在画布外松手也能正常收尾, 不会留下"粘住"的拖拽状态。
    // 没有绘制/拖拽时 onMove/onUp 立刻返回, 不影响十字光标、图表平移和页面其它交互。
    document.addEventListener('mousemove', e => this.onMove(e), true);
    document.addEventListener('mouseup', e => this.onUp(e), true);
    // 时间轴: 有日报的日期可以点开 (新标签页)
    this.bindReportClicks(area);

    this.resize();
    new ResizeObserver(() => this.resize()).observe(area);
    // 画布位置缓存失效: 窗口尺寸/滚动/窗口移动
    const dropRect = () => { this._rect = null; };
    window.addEventListener('resize', dropRect, { passive: true });
    window.addEventListener('scroll', dropRect, { passive: true, capture: true });
    // 视窗变化(缩放/平移)时重绘, 一帧最多画一次
    ChartMgr.chart.timeScale().subscribeVisibleLogicalRangeChange(() => this.paintSoon());
    // 纵向(价格轴)变化: 库没有任何订阅回调, 要自己盯 —— 否则止盈/止损只在 mouseup 后跳一下
    this.watchPriceScale();
    // 仅在拖拽/绘制中才每帧重绘, 避免鼠标移动时的无谓重绘
    ChartMgr.chart.subscribeCrosshairMove(() => {
      if (this.draft || this._drag) this.render();
    });
  },

  /* ---------- 价格轴(纵向)变化跟随 ----------
     lightweight-charts 只对外发"可见逻辑范围"(横向)的变化; 在右侧价格轴上上下拖、
     或在图上滚轮缩放价格, 都不会触发任何回调 → 我们的绘图层(入场/止盈/止损/画好的图元)
     只在 mouseup 后才重绘一次, 看起来就是"止盈止损不跟着动, 松手才到位"。
     这里每帧取两个固定价格在屏幕上的 y 当指纹, 变了就补一帧;
     为了不白烧 CPU, 只在按下 / 滚轮之后的窗口期内跑。 */
  watchPriceScale() {
    const area = document.getElementById('chartArea');
    if (!area || this._watchBound) return;
    this._watchBound = true;
    let raf = 0, stopAt = 0, last = '';

    const fingerprint = () => {
      const s = ChartMgr.candle;
      if (!s) return '';
      const a = s.priceToCoordinate(0), b = s.priceToCoordinate(100);
      return (a == null || b == null) ? '' : a.toFixed(3) + ',' + b.toFixed(3);   // 缩放会改斜率, 平移会改截距, 两个采样都看
    };
    const tick = () => {
      raf = 0;
      const sig = fingerprint();
      if (sig && sig !== last) {
        last = sig;
        this.render();                     // yOf/pOf 每次都现算, 所以直接重绘就是跟随
      }
      if (performance.now() < stopAt) raf = requestAnimationFrame(tick);
    };
    const kick = ms => {                        // 延长跟随窗口
      stopAt = Math.max(stopAt, performance.now() + ms);
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const settle = () => {                      // 松手: 立刻缩短窗口, 再补几帧收尾
      stopAt = performance.now() + 250;
      if (!raf) raf = requestAnimationFrame(tick);
    };

    area.addEventListener('mousedown', () => kick(15000), true);       // 按住期间一直跟
    window.addEventListener('mouseup', settle, true);
    area.addEventListener('wheel', () => kick(320), { passive: true, capture: true });
    area.addEventListener('dblclick', () => kick(400), true);
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

  /** x → 逻辑索引 (可以是小数、可以越界)。拖动时算横向位移用它 ——
   *  时间轴不是等比的 (周末/夜盘缺口、日线是日期串), 直接拿"秒差"当位移会走样;
   *  逻辑索引就是「第几根 K 线」, 像素和它线性对应, 加减都成立。 */
  logicalAtX(x) {
    const l = ChartMgr.chart.timeScale().coordinateToLogical(x);
    return (l == null || !isFinite(l)) ? null : l;
  },
  pOf(y) { return ChartMgr.candle.coordinateToPrice(y); },

  /** 一个 {t,p} 锚点 → 屏幕像素; 任一维取不到就返回 null */
  _px(pt) {
    if (!pt) return null;
    const x = this.xOf(pt.t), y = this.yOf(pt.p);
    return (x == null || y == null) ? null : { x, y };
  },

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
    this.save();                 // 每画完一个立刻落盘, 不给"忘了存"留窗口
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
    this.save();
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
    this.save();
    return it;
  },
  removeAll() {
    const n = this.items.length;
    if (n) this.pushHistory();
    this.items = [];
    this.selected = null;
    this.draft = null;
    this.render();
    this.save();                 // 清空也要存: 不然刷新一下又全回来了
    return n;
  },
  clearAll() {   // 静默清空 (只在真需要销毁画布时用)
    this.items = []; this.selected = null; this.draft = null; this._drag = null;
    this.undo = []; this.redo = [];
    this.render();
    this.save();
  },
  count() { return this.items.length; },

  /* ---------- 存档读写 ---------- */
  /** localStorage 里的全量存档 (格式不对就当空的, 不让一条坏数据把整个绘图搞死) */
  _readLocal() {
    try {
      const o = JSON.parse(localStorage.getItem(this.STORE) || 'null');
      if (o && typeof o === 'object' && o.byTf && typeof o.byTf === 'object') return o;
    } catch (e) { }
    return { version: 1, byTf: {}, updatedAt: 0 };
  },

  /** 把内存里的 items 存回「当前周期」那一桶。localStorage 立即写, 磁盘节流 800ms */
  save() {
    const tf = this.tf || (typeof ChartMgr !== 'undefined' && ChartMgr.tf) || '1m';
    const all = this._readLocal();
    all.version = 1;
    all.byTf[tf] = this.snapshot();
    all.updatedAt = Date.now();
    this._all = all;
    try { localStorage.setItem(this.STORE, JSON.stringify(all)); } catch (e) { }
    this._scheduleToServer();
    return all;
  },

  /** 拖动/点选这类高频操作会连着触发 save, 别每次都发一个请求 */
  _scheduleToServer() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = 0;
      this._toServer(this._all || this._readLocal());
    }, 800);
  },

  _toServer(all) {
    try {
      fetch('/api/draw', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(all),
      }).catch(() => { });          // 没服务端就只靠 localStorage, 不弹错
    } catch (e) { }
  },

  /** 启动时读一次存档: 先 localStorage (同步、立刻可用), 再补一次磁盘取更新的那份 */
  async load() {
    const local = this._readLocal();
    let disk = null;
    try {
      const r = await fetch('/api/draw', { cache: 'no-store' });
      if (r.ok) {
        const o = await r.json();
        if (o && typeof o === 'object' && o.byTf) disk = o;
      }
    } catch (e) { }
    /* 取 updatedAt 更新的那份: 磁盘通常更权威, 但刚编辑完还没落盘时 localStorage 才是最新的 */
    const best = (disk && (disk.updatedAt || 0) > (local.updatedAt || 0)) ? disk : local;
    this._all = best;
    if (best === disk) {
      try { localStorage.setItem(this.STORE, JSON.stringify(best)); } catch (e) { }
    }
    return best;
  },

  /** 把「当前周期」那一桶装回画布。
   *  进回放 / 切周期 / 切时段 / 刷新之后都走这里, 替换掉原来的 Draw.clearAll()。
   *  调用时机必须在 ChartMgr.setData() 之后 —— 图元要靠 ChartMgr._lastData 换算坐标。 */
  restore(tf) {
    if (tf) this.tf = tf;
    const key = this.tf || (typeof ChartMgr !== 'undefined' && ChartMgr.tf) || '1m';
    const all = this._all || this._readLocal();
    const list = (all.byTf && all.byTf[key]) || [];
    this.items = JSON.parse(JSON.stringify(list));
    this.selected = null; this.draft = null; this._drag = null;
    /* 撤销栈不跨会话: 刷新完还能撤销到"上一根线"只会让人困惑 (而且 undo 里的图元可能是别的周期的) */
    this.undo = []; this.redo = [];
    // id / z 计数器要跳过已装回来的, 否则新画的会跟存档里的撞 id
    let mx = 0, mz = 0;
    for (const it of this.items) {
      if (it.id > mx) mx = it.id;
      if (it.z > mz) mz = it.z;
    }
    if (mx + 1 > this.seq) this.seq = mx + 1;
    if (mz + 1 > this.zseq) this.zseq = mz + 1;
    this.render();
    return this.items.length;
  },

  /* ---------- 复制 / 粘贴 ---------- */
  /** 复制选中的图元 (Ctrl+C)。返回被复制的那个, 没选中返回 null */
  copySelected() {
    if (this.selected == null) return null;
    const it = this.items.find(i => i.id === this.selected);
    if (!it) return null;
    this._clip = JSON.parse(JSON.stringify(it));
    delete this._clip.id;                 // id/z 由 addItem 重新发, 否则和原图撞
    delete this._clip.z;
    return it;
  },

  /** 粘贴一份副本 (Ctrl+V): 右下偏移, 自动选中, 之后可以像手画的一样拖/改/删 */
  paste() {
    const c = this._clip;
    if (!c) return null;
    const mv = pt => {
      if (!pt) return pt;
      let t = pt.t;
      const l = this._logicalOfTime(pt.t);
      if (l != null) {
        const nt = this.timeOfLogical(l + this.COPY_DL);
        if (nt != null) t = nt;
      }
      return { t, p: Math.round((pt.p + this.COPY_DP) * 100) / 100 };
    };
    const it = JSON.parse(JSON.stringify(c));
    it.a = mv(it.a);
    if (it.b) it.b = mv(it.b);
    if (it.c) it.c = mv(it.c);
    if (!it.a) return null;
    this.pushHistory();
    this.addItem(it);                     // addItem 里会 save()
    this.selected = it.id;
    this.render();
    return it;
  },

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

  /** 把画布外坐标夹回画布边界 (0..W, 0..H)。
      画图/拖拽时鼠标滑出画布, 坐标会变成负数或超过宽高 —— 夹住它,
      效果就是线条停在边界上不动("假装鼠标还在那个边界点"), 鼠标移回来自然接上。 */
  _clampPos({ x, y }) {
    const W = this.W || 0, H = this.H || 0;
    return {
      x: x < 0 ? 0 : (x > W ? W : x),
      y: y < 0 ? 0 : (y > H ? H : y),
    };
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
    // 右侧价格轴上的手势一律让给图表库 (平移/缩放)。否则"线和鼠标同高时点价格轴"会被
    // 当成拖那条线 —— 交易线的命中判定只看 y, 不看 x
    const axW = (typeof ChartMgr !== 'undefined' && ChartMgr._axisW) ? ChartMgr._axisW() : 0;
    if (x > this.W - axW) return;

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
        startL: this.logicalAtX(x),          // 横向位移的基准 (见 onMove 的 body 分支)
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
    // 上/下箭头: 一下就是在光标位置落一个箭头标记
    if (this.tool === 'arrowup' || this.tool === 'arrowdown') {
      this.pushHistory();
      const up = this.tool === 'arrowup';
      this.addItem({ type: 'arrow', dir: up ? 1 : -1, a: { t, p }, b: { t, p },
                     color: up ? this.MARK_UP : this.MARK_DOWN });
      this.setTool('cursor');
      return;
    }

    // 三点工具 (斐波那契扩展): 第 1 点 A → 第 2 点 B → 第 3 点 C
    if (this.tool === 'fibext') {
      if (!this.draft) {
        this.draft = { type: 'fibext', a: { t, p }, b: { t, p }, c: { t, p }, stage: 1 };
        this.render();
        if (typeof App !== 'undefined' && App.toast) App.toast('已定 A 点 · 再点 B 点 (A→B 为 1 个单位)');
        return;
      }
      if (this.draft.stage === 1) {
        this.draft.b = { t, p };
        this.draft.c = { t, p };
        this.draft.stage = 2;
        this.render();
        if (typeof App !== 'undefined' && App.toast) App.toast('已定 B 点 · 再点一下定 C 点 (0 级从 C 起算)');
        return;
      }
      this.draft.c = { t, p };
      this.finishDraft();
      return;
    }

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
    // 三点工具: A→B 要有长度, B→C 要有横向位移才算画成
    if (d.type === 'fibext') {
      const pa = this._px(d.a), pb = this._px(d.b), pc = this._px(d.c);
      const ok = pa && pb && pc
        && Math.hypot(pb.x - pa.x, pb.y - pa.y) >= this.MIN_DRAW_PX
        && Math.abs(pc.x - pb.x) >= 2;
      if (ok) {
        this.pushHistory();
        this.addItem({ type: 'fibext', a: d.a, b: d.b, c: d.c, levels: d.levels || this.FIBEXT.slice() });
      }
      this.setTool('cursor');
      return;
    }
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
    // 监听挂在 document 上, 页面里每次移动都会进来 —— 没有绘制/拖拽就直接走开
    if (!this.draft && !this._drag && !this._dragOrder) return;
    if (!App.engine || this.hidden) return;
    const { x, y } = this._clampPos(this._pos(e));

    if (this.draft) {
      e.stopPropagation();
      const t = this.timeAtX(x);
      const p = this.snapPrice(x, y);
      // 三点工具: 定完 B 之后再移动就是拖 C; 还没定 B 时 B、C 一起跟手
      if (this.draft.type === 'fibext') {
        if (this.draft.stage === 2) {
          if (t != null) this.draft.c = { t, p: p != null ? p : this.draft.c.p };
        } else if (t != null) {
          const pp = p != null ? p : this.draft.b.p;
          this.draft.b = { t, p: pp };
          this.draft.c = { t, p: pp };
        }
        this.render();
        return;
      }
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
      else if (it.type === 'arrow') { it.a = { t, p }; it.b = { t, p }; }
      else if (it.type === 'text') { it.a.t = t; it.a.p = p; }
      else if (it.type === 'fibext') {
        if (part === 'a') it.a = { t, p };
        else if (part === 'b') it.b = { t, p };
        else if (part === 'c') it.c = { t, p };
        else {                                   // body: 三个点一起平移
          const o = this._drag.orig;
          const sh = this._shifter(p, x);
          it.a = sh(o.a); it.b = sh(o.b); it.c = sh(o.c);
        }
      }
      else if (part === 'a') { it.a = { t, p }; }
      else if (part === 'b') { it.b = { t, p }; }
      else {  // body: 整体平移 (上下 + 左右)
        const o = this._drag.orig;
        if (it.type === 'trend' || it.type === 'rect' || it.type === 'fib') {
          const sh = this._shifter(p, x);
          it.a = sh(o.a); it.b = sh(o.b);
        }
      }
      this.render();
      return;
    }
  },

  /** x 相对拖动起点的横向位移, 单位是「根」——时间轴不等比, 只有逻辑索引能这么加 */
  _deltaLogical(x) {
    const a = this._drag && this._drag.startL;
    const b = this.logicalAtX(x);
    return (a == null || b == null) ? null : (b - a);
  },

  /** 「整体平移」用: 返回一个把原锚点按本次拖动量搬过去的函数。
   *
   *  这里以前只算价格增量 dP、`t` 直接抄回原值, 于是趋势线/矩形/斐波那契只能上下拖
   *  (用户 2026-10-24 报)。横向也不能用秒差: 周末缺口、夜盘、日线的日期串都不等比。
   *  用逻辑索引 (第几根 K 线) 做位移再换算回该周期的 t —— 日线自动得到 'yyyy-mm-dd',
   *  跨周末也不会漂。 */
  _shifter(p, x) {
    const dg = this._drag;
    const dP = p - this.pOf(dg.startY);
    const dL = this._deltaLogical(x);
    return pt => {
      if (!pt) return pt;
      let t = pt.t;
      if (dL != null) {
        const l = this._logicalOfTime(pt.t);
        if (l != null) {
          const nt = this.timeOfLogical(l + dL);
          if (nt != null) t = nt;
        }
      }
      return { t, p: pt.p + dP };
    };
  },

  onUp(e) {
    if (this._dragOrder) {
      this._dragOrder = null;
      if (typeof Trading !== 'undefined') Trading.save();
      this.render();
      return;
    }
    if (this._drag) { this._drag = null; this.render(); this.save(); }   // 拖完立刻落盘
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
      if (it.type === 'arrow') {
        const hw = this.MARK.w / 2, hh = this.MARK.h / 2;
        if (ax != null && ay != null && Math.abs(x - ax) <= hw && Math.abs(y - ay) <= hh) {
          return { id: it.id, part: 'a' };
        }
        continue;
      }
      if (it.type === 'text') {
        if (ax != null && ay != null &&
            x > ax - 6 && x < ax + 6 + (it.text || '').length * 7 && y > ay - 14 && y < ay + 6) {
          return { id: it.id, part: 'a' };
        }
        continue;
      }
      if (it.type === 'fibext') {
        const c = this._px(it.c);
        if (ax != null && ay != null && dist(ax, ay) < TH + 2) return { id: it.id, part: 'a' };
        if (bx != null && by != null && dist(bx, by) < TH + 2) return { id: it.id, part: 'b' };
        if (c && dist(c.x, c.y) < TH + 2) return { id: it.id, part: 'c' };
        if (ax == null || ay == null || bx == null || by == null || !c) continue;
        if (this._distSeg(x, y, ax, ay, bx, by) < TH) return { id: it.id, part: 'body' };
        if (this._distSeg(x, y, bx, by, c.x, c.y) < TH) return { id: it.id, part: 'body' };
        // 级别横线 (x 从 B 到 C)
        const lx0 = Math.min(bx, c.x), lx1 = Math.max(bx, c.x);
        if (x > lx0 - TH && x < lx1 + TH) {
          for (const lv of (it.levels || this.FIBEXT)) {
            const yy = this.yOf(it.c.p + (it.b.p - it.a.p) * lv);
            if (yy != null && Math.abs(y - yy) < TH) return { id: it.id, part: 'body' };
          }
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
    // 顺序: 先色带/交易线, 再成交大箭头 —— 反过来的话持仓色带(半透明)会把箭头染淡
    //     (用户截图里箭头也是压在色带之上的饱和色)
    this.drawOrderLines(ctx);          // 交易线不受"隐藏绘图"影响
    this.drawReportMarks(ctx);         // 时间轴: 有日报的日期下加短下划线 (也不受"隐藏绘图"影响)
    /* 成交大箭头放在 hidden 之后: 用户 2026-10-24 要求「眼睛按钮也要把上下箭头一起藏掉」。
       它本来就是我们自己画在绘图层上的 (库自带的 markers 小三角早已关掉), 跟线一起收起才合理。 */
    if (this.hidden) return;
    this.drawTradeMarkers(ctx);        // 成交大箭头 (K 线上方卖 / 下方买)

    for (const it of this.items.slice().sort((p, q) => (p.z || 0) - (q.z || 0))) {
      this.drawItem(ctx, it, it.id === this.selected);
    }
    if (this.draft) this.drawItem(ctx, this.draft, false, true);
  },

  /* ---------- 时间轴: E-mini 日报索引 ----------
     数据来自 data/reports.json (tools/build_reports.py 从 xlsx 生成)。
     有日报的那一天, 在时间轴数字下方画一条短下划线; 时间轴任意位置都能点开那天,
     点击用 window.open 新开标签页。用户 2026-10-22 定的口径:
       「能点的加下划线, 不能点的保持原样; 整条时间轴都能点」。 */
  REPORT_MARK: { w: 14, h: 2, gap: 9 },   // 下划线宽 / 粗 / 相邻标记最小间距

  /** 可见范围内每个"有日报的日期刻度" → [{x, date, url}]
   *  关键: 只认库真正画出来的"日期数字刻度"(type===2, 由 chart.js 的 tickMarkFormatter
   *  逐帧记录到 ChartMgr._dayTickTimes), 不再按"每天第一根 bar"猜 —— 日内图里日刻度
   *  是隔天稀疏的, 首根 bar 的 x 常落在 12:30 这类时分刻度下面。 */
  reportMarks() {
    if (typeof Reports === 'undefined' || !Reports.ready()) return [];
    const ticks = (typeof ChartMgr !== 'undefined' && ChartMgr._dayTickTimes) || [];
    if (!ticks.length) return [];
    const ts = ChartMgr.chart.timeScale();
    const out = [];
    const seen = {};
    let lastX = -1e9;
    for (const time of ticks) {
      const d = chartDateStr(time);
      if (!d || seen[d]) continue;
      seen[d] = true;
      const r = Reports.get(d);
      if (!r) continue;
      let x = null;
      try { x = ts.timeToCoordinate(time); } catch (e) { x = null; }
      if (x == null || !isFinite(x)) continue;
      if (x < 0 || x > this.W) continue;
      if (x - lastX < this.REPORT_MARK.gap) continue;     // 挤在一起就跳过, 免得糊成一条线
      lastX = x;
      out.push({ x, date: d, url: r.u, title: r.t });
    }
    return out;
  },

  drawReportMarks(ctx) {
    this._reportXs = null;
    const marks = this.reportMarks();
    if (!marks.length) return;
    const top = this._priceAreaHeight();
    if (!(top > 0) || top >= this.H - 6) return;
    const c = (typeof ChartMgr !== 'undefined' && ChartMgr.theme === 'dark') ? '#5b8dff' : '#2962ff';
    const y = this.H - 4.5;                 // 贴着时间轴底边, 不压刻度文字
    const half = this.REPORT_MARK.w / 2;
    ctx.save();
    ctx.strokeStyle = c;
    ctx.lineWidth = this.REPORT_MARK.h;
    ctx.lineCap = 'round';
    for (const m of marks) {
      ctx.beginPath();
      ctx.moveTo(Math.round(m.x - half) + 0.5, y);
      ctx.lineTo(Math.round(m.x + half) + 0.5, y);
      ctx.stroke();
    }
    ctx.restore();
    this._reportXs = marks;                  // 点击/手势不用它, 留作自检
  },

  /** 鼠标 x → 该位置所属的 ET 日期 "YYYY-MM-DD"
   *  按"最近的 K 线下标"取, 不用时间反查 —— 时间坐标是连续量, 缩得很小时
   *  coordinateToTime 会把边界上的点判到隔壁那一天去 (实测会误开邻日的日报)。 */
  dateAtX(x) {
    const bars = ChartMgr._lastData;
    if (!bars || !bars.length) return null;
    const ts = ChartMgr.chart.timeScale();
    const l = ts.coordinateToLogical(x);
    if (l == null || !isFinite(l)) return null;
    // 左右空白区不归属任何一天, 免得点了打开"最后一天"的日报
    if (l < -0.5 || l > bars.length - 0.5) return null;
    const i = Math.max(0, Math.min(bars.length - 1, Math.round(l)));
    const b = bars[i];
    return (b && b.epoch != null) ? etDateStr(b.epoch, b.off) : null;
  },

  /** 时间轴区域点击 → 打开那天的日报 (新标签页)。拖动时间轴缩放不算点击。 */
  bindReportClicks(area) {
    if (this._reportClickBound) return;
    this._reportClickBound = true;
    let downX = 0, downY = 0, onAxis = false;
    let lastOpenAt = 0, lastOpenDay = '';      // 双击去抖: 同一天 600ms 内只开一次

    area.addEventListener('mousedown', e => {
      if (e.button !== 0) { onAxis = false; return; }
      const p = this._pos(e);
      onAxis = p.y > this._priceAreaHeight();
      downX = e.clientX; downY = e.clientY;
    }, true);

    area.addEventListener('mouseup', e => {
      if (!onAxis || e.button !== 0) return;
      onAxis = false;
      // 位移超过 4px 当成"拖时间轴缩放", 不跳转
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) return;
      if (typeof Reports === 'undefined' || !Reports.ready()) return;
      const p = this._pos(e);
      if (p.y <= this._priceAreaHeight()) return;
      const d = this.dateAtX(p.x);
      const r = d && Reports.get(d);
      if (!r) return;
      // 双击同一天: 只算一次 (否则会连开两个一模一样的标签页)
      const now = Date.now();
      if (d === lastOpenDay && now - lastOpenAt < 600) return;
      lastOpenDay = d; lastOpenAt = now;
      // 注意: 这里绝对不能再 stopPropagation。
      // lightweight-charts 的"拖动平移"监听挂在 document 的冒泡阶段, mousedown 之后
      // 一直等 mouseup 才松手。在这里把 mouseup 拦死 → 图表以为你还按着鼠标,
      // 从新标签页回来不按键光移动鼠标, 图表就跟着平移(用户 2026-10-22 反馈的现象)。
      // 只 preventDefault(防止浏览器把这次点击当文本选择/拖拽), 事件继续正常传播给图表。
      e.preventDefault();
      window.open(r.u, '_blank', 'noopener');
      if (typeof App !== 'undefined' && App.toast) App.toast(`打开 ${d} 的日报: ${r.t || r.u}`);
    }, true);

    // hover: 那天有日报就变手型, 让人看得出能点
    area.addEventListener('mousemove', e => {
      if (typeof Reports === 'undefined' || !Reports.ready()) return;
      const p = this._pos(e);
      const on = p.y > this._priceAreaHeight();
      const d = on ? this.dateAtX(p.x) : null;
      const want = (d && Reports.get(d)) ? 'pointer' : '';
      if (area.style.cursor !== want) area.style.cursor = want;
    }, true);
  },

  /** 成交标记: 大箭头 ----------
     照用户 2026-10-22 截图逐像素描出来: 杆 19×18 + 三角头 33×20, 总 33×38, 平头平尾无描边。
     买 = K 线下方、箭头朝上、青绿 #70ccbd; 卖 = K 线上方、朝下、红 #cc2f3c。
     出场 (m.isExit) 不分方向一律灰 #787b86 —— 见 MARK_EXIT 的注释。 */
  arrowShape(ctx, cx, cy, dir) {
    const { w, h, stemW, stemH } = this.MARK;
    const half = w / 2, sh = stemW / 2;
    const top = cy - h / 2, bot = cy + h / 2;
    ctx.beginPath();
    if (dir > 0) {                                  // 朝上: 尖在 top
      const base = bot - stemH;                     // 头与杆的分界
      ctx.moveTo(cx, top);
      ctx.lineTo(cx + half, base);
      ctx.lineTo(cx + sh, base);
      ctx.lineTo(cx + sh, bot);
      ctx.lineTo(cx - sh, bot);
      ctx.lineTo(cx - sh, base);
      ctx.lineTo(cx - half, base);
    } else {                                        // 朝下: 尖在 bot
      const base = top + stemH;
      ctx.moveTo(cx, bot);
      ctx.lineTo(cx + half, base);
      ctx.lineTo(cx + sh, base);
      ctx.lineTo(cx + sh, top);
      ctx.lineTo(cx - sh, top);
      ctx.lineTo(cx - sh, base);
      ctx.lineTo(cx - half, base);
    }
    ctx.closePath();
  },

  drawTradeMarkers(ctx) {
    const list = (typeof ChartMgr !== 'undefined' && ChartMgr.markers) || [];
    if (!list.length || !ChartMgr.barByTime) return;
    const axW = (ChartMgr._axisW && ChartMgr._axisW()) || 0;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.W - axW, this._priceAreaHeight());   // 别画到右侧价格轴/时间轴上
    ctx.clip();
    for (const m of list) {
      const b = ChartMgr.barByTime(m.time);
      if (!b) continue;
      const buy = m.shape === 'arrowUp';
      const yEdge = this.yOf(buy ? b.l : b.h);
      const x = this.xOf(b.t);
      if (yEdge == null || x == null) continue;
      const half = this.MARK.h / 2;
      const cy = buy ? yEdge + this.MARK_GAP + half : yEdge - this.MARK_GAP - half;
      this.arrowShape(ctx, x, cy, buy ? 1 : -1);
      ctx.fillStyle = m.isExit ? this.MARK_EXIT : (buy ? this.MARK_UP : this.MARK_DOWN);
      ctx.fill();
    }
    ctx.restore();
  },

  /* ---------- 交易线: 挂单 / 入场 / 止盈 / 止损 (均可拖动) ---------- */
  orderLines() {
    const out = [];
    if (typeof Trading === 'undefined') return out;
    const mult = Trading.MULT || 50, pos = Trading.pos;
    // 突破挂单: 每张单一条线 + 右侧牌子 (买=蓝 / 卖=红)
    // 挂单时已经机械性算好 tp/sl (App.plannedBrackets), 所以三条线一起显示, 三条都能拖
    for (const s of (Trading.stops || [])) {
      const buy = s.side === 'buy';
      const dir = p => (buy ? p - s.price : s.price - p);   // 相对挂单价的点数
      out.push({
        key: 'stop:' + s.id, price: s.price, kind: 'stop', qty: s.qty,
        color: buy ? '#2962ff' : '#f23645',
        label: buy ? '突破买' : '突破卖', pts: null, solid: true,
      });
      if (s.tp != null) out.push({
        key: 'stop:' + s.id + ':tp', price: s.tp, kind: 'tp', qty: s.qty,
        color: '#089981', label: '', pts: dir(s.tp), solid: false,
      });
      if (s.sl != null) out.push({
        key: 'stop:' + s.id + ':sl', price: s.sl, kind: 'sl', qty: s.qty,
        color: '#ff9800', label: '', pts: dir(s.sl), solid: false,
      });
    }
    if (pos !== 0) {
      const n = Math.abs(pos), long = pos > 0;
      // 牌子上的盈亏改按"点"显示 (用户要求): 一点 = $50, 即价格走了几个点
      const ptsAt = p => (long ? p - Trading.avg : Trading.avg - p);
      const last = (ChartMgr._lastData || []);
      const cur = last.length ? last[last.length - 1].c : Trading.avg;
      out.push({
        key: 'entry', price: Trading.avg, kind: 'entry', qty: n,
        color: '#2962ff', label: '', pts: ptsAt(cur), solid: true,
      });
      if (Trading.tp != null) out.push({
        key: 'tp', price: Trading.tp, kind: 'tp', qty: n,
        color: '#089981', label: '', pts: ptsAt(Trading.tp), solid: false,
      });
      if (Trading.sl != null) out.push({
        key: 'sl', price: Trading.sl, kind: 'sl', qty: n,
        color: '#ff9800', label: '', pts: ptsAt(Trading.sl), solid: false,
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
      const parts = key.split(':');
      const id = +parts[1];
      // 挂单上的 tp/sl 单独一条: 只清这一项, 挂单本身还在
      if (parts[2]) {
        const s = (Trading.stops || []).find(s => s.id === id);
        if (!s) return false;
        if (parts[2] === 'tp') s.tp = null; else s.sl = null;
        Trading.save(); this.render();
        if (typeof App !== 'undefined') {
          App.toast(`已取消这张挂单的${parts[2] === 'tp' ? '止盈' : '止损'}`);
        }
        return true;
      }
      // 撤销挂单要进账本 (存活 ≥1 根的才算挂过)
      const cur = (typeof App !== 'undefined' && App.engine) ? App.engine.current : null;
      const n = Trading.removeStops([id], cur ? cur.epoch : null, cur ? cur.off : null);
      this.render();
      if (typeof App !== 'undefined') App.toast(n ? '已撤销这张挂单' : '挂单已不存在');
      return n > 0;
    }
    if (key === 'tp') {
      Trading.tp = null; Trading._tpMoved = true; Trading.save(); this.render();
      if (typeof App !== 'undefined') App.toast('已取消止盈 (只保留止损)');
      return true;
    }
    if (key === 'sl') {
      Trading.sl = null; Trading._slMoved = true; Trading.save(); this.render();
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
      const parts = key.split(':');
      const id = +parts[1];
      const s = (Trading.stops || []).find(s => s.id === id);
      if (!s) return;
      if (parts[2] === 'tp') { s.tp = price; return; }
      if (parts[2] === 'sl') { s.sl = price; return; }
      // 拖挂单价: 止盈止损按相对距离一起走 (用户 2026-10-23 要求)
      const d = price - s.price;
      s.price = price;
      const mv = v => Math.round((v + d) * 4) / 4;
      if (s.tp != null) s.tp = mv(s.tp);
      if (s.sl != null) s.sl = mv(s.sl);
    } else if (key === 'tp') { Trading.tp = price; Trading._tpMoved = true; }
    else if (key === 'sl') { Trading.sl = price; Trading._slMoved = true; }
  },

  _axisWidth() {
    try { return ChartMgr.chart.priceScale('right').width() || 60; } catch (e) { return 60; }
  },

  /** 点数盈亏: 0.00 / +12.00 / -8.25 (ES 1 点 = 50 美元, 这里只显示价格走了多少点) */
  _fmtPts(v) {
    if (v == null || !isFinite(v)) return '—';
    const a = Math.abs(v).toFixed(2);
    if (Math.abs(v) < 0.005) return '0.00 点';
    return (v > 0 ? '+' : '-') + a + ' 点';
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
    const midTxt = (o.pts != null) ? this._fmtPts(o.pts) : (o.label || '');
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

    /* 1) 盈亏色区 (入场→止盈 淡绿 / 入场→止损 淡橙) 已按用户 2026-10-23 要求整块去掉:
       持仓期间那两块底色一直铺在盘面上, 影响观感和判断。
       这是**主动偏离 TradingView** 的一处 (原版有, 见 reference/16-TV-双边盈亏区-2026-10-21.png),
       用户明确要求去掉, 不是 bug。TP/SL 的线、右侧圆点、牌子都照旧。 */

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
      const probe = { key: 'entry', qty: entry.qty, color: dir, pts: entry.pts, solid: true, label: '' };
      ctx.font = '700 11px -apple-system, "Segoe UI", sans-serif';
      const wl0 = Math.ceil(ctx.measureText('◀ ' + probe.qty).width) + 18;
      ctx.font = '500 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      const wm0 = Math.ceil(ctx.measureText(this._fmtPts(probe.pts)).width) + 22;
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
      /* 原来这里会在线的中点浮一个蓝底 `+16.09 (+0.30%)` 的涨跌标签。
         用户 2026-10-24 明确不要:「划线会出现这个蓝色的, 没必要出现」——
         TradingView 的趋势线默认也不带它 (那是「显示价格变动」这个开关打开才有的)。 */
      if (selected) this.handles(ctx, [[ax, ay], [bx, by]]);
    } else if (it.type === 'arrow') {
      // 上/下箭头标记: 与成交标记同一个字形, 一下落一个
      if (ax == null || ay == null) { ctx.restore(); return; }
      const dir = it.dir || 1;
      ctx.setLineDash([]);
      this.arrowShape(ctx, ax, ay, dir);
      ctx.fillStyle = it.color || (dir > 0 ? this.MARK_UP : this.MARK_DOWN);
      ctx.fill();
      if (selected) this.handles(ctx, [[ax, ay]]);
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
      // 照 reference/06 截图: 无填充; 深灰水平线 + 左侧 `级别 (价格)` 灰字 + 两端空心圆手柄(仅绘制中)
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
      // 两个圆形手柄 (空心圆: 蓝环白芯) —— 和扩展一样只在画的过程中给落点反馈;
      //    画完不画圈 (用户 2026-10-22: "斐波纳契现在画完之后还有圆圈"), 挪点靠选中后的方形手柄
      if (isDraft) {
        const knob = (cx, cy) => {
          if (cx == null || cy == null) return;
          ctx.beginPath(); ctx.arc(cx, cy, 8, 0, Math.PI * 2);
          ctx.fillStyle = dark ? '#131722' : '#fff'; ctx.fill();
          ctx.strokeStyle = this.COLOR; ctx.lineWidth = 1.6; ctx.stroke();
        };
        knob(ax, ay); knob(bx, by);
      }
      ctx.strokeStyle = it.color || this.COLOR;
      ctx.fillStyle = it.color || this.COLOR;
      if (selected) this.handles(ctx, [[ax, ay], [bx, by]]);
    } else if (it.type === 'fibext') {
      // 照 reference/18 + 20 截图:
      //   浅灰虚线 A→B→C (只在画的过程中带三个锚点圈)
      //   每个级别一条灰实线, 横向从 x(B) 拉到 x(C), 标签右对齐贴在线左端外侧
      const cc = this._px(it.c);
      if (ax == null || ay == null || bx == null || by == null || !cc) { ctx.restore(); return; }
      const dark = ChartMgr.theme === 'dark';
      const dashC = dark ? '#4a4e59' : '#cfcfcf';
      const lineC = dark ? '#b2b5be' : '#808080';

      // 1) A→B→C 虚线 (实测: 虚 8px / 实 8px, 1px 宽)
      ctx.setLineDash([8, 8]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = dashC;
      ctx.beginPath();
      ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.lineTo(cc.x, cc.y);
      ctx.stroke();
      ctx.setLineDash([]);

      // 2) 级别线 + 标签
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = lineC;
      ctx.font = '12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'right';
      const step = it.b.p - it.a.p;                 // A→B 的 1 个单位
      for (const lv of (it.levels || this.FIBEXT)) {
        const price = it.c.p + step * lv;
        const yy = this.yOf(price);
        if (yy == null) continue;
        ctx.beginPath(); ctx.moveTo(bx, yy); ctx.lineTo(cc.x, yy); ctx.stroke();
        const txt = `${lv} (${this._fmtPrice(price)})`;
        const tw = ctx.measureText(txt).width;
        ctx.fillStyle = lineC;
        let tx = bx - 5.5;                          // 实测: 标签右端距 x(B) 约 7 CSS px
        if (tx - tw < 2) tx = tw + 2;               // 左边实在放不下就贴左边缘
        ctx.fillText(txt, tx, yy);
      }

      // 3) 三个空心圆锚点 (蓝环 + 白芯) —— 只在画的过程中给落点反馈;
      //    画完就收掉 (照 reference/20: 画好的扩展只有虚线和级别横线, 没有圈),
      //    要挪点靠选中后的方形手柄
      if (isDraft) {
        const knob = (kx, ky) => {
          if (kx == null || ky == null) return;
          ctx.beginPath(); ctx.arc(kx, ky, 4.75, 0, Math.PI * 2);
          ctx.fillStyle = dark ? '#131722' : '#fff'; ctx.fill();
          ctx.strokeStyle = this.COLOR; ctx.lineWidth = 1; ctx.stroke();
        };
        knob(ax, ay); knob(bx, by); knob(cc.x, cc.y);
      }

      ctx.strokeStyle = it.color || this.COLOR;
      ctx.fillStyle = it.color || this.COLOR;
      if (selected) this.handles(ctx, [[ax, ay], [bx, by], [cc.x, cc.y]]);
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
