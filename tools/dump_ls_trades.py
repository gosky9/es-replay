"""把 Chrome leveldb 里那份 es_replay_journal 的交易逐条列出来 (只读, 不写任何文件)。

用法:
    python tools/dump_ls_trades.py <leveldb 目录>

只做诊断, 用来判断「用户浏览器里到底有哪些单子、哪些不是他做的」。
"""
import glob
import json
import os
import sys
import datetime

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from scan_ls_journal import from_ldb, from_log

KEY_PREFIX = 'es_replay_journal'


def pick_latest(d):
    """取 mtime 最新、且记录条数最多的那一份"""
    best = None
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
            continue
        except Exception:
            continue
        for s in cand:
            try:
                o = json.loads(s)
            except Exception:
                continue
            if 'trades' not in o:
                continue
            rank = (len(o.get('trades') or []) + len(o.get('orders') or []), os.path.getmtime(path))
            if best is None or rank > best[0]:
                best = (rank, name, o)
    return best


def born(idstr):
    """从 T-xxxx-x / O-xxxx-x 里解创建毫秒。

    id 里有两个 '-' (前缀 + 时间 + 随机尾), 必须只取中间那段 ——
    直接 int(整串, 36) 会因为遇到第二个 '-' 抛异常, 全都解不出来。
    """
    if not isinstance(idstr, str):
        return None
    parts = idstr.split('-')
    if len(parts) < 2:
        return None
    try:
        n = int(parts[1], 36)
    except Exception:
        return None
    return n if 1e12 < n < 1e13 else None


def ts(ms):
    if ms is None:
        return '--'
    return datetime.datetime.fromtimestamp(ms / 1000).strftime('%m-%d %H:%M:%S')


def main(d):
    best = pick_latest(d)
    if not best:
        print('没找到账本')
        return
    _rank, name, o = best
    trades = o.get('trades') or []
    orders = o.get('orders') or []
    tomb = set(o.get('deleted') or [])
    print('来源文件: %s' % name)
    print('trades=%d  orders=%d  tombstones=%d' % (len(trades), len(orders), len(tomb)))
    print('')
    print('%-20s %-14s %-12s %-12s %-10s %-9s %8s %7s  %s' %
          ('id', 'sessionId', 'entryTime', 'exitTime', 'setup', 'dir', 'pnl', 'price0', '出生时间(由id反解)'))
    print('-' * 150)
    rows = []
    for t in trades:
        rows.append((born(t.get('id')), t))
    rows.sort(key=lambda r: (r[0] or 0))
    for b, t in rows:
        sid = str(t.get('sessionId') or '')[:12]
        et = str(t.get('entryTime') or t.get('entryEpoch') or '')[:19]
        xt = str(t.get('exitTime') or t.get('exitEpoch') or '')[:19]
        setup = str(t.get('setup') or '')[:11]
        d_ = str(t.get('dir') or '')[:8]
        pnl = t.get('pnl')
        pnl_s = ('%.2f' % pnl) if isinstance(pnl, (int, float)) else str(pnl or '')
        # 找入场价: 兼容几种字段名
        p0 = None
        for k in ('entryPrice', 'entry', 'openPrice', 'price'):
            if isinstance(t.get(k), (int, float)):
                p0 = t[k]
                break
        flag = ''
        if str(t.get('id')) in tomb:
            flag = '  <墓碑>'
        print('%-20s %-14s %-12s %-12s %-10s %-9s %8s %7s  %s%s' %
              (str(t.get('id'))[:20], sid, et, xt, setup, d_, pnl_s,
               ('%.2f' % p0) if p0 is not None else '--', ts(b), flag))
    print('')
    print('=== 挂单 %d 条 ===' % len(orders))
    for od in orders:
        b = born(od.get('id'))
        print('%-20s %-14s %-10s %-9s %s' % (
            str(od.get('id'))[:20], str(od.get('sessionId') or '')[:12],
            str(od.get('status') or '')[:9], str(od.get('dir') or '')[:8], ts(b)))


if __name__ == '__main__':
    main(sys.argv[1])
