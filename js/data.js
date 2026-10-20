/* ============ data.js — 二进制数据加载 ============
 * 文件格式 (little-endian):
 *   头24字节: magic'ESB1'(4) + version(1) + tf_code(1) + session(1) + pad_len(1)
 *             + count(uint32) + first_time(int32) + last_time(int32) + reserved(4)
 *   体: time int32[n] + et_offset int8[n] + pad[pad_len] + o/h/l/c float32[n] + volume uint32[n]
 *      (pad 使 o/h/l/c 段 4 字节对齐, 浏览器 TypedArray 视图要求; pad_len=(4-n%4)%4)
 */
const DataLoader = {
  meta: null,
  fileCache: new Map(),     // url -> 解析后的文件数组
  MAX_CACHE_FILES: 40,

  async init() {
    const r = await fetch('data/meta.json?_=' + Date.now());
    if (!r.ok) throw new Error('meta.json 加载失败: ' + r.status);
    this.meta = await r.json();
    return this.meta;
  },

  /** 解析单个 .bin.gz 文件 */
  async fetchFile(url) {
    if (this.fileCache.has(url)) return this.fileCache.get(url);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(url + ' → HTTP ' + resp.status);
    const gz = await resp.arrayBuffer();
    let buf;
    if (typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('gzip');
      const stream = new Blob([gz]).stream().pipeThrough(ds);
      buf = await new Response(stream).arrayBuffer();
    } else {
      throw new Error('浏览器不支持 DecompressionStream, 请用较新的 Chrome/Edge');
    }
    const dv = new DataView(buf);
    const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
    if (magic !== 'ESB1') throw new Error('文件格式错误: ' + url);
    const count = dv.getUint32(8, true);
    const pad = dv.getUint8(7);        // flags: off(int8×n) 后的 4 字节对齐 padding
    let p = 24;
    const time   = new Int32Array(buf, p, count); p += count * 4;
    const off    = new Int8Array(buf, p, count);  p += count + pad;
    const open   = new Float32Array(buf, p, count); p += count * 4;
    const high   = new Float32Array(buf, p, count); p += count * 4;
    const low    = new Float32Array(buf, p, count); p += count * 4;
    const close  = new Float32Array(buf, p, count); p += count * 4;
    const volume = new Uint32Array(buf, p, count);
    const rec = { time, off, open, high, low, close, volume, count };
    if (this.fileCache.size >= this.MAX_CACHE_FILES) {
      this.fileCache.delete(this.fileCache.keys().next().value);
    }
    this.fileCache.set(url, rec);
    return rec;
  },

  /** 找到覆盖 [from,to] 的所有文件并拼接 */
  async loadRange(session, tf, from, to) {
    const key = session + '_' + tf;
    const list = this.meta.files[key];
    if (!list) throw new Error('无此数据口径: ' + key);
    const hits = list.filter(f => f.last >= from && f.first <= to);
    if (!hits.length) return null;
    const recs = await Promise.all(hits.map(f => this.fetchFile('data/' + f.f)));
    const total = recs.reduce((s, r) => s + r.count, 0);
    const out = {
      time: new Int32Array(total), off: new Int8Array(total),
      open: new Float32Array(total), high: new Float32Array(total),
      low: new Float32Array(total), close: new Float32Array(total),
      volume: new Uint32Array(total), count: total,
    };
    let o = 0;
    for (const r of recs) {
      out.time.set(r.time, o); out.off.set(r.off, o);
      out.open.set(r.open, o); out.high.set(r.high, o);
      out.low.set(r.low, o); out.close.set(r.close, o);
      out.volume.set(r.volume, o);
      o += r.count;
    }
    return out;
  },

  /** 在已排序 time 数组中二分查找 */
  lowerBound(arr, n, v) {
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  },
  upperBound(arr, n, v) {
    let lo = 0, hi = n;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] <= v) lo = mid + 1; else hi = mid; }
    return lo;
  },

  /**
   * 客户端聚合: 由基础周期合成 2分 / 3天 / 月线 (参考截图顶栏有这三个周期)
   * mode='count' 每 n 根合成一根(时间取首根) | mode='month' 按 ET 自然月合成
   */
  aggregate(data, mode, n) {
    const t = [], o = [], h = [], l = [], c = [], v = [], off = [];
    let cur = null;
    const push = () => {
      if (!cur) return;
      t.push(cur.t); o.push(cur.o); h.push(cur.h); l.push(cur.l);
      c.push(cur.c); v.push(cur.v); off.push(cur.off);
      cur = null;
    };
    let grpCount = 0, lastKey = '';
    for (let i = 0; i < data.count; i++) {
      let key;
      if (mode === 'month') {
        const p = etParts(data.time[i], data.off[i]);
        key = p.y * 100 + p.mo;
      } else {
        // 按"从数据起点算起的第几组"分桶, 保证同一文件内分桶稳定
        key = Math.floor(i / n);
      }
      if (key !== lastKey) { push(); lastKey = key; grpCount = 0; }
      const O = data.open[i], H = data.high[i], L = data.low[i], C = data.close[i];
      if (!cur) cur = { t: data.time[i], o: O, h: H, l: L, c: C, v: data.volume[i], off: data.off[i] };
      else {
        if (H > cur.h) cur.h = H;
        if (L < cur.l) cur.l = L;
        cur.c = C;
        cur.v += data.volume[i];
      }
      grpCount++;
    }
    push();
    return {
      time: Int32Array.from(t), off: Int8Array.from(off),
      open: Float32Array.from(o), high: Float32Array.from(h),
      low: Float32Array.from(l), close: Float32Array.from(c),
      volume: Uint32Array.from(v), count: t.length,
    };
  },

  /**
   * 取回放窗口: 目标点 P 之前 contextBars 根 + 之后 forwardBars 根
   * 返回 { bars, startIdx } — bars 为纯数组对象, startIdx 为 P 在 bars 中的下标
   */
  async loadWindow(session, tf, targetEpoch, contextBars, forwardBars) {
    const der = DERIVED_TF[tf];
    const baseTf = der ? der.base : tf;
    const tfMin = TF_MINUTES[tf];
    // 2 倍时间余量吸收周末/休市空洞
    const backSec  = contextBars * tfMin * 60 * 2.2;
    const fwdSec   = forwardBars * tfMin * 60 * 2.2;
    const from = targetEpoch - backSec;
    const to   = Math.min(targetEpoch + fwdSec, this.meta.range.last);
    let data = await this.loadRange(session, baseTf, from, to);
    if (!data || data.count === 0) return null;
    if (der) data = this.aggregate(data, der.group, der.n);
    if (!data || data.count === 0) return null;
    const iEnd = this.upperBound(data.time, data.count, targetEpoch); // P 之后的第一个
    const iStart = Math.max(0, iEnd - contextBars);
    const iStop = Math.min(data.count, iEnd + forwardBars);
    const bars = [];
    for (let i = iStart; i < iStop; i++) bars.push(i);
    return {
      indices: bars, data,
      startIdx: iEnd - iStart - 1,   // P 前最后一根(若无则为-1)
      firstIdx: iStart,
    };
  },
};

