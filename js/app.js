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

  /* ---- 价格行为打标 (v1.1): 市场周期 × setup ---- */
  pendingSetup: null,        // 面板上预选的 setup id —— 下单即消费, 每单都要明确选过
  pendingCycle: null,        // 市场周期 id (记在 localStorage: 一个阶段里不常变)
  _setupCb: null,            // 弹窗选完之后要执行的那个下单动作
  _setupTempCycle: null,     // 弹窗里正在选的周期 (点 setup 才落地)
  _resumeAfterSetup: false,  // 因弹窗而暂停的回放, 关掉弹窗要续上
  sessionId: null,           // 本次复盘 id; 账本用它区分「本场」和「历史」

  async boot() {
    // 主题: 默认浅色 (TradingView 默认), 记住用户选择
    this.theme = localStorage.getItem('es_replay_theme') || 'light';
    document.body.dataset.theme = this.theme;

    ChartMgr.theme = this.theme;
    ChartMgr.init();
    Draw.init();

    /* 本次复盘 id 必须排在 Trading.load() 前面: 持仓靠它做归属校验,
       不是本场的持仓要在恢复阶段就丢掉, 免得挡住「开始复盘」 */
    try {
      this.sessionId = localStorage.getItem('es_replay_session') ||
        ('S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
      localStorage.setItem('es_replay_session', this.sessionId);
      this.pendingCycle = localStorage.getItem('es_replay_cycle') || null;
    } catch (e) { this.sessionId = 'S' + Date.now().toString(36); }

    Trading.load();
    Trading.onChange = () => this.renderTrading();

    /* setup 清单 + 账本 */
    this.syncSetupUI();
    try { await Setups.load(); } catch (e) { console.error('setups load failed', e); }
    this.syncSetupUI(); this.syncManageList();
    Journal.onChange = () => { this.renderTrading(); this.renderStats(); };
    try { await Journal.load(); } catch (e) { console.error('journal load failed', e); }

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
    this.initStartModal();            // 有上次位置时, 弹窗默认选中「继续上次」
    this.renderTrading();
    this.renderStats();
    this.startClock();
    // 日报索引 (时间轴日期跳转): 后台拉, 拉到就补一帧, 把有日报的日期标记画出来
    if (typeof Reports !== 'undefined') {
      Reports.load().then(() => { try { Draw.render(); } catch (e) { /* 还没建图, 无所谓 */ } });
    }
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
    /* 截图有、但本工具没有对应能力 => 明确提示未实现 (分屏/Xe-XAU 已按用户要求删掉) */
    ['chartTypeBtn', 'symAddBtn', 'alertBtn', 'cmpSymBtn',
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
      $('resumeRow').style.display = this.mode === 'resume' ? '' : 'none';
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

    /* 底部状态条不接交互; 原来的「区间按钮 + 回放交易」已按用户要求删掉 (reference/22) */

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
    $('btnResetTrades').addEventListener('click', () => this.clearSessionTrades());

    /* 市场周期 / setup 打标 */
    $('cycleSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      this.setCycle(b.dataset.cycle);
    });
    $('setupPick').addEventListener('click', () => this.openSetupModal(null));
    $('sideTabs').addEventListener('click', e => {
      const b = e.target.closest('button[data-tab]'); if (!b) return;
      this.switchTab(b.dataset.tab);
    });

    /* setup 选择弹窗 */
    this.bindModalDrag($('setupModal').querySelector('.modal'));   // 能拖走, 免得挡住 K 线
    $('setupModalClose').addEventListener('click', () => this.closeSetupModal(false));
    $('setupCancelBtn').addEventListener('click', () => this.closeSetupModal(false));
    $('setupCycleSeg').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      this._setupTempCycle = b.dataset.cycle;
      this.syncSetupModal();
    });
    $('setupList').addEventListener('click', e => {
      // 先看是不是点了 × —— 那是「从本周期移出」, 不是选它
      const rm = e.target.closest('[data-rm]');
      if (rm) { e.stopPropagation(); this.removeSetupFromCycle(rm.dataset.rm); return; }
      const b = e.target.closest('[data-setup]'); if (!b) return;
      this.chooseSetup(b.dataset.setup);
    });
    $('setupLib').addEventListener('click', e => {
      const b = e.target.closest('[data-lib]'); if (!b || b.disabled) return;
      this.addSetupToCycle(b.dataset.lib);
    });
    $('setupAddBtn').addEventListener('click', () => this.quickAddSetup());
    $('setupManageBtn').addEventListener('click', () => this.openManageModal());

    /* setup 管理弹窗 */
    $('manageModalClose').addEventListener('click', () => this.closeManageModal());
    $('manageDoneBtn').addEventListener('click', () => this.closeManageModal());
    $('manageAddBtn').addEventListener('click', () => this.manageAdd());
    $('manageNewName').addEventListener('keydown', e => { if (e.key === 'Enter') this.manageAdd(); });
    $('manageGroupAdd').addEventListener('click', () => this.manageAddGroup());
    $('manageGroupName').addEventListener('keydown', e => { if (e.key === 'Enter') this.manageAddGroup(); });
    $('manageList').addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.act === 'toggle') { Setups.setActive(t.dataset.id, t.checked); this.syncManageList(); }
      else if (t.dataset.act === 'group') {
        Setups.setGroup(t.dataset.id, t.value); this.syncManageList(); this.syncSetupModal();
      } else if (t.dataset.act === 'cycle') {
        // 适用周期: 勾上就进那个周期的清单, 取消就移出 (setup 本身不动)
        if (t.checked) Setups.addToCycle(t.dataset.id, t.dataset.cycle);
        else Setups.removeFromCycle(t.dataset.id, t.dataset.cycle);
        this.syncSetupModal();
      } else if (t.dataset.act === 'rename') {
        if (!Setups.rename(t.dataset.id, t.value)) { this.syncManageList(); }
        this.syncSetupUI();
      }
    });
    /* 分组管理: 改名 (change) / 删除 (click) */
    $('manageGroupRows').addEventListener('change', e => {
      const t = e.target;
      if (t.dataset.gact !== 'grename') return;
      if (!Setups.renameGroup(t.dataset.gid, t.value)) { this.syncManageList(); return; }
      this.syncManageList(); this.syncSetupModal();
    });
    $('manageGroupRows').addEventListener('click', e => {
      const b = e.target.closest('[data-gdel]'); if (!b) return;
      const g = Setups.groups.find(x => x.id === b.dataset.gdel);
      if (!g) return;
      const n = Setups.list.filter(s => s.group === g.id).length;
      const msg = n
        ? `删除分组「${g.name}」？\n\n组里 ${n} 个 setup 不会删，会落到「未分组」等重新归位。`
        : `删除分组「${g.name}」？`;
      if (!window.confirm(msg)) return;
      const moved = Setups.removeGroup(g.id);
      this.syncManageList(); this.syncSetupModal();
      this.toast(moved ? `已删除分组, ${moved} 个 setup 移到「未分组」` : '已删除分组');
    });

    /* 账本导出 / 导入 */
    $('statsPane').addEventListener('click', e => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      this.statsAction(b.dataset.act);
    });
    $('journalImport').addEventListener('change', e => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';                    // 同一个文件能重复导入
      if (f) this.importJournal(f);
    });

    /* 键盘 */
    document.addEventListener('keydown', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      // setup 弹窗/管理弹窗开着时, 快捷键一律不生效 (B/S/C 会误下单)
      if ($('setupModal').style.display === 'flex' || $('manageModal').style.display === 'flex') {
        if (e.key === 'Escape') {
          if ($('manageModal').style.display === 'flex') this.closeManageModal();
          else this.closeSetupModal(false);
        }
        return;
      }
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

  /* 底部区间按钮 (1天/5天/…/全部) 已按用户要求整块删掉, 连同 applyRange 一起去掉 */

  /* ---------- 上次看到的位置 ----------
     用户要求: 每次打开回放默认回到上次那个时间点。
     窗口由 (session, tf, anchor) 唯一决定 (DataLoader.loadWindow), 所以存
       anchor = 本次会话的加载锚点 targetEpoch
       idx    = 看到第几根 (窗口内下标)
     两项就能把同一段 K 线、同一个视角精确复原。 */
  POS_KEY: 'es_replay_pos',

  savedPos() {
    try {
      const o = JSON.parse(localStorage.getItem(this.POS_KEY) || 'null');
      if (!o || !o.anchor || o.idx == null || !o.tf) return null;
      return o;
    } catch (e) { return null; }
  },

  savePos() {
    if (!this.engine || !this.engine.current) return;
    const cur = this.engine.current;
    clearTimeout(this._posTimer);
    this._posTimer = setTimeout(() => {
      if (!this.engine) return;
      try {
        localStorage.setItem(this.POS_KEY, JSON.stringify({
          tf: this.tf, session: this.session,
          anchor: this.targetEpoch, idx: this.engine.idx,
          time: etTimeStr(cur.epoch, cur.off).replace(' ET', ''),
        }));
      } catch (e) { /* 隐私模式写不进去就算了 */ }
    }, 250);
  },

  /** 开始弹窗的默认状态: 有上次位置就默认「继续上次」, 否则「随机一段」 */
  initStartModal() {
    const $ = id => document.getElementById(id);
    const sp = this.savedPos();
    this.mode = sp ? 'resume' : 'random';
    $('modeSeg').querySelectorAll('button').forEach(x =>
      x.classList.toggle('active', x.dataset.mode === this.mode));
    $('modeSeg').querySelector('button[data-mode="resume"]').style.display = sp ? '' : 'none';
    $('customDateRow').style.display = 'none';
    $('resumeRow').style.display = sp ? '' : 'none';
    $('resumeNote').textContent = sp
      ? `${sp.time} · ${TF_LABEL[sp.tf] || sp.tf} / ${(sp.session || '').toUpperCase()}`
      : '--';
    $('modalSession').value = sp ? (sp.session || this.session) : this.session;
    $('modalTf').value = sp ? sp.tf : this.tf;
  },

  /** 打开「选择随机K线」弹窗 (顶栏回放胶囊 / 图例◀◀ / 弹窗下拉 共用) */
  startReplay() {
    const $ = id => document.getElementById(id);
    if (!this.guardFlat('换一段行情')) return;
    this.initStartModal();
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
    if (!this.guardFlat('换一段行情')) return;
    $('modeSeg').querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.mode === 'custom'));
    this.mode = 'custom';
    $('customDateRow').style.display = '';
    $('resumeRow').style.display = 'none';
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
  /** 持仓中不允许换行情/清空 —— 否则这一笔的 R 就丢了。
   *
   *  ⚠️ 图表还没加载时一律放行 (2026-10-23 用户报的死锁):
   *  那时没有任何价格, 用户根本没有平仓的入口, 拦下来就是走投无路。
   *  这种情况下残留持仓已由 Trading.load() 按 sessionId 清理, 这里再兜一次底。 */
  guardFlat(what) {
    if (!this.engine) {
      if (Trading.pos !== 0) {
        Trading.reset();          // 图表都没了, 这笔无从平起, 直接丢弃(账本里本来就没有它)
        Draw.render();
      }
      return true;
    }
    if (Trading.pos !== 0) {
      this.toast(`当前有持仓, 先点右侧面板的「平仓」再${what || '继续'}`, true);
      return false;
    }
    return true;
  },

  async startSession() {
    this._resumeAfterModal = false;       // 真的开始新会话了, 不要残留自动续播
    if (!this.guardFlat('开始新的复盘')) return;
    const meta = DataLoader.meta;
    if (!meta) { this.toast('数据索引未加载完成, 请稍候', true); return; }
    const from = meta.usableFrom ? Math.floor(new Date(meta.usableFrom + 'T00:00:00Z').getTime() / 1000) : meta.range.first;
    const last = meta.range.last - 86400 * 2;
    this._resumeIdx = null;
    if (this.mode === 'resume') {
      // 继续上次: 用上次的锚点重建同一段窗口, 再 seek 回看到的那一根
      const sp = this.savedPos();
      if (!sp) {
        this.mode = 'random';
        this.toast('没有可继续的位置, 已改为随机一段');
      } else {
        this.targetEpoch = sp.anchor;
        this._resumeIdx = sp.idx;
        document.getElementById('modalSession').value = sp.session || 'rth';
        document.getElementById('modalTf').value = sp.tf;
      }
    }
    if (this.mode === 'random') {
      this.targetEpoch = from + Math.random() * (last - from);
    } else if (this.mode === 'custom') {
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
    // 新会话: 换一个场次 id —— 账本按它区分「本场」和「历史」, 历史不会被这一场覆盖
    this.sessionId = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    try { localStorage.setItem('es_replay_session', this.sessionId); } catch (e) { }
    this._tradeSig = null;
    // 上一场还没触发的挂单: 记成「未触发」再清掉, 不然它们就凭空消失了
    if (this.engine && this.engine.current) {
      Trading.expireStops(this.engine.current.epoch, this.engine.current.off);
    }
    // 新会话: 重置交易状态(持仓/流水/标记/挂单/止盈止损)
    Trading.reset();
    this._limits = []; Trading._pendingLimits = false;
    ChartMgr.setMarkers([]);
    await this.loadAndBuild(true);
    // 继续上次: 窗口建好后 seek 回上次看到的那一根
    if (this._resumeIdx != null && this.engine) {
      this.engine.seek(Math.min(this._resumeIdx, this.bars.length - 1));
      // seek 只重设数据, 视窗仍是 loadAndBuild 里 fit:'recent' 算的那一版 ——
      // 数据长度变了而视窗没跟着走, K 线就会整块挤到右边(用户 2026-10-23 报)。
      // 这里按当前末端重算一次, 让"看到的那一根"落在横向 2/3 处, 跟正常开始一致。
      ChartMgr.fitRecent();
      this._resumeIdx = null;
    }
    this.savePos();
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
        this.savePos();                    // 记住看到第几根, 下次打开接着来
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
    if (!this.guardFlat('结束本次复盘')) return;
    this._resumeAfterModal = false;
    if (this.engine.current) Trading.expireStops(this.engine.current.epoch, this.engine.current.off);
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
      if (!this.guardFlat('跳到其它时段')) return;
      this.targetEpoch = ep;
      if (this.engine && this.engine.current) {
        Trading.expireStops(this.engine.current.epoch, this.engine.current.off);
      }
      this.sessionId = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
      try { localStorage.setItem('es_replay_session', this.sessionId); } catch (e) { }
      this._tradeSig = null;
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
    document.getElementById('replayBar').classList.toggle('playing', e.playing);
    this.onLegendIdle();
  },

  /** 美元 → 点 (ES: 1 点 = $50)。右侧面板/交易记录的所有盈亏都走这里
   *  (用户 2026-10-22: "无论是交易记录还是已实现盈亏, 全部改成多少个点" -> 再去掉"点"字只留数字) */
  ptStr(usd) {
    const p = (usd || 0) / (Trading.MULT || 50);
    const s = Number(p.toFixed(2)).toString();     // 12.00→"12", -6.50→"-6.5"
    return (p > 0 ? '+' : '') + s;
  },

  /** 最近 n 根已走出的 K 线 (不含当前这根) —— 新开仓的止损取这里面的极值 */
  prevBars(n = 5) {
    const e = this.engine;
    if (!e || !e.bars || !e.bars.length) return [];
    return e.bars.slice(Math.max(0, e.idx - n), e.idx);
  },

  /** 本场已完成的一笔交易 (账本按 sessionId 切; 一笔交易一行, 不是成交流水) */
  sessionTrades() {
    if (typeof Journal === 'undefined' || !Journal.loaded || !this.sessionId) return [];
    const sid = this.sessionId;
    return Journal.data.trades.filter(t => t.sessionId === sid);
  },

  esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  },

  renderTrading() {
    const cur = this.engine ? this.engine.current : null;
    const price = cur ? cur.c : 0;
    const $ = id => document.getElementById(id);
    $('stPos').textContent = Trading.pos === 0 ? '0 手' : `${Math.abs(Trading.pos)} 手${Trading.pos > 0 ? '多' : '空'}`;
    $('stAvg').textContent = (Trading.pos === 0 || Trading.avg == null) ? '-' : Trading.avg.toFixed(2);
    // 盈亏一律按「点」显示 (用户 2026-10-22: 原来写 $, 全部改成多少个点)
    const fp = Trading.floatPnl(price) || 0;
    $('stFloat').textContent = Trading.pos === 0 ? '-' : this.ptStr(fp);
    $('stFloat').className = 'stat-v ' + (fp > 0 ? 'up' : fp < 0 ? 'down' : '');
    $('stReal').textContent = this.ptStr(Trading.realized);
    $('stReal').className = 'stat-v ' + (Trading.realized > 0 ? 'up' : Trading.realized < 0 ? 'down' : '');
    const tp = Trading.totalPnl(price);
    $('stTotal').textContent = this.ptStr(tp);
    $('stTotal').className = 'stat-v ' + (tp > 0 ? 'up' : tp < 0 ? 'down' : '');
    // 交易/胜率: 换成一笔交易为单位的统计 (成交流水会把一次开平仓算两笔)
    const mine = this.sessionTrades();
    const aggS = (typeof Journal !== 'undefined' && Journal.loaded)
      ? Journal.agg(mine) : { n: 0, winRate: null };
    $('stWin').textContent = `${aggS.n} 笔 / ${aggS.winRate == null ? '-' : aggS.winRate.toFixed(0) + '%'}`;
    ChartMgr.setPosLine(Trading.pos === 0 ? null : Trading.avg);
    // 交易记录: 内容没变就不重建 DOM (回放每推进一根都会走到这里)
    const list = $('tradeList');
    const total = (typeof Journal !== 'undefined' && Journal.loaded) ? Journal.data.trades.length : 0;
    $('tradeCount').textContent = total > mine.length ? `(${mine.length}/${total})` : `(${mine.length})`;
    const lastT = mine[mine.length - 1];
    const sig = mine.length + '|' + (lastT ? lastT.id + '|' + lastT.r : '');
    if (sig !== this._tradeSig) {
      this._tradeSig = sig;
      if (!mine.length) {
        list.innerHTML = '<div class="trade-empty">本场还没有完成的交易<br>' +
          '<span class="t-none">平仓后自动记一笔</span></div>';
      } else {
        list.innerHTML = mine.slice().reverse().map(t => {
          const long = t.side === 'long';
          const rc = t.r == null ? '' : (t.r > 0 ? 'up' : t.r < 0 ? 'down' : '');
          const rTxt = t.r == null ? '–' : (t.r > 0 ? '+' : '') + t.r.toFixed(2) + 'R';
          const pTxt = t.points == null ? '' : (t.points > 0 ? '+' : '') + t.points.toFixed(2) + '点';
          return `<div class="trade-item t-one">
          <div class="t-top">
            <span class="t-setup">${this.esc(t.setupName || Setups.name(t.setupId))}</span>
            <span class="t-side ${long ? 'buy' : 'sell'}">${long ? '多' : '空'}</span>
          </div>
          <span class="t-r ${rc}">${rTxt}</span>
          <div class="t-sub">
            <span>${String(t.exitTime || '').slice(5, 16)}</span>
            <span class="t-cyc">${this.esc(Setups.cycleName(t.cycle))}</span>
            <span>${pTxt}</span>
          </div>
        </div>`;
        }).join('');
      }
      if (list.scrollTop) list.scrollTop = 0;
    }
    if (typeof Draw !== 'undefined' && Draw.render) Draw.render();   // 入场/止盈/止损线跟随持仓
  },

  /** 清空「本场」的交易记录 (账本其它场次不动) */
  clearSessionTrades() {
    if (Trading.pos !== 0) { this.toast('还有持仓, 先平仓再清空', true); return; }
    const mine = this.sessionTrades();
    if (!mine.length) { this.toast('本场还没有完成的交易'); return; }
    const ok = window.confirm(`清空本场 ${mine.length} 笔交易记录？\n账本里其它场次的记录不受影响。`);
    if (!ok) return;
    const sid = this.sessionId;
    Journal.data.trades = Journal.data.trades.filter(t => t.sessionId !== sid);
    Journal.data.orders = Journal.data.orders.filter(o => o.sessionId !== sid);
    Journal.save();
    this.renderTrading(); this.renderStats();
    this.toast('已清空本场交易记录');
  },

  /* ================================================================
     Setup 统计 —— 读的是账本全量 (跨复盘会话), 这才是这个功能的意义
     ================================================================ */
  MIN_SAMPLE: 20,          // 样本量低于这个数就标 *, 别拿 3 笔的胜率当结论

  switchTab(tab) {
    document.querySelectorAll('#sideTabs button').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    const isStats = tab === 'stats';
    document.getElementById('tradeList').style.display = isStats ? 'none' : '';
    document.getElementById('statsPane').style.display = isStats ? '' : 'none';
    if (isStats) this.renderStats();
  },

  _statsTools() {
    return `<div class="stats-tools">
      <button class="btn-ghost" data-act="csv">导出交易 CSV</button>
      <button class="btn-ghost" data-act="csvOrders">导出挂单 CSV</button>
      <button class="btn-ghost" data-act="json">导出 JSON 备份</button>
      <button class="btn-ghost" data-act="import">导入 JSON</button>
    </div>`;
  },

  renderStats() {
    const box = document.getElementById('statsPane');
    if (!box) return;
    if (typeof Journal === 'undefined' || !Journal.loaded) {
      box.innerHTML = '<div class="stats-empty">账本加载中…</div>';
      return;
    }
    const trades = Journal.data.trades || [];
    const orders = Journal.data.orders || [];
    if (!trades.length && !orders.length) {
      box.innerHTML = '<div class="stats-empty">还没有记录<br>做完一笔交易就会出现在这里</div>' + this._statsTools();
      return;
    }
    const MIN = this.MIN_SAMPLE;
    const all = Journal.agg(trades);
    let sumPts = 0;
    for (const t of trades) sumPts += (t.points || 0);

    const sec = (title, right, body) =>
      `<div class="stats-sec"><div class="stats-sec-h"><b>${title}</b><span>${right || ''}</span></div>${body}</div>`;
    const head = '<div class="stats-row head"><span class="s-name">Setup</span>' +
                 '<span class="s-n">n</span><span class="s-wr">胜率</span><span class="s-r">均R</span></div>';
    const rowHtml = (name, a, alt, tot) => {
      const weak = a.rn > 0 && a.rn < MIN;
      const wr = a.winRate == null ? '–' : a.winRate.toFixed(0) + '%';
      const avg = a.avgR == null ? '–' : (a.avgR > 0 ? '+' : '') + a.avgR.toFixed(2);
      const cls = a.avgR == null ? '' : (a.avgR > 0 ? 'up' : a.avgR < 0 ? 'down' : '');
      return `<div class="stats-row${alt ? ' alt' : ''}${tot ? ' tot' : ''}${weak ? ' weak' : ''}">` +
        `<span class="s-name" title="${this.esc(name)}">${this.esc(name)}${weak ? '*' : ''}</span>` +
        `<span class="s-n">${a.n}</span>` +
        `<span class="s-wr ${cls}">${wr}</span>` +
        `<span class="s-r ${cls}">${avg}</span></div>`;
    };
    const groupBy = keyFn => {
      const m = new Map();
      for (const t of trades) {
        const k = keyFn(t) || '_none';
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(t);
      }
      return [...m.entries()].map(([k, l]) => ({ k, a: Journal.agg(l) }))
        .sort((x, y) => y.a.n - x.a.n);
    };
    const num = (v, sign) => (v == null ? '–' : (sign && v > 0 ? '+' : '') + v.toFixed(2));

    // 导出/导入放最上面: 统计内容比可视区高, 放末尾会被埋在下面
    let html = this._statsTools();

    /* 综合 (所有 setup / 所有场次) */
    html += sec('综合', `全部 ${all.n} 笔`, `
      <div class="stat-grid">
        <div class="stat"><span class="stat-k">胜率</span>
          <span class="stat-v">${all.winRate == null ? '–' : all.winRate.toFixed(0) + '%'}</span></div>
        <div class="stat"><span class="stat-k">平均 R</span>
          <span class="stat-v ${all.avgR == null ? '' : all.avgR > 0 ? 'up' : all.avgR < 0 ? 'down' : ''}">${num(all.avgR, true)}</span></div>
        <div class="stat"><span class="stat-k">总 R</span>
          <span class="stat-v ${all.totalR == null ? '' : all.totalR > 0 ? 'up' : all.totalR < 0 ? 'down' : ''}">${num(all.totalR, true)}</span></div>
        <div class="stat"><span class="stat-k">总点数</span>
          <span class="stat-v ${sumPts > 0 ? 'up' : sumPts < 0 ? 'down' : ''}">${num(sumPts, true)}</span></div>
      </div>`);

    /* 按 setup */
    const bySetup = groupBy(t => t.setupId);
    if (bySetup.length) {
      html += sec('按 Setup', `${bySetup.length} 种`,
        head + bySetup.map((r, i) => rowHtml(
          r.k === '_none' ? '（未标注）' : Setups.name(r.k), r.a, i % 2 === 1)).join('') +
        rowHtml('全部', all, false, true));
    }

    /* 按市场周期 */
    const byCycle = groupBy(t => t.cycle);
    if (byCycle.length) {
      html += sec('按市场周期', '', head + byCycle.map((r, i) => rowHtml(
        r.k === '_none' ? '（未标周期）' : Setups.cycleName(r.k), r.a, i % 2 === 1)).join(''));
    }

    /* 突破挂单成交率 */
    if (orders.length) {
      const os = Journal.orderStats(orders);
      const byOSetup = new Map();
      for (const o of orders) {
        const k = o.setupId || '_none';
        if (!byOSetup.has(k)) byOSetup.set(k, []);
        byOSetup.get(k).push(o);
      }
      const orows = [...byOSetup.entries()]
        .map(([k, l]) => ({ k, s: Journal.orderStats(l) }))
        .sort((x, y) => y.s.total - x.s.total)
        .map((r, i) => `<div class="stats-row ord${i % 2 === 1 ? ' alt' : ''}">` +
          `<span class="s-name">${this.esc(r.k === '_none' ? '（未标注）' : Setups.name(r.k))}</span>` +
          `<span class="s-n">${r.s.total}</span>` +
          `<span class="s-wr">${r.s.hitRate == null ? '–' : r.s.hitRate.toFixed(0) + '%'}</span></div>`)
        .join('');
      const ohead = '<div class="stats-row ord head"><span class="s-name">Setup</span>' +
        '<span class="s-n">张</span><span class="s-wr">成交率</span></div>';
      html += sec('突破挂单成交率',
        `${os.filled}/${os.total} = ${os.hitRate == null ? '–' : os.hitRate.toFixed(0) + '%'}`,
        ohead + orows);
    }

    /* 脚注 */
    html += `<div class="stats-note">* 样本量 &lt; ${MIN} 笔，参考价值有限。<br>` +
            `R = 盈亏点数 ÷ 初始风险点数（成交后锁定，不重算）。<br>` +
            `统计口径：全部场次，一笔交易一行。</div>`;
    box.innerHTML = html;
  },

  statsAction(act) {
    if (typeof Journal === 'undefined') return;
    if (act === 'csv') Journal.exportCSV();
    else if (act === 'csvOrders') Journal.exportOrdersCSV();
    else if (act === 'json') Journal.exportJSON();
    else if (act === 'import') document.getElementById('journalImport').click();
  },

  async importJournal(file) {
    const r = await Journal.importJSON(file);
    if (!r.ok) { this.toast('导入失败: ' + r.err, true); return; }
    this.renderStats(); this.renderTrading();
    this.toast(`已合并导入 · 新增 ${r.added} 条 · 账本共 ${r.total} 条`);
  },

  refreshMarkers() {
    if (!this.engine) return;
    if (!Trading.trades.length && ChartMgr.markers.length) ChartMgr.setMarkers([]);
  },

  /* ================================================================
     价格行为打标: 市场周期 × setup
     —— 下单前必须明确选过 (没选就弹窗拦), 选完这一单就消费掉, 下一单重新选
     ================================================================ */
  setCycle(id) {
    this.pendingCycle = id || null;
    try { localStorage.setItem('es_replay_cycle', id || ''); } catch (e) { }
    this.syncSetupUI();
    this.syncSetupModal();
  },

  syncSetupUI() {
    const $ = id => document.getElementById(id);
    const txt = $('setupPickText'), btn = $('setupPick');
    if (txt) txt.textContent = (typeof Setups !== 'undefined' && this.pendingSetup)
      ? Setups.name(this.pendingSetup) : '未选择';
    if (btn) btn.classList.toggle('unset', !(this.pendingSetup && this.pendingCycle));
    const seg = $('cycleSeg');
    if (seg) seg.querySelectorAll('button').forEach(b =>
      b.classList.toggle('active', b.dataset.cycle === this.pendingCycle));
    this.syncSetupModal();
  },

  /** 弹窗内容: 周期 4 按钮 + 左(全局参考库) / 右(当前周期在用)
   *
   *  用户 2026-10-23 定: 4 个市场周期的入场不一样, 每个周期只列自己会用的。
   *  左 = 全库(点一下就加进右), 右 = 当前周期的清单(点选它下单 / 点 × 移出本周期)。 */
  syncSetupModal() {
    const $ = id => document.getElementById(id);
    const seg = $('setupCycleSeg');
    if (seg) seg.querySelectorAll('button').forEach(b =>
      b.classList.toggle('active', b.dataset.cycle === this._setupTempCycle));

    const cur = this._setupTempCycle;
    const libBox = $('setupLib');
    const box = $('setupList');
    if (!box || typeof Setups === 'undefined' || !Setups.loaded) return;

    const curName = $('setupCurName');
    if (curName) curName.textContent = cur ? Setups.cycleName(cur) : '先选周期';

    /* 左栏: 全库按组列; 已经在当前周期的打勾灰显, 点不动 */
    if (libBox) {
      const all = Setups.grouped();
      libBox.innerHTML = !all.length
        ? '<div class="manage-empty">库里还没有 setup</div>'
        : all.map(g => `
          <div class="setup-group-h">${this.esc(g.group.name)}</div>
          <div class="setup-grid">${g.items.map(s => {
            const on = !!cur && Setups.inCycle(s.id, cur);
            return `<button class="setup-chip lib${on ? ' in' : ''}" data-lib="${s.id}"
              title="${this.esc(on ? '已在本周期清单里' : '点一下加进右边')}"
              ${on ? 'disabled' : ''}><span class="nm">${this.esc(s.name)}</span>${
              on ? '<span class="ck">✓</span>' : ''}</button>`;
          }).join('')}</div>`).join('');
    }

    /* 右栏: 当前周期的清单 */
    if (!cur) {
      box.innerHTML = '<div class="manage-empty">先在上面选一个市场周期</div>';
      return;
    }
    const groups = Setups.groupedFor(cur);
    if (!groups.length) {
      box.innerHTML = '<div class="manage-empty">这个周期还没有 setup<br>从左边点一个加进来</div>';
      return;
    }
    box.innerHTML = groups.map(g => `
      <div class="setup-group-h">${this.esc(g.group.name)}</div>
      <div class="setup-grid">${g.items.map(s => `
        <div class="setup-chip pick${s.id === this.pendingSetup ? ' active' : ''}" data-setup="${s.id}">
          <span class="nm" title="${this.esc(s.name)}">${this.esc(s.name)}</span>
          <button class="rm" data-rm="${s.id}" title="从本周期移出（不删库）">×</button>
        </div>`).join('')}</div>`).join('');
  },

  /** 左栏点一下 → 加进当前周期 */
  addSetupToCycle(id) {
    const cur = this._setupTempCycle;
    if (!cur) { this.toast('先选市场周期', true); return; }
    if (!Setups.addToCycle(id, cur)) { this.toast('这个 setup 已经在本周期里了'); return; }
    this.syncSetupModal();
    this.toast(`已加进「${Setups.cycleName(cur)}」: ${Setups.name(id)}`);
  },

  /** 右栏点 × → 只从当前周期移出, setup 本身还在库里 */
  removeSetupFromCycle(id) {
    const cur = this._setupTempCycle;
    if (!cur) return;
    if (!Setups.removeFromCycle(id, cur)) return;
    if (this.pendingSetup === id) this.consumeSetup();
    this.syncSetupModal();
    this.toast(`已从「${Setups.cycleName(cur)}」移出（库里还留着）`);
  },

  /* ---------- 弹窗拖动 ----------
     setup 弹窗会盖住 K 线, 用户要一边对照盘面一边选入场原因 (2026-10-23 要求)。
     按住空白处 / 边框 / 标题就能挪; 点在按钮、输入框、可滚动列表、setup 卡片上不拖,
     免得把点击和滚动抢掉。位置只在本次会话里保留(关掉再开还在原处), 不写 localStorage ——
     用户只要求"能拖", 没要求记住位置。 */
  bindModalDrag(modal) {
    if (!modal || modal._dragBound) return;
    modal._dragBound = true;
    let sx = 0, sy = 0, ox = 0, oy = 0, on = false;
    let baseL = 0, baseT = 0, mw = 0, mh = 0;

    /* 偏移只存在 transform 上, 用时读回来, 免得和外部改动不同步 */
    const getXY = () => {
      const m = /translate\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px\s*\)/.exec(modal.style.transform || '');
      return m ? { x: +m[1], y: +m[2] } : { x: 0, y: 0 };
    };
    /* 夹在视口内: 拖出去就再也抓不回来了(留 8px 边) */
    const place = (x, y) => {
      const minX = 8 - baseL, maxX = innerWidth - 8 - baseL - mw;
      const minY = 8 - baseT, maxY = innerHeight - 8 - baseT - mh;
      const cx = Math.min(Math.max(x, Math.min(minX, maxX)), Math.max(minX, maxX));
      const cy = Math.min(Math.max(y, Math.min(minY, maxY)), Math.max(minY, maxY));
      modal.style.transform = `translate(${cx}px, ${cy}px)`;
    };

    modal.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      /* 这些地方按下是要"点"或"滚"的, 不是要拖窗口 */
      if (e.target.closest('button, input, select, textarea, a, label, .setup-list, .setup-chip, .seg')) return;
      const p = getXY();
      const r = modal.getBoundingClientRect();
      /* 记录未平移时的左上角, 拖动中算边界要用 */
      baseL = r.left - p.x; baseT = r.top - p.y; mw = r.width; mh = r.height;
      sx = e.clientX; sy = e.clientY; ox = p.x; oy = p.y;
      on = true;
      modal.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();                    // 别把这次按下当成选文字
    });

    document.addEventListener('mousemove', e => {
      if (!on) return;
      place(ox + (e.clientX - sx), oy + (e.clientY - sy));
    });

    document.addEventListener('mouseup', () => {
      if (!on) return;
      on = false;
      modal.classList.remove('dragging');
      document.body.style.userSelect = '';
    });
  },

  /** 打开 setup 弹窗; cb = 选完之后要执行的动作 (下单) */
  openSetupModal(cb) {
    const $ = id => document.getElementById(id);
    this._setupCb = cb || null;
    this._setupTempCycle = this.pendingCycle;
    this.syncSetupModal();
    $('setupModal').style.display = 'flex';
    // 弹窗期间别让回放继续跑掉几根 K 线
    if (this.engine && this.engine.playing) { this._resumeAfterSetup = true; this.engine.pause(); }
  },

  closeSetupModal(run) {
    const $ = id => document.getElementById(id);
    $('setupModal').style.display = 'none';
    $('manageModal').style.display = 'none';
    if (this._resumeAfterSetup) {
      this._resumeAfterSetup = false;
      if (this.engine) this.engine.play();
    }
    const cb = this._setupCb; this._setupCb = null;
    if (run && cb) cb();
  },

  /** 选中一个 setup: 落地周期 + setup, 关弹窗, 继续执行刚才那笔下单 */
  chooseSetup(id) {
    if (!this._setupTempCycle) {
      this.toast('先选市场周期 (突破 / 窄通道 / 宽通道 / 区间)', true);
      return;
    }
    this.pendingSetup = id;
    this.pendingCycle = this._setupTempCycle;
    try { localStorage.setItem('es_replay_cycle', this.pendingCycle); } catch (e) { }
    this.syncSetupUI();
    const hadCb = !!this._setupCb;
    this.closeSetupModal(true);
    if (!hadCb) this.toast(`已标记: ${Setups.name(id)} · ${Setups.cycleName(this.pendingCycle)}`);
  },

  /** 只有在 setup + 周期都选过时才放行; 否则弹窗, 选完再执行 */
  withSetup(cb) {
    if (this.pendingSetup && this.pendingCycle) { cb(); return; }
    this.openSetupModal(cb);
  },

  /** 这一单已经落定 → 清掉 setup (周期留着), 下一单重新选 */
  consumeSetup() {
    this.pendingSetup = null;
    this.syncSetupUI();
  },

  /** 突破单的机械止盈止损: 前 5 根极值外 1 tick 当止损, 止盈 = 2R */
  plannedBrackets(side, entryPx, prev) {
    const tick = Trading.TICK || 0.25;
    const long = side === 'buy';
    let sl;
    if (prev && prev.length) {
      const lo = Math.min(...prev.map(b => b.l));
      const hi = Math.max(...prev.map(b => b.h));
      sl = long ? lo - tick : hi + tick;
    } else {
      sl = long ? entryPx - 6 : entryPx + 6;
    }
    let risk = Math.abs(entryPx - sl);
    if (!(risk > 0)) { risk = 6; sl = long ? entryPx - risk : entryPx + risk; }
    const tp = long ? entryPx + risk * (Trading.TP_R || 2)
                    : entryPx - risk * (Trading.TP_R || 2);
    const r2 = v => Math.round(v * 4) / 4;
    return { tp: r2(tp), sl: r2(sl) };
  },

  /* ---------- setup 管理 ---------- */
  /** 「+ 新增」直接进管理弹窗并聚焦输入框 (不用 window.prompt, 也不会被浏览器拦) */
  quickAddSetup() {
    this._manageFromOrder = (document.getElementById('setupModal').style.display === 'flex');
    // 新增的 setup 只勾给"当前正在看/正在用的那个周期"
    this._manageCycle = this._setupTempCycle || this.pendingCycle || null;
    document.getElementById('setupModal').style.display = 'none';
    document.getElementById('manageModal').style.display = 'flex';
    this.syncManageList();
    setTimeout(() => document.getElementById('manageNewName').focus(), 0);
  },

  openManageModal() {
    this._manageFromOrder = (document.getElementById('setupModal').style.display === 'flex');
    this._manageCycle = this._setupTempCycle || this.pendingCycle || null;
    document.getElementById('setupModal').style.display = 'none';
    document.getElementById('manageModal').style.display = 'flex';
    this.syncManageList();
  },

  closeManageModal() {
    document.getElementById('manageModal').style.display = 'none';
    // 从下单弹窗进来的: 回到下单弹窗继续选 (下单动作还挂着)
    if (this._manageFromOrder) {
      this._manageFromOrder = false;
      document.getElementById('setupModal').style.display = 'flex';
    }
    this.syncSetupModal(); this.syncSetupUI();
  },

  syncManageList() {
    const box = document.getElementById('manageList');
    if (!box || typeof Setups === 'undefined' || !Setups.loaded) return;

    /* 分组管理: 改名 / 删除 (删组不删 setup) */
    const gbox = document.getElementById('manageGroupRows');
    if (gbox) {
      gbox.innerHTML = Setups.groups.length
        ? Setups.groups.map(g => `
          <div class="mgrow">
            <input type="text" data-gact="grename" data-gid="${g.id}"
                   value="${this.esc(g.name)}" maxlength="16">
            <button class="mgdel" data-gdel="${g.id}" title="删除这个分组（组里的 setup 不删，会落到「未分组」）">×</button>
          </div>`).join('')
        : '<div class="manage-empty">还没有分组</div>';
    }

    if (!Setups.list.length) { box.innerHTML = '<div class="manage-empty">还没有 setup</div>'; return; }
    const groups = Setups.groups.map(g =>
      `<option value="${g.id}">${this.esc(g.name)}</option>`).join('');
    box.innerHTML = Setups.list.map(s => `
      <div class="manage-row${s.active ? '' : ' off'}">
        <input type="text" data-act="rename" data-id="${s.id}" value="${this.esc(s.name)}" maxlength="24">
        <select data-act="group" data-id="${s.id}">${groups}</select>
        <label class="manage-on"><input type="checkbox" data-act="toggle" data-id="${s.id}"
          ${s.active ? 'checked' : ''}>启用</label>
        <div class="manage-cyc"><em>周期</em>${Setups.cycles.map(c => `
          <label><input type="checkbox" data-act="cycle" data-id="${s.id}" data-cycle="${c.id}"
            ${(s.cycles || []).includes(c.id) ? 'checked' : ''}>${this.esc(c.name)}</label>`).join('')}</div>
      </div>`).join('');

    // 回填下拉 (template 里不好写 selected)
    box.querySelectorAll('select[data-act="group"]').forEach(sel => {
      const s = Setups.byId(sel.dataset.id);
      if (s && sel.value !== s.group) sel.value = s.group;
      if (s && ![...sel.options].some(o => o.value === s.group)) {
        const o = document.createElement('option');
        o.value = s.group; o.textContent = s.group === '_nogroup' ? '未分组' : s.group;
        sel.appendChild(o); sel.value = s.group;
      }
    });

    // 新增区: 分组下拉跟着组列表走
    const gsel = document.getElementById('manageNewGroup');
    if (gsel) {
      const keep = gsel.value;
      gsel.innerHTML = Setups.groups.map(g =>
        `<option value="${g.id}">${this.esc(g.name)}</option>`).join('');
      if (keep && [...gsel.options].some(o => o.value === keep)) gsel.value = keep;
    }
  },

  /** 管理弹窗里新增 setup: 同时进全局库, 只勾给「进弹窗时选中的那个周期」
   *  (用户 2026-10-23 定) */
  manageAdd() {
    const inp = document.getElementById('manageNewName');
    const gsel = document.getElementById('manageNewGroup');
    const group = (gsel && gsel.value) || (Setups.groups[0] && Setups.groups[0].id) || 'other';
    const cyc = this._manageCycle || this.pendingCycle || null;
    const id = Setups.add(inp.value, group, cyc);
    if (!id) { this.toast('名称不能为空', true); return; }
    inp.value = '';
    this.syncManageList(); this.syncSetupModal();
    this.toast(cyc
      ? `已新增: ${Setups.name(id)} · 只勾给「${Setups.cycleName(cyc)}」`
      : `已新增: ${Setups.name(id)}（还没归到任何周期）`);
  },

  manageAddGroup() {
    const inp = document.getElementById('manageGroupName');
    if (!inp) return;
    const id = Setups.addGroup(inp.value);
    if (!id) { this.toast('分组名不能为空或重复', true); return; }
    inp.value = '';
    this.syncManageList(); this.syncSetupModal();
    this.toast('已新增分组: ' + Setups.groups.find(g => g.id === id).name);
  },

  /* ---------- 下单 ---------- */
  /* 只有「从空仓开新仓」才强制打标; 加仓/减仓都沿用本笔已有的 setup —— 一笔交易一个 setup */
  placeOrder(side) {
    if (!this.engine) { this.toast('请先开始复盘', true); return; }
    if (Trading.pos !== 0) { this._doPlaceOrder(side); return; }
    this.withSetup(() => this._doPlaceOrder(side));
  },

  _doPlaceOrder(side) {
    const cur = this.engine.current;
    const qty = Math.max(1, +document.getElementById('orderQty').value || 1);
    const wasPos = Trading.pos;
    const adding = wasPos !== 0 && ((wasPos > 0) === (side === 'buy'));
    const setupId = adding ? (Trading._posSetupId || null) : this.pendingSetup;
    const cycle = adding ? (Trading._posCycle || null) : this.pendingCycle;
    if (this.orderType === 'market') {
      Trading.fill(side, qty, cur.c, 'market', cur.epoch, cur.off,
                   { bar: cur, prev: this.prevBars(Trading.SL_LOOKBACK), setupId, cycle });
      this.toast(`${side === 'buy' ? '买入' : '卖出'} ${qty} 手 @ ${cur.c.toFixed(2)} · ` +
                 (adding ? '加仓' : (wasPos === 0 ? Setups.name(setupId) : '减仓')));
      if (wasPos === 0) this.consumeSetup();
      this.renderTrading();
      this.addMarker(side, cur.c);
    } else {
      const lp = +document.getElementById('limitPrice').value;
      if (!lp || lp <= 0) { this.toast('请输入有效限价', true); return; }
      if (!this._limits) this._limits = [];
      this._limits.push({ side, price: lp, qty, setupId, cycle });
      Trading._pendingLimits = true;
      this.toast(`限价${side === 'buy' ? '买入' : '卖出'} ${qty} 手 @ ${lp.toFixed(2)} 已挂单, 等待成交`);
      if (wasPos === 0) this.consumeSetup();
    }
  },

  /* 上/下键: 在当前这根 K 线的上/下沿外一个 tick 挂突破单
     上键 → 最高价 + 1 tick 上破买入 (止损买单); 下键 → 最低价 − 1 tick 下破卖出 (止损卖单)
     覆盖式: 同一方向只保留最新这一张, 连按不会堆一叠 (多/空各一张可以共存, 当 bracket 用)
     挂单时就把 tp/sl 机械性算好, 之后可以拖; 成交瞬间锁定成这一笔的初始风险 */
  stopOrderAtBarEdge(side) {
    if (!this.engine) { this.toast('请先开始复盘', true); return; }
    // 持仓中挂的反向单是用来平仓的, 不该再强制打标
    if (Trading.pos !== 0) { this._doStopOrderAtBarEdge(side); return; }
    this.withSetup(() => this._doStopOrderAtBarEdge(side));
  },

  _doStopOrderAtBarEdge(side) {
    const cur = this.engine.current;
    const tick = Trading.TICK || 0.25;
    const qty = Math.max(1, +document.getElementById('orderQty').value || 1);
    const px = side === 'buy' ? cur.h + tick : cur.l - tick;
    const price = Math.round(px * 100) / 100;                 // 去掉浮点毛刺, 保持 0.25 对齐
    const br = this.plannedBrackets(side, price, this.prevBars(Trading.SL_LOOKBACK));
    // 覆盖同方向旧单 (存活过的先记成撤销)
    const gone = Trading.stops.filter(s => s.side === side);
    Trading.stops = Trading.stops.filter(s => s.side !== side);
    if (gone.length) Trading._logOrders(gone, 'cancelled', cur.epoch, cur.off);
    const flat = Trading.pos === 0;
    Trading.placeStop(side, qty, price, {
      tp: br.tp, sl: br.sl,
      setupId: flat ? this.pendingSetup : (Trading._posSetupId || null),
      cycle: flat ? this.pendingCycle : (Trading._posCycle || null),
      placeEpoch: cur.epoch, placeTf: this.tf, placeTime: etTimeStr(cur.epoch, cur.off),
    });
    const replaced = gone.length;
    Draw.render();
    this.toast(`${side === 'buy' ? '上破' : '下破'} ${price.toFixed(2)} 挂突破${side === 'buy' ? '买' : '卖'} ${qty} 手` +
               ` · ${Setups.name(flat ? this.pendingSetup : Trading._posSetupId)}` +
               ` · 止损 ${br.sl.toFixed(2)} 止盈 ${br.tp.toFixed(2)}` +
               (replaced ? ` (已替换旧的 ${replaced} 张)` : '') + ' · 三条线都可拖');
    if (flat) this.consumeSetup();
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
        Trading.fill(o.side, o.qty, o.price, 'limit', bar.epoch, bar.off,
                     { bar, prev: this.prevBars(Trading.SL_LOOKBACK),
                       setupId: o.setupId, cycle: o.cycle });
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
    // prev = 入场那根之前的 5 根, 用来算"前 5 根极值"止损 (Trading.SL_LOOKBACK)
    const evs = Trading.checkBar(bar, bar.epoch, bar.off, { prev: this.prevBars(Trading.SL_LOOKBACK) });
    for (const ev of evs) {
      if (ev.type === 'fill') {
        this.toast(`突破${ev.side === 'buy' ? '买入' : '卖出'}成交 ${ev.qty} 手 @ ${ev.price.toFixed(2)}`);
        this.addMarker(ev.side, ev.price);
      } else if (ev.type === 'risk_locked') {
        // 初始风险锁定: 从这一刻起 R 的分母定了, 之后再挪止损/加仓都不改
        if (ev.risk != null) this.toast(`初始风险已锁定: ${ev.risk.toFixed(2)} 点 (R 的分母)`);
      } else if (ev.type === 'tp_extend') {
        // 开仓后第一根就扫到 2R → 2R 太近, 止盈改挂到入场K线另一侧
        this.toast(`2R 太近(下一根就扫到), 止盈已改挂到入场K线另一侧 ${ev.price.toFixed(2)}`);
      } else {
        const isTp = ev.kind === 'tp' || ev.kind === 'tp_extend';
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
    const p = this._ctxPrice;
    if (act === 'buyStop' || act === 'sellStop') {
      const side = act === 'buyStop' ? 'buy' : 'sell';
      if (Trading.pos !== 0) this._doStopOrderAtPrice(side, p);
      else this.withSetup(() => this._doStopOrderAtPrice(side, p));
    } else if (act === 'close') {
      this.closePosition();
    } else if (act === 'clearStops') {
      const cur = this.engine ? this.engine.current : null;
      const n = Trading.clearStops(cur ? cur.epoch : null, cur ? cur.off : null);
      Draw.render();
      this.toast(n ? `已撤销 ${n} 张挂单` : '当前没有挂单');
    } else if (act === 'clearBrackets') {
      Trading.tp = null; Trading.sl = null;
      Trading._tpMoved = true; Trading._slMoved = true;
      Trading.save(); Draw.render();
      this.toast('已清除止盈止损');
    }
  },

  /** 右键菜单里点的那个价位挂突破单 (同样先挂好 tp/sl) */
  _doStopOrderAtPrice(side, price) {
    const cur = this.engine.current;
    const qty = Math.max(1, +document.getElementById('orderQty').value || 1);
    const br = this.plannedBrackets(side, price, this.prevBars(Trading.SL_LOOKBACK));
    const flat = Trading.pos === 0;
    Trading.placeStop(side, qty, price, {
      tp: br.tp, sl: br.sl,
      setupId: flat ? this.pendingSetup : (Trading._posSetupId || null),
      cycle: flat ? this.pendingCycle : (Trading._posCycle || null),
      placeEpoch: cur.epoch, placeTf: this.tf, placeTime: etTimeStr(cur.epoch, cur.off),
    });
    Draw.render();
    this.toast(`${side === 'buy' ? '上破' : '下破'} ${price.toFixed(2)} 挂突破${side === 'buy' ? '买' : '卖'} ${qty} 手` +
               ` · ${Setups.name(flat ? this.pendingSetup : Trading._posSetupId)}` +
               ` · 止损 ${br.sl.toFixed(2)} 止盈 ${br.tp.toFixed(2)}`);
    if (flat) this.consumeSetup();
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
