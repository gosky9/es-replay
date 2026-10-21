# -*- coding: utf-8 -*-
"""
把 reference/17 里的 TV 图标墨迹描成矢量轮廓(不是手画形状, 是直接从原图描)。

- marching squares 在"墨迹覆盖率场"上取 0.5 等值线, 借抗锯齿做亚像素定位
- 鞍点(5/10)按四角均值消歧, 否则 45° 细线会被切碎
- 每条等值线都是闭合环, 全塞进一个 path + fill-rule="evenodd", 孔洞自动镂空
- 坐标: viewBox "0 0 56 56", 1 单位 = 0.5 CSS px(原图 2x), 墨迹中心对准 (28,28)

用法:
    python trace_icons.py     # 描出轮廓 -> _icons_tv.json
    python apply_icons.py     # 把轮廓写进 index.html(可重复运行)
"""
import json
import numpy as np
from PIL import Image

TV = "reference/17-TV-收藏条真实尺寸-2026-10-21.png"
V = 56
THR = 0.5
EPS = 0.28

# 收藏条里的图标: 精确 bbox(device px)
BAR = {
    "hline":  (1652, 358, 1688, 366),   # 横线 + 中间圆点
    "rect":   (1318, 342, 1356, 380),   # 方框 + 四角圆点
    "fib":    (1379, 340, 1427, 385),   # 菱形 + 8 圆点
    "trend":  (1251, 342, 1289, 380),   # 斜线 + 两端圆点
    "text":   (1923, 346, 1949, 376),   # 带脚的 T
}
# 左侧竖排工具栏: 只给 y 区间, x 用真实墨迹自动收紧
SIDE_Y = {
    "cursor":     (184, 224),
    "multihline": (319, 355),
    "fan":        (383, 421),
    "box":        (452, 488),
    "emoji":      (649, 687),
    "ruler":      (738, 778),
    "zoom":       (807, 838),
    "magnet":     (896, 928),
    "penlock":    (963, 999),
    "padlock":    (1027, 1061),
    "eye":        (1094, 1132),
    "link":       (1162, 1196),
    "trash":      (1252, 1286),
}

_img = np.asarray(Image.open(TV).convert("RGB")).astype(np.float32).mean(axis=2)

TABLE = {
    1:  [(3, 0)], 2:  [(0, 1)], 3:  [(3, 1)], 4:  [(1, 2)],
    5:  [(3, 0), (1, 2)], 6:  [(0, 2)], 7:  [(3, 2)], 8:  [(2, 3)],
    9:  [(0, 2)], 10: [(0, 1), (2, 3)], 11: [(1, 2)], 12: [(1, 3)],
    13: [(0, 1)], 14: [(3, 0)], 15: [],
}
SADDLE_CONNECTED = {5: [(0, 1), (2, 3)], 10: [(3, 0), (1, 2)]}
SADDLE_SPLIT = {5: [(3, 0), (1, 2)], 10: [(0, 1), (2, 3)]}


def rdp(pts, eps):
    if len(pts) < 3:
        return pts
    (x1, y1), (x2, y2) = pts[0], pts[-1]
    dx, dy = x2 - x1, y2 - y1
    norm = (dx * dx + dy * dy) ** 0.5
    dmax, idx = -1.0, 0
    for i in range(1, len(pts) - 1):
        px, py = pts[i]
        d = ((px - x1) ** 2 + (py - y1) ** 2) ** 0.5 if norm == 0 else \
            abs(dy * (px - x1) - dx * (py - y1)) / norm
        if d > dmax:
            dmax, idx = d, i
    if dmax > eps:
        return rdp(pts[:idx + 1], eps)[:-1] + rdp(pts[idx:], eps)
    return [pts[0], pts[-1]]


def area(ring):
    s = 0.0
    for i in range(len(ring) - 1):
        s += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1]
    return abs(s) / 2