/**
 * 由基础周期合成的周期 (参考截图顶栏: 2分 / 3天 / 月)
 * base = 基础周期文件, group = 合成方式, n = 每几根合成一根
 */
const DERIVED_TF = {
  '2m': { base: '1m', group: 'count', n: 2 },
  '3d': { base: '1d', group: 'count', n: 3 },
  '1M': { base: '1d', group: 'month', n: 1 },
};

const TF_MINUTES = {
  '1m': 1, '2m': 2, '5m': 5, '10m': 10, '15m': 15, '30m': 30,
  '1h': 60, '4h': 240, '12h': 720, '1d': 1440, '3d': 4320, '1w': 10080, '1M': 43200,
};
const TF_CODES = { '1m': 1, '2m': 11, '5m': 2, '10m': 3, '15m': 4, '30m': 5, '1h': 6, '4h': 7, '12h': 8, '1d': 9, '3d': 12, '1w': 10, '1M': 13 };
const TF_LABEL = {
  '1m': '1分钟', '2m': '2分钟', '5m': '5分钟', '10m': '10分钟', '15m': '15分钟', '30m': '30分钟',
  '1h': '1小时', '4h': '4小时', '12h': '12小时', '1d': '日线', '3d': '3天', '1w': '周线', '1M': '月线',
};

