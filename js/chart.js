/* ============ chart.js — lightweight-charts v5 封装 (TradingView 风格) ============ */

/* 全局 rAF 帧号: tickMarkFormatter 靠它区分"同一帧内的连续调用"。
   日报下划线只画在库真正显示了"日期数字刻度"(type===2)的那几天下面 ——
   日内图里日刻度是隔天稀疏的(不是每天都有日期数字), 用这个帧号保证
   每帧只保留当帧的刻度, 上一帧的自动作废, 不会画到时分刻度下面去。 */
let __rafFrame = 0;
(function __rafLoop() { __rafFrame++; requestAnimationFrame(__rafLoop); })();

/* ---------------- Bar Count 图元 ----------------
   为什么挂在 series 上, 而不是画在我们自己的 #drawLayer 里:
   那张 canvas 是独立的 requestAnimationFrame 重绘, 跟图表自己的渲染循环差一帧 ——
   拖动/缩放/回放时数字会"脱影"、"不跟"; 而且每帧要为几百根 K 线走一遍 timeToCoordinate。
   作为 pane 图元放进 lightweight-charts 的渲染管线后, 和 K 线同一帧、同一套坐标:
   天然同步, 也不额外开渲染循环。 */
const BarCountView = {
  zOrder() { return 'top'; },                 // 压在 K 线之上
  renderer() { return { draw: target => drawBarCounts(target) }; },
};

const BarCountPrimitive = {
  _chart: null, _series: null, _req: null,
  _views: [BarCountView],                     // 固定数组: 库会用 === 比对来复用视图, 每次新建会白走一遍
  attached(p) { this._chart = p.chart; this._series = p.series; this._req = p.requestUpdate; },
  detached() { this._chart = null; this._series = null; this._req = null; },
  updateAllViews() {},
  paneViews() { return this._views; },
  /** 开关/配色变了, 让图表重画一帧(图元内容由 drawBarCounts 每次现算) */
  refresh() { if (this._req) this._req(); },
};

/** Bar Count 数字顶端与 K 线最低点的垂直间距 (CSS px), 实测 reference/20 = 48.8 device / 2 */
const BARCOUNT_GAP = 24.4;

/* Bar Count 数字层缓存 ----------------------------------------------------
   drawBarCounts 挂在库的渲染管线里, 鼠标每移动一次就整幅重画一遍:
   150 根可见 K 线各算一次 priceToCoordinate/logicalToCoordinate, 再画 40~50 个 fillText。
   fillText 是 canvas 2D 里最贵的操作之一; 在 DPR 1.75 的 2195×1147 窗口(位图 3140×1820)下,
   用户实测移动鼠标时有 4.7% 的帧掉到 33ms (26/555 帧, 静止时 0 次)。
   但光标移动时视窗并没有变, 这一层的内容完全一样 —— 所以按指纹缓存整层位图,
   命中就只做一次 drawImage(blit), 视窗/价格轴/主题变了才重画。
   视觉零变化: 还是同一段绘制代码, 只是不再每帧重复做字形光栅化。 */
let _bcLayer = null, _bcKey = '';