def contours(cov, thr=THR):
    h, w = cov.shape
    pt = {}

    def edge_pt(kind, i, j):
        key = (kind, i, j)
        if key in pt:
            return pt[key]
        if kind == 0:
            c1, c2 = cov[i, j], cov[i, j + 1]
            t = (thr - c1) / (c2 - c1) if c2 != c1 else 0.5
            p = (j + min(max(t, 0.0), 1.0), float(i))
        else:
            c1, c2 = cov[i, j], cov[i + 1, j]
            t = (thr - c1) / (c2 - c1) if c2 != c1 else 0.5
            p = (float(j), i + min(max(t, 0.0), 1.0))
        pt[key] = p
        return p

    def eid(i, j, e):
        if e == 0:
            return (0, i, j)
        if e == 1:
            return (1, i, j + 1)
        if e == 2:
            return (0, i + 1, j)
        return (1, i, j)

    segs = []
    for i in range(h - 1):
        for j in range(w - 1):
            c00, c10 = cov[i, j], cov[i, j + 1]
            c11, c01 = cov[i + 1, j + 1], cov[i + 1, j]
            idx = (1 if c00 > thr else 0) | (2 if c10 > thr else 0) | \
                  (4 if c11 > thr else 0) | (8 if c01 > thr else 0)
            if idx in SADDLE_CONNECTED:
                center = (c00 + c10 + c11 + c01) / 4.0
                pairs = SADDLE_CONNECTED[idx] if center > thr else SADDLE_SPLIT[idx]
            else:
                pairs = TABLE.get(idx, [])
            for a, b in pairs:
                segs.append((eid(i, j, a), eid(i, j, b)))
    if not segs:
        return []

    adj = {}
    for n, (a, b) in enumerate(segs):
        adj.setdefault(a, []).append((b, n))
        adj.setdefault(b, []).append((a, n))
    used = [False] * len(segs)
    loops = []
    for n0 in range(len(segs)):
        if used[n0]:
            continue
        a, b = segs[n0]
        used[n0] = True
        loop = [a, b]
        cur, prev = b, n0
        while True:
            nxt = None
            for (other, sn) in adj.get(cur, []):
                if sn != prev and not used[sn]:
                    nxt = (other, sn)
                    break
            if nxt is None:
                break
            other, sn = nxt
            used[sn] = True
            if other == loop[0]:
                break
            loop.append(other)
            cur, prev = other, sn
        if len(loop) >= 4:
            loops.append([edge_pt(*p) for p in loop])

    out = []
    for lp in loops:
        r = rdp(lp + [lp[0]], EPS)
        if len(r) >= 3:
            out.append(r)
    return out


def trace(name, x0, y0, x1, y1):
    pad = 2
    gx0, gy0 = max(0, x0 - pad), max(0, y0 - pad)
    gx1, gy1 = min(_img.shape[1], x1 + pad + 1), min(_img.shape[0], y1 + pad + 1)
    cov = (255.0 - _img[gy0:gy1, gx0:gx1]) / 255.0
    ink = cov > THR
    if not ink.any():
        raise RuntimeError(name + " 没找到墨迹")
    ys, xs = np.where(ink)
    dx = V / 2.0 - (xs.min() + xs.max()) / 2.0
    dy = V / 2.0 - (ys.min() + ys.max()) / 2.0

    rings = [r for r in contours(cov) if area(r) >= 2.0]
    d = ""
    for r in rings:
        # +0.5: 等值线坐标是"像素中心"(整数), 绘制坐标里像素 i 占 [i,i+1), 中心在 i+0.5
        pts = [(x + 0.5 + dx, y + 0.5 + dy) for x, y in r[:-1]]
        d += "M" + " ".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z"
    print(f"  {name:11s} 环{len(rings):2d} 点{len(d.split()) // 2:3d} 长{len(d):5d}  墨迹 {xs.max()-xs.min()+1}x{ys.max()-ys.min()+1}")
    return d


if __name__ == "__main__":
    out = {}
    boxes = {}
    print("收藏条:")
    for k, b in BAR.items():
        out[k] = trace(k, *b)
        boxes[k] = list(b)
    print("左侧工具栏:")
    for k, (ys, ye) in SIDE_Y.items():
        # x 用真实墨迹收紧: 在 y 区间内找墨迹列范围
        band = (255.0 - _img[ys:ye + 1, 0:66]) / 255.0
        cols = np.where((band > THR).any(axis=0))[0]
        bb = (int(cols.min()), ys, int(cols.max()), ye)
        out[k] = trace(k, *bb)
        boxes[k] = list(bb)
    with open("_icons_tv.json", "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    with open("_icons_tv_boxes.json", "w", encoding="utf-8") as f:
        json.dump(boxes, f, ensure_ascii=False, indent=1)
    print(f"\n{len(out)} 个 -> _icons_tv.json")
