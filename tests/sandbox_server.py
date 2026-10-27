# -*- coding: utf-8 -*-
"""跑 e2e / 视觉自检用的「隔离服务」—— 账本和绘图存档跟真实的分开存。

为什么需要:
  e2e 的流程是「备份 → 清空 → 跑 → 还原」, 那两分钟里磁盘上的
  data/journal.json 是**空的**。用户如果正好在练习, 这段窗口里成交的单子
  虽然还留在浏览器 localStorage 里(下次打开会被并集带回来), 但磁盘上是没有的,
  事后排查很容易以为丢账。
  (2026-10-25 就因为一个崩在半路的探针把 19 笔清成了空文件。)

做法:
  复用 server.py 的 Handler —— 静态文件照旧从项目根目录出, 只把
  /api/journal 与 /api/draw 这两个存档接口指向本文件同目录下的副本。
  真实账本一个字节都不会被碰。

用法:
  python tests/sandbox_server.py 8900        # 前台跑, Ctrl+C 停
  ES_BASE=http://127.0.0.1:8900 node tests/e2e.js
"""
import os
import socket
import sys
from functools import partial

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)
import server  # noqa: E402  (必须先改 sys.path)

SANDBOX = os.path.join(HERE, '_sandbox')


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8900
    os.makedirs(SANDBOX, exist_ok=True)

    # 存档接口改指向沙箱副本; 静态文件(BASE)仍指真实项目目录
    server.JOURNAL = os.path.join(SANDBOX, 'journal.json')
    server.DRAW = os.path.join(SANDBOX, 'draw.json')
    server.ARCHIVES['/api/journal'] = ('journal', server.JOURNAL, server.EMPTY_JOURNAL)
    server.ARCHIVES['/api/draw'] = ('draw', server.DRAW, server.EMPTY_DRAW)
    server.LOG = open(os.path.join(SANDBOX, 'server.log'), 'a', encoding='utf-8', buffering=1)

    for p in (server.JOURNAL, server.DRAW):
        if not os.path.exists(p):
            with open(p, 'w', encoding='utf-8') as f:
                f.write('{"version":1,"trades":[],"orders":[]}' if 'journal' in p
                        else '{"version":1,"byTf":{},"updatedAt":0}')

    # 独占探测: 端口被占就直接报错, 不要偷偷换端口(测试脚本要连固定地址)
    with socket.socket() as s:
        excl = getattr(socket, 'SO_EXCLUSIVEADDRUSE', None) if os.name == 'nt' else None
        if excl is not None:
            s.setsockopt(socket.SOL_SOCKET, excl, 1)
        try:
            s.bind(('127.0.0.1', port))
        except OSError:
            raise SystemExit('端口 %d 已被占用' % port)

    print('sandbox server: http://127.0.0.1:%d/  (账本 -> %s)' % (port, server.JOURNAL), flush=True)
    httpd = server.Server(('127.0.0.1', port), partial(server.Handler, directory=server.BASE))
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        print('sandbox server stopped', flush=True)


if __name__ == '__main__':
    main()