function drawBarCounts(target) {
  if (typeof Draw !== 'undefined' && !Draw.showBarCount) return;
  const bars = ChartMgr._lastData;
  const chart = BarCountPrimitive._chart, series = BarCountPrimitive._series;
  if (!bars || !bars.length || !chart || !series) return;
  const ts = chart.timeScale();
  const lr = ts.getVisibleLogicalRange();
  if (!lr) return;

  // 密度: 默认每 2 根显示一次(2/4/6…), 缩小时成倍稀疏, 再密就整体不画(与 TV 一致)
  const spacing = ts.options().barSpacing || 7;
  let every;
  if (spacing >= 5) every = 2;
  else if (spacing >= 3.2) every = 4;
  else if (spacing >= 2) every = 8;
  else return;

  const i0 = Math.max(0, Math.floor(lr.from));
  const i1 = Math.min(bars.length - 1, Math.ceil(lr.to));
  if (i1 < i0) return;

  const dark = ChartMgr.theme === 'dark';

  target.useBitmapCoordinateSpace(scope => {
    const ctx = scope.context;
    const hrp = scope.horizontalPixelRatio, vpr = scope.verticalPixelRatio;
    const bwRaw = scope.bitmapSize.width, bhRaw = scope.bitmapSize.height;
    const bw = Math.round(bwRaw), bh = Math.round(bhRaw);
    const H = bhRaw / vpr;                  // 画布高度(CSS px), 用未取整的值免得数字位移

    /* 指纹: 视窗 + 纵向缩放 + 画布尺寸 + 主题 + 数据长度 + 显示密度。
       价格轴(纵向)没有任何订阅回调, 拿两根可见 K 线最低点的屏幕 y 当指纹。 */
    const ya = series.priceToCoordinate(bars[i0].l);
    const yb = series.priceToCoordinate(bars[i1].l);
    const key = [lr.from.toFixed(2), lr.to.toFixed(2), ya, yb,
      bw, bh, dark ? 'd' : 'l', bars.length, every].join('|');

    if (_bcLayer && _bcKey === key && _bcLayer.width === bw && _bcLayer.height === bh) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);   // 位图坐标系, 1:1 贴回去
      ctx.drawImage(_bcLayer, 0, 0);
      ctx.restore();
      return;
    }

    if (!_bcLayer || _bcLayer.width !== bw || _bcLayer.height !== bh) {
      _bcLayer = document.createElement('canvas');
      _bcLayer.width = bw; _bcLayer.height = bh;
    }
    const c = _bcLayer.getContext('2d');
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, bw, bh);
    c.scale(hrp, vpr);                      // 之后按 CSS px 画
    // 照 reference/20 逐像素标定: 数字墨迹高 15 device px (=7.5 CSS), 字干 2 device px
    //   → 常规字重(400) 11px; 数字中心与 K 线中心对齐
    c.font = '400 11px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif';
    c.textAlign = 'center';
    c.textBaseline = 'alphabetic';
    c.fillStyle = dark ? '#ffab40' : '#ff9800';     // TV 的 Bar Count 是橙色 rgb(255,152,0)
    // 数字顶端距 K 线最低点固定 24.4 CSS px (10 根样本 48~50 device px, 与蜡烛形状无关)。
    // 用字形真实高度把"顶端"换算成 baseline, 免得不同字体基线位置不一样
    const capH = c.measureText('0').actualBoundingBoxAscent || 7.5;
    for (let i = i0; i <= i1; i++) {
      const b = bars[i];
      const n = b && b.dayNo;
      if (!n || n % every !== 0) continue;
      const y = series.priceToCoordinate(b.l);
      // 上下都要判: 旧版只判了"低于下边界", K 线跑到视窗上方时数字会飘在顶上
      if (y == null || y < 0 || y > H - 12) continue;
      const x = ts.logicalToCoordinate(i);
      if (x == null) continue;
      c.fillText(String(n), x, y + BARCOUNT_GAP + capH);  // 不再描边: TV 就是纯色字
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    _bcKey = key;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(_bcLayer, 0, 0);
    ctx.restore();
  });
}

