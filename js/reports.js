/* ============ reports.js — E-mini 日报索引 (时间轴日期跳转) ============
 * 数据来自 `data/reports.json`, 由 tools/build_reports.py 从
 * `BTC_Emini日报索引.xlsx` 生成, 结构: { "YYYY-MM-DD": [url, 标题] }
 *
 * 只在用到时才拉(第一次画时间轴标记 / 第一次点时间轴),
 * 拉不到(没生成过 / file:// 直开)就退化成"全程不可点", 不影响其它功能。
 */
const Reports = {
  map: null,          // null = 还没拉过; {} = 拉过但没有/失败
  _loading: null,

  load() {
    if (this.map) return Promise.resolve(this.map);
    if (this._loading) return this._loading;
    this._loading = fetch('data/reports.json')
      .then(r => (r.ok ? r.json() : {}))
      .then(o => { this.map = (o && typeof o === 'object') ? o : {}; this._loading = null; return this.map; })
      .catch(() => { this.map = {}; this._loading = null; return this.map; });
    return this._loading;
  },

  ready() { return !!this.map; },

  /** ET 日期 "YYYY-MM-DD" → {u: url, t: 标题} | null */
  get(date) {
    const v = this.map && this.map[date];
    return Array.isArray(v) && v[0] ? { u: v[0], t: v[1] || '' } : null;
  },

  has(date) { return !!this.get(date); },

  /** 调试/统计用 */
  size() { return this.map ? Object.keys(this.map).length : 0; },
};
