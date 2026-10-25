"""扫描 Chrome Local Storage 的 leveldb 目录, 把里面所有版本的 es_replay_journal
都解出来看一遍 (只读)。.ldb 里的 block 可能是 Snappy 压过的, .log 里是原始记录,
两种格式都试。用来判断「浏览器里那份账本现在长什么样」。
"""
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from read_chrome_ls import decode_ls_value, parse_block, snappy_decompress

KEY = b'es_replay_journal'
IMPOSSIBLE = ['T-mvlgj779', 'T-mvlgj77v', 'T-mvlgj78j', 'T-mvlgjnii', 'T-mvlgjnj2',
              'T-mvlgjnjm', 'T-mvlx5p7s', 'T-mvlx6oyw', 'T-mvlx6xaw',   # 第一轮删的 9 笔
              'T-mvntfx4b', 'T-mvntfij6', 'T-mvntfob0', 'T-mvntfyq']     # 20:40 那批假单


def brace_json(s):
    i = s.find('{"version"')
    if i < 0:
        return None
    s = s[i:]
    depth = 0
    for k, ch in enumerate(s):
        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return s[:k + 1]
    return None


def varint(buf, i):
    shift = 0
    val = 0
    while True:
        b = buf[i]
        i += 1
        val |= (b & 0x7F) << shift
        if not (b & 0x80):
            return val, i
        shift += 7


MAGIC = 0xdb4775248b80fb57


def read_block(raw, off, size):
    """block data + 5 字节 trailer (1 字节压缩类型 + 4 字节 crc)"""
    data = raw[off:off + size]
    typ = raw[off + size] if off + size < len(raw) else 0
    if typ == 1:
        try:
            data, _ = snappy_decompress(data)
        except Exception:
            pass
    return data


def from_ldb(path):
    """正经读法: footer → index block → 每个 data block。
    只按 512 字节步长盲试偏移是找不到大表里的 block 的 (2026-10-25 踩到)。"""
    raw = open(path, 'rb').read()
    out = []
    try:
        footer = raw[-48:]
        i = 0
        _mo, i = varint(footer, i)
        _ms, i = varint(footer, i)
        io_, i = varint(footer, i)
        isz, i = varint(footer, i)
        for _k, v in parse_block(read_block(raw, io_, isz)):
            bo, j = varint(v, 0)
            bs, j = varint(v, j)
            for kk, vv in parse_block(read_block(raw, bo, bs)):
                if KEY in kk:
                    out.append(decode_ls_value(vv))
    except Exception:
        pass
    if out:
        return out
    # 兜底: 小文件里 block 可能在开头, 盲试
    for off in range(0, min(len(raw), 1 << 20), 64):
        try:
            block, _ = snappy_decompress(raw, off)
        except Exception:
            continue
        if KEY not in block:
            continue
        for k, v in parse_block(block):
            if KEY in k:
                out.append(decode_ls_value(v))
    return out


def from_log(path):
    raw = open(path, 'rb').read()
    out = []
    for m in re.finditer(KEY, raw):
        seg = raw[m.end():m.end() + 300000]
        for off in range(0, 4):
            for enc in ('utf-16-le', 'utf-8'):
                try:
                    s = seg[off:].decode(enc, 'ignore')
                except Exception:
                    continue
                j = brace_json(s)
                if j:
                    out.append(j)
    return out


def main(d):
    rows = []
    for path in sorted(glob.glob(os.path.join(d, '*'))):
        name = os.path.basename(path)
        try:
            if name.endswith('.ldb'):
                cand = from_ldb(path)
            elif name.endswith('.log'):
                cand = from_log(path)
            else:
                continue
        except (FileNotFoundError, PermissionError):
            continue          # Chrome 正在轮转文件, 跳过就好
        except Exception:
            continue
        for s in cand:
            try:
                o = json.loads(s)
            except Exception:
                continue
            rows.append((os.path.getmtime(path), name, o))
    if not rows:
        print('没找到账本记录')
        return
    rows.sort(key=lambda r: r[0])
    for mt, name, o in rows:
        t = len(o.get('trades') or [])
        od = len(o.get('orders') or [])
        tomb = len(o.get('deleted') or [])
        bad = [x for x in IMPOSSIBLE
               if any(str(tr.get('id', '')).startswith(x) for tr in (o.get('trades') or []))]
        print('%s  trades=%-3d orders=%-3d tombstones=%-2d 假单残留=%s' %
              (name, t, od, tomb, bad if bad else '无'))


if __name__ == '__main__':
    main(sys.argv[1])
