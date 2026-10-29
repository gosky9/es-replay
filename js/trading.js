/* ============ trading.js — 模拟交易 (价格行为学: 突破单 / 结构位止盈止损 / Setup 记账) ============
 *
 * 一笔交易的生命周期 (2026-10-23 与用户对齐):
 *   空仓 → 下单(必选 setup + 市场周期) → 成交 → 机械挂 tp/sl
 *        → 入场当根内可自由拖 tp/sl → 进入下一根 K 线时「锁定初始风险」
 *        → 加仓(不改 R, 只加计数) → 回到空仓时结算成一条账本记录
 *   突破单: 挂单时就算好 tp/sl, 成交即锁定。
 *   超量下单(反手)已取消: 只平到现有仓位, 多出的部分丢弃并提示 —— 想反手就分两次做。
 */
const Trading = {
  MULT: 50,                // ES 1手 = $50/点
  TICK: 0.25,              // ES 最小跳动
  trades: [],              // 成交流水 {time, side, price, qty, type, pnl}
  pos: 0,                  // 净持仓 (+多 / -空)
  avg: 0,                  // 持仓均价
  realized: 0,             // 已实现盈亏(美元)
  stops: [],               // 突破单 {id, side, qty, price, tp, sl, setupId, cycle, placeEpoch, placeTf, barsAlive}
  tp: null,                // 止盈价 (null=未设)
  sl: null,                // 止损价 (null=未设)
  autoBracket: true,       // 新开仓自动挂止盈止损
  _stopSeq: 1,
  onChange: null,          // 状态变化回调

  /* ---------- 开仓保护口径 (用户 2026-10-22 定) ----------
       止损 = 前 5 根 K 线的极值外 1 个 tick (做多取最低点下方, 做空取最高点上方)
       止盈 = 入场价 ± 2 × 止损距离 (2R)
       如果开仓后的第一根就把 2R 扫掉(说明 2R 太近), 改用「入场K线另一侧」继续,
       这一根不平仓 —— 见 checkBar 里的 _tpGuard 分支。

     入场当根怎么判 (2026-10-27 用户批准方案 A):
       市价单成交在当根**收盘那一刻** → 当根没有剩余行情, 不判。
       突破单 / 限价单是在一根 K 线**之内**成交的 → 成交之后这跟剩下的一段照样会扫到止盈止损,
       由 App.settleEntryBarSub() 用 1 分钟数据算出 [成交那一分钟, 当根收盘) 的真实高低点,
       再调 checkExits(src, …, {isEntryBar:true}) 只判这一段。
       原来一刀切"入场当根不判", 结果 2026-10-27 用户那笔 5525.5 做空成交后
       10:21/10:22 两根 1 分钟都到 5519.50(止盈 5521.75), 却被跳过了。 */
  /* 止损取样: **前这么多根 + 入场那根**, 共 SL_LOOKBACK+1 根。
     v1.2.22 起把当前根算进来 —— 市价单成交在当根收盘, 那根本身就该参与极值;
     原来漏掉它会让约 9~13% 的单子止损落到入场价的错误一侧。
     之所以保留"前 5 根"再另加当前根(而不是挤掉最老那根): 后者实测会让 28% 的止损变紧。 */
  SL_LOOKBACK: 5,
  TP_R: 2,
  entryBar: null,          // 入场那根 K 线的 {h, l}
  _entryEpoch: null,       // 入场那根的时间
  _entryTrigger: null,     // 本笔是怎么成交的 {kind:'market'|'stop'|'limit', side, price}
  _entrySubDone: false,    // 入场当根"成交后那一段"是否已经走过止盈止损判定
  _tpGuard: false,         // true = 还没度过"开仓后第一根"

  /* ---------- 本笔交易的风险档案 ---------- */
  _entryPrice: null,       // 首次入场成交价
  _entryTime: '',          // 入场时间文字 (ET)
  _entrySide: null,        // 'long' | 'short'
  _posSetupId: null,       // 本笔 setup id
  _posCycle: null,         // 本笔市场周期 id
  _addOns: 0,              // 加仓次数
  _maxQty: 0,              // 本笔最大持仓手数
  _closeQty: 0,            // 累计平仓数量
  _closeSum: 0,            // Σ(平仓价 × 数量) —— 加权出场价用
  _pnlSum: 0,              // 本笔累计已实现美元
  _exitKind: null,         // 最后一笔平仓的原因: sl|tp|tp_extend|manual
  _tpMoved: false,         // 止盈被拖动过 (Draw 负责置位)
  _slMoved: false,         // 止损被拖动过
  riskPoints: null,        // 锁定的初始风险(点) = |入场价 − 初始止损|
  initTp: null,            // 锁定的初始止盈价
  initSl: null,            // 锁定的初始止损价
  _riskLocked: false,      // R 是否已锁定
  _sessionId: null,        // 这笔持仓属于哪一场复盘 (换了行情就不能再算数)

  /* ================= 持久化 ================= */
  /** 从 localStorage 恢复。
   *
   *  ⚠️ 持仓必须绑 sessionId —— 否则会死锁 (2026-10-23 用户报):
   *  上一段做到一半关掉页面, 重开后 pos 还留着, 但图表是空的:
   *  没价可平仓 → guardFlat() 挡住「重新开始复盘」和「结束复盘」→ 完全没法用。
   *  归属对不上(或老存档没有归属)就整笔丢掉: 这笔本来就没平、账本里也没有,
   *  扔掉不损失任何记录。 */
  load() {
    try {
      const s = localStorage.getItem('es_replay_trading');
      if (s) {
        const d = JSON.parse(s);
        // —— 归属校验: 不是本场的一律丢弃 ——
        const mine = (typeof App !== 'undefined') ? App.sessionId : null;
        if (mine && d._sessionId !== mine) {
          localStorage.removeItem('es_replay_trading');
          return;
        }
        this.trades = d.trades || []; this.pos = d.pos || 0;
        this.avg = d.avg || 0; this.realized = d.realized || 0;
        this.stops = d.stops || []; this.tp = d.tp ?? null; this.sl = d.sl ?? null;
        this.entryBar = d.entryBar || null; this._entryEpoch = d._entryEpoch ?? null;
        this._tpGuard = !!d._tpGuard;
        this._stopSeq = this.stops.reduce((m, s) => Math.max(m, s.id), 0) + 1;
        // 风险档案: 不存就等于关一次浏览器这笔没 R
        this._entryPrice = d._entryPrice ?? null;
        this._entryTime = d._entryTime || '';
        this._entrySide = d._entrySide || null;
        this._posSetupId = d._posSetupId || null;
        this._posCycle = d._posCycle || null;
        this._addOns = d._addOns || 0;
        this._maxQty = d._maxQty || 0;
        this._closeQty = d._closeQty || 0;
        this._closeSum = d._closeSum || 0;
        this._pnlSum = d._pnlSum || 0;
        this._exitKind = d._exitKind || null;
        this._tpMoved = !!d._tpMoved;
        this._slMoved = !!d._slMoved;
        this.riskPoints = d.riskPoints ?? null;
        this.initTp = d.initTp ?? null;
        this.initSl = d.initSl ?? null;
        this._riskLocked = !!d._riskLocked;
        this._sessionId = d._sessionId || mine;
        // 关浏览器时还没走完入场当根 → 重开后如果已经不在那一根, 立刻补锁
        if (this.pos !== 0 && !this._riskLocked && this._entryEpoch != null) {
          const cur = (typeof App !== 'undefined' && App.engine && App.engine.current) ? App.engine.current : null;
          if (cur && cur.epoch !== this._entryEpoch) this.lockRisk(cur.epoch);
        }
      }
    } catch (e) { /* ignore */ }
  },

  save() {
    this._sessionId = (typeof App !== 'undefined' && App.sessionId) || this._sessionId || null;
    localStorage.setItem('es_replay_trading', JSON.stringify({
      trades: this.trades.slice(-200), pos: this.pos, avg: this.avg, realized: this.realized,
      stops: this.stops, tp: this.tp, sl: this.sl,
      entryBar: this.entryBar, _entryEpoch: this._entryEpoch, _tpGuard: this._tpGuard,
      _entryPrice: this._entryPrice, _entryTime: this._entryTime, _entrySide: this._entrySide,
      _posSetupId: this._posSetupId, _posCycle: this._posCycle,
      _addOns: this._addOns, _maxQty: this._maxQty,
      _closeQty: this._closeQty, _closeSum: this._closeSum, _pnlSum: this._pnlSum,
      _exitKind: this._exitKind, _tpMoved: this._tpMoved, _slMoved: this._slMoved,
      riskPoints: this.riskPoints, initTp: this.initTp, initSl: this.initSl,
      _riskLocked: this._riskLocked, _sessionId: this._sessionId,
    }));
    this.onChange && this.onChange();
  },

  reset() {
    this.trades = []; this.pos = 0; this.avg = 0; this.realized = 0;
    this.stops = []; this.tp = null; this.sl = null;
    this.entryBar = null; this._entryEpoch = null; this._tpGuard = false;
    this._entryTrigger = null; this._entrySubDone = false;
    this._entryPrice = null; this._entryTime = ''; this._entrySide = null;
    this._posSetupId = null; this._posCycle = null;
    this._addOns = 0; this._maxQty = 0;
    this._closeQty = 0; this._closeSum = 0; this._pnlSum = 0;
    this._exitKind = null; this._tpMoved = false; this._slMoved = false;
    this.riskPoints = null; this.initTp = null; this.initSl = null;
    this._riskLocked = false;
    this._sessionId = (typeof App !== 'undefined' && App.sessionId) || null;
    localStorage.removeItem('es_replay_trading');
    this.onChange && this.onChange();
  },

  /* ================= 突破单 ================= */
  /** @param opts {tp, sl, setupId, cycle, placeEpoch, placeTf, placeTime}
   *  挂单时就把止盈止损算好 (用户 2026-10-23 要求), 成交后直接沿用。 */
  placeStop(side, qty, price, opts) {
    const o = {
      id: this._stopSeq++, side, qty, price,
      tp: (opts && opts.tp != null) ? opts.tp : null,
      sl: (opts && opts.sl != null) ? opts.sl : null,
      setupId: (opts && opts.setupId) || null,
      cycle: (opts && opts.cycle) || null,
      placeEpoch: (opts && opts.placeEpoch) || null,
      placeTf: (opts && opts.placeTf) || null,
      placeTime: (opts && opts.placeTime) || '',
      barsAlive: 0,
    };
    this.stops.push(o);
    this.save();
    return o;
  },

  /** 撤销挂单; 存活 ≥1 根的才进账本 (没点下一根就撤 = 视为没挂过) */
  removeStops(ids, epoch, off) {
    const set = new Set(ids);
    const gone = this.stops.filter(s => set.has(s.id));
    this.stops = this.stops.filter(s => !set.has(s.id));
    this._logOrders(gone, 'cancelled', epoch, off);
    this.save();
    return gone.length;
  },

  clearStops(epoch, off) {
    const n = this.stops.length;
    this._logOrders(this.stops, 'cancelled', epoch, off);
    this.stops = [];
    this.save();
    return n;
  },

  /** 把挂单的结局写进账本 (撤单/过期: 存活 <1 根的不记 —— 视为没挂过)
   *  但「成交」必须记: 挂上去下一根就打穿, 那也是真成交, 不能因为它活得太短就丢掉。 */
  _logOrders(list, status, epoch, off, fillInfo) {
    if (typeof Journal === 'undefined' || !Journal.loaded) return;
    for (const o of (list || [])) {
      if (status !== 'filled' && (o.barsAlive || 0) < 1) continue;
      Journal.addOrder({
        setupId: o.setupId, setupName: o.setupId ? Setups.name(o.setupId) : '',
        cycle: o.cycle, side: o.side, qty: o.qty, price: o.price,
        tp: o.tp, sl: o.sl, placeTf: o.placeTf, placeTime: o.placeTime,
        placeEpoch: o.placeEpoch, barsAlive: o.barsAlive || 0,
        status,
        endEpoch: epoch || null,
        endTime: (epoch != null && off != null) ? etTimeStr(epoch, off) : '',
        fillPrice: fillInfo ? fillInfo.price : null,
        fillEpoch: fillInfo ? fillInfo.epoch : null,
        fillTime: fillInfo ? fillInfo.time : '',
        sessionId: (typeof App !== 'undefined' && App.sessionId) || null,
      });
    }
  },

  /** 全清 (会话重开时用): 剩余挂单按 expired 归账 */
  expireStops(epoch, off) { this._logOrders(this.stops, 'expired', epoch, off); this.stops = []; },

  /* ================= 止盈止损 ================= */
  setAutoBrackets(entryPrice, prev, bar) {
    if (!this.autoBracket) return;
    const long = this.pos > 0;
    const tick = this.TICK || 0.25;
    let sl;
    if (prev && prev.length) {
      const lo = Math.min(...prev.map(b => b.l));
      const hi = Math.max(...prev.map(b => b.h));
      sl = long ? lo - tick : hi + tick;
    } else {
      sl = long ? entryPrice - 6 : entryPrice + 6;
    }
    let risk = Math.abs(entryPrice - sl);
    if (!(risk > 0)) {
      risk = 6;
      sl = long ? entryPrice - risk : entryPrice + risk;
    }
    this.sl = sl;
    this.tp = long ? entryPrice + risk * this.TP_R : entryPrice - risk * this.TP_R;
    this.entryBar = bar ? { h: bar.h, l: bar.l } : null;
    this._tpGuard = true;
  },

  /** 锁定本笔的「初始风险 / 初始止盈止损」
   *  触发时机: 进入下一根 K 线 (市价单) / 成交瞬间 (突破单, force=true)
   *  之后手动挪止损、加仓都不再重算 —— 分母恒定才能横向比较。 */
  lockRisk(epoch, force) {
    if (this.pos === 0 || this._riskLocked) return false;
    if (this._entryEpoch == null) return false;
    if (!force && (epoch == null || epoch === this._entryEpoch)) return false;
    const px = this._entryPrice;
    let risk = (px != null && this.sl != null) ? Math.abs(px - this.sl) : null;
    if (risk != null && risk < (this.TICK || 0.25) * 0.5) risk = null;   // 止损贴着入场价 → 无效
    this.riskPoints = risk;
    this.initTp = this.tp;
    this.initSl = this.sl;
    this._riskLocked = true;
    this.save();
    return true;
  },

  /* ================= 每根 K 线 ================= */
  checkBar(bar, epoch, off, ctx) {
    const ev = [];
    // 0) 进入新的一根 → 锁定市价单的初始风险
    if (this.pos !== 0 && !this._riskLocked && this._entryEpoch != null && epoch !== this._entryEpoch) {
      if (this.lockRisk(epoch)) ev.push({ type: 'risk_locked', risk: this.riskPoints });
    }

    // 1) 突破单: 上破买 / 下破卖 (跳空则按开盘价成交, 更接近真实)
    if (this.stops.length) {
      const remain = [];
      const curTf = (typeof ChartMgr !== 'undefined') ? ChartMgr.tf : null;
      for (const o of this.stops) {
        // 挂单只在自己被挂的周期上判定 —— 切去别的周期看行情不该触发
        if (o.placeTf && curTf && o.placeTf !== curTf) { remain.push(o); continue; }
        const hit = o.side === 'buy' ? bar.h >= o.price : bar.l <= o.price;
        if (hit) {
          const px = o.side === 'buy' ? Math.max(o.price, bar.o) : Math.min(o.price, bar.o);
          const gap = Math.abs(px - o.price) > (this.TICK || 0.25) * 0.5;
          const r = this.fill(o.side, o.qty, px, 'stop', epoch, off, {
            bar, prev: ctx && ctx.prev,
            setupId: o.setupId, cycle: o.cycle,
            planTp: o.tp, planSl: o.sl, gapEntry: gap,
            // 成交在当根之内 → 记下触发价, 好让 App 用 1 分钟数据还原"成交后那一段"
            entryTrigger: { kind: 'stop', side: o.side, price: o.price },
          });
          // closed 带上: 持仓中挂的反向突破单是用来平仓的, 盘面箭头要画成灰 (出场)
          ev.push({ type: 'fill', side: o.side, price: px, qty: o.qty, closed: r.closed });
          this._logOrders([o], 'filled', epoch, off,
            { price: px, epoch, time: etTimeStr(epoch, off) });
        } else {
          o.barsAlive = (o.barsAlive || 0) + 1;
          remain.push(o);
        }
      }
      this.stops = remain;
    }

    /* 2) 止盈 / 止损 —— 只判整根
       入场当根**成交之后的那一段**不在这里判: 它需要 1 分钟数据(异步),
       由 App.settleEntryBarSub() 算好后调 checkExits(), 见那个函数的注释。 */
    if (this.pos !== 0 && this._entryEpoch !== epoch) {
      for (const e of this.checkExits(bar, epoch, off, { isEntryBar: false })) ev.push(e);
    }
    return ev;
  },

  /** 止盈 / 止损判定本体。
   *
   *  src 只提供 {h, l} —— 谁来当 src 决定了"拿哪一段行情来判":
   *   · 平时 = 整根 K 线
   *   · 入场当根 = App 用 1 分钟数据算出的「成交那一分钟 → 当根收盘」那一段
   *     (整根的高低点不行: 成交之前的高/低跟这笔交易毫无关系, 会凭空判出止损)
   *  opts.isEntryBar: 入场当根不做 _tpGuard(2R 太近的延长), 那道保护留给真正的"下一根",
   *  口径与用户 2026-10-22 定的完全一致 —— 这里只是把漏掉的当根补上。
   */
  checkExits(src, epoch, off, opts) {
    const ev = [];
    if (this.pos === 0 || !src) return ev;
    const isEntryBar = !!(opts && opts.isEntryBar);
    const qty = Math.abs(this.pos);
    const long = this.pos > 0;
    const closeSide = long ? 'sell' : 'buy';
    const slHit = this.sl != null && (long ? src.l <= this.sl : src.h >= this.sl);
    let tpHit = this.tp != null && (long ? src.h >= this.tp : src.l <= this.tp);

    // 开仓后的第一根就把 2R 扫掉 → 2R 太近, 止盈改用「入场K线另一侧」, 这一根不平仓
    if (!isEntryBar && tpHit && this._tpGuard && this.entryBar) {
      const alt = long ? this.entryBar.h : this.entryBar.l;
      if (long ? alt > this.tp : alt < this.tp) {
        this.tp = alt;
        // 注意: 这里不置 _tpMoved —— 那是"用户手动拖过止盈"的标记, 自动改挂不算
        tpHit = false;
        ev.push({ type: 'tp_extend', price: alt });
        this.save();
      }
    }
    if (!isEntryBar) this._tpGuard = false;

    if (slHit) {
      const px = this.sl;
      this.fill(closeSide, qty, px, 'stop_loss', epoch, off, { bar: src, exitKind: 'sl' });
      ev.push({ type: 'exit', kind: 'sl', price: px, side: closeSide });
    } else if (tpHit) {
      const px = this.tp;
      // 出场原因统一是 tp; 「是不是初始止盈」由 _settle 里比 initTp 判定
      this.fill(closeSide, qty, px, 'take_profit', epoch, off, { bar: src, exitKind: 'tp' });
      ev.push({ type: 'exit', kind: 'tp', price: px, side: closeSide });
    }
    return ev;
  },

  /* ================= 成交 ================= */
  /** 开/平仓成交
   *  ctx: {bar, prev, setupId, cycle, planTp, planSl, gapEntry, exitKind, entryTrigger}
   *  返回 {pnl, closed, truncated} —— truncated>0 表示超量下单被截断 (反手已取消) */
  fill(side, qty, price, type, epoch, off, ctx) {
    ctx = ctx || {};
    const prevPos = this.pos;
    const wasFlat = prevPos === 0;
    const avgBefore = this.avg;
    let pnl = 0, closed = 0, opened = 0, truncated = 0;

    if (wasFlat) {
      opened = qty;
      this.pos = side === 'buy' ? qty : -qty;
      this.avg = price;
    } else {
      const sameDir = (prevPos > 0) === (side === 'buy');
      if (sameDir) {
        opened = qty;                                   // 加仓
        const n0 = Math.abs(prevPos);
        this.avg = (this.avg * n0 + price * opened) / (n0 + opened);
        this.pos = prevPos + (prevPos > 0 ? opened : -opened);
        this._addOns++;
      } else {
        const can = Math.abs(prevPos);
        closed = Math.min(qty, can);                    // 只平到现有仓位
        pnl = prevPos > 0 ? (price - this.avg) * closed * this.MULT
                          : (this.avg - price) * closed * this.MULT;
        this.pos = prevPos + (prevPos > 0 ? -closed : closed);
        this.realized += pnl;
        if (this.pos === 0) this.avg = 0;
        truncated = qty - closed;                       // 反手部分: 丢弃, 不开新仓
      }
    }

    this.trades.push({
      time: etTimeStr(epoch, off), side, price, qty, type,
      pnl: closed > 0 ? +pnl.toFixed(2) : null,
    });

    // 本笔累计
    if (closed > 0) {
      this._closeQty += closed;
      this._closeSum += price * closed;
      this._pnlSum += pnl;
      if (ctx.exitKind) this._exitKind = ctx.exitKind;
    }
    if (this.pos !== 0) this._maxQty = Math.max(this._maxQty || 0, Math.abs(this.pos));

    if (wasFlat && this.pos !== 0) {
      /* ---- 开新仓 ---- */
      this._entryEpoch = epoch;
      this._entryPrice = price;
      this._entryTime = etTimeStr(epoch, off);
      this._entrySide = this.pos > 0 ? 'long' : 'short';
      /* 成交方式: 突破单/限价单是"当根之内"成交的, App 要靠它判断要不要补判当根剩余行情
         (市价单成交在当根收盘那一刻, 当根没有剩余行情 → 不用补) */
      this._entryTrigger = ctx.entryTrigger || null;
      this._entrySubDone = false;
      this._posSetupId = ctx.setupId || (typeof App !== 'undefined' ? App.pendingSetup : null) || null;
      this._posCycle = ctx.cycle || (typeof App !== 'undefined' ? App.pendingCycle : null) || null;
      this._addOns = 0; this._maxQty = Math.abs(this.pos);
      this._closeQty = 0; this._closeSum = 0; this._pnlSum = 0;
      this._exitKind = null; this._tpMoved = false; this._slMoved = false;
      this.riskPoints = null; this.initTp = null; this.initSl = null; this._riskLocked = false;

      if (ctx.planSl != null) {
        // 突破单: 挂单时就算好了, 成交即锁定
        this.sl = ctx.planSl;
        this.tp = (ctx.planTp != null) ? ctx.planTp : null;
        this.entryBar = ctx.bar ? { h: ctx.bar.h, l: ctx.bar.l } : null;
        this._tpGuard = false;
        this.lockRisk(epoch, true);
      } else {
        this.setAutoBrackets(price, ctx.prev, ctx.bar);
      }
    } else if (this.pos === 0) {
      /* ---- 平光 → 结算成一条账本记录 ---- */
      this._settle(epoch, off, avgBefore, ctx);
      this.tp = null; this.sl = null;
      this.entryBar = null; this._entryEpoch = null; this._tpGuard = false;
      this._entryTrigger = null; this._entrySubDone = false;
      this._entryPrice = null; this._entryTime = ''; this._entrySide = null;
      this._posSetupId = null; this._posCycle = null;
      this._addOns = 0; this._maxQty = 0;
      this._closeQty = 0; this._closeSum = 0; this._pnlSum = 0;
      this._exitKind = null; this._tpMoved = false; this._slMoved = false;
      this.riskPoints = null; this.initTp = null; this.initSl = null; this._riskLocked = false;
    }
    this.save();
    return { pnl, closed, truncated };
  },

  /** 把刚平掉的一笔写进账本 */
  _settle(epoch, off, avgIn, ctx) {
    if (typeof Journal === 'undefined' || !Journal.loaded) return;
    const long = this._entrySide === 'long';
    const exitPrice = this._closeQty > 0 ? this._closeSum / this._closeQty : 0;
    const points = long ? (exitPrice - (avgIn || this._entryPrice || 0))
                        : ((avgIn || this._entryPrice || 0) - exitPrice);

    // 当根内就平掉 → R 从没锁定, 用当时的止损补算
    let risk = this.riskPoints;
    if (risk == null) {
      const slNow = this.initSl != null ? this.initSl : this.sl;
      if (slNow != null && this._entryPrice != null) risk = Math.abs(this._entryPrice - slNow);
    }
    const r = (risk && risk > 0) ? +(points / risk).toFixed(3) : null;

    let reason = this._exitKind || 'manual';
    if (reason === 'sl' && this._slMoved) reason = 'trail_sl';
    if (reason === 'tp' && this._tpMoved) reason = 'trail_tp';
    // 「拿到初始止盈」= 实际出场价比锁定的初始止盈还划算, 跟出场原因无关
    const tick = this.TICK || 0.25;
    const gotInitTp = !!(this.initTp != null &&
      (long ? exitPrice >= this.initTp - tick * 0.5 : exitPrice <= this.initTp + tick * 0.5));

    Journal.addTrade({
      sessionId: (typeof App !== 'undefined' && App.sessionId) || null,
      setupId: this._posSetupId || null,
      setupName: this._posSetupId ? Setups.name(this._posSetupId) : '',
      cycle: this._posCycle || null,
      side: long ? 'long' : 'short',
      tf: (typeof ChartMgr !== 'undefined' && ChartMgr.tf) || null,
      session: (typeof App !== 'undefined' && App.session) || null,
      entryTime: this._entryTime || '',
      /* 入场时刻的行情时间 (秒)。原来只存了 entryTime 这个**字符串**, 没有秒级时间戳,
         于是刷新页面后想按时间把入场箭头摆回原来那根 K 线上, 只能从 exitTime/exitEpoch
         反解时区偏移 (还必须恰好是 -4/-5 才敢用)。这里直接把 _entryEpoch 落盘, 一劳永逸;
         历史老记录缺失这个字段时, app.js 会退回用墙钟字符串解析 (见 _wallSec)。 */
      entryEpoch: this._entryEpoch || null,
      entryPrice: +(this._entryPrice || 0).toFixed(2),
      exitTime: (epoch != null && off != null) ? etTimeStr(epoch, off) : '',
      exitPrice: +exitPrice.toFixed(2),
      exitEpoch: epoch || null,
      qty: this._maxQty || 1,
      addOns: this._addOns || 0,
      points: +points.toFixed(2),
      riskPoints: (risk != null) ? +risk.toFixed(2) : null,
      r,
      usd: +this._pnlSum.toFixed(2),
      initTp: this.initTp,
      initSl: this.initSl,
      exitReason: reason,
      gotInitTp,
      gapEntry: !!(ctx && ctx.gapEntry),
      note: '',
    });
  },

  floatPnl(price) {
    if (this.pos === 0) return 0;
    return (this.pos > 0 ? (price - this.avg) : (this.avg - price)) * Math.abs(this.pos) * this.MULT;
  },

  totalPnl(price) { return this.realized + this.floatPnl(price); },

  /** 会话内的简单统计 (账本统计走 Journal) */
  stats() {
    const closedTrades = this.trades.filter(t => t.pnl != null);
    const wins = closedTrades.filter(t => t.pnl > 0).length;
    return {
      n: this.trades.length, closed: closedTrades.length, wins,
      winRate: closedTrades.length ? (wins / closedTrades.length * 100).toFixed(0) + '%' : '-',
    };
  },
};