const ChartMgr = {
  chart: null, candle: null, ema: null, markersPlugin: null,
  priceLine: null, posLine: null,
  markers: [],
  emaEnabled: true,
  tf: '1m',
  theme: 'light',
  scheme: 'cn',                       // cn=红涨绿跌, us=绿涨红跌

  /** 当前主题的图表配色 (TradingView light / dark) */
  themeColors() {
    if (this.theme === 'dark') {
      return { bg: '#131722', text: '#d1d4dc', grid: '#2a2e39', border: '#2a2e39',
               label: '#363a45', crosshair: '#758696' };
    }
    return { bg: '#ffffff', text: '#131722', grid: '#e0e3eb', border: '#e0e3eb',
             label: '#131722', crosshair: '#9598a1' };
  },

  /**
   * 黑白配色 (价格行为学/阿尔·布鲁克斯风格): 两个主题下都是「白涨黑跌」。
   * 浅色: 阳线 = 空心(背景白填充 + 黑边框) → 白; 阴线 = 实心黑 → 黑。
   * 深色: 不能照抄成镜像(那样就成了"黑涨白跌", 用户 2026-10-22 指出错了),
   *       阳线 = 浅灰实心(读作白), 阴线 = 背景深色填充 + 浅色描边(读作黑, 靠边框才看得见)。
   */
  bw() {
    const t = this.themeColors();
    if (this.theme === 'dark') {
      return {
        upFill: t.text, upBorder: t.text, wick: t.text,        // 涨 = 白(浅灰实心)
        downFill: t.bg, downBorder: t.text,                    // 跌 = 黑(深底 + 亮边框)
        ink: t.text,
      };
    }
    return {
      upFill: t.bg, upBorder: t.text, wick: t.text,            // 涨 = 白(空心)
      downFill: t.text, downBorder: t.text,                    // 跌 = 黑(实心)
      ink: t.text,
    };
  },

  colors() {
    const b = this.bw();
    return { up: b.ink, down: b.ink };      // 成交标记/尺子统一用墨色
  },

  soft(hex) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},.45)`;
  },

  /** K线颜色套用(含空心边框), init / 主题切换 / 配色切换都要调 */
  applyCandleColors() {
    const b = this.bw();
    this.candle.applyOptions({
      upColor: b.upFill, borderUpColor: b.upBorder, wickUpColor: b.wick,
      downColor: b.downFill, borderDownColor: b.downBorder, wickDownColor: b.wick,
      borderVisible: true,                 // 空心阳线靠边框成形
    });
  },

  init() {
    const el = document.getElementById('chartMain');
    const t = this.themeColors();
    this.chart = LightweightCharts.createChart(el, {
      layout: {
        background: { type: 'solid', color: t.bg },
        textColor: t.text,
        fontSize: 11,
        attributionLogo: false,          // 去掉左下角 TradingView logo
      },
      grid: {
        // 用户要求: 干净背景, 不要网格线
        vertLines: { visible: false },
        horzLines: { visible: false },
      },
      crosshair: {
        mode: LightweightCharts.CrosshairMode.Normal,
        vertLine: { color: t.crosshair, width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: t.label },
        horzLine: { color: t.crosshair, width: 1, style: LightweightCharts.LineStyle.Dashed, labelBackgroundColor: t.label },
      },
      rightPriceScale: {
        borderColor: t.border,
        scaleMargins: { top: 0.06, bottom: 0.06 },
        entireTextOnly: true,
      },
      timeScale: {
        borderColor: t.border,
        timeVisible: true, secondsVisible: false,
        rightOffset: 6, barSpacing: 7,
        fixLeftEdge: false, lockVisibleTimeRangeOnResize: true,
        tickMarkFormatter: (time, type) => {
          // 记录本帧"日刻度"(type===2), 供 draw.js 的日报下划线定位。
          // 只有库真的显示了日期数字的那几天才有资格画线(日内图里日刻度隔天稀疏)。
          if (type === 2) {
            if (!ChartMgr._dayTickTimes) ChartMgr._dayTickTimes = [];
            if (ChartMgr._dayTickFrame !== __rafFrame) {
              ChartMgr._dayTickFrame = __rafFrame;
              ChartMgr._dayTickTimes.length = 0;
            }
            ChartMgr._dayTickTimes.push(time);
          }
          // 日/3日/周/月线的 time 是 "YYYY-MM-DD" 字符串, 直接 *1000 会得到 NaN
          // 日刻度只出数字, 不带「日」字 (用户 2026-10-22 要求: 屏幕最下面那条时间轴 xx日 → xx)
          if (typeof time === 'string') {
            const s = time.split('-').map(Number);
            if (type === 0) return String(s[0]);
            if (type === 1) return `${s[1]}月`;
            return String(s[2]);
          }
          if (time && typeof time === 'object') {                   // BusinessDay 形式
            if (type === 0) return String(time.year);
            if (type === 1) return `${time.month}月`;
            return String(time.day);
          }
          const d = new Date(time * 1000), p = n => String(n).padStart(2, '0');
          if (type === 0) return String(d.getUTCFullYear());        // 年
          if (type === 1) return `${d.getUTCMonth() + 1}月`;          // 月
          if (type === 2) return String(d.getUTCDate());             // 日 (不带「日」字)
          return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;     // 时:分(ET)
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: {
        locale: 'zh-CN',
        // 图表时间戳 = "ET 墙钟编码成的假 UTC 秒", 统一用 UTC 方法格式化 => 恒显示美东时间
        timeFormatter: (t) => {
          if (typeof t === 'string') return t;                     // 日线: 只显示日期
          if (t && typeof t === 'object') {
            const p2 = n => String(n).padStart(2, '0');
            return `${t.year}-${p2(t.month)}-${p2(t.day)}`;
          }
          const d = new Date(t * 1000), p = n => String(n).padStart(2, '0');
          return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
                 `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
        },
      },
    });
    this.resize();

    const bwc = this.bw();
    this.candle = this.chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: bwc.upFill, borderUpColor: bwc.upBorder, wickUpColor: bwc.wick,
      downColor: bwc.downFill, borderDownColor: bwc.downBorder, wickDownColor: bwc.wick,
      borderVisible: true,
      priceLineVisible: false, lastValueVisible: false,   // 价格标签由自定义彩色价线提供, 避免双标签
      priceFormat: { type: 'price', precision: 2, minMove: 0.25 },
    }, 0);

    // v5: 成交标记是独立 primitive(不再是 series.setMarkers), 构造时自动 attach
    this.markersPlugin = LightweightCharts.createSeriesMarkers(this.candle, []);

    // Bar Count 也走图元: 跟 K 线同帧绘制, 不会脱影
    this.candle.attachPrimitive(BarCountPrimitive);

    // 注: 参考截图里没有成交量副图, 用户也明确说"删了成交量, 我不需要" => 不建 HistogramSeries
    // 参考截图: EMA 是黑色细线 + 右侧价格轴黑底数值标签 (不是橙色)
    this.ema = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: t.text, lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: false,
    }, 0);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(document.getElementById('chartWrap'));

    this.chart.subscribeCrosshairMove(param => this.onCrosshair(param));
    this.bindPanTuning();
  },

  _axisW() {
    try { return this.chart.priceScale('right').width() || 60; } catch (e) { return 60; }
  },

  /* ---------- 纵向拖动: 不必先去价格轴上拉一下 ----------
     lightweight-charts 在 autoScale 打开时每帧重算价格区间, 纵向拖动完全无效,
     必须先手动缩放过价格轴(退出 autoScale)才能上下拖。
     TradingView 的观感是不用先拉轴; 这里改成: 只要这一下手势以纵向为主, 就立刻退出 autoScale,
     剩下的交给库自己走完 (实测库在 autoScale=false 时纵向拖动正常)。
     恢复自动: 双击右侧价格轴 (库自带 axisDoubleClickReset)。 */
  bindPanTuning() {
    const area = document.getElementById('chartArea');
    if (!area || this._panBound) return;
    this._panBound = true;
    let start = null;

    const onDown = e => {
      if (e.button !== 0) return;
      const d = (typeof Draw !== 'undefined') ? Draw : null;
      if (d && d.tool !== 'cursor') return;                    // 正在用绘图工具
      const r = area.getBoundingClientRect();
      if (d && (d.hitTest(e.clientX - r.left, e.clientY - r.top) || d.hitOrder(e.clientY - r.top))) return;
      if (!this.chart.priceScale('right').options().autoScale) return;   // 已经是手动缩放态
      start = { x: e.clientX, y: e.clientY };
    };

    const onMove = e => {
      if (!start) return;
      const dx = Math.abs(e.clientX - start.x), dy = Math.abs(e.clientY - start.y);
      if (dx < 3 && dy < 3) return;
      const s = start; start = null;
      if (dy > dx) {
        this.chart.priceScale('right').applyOptions({ autoScale: false });
        if (typeof App !== 'undefined' && App.toast) App.toast('价格轴已退出自动缩放 · 双击价格轴可恢复');
      }
    };

    area.addEventListener('mousedown', onDown, true);
    area.addEventListener('mousemove', onMove, true);
    const clear = () => { start = null; };
    area.addEventListener('mouseup', clear, true);
    area.addEventListener('mouseleave', clear, true);
  },

  resize() {
    const el = document.getElementById('chartMain');
    const w = el.clientWidth, h = el.clientHeight;
    if (w > 0 && h > 0) this.chart.applyOptions({ width: w, height: h });
  },

  /* ---------- 主题 ---------- */
  applyTheme(mode) {
    this.theme = mode;
    const t = this.themeColors();
    this.chart.applyOptions({
      layout: { background: { type: 'solid', color: t.bg }, textColor: t.text },
      grid: { vertLines: { visible: !!this.gridOn, color: t.grid }, horzLines: { visible: !!this.gridOn, color: t.grid } },
      crosshair: {
        vertLine: { color: t.crosshair, labelBackgroundColor: t.label },
        horzLine: { color: t.crosshair, labelBackgroundColor: t.label },
      },
      rightPriceScale: { borderColor: t.border },
      timeScale: { borderColor: t.border },
    });
    this.applyCandleColors();
    if (this.ema) this.ema.applyOptions({ color: t.text });   // EMA 跟随主题墨色
    if (this._lastData && this._lastData.length) {
      this.setData(this._lastData, { preserve: true });
    }
  },

  setScheme(scheme) {
    this.scheme = scheme;
    this.applyCandleColors();
    if (this._lastData && this._lastData.length) {
      this.setData(this._lastData, { preserve: true });
    }
  },

  setTf(tf) {
    this.tf = tf;
    const daily = (tf === '1d' || tf === '3d' || tf === '1w' || tf === '1M');
    this.chart.timeScale().applyOptions({ timeVisible: !daily, secondsVisible: false });
  },

  /** 网格线开关 (顶栏 ⊞ 按钮; 默认关, 用户要求干净背景) */
  setGrid(on) {
    this.gridOn = !!on;
    const t = this.themeColors();
    this.chart.applyOptions({
      grid: {
        vertLines: { visible: this.gridOn, color: t.grid },
        horzLines: { visible: this.gridOn, color: t.grid },
      },
    });
  },

  setEmaEnabled(on) { this.emaEnabled = on; if (!on) this.ema.setData([]); },

  /* ---------- 视窗控制 (TradingView 行为: 不打断用户缩放/拖动) ---------- */
  /** 右侧留白比例: 空白占整幅宽度的 1/3, 即空白 = 有 K 线部分的一半 */
  RIGHT_BLANK: 0.5,

  /** 显示最近 n 根, 靠左 2/3, 右侧 1/3 留空 (新图初始状态 / 换一段 / 重置) */
  fitRecent(n = 100) {
    const total = this._lastData ? this._lastData.length : 0;
    if (!total) return;
    const shown = Math.min(n, total);
    const from = Math.max(0, total - shown) - 0.5;
    const to = from + shown * (1 + this.RIGHT_BLANK);   // 有 K 线部分 : 空白 = 2 : 1
    this.chart.timeScale().setVisibleLogicalRange({ from, to });
  },

  /** 以某根为锚点显示 (切周期/时段时锚定原时间位置, 不像 fitContent 那样跳走)
   *  锚点落在横向 2/3 处, 右侧 1/3 留空 */
  fitAround(idx, n = 140) {
    if (!this._lastData || !this._lastData.length) return;
    const total = this._lastData.length;
    const i = Math.min(Math.max(0, idx), total - 1);
    const from = i - n * (2 / 3);
    const to = from + n;
    this.chart.timeScale().setVisibleLogicalRange({ from, to });
  },

  fitAll() {
    if (!this._lastData || !this._lastData.length) return;
    this.chart.timeScale().fitContent();
  },

  /** 当前视窗 (供"是否跟随"判断/测试) */
  visibleRange() {
    try { return this.chart.timeScale().getVisibleLogicalRange(); } catch (e) { return null; }
  },

  /** Bar Count 开关/配色变化后重画一帧
   *  必须同时作废层缓存: 这个方法的语义就是"内容变了, 强制重画一遍",
   *  而缓存按"视窗+价格轴+主题"做指纹, 开关配色这类变化它未必能察觉。 */
  refreshBarCount() { _bcLayer = null; _bcKey = ''; BarCountPrimitive.refresh(); },

  /**
   * 全量替换数据
   * @param {boolean|string} opts.fit  false=保持视窗 | 'recent'=最近180根 | 'all'=全部
   * @param {boolean} opts.preserve     true=恢复调用前的可见区间
   */
  setData(bars, opts = {}) {
    const ts = this.chart.timeScale();
    let prev = null;
    if (opts.preserve && !opts.fit) prev = this.visibleRange();

    this._lastData = bars.slice();
    const candleData = new Array(bars.length);
    const emaData = [];
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      candleData[i] = { time: b.t, open: b.o, high: b.h, low: b.l, close: b.c };
      if (this.emaEnabled && b.ema != null) emaData.push({ time: b.t, value: b.ema });
    }
    this.candle.setData(candleData);
    this.ema.setData(emaData);
    if (bars.length) this.setLastPrice(bars[bars.length - 1]);

    if (opts.fit === 'recent') this.fitRecent();
    else if (opts.fit === 'all') this.fitAll();
    else if (prev) {
      // 跟随态判断: 视窗右端贴着最新一根且新 bar 会跑出视窗 => 整体右移一格
      // 否则严格恢复用户原来的视窗(不打断拖动/缩放)
      const n = bars.length;
      const follow = opts.followLast && prev.to < n && prev.to >= n - 3;
      ts.setVisibleLogicalRange(follow
        ? { from: prev.from + 1, to: prev.to + 1 }
        : prev);
    }
    if (typeof Draw !== 'undefined' && Draw.render) Draw.render();     // 绘图层的 Bar Count 序号需跟随数据刷新
  },

  /**
   * 回放推进: 追加一根, 按 TradingView 行为处理视窗
   * - 视窗右端已在空白区(含 rightOffset) => 新 bar 直接填入, 视窗不动
   * - 视窗右端贴着最后一根(跟随态) => 整体右移一格, 新 bar 从右侧推入
   * - 用户把视窗拖到历史区 => 视窗完全不动, 新 bar 在视窗外(不打断用户)
   */
  appendBar(bar) {
    const ts = this.chart.timeScale();
    const r = this.visibleRange();                 // {from, to}
    const newIdx = this._lastData.length;          // 新 bar 的逻辑索引
    // 新 bar 会跑出视窗右端吗? 以及视窗是否本来就贴着右端(跟随态)?
    const follow = r && r.to < newIdx && r.to >= newIdx - 3;

    this._lastData.push(bar);
    this.candle.update({ time: bar.t, open: bar.o, high: bar.h, low: bar.l, close: bar.c });
    if (this.emaEnabled && bar.ema != null) this.ema.update({ time: bar.t, value: bar.ema });
    this.setLastPrice(bar);

    // 跟随态: 用专用滚动 API 右移一格(同步 setVisibleLogicalRange 会被同一帧的渲染覆盖)
    if (follow) {
      try { ts.scrollToPosition(1, false); }
      catch (e) { ts.setVisibleLogicalRange({ from: r.from + 1, to: r.to + 1 }); }
    }
    if (typeof Draw !== 'undefined' && Draw.render) Draw.render();
  },

  /** 右侧价格轴的最新价线 (颜色跟随涨跌, 类似 TV 的彩色价格标签) */
  setLastPrice(bar) {
    if (this.priceLine) { this.candle.removePriceLine(this.priceLine); this.priceLine = null; }
    const c = this.colors();
    this.priceLine = this.candle.createPriceLine({
      price: bar.c, color: bar.c >= bar.o ? c.up : c.down, lineWidth: 1,
      lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '',
    });
  },

  /** 持仓均价线 */
  setPosLine(price) {
    if (this._posLinePrice === price) return;      // 价格没变就别反复销毁重建
    this._posLinePrice = price;
    if (this.posLine) { this.candle.removePriceLine(this.posLine); this.posLine = null; }
    if (price != null) {
      this.posLine = this.candle.createPriceLine({
        price, color: '#2962ff', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Solid, axisLabelVisible: true, title: '',
      });
    }
  },

  setMarkers(list) {
    // v5 要求 markers 按 time 升序; time 可能是 number(日内) 或 'yyyy-mm-dd'(日/周)
    const sorted = list.slice().sort((a, b) => {
      const ta = typeof a.time === 'string' ? a.time : String(a.time);
      const tb = typeof b.time === 'string' ? b.time : String(b.time);
      return ta < tb ? -1 : ta > tb ? 1 : 0;
    });
    this.markers = sorted;
    // 成交标记不再交给库画它的小三角, 由 draw.js 自己画大箭头(见 drawTradeMarkers)
    this.markersPlugin.setMarkers([]);
  },

  /** 按时间戳找 K 线 (成交标记要拿这根 K 线的高/低来定位); 二分, 数据几十万根也不慢 */
  barByTime(t) {
    const bars = this._lastData;
    if (!bars || !bars.length || t == null) return null;
    const key = bars[0].t;
    // 日/周线的 marker.time 是 'yyyy-mm-dd' 字符串, 直接线性找(标记数量很少)
    if (typeof t === 'string' || typeof key === 'string') {
      for (let i = bars.length - 1; i >= 0; i--) if (bars[i].t === t) return bars[i];
      return null;
    }
    let lo = 0, hi = bars.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (bars[mid].t === t) return bars[mid];
      if (bars[mid].t < t) lo = mid + 1; else hi = mid - 1;
    }
    return null;
  },

  /** 保存图表截图 */
  screenshot(filename) {
    try {
      const cv = this.chart.takeScreenshot();
      cv.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename || ('ES-replay-' + Date.now() + '.png');
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      });
      return true;
    } catch (e) { return false; }
  },

  onCrosshair(param) {
    if (!param || !param.time || !param.seriesData) {
      if (this._hoverT !== null) {                 // 只在真的离开过图区时才回填"当前那根"
        this._hoverT = null; this._hoverCd = null;
        if (App.onLegendIdle) App.onLegendIdle();
      }
      return;
    }
    const cd = param.seriesData.get(this.candle);
    if (!cd) return;
    // 同一条 K 线内上下移动不必重算图例(每个像素写 8 个 DOM 节点是主要的输入卡顿来源)
    if (param.time === this._hoverT) return;
    this._hoverT = param.time;
    this._hoverCd = cd;
    if (this._hoverRaf) return;                    // 本帧已排队, 到帧末取最新值
    this._hoverRaf = requestAnimationFrame(() => {
      this._hoverRaf = 0;
      if (this._hoverT == null || !this._hoverCd) return;
      if (App.onLegend) App.onLegend(this._hoverCd, this._hoverT);
    });
  },
};
