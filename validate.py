#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据校验: 1) rth_1d 数量异常 2) 聚合正确性 3) RTH 口径 4) 复权连续性"""
import numpy as np, gzip, json, struct, sys
from pathlib import Path
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

ET = ZoneInfo("America/New_York")
DATA = Path(r"C:/Users/gosky9/Desktop/es/es-replay/data")
meta = json.load(open(DATA / "meta.json", encoding="utf-8"))

def read_bin(path):
    raw = gzip.open(path, "rb").read()
    magic = raw[:4]; count = struct.unpack("<I", raw[8:12])[0]
    pad = raw[7]                       # flags: off 段后的对齐字节数
    p = 24
    time = np.frombuffer(raw, dtype="<i4", count=count, offset=p); p += count*4
    off  = np.frombuffer(raw, dtype="<i1", count=count, offset=p); p += count + pad
    o = np.frombuffer(raw, dtype="<f4", count=count, offset=p); p += count*4
    h = np.frombuffer(raw, dtype="<f4", count=count, offset=p); p += count*4
    l = np.frombuffer(raw, dtype="<f4", count=count, offset=p); p += count*4
    c = np.frombuffer(raw, dtype="<f4", count=count, offset=p); p += count*4
    v = np.frombuffer(raw, dtype="<u4", count=count, offset=p)
    return dict(time=time, off=off, o=o, h=h, l=l, c=c, v=v, count=count)

print("===== 1. 各口径总量 =====")
for k, files in meta["files"].items():
    print(f"  {k:10s} {sum(f['n'] for f in files):>10,} 根, {len(files)} 文件")

print("\n===== 2. rth_1d vs eth_1d 日期对比 (2024年) =====")
rth1d = read_bin(DATA / "rth_1d" / "2024.bin.gz")
eth1d = read_bin(DATA / "eth_1d" / "2024.bin.gz")
def dates_of(rec):
    return set(datetime.fromtimestamp(int(t) + int(o)*3600, tz=timezone.utc).strftime("%Y-%m-%d")
               for t, o in zip(rec["time"], rec["off"]))
rd, ed = dates_of(rth1d), dates_of(eth1d)
print(f"  rth_1d 2024: {len(rd)} 天, eth_1d 2024: {len(ed)} 天")
print(f"  rth 有但 eth 无 ({len(rd-ed)}):", sorted(rd-ed)[:20])
print(f"  eth 有但 rth 无 ({len(ed-rd)}):", sorted(ed-rd)[:20])

print("\n===== 3. rth_1d 每天 bar time 检查(是否都在 09:30 ET) =====")
bad = 0
for t, o in zip(rth1d["time"], rth1d["off"]):
    d = datetime.fromtimestamp(int(t) + int(o)*3600, tz=timezone.utc)
    if d.hour != 9 or d.minute != 30:
        bad += 1
        if bad < 5: print("  异常 bar time:", d)
print(f"  非 09:30 的 rth_1d bar: {bad} / {rth1d['count']}")

print("\n===== 4. eth_1d bar time 检查(是否都在 18:00 ET) =====")
bad = 0
for t, o in zip(eth1d["time"], eth1d["off"]):
    d = datetime.fromtimestamp(int(t) + int(o)*3600, tz=timezone.utc)
    if d.hour != 18 or d.minute != 0:
        bad += 1
        if bad < 5: print("  异常 bar time:", d)
print(f"  非 18:00 的 eth_1d bar: {bad} / {eth1d['count']}")

print("\n===== 5. rth_1m 时段检查(全部应在 09:30-15:59 ET) =====")
rth1m = read_bin(DATA / "rth_1m" / "2024-06.bin.gz")
mods = ((rth1m["time"].astype(np.int64) + rth1m["off"].astype(np.int64)*3600) // 60) % 1440
print(f"  分钟范围: {mods.min()} ~ {mods.max()} (应在 [570,960))")
print(f"  越界 bar 数: {int(((mods < 570) | (mods >= 960)).sum())} / {rth1m['count']}")

print("\n===== 6. 聚合正确性: 抽 2024-03 的 5m bar 与 1m 源对比 =====")
m5 = read_bin(DATA / "eth_5m" / "2024.bin.gz")
m1 = read_bin(DATA / "eth_1m" / "2024-03.bin.gz")
# 取 2024-03-15 10:00-11:00 ET 的 5m bar, 与 1m 聚合对比
def et_min(t, o): return (int(t) + int(o)*3600) // 60
target_day = None
sel = []
for i in range(m5["count"]):
    d = datetime.fromtimestamp(int(m5["time"][i]) + int(m5["off"][i])*3600, tz=timezone.utc)
    if d.strftime("%Y-%m-%d %H:%M") == "2024-03-15 10:00":
        sel = [i]; target_day = d.date(); break
if sel:
    i = sel[0]
    b5 = (m5["time"][i], m5["o"][i], m5["h"][i], m5["l"][i], m5["c"][i], m5["v"][i])
    # 1m 聚合
    start_min = et_min(m5["time"][i], m5["off"][i])
    om, oh, ol, oc, ov = None, -1e18, 1e18, None, 0
    n = 0
    for j in range(m1["count"]):
        mm = et_min(m1["time"][j], m1["off"][j])
        if start_min <= mm < start_min + 5:
            n += 1
            if om is None: om = m1["o"][j]
            oh = max(oh, m1["h"][j]); ol = min(ol, m1["l"][j])
            oc = m1["c"][j]; ov += m1["v"][j]
    print(f"  5m bar: O={b5[1]} H={b5[2]} L={b5[3]} C={b5[4]} V={b5[5]}")
    print(f"  1m聚合: O={om} H={oh} L={ol} C={oc} V={ov} (n={n})")
    ok = (abs(b5[1]-om)<1e-4 and abs(b5[2]-oh)<1e-4 and abs(b5[3]-ol)<1e-4
          and abs(b5[4]-oc)<1e-4 and b5[5]==ov)
    print(f"  聚合一致: {'✓' if ok else '✗ 不一致!'}")
else:
    print("  未找到目标 5m bar")

print("\n===== 7. 复权连续性: 2026-06-14 M26→U26 切换点附近 =====")
u26 = read_bin(DATA / "eth_1m" / "2026-06.bin.gz")
# 找 18:00 ET 边界
for i in range(1, u26["count"]):
    d0 = datetime.fromtimestamp(int(u26["time"][i-1]) + int(u26["off"][i-1])*3600, tz=timezone.utc)
    d1 = datetime.fromtimestamp(int(u26["time"][i]) + int(u26["off"][i])*3600, tz=timezone.utc)
    if (d1-d0).total_seconds() > 3600 and d1.hour == 18:
        print(f"  边界 {d0} → {d1}: 前收 {u26['c'][i-1]}, 后开 {u26['o'][i]}, 差 {u26['o'][i]-u26['c'][i-1]:.2f}")
