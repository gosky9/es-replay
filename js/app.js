/* ============ app.js — UI 组装与事件 ============ */
const App = {
  engine: null,
  bars: [],               // 当前会话全部K线(含未来)
  session: 'rth',
  tf: '5m',
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
    this.startClock();
    // 提示气泡要贴着鼠标走, 记一下最后位置
    window.addEventListener('mousemove', e => { this._mx = e.clientX; this._my = e.clientY; }, { passive: true });
  },

  /** 右下角状态条: 本地时间 + 时区 + 时段 + 复权标记 (照截图 22:29:01 UTC+8 RTH B-ADJ) */
  startClock() {
    const p = n => String(n).padStart(2, '0');
    const tz = -new Date().getTimezoneOffset() / 60;
    const tzTxt = 'UTC' + (tz >= 0 ? '+' : '') + tz;
    const el = id => document.getElementById(id);
    if (el('statusTz')) el('statusTz').textContent = tzTxt;
    const tick = () => {
      const d = new Date();
      if (el('statusClock')) el('statusClock').textContent =
        `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
      if (el('statusSession')) el('statusSession').textContent = this.session === 'rth' ? 'RTH' : 'ETH';
    };
    tick();
    setInterval(tick, 1000);
  },

  bindUI() {
    const $ = id => document.getElementById(id);

    /* 顶栏 */
    $('symbolBlock').addEventListener('click', () => this.openCustomPicker());
    $('tfGroup').addEventListener('click', e => {
      const b = e.target.closest('button[data-tf]'); if (!b) return;
      if (this.engine) this.switchTf(b.dataset.tf);
      else { $('modalTf').value = b.dataset.tf; this.toast('请先开始复盘'); }
    });
    $('tfMoreBtn').addEventListener('click', e => this.notDone('更多周期', e.currentTarget));
    $('indicatorBtn').addEventListener('click', e => {
      e.stopPropagation();
      const m = $('indMenu');
      if (m.classList.contains('open')) { m.classList.remove('open'); return; }
      const r = $('indicatorBtn').getBoundingClientRect();
      m.style.left = Math.round(r.left) + 'px';
      m.style.top = Math.round(r.bottom + 4) + 'px';
      m.classList.add('open');
    });
    $('indMenu').addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => $('indMenu').classList.remove('open'));
    $('indEma').addEventListener('change', e => {
      ChartMgr.setEmaEnabled(e.target.checked);
      if (this.engine) ChartMgr.setData(this.visibleBars(), { preserve: true });
      this.syncToolUI(); this.onLegendIdle();
    });
    $('indBarCount').addEventListener('change', e => {
      Draw.showBarCount = e.target.checked;
      ChartMgr.refreshBarCount();      // Bar Count 是 series 图元, 请求重画即可
      this.syncToolUI();
    });
    $('gridBtn').addEventListener('click', () => {
      this.gridOn = !this.gridOn;
      ChartMgr.setGrid(this.gridOn);
      $('gridBtn').classList.toggle('on', this.gridOn);
      this.toast(this.gridOn ? '网格线: 开' : '网格线: 关');
    });
    $('replayPillBtn').addEventListener('click', () => this.startReplay());
    $('undoBtn').addEventListener('click', () => this.undoDraw());
    $('redoBtn').addEventListener('click', () => this.redoDraw());
    $('fullBtn').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen().catch(() => this.toast('全屏不可用', true));
    });
    $('shotBtn').addEventListener('click', () => {
      const ok = ChartMgr.screenshot();
      this.toast(ok ? '截图已保存到下载目录' : '截图失败', !ok);
    });
    /* 截图有、但本工具没有对应能力 => 明确提示未实现 */
    ['chartTypeBtn', 'symAddBtn', 'alertBtn', 'layoutBtn', 'compareBtn', 'cmpSymBtn',
     'intervalBtn', 'clockBtn', 'settingsBtn', 'langBtn', 'tradeBtn']
      .forEach(id => { const el = $(id); if (el) el.addEventListener('click', () => this.notDone(el.title || '该功能', el)); });
    $('sessionSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      $('sessionSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      if (this.engine) this.switchSession(b.dataset.session);
    });
    $('themeBtn').addEventListener('click', () => this.toggleTheme());
    $('exitBtn').addEventListener('click', () => this.exitApp());

    /* 图例上的按钮 (照参考截图: 卖出 / 买入 / 回放 / EMA 开关) */
    $('lgSellBtn').addEventListener('click', () => this.placeOrder('sell'));
    $('lgBuyBtn').addEventListener('click', () => this.placeOrder('buy'));
    $('lgReplayBtn').addEventListener('click', () => this.startReplay());
    const smx = $('startModalClose');
    if (smx) smx.addEventListener('click', () => this.closeStartModal());
    $('lgEmaBtn').addEventListener('click', () => {
      ChartMgr.setEmaEnabled(!ChartMgr.emaEnabled);
      if (ChartMgr._lastData) ChartMgr.setData(ChartMgr._lastData, { preserve: true });
      this.fillIndicators(this.engine ? this.bars[this.engine.idx] : null);
      this.syncToolUI();
    });

    /* 左侧工具栏 + 顶部收藏工具横条 (共用一套分发, 两处 active 状态同步) */
    const onToolClick = e => {
      const b = e.target.closest('button[data-tool]'); if (!b) return;
      this.applyTool(b.dataset.tool, b);
    };
    $('sideToolbar').addEventListener('click', onToolClick);
    $('drawBar').addEventListener('click', onToolClick);
    this.syncToolUI();
    this.bindToolTips();
    this.bindDrawBarDrag();

    /* 右键菜单: 突破单 / 平仓 / 撤销 */
    $('chartArea').addEventListener('contextmenu', e => this.openContextMenu(e));
    $('ctxMenu').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      this.onContextAction(b.dataset.act);
    });
    document.addEventListener('mousedown', e => {
      const m = $('ctxMenu');
      if (m.style.display === 'block' && !m.contains(e.target)) m.style.display = 'none';
    }, true);
    window.addEventListener('blur', () => { $('ctxMenu').style.display = 'none'; });
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
    $('rbPickBtn').addEventListener('click', () => this.startReplay());
    $('rbTfSel').addEventListener('change', e => {
      const tf = e.target.value;
      if (this.engine) this.switchTf(tf);
      else { this.tf = tf; this.syncTfUI(); }
    });

    /* 底部: 区间按钮 + 回放交易 */
    $('rangeGroup').addEventListener('click', e => {
      const b = e.target.closest('button[data-range]'); if (!b) return;
      $('rangeGroup').querySelectorAll('button[data-range]').forEach(x => x.classList.toggle('active', x === b));
      this.applyRange(b.dataset.range);
    });
    $('replayTradeBtn').addEventListener('click', () => {
      const bar = $('replayBar');
      if (!this.engine) { this.startReplay(); return; }
      bar.classList.toggle('hidden');
    });

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
    $('btnResetTrades').addEventListener('click', () => { Trading.reset(); ChartMgr.setPosLine(null); this.renderTrading(); this.refreshMarkers(); });

    /* 键盘 */
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      if (e.key === 'Escape') {
        if ($('ctxMenu').style.display === 'block') { $('ctxMenu').style.display = 'none'; return; }
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
      else if (e.key === 'ArrowUp') { e.preventDefault(); this.stopOrderAtBarEdge('buy'); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.stopOrderAtBarEdge('sell'); }
      else if (k === 'r') { this.engine.restart(); ChartMgr.setData(this.visibleBars(), { fit: 'recent' }); }
      else if (k === 'b') this.placeOrder('buy');
      else if (k === 's') this.placeOrder('sell');
      else if (k === 'c') this.closePosition();
    });
  },

  /** 提示气泡: 就近显示 —— 传了按钮就贴着按钮, 否则跟着鼠标走 (不再固定在左下角) */
  /* ---------- 工具按钮的深色悬浮提示 (照 reference/07 截图) ---------- */
  bindToolTips() {
    const tip = document.getElementById('tip');
    if (!tip) return;
    // 原生 title 换成自绘提示, 免得两套提示叠在一起
    document.querySelectorAll('#sideToolbar [title], #drawBar [title]').forEach(el => {
      el.dataset.tip = el.getAttribute('title');
      el.removeAttribute('title');
    });
    const hide = () => { tip.style.opacity = '0'; };
    document.addEventListener('mouseover', e => {
      const el = e.target.closest('#sideToolbar [data-tip], #drawBar [data-tip]');
      if (!el) { hide(); return; }
      tip.textContent = el.dataset.tip;
      tip.classList.add('show');
      const r = el.getBoundingClientRect();
      const side = el.closest('#sideToolbar') ? 'right' : 'top';
      tip.classList.toggle('right', side === 'right');
      tip.classList.toggle('top', side === 'top');
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let L, T;
      if (side === 'right') { L = r.right + 9; T = r.top + r.height / 2 - th / 2; }
      else { L = r.left + r.width / 2 - tw / 2; T = r.top - th - 8; }
      L = Math.max(4, Math.min(L, window.innerWidth - tw - 4));
      T = Math.max(4, T);
      tip.style.left = Math.round(L) + 'px';
      tip.style.top = Math.round(T) + 'px';
    });
    document.addEventListener('mouseout', e => {
      if (e.target.closest && e.target.closest('#sideToolbar [data-tip], #drawBar [data-tip]')) hide();
    });
  },

  /* ---------- 收藏工具条: 可拖动移动 (照 reference/07、08) ---------- */
  bindDrawBarDrag() {
    const bar = document.getElementById('drawBar');
    const grip = bar && bar.querySelector('.db-grip');
    if (!bar || !grip) return;
    // 平移量用 transform 表达: 收藏条本身绝对定位在右上角, 不再随图例文字宽度变化而挪动
    let dx = 0, dy = 0;
    const apply = () => { bar.style.transform = `translate(${dx}px, ${dy}px)`; };
    try {
      const p = JSON.parse(localStorage.getItem('es_replay_drawbar') || 'null');
      if (p && typeof p.dx === 'number') { dx = p.dx; dy = p.dy || 0; apply(); }
    } catch (e) { /* 本地记录损坏时忽略 */ }

    grip.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const dx0 = dx, dy0 = dy;
      const sx = e.clientX, sy = e.clientY;
      bar.classList.add('dragging');
      const move = ev => {
        dx = Math.round(dx0 + ev.clientX - sx);
        dy = Math.round(dy0 + ev.clientY - sy);
        apply();
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        bar.classList.remove('dragging');
        try {
          localStorage.setItem('es_replay_drawbar', JSON.stringify({ dx, dy }));
        } catch (err) { /* 隐私模式下忽略 */ }
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  },

  toast(msg, warn, anchor) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.toggle('warn', !!warn);
    // 先归零再量尺寸, 避免上一帧的定位影响本次居中
    t.style.left = '-9999px'; t.style.top = '0px';
    t.classList.add('show');
    let x = null, y = null;
    if (anchor && typeof anchor.getBoundingClientRect === 'function') {
      const r = anchor.getBoundingClientRect();
      x = r.left + r.width / 2; y = r.bottom + 10;
    } else if (anchor && typeof anchor.x === 'number') {
      x = anchor.x; y = anchor.y + 16;
    } else if (this._mx != null) {
      x = this._mx; y = this._my + 18;
    }
    if (x == null) { x = window.innerWidth / 2; y = window.innerHeight - 120; }
    const w = t.offsetWidth, h = t.offsetHeight;
    let L = x - w / 2;
    let T = y;
    L = Math.max(8, Math.min(L, window.innerWidth - w - 8));
    if (T + h > window.innerHeight - 8) T = y - h - 36;    // 下方放不下就翻上去
    T = Math.max(8, T);
    t.style.left = Math.round(L) + 'px';
    t.style.top = Math.round(T) + 'px';
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  },

  loading(on, text) {
    document.getElementById('loadingMask').style.display = on ? 'flex' : 'none';
    if (text) document.getElementById('loadingText').textContent = text;
  },

  /* ---------- 工具栏分发 (左侧工具栏 + 顶部收藏条共用) ---------- */
  DRAW_TOOLS: ['cursor', 'trend', 'hline', 'rect', 'fib', 'fibext', 'arrowup', 'arrowdown', 'text', 'measure'],
  /** 截图里有、但本工具还没实现的工具 —— 点击只提示, 不做任何事 */
  TODO_TOOLS: {
    hmlines: '多水平线', gannfan: '江恩扇形', gannbox: '江恩箱', brush: '画笔',
    emoji: '表情', lockdraw: '锁定绘图', lock: '锁定所有绘图', link: '复制样式',
  },
  TOOL_NAME: {
    cursor: '光标', trend: '趋势线', hline: '水平线', rect: '矩形',
    fib: '斐波那契', fibext: '斐波那契扩展', text: '文字', measure: '尺子',
    arrowup: '向上箭头', arrowdown: '向下箭头',
  },

  /** 明确告知"该功能还没做", 不伪造行为; 提示贴在所点的按钮旁边 */
  notDone(name, el) {
    this.toast(`${name}还没做`, true, el || null);
  },

  applyTool(tool, el) {
    if (this.TODO_TOOLS[tool]) { this.notDone(this.TODO_TOOLS[tool], el); return; }
    if (this.DRAW_TOOLS.includes(tool)) {
      if (tool !== 'cursor' && !this.engine) { this.toast('请先开始复盘再使用绘图工具', true); return; }
      Draw.setTool(tool);
      if (tool !== 'cursor') {
        if (tool === 'fibext') {
          this.toast(`${this.TOOL_NAME[tool]}: 点 A → 点 B → 点 C (三个点) · 画完自动回到光标`);
        } else if (tool === 'arrowup' || tool === 'arrowdown') {
          this.toast(`${this.TOOL_NAME[tool]}: 点一下落在光标处 (Esc 取消) · 放完自动回到光标`);
        } else {
          this.toast(`${this.TOOL_NAME[tool]}: 点第一点 → 移动 → 点第二点 (Esc 取消) · 画完自动回到光标`);
        }
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
    if (tool === 'zoomin') {
      const r = ChartMgr.visibleRange();
      if (!r) return;
      const mid = (r.from + r.to) / 2, half = Math.max(6, (r.to - r.from) / 4);
      ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: mid - half, to: mid + half });
      return;
    }
    if (tool === 'trash') {
      const n = Draw.removeAll();
      this.toast(n ? `已删除 ${n} 个绘图` : '当前没有绘图');
      this.syncToolUI(); return;
    }
  },

  /* ---------- 绘图撤销 / 重做 ---------- */
  undoDraw() {
    if (!Draw.undo || !Draw.undo.length) { this.toast('没有可撤销的操作'); return; }
    Draw.redo.push(Draw.snapshot());
    Draw.items = Draw.undo.pop();
    Draw.selected = null; Draw.render(); this.syncToolUI();
    this.toast('已撤销');
  },

  redoDraw() {
    if (!Draw.redo || !Draw.redo.length) { this.toast('没有可重做的操作'); return; }
    Draw.undo.push(Draw.snapshot());
    Draw.items = Draw.redo.pop();
    Draw.selected = null; Draw.render(); this.syncToolUI();
    this.toast('已重做');
  },

  /* ---------- 底部区间按钮: 缩放到对应时间跨度 ---------- */
  applyRange(key) {
    const bars = this.bars;
    if (!bars || !bars.length || !this.engine) { this.toast('请先开始复盘', true); return; }
    const total = this.engine.idx + 1;                  // 已播放到第几根(下标)
    if (key === 'all') { ChartMgr.fitAll(); return; }
    const last = bars[total - 1];
    let fromEpoch = null;
    const DAY = 86400;
    if (key === '1d') fromEpoch = last.epoch - DAY;
    else if (key === '5d') fromEpoch = last.epoch - 5 * DAY;
    else if (key === '1M') fromEpoch = last.epoch - 30 * DAY;
    else if (key === '3M') fromEpoch = last.epoch - 91 * DAY;
    else if (key === '6M') fromEpoch = last.epoch - 182 * DAY;
    else if (key === '1y') fromEpoch = last.epoch - 365 * DAY;
    else if (key === '5y') fromEpoch = last.epoch - 365 * 5 * DAY;
    else if (key === 'ytd') {
      const p = etParts(last.epoch, last.off);
      fromEpoch = etWallToEpoch(p.y, 1, 1, 0, 0);
    }
    if (fromEpoch == null) return;
    let i = 0;
    for (let k = total - 1; k >= 0; k--) { if (bars[k].epoch >= fromEpoch) i = k; else break; }
    ChartMgr.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, i - 0.5), to: total + 5 });
  },

  /* ---------- 打开「选择随机K线」弹窗 (顶栏回放胶囊 / 图例◀◀ / 底部回放交易 共用) ---------- */
  startReplay() {
    const $ = id => document.getElementById(id);
    $('modeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.mode === 'random'));
    this.mode = 'random';
    $('customDateRow').style.display = 'none';
    $('modalSession').value = this.session;
    $('modalTf').value = this.tf;
    // 复盘进行中误点进来: 先暂停, 免得在弹窗后面白跑掉几十根
    if (this.engine && this.engine.playing) { this._resumeAfterModal = true; this.engine.pause(); }
    $('startModal').style.display = 'flex';
    $('replayBar').classList.remove('hidden');
  },

  /** 弹窗右上角的 ✕: 只关弹窗, 不动当前复盘(不小心点到时的退路) */
  closeStartModal() {
    document.getElementById('startModal').style.display = 'none';
    if (!this.engine) {
      document.getElementById('replayBar').classList.add('hidden');
      this.toast('还没开始复盘 · 点图例左侧的 ◀◀ 可以重新选');
      return;
    }
    if (this._resumeAfterModal) { this._resumeAfterModal = false; this.engine.play(); }
  },

  /** 打开「自选日期」弹窗 */
  openCustomPicker() {
    const $ = id => document.getElementById(id);
    $('modeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.mode === 'custom'));
    this.mode = 'custom';
    $('customDateRow').style.display = '';
    $('modalSession').value = this.session;
    $('modalTf').value = this.tf;
    if (this.engine && this.engine.playing) { this._resumeAfterModal = true; this.engine.pause(); }
    $('startModal').style.display = 'flex';
  },


  /** 两处工具栏的 active 状态 / 图例指标行 统一同步 */
  syncToolUI() {
    document.querySelectorAll('#sideToolbar button[data-tool], #drawBar button[data-tool]')
      .forEach(b => {
        const t = b.dataset.tool;
        let on = false;
        if (t === 'magnet') on = !!Draw.magnet;
        else if (t === 'hide') on = !!Draw.hidden;
        else if (this.DRAW_TOOLS.includes(t)) on = (Draw.tool === t);
        b.classList.toggle('active', on);
      });
    const emaRow = document.getElementById('lgEmaRow');
    if (emaRow) emaRow.classList.toggle('hidden-row', !ChartMgr.emaEnabled);
    const barRow = document.getElementById('lgBarRow');
    if (barRow) barRow.classList.toggle('hidden-row', !Draw.showBarCount);
    const ce = document.getElementById('indEma');
    if (ce) ce.checked = !!ChartMgr.emaEnabled;
    const cb = document.getElementById('indBarCount');
    if (cb) cb.checked = !!Draw.showBarCount;
  },

  /** 图例两个指标行: EMA 值 / 当前 bar 的当日序号 */
  fillIndicators(bar) {
    const $ = id => document.getElementById(id);
    this._setText($('lgEma'), (ChartMgr.emaEnabled && bar && bar.ema != null)
      ? bar.ema.toFixed(2) : '–');
    this._setText($('lgBarIdx'), (bar && bar.dayNo > 0) ? String(bar.dayNo) : '–');
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
    this._resumeAfterModal = false;       // 真的开始新会话了, 不要残留自动续播
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
    // 新会话: 重置交易状态(持仓/流水/标记/挂单/止盈止损)
    Trading.reset();
    this._limits = []; Trading._pendingLimits = false;
    ChartMgr.setMarkers([]);
    await this.loadAndBuild(true);
  },

  /** 周期显示名: 分钟只写数字(截图里是 "· 5 ·"), 其余给中文单位 */
  tfLabel() {
    if (this.tf === '1M') return '月';
    const n = this.tf.replace(/[mhdw]$/, '');
    if (this.tf.endsWith('m')) return n;
    if (this.tf.endsWith('h')) return `${n}小时`;
    if (this.tf.endsWith('d')) return n === '1' ? '天' : `${n}天`;
    return n === '1' ? '周' : `${n}周`;
  },

  syncTfUI() {
    document.querySelectorAll('#tfGroup button[data-tf]').forEach(b =>
      b.classList.toggle('active', b.dataset.tf === this.tf));
    document.getElementById('lgTf').textContent = this.tfLabel();
    document.getElementById('modalTf').value = this.tf;
    const rb = document.getElementById('rbTfSel');
    if (rb) rb.value = this.tf;
    document.title = `ES1! · ${this.tfLabel()} · CME`;
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
      const isDay = (this.tf === '1d' || this.tf === '3d' || this.tf === '1w' || this.tf === '1M');
      const bars = new Array(n);
      const k = 2 / 21;                     // EMA20 因果计算
      const tfMin = TF_MINUTES[this.tf] || 1;
      let prev = null;
      let prevKey = null, dayNo = 0;        // Bar Count: 按当日重置
      for (let i = 0; i < n; i++) {
        const j = w.indices[i];
        const ep = d.time[j], off = d.off[j];
        const c = d.close[j];
        if (prev === null) prev = c;
        else prev = c * k + prev * (1 - k);
        let dkey, dno;
        if (isDay) { dkey = 'D' + i; dno = i + 1; }   // 日/周线: 每根独立, 用顺序号
        else {
          dkey = dayKeyOf(ep, off, this.session);
          if (dkey !== prevKey) {
            const firstOfWindow = prevKey === null;
            prevKey = dkey;
            // 窗口首根落在日内中间时, 用"距开盘的时间"估算它是当日第几根
            dayNo = firstOfWindow ? barNoInDay(ep, off, this.session, tfMin) : 1;
          } else dayNo++;
          dno = dayNo;
        }
        bars[i] = {
          t: isDay ? etDateStr(ep, off) : chartTime(ep, off),
          o: d.open[j], h: d.high[j], l: d.low[j], c, v: d.volume[j],
          ema: prev, epoch: ep, off, dayNo: dno, dayKey: dkey,
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
      this._tickIdx = this.engine.idx;      // 用于判断"回退"不重复触发挂单/止损
      this.engine.speed = +document.getElementById('speedSel').value;
      this.engine.onTick = (bar, idx, isNew) => {
        const backward = this._tickIdx != null && idx <= this._tickIdx;
        this._tickIdx = idx;
        // 新 bar 追加; 后退/跳转用 setData, 严格保持用户视窗(followLast 仅在贴右端时滚动)
        if (isNew) ChartMgr.appendBar(bar);
        else ChartMgr.setData(this.visibleBars(), { preserve: true, followLast: true });
        if (!backward) {
          if (Trading._pendingLimits) this.checkLimits(bar);
          this.runTradeChecks(bar);          // 突破单触发 / 止盈止损
        }
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
    this._resumeAfterModal = false;
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
      this._limits = []; Trading._pendingLimits = false;
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
    $('stAvg').textContent = (Trading.pos === 0 || Trading.avg == null) ? '-' : Trading.avg.toFixed(2);
    const fp = Trading.floatPnl(price) || 0;
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
    // 交易记录: 内容没变就不重建 DOM (回放每推进一根都会走到这里)
    const list = $('tradeList');
    $('tradeCount').textContent = `(${Trading.trades.length})`;
    const lastT = Trading.trades[Trading.trades.length - 1];
    const sig = Trading.trades.length + '|' + (lastT ? (lastT.time || '') + lastT.side + lastT.qty + lastT.price + lastT.pnl : '');
    if (sig !== this._tradeSig) {
      this._tradeSig = sig;
      if (!Trading.trades.length) {
        list.innerHTML = '<div class="trade-empty">暂无交易记录</div>';
      } else {
        list.innerHTML = Trading.trades.slice().reverse().map(t => `
        <div class="trade-item">
          <span class="t-time">${String(t.time || '').slice(5, 16)}</span>
          <span class="t-side ${t.side}">${t.side === 'buy' ? '买' : '卖'}${t.qty}手</span>
          <span>@${t.price.toFixed(2)}</span>
          <span class="t-pnl ${t.pnl == null ? '' : t.pnl >= 0 ? 'up' : 'down'}">${t.pnl == null ? '' : (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(0) + '$'}</span>
        </div>`).join('');
      }
      if (list.scrollTop) list.scrollTop = 0;
    }
    if (typeof Draw !== 'undefined' && Draw.render) Draw.render();   // 入场/止盈/止损线跟随持仓
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

  /* 上/下键: 在当前这根 K 线的上/下沿外一个 tick 挂突破单
     上键 → 最高价 + 1 tick 上破买入 (止损买单); 下键 → 最低价 − 1 tick 下破卖出 (止损卖单)
     覆盖式: 同一方向只保留最新这一张, 连按不会堆一叠 (多/空各一张可以共存, 当 bracket 用) */
  stopOrderAtBarEdge(side) {
    if (!this.engine) { this.toast('请先开始复盘', true); return; }
    const cur = this.engine.current;
    const tick = Trading.TICK || 0.25;
    const qty = Math.max(1, +document.getElementById('orderQty').value || 1);
    const px = side === 'buy' ? cur.h + tick : cur.l - tick;
    const price = Math.round(px * 100) / 100;                 // 去掉浮点毛刺, 保持 0.25 对齐
    const before = Trading.stops.length;
    Trading.stops = Trading.stops.filter(s => s.side !== side);   // 覆盖同方向旧单
    const replaced = before - Trading.stops.length;
    Trading.placeStop(side, qty, price);
    Draw.render();
    this.toast(`${side === 'buy' ? '上破' : '下破'} ${price.toFixed(2)} 挂突破${side === 'buy' ? '买' : '卖'} ${qty} 手` +
               (replaced ? ` (已替换旧的 ${replaced} 张)` : '') + ' · 拖动该线可改价');
  },

  addMarker(side, price) {
    const cur = this.engine.current;
    const isDay = (this.tf === '1d' || this.tf === '1w');
    const t = isDay ? etDateStr(cur.epoch, cur.off) : chartTime(cur.epoch, cur.off);
    const m = ChartMgr.markers.slice();
    m.push({
      time: t,
      position: side === 'buy' ? 'belowBar' : 'aboveBar',
      color: side === 'buy' ? Draw.MARK_UP : Draw.MARK_DOWN,   // 只是记录, 实际颜色由 draw.js 定
      shape: side === 'buy' ? 'arrowUp' : 'arrowDown',
      text: side === 'buy' ? '买' : '卖',
      price,
    });
    ChartMgr.setMarkers(m);   // setMarkers 内部按 time 升序排
    Draw.render();            // 大箭头是我们自己画的, 要主动重绘一帧
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

  /** 每根 K 线的交易事件: 突破单触发 + 止盈止损 */
  runTradeChecks(bar) {
    const evs = Trading.checkBar(bar, bar.epoch, bar.off);
    for (const ev of evs) {
      if (ev.type === 'fill') {
        this.toast(`突破${ev.side === 'buy' ? '买入' : '卖出'}成交 ${ev.qty} 手 @ ${ev.price.toFixed(2)}`);
        this.addMarker(ev.side, ev.price);
      } else {
        const isTp = ev.kind === 'tp';
        this.toast(`${isTp ? '止盈' : '止损'}触发 @ ${ev.price.toFixed(2)} · 已平仓`);
        this.addMarker(ev.side, ev.price);
      }
    }
  },

  /* ---------- 右键菜单 (突破单 / 平仓 / 撤销) ---------- */
  openContextMenu(e) {
    // 画到一半点右键 => 优先取消当前绘制, 不弹挂单菜单
    if (Draw.draft || Draw.tool !== 'cursor') {
      e.preventDefault(); e.stopPropagation();
      const wasDraft = !!Draw.draft;
      Draw.cancel();
      this.syncToolUI();
      this.toast(wasDraft ? '已取消本次绘制' : '已退出绘图工具', false, { x: e.clientX, y: e.clientY });
      return;
    }
    if (!this.engine) return;
    const area = document.getElementById('chartArea');
    const rect = area.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;
    if (y > Draw._priceAreaHeight()) return;         // 时间轴/成交量区域不处理
    const raw = Draw.pOf(y);
    if (raw == null) return;
    e.preventDefault();
    const price = Math.round(raw * 4) / 4;           // 对齐 0.25 tick
    this._ctxPrice = price;
    const m = document.getElementById('ctxMenu');
    const cur = this.engine.current;
    document.getElementById('ctxHead').textContent =
      `@ ${price.toFixed(2)} · ${etTimeStr(cur.epoch, cur.off).replace(' ET', '')}`;
    m.style.display = 'block';
    m.style.left = Math.max(4, Math.min(x, rect.width - m.offsetWidth - 8)) + 'px';
    m.style.top = Math.max(4, Math.min(y, rect.height - m.offsetHeight - 8)) + 'px';
  },

  onContextAction(act) {
    const $ = id => document.getElementById(id);
    $('ctxMenu').style.display = 'none';
    const qty = Math.max(1, +$('orderQty').value || 1);
    const p = this._ctxPrice;
    if (act === 'buyStop' || act === 'sellStop') {
      const side = act === 'buyStop' ? 'buy' : 'sell';
      Trading.placeStop(side, qty, p);
      Draw.render();
      this.toast(`${side === 'buy' ? '上破' : '下破'} ${p.toFixed(2)} 挂突破${side === 'buy' ? '买' : '卖'} ${qty} 手 · 拖动该线可改价`);
    } else if (act === 'close') {
      this.closePosition();
    } else if (act === 'clearStops') {
      const n = Trading.clearStops();
      Draw.render();
      this.toast(n ? `已撤销 ${n} 张挂单` : '当前没有挂单');
    } else if (act === 'clearBrackets') {
      Trading.tp = null; Trading.sl = null; Trading.save(); Draw.render();
      this.toast('已清除止盈止损');
    }
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

  /* ---------- 图例 (照参考截图: 开/高/低/收 + 卖出/买入 + 指标行) ---------- */
  /** 值没变就不写 DOM (鼠标悬停时每秒会调用几十次) */
  _setText(el, v) { if (el && el.textContent !== v) el.textContent = v; },

  setLegend(cd) {
    const $ = id => document.getElementById(id);
    const up = cd.close >= cd.open;
    const o = cd.open.toFixed(2), h = cd.high.toFixed(2), l = cd.low.toFixed(2), c = cd.close.toFixed(2);
    this._setText($('lgO'), o);
    this._setText($('lgH'), h);
    this._setText($('lgL'), l);
    this._setText($('lgC'), c);
    const chg = cd.close - cd.open;
    const pct = (cd.close / cd.open - 1) * 100;
    this._setText($('lgChg'), `${chg >= 0 ? '+' : ''}${chg.toFixed(2)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)`);
    const chgEl = $('lgChg');
    const col = up ? 'var(--up)' : 'var(--down)';
    if (chgEl && chgEl.style.color !== col) chgEl.style.color = col;
    // 卖/买按钮上挂当前收盘价 (TV 的快速下单按钮)
    this._setText($('lgSell'), c);
    this._setText($('lgBuy'), c);
    this._setText($('lgMid'), Trading.pos === 0 ? '0.00' : String(Math.abs(Trading.pos)));
  },

  onLegend(cd, time) {
    if (!cd) { this.onLegendIdle(); return; }
    this.setLegend(cd);
    // 指标行: 悬停那根的值 + 它的 Bar 序号 (用索引表, 不再每次线性扫几千根)
    const arr = ChartMgr._lastData || [];
    let idx = this._timeIndex(arr).get(time);
    if (idx === undefined) idx = arr.length - 1;
    const bar = arr[idx];
    this.fillIndicators(bar);
  },

  /** time -> 下标 的索引表, 数据数组换了才重建 */
  _timeIndex(arr) {
    if (this._idxFor !== arr) {
      const m = new Map();
      for (let i = 0; i < arr.length; i++) m.set(arr[i].t, i);
      this._idxFor = arr; this._idxMap = m;
    }
    return this._idxMap;
  },

  onLegendIdle() {
    if (!this.engine) return;
    const b = this.bars[this.engine.idx];
    if (!b) return;
    this.setLegend({ open: b.o, high: b.h, low: b.l, close: b.c });
    this.fillIndicators(b);
  },
};

document.addEventListener('DOMContentLoaded', () => App.boot());
