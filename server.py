# -*- coding: utf-8 -*-
"""ES 复盘练习 · 本地静态服务器

- 仅绑定 127.0.0.1(不对外)
- 全部响应禁缓存(no-store), 数据/代码改动即时生效
- GET  /__ping    探活(启动器用它判断"是不是已经有一个在跑了")
- GET  /api/journal  读交易账本(data/journal.json)
- POST /api/journal  写交易账本(原子写: 临时文件 + rename, 断电不会写一半)
- POST /__shutdown 停止服务(页面"退出"按钮 / 停止.vbs 调用)
- 日志落盘 server.log; 实际端口写入 port.txt 供启动器读取
"""
import json
import os
import socket
import threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

BASE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(BASE, 'server.log'), 'a', encoding='utf-8', buffering=1)
JOURNAL = os.path.join(BASE, 'data', 'journal.json')
EMPTY_JOURNAL = {'version': 1, 'trades': [], 'orders': []}


class Server(ThreadingHTTPServer):
    """Windows 上必须关掉 SO_REUSEADDR。

    Linux 的 SO_REUSEADDR 只放行 TIME_WAIT 状态的端口; Windows 的语义却是
    "允许抢占一个已经被别人 listen 的端口", bind 不报错。开着它时 pick_port()
    永远返回 8899, 于是每次双击启动器都多拉起一个 pythonw.exe 且永不退出
    (实测攒了 19 个僵尸进程, 只有 1 个真正在服务)。
    """
    allow_reuse_address = os.name != 'nt'
    daemon_threads = True


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, fmt, *args):
        try:
            LOG.write('[%s] %s\n' % (self.log_date_time_string(), fmt % args))
        except Exception:
            pass

    def _plain(self, body, ctype='text/plain'):
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.split('?')[0] == '/__ping':
            self._plain(b'ok')          # 探活: 启动器据此复用已在跑的服务
            return
        if self.path.split('?')[0] == '/api/journal':
            self._journal_get()
            return
        super().do_GET()

    def _journal_get(self):
        try:
            with open(JOURNAL, 'r', encoding='utf-8') as f:
                body = f.read().encode('utf-8')
        except Exception:
            body = json.dumps(EMPTY_JOURNAL, ensure_ascii=False).encode('utf-8')
        self._plain(body, 'application/json; charset=utf-8')

    def _journal_post(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(n) if n else b''
            obj = json.loads(raw.decode('utf-8'))
            if not isinstance(obj, dict):
                raise ValueError('not an object')
        except Exception as e:
            self.send_error(400, 'bad journal: %s' % e)
            return
        try:
            os.makedirs(os.path.dirname(JOURNAL), exist_ok=True)
            tmp = JOURNAL + '.tmp'
            with open(tmp, 'w', encoding='utf-8') as f:
                json.dump(obj, f, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, JOURNAL)          # 原子替换: 断电不会留下半个文件
            self._plain(b'{"ok":true}', 'application/json')
        except Exception as e:
            LOG.write('journal write failed: %s\n' % e)
            self.send_error(500, 'write failed')

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/api/journal':
            self._journal_post()
        elif path == '/__shutdown':
            self._plain(b'{"ok":true}', 'application/json')
            LOG.write('shutdown requested\n')
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self.send_error(404)


def pick_port(preferred=8899, tries=12):
    # Windows 上 SO_REUSEADDR 探不出"已占用", 必须用 SO_EXCLUSIVEADDRUSE 独占探测
    exclusive = getattr(socket, 'SO_EXCLUSIVEADDRUSE', None) if os.name == 'nt' else None
    for p in range(preferred, preferred + tries):
        with socket.socket() as s:
            if exclusive is not None:
                s.setsockopt(socket.SOL_SOCKET, exclusive, 1)
            else:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(('127.0.0.1', p))
                return p
            except OSError:
                continue
    raise SystemExit('端口 %d-%d 都被占用' % (preferred, preferred + tries - 1))


def already_running():
    """已有一个实例在 127.0.0.1 上应答就返回它的端口。

    启动器 (启动.vbs) 会先探活再决定要不要拉起进程, 但它依赖脚本宿主;
    这里再兜一层: 真的已经有一个在服务, 本次启动直接退出, 不占端口、不覆盖 port.txt。
    这样即便启动器判断失效, 也不会再攒出一堆僵尸 pythonw.exe。
    """
    try:
        with open(os.path.join(BASE, 'port.txt'), encoding='utf-8') as f:
            p = int(f.read().strip())
    except (OSError, ValueError):
        return None
    try:
        with socket.create_connection(('127.0.0.1', p), timeout=0.4) as s:
            s.sendall(b'GET /__ping HTTP/1.0\r\nHost: 127.0.0.1\r\n\r\n')
            head = s.recv(64).split(b'\r\n')[0]
    except OSError:
        return None
    return p if b' 200 ' in head else None


def main():
    alive = already_running()
    if alive:
        LOG.write('already serving on %d, skip this instance (pid %d)\n' % (alive, os.getpid()))
        return
    port = pick_port()
    httpd = Server(('127.0.0.1', port), partial(Handler, directory=BASE))
    with open(os.path.join(BASE, 'port.txt'), 'w', encoding='utf-8') as f:
        f.write(str(port))
    LOG.write('server started: http://127.0.0.1:%d/ (pid %d)\n' % (port, os.getpid()))
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        LOG.write('server stopped (pid %d)\n' % os.getpid())
        try:
            os.remove(os.path.join(BASE, 'port.txt'))
        except OSError:
            pass


if __name__ == '__main__':
    main()
