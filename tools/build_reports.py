# -*- coding: utf-8 -*-
"""BTC_Emini日报索引.xlsx  ->  data/reports.json

表格里是 Brookstradingcourse 的 E-mini 每日分析索引 (发布时间 / 文章链接 / 网页名称)。
浏览器读不了 xlsx, 所以这里转成一个 { "YYYY-MM-DD": [url, 标题] } 的字典,
供时间轴上的日期做跳转。用标准库解析 xlsx(zip+xml), 不依赖 openpyxl。

用法:
    python ../../tools/build_reports.py            # 默认找上一级目录里的表
    python ../../tools/build_reports.py 表.xlsx 输出.json
"""
import json
import os
import sys
import zipfile
from datetime import date, timedelta
from xml.etree import ElementTree as ET

NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
EXCEL_EPOCH = date(1899, 12, 30)          # Excel 序列号零点 (含 1900 闰年 bug 的常规修正)
HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_SRC = os.path.join(HERE, '..', '..', 'BTC_Emini日报索引.xlsx')
DEFAULT_OUT = os.path.join(HERE, '..', 'data', 'reports.json')
SHEET = 'xl/worksheets/sheet1.xml'        # 第 1 张表「Emini日报」; 第 2 张是未入选, 不用


def col_no(ref):
    """'B12' -> 2"""
    n = 0
    for ch in ref:
        if ch.isalpha():
            n = n * 26 + (ord(ch.upper()) - 64)
    return n


def read_rows(path, sheet):
    with zipfile.ZipFile(path) as z:
        root = ET.fromstring(z.read(sheet))
        for row in root.iter(NS + 'row'):
            cells = {}
            for c in row.iter(NS + 'c'):
                t = c.get('t', '')
                if t == 'inlineStr':
                    isx = c.find(NS + 'is')
                    val = ''.join(x.text or '' for x in isx.iter(NS + 't')) if isx is not None else ''
                else:
                    v = c.find(NS + 'v')
                    val = (v.text or '') if v is not None else ''
                cells[col_no(c.get('r', ''))] = val
            yield cells


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    out = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_OUT
    src = os.path.abspath(src)
    out = os.path.abspath(out)
    if not os.path.exists(src):
        raise SystemExit('找不到表格: %s' % src)

    data = {}
    seq = []          # 原始顺序, 用来判断"同一天多篇"取哪条
    rows = read_rows(src, SHEET)
    header = next(rows, None)
    if not header:
        raise SystemExit('表是空的')
    for r in rows:
        raw, url, title = r.get(1, ''), (r.get(2) or '').strip(), (r.get(3) or '').strip()
        if not url.startswith('http'):
            continue
        try:
            d = EXCEL_EPOCH + timedelta(days=int(float(raw)))
        except (TypeError, ValueError):
            continue
        key = d.isoformat()
        seq.append(key)
        # 同一天多篇: 保留表里靠前的那条 (表按发布时间倒序, 靠前=最新)
        if key not in data:
            data[key] = [url, title]

    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'), sort_keys=True)

    days = sorted(data)
    dup = len(seq) - len(set(seq))
    print('读出 %d 条, 去重后 %d 天 (同日多篇 %d 条)' % (len(seq), len(days), dup))
    print('日期范围: %s → %s' % (days[0], days[-1]))
    print('写出: %s (%.0f KB)' % (out, os.path.getsize(out) / 1024))


if __name__ == '__main__':
    main()
