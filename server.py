# -*- coding: utf-8 -*-
"""ES 复盘练习 · 本地静态服务器

- 仅绑定 127.0.0.1(不对外)
- 全部响应禁缓存(no-store), 数据/代码改动即时生效
- POST /__shutdown 停止服务(页面"退出"按钮 / 停止.vbs 调用)
- 日志落盘 server.log; 实际端口写入 port.txt 供启动器读取
"""
import os
import socket
import threading
from functools import partial
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

BASE = os.path.dirname(os.path.abspath(__file__))
LOG = open(os.path.join(BASE, 'server.log'), 'a', encoding='utf-8', buffering=1)


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

    def do_POST(self):
        path = self.path.split('?')[0]
        if path == '/__shutdown':
            body = b'{"ok":true}'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            LOG.write('shutdown requested\n')
            threading.Thread(target=self.server.shutdown, daemon=True).start()
        else:
            self.send_error(404)


def pick_port(preferred=8899, tries=12):
    for p in range(preferred, preferred + tries):
        with socket.socket() as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(('127.0.0.1', p))
                return p
            except OSError:
                continue
    raise SystemExit('端口 %d-%d 都被占用' % (preferred, preferred + tries - 1))


def main():
    port = pick_port()
    httpd = ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=BASE))
    with open(os.path.join(BASE, 'port.txt'), 'w', encoding='utf-8') as f:
        f.write(str(port))
    LOG.write('server started: http://127.0.0.1:%d/\n' % port)
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        LOG.write('server stopped\n')
        try:
            os.remove(os.path.join(BASE, 'port.txt'))
        except OSError:
            pass


if __name__ == '__main__':
    main()
