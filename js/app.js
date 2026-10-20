/* ============ app.js — UI 组装与事件 ============ */
const App = {
  engine: null,
  bars: [],               // 当前会话全部K线(含未来)
  session: 'eth',
  tf: '1m',
  mode: 'random',
  targetEpoch: null,
  CONTEXT_BARS: 400,
  FORWARD_BARS: 3000,
  orderDir: 'buy',
  orderType: 'market',
  theme: 'light',
  crosshairMagnet: false,

  async boot() {
    // 主题: 默认浅色 (TradingView 默认), 记住用户选择
    this.theme = localStorage.getItem('es_replay_theme') || 'light';
    document.body.dataset.theme = this.theme;

    ChartMgr.theme = this.theme;
    ChartMgr.init();
    Draw.init();
    Trading.load();
    Trading.onChange = () => this.renderTrading();
    try {
      const meta = await DataLoader.init();
      document.getElementById('dataRangeNote').textContent =
        `${new Date(meta.range.first * 1000).toISOString().slice(0, 10)} → ` +
        `${new Date(meta.range.last * 1000).toISOString().slice(0, 10)}` +
        ` · ${meta.tradingDays.toLocaleString()} 个交易日 · 主力切换 ${meta.rolls.length} 次`;
    } catch (e) {
      document.getElementById('dataRangeNote').textContent = '数据加载失败: ' + e.message;
    }
    this.bindUI();
    this.renderTrading();
  },

  bindUI() {
    const $ = id => document.getElementById(id);

    /* 顶栏 */
    $('symbolBlock').addEventListener('click', () => {
      if (this.engine) $('gotoInput').focus();
      else $('startModal').style.display = '';
    });
    $('tfGroup').addEventListener('click', e => {
      const b = e.target.closest('button[data-tf]'); if (!b) return;
      if (this.engine) this.switchTf(b.dataset.tf);
      else { $('modalTf').value = b.dataset.tf; this.toast('请先开始复盘'); }
    });
    $('tfMore').addEventListener('change', e => {
      const tf = e.target.value;
      e.target.value = '';
      if (!tf) return;
      if (this.engine) this.switchTf(tf);
      else $('modalTf').value = tf;
    });
    $('indicatorBtn').addEventListener('click', () => {
      const on = ChartMgr.emaEnabled;
      ChartMgr.setEmaEnabled(!on);
      $('indicatorBtn').classList.toggle('active', !on);
      if (this.engine) ChartMgr.setData(this.visibleBars(), { preserve: true });
      this.syncToolUI();
      this.onLegendIdle();
      this.toast(!on ? 'EMA20 已开启' : 'EMA20 已关闭');
    });
    $('sessionSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $('sessionSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      if (this.engine) this.switchSession(b.dataset.session);
    });
    $('themeBtn').addEventListener('click', () => this.toggleTheme());

    /* 顶栏右侧 */
    $('randomBtn').addEventListener('click', () => { this.mode = 'random'; this.startSession(); });
    $('customBtn').addEventListener('click', () => { this.mode = 'custom'; this.startSession(); });
    $('exitBtn').addEventListener('click', () => this.exitApp());

    /* 左侧工具栏 + 顶部收藏工具横条 (共用一套分发, 两处 active 状态同步) */
    const onToolClick = e => {
      const b = e.target.closest('button[data-tool]'); if (!b) return;
      this.applyTool(b.dataset.tool);
    };
    $('sideToolbar').addEventListener('click', onToolClick);
    $('drawBar').addEventListener('click', onToolClick);
    this.syncToolUI();
    $('helpCloseBtn').addEventListener('click', () => { $('helpModal').style.display = 'none'; });

    /* 弹窗 */
    $('modeSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $('modeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      this.mode = b.dataset.mode;
      $('customDateRow').style.display = this.mode === 'custom' ? '' : 'none';
    });
    $('startBtn').addEventListener('click', () => this.startSession());

    /* 回放控制 */
    $('btnPlay').addEventListener('click', () => this.engine && this.engine.toggle());
    $('btnStepFwd').addEventListener('click', () => this.engine && this.engine.step(1));
    $('btnStepBack').addEventListener('click', () => this.engine && this.engine.step(-1));
    $('btnRestart').addEventListener('click', () => {
      if (!this.engine) return;
      this.engine.restart();
      ChartMgr.setData(this.visibleBars(), { fit: 'recent' });
    });
    $('btnEnd').addEventListener('click', () => { if (this.engine) this.engine.seek(this.engine.total - 1); });
    $('speedSel').addEventListener('change', () => this.engine && this.engine.setSpeed(+$('speedSel').value));
    $('gotoBtn').addEventListener('click', () => this.gotoTime());
    $('gotoInput').addEventListener('keydown', e => { if (e.key === 'Enter') this.gotoTime(); });
    $('btnCloseReplay').addEventListener('click', () => this.closeReplay());

    /* 下单 */
    $('dirSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $('dirSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      this.orderDir = b.dataset.dir;
    });
    $('typeSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $('typeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      this.orderType = b.dataset.type;
      $('limitPrice').disabled = this.orderType !== 'limit';
    });
    $('btnBuy').addEventListener('click', () => this.placeOrder('buy'));
    $('btnSell').addEventListener('click', () => this.placeOrder('sell'));
    $('btnClose').addEventListener('click', () => this.closePosition());
    $('btnResetTrades').addEventListener('click', () => { Trading.reset(); this.refreshMarkers(); });

    /* 键盘 */
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'Escape') {
        if ($('helpModal').style.display === 'flex') { $('helpModal').style.display = 'none'; return; }
        if (Draw.tool !== 'cursor') {          // 先取消绘图工具, 再退出复盘
          Draw.setTool('cursor'); this.syncToolUI();
          this.toast('已取消绘图工具'); return;
        }
        if (this.engine) { this.closeReplay(); return; }
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && Draw.selected) {
        e.preventDefault();
        if (Draw.removeSelected()) { this.toast('已删除选中的绘图'); return; }
      }
      if (!this.engine) return;
      const k = e.key.toLowerCase();
      if (k === ' ') { e.preventDefault(); this.engine.toggle(); }
      else if (e.key === 'ArrowRight') this.engine.step(1);
      else if (e.key === 'ArrowLeft') this.engine.step(-1);
      else if (k === 'r') { this.engine.restart(); ChartMgr.setData(this.visibleBars(), { fit: 'recent' }); }
      else if (k === 'b') this.placeOrder('buy');
      else if (k === 's') this.placeOrder('sell');
      else if (k === 'c') this.closePosition();
    });
  },

  toast(msg, warn) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.toggle('warn', !!warn);
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  },

  loading(on, text) {
    document.getElementById('loadingMask').style.display = on ? 'flex' : 'none';
    if (text) document.getElementById('loadingText').textContent = text;
  },

  /* ---------- 工具栏分发 (左侧工具栏 + 顶部收藏横条共用) ---------- */
  DRAW_TOOLS: ['cursor', 'trend', 'hline', 'vline', 'rect', 'fib', 'text', 'measure'],
  TOOL_NAME: {
    cursor: '光标', trend: '趋势线', hline: '水平线', vline: '垂直线',
    rect: '矩形', fib: '斐波那契回撤', text: '文字', measure: '测量尺',
  },

  applyTool(tool) {
    if (this.DRAW_TOOLS.includes(tool)) {
      if (tool !== 'cursor' && !this.engine) { this.toast('请先开始复盘再使用绘图工具', true); return; }
      Draw.setTool(tool);
      if (tool !== 'cursor') {
        this.toast(`${this.TOOL_NAME[tool]}: 在图上按住左键拖动 (Esc 取消) · 画完自动回到光标`);
      }
      this.syncToolUI();
      return;
    }
    if (tool === 'magnet') {
      const on = Draw.toggleMagnet();
      this.toast(on ? '磁吸: 开 (吸附到开高低收)' : '磁吸: 关');
      this.syncToolUI(); return;
    }
    if (tool === 'hide') {
      const on = Draw.toggleHide();
      this.toast(on ? '已隐藏所有绘图' : '已显示所有绘图');
      this.syncToolUI(); return;
    }
    if (tool === 'barcount') {
      const on = Draw.toggleBarCount();
      this.toast(on ? 'Bar Count 序号: 开' : 'Bar Count 序号: 关');
      this.syncToolUI(); return;
    }
    if (tool === 'trash') {
      const n = Draw.removeAll();
      this.toast(n ? `已删除 ${n} 个绘图` : '当前没有绘图');
      this.syncToolUI(); return;
    }
    if (tool === 'fit') { ChartMgr.fitRecent(); this.toast('已重置缩放: 显示最近 180 根'); return; }
    if (tool === 'fitall') { ChartMgr.fitAll(); this.toast('显示全部已播放 K 线'); return; }
    if (tool === 'shot') {
      const ok = ChartMgr.screenshot();
      this.toast(ok ? '截图已保存到下载目录' : '截图失败', !ok); return;
    }
    if (tool === 'clean') {
      Trading.reset(); this.refreshMarkers();
      this.toast('已清除交易记录与标记'); return;
    }
    if (tool === 'help') document.getElementById('helpModal').style.display = 'flex';
  },

  /** 两处工具栏的 active 状态 / 图例指标行 统一同步 */
  syncToolUI() {
    document.querySelectorAll('#sideToolbar button[data-tool], #drawBar button[data-tool]')
      .forEach(b => {
        const t = b.dataset.tool;
        let on = false;
        if (t === 'magnet') on = !!Draw.magnet;
        else if (t === 'hide') on = !!Draw.hidden;
        else if (t === 'barcount') on = !!Draw.showBarCount;
        else if (this.DRAW_TOOLS.includes(t)) on = (Draw.tool === t);
        b.classList.toggle('active', on);
      });
    const emaRow = document.getElementById('lgEmaRow');
    if (emaRow) emaRow.classList.toggle('hidden-row', !ChartMgr.emaEnabled);
    const barRow = document.getElementById('lgBarRow');
    if (barRow) barRow.classList.toggle('hidden-row', !Draw.showBarCount);
  },

  /** 图例两个指标行: EMA 值 / 当前 Bar 序号 */
  fillIndicators(bar, barIdx) {
    const $ = id => document.getElementById(id);
    const ema = $('lgEma'), bi = $('lgBarIdx');
    if (ema) ema.textContent = (ChartMgr.emaEnabled && bar && bar.ema != null)
      ? bar.ema.toFixed(2) : '–';
    if (bi) bi.textContent = (barIdx > 0) ? String(barIdx) : '–';
  },

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    document.body.dataset.theme = this.theme;
    localStorage.setItem('es_replay_theme', this.theme);
    ChartMgr.applyTheme(this.theme);
    this.toast(this.theme === 'dark' ? '深色主题' : '浅色主题');
  },

  toggleCrosshair(btn) {
    this.crosshairMagnet = !this.crosshairMagnet;
    ChartMgr.chart.applyOptions({
      crosshair: { mode: this.crosshairMagnet
        ? LightweightCharts.CrosshairMode.Magnet
        : LightweightCharts.CrosshairMode.Normal },
    });
    btn.classList.toggle('active', this.crosshairMagnet);
    this.toast(this.crosshairMagnet ? '十字光标: 磁吸模式' : '十字光标: 普通模式');
  },

  async exitApp() {
    let stopped = false;
    try {
      const r = await fetch('/__shutdown', { method: 'POST' });
      stopped = r.ok;
    } catch (e) { /* file:// 直开或无服务器时不可用 */ }
    this.toast(stopped ? '服务器已停止, 可以关闭此页面' : '未连接本地服务器(直接双击打开时无法停止服务)', !stopped);
    if (stopped) setTimeout(() => { try { window.close(); } catch (e) {} }, 1200);
  },

  /* ---------- 会话生命周期 ---------- */
  async startSession() {
    const meta = DataLoader.meta;
    if (!meta) { this.toast('数据索引未加载完成, 请稍候', true); return; }
    const from = meta.usableFrom ? Math.floor(new Date(meta.usableFrom + 'T00:00:00Z').getTime() / 1000) : meta.range.first;
    const last = meta.range.last - 86400 * 2;
    if (this.mode === 'random') {
      this.targetEpoch = from + Math.random() * (last - from);
    } else {
      const d = document.getElementById('startDate').value;
      const t = document.getElementById('startTime').value || '09:35';
      if (!d) { this.toast('请选择开始日期', true); return; }
      const [y, mo, dd] = d.split('-').map(Number);
      const [hh, mi] = t.split(':').map(Number);
      if (!y || !mo || !dd || Number.isNaN(hh) || Number.isNaN(mi)) {
        this.toast('日期或时间格式不正确', true); return;
      }
      this.targetEpoch = etWallToEpoch(y, mo, dd, hh, mi);
      if (this.targetEpoch < meta.range.first || this.targetEpoch > meta.range.last) {
        this.toast('所选日期超出数据范围', true); return;
      }
    }
    this.session = document.getElementById('modalSession').value;
    this.tf = document.getElementById('modalTf').value;
    this.syncTfUI();
    // 新会话: 重置交易状态(持仓/流水/标记)
    Trading.reset();
    ChartMgr.setMarkers([]);
    await this.loadAndBuild(true);
  },

  syncTfUI() {
    document.querySelectorAll('#tfGroup button[data-tf]').forEach(b =>
      b.classList.toggle('active', b.dataset.tf === this.tf));
    document.getElementById('lgTf').textContent = this.tf;
    document.getElementById('symMeta').textContent = `· ${this.tf} · CME`;
    document.getElementById('modalTf').value = this.tf;
  },

  async loadAndBuild(fresh) {
    this.loading(true, '加载数据…');
    try {
      const w = await DataLoader.loadWindow(this.session, this.tf, this.targetEpoch,
                                            this.CONTEXT_BARS, this.FORWARD_BARS);
      if (!w || w.data.count === 0) {
        this.toast('该时段无数据, 请换一个', true); this.loading(false);
        if (fresh) document.getElementById('startModal').style.display = '';
        return;
      }
      const d = w.data;
      const n = w.indices.length;
      const isDay = (this.tf === '1d' || this.tf === '1w');
      const bars = new Array(n);
      const k = 2 / 21;                     // EMA20 因果计算
      let prev = null;
      for (let i = 0; i < n; i++) {
        const j = w.indices[i];
        const ep = d.time[j], off = d.off[j];
        const c = d.close[j];
        if (prev === null) prev = c;
        else prev = c * k + prev * (1 - k);
        bars[i] = {
          t: isDay ? etDateStr(ep, off) : chartTime(ep, off),
          o: d.open[j], h: d.high[j], l: d.low[j], c, v: d.volume[j],
          ema: prev, epoch: ep, off,
        };
      }
      this.bars = bars;
      // 换周期/换时段/新会话: 时间轴刻度变了, 旧绘图的锚点会失效 => 清空（避免画出错位的线）
      const hadDraw = Draw.count();
      Draw.clearAll();
      this._drawCleared = hadDraw > 0 && !fresh;
      ChartMgr.setTf(this.tf);
      // 新会话: 显示最近 180 根; 切周期/时段: 锚定在原来的那根 K 线上
      ChartMgr.setData(bars.slice(0, w.startIdx + 1), { fit: fresh ? 'recent' : false });
      if (!fresh) ChartMgr.fitAround(Math.max(0, w.startIdx), 140);
      if (this.engine) this.engine.destroy();
      this.engine = new ReplayEngine(bars, Math.max(0, w.startIdx));
      this.engine.markStart(Math.max(0, w.startIdx));
      this.engine.speed = +document.getElementById('speedSel').value;
      this.engine.onTick = (bar, idx, isNew) => {
        // 新 bar 追加; 后退/跳转用 setData, 严格保持用户视窗(followLast 仅在贴右端时滚动)
        if (isNew) ChartMgr.appendBar(bar);
        else ChartMgr.setData(this.visibleBars(), { preserve: true, followLast: true });
        Trading._pendingLimits && this.checkLimits(bar);
        this.renderReplayBar();
        this.renderTrading();
        this.refreshMarkers();
      };
      this.engine.onState = () => {
        document.getElementById('replayBar').classList.toggle('playing', this.engine.playing);
        this.renderReplayBar();
      };
      this.engine.onEnd = () => this.toast('已到数据末尾 · 可按 R 重新开始或换一段');
      document.getElementById('startModal').style.display = 'none';
      document.getElementById('replayBar').classList.remove('hidden');
      this.syncTfUI();
      this.syncToolUI();
      this.renderReplayBar();
      this.renderTrading();
      this.refreshMarkers();
      const cur = this.engine.current;
      const s = document.getElementById('gotoInput');
      if (s && !s.value) s.value = etTimeStr(cur.epoch, cur.off).replace(' ET', '').slice(0, 16);
      this.toast(`开始复盘: ${etTimeStr(cur.epoch, cur.off)} (${TF_LABEL[this.tf]} / ${this.session.toUpperCase()})` +
                 (this._drawCleared ? ' · 周期已切换, 绘图已清空' : ''));
    } catch (e) {
      console.error(e);
      this.toast('加载失败: ' + e.message, true);
    }
    this.loading(false);
  },

  visibleBars() { return this.engine ? this.bars.slice(0, this.engine.idx + 1) : []; },

  async switchTf(tf) {
    if (tf === this.tf) return;
    const cur = this.engine && this.engine.current;
    this.tf = tf;
    this.targetEpoch = cur ? cur.epoch : this.targetEpoch;
    this.syncTfUI();
    await this.loadAndBuild(false);
  },

  async switchSession(session) {
    if (session === this.session) return;
    const cur = this.engine && this.engine.current;
    this.session = session;
    this.targetEpoch = cur ? cur.epoch : this.targetEpoch;
    ChartMgr.setMarkers([]);
    await this.loadAndBuild(false);
  },

  /** 结束本次复盘, 回到开始弹窗 */
  closeReplay() {
    if (!this.engine) return;
    this.engine.destroy();
    this.engine = null;
    this.bars = [];
    Draw.clearAll();
    ChartMgr.setData([]);
    ChartMgr.setMarkers([]);
    document.getElementById('replayBar').classList.add('hidden');
    document.getElementById('startModal').style.display = 'flex';
    this.toast('已结束复盘');
  },

  /** TradingView 的 Go to: 跳到指定美东时间 */
  async gotoTime() {
    const raw = document.getElementById('gotoInput').value.trim();
    const m = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})$/);
    if (!m) { this.toast('格式: 2024-03-15 09:35 (美东时间)', true); return; }
    const ep = etWallToEpoch(+m[1], +m[2], +m[3], +m[4], +m[5]);
    if (!this.bars.length) { this.targetEpoch = ep; this.loadAndBuild(true); return; }
    // 在已加载窗口内找最近的一根; 超出窗口则按新起点重新加载(属于新会话, 重置交易)
    const first = this.bars[0].epoch, last = this.bars[this.bars.length - 1].epoch;
    if (ep < first - 60 || ep > last + 60) {
      this.targetEpoch = ep;
      Trading.reset();
      ChartMgr.setMarkers([]);
      await this.loadAndBuild(false);
      this.toast('已跳转到 ' + raw + ' (新会话, 交易记录已重置)');
      return;
    }
    let best = 0, bd = Infinity;
    for (let i = 0; i < this.bars.length; i++) {
      const dd = Math.abs(this.bars[i].epoch - ep);
      if (dd < bd) { bd = dd; best = i; }
    }
    this.engine.seek(best);
    this.toast('已跳转到 ' + etTimeStr(this.bars[best].epoch, this.bars[best].off));
  },

  /* ---------- 渲染 ---------- */
  renderReplayBar() {
    if (!this.engine) return;
    const e = this.engine;
    const cur = e.current;
    document.getElementById('replayTime').textContent = etTimeStr(cur.epoch, cur.off);
    document.getElementById('barCount').textContent = `${e.played} / ${e.total}`;
    document.getElementById('rbProgressFill').style.width =
      (e.played / Math.max(1, e.total) * 100).toFixed(1) + '%';
    document.getElementById('replayBar').classList.toggle('playing', e.playing);
    this.onLegendIdle();
  },

  renderTrading() {
    const cur = this.engine ? this.engine.current : null;
    const price = cur ? cur.c : 0;
    const $ = id => document.getElementById(id);
    $('stPos').textContent = Trading.pos === 0 ? '0 手' : `${Math.abs(Trading.pos)} 手${Trading.pos > 0 ? '多' : '空'}`;
    $('stAvg').textContent = Trading.pos === 0 ? '-' : Trading.avg.toFixed(2);
    const fp = Trading.floatPnl(price);
    $('stFloat').textContent = Trading.pos === 0 ? '-' : (fp >= 0 ? '+' : '') + fp.toFixed(0) + ' $';
    $('stFloat').className = 'stat-v ' + (fp > 0 ? 'up' : fp < 0 ? 'down' : '');
    $('stReal').textContent = (Trading.realized >= 0 ? '+' : '') + Trading.realized.toFixed(0) + ' $';
    $('stReal').className = 'stat-v ' + (Trading.realized > 0 ? 'up' : Trading.realized < 0 ? 'down' : '');
    const tp = Trading.totalPnl(price);
    $('stTotal').textContent = (tp >= 0 ? '+' : '') + tp.toFixed(0) + ' $';
    $('stTotal').className = 'stat-v ' + (tp > 0 ? 'up' : tp < 0 ? 'down' : '');
    const st = Trading.stats();
    $('stWin').textContent = `${st.n} 笔 / ${st.winRate}`;
    ChartMgr.setPosLine(Trading.pos === 0 ? null : Trading.avg);
    // 交易记录
    const list = $('tradeList');
    $('tradeCount').textContent = `(${Trading.trades.length})`;
    if (!Trading.trades.length) {
      list.innerHTML = '<div class="trade-empty">暂无交易记录</div>';
    } else {
      list.innerHTML = Trading.trades.slice().reverse().map(t => `
        <div class="trade-item">
          <span class="t-time">${t.time.slice(5, 16)}</span>
          <span class="t-side ${t.side}">${t.side === 'buy' ? '买' : '卖'}${t.qty}手</span>
          <span>@${t.price.toFixed(2)}</span>
          <span class="t-pnl ${t.pnl == null ? '' : t.pnl >= 0 ? 'up' : 'down'}">${t.pnl == null ? '' : (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(0) + '$'}</span>
        </div>`).join('');
    }
  },

  refreshMarkers() {
    if (!this.engine) return;
    if (!Trading.trades.length && ChartMgr.markers.length) ChartMgr.setMarkers([]);
  },

  /* ---------- 下单 ---------- */
  placeOrder(side) {
    if (!this.engine) { this.toast('请先开始复盘', true); return; }
    const cur = this.engine.current;
    const qty = Math.max(1, +document.getElementById('orderQty').value || 1);
    if (this.orderType === 'market') {
      Trading.fill(side, qty, cur.c, 'market', cur.epoch, cur.off);
      this.toast(`${side === 'buy' ? '买入' : '卖出'} ${qty} 手 @ ${cur.c.toFixed(2)}`);
      this.renderTrading();
      this.addMarker(side, cur.c);
    } else {
      const lp = +document.getElementById('limitPrice').value;
      if (!lp || lp <= 0) { this.toast('请输入有效限价', true); return; }
      if (!this._limits) this._limits = [];
      this._limits.push({ side, price: lp, qty });
      Trading._pendingLimits = true;
      this.toast(`限价${side === 'buy' ? '买入' : '卖出'} ${qty} 手 @ ${lp.toFixed(2)} 已挂单, 等待成交`);
    }
  },

  addMarker(side, price) {
    const cur = this.engine.current;
    const isDay = (this.tf === '1d' || this.tf === '1w');
    const t = isDay ? etDateStr(cur.epoch, cur.off) : chartTime(cur.epoch, cur.off);
    const m = ChartMgr.markers.slice();
    const c = ChartMgr.colors();
    m.push({
      time: t,
      position: side === 'buy' ? 'belowBar' : 'aboveBar',
      color: side === 'buy' ? c.up : c.down,
      shape: side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: side === 'buy' ? '买' : '卖',
    });
    ChartMgr.setMarkers(m);   // setMarkers 内部按 time 升序排
  },

  checkLimits(bar) {
    if (!this._limits || !this._limits.length) { Trading._pendingLimits = false; return; }
    const remain = [];
    for (const o of this._limits) {
      let filled = false;
      if (o.side === 'buy' && bar.l <= o.price) filled = true;
      if (o.side === 'sell' && bar.h >= o.price) filled = true;
      if (filled) {
        Trading.fill(o.side, o.qty, o.price, 'limit', bar.epoch, bar.off);
        this.toast(`限价成交: ${o.side === 'buy' ? '买入' : '卖出'} ${o.qty} 手 @ ${o.price.toFixed(2)}`);
        this.addMarker(o.side, o.price);
      } else remain.push(o);
    }
    this._limits = remain;
    if (!remain.length) Trading._pendingLimits = false;
    this.renderTrading();
  },

  closePosition() {
    if (!this.engine) return;
    if (Trading.pos === 0) { this.toast('当前无持仓'); return; }
    const cur = this.engine.current;
    const qty = Math.abs(Trading.pos);
    const r = Trading.fill(Trading.pos > 0 ? 'sell' : 'buy', qty, cur.c, 'market', cur.epoch, cur.off);
    this.toast(`平仓 ${qty} 手 @ ${cur.c.toFixed(2)} · 盈亏 ${(r.pnl >= 0 ? '+' : '') + r.pnl.toFixed(0)}$`);
    this.addMarker(Trading.pos > 0 ? 'sell' : 'buy', cur.c);
    this.renderTrading();
  },

  /* ---------- 图例 (TradingView: O/H/L/C + 涨跌 + 量) ---------- */
  setLegend(cd, vd) {
    const $ = id => document.getElementById(id);
    const up = cd.close >= cd.open;
    $('lgO').textContent = cd.open.toFixed(2);
    $('lgH').textContent = cd.high.toFixed(2);
    $('lgL').textContent = cd.low.toFixed(2);
    $('lgC').textContent = cd.close.toFixed(2);
    const chg = cd.close - cd.open;
    $('lgChg').textContent = `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${((cd.close / cd.open - 1) * 100).toFixed(2)}%)`;
    $('lgChg').style.color = up ? 'var(--up)' : 'var(--down)';
    $('lgVol').innerHTML = vd ? `<b>Vol</b> ${vd.value.toLocaleString()}` : '';
  },

  onLegend(cd, vd, time) {
    if (!cd) { this.onLegendIdle(); return; }
    this.setLegend(cd, vd);
    const $ = id => document.getElementById(id);
    // 指标行: 悬停那根的值 + 它的 Bar 序号
    const arr = ChartMgr._lastData || [];
    let idx = -1;
    for (let i = arr.length - 1; i >= 0; i--) { if (arr[i].t === time) { idx = i; break; } }
    const bar = idx >= 0 ? arr[idx] : arr[arr.length - 1];
    this.fillIndicators(bar, idx >= 0 ? idx + 1 : arr.length);
    if (Trading.pos !== 0) {
      $('lgPos').textContent = `持仓 ${Math.abs(Trading.pos)} 手${Trading.pos > 0 ? '多' : '空'} @ ${Trading.avg.toFixed(2)}`;
    } else $('lgPos').textContent = '';
  },

  onLegendIdle() {
    const $ = id => document.getElementById(id);
    if (!this.engine) return;
    const idx = this.engine.idx;
    const b = this.bars[idx];
    if (!b) return;
    this.setLegend({ open: b.o, high: b.h, low: b.l, close: b.c }, { value: b.v });
    this.fillIndicators(b, idx + 1);
    if (Trading.pos !== 0) {
      $('lgPos').textContent = `持仓 ${Math.abs(Trading.pos)} 手${Trading.pos > 0 ? '多' : '空'} @ ${Trading.avg.toFixed(2)}`;
    } else $('lgPos').textContent = '';
  },
};

document.addEventListener('DOMContentLoaded', () => App.boot());
