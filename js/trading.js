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
  autoBracket: true,       // 新开仓自动挂 12/6 点止盈止损
  _stopSeq: 1,
  onChange: null,          // 状态变化回调

  load() {
    try {
      const s = localStorage.getItem('es_replay_trading');
      if (s) {
        const d = JSON.parse(s);
        this.trades = d.trades || []; this.pos = d.pos || 0;
        this.avg = d.avg || 0; this.realized = d.realized || 0;
        this.stops = d.stops || []; this.tp = d.tp ?? null; this.sl = d.sl ?? null;
        this._stopSeq = this.stops.reduce((m, s) => Math.max(m, s.id), 0) + 1;
      }
    } catch (e) { /* ignore */ }
  },

  save() {
    localStorage.setItem('es_replay_trading', JSON.stringify({
      trades: this.trades.slice(-200), pos: this.pos, avg: this.avg, realized: this.realized,
      stops: this.stops, tp: this.tp, sl: this.sl,
    }));
    this.onChange && this.onChange();
  },

  reset() {
    this.trades = []; this.pos = 0; this.avg = 0; this.realized = 0;
    this.stops = []; this.tp = null; this.sl = null;
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
  /** 开仓后设置默认保护: 止盈 2R / 止损 1R (ES 点数) */
  setAutoBrackets(entryPrice) {
    if (!this.autoBracket) return;
    const TP = 12, SL = 6;
    this.tp = this.pos > 0 ? entryPrice + TP : entryPrice - TP;
    this.sl = this.pos > 0 ? entryPrice - SL : entryPrice + SL;
  },

  /** 每根新 K 线: 先判突破单触发, 再判止盈止损 */
  checkBar(bar, epoch, off) {
    const ev = [];
    // 1) 突破单: 上破买 / 下破卖 (跳空则按开盘价成交, 更接近真实)
    if (this.stops.length) {
      const remain = [];
      for (const o of this.stops) {
        const hit = o.side === 'buy' ? bar.h >= o.price : bar.l <= o.price;
        if (hit) {
          const px = o.side === 'buy' ? Math.max(o.price, bar.o) : Math.min(o.price, bar.o);
          this.fill(o.side, o.qty, px, 'stop', epoch, off);
          ev.push({ type: 'fill', side: o.side, price: px, qty: o.qty });
        } else remain.push(o);
      }
      this.stops = remain;
    }
    // 2) 止盈 / 止损 (同一根内两者都触及时按止损优先, 保守处理)
    if (this.pos !== 0) {
      const qty = Math.abs(this.pos);
      const long = this.pos > 0;
      const closeSide = long ? 'sell' : 'buy';
      if (this.sl != null && (long ? bar.l <= this.sl : bar.h >= this.sl)) {
        const px = this.sl;                    // 先取值: fill() 平光后会把 sl 清成 null
        this.fill(closeSide, qty, px, 'stop_loss', epoch, off);
        ev.push({ type: 'exit', kind: 'sl', price: px, side: closeSide });
      } else if (this.tp != null && (long ? bar.h >= this.tp : bar.l <= this.tp)) {
        const px = this.tp;
        this.fill(closeSide, qty, px, 'take_profit', epoch, off);
        ev.push({ type: 'exit', kind: 'tp', price: px, side: closeSide });
      }
    }
    return ev;
  },

  /** 开/平仓成交 */
  fill(side, qty, price, type, epoch, off) {
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
    if (wasFlat && this.pos !== 0) this.setAutoBrackets(price);
    else if (this.pos === 0) { this.tp = null; this.sl = null; }
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