/** 浏览器本地时区偏移(秒, 东为正) */
const TZ_SHIFT = -new Date().getTimezoneOffset() * 60;

/**
 * ET wall → 图表时间戳 (秒)
 * 说明: 这里把"美东墙钟"直接编码成 UTC 秒(即假UTC), 再由 chart.js 的
 * tickMarkFormatter / timeFormatter 全部用 getUTC* 方法格式化。
 * 这样刻度显示恒为交易所时间(ET), 与用户浏览器时区无关 —— 换台机器也不会偏。
 */
function chartTime(epoch, off) { return epoch + off * 3600; }

/** ET 日期字符串 yyyy-mm-dd (用于日线/周线 business day) */
function etDateStr(epoch, off) {
  const d = new Date((epoch + off * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate());
}

/** ET 墙钟各字段 */
function etParts(epoch, off) {
  const d = new Date((epoch + off * 3600) * 1000);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    hh: d.getUTCHours(), mi: d.getUTCMinutes(),
  };
}

/**
 * CME 交易日键 (ETH 口径): 18:00 ET 起算新的一天
 * 周日 18:00 → 周一；周五 17:00 后无数据，自然衔接
 */
function cmTradingDay(epoch, off) {
  const p = etParts(epoch, off);
  const dt = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  if (p.hh >= 18) dt.setUTCDate(dt.getUTCDate() + 1);
  const q = n => String(n).padStart(2, '0');
  return dt.getUTCFullYear() + '-' + q(dt.getUTCMonth() + 1) + '-' + q(dt.getUTCDate());
}

/** 按回放口径取"交易分组键": RTH=自然日 / ETH=CME 交易日 */
function dayKeyOf(epoch, off, session) {
  return session === 'rth' ? etDateStr(epoch, off) : cmTradingDay(epoch, off);
}

/**
 * 某根 K 线是当日第几根 (1 起)
 * RTH 以 09:30 开盘、ETH 以 18:00 开盘为锚, 按周期分钟数折算。
 * 用于窗口首根落在日内中间时估算序号(窗口内其余 bar 用逐根累加, 更准)
 */
function barNoInDay(epoch, off, session, tfMin) {
  const p = etParts(epoch, off);
  const mins = p.hh * 60 + p.mi;
  const open = session === 'rth' ? 570 : 1080;      // 09:30 / 18:00
  const since = session === 'rth' ? mins - open : (mins - open + 1440) % 1440;
  return Math.max(1, Math.floor(since / tfMin) + 1);
}

/** epoch → 美东时间显示串 */
function etTimeStr(epoch, off, withSec) {
  const d = new Date((epoch + off * 3600) * 1000);
  const p = n => String(n).padStart(2, '0');
  let s = d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) +
          ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes());
  if (withSec) s += ':' + p(d.getUTCSeconds());
  return s + ' ET';
}

/**
 * 美东墙钟时间 → epoch 秒 (精确处理 DST, 用 Intl 时区数据库迭代求解)
 * @param {number} y @param {number} mo 1-12 @param {number} d
 * @param {number} hh @param {number} mi
 * 不存在的时间(春跳空洞 02:00-03:00)会 shift_forward 到最近的有效时刻
 */
function etWallToEpoch(y, mo, d, hh, mi) {
  const target = Date.UTC(y, mo - 1, d, hh, mi, 0);
  let ts = target;                       // 初始猜测: 当作 UTC
  for (let i = 0; i < 4; i++) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York', hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ts));
    const g = k => +parts.find(p => p.type === k).value;
    const etMs = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second'));
    const diff = etMs - target;          // ET 墙钟 - 目标墙钟
    if (diff === 0) break;
    ts -= diff;                          // 修正
  }
  return Math.floor(ts / 1000);
}
