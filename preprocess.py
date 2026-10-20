#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ES 1min 数据预处理
==================
输入: 78 个单月份 CSV (datetime,open,high,low,close,volume, 时间为美东ET wall clock)
输出: es-replay/data/ 下的二进制 gz 数据 + meta.json

流程:
  1. 读取全部合约(剔除几乎为空的 H27/M27 远月残文件)
  2. 按 CME 交易日(18:00 ET 起算)的成交量选出主力合约, 拼接为连续序列
  3. 计算每次主力切换的价差, 做加法向后复权(back-adjust), 使历史价格与最新合约对齐
  4. 聚合 10 个周期 x ETH/RTH 两种时段口径
  5. 写出紧凑二进制文件(带文件头, 可直接被 JS 解析)

二进制格式 (little-endian):
  头 24 字节: magic'ESB1'(4) + version(1) + tf_code(1) + session(1) + flags(1)
              + count(uint32) + first_time(int32) + last_time(int32) + reserved(4)
  体: time int32[count] + et_offset int8[count] + open/high/low/close float32[count]
      + volume uint32[count]
"""
import numpy as np
import pandas as pd
import gzip, json, struct, sys, time
from pathlib import Path
from zoneinfo import ZoneInfo

t0 = time.time()
def log(msg):
    print(f"[{time.time()-t0:7.1f}s] {msg}", flush=True)

SRC = Path(r"C:/Users/gosky9/Desktop/es/国外期货CME(COMEX) 芝加哥商品交易所CME单月份一分钟_2008-01-01_2026-07-27_ES/data")
OUT = Path(r"C:/Users/gosky9/Desktop/es/es-replay/data")
OUT.mkdir(parents=True, exist_ok=True)

ET = ZoneInfo("America/New_York")
RTH_START = 9 * 60 + 30   # 09:30 ET
RTH_END   = 16 * 60       # 16:00 ET (不含)
CME_DAY_START = 18 * 60   # 18:00 ET

TFS = [
    (1,  "1m",    1, 0),
    (2,  "5m",    5, 0),
    (3,  "10m",  10, 0),
    (4,  "15m",  15, 0),
    (5,  "30m",  30, 0),
    (6,  "1h",   60, CME_DAY_START),
    (7,  "4h",  240, CME_DAY_START),
    (8,  "12h", 720, CME_DAY_START),
    (9,  "1d",    0, 0),   # 特殊: 按 CME 交易日
    (10, "1w",    0, 0),   # 特殊: 按 CME 交易周(周日起)
]
RTH_TFS = {6: RTH_START, 7: RTH_START, 8: RTH_START}

MAGIC = b"ESB1"
HDR = struct.Struct("<4sBBBBIIII")

def et_offset_at(epochs):
    """给定 unix 秒数组, 返回该时刻的美东偏移小时数(-5/-4), 向量化精确计算"""
    utc = pd.to_datetime(np.asarray(epochs, dtype="int64"), unit="s", utc=True).astype("datetime64[ns, UTC]")
    et = utc.tz_convert(ET)
    naive = et.tz_localize(None)
    # ET wall - UTC = 负值 (-5/-4)
    return ((naive.astype("int64") - et.astype("int64")) // 3_600_000_000_000).astype(np.int64)

# ---------------------------------------------------------------- 1. 读取
log("读取源 CSV ...")
CN_MAP = {"时间": "datetime", "开盘价": "open", "最高价": "high",
          "最低价": "low", "收盘价": "close", "成交量": "volume"}
frames = []
for f in sorted(SRC.glob("ES_*_1min.csv")):
    contract = f.stem.split("_")[1]
    if contract in ("H27", "M27"):
        continue
    df = pd.read_csv(f, encoding="utf-8-sig")
    df.columns = [c.strip().lower() for c in df.columns]
    df = df.rename(columns=CN_MAP)          # 兼容中文表头(U26/Z26 等文件)
    df = df[["datetime", "open", "high", "low", "close", "volume"]]
    df["contract"] = contract
    frames.append(df)
big = pd.concat(frames, ignore_index=True)
# 注意: pandas 3.x 的 to_datetime 默认返回 datetime64[us], 统一强制为 ns 保证后续换算一致
big["dt"] = pd.to_datetime(big["datetime"], format="%Y-%m-%d %H:%M:%S").astype("datetime64[ns]")
big = big.drop(columns=["datetime"])
for c in ("open", "high", "low", "close"):
    big[c] = big[c].astype("float32")
big["volume"] = big["volume"].astype("int64")
log(f"  共 {len(big):,} 行, 合约 {big['contract'].nunique()} 个")

# ---------------------------------------------------------------- 2. 时间字段
log("计算 ET 时间戳 / DST 偏移 / CME 交易日 ...")
loc = big["dt"].dt.tz_localize(ET, ambiguous=True, nonexistent="shift_forward")
big["epoch"]  = loc.astype("int64") // 1_000_000_000
# offset = ET wall - UTC, 即 -5(冬令)/-4(夏令)
big["offset"] = (big["dt"].astype("int64") - loc.astype("int64")) // 3_600_000_000_000
big["tday"]   = (big["dt"] - pd.Timedelta(hours=18)).dt.normalize().astype("int64") // 86_400_000_000_000

# ---------------------------------------------------------------- 3. 主力拼接
log("按 CME 交易日成交量选主力 ...")
vol = (big.groupby(["tday", "contract"], observed=True)["volume"].sum()
          .unstack(fill_value=0))
front = vol.idxmax(axis=1)
big["front_c"] = big["tday"].map(front)
cont = big[big["contract"] == big["front_c"]].sort_values(["dt"]).reset_index(drop=True)
assert cont["dt"].is_unique, "连续序列存在重复时间戳!"
log(f"  连续序列 {len(cont):,} 行  范围 {cont['dt'].iloc[0]} → {cont['dt'].iloc[-1]}")

# ---------------------------------------------------------------- 4. 复权
log("计算主力切换价差并向后复权 ...")
per_day = cont.groupby("tday").agg(first=("close", "first"), last=("close", "last"),
                                   contract=("contract", "first"))
roll_tdays, roll_from, roll_to, gaps = [], [], [], []
prev_close = None; prev_contract = None
for td, row in per_day.iterrows():
    if prev_close is not None and row["contract"] != prev_contract:
        gaps.append(float(row["first"] - prev_close))
        roll_tdays.append(int(td))
        roll_from.append(str(prev_contract)); roll_to.append(str(row["contract"]))
    prev_close = float(row["last"]); prev_contract = row["contract"]
gaps = np.array(gaps, dtype=np.float64)
suffix = np.cumsum(gaps[::-1])[::-1] if len(gaps) else np.zeros(0)
roll_arr = np.array(roll_tdays, dtype=np.int64)

tday_vals = cont["tday"].values.astype(np.int64)
idx = np.searchsorted(roll_arr, tday_vals, side="right")
G = np.where(idx < len(suffix), suffix[np.clip(idx, 0, max(len(suffix) - 1, 0))], 0.0).astype(np.float32)
for c in ("open", "high", "low", "close"):
    cont[c] = (cont[c].astype(np.float64) + G).astype(np.float32)
log(f"  切换 {len(gaps)} 次, 复权总量 {suffix[0] if len(suffix) else 0:+.2f} 点")

# 连续性自检: 复权后每次主力切换点残差应≈0 (必须用调整后的序列重算)
per_day_adj = cont.groupby("tday").agg(first=("close", "first"), last=("close", "last"))
resid = []
for td in roll_tdays:
    j = per_day_adj.index.get_loc(td)
    if j > 0:
        resid.append(float(per_day_adj["first"].iloc[j]) - float(per_day_adj["last"].iloc[j-1]))
resid = np.array(resid)
log(f"  复权后切换点残差: max|Δ|={np.abs(resid).max():.4f} 点 (应≈0)")
assert np.abs(resid).max() < 0.01, "复权后仍有跳空!"

# ---------------------------------------------------------------- 5. RTH 掩码
mod = ((cont["epoch"].values + cont["offset"].values.astype(np.int64) * 3600) // 60) % 1440
is_rth = (mod >= RTH_START) & (mod < RTH_END)
log(f"  RTH bar 数 {is_rth.sum():,} / {len(cont):,}")

# ---------------------------------------------------------------- 6. 聚合 & 写出
def aggregate(df, tf_code, tf_min, anchor):
    """返回 (agg DataFrame含 epoch/o/h/l/c/v, offset数组)"""
    if tf_code == 1:
        out = pd.DataFrame({"epoch": df["epoch"].values,
                            "o": df["open"].values, "h": df["high"].values,
                            "l": df["low"].values, "c": df["close"].values,
                            "v": df["volume"].values})
        return out, df["offset"].values.astype(np.int64)
    if tf_code in (9, 10):
        dnum = (df["dt"].dt.normalize().astype("int64") // 86_400_000_000_000).values
        wd = (dnum + 3) % 7                      # 1970-01-01=周四 → 周一=0..周日=6
        if tf_code == 9:                          # 1d
            if df.attrs.get("rth"):
                key = dnum
            else:
                key = df["tday"].values.copy()
        else:                                     # 1w
            if df.attrs.get("rth"):
                key = dnum - wd                   # 周一
            else:
                key = dnum - ((wd + 1) % 7)       # 周日
        day0 = pd.to_datetime(key, unit="D").astype("datetime64[ns]")
        # 先加至目标墙钟再 localize, 避免 DST 切换日 00:00 的偏移量污染 18:00/09:30
        naive_start = day0 + pd.Timedelta(minutes=RTH_START if df.attrs.get("rth") else CME_DAY_START)
        loc_d = naive_start.tz_localize(ET, ambiguous=True, nonexistent="shift_forward")
        btime = (loc_d.astype("int64") // 1_000_000_000).values
        g = df.groupby(key, sort=True)
        agg = g.agg(o=("open", "first"), h=("high", "max"), l=("low", "min"),
                    c=("close", "last"), v=("volume", "sum"))
        bt = pd.Series(btime, index=df.index).groupby(pd.Series(key, index=df.index)).first()
        agg["epoch"] = bt.values
        return agg, None
    # 日内周期
    et_min = (df["epoch"].values + df["offset"].values.astype(np.int64) * 3600) // 60
    m = et_min % 1440
    rel = (m - anchor) % 1440
    brel = (rel // tf_min) * tf_min
    bmod = (anchor + brel) % 1440
    bk = et_min - m + bmod                        # bucket 起始 ET wall 分钟
    g = df.groupby(bk, sort=True)
    agg = g.agg(o=("open", "first"), h=("high", "max"), l=("low", "min"),
                c=("close", "last"), v=("volume", "sum"))
    off = (pd.Series(df["offset"].values, index=df.index).groupby(bk).first().values.astype(np.int64))
    agg["epoch"] = (agg.index.values - off * 60) * 60
    return agg, None

def write_bin(path, tf_code, session, epochs, offs, o, h, l, c, v):
    n = len(epochs)
    assert n < 2**32
    # off(int8×n) 后补 pad 字节, 使后续 f4/u4 段 4 字节对齐(浏览器 TypedArray 视图要求)
    pad = (4 - (n % 4)) % 4
    buf = bytearray()
    buf += HDR.pack(MAGIC, 1, tf_code, session, pad, n, int(epochs[0]), int(epochs[-1]), 0)
    buf += np.asarray(epochs, dtype="<i4").tobytes()
    buf += np.asarray(offs, dtype="<i1").tobytes()
    buf += b"\x00" * pad
    for arr in (o, h, l, c):
        buf += np.asarray(arr, dtype="<f4").tobytes()
    buf += np.asarray(v, dtype="<u4").tobytes()
    with gzip.open(path, "wb", compresslevel=6) as fh:
        fh.write(bytes(buf))
    return len(buf)

files_index = {}
total_bytes = 0
for session_id, session_name, base in ((0, "eth", cont),
                                       (1, "rth", cont[is_rth].reset_index(drop=True))):
    base.attrs["rth"] = (session_id == 1)
    log(f"--- {session_name.upper()} 口径 ({len(base):,} 根 1m) ---")
    for tf_code, tf_name, tf_min, anchor in TFS:
        anchor = RTH_TFS.get(tf_code, anchor) if session_id == 1 else anchor
        agg, offs = aggregate(base, tf_code, tf_min, anchor)
        epochs = agg["epoch"].values.astype(np.int64)
        if offs is None:
            offs = et_offset_at(epochs)
        o = agg["o"].values; h = agg["h"].values
        l = agg["l"].values; c = agg["c"].values
        v = agg["v"].values.astype(np.int64)
        dts = pd.to_datetime(epochs, unit="s").astype("datetime64[ns]") + pd.to_timedelta(offs, unit="h")
        if tf_code == 1:
            split_keys = (dts.year * 100 + dts.month).values
            split_names = {int(k): f"{k//100:04d}-{k%100:02d}" for k in np.unique(split_keys)}
        else:
            split_keys = dts.year.values
            split_names = {int(k): f"{k:04d}" for k in np.unique(split_keys)}
        idx_key = f"{session_name}_{tf_name}"
        files_index[idx_key] = []
        subdir = OUT / idx_key
        subdir.mkdir(exist_ok=True)
        for k in np.unique(split_keys):
            k = int(k)
            mask = split_keys == k
            fname = f"{split_names[k]}.bin.gz"
            raw_len = write_bin(subdir / fname, tf_code, session_id,
                                epochs[mask], offs[mask], o[mask], h[mask],
                                l[mask], c[mask], v[mask])
            total_bytes += raw_len
            files_index[idx_key].append({
                "f": f"{idx_key}/{fname}",
                "first": int(epochs[mask][0]), "last": int(epochs[mask][-1]),
                "n": int(mask.sum()), "bytes": raw_len,
            })
        log(f"  {idx_key}: {len(epochs):,} 根 -> {len(np.unique(split_keys))} 个文件")

# ---------------------------------------------------------------- 7. meta.json
rolls_meta = [{"tday": str(pd.to_datetime(td * 86_400_000_000_000).date()),
               "from": roll_from[i], "to": roll_to[i], "gap": round(float(gaps[i]), 2)}
              for i, td in enumerate(roll_tdays)]
meta = {
    "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
    "symbol": "ES1! (CME E-mini S&P 500 连续复权序列)",
    "range": {"first": int(cont["epoch"].min()), "last": int(cont["epoch"].max())},
    "tradingDays": int(cont["tday"].nunique()),
    "usableFrom": "2008-01-01",
    "sparsePeriod": ["2007-09-20", "2007-12-31"],
    "adjust": {"type": "back-additive", "totalShift": round(float(suffix[0]), 2) if len(suffix) else 0},
    "rolls": rolls_meta,
    "files": files_index,
    "format": {"header": 24, "bar": 25, "magic": "ESB1",
               "flags": "off(int8×n) 后的对齐 pad 字节数 = (4 - n%4) % 4"},
}
with open(OUT / "meta.json", "w", encoding="utf-8") as fh:
    json.dump(meta, fh, ensure_ascii=False, indent=1)
log(f"meta.json 写出, gz 前原始数据总量 {total_bytes/1e6:.1f} MB")
log("完成 ✓")
