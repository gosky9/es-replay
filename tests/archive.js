/* 测试脚本的存档还原工具。
 *
 * 为什么需要它（2026-10-25 血案）：
 *   e2e / 视觉自检都会「备份 → 清空 → 跑 → 还原」，而还原以前是**直接覆盖**。
 *   于是只要用户在测试跑着的时候（或备份之后、还没落盘的时候）自己做了交易，
 *   下一次还原就把它整条抹掉 —— 当天真的丢了 3 笔（17:18~17:23 那段只存在于浏览器
 *   localStorage，磁盘上从来没有过，却在我还原磁盘时被一起当成"测试产物"清了）。
 *
 * 判据：交易/挂单的 id 就是 `T-` / `O-` + `Date.now().toString(36)`，可以直接解出
 * 创建毫秒。凡是**创建时间早于本次开跑**的记录，绝不可能是本轮测试产生的 → 一律保留。
 * （测试自己造的记录创建时间必然在开跑之后，所以照样被还原覆盖掉。）
 *
 * 绘图存档（{byTf}）不走这套：图元 id 是自增序号，解不出时间；而且画错了随手删掉就行，
 * 丢一张线的代价远小于留一堆测试线，所以还是整桶覆盖。
 */

/** 从 T-/O- 开头的 id 里解出创建毫秒（解析失败返回 NaN） */
function born(id) {
  if (typeof id !== 'string') return NaN;
  const i = id.indexOf('-');
  if (i < 0) return NaN;
  const n = parseInt(id.slice(i + 1), 36);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * @param {{trades?:Array,orders?:Array}} backup  开跑前备份的账本
 * @param {{trades?:Array,orders?:Array}} current 现在的磁盘账本
 * @param {number} runStart 本轮开跑的毫秒时间戳
 * @returns {{version:number,trades:Array,orders:Array}}
 */
function mergeJournal(backup, current, runStart) {
  /* 墓碑 (已删掉的 id) 也要并集: 还原时把 deleted 弄丢, 等于把用户删掉的记录放回去 */
  const gone = new Set([...((backup && backup.deleted) || []), ...((current && current.deleted) || [])]);
  const out = { version: 1, trades: [], orders: [], deleted: [...gone] };
  for (const k of ['trades', 'orders']) {
    const m = new Map();
    for (const r of ((backup && backup[k]) || [])) if (r && r.id && !gone.has(r.id)) m.set(r.id, r);
    for (const r of ((current && current[k]) || [])) {
      if (!r || !r.id || m.has(r.id) || gone.has(r.id)) continue;
      const t = born(r.id);
      // 解不出时间的也留着: 宁可多留一条, 不要少一条用户的记录
      if (!Number.isFinite(t) || t < runStart) m.set(r.id, r);
    }
    out[k] = [...m.values()];
  }
  out.trades.sort((a, b) => (a.exitEpoch || 0) - (b.exitEpoch || 0));
  out.orders.sort((a, b) => (a.placeEpoch || 0) - (b.placeEpoch || 0));
  return out;
}

module.exports = { born, mergeJournal };
