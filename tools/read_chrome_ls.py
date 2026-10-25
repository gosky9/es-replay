"""从 Chrome 的 Local Storage leveldb (.ldb) 里把某个键的值抠出来。

背景: 2026-10-25 我把 data/journal.json 清空了, 服务器侧只剩 10-24 的备份 (15 笔)。
用户浏览器里 localStorage 还有一份 —— Chromium 的 localStorage 存在 leveldb 里,
值可能是 UTF-16 但整个 block 会用 Snappy 压缩过, 直接 grep 只能看到碎片。
这里自己实现一个 Snappy 解压 + leveldb block 解析 (只读, 不改任何文件)。
"""
import json
import sys

MAGIC = 0xdb4775248b80fb57


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


def snappy_decompress(buf, start=0, limit=None):
    """raw snappy block: varint(解压后长度) + tags"""
    end = len(buf) if limit is None else limit
    n, i = varint(buf, start)
    out = bytearray()
    while i < end and len(out) < n:
        tag = buf[i]
        i += 1
        t = tag & 3
        if t == 0:                                    # literal
            ln = tag >> 2
            if ln < 60:
                ln += 1
            else:
                extra = ln - 59
                ln = int.from_bytes(buf[i:i + extra], 'little') + 1
                i += extra
            out += buf[i:i + ln]
            i += ln
        else:                                          # copy
            if t == 1:
                ln = 4 + ((tag >> 2) & 7)
                off = ((tag >> 5) << 8) | buf[i]
                i += 1
            elif t == 2:
                ln = 1 + (tag >> 2)
                off = int.from_bytes(buf[i:i + 2], 'little')
                i += 2
            else:
                ln = 1 + (tag >> 2)
                off = int.from_bytes(buf[i:i + 4], 'little')
                i += 4
            p = len(out) - off
            if p < 0:
                raise ValueError('bad offset')
            for k in range(ln):
                out.append(out[p + k])
    return bytes(out[:n]), i


def parse_block(data):
    """block = 若干前缀压缩 entry + restart 数组 + num_restarts(4B)。只取 entry 部分。"""
    if len(data) < 8:
        return []
    num_restarts = int.from_bytes(data[-4:], 'little')
    if num_restarts <= 0 or num_restarts > len(data) // 4:
        return []
    entries_end = len(data) - 4 - 4 * num_restarts
    out = []
    i = 0
    prev = b''
    while i < entries_end:
        shared, i = varint(data, i)
        non_shared, i = varint(data, i)
        vlen, i = varint(data, i)
        key = prev[:shared] + data[i:i + non_shared]
        i += non_shared
        val = data[i:i + vlen]
        i += vlen
        prev = key
        out.append((key, val))
        if i > len(data):
            break
    return out


def decode_ls_value(val):
    if not val:
        return None
    # Chromium: 第一个字节是编码标记 (0 = UTF-16LE, 1 = Latin-1/UTF-8)
    enc = val[0]
    body = val[1:]
    try:
        if enc == 0:
            return body.decode('utf-16-le', 'replace')
        return body.decode('utf-8', 'replace')
    except Exception:
        return None


def main(path, needle):
    raw = open(path, 'rb').read()
    # 1) 先试「从 0 开始就是一整块 snappy」
    candidates = [0]
    # 2) 再试各个 4KB 边界附近 (leveldb 的 block 大约这么大)
    candidates += [o for o in range(0, min(len(raw), 1 << 20), 512)]
    seen = set()
    for off in candidates:
        if off in seen:
            continue
        seen.add(off)
        try:
            block, _ = snappy_decompress(raw, off)
        except Exception:
            continue
        if needle.encode() in block:
            for k, v in parse_block(block):
                if needle.encode() in k:
                    s = decode_ls_value(v)
                    print('KEY:', k.decode('utf-8', 'replace'))
                    print('VALUE_BEGIN')
                    print(s)
                    print('VALUE_END')
                    return 0
    print('没找到', needle)
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv[1], sys.argv[2]))
