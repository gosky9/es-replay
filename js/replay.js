/* ============ replay.js — 回放引擎 ============ */
class ReplayEngine {
  /**
   * @param {Array} bars 全部K线(含未来), 每根 {t,o,h,l,c,v,ema,epoch,off}
   * @param {number} startIdx 起始已播放下标(此下标及之前可见)
   */
  constructor(bars, startIdx) {
    this.bars = bars;
    this.idx = startIdx;
    this.playing = false;
    this.speed = 2;
    this.baseInterval = 1000;     // ms / 1x (TradingView 语义: 1x ≈ 1 根/秒)
    this._timer = null;
    this.onTick = null;           // (bar, idx, isNew) => void
    this.onState = null;          // () => void
    this.onEnd = null;
  }

  get total() { return this.bars.length; }
  get played() { return this.idx + 1; }
  get current() { return this.bars[this.idx]; }

  play() {
    if (this.playing) return;
    if (this.idx >= this.bars.length - 1) { this.restart(); }
    this.playing = true;
    this._schedule();
    this.onState && this.onState();
  }

  _schedule() {
    clearTimeout(this._timer);
    const iv = Math.max(16, this.baseInterval / this.speed);
    this._timer = setTimeout(() => this._tick(), iv);
  }

  _tick() {
    if (!this.playing) return;
    if (this.idx >= this.bars.length - 1) {
      this.pause();
      this.onEnd && this.onEnd();
      return;
    }
    this.idx++;
    const bar = this.bars[this.idx];
    this.onTick && this.onTick(bar, this.idx, true);
    this.onState && this.onState();
    this._schedule();
  }

  pause() {
    this.playing = false;
    clearTimeout(this._timer);
    this.onState && this.onState();
  }

  toggle() { this.playing ? this.pause() : this.play(); }

  step(dir) {
    this.pause();
    const ni = this.idx + dir;
    if (ni < 0 || ni >= this.bars.length) return;
    this.idx = ni;
    this.onTick && this.onTick(this.bars[ni], ni, false);
    this.onState && this.onState();
  }

  seek(idx) {
    this.pause();
    idx = Math.max(0, Math.min(this.bars.length - 1, idx));
    if (idx === this.idx) return;
    const forward = idx > this.idx;
    this.idx = idx;
    this.onTick && this.onTick(this.bars[idx], idx, !forward);
    this.onState && this.onState();
  }

  restart() {
    this.pause();
    this.idx = Math.max(0, this._startIdx);
    this.onTick && this.onTick(this.bars[this.idx], this.idx, false);
    this.onState && this.onState();
  }

  setSpeed(s) { this.speed = s; if (this.playing) this._schedule(); }

  /** 记录初始起点(供 restart 用) */
  markStart(idx) { this._startIdx = idx; this.idx = idx; }

  destroy() { clearTimeout(this._timer); this.playing = false; }
}
