/* ============ trading.js — 模拟交易 ============ */
const Trading = {
  MULT: 50,                // ES 1手 = $50/点
  trades: [],              // {time, side, price, qty, type, pnl, closePrice}
  pos: 0,                  // 净持仓 (+多 / -空)
  avg: 0,                  // 持仓均价
  realized: 0,             // 已实现盈亏(美元)
  onChange: null,          // 状态变化回调

  load() {
    try {
      const s = localStorage.getItem('es_replay_trading');
      if (s) {
        const d = JSON.parse(s);
        this.trades = d.trades || []; this.pos = d.pos || 0;
        this.avg = d.avg || 0; this.realized = d.realized || 0;
      }
    } catch (e) { /* ignore */ }
  },

  save() {
    localStorage.setItem('es_replay_trading', JSON.stringify({
      trades: this.trades.slice(-200), pos: this.pos, avg: this.avg, realized: this.realized,
    }));
    this.onChange && this.onChange();
  },

  reset() {
    this.trades = []; this.pos = 0; this.avg = 0; this.realized = 0;
    localStorage.removeItem('es_replay_trading');
    this.onChange && this.onChange();
  },

  /** 开/平仓成交 */
  fill(side, qty, price, type, epoch, off) {
    // side: 'buy' | 'sell'
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
