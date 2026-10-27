"""只读诊断: 打印某个时间窗口内指定周期的 K 线 (不入库、不改任何东西)

用法:
  python tools/dump_window.py rth 5m 2024-02-01T10:15 2024-02-01T10:35
  python tools/dump_window.py rth 1m 2024-02-01T10:15 2024-02-01T10:30

时间一律按 **ET 墙钟** 给 (和界面一致), 内部再换算成 epoch。
"""
import gzip
import json
import os
import struct
import sys
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def parse_bin(path):
    with gzip.open(path, 'rb') as f:
        buf = f.read()
    magic = buf[0:4]
    if magic != b'ESB1':
        raise SystemExit('格式不对: ' + path)
    pad = buf[7]
    count = struct.unpack_from('<I', buf, 8)[0]
    p = 24
    time = struct.unpack_from('<%di' % count, buf, p); p += count * 4
    off = struct.unpack_from('<%db' % count, buf, p); p += count + pad
    o = struct.unpack_from('<%df' % count, buf, p); p += count * 4
    h = struct.unpack_from('<%df' % count, buf, p); p += count * 4
    l = struct.unpack_from('<%df' % count, buf, p); p += count * 4
    c = struct.unpack_from('<%df' % count, buf, p); p += count * 4
    return list(zip(time, off, o, h, l, c))


def main():
    if len(sys.argv) < 5:
        raise SystemExit(__doc__)
    session, tf, a, b = sys.argv[1:5]
    # ET 墙钟 → "假 UTC" epoch: 直接按 UTC 造出来, 再减去该时刻的 ET 偏移是反的…
    # 数据里的 time 是真实 epoch, off 是当时的 ET 偏移(小时, 负数)。
    # 所以 ET 墙钟 W 对应的真实 epoch = W - off*3600。这里直接遍历当天数据比对墙钟。
    meta = json.load(open(os.path.join(ROOT, 'data', 'meta.json'), encoding='utf-8'))
    files = meta['files'][session + '_' + tf]

    def wall(ts, off):
        return datetime.fromtimestamp(ts, timezone.utc) + timedelta(hours=off)

    want_a = a.replace('T', ' ')
    want_b = b.replace('T', ' ')
    for f in files:
        rows = parse_bin(os.path.join(ROOT, 'data', f['f']))
        for ts, off, o, h, l, c in rows:
            s = wall(ts, off).strftime('%Y-%m-%d %H:%M')
            if want_a <= s <= want_b:
                print('%s  o=%.2f h=%.2f l=%.2f c=%.2f' % (s, o, h, l, c))


if __name__ == '__main__':
    main()
