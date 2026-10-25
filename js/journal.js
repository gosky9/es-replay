/* ============ journal.js — setup 清单 + 交易账本 (跨复盘会话, 永久) ============
 *
 * 两个对象:
 *   Setups  — setup 清单。内置来自 data/setups.json; 用户的改名/新增/停用存 localStorage
 *             覆盖层, 不改内置文件。id 恒定 —— 统计靠 id 聚合, 改名不影响历史。
 *   Journal — 账本。存两类数据:
 *             trades[] 「一笔交易」= 空仓 → 回到空仓, 统计的基本单位
 *             orders[] 突破挂单的记录(含未成交), 用来算触发率
 *
 * 落地三层:
 *   ① localStorage  — 即时, 关浏览器/关机都不丢
 *   ② data/journal.json — 自动写盘, 清缓存/换浏览器能整本读回
 *   ③ 手动导出 JSON/CSV
 * 冲突一律「按 id 去重合并」, 绝不覆盖。
 */
const Setups = {
  DB: 'es_replay_setups',
  base: null, over: null, list: [], cycles: [], groups: [], loaded: false,

  async load() {
    try {
      const r = await fetch('data/setups.json');
      this.base = r.ok ? await r.json() : null;
    } catch (e) { this.base = null; }
    if (!this.base || !this.base.setups) {
      this.base = {
        cycles: [{ id: 'breakout', name: '突破' }, { id: 'tight', name: '窄通道' },
                 { id: 'broad', name: '宽通道' }, { id: 'range', name: '区间' }],
        groups: [{ id: 'other', name: '其他' }],
        setups: [{ id: 'feel', name: '感觉', group: 'other',
                   cycles: ['breakout', 'tight', 'broad', 'range'] }],
      };
    }
    try { this.over = JSON.parse(localStorage.getItem(this.DB) || 'null'); } catch (e) { this.over = null; }
    this.rebuild();
    this.loaded = true;
  },

  rebuild() {
    const b = this.base || {};
    const ov = this.over || {};
    this.cycles = b.cycles || [];

    /* 组: 内置 → 覆盖层改名/新增 → 覆盖层删除
       (v1 的覆盖层没有 groups 字段, 走空数组, 老的改动照样生效) */
    const gmap = new Map();
    for (const g of (b.groups || [])) gmap.set(g.id, { id: g.id, name: g.name, builtin: true });
    for (const g of (ov.groups || [])) {
      if (!g || !g.id) continue;
      if (gmap.has(g.id)) { if (g.name != null) gmap.get(g.id).name = g.name; }
      else gmap.set(g.id, { id: g.id, name: g.name || g.id, builtin: false });
    }
    for (const gid of (ov.groupDel || [])) gmap.delete(gid);
    this.groups = [...gmap.values()];

    const map = new Map();
    for (const s of (b.setups || [])) {
      map.set(s.id, {
        id: s.id, name: s.name, group: s.group || 'other',
        cycles: Array.isArray(s.cycles) ? s.cycles.slice() : [],
        active: true, builtin: true,
      });
    }
    for (const s of (ov.list || [])) {
      if (!s || !s.id) continue;
      if (map.has(s.id)) {
        const t = map.get(s.id);
        if (s.name != null) t.name = s.name;
        if (s.group != null) t.group = s.group;
        if (s.active != null) t.active = !!s.active;
        if (Array.isArray(s.cycles)) t.cycles = s.cycles.slice();
      } else {
        map.set(s.id, {
          id: s.id, name: s.name || s.id, group: s.group || 'other',
          cycles: Array.isArray(s.cycles) ? s.cycles.slice() : [],
          active: s.active !== false, builtin: false,
        });
        if (!this.groups.some(g => g.id === (s.group || 'other'))) {
          this.groups.push({ id: s.group || 'other', name: s.group || '其他', builtin: false });
        }
      }
    }
    for (const id of (ov.deleted || [])) map.delete(id);
    this.list = [...map.values()];
  },

  _persist() {
    const b = this.base || {};
    const baseSetups = b.setups || [];
    const baseGroups = b.groups || [];
    const ov = { list: [], deleted: [], groups: [], groupDel: [] };

    for (const s of this.list) {
      const base = baseSetups.find(x => x.id === s.id);
      const cur = s.cycles || [];
      if (!base) {
        ov.list.push({ id: s.id, name: s.name, group: s.group, active: s.active, cycles: cur.slice() });
        continue;
      }
      const bcyc = Array.isArray(base.cycles) ? base.cycles : [];
      // 周期归属只比内容, 不比顺序 —— 换个添加顺序不算改动
      const cycSame = cur.length === bcyc.length && cur.every(c => bcyc.includes(c));
      const changed = base.name !== s.name || (base.group || 'other') !== s.group
        || !s.active || !cycSame;
      if (changed) {
        ov.list.push({ id: s.id, name: s.name, group: s.group, active: s.active, cycles: cur.slice() });
      }
    }

    for (const g of this.groups) {
      const bg = baseGroups.find(x => x.id === g.id);
      if (!bg) ov.groups.push({ id: g.id, name: g.name });
      else if (bg.name !== g.name) ov.groups.push({ id: g.id, name: g.name });
    }
    for (const bg of baseGroups) {
      if (!this.groups.some(g => g.id === bg.id)) ov.groupDel.push(bg.id);
    }

    this.over = ov;
    try { localStorage.setItem(this.DB, JSON.stringify(ov)); } catch (e) { }
  },

  byId(id) { return this.list.find(s => s.id === id) || null; },
  name(id) { const s = this.byId(id); return s ? s.name : (id || '未标注'); },
  active() { return this.list.filter(s => s.active); },
  cycleName(id) { const c = this.cycles.find(c => c.id === id); return c ? c.name : (id || '未标周期'); },

  /** 按组返回 [{group, items}] (全库, 只含启用的) —— 管理弹窗与左侧参考库用 */
  grouped() {
    const out = [];
    for (const g of this.groups) {
      const items = this.active().filter(s => s.group === g.id);
      if (items.length) out.push({ group: g, items });
    }
    const known = new Set(this.groups.map(g => g.id));
    const rest = this.active().filter(s => !known.has(s.group));
    if (rest.length) out.push({ group: { id: '_rest', name: '未分组' }, items: rest });
    return out;
  },

  /* ================= 市场周期 (v1.2: 4 个周期各存一份清单) ================= */
  /** 某个市场周期的清单 (启用 + 归属该周期) */
  forCycle(cycleId) {
    if (!cycleId) return [];
    return this.active().filter(s => (s.cycles || []).includes(cycleId));
  },

  /** 某周期按组排好: [{group, items}] */
  groupedFor(cycleId) {
    const items = this.forCycle(cycleId);
    const out = [];
    for (const g of this.groups) {
      const xs = items.filter(s => s.group === g.id);
      if (xs.length) out.push({ group: g, items: xs });
    }
    const known = new Set(this.groups.map(g => g.id));
    const rest = items.filter(s => !known.has(s.group));
    if (rest.length) out.push({ group: { id: '_rest', name: '未分组' }, items: rest });
    return out;
  },

  inCycle(id, cycleId) {
    const s = this.byId(id);
    return !!(s && (s.cycles || []).includes(cycleId));
  },

  /** 加进某个周期的清单 (不动其它周期) */
  addToCycle(id, cycleId) {
    const s = this.byId(id);
    if (!s || !cycleId) return false;
    if (!s.cycles) s.cycles = [];
    if (s.cycles.includes(cycleId)) return false;
    s.cycles.push(cycleId);
    this._persist(); return true;
  },

  /** 从某个周期的清单移除 (setup 本身还在库里, 别的周期不受影响) */
  removeFromCycle(id, cycleId) {
    const s = this.byId(id);
    if (!s || !cycleId) return false;
    const n = (s.cycles || []).length;
    s.cycles = (s.cycles || []).filter(c => c !== cycleId);
    if (s.cycles.length === n) return false;
    this._persist(); return true;
  },

  rename(id, name) {
    const s = this.byId(id); if (!s) return false;
    name = String(name || '').trim(); if (!name) return false;
    s.name = name; this._persist(); return true;
  },

  setActive(id, on) {
    const s = this.byId(id); if (!s) return false;
    s.active = !!on; this._persist(); return true;
  },

  setGroup(id, group) {
    const s = this.byId(id); if (!s) return false;
    if (!group) return false;
    s.group = group;
    if (!this.groups.some(g => g.id === group)) {
      this.groups.push({ id: group, name: group, builtin: false });
    }
    this._persist(); return true;
  },

  /** 新增 setup: 同时进全局库, 但只勾给当前周期 (用户 2026-10-23 定)
   *  这样以后在别的周期也能从左侧库点到它, 不用重敲一遍。 */
  add(name, group, cycleId) {
    name = String(name || '').trim(); if (!name) return null;
    const id = 'u_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
    const g = group || (this.groups[0] && this.groups[0].id) || 'other';
    this.list.push({
      id, name, group: g, active: true, builtin: false,
      cycles: cycleId ? [cycleId] : [],
    });
    if (!this.groups.some(x => x.id === g)) {
      this.groups.push({ id: g, name: g, builtin: false });
    }
    this._persist();
    return id;
  },

  /* ================= 组管理 (v1.2: 组名/组本身都可自定义) ================= */
  addGroup(name) {
    name = String(name || '').trim(); if (!name) return null;
    if (this.groups.some(g => g.name === name)) return null;   // 重名不加
    const id = 'g_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 5);
    this.groups.push({ id, name, builtin: false });
    this._persist();
    return id;
  },

  renameGroup(gid, name) {
    name = String(name || '').trim(); if (!name) return false;
    const g = this.groups.find(x => x.id === gid); if (!g) return false;
    g.name = name;
    this._persist(); return true;
  },

  /** 删组: 组里的 setup 一个都不删, 落到「未分组」等重新归位。
   *  返回受影响的 setup 个数。 */
  removeGroup(gid) {
    const i = this.groups.findIndex(x => x.id === gid);
    if (i < 0) return 0;
    let n = 0;
    for (const s of this.list) { if (s.group === gid) { s.group = '_nogroup'; n++; } }
    this.groups.splice(i, 1);
    this._persist();
    return n;
  },
};

