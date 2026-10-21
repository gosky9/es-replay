/* ============ trading.js — 模拟交易 (含价格行为学的突破单/止盈止损) ============ */
const Trading = {
  MULT: 50,                // ES 1手 = $50/点
  TICK: 0.25,              // ES 最小跳动
  trades: [],              // {time, side, price, qty, type, pnl}
  pos: 0,                  // 净持仓 (+多 / -空)
  avg: 0,                  // 持仓均价
  realized: 0,             // 已实现盈亏(美元)
  stops: [],               // 突破单 {id, side, qty, price} — 价格穿越 price 即成交
  tp: null,                // 止盈价 (null=未设)
  sl: null,                // 止损价 (null=未设)
  autoBracket: true,       // 新开仓自动挂止盈止损
  _stopSeq: 1,
  onChange: null,          // 状态变化回调

  /* ---------- 开仓保护口径 (用户 2026-10-22 定) ----------
     原来是死板的 止损 6 点 / 止盈 12 点, 遇到大波动行情刚开单下一根就被扫掉。
     现在:
       止损 = 前 5 根 K 线的极值外 1 个 tick (做多取最低点下方, 做空取最高点上方)
       止盈 = 入场价 ± 2 × 止损距离 (2R)
       如果开仓后的第一根就把 2R 扫掉(说明 2R 太近), 改用「入场K线另一侧」继续,
       这一根不平仓 —— 见 checkBar 里的 _tpGuard 分支。
     入场那根 K 线本身不判止盈止损: 刚成交就在同一根里被扫, 等于没给行情走的机会。 */
  SL_LOOKBACK: 5,
  TP_R: 2,
  entryBar: null,          // 入场那根 K 线的 {h, l} — 止盈改结构位时要用
  _entryEpoch: null,       // 入场那根的时间, 用来跳过入场当根的判定
  _tpGuard: false,         // true = 还没度过"开仓后第一根"

  load() {
    try {
      const s = localStorage.getItem('es_replay_trading');
      if (s) {
        const d = JSON.parse(s);
        this.trades = d.trades || []; this.pos = d.pos || 0;
        this.avg = d.avg || 0; this.realized = d.realized || 0;
        this.stops = d.stops || []; this.tp = d.tp ?? null; this.sl = d.sl ?? null;
        this.entryBar = d.entryBar || null; this._entryEpoch = d._entryEpoch ?? null;
        this._tpGuard = !!d._tpGuard;
        this._stopSeq = this.stops.reduce((m, s) => Math.max(m, s.id), 0) + 1;
      }
    } catch (e) { /* ignore */ }
  },

  save() {
    localStorage.setItem('es_replay_trading', JSON.stringify({
      trades: this.trades.slice(-200), pos: this.pos, avg: this.avg, realized: this.realized,
      stops: this.stops, tp: this.tp, sl: this.sl,
      entryBar: this.entryBar, _entryEpoch: this._entryEpoch, _tpGuard: this._tpGuard,
    }));
    this.onChange && this.onChange();
  },

  reset() {
    this.trades = []; this.pos = 0; this.avg = 0; this.realized = 0;
    this.stops = []; this.tp = null; this.sl = null;
    this.entryBar = null; this._entryEpoch = null; this._tpGuard = false;
    localStorage.removeItem('es_replay_trading');
    this.onChange && this.onChange();
  },

  /* ---------- 突破单 ---------- */
  placeStop(side, qty, price) {
    const o = { id: this._stopSeq++, side, qty, price };
    this.stops.push(o);
    this.save();
    return o;
  },

  clearStops() { const n = this.stops.length; this.stops = []; this.save(); return n; },

  /* ---------- 止盈止损 ---------- */
  /** 开仓后设置默认保护 (口径见文件头 SL_LOOKBACK / TP_R)
   *  @param entryPrice 成交价
   *  @param prev       入场 K 线之前的 K 线数组 (取最后 5 根算极值)
   *  @param bar        入场 K 线本身 (记 h/l, 供"止盈改结构位"用)
   */
  setAutoBrackets(entryPrice, prev, bar) {
    if (!this.autoBracket) return;
    const long = this.pos > 0;
    const tick = this.TICK || 0.25;
    let sl;
    if (prev && prev.length) {
      const lo = Math.min(...prev.map(b => b.l));
      const hi = Math.max(...prev.map(b => b.h));
      sl = long ? lo - tick : hi + tick;          // 极值外一个 tick
    } else {
      sl = long ? entryPrice - 6 : entryPrice + 6; // 没有参照 K 线时退回 6 点
    }
    let risk = Math.abs(entryPrice - sl);
    if (!(risk > 0)) {                            // 极值正好压着成交价 → 别挂零距离止损
      risk = 6;
      sl = long ? entryPrice - risk : entryPrice + risk;
    }
    this.sl = sl;
    this.tp = long ? entryPrice + risk * this.TP_R : entryPrice - risk * this.TP_R;
    this.entryBar = bar ? { h: bar.h, l: bar.l } : null;
    this._tpGuard = true;                         // 等"开仓后第一根"来验一次
  },

  /** 每根新 K 线: 先判突破单触发, 再判止盈止损
   *  @param ctx {prev} 入场那根之前的 K 线, 供 setAutoBrackets 用 */
  checkBar(bar, epoch, off, ctx) {
    const ev = [];
    // 1) 突破单: 上破买 / 下破卖 (跳空则按开盘价成交, 更接近真实)
    if (this.stops.length) {
      const remain = [];
      for (const o of this.stops) {
        const hit = o.side === 'buy' ? bar.h >= o.price : bar.l <= o.price;
        if (hit) {
          const px = o.side === 'buy' ? Math.max(o.price, bar.o) : Math.min(o.price, bar.o);
          this.fill(o.side, o.qty, px, 'stop', epoch, off, { bar, prev: ctx && ctx.prev });
          ev.push({ type: 'fill', side: o.side, price: px, qty: o.qty });
        } else remain.push(o);
      }
      this.stops = remain;
    }
    // 2) 止盈 / 止损 —— 入场当根不判 (刚成交就在同一根里被扫 = 没给行情走的机会)
    if (this.pos !== 0 && this._entryEpoch !== epoch) {
      const qty = Math.abs(this.pos);
      const long = this.pos > 0;
      const closeSide = long ? 'sell' : 'buy';
      const slHit = this.sl != null && (long ? bar.l <= this.sl : bar.h >= this.sl);
      let tpHit = this.tp != null && (long ? bar.h >= this.tp : bar.l <= this.tp);

      // 开仓后的第一根就把 2R 扫掉 → 2R 太近(多半是前 5 根贴着入场价, 止损距离很小),
      // 止盈改用「入场K线另一侧」, 这一根不平仓
      if (tpHit && this._tpGuard && this.entryBar) {
        const alt = long ? this.entryBar.h : this.entryBar.l;
        if (long ? alt > this.tp : alt < this.tp) {
          this.tp = alt;
          tpHit = false;
          ev.push({ type: 'tp_extend', price: alt });
          this.save();
        }
      }
      this._tpGuard = false;                      // 只保护开仓后的第一根

      // 同一根内两者都触及时按止损优先 (保守处理)
      if (slHit) {
        const px = this.sl;                    // 先取值: fill() 平光后会把 sl 清成 null
        this.fill(closeSide, qty, px, 'stop_loss', epoch, off, { bar });
        ev.push({ type: 'exit', kind: 'sl', price: px, side: closeSide });
      } else if (tpHit) {
        const px = this.tp;
        this.fill(closeSide, qty, px, 'take_profit', epoch, off, { bar });
        ev.push({ type: 'exit', kind: 'tp', price: px, side: closeSide });
      }
    }
    return ev;
  },

  /** 开/平仓成交 */
  fill(side, qty, price, type, epoch, off, ctx) {
    // side: 'buy' | 'sell'
    const wasFlat = this.pos === 0;
    let pnl = 0, closed = 0;
    if (side === 'buy') {
      if (this.pos < 0) {                       // 平空
        closed = Math.min(qty, -this.pos);
        pnl = (this.avg - price) * closed * this.MULT;
        this.pos += closed; this.realized += pnl;
        if (this.pos === 0) this.avg = 0;
      }
      const openQty = qty - closed;
      if (openQty > 0) {
        if (this.pos > 0) this.avg = (this.avg * this.pos + price * openQty) / (this.pos + openQty);
        else this.avg = price;
        this.pos += openQty;
      }
    } else {                                    // sell
      if (this.pos > 0) {                       // 平多
        closed = Math.min(qty, this.pos);
        pnl = (price - this.avg) * closed * this.MULT;
        this.pos -= closed; this.realized += pnl;
        if (this.pos === 0) this.avg = 0;
      }
      const openQty = qty - closed;
      if (openQty > 0) {
        if (this.pos < 0) this.avg = (this.avg * (-this.pos) + price * openQty) / (-this.pos + openQty);
        else this.avg = price;
        this.pos -= openQty;
      }
    }
    this.trades.push({
      time: etTimeStr(epoch, off), side, price, qty, type,
      pnl: closed > 0 ? +pnl.toFixed(2) : null,
    });
    // 仓位变化时维护止盈止损: 新开仓→自动挂, 平光→清空
    if (wasFlat && this.pos !== 0) {
      this._entryEpoch = epoch;
      this.setAutoBrackets(price, ctx && ctx.prev, ctx && ctx.bar);
    } else if (this.pos === 0) {
      this.tp = null; this.sl = null;
      this.entryBar = null; this._entryEpoch = null; this._tpGuard = false;
    }
    this.save();
    return { pnl, closed };
  },

  floatPnl(price) {
    if (this.pos === 0) return 0;
    return (this.pos > 0 ? (price - this.avg) : (this.avg - price)) * Math.abs(this.pos) * this.MULT;
  },

  totalPnl(price) { return this.realized + this.floatPnl(price); },

  stats() {
    const closedTrades = this.trades.filter(t => t.pnl != null);
    const wins = closedTrades.filter(t => t.pnl > 0).length;
    return {
      n: this.trades.length, closed: closedTrades.length, wins,
      winRate: closedTrades.length ? (wins / closedTrades.length * 100).toFixed(0) + '%' : '-',
    };
  },
};
