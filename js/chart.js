/* ============ chart.js — lightweight-charts v5 封装 (TradingView 风格) ============ */
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
   * 黑白配色 (价格行为学/阿尔·布鲁克斯风格):
   * 阳线 = 空心(背景色填充 + 深色边框) → 浅色主题下即"白涨"
   * 阴线 = 实心深色 → "黑跌"
   * 深色主题下镜像: 阳线空心(深底亮框), 阴线实心亮色
   */
  bw() {
    const t = this.themeColors();
    return {
      upFill: t.bg, upBorder: t.text, wick: t.text,
      downFill: t.text, downBorder: t.text,
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
          const d = new Date(time * 1000), p = n => String(n).padStart(2, '0');
          if (type === 0) return String(d.getUTCFullYear());        // 年
          if (type === 1) return `${d.getUTCMonth() + 1}月`;          // 月
          if (type === 2) return `${d.getUTCDate()}日`;              // 日
          return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;     // 时:分(ET)
        },
      },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: {
        locale: 'zh-CN',
        // 图表时间戳 = "ET 墙钟编码成的假 UTC 秒", 统一用 UTC 方法格式化 => 恒显示美东时间
        timeFormatter: (t) => {
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

    // 注: 参考截图里没有成交量副图, 用户也明确说"删了成交量, 我不需要" => 不建 HistogramSeries
    // 参考截图: EMA 是黑色细线 + 右侧价格轴黑底数值标签 (不是橙色)
    this.ema = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: t.text, lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
      crosshairMarkerVisible: false,
    }, 0);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(document.getElementById('chartWrap'));

    this.chart.subscribeCrosshairMove(param => this.onCrosshair(param));
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
  /** 显示最近 n 根, 右侧留白 (新图初始状态) */
  fitRecent(n = 180) {
    const total = this._lastData ? this._lastData.length : 0;
    if (!total) return;
    this.chart.timeScale().setVisibleLogicalRange({
      from: Math.max(0, total - n) - 0.5, to: total + 5,
    });
  },

  /** 以某根为中心显示 (切周期/时段时锚定原时间位置, 不像 fitContent 那样跳走) */
  fitAround(idx, n = 140) {
    if (!this._lastData || !this._lastData.length) return;
    const total = this._lastData.length;
    const i = Math.min(Math.max(0, idx), total - 1);
    const from = Math.max(0, i - n * 0.8);
    const to = Math.min(total + 5, i + n * 0.2 + 4);
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
    if (this.posLine) { this.candle.removePriceLine(this.posLine); this.posLine = null; }
    if (price != null) {
      this.posLine = this.candle.createPriceLine({
        price, color: '#2962ff', lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: '',
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
    this.markersPlugin.setMarkers(sorted);
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
      if (App.onLegendIdle) App.onLegendIdle();
      return;
    }
    const cd = param.seriesData.get(this.candle);
    if (App.onLegend) App.onLegend(cd, param.time);
  },
};