const Journal = {
  DB: 'es_replay_journal',
  API: '/api/journal',
  data: { version: 1, trades: [], orders: [], deleted: [] },
  loaded: false,
  onChange: null,
  _posting: null, _dirty: false,

  uid(p) { return p + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6); },

  /** 反解场次 id 里藏着的「真实练习时间」(毫秒时间戳, UTC)。
   *
   *  场次 id 的生成规则 (见 app.js 里三处 `'S' + Date.now()...`):
   *      'S' + Date.now().toString(36) + 3 位随机码
   *  所以去掉头尾各几位、按 36 进制解析, 拿到的就是创建这一场时的毫秒时间。
   *
   *  为什么需要它: 账本里每笔只有 exitTime / exitEpoch, 那是**行情时间**(K 线时间),
   *  不是"我什么时候练的"。今天练 2009 年的行情, exitEpoch 会是很久以前,
   *  光靠它没法把场次按练习先后排出来。
   *
   *  拿不准就返回 null (宁可退回用行情时间排, 也不要显示一个荒唐的年份):
   *  解析出来不在 2017~2096 之间的一律当无效。 */
  sessionAt(sid) {
    if (!sid || typeof sid !== 'string' || sid[0] !== 'S' || sid.length < 6) return null;
    const ms = parseInt(sid.slice(1, -3), 36);
    if (!isFinite(ms) || ms < 1.5e12 || ms > 4e12) return null;
    return ms;
  },

  /** 读账本: localStorage 与磁盘取并集 (按 id 去重) */
  async load() {
    let local = null, disk = null;
    try { local = JSON.parse(localStorage.getItem(this.DB) || 'null'); } catch (e) { local = null; }
    try {
      const r = await fetch(this.API, { cache: 'no-store' });
      if (r.ok) disk = await r.json();
    } catch (e) { disk = null; }
    this.data = this._merge(this._norm(local), this._norm(disk));
    this.loaded = true;
    this._writeLocal();
    this.onChange && this.onChange();
    return this.data;
  },

  _norm(d) {
    if (!d || typeof d !== 'object') return { version: 1, trades: [], orders: [], deleted: [] };
    return {
      version: d.version || 1,
      trades: Array.isArray(d.trades) ? d.trades : [],
      orders: Array.isArray(d.orders) ? d.orders : [],
      /* 墓碑: 已经删掉的 id。合并时永远过滤掉它们。
         没有这一层的话, 删掉一条只是从磁盘消失了, 而浏览器 localStorage 里那条还在,
         下次 load() 的「并集」会把它原样带回来 —— 用户会以为删除根本没生效
         (2026-10-25 清那 9 笔测试残留时就踩到了)。 */
      deleted: Array.isArray(d.deleted) ? d.deleted.filter(x => typeof x === 'string') : [],
    };
  },

  /** 按 id 去重合并; 同 id 以 b 为准 (导入/磁盘通常更新)。墓碑取并集, 且优先于一切记录 */
  _merge(a, b) {
    const gone = new Set([...(a.deleted || []), ...(b.deleted || [])]);
    const out = { version: 1, trades: [], orders: [], deleted: [...gone] };
    for (const k of ['trades', 'orders']) {
      const m = new Map();
      for (const r of (a[k] || [])) if (r && r.id && !gone.has(r.id)) m.set(r.id, r);
      for (const r of (b[k] || [])) if (r && r.id && !gone.has(r.id)) m.set(r.id, r);
      out[k] = [...m.values()];
    }
    out.trades.sort((x, y) => (x.exitEpoch || 0) - (y.exitEpoch || 0));
    out.orders.sort((x, y) => (x.placeEpoch || 0) - (y.placeEpoch || 0));
    return out;
  },

  addTrade(rec) {
    const t = Object.assign({ id: this.uid('T') }, rec);
    this.data.trades.push(t);
    this.data.trades.sort((x, y) => (x.exitEpoch || 0) - (y.exitEpoch || 0));
    this.save();
    return t;
  },

  addOrder(rec) {
    const o = Object.assign({ id: this.uid('O') }, rec);
    this.data.orders.push(o);
    this.data.orders.sort((x, y) => (x.placeEpoch || 0) - (y.placeEpoch || 0));
    this.save();
    return o;
  },

  /** 关浏览器不丢的即时层; 磁盘写是异步的, 失败静默 */
  save() {
    this._writeLocal();
    this._post();
    this.onChange && this.onChange();
  },

  _writeLocal() {
    try { localStorage.setItem(this.DB, JSON.stringify(this.data)); } catch (e) { }
  },

  _post() {
    if (this._posting) { this._dirty = true; return this._posting; }
    this._dirty = false;
    this._posting = fetch(this.API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(this.data),
    }).catch(() => { }).then(() => {
      this._posting = null;
      if (this._dirty) return this._post();
    });
    return this._posting;
  },

  /** 取要统计的交易; last>0 时只取最近 last 笔 */
  pick(opts) {
    opts = opts || {};
    let list = this.data.trades.slice();
    if (opts.setupId) list = list.filter(t => t.setupId === opts.setupId);
    if (opts.cycle) list = list.filter(t => t.cycle === opts.cycle);
    if (opts.last > 0) list = list.slice(-opts.last);
    return list;
  },

  /** 聚合一组交易 → 统计行 */
  agg(list) {
    let n = 0, wins = 0, losses = 0, flats = 0, sumR = 0, sumUsd = 0;
    for (const t of list) {
      n++;
      sumUsd += (t.usd || 0);
      const r = t.r;
      if (r == null || !isFinite(r)) continue;
      sumR += r;
      if (r > 0.0001) wins++;
      else if (r < -0.0001) losses++;
      else flats++;
    }
    const rn = wins + losses + flats;
    return {
      n, rn, wins, losses, flats, sumUsd,
      winRate: rn ? wins / rn * 100 : null,
      avgR: rn ? sumR / rn : null,
      totalR: rn ? sumR : null,
    };
  },

  /** 挂单统计 */
  orderStats(list) {
    let filled = 0, cancelled = 0, expired = 0;
    for (const o of list) {
      if (o.status === 'filled') filled++;
      else if (o.status === 'cancelled') cancelled++;
      else if (o.status === 'expired') expired++;
    }
    const total = filled + cancelled + expired;
    return { total, filled, cancelled, expired, hitRate: total ? filled / total * 100 : null };
  },

  /* ---------- 导出 ---------- */
  _csvCell(v) {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  },

  /** 数字不带正号 —— Excel 会把 "+1.4" 当文本, 不参与计算 */
  _num(v, dp) {
    if (v == null || !isFinite(v)) return '';
    const n = dp == null ? v : +Number(v).toFixed(dp);
    return String(n);
  },

  tradesCSV() {
    const H = ['交易ID', '会话', 'Setup', '市场周期', '方向', '周期', '时段',
      '入场时间', '入场价', '出场时间', '出场价', '手数', '加仓次数',
      '点数', '初始风险(点)', 'R', '美元',
      '初始止盈', '初始止损', '出场原因', '拿到初始止盈', '跳空成交', '备注'];
    const rows = this.data.trades.map(t => [
      t.id, t.sessionId, t.setupName || Setups.name(t.setupId), Setups.cycleName(t.cycle),
      t.side === 'long' ? '多' : '空', t.tf, (t.session || '').toUpperCase(),
      t.entryTime, this._num(t.entryPrice, 2), t.exitTime, this._num(t.exitPrice, 2),
      t.qty, t.addOns || 0,
      this._num(t.points, 2), this._num(t.riskPoints, 2), this._num(t.r, 2), this._num(t.usd, 2),
      this._num(t.initTp, 2), this._num(t.initSl, 2), t.exitReason || '',
      t.gotInitTp ? '是' : '否', t.gapEntry ? '是' : '否', t.note || '',
    ]);
    return [H, ...rows].map(r => r.map(c => this._csvCell(c)).join(',')).join('\r\n');
  },

  ordersCSV() {
    const H = ['挂单ID', '会话', 'Setup', '市场周期', '方向', '周期', '挂单时间', '挂单价',
      '止盈', '止损', '手数', '存活根数', '结局', '成交时间', '成交价'];
    const rows = this.data.orders.map(o => [
      o.id, o.sessionId, o.setupName || Setups.name(o.setupId), Setups.cycleName(o.cycle),
      o.side === 'buy' ? '买' : '卖', o.placeTf, o.placeTime, this._num(o.price, 2),
      this._num(o.tp, 2), this._num(o.sl, 2), o.qty, o.barsAlive || 0,
      o.status === 'filled' ? '成交' : (o.status === 'cancelled' ? '撤销' : '未触发'),
      o.fillTime || '', this._num(o.fillPrice, 2),
    ]);
    return [H, ...rows].map(r => r.map(c => this._csvCell(c)).join(',')).join('\r\n');
  },

  _download(name, text, mime) {
    const blob = new Blob(['\ufeff' + text], { type: mime + ';charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  },

  exportCSV() {
    const d = new Date().toISOString().slice(0, 10);
    this._download('journal_trades_' + d + '.csv', this.tradesCSV(), 'text/csv');
  },

  exportOrdersCSV() {
    const d = new Date().toISOString().slice(0, 10);
    this._download('journal_orders_' + d + '.csv', this.ordersCSV(), 'text/csv');
  },

  exportJSON() {
    const d = new Date().toISOString().slice(0, 10);
    this._download('journal_' + d + '.json', JSON.stringify(this.data, null, 2), 'application/json');
  },

  /** 导入: 按 id 合并, 同 id 以导入的为准 */
  async importJSON(file) {
    const text = await file.text();
    let obj;
    try { obj = JSON.parse(text); } catch (e) { return { ok: false, err: '不是合法的 JSON' }; }
    obj = this._norm(obj);
    if (!obj.trades.length && !obj.orders.length) return { ok: false, err: '文件里没有交易记录' };
    const before = this.data.trades.length + this.data.orders.length;
    this.data = this._merge(this.data, obj);
    const after = this.data.trades.length + this.data.orders.length;
    this.save();
    return { ok: true, added: after - before, total: after };
  },

  /** 删掉指定的交易/挂单 (按 id), 返回实际删掉的条数。
   *
   *  被删的 id 记进墓碑 `deleted`, 合并时永远过滤 —— 否则浏览器 localStorage 里
   *  那份会在下次 load() 的并集里把它们原样带回来 (删了又回来)。
   *  目前只在「清理测试残留」这类脚本里调用, 界面上没有单条删除的入口。 */
  purge(ids) {
    const set = new Set((ids || []).filter(x => typeof x === 'string'));
    if (!set.size) return 0;
    const before = this.data.trades.length + this.data.orders.length;
    this.data.deleted = [...new Set([...(this.data.deleted || []), ...set])];
    this.data.trades = this.data.trades.filter(t => !set.has(t.id));
    this.data.orders = this.data.orders.filter(o => !set.has(o.id));
    const after = this.data.trades.length + this.data.orders.length;
    this.save();
    return before - after;
  },

  clear() {
    this.data = { version: 1, trades: [], orders: [], deleted: [] };
    this.save();
  },
};
