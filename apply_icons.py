# -*- coding: utf-8 -*-
"""把描边结果写进 index.html, 替换原有的手画图标。可重复运行。"""
import json
import re

icons = json.load(open("_icons_tv.json", encoding="utf-8"))

# data-tool -> 描边图标名
MAP = {
    "cursor": "cursor",
    "trend": "trend",
    "hline": "hline",
    "rect": "rect",
    "fib": "fib",
    "text": "text",
    "measure": "ruler",
    "magnet": "magnet",
    "hide": "eye",
    "trash": "trash",
    "hmlines": "multihline",
    "gannfan": "fan",
    "gannbox": "box",
    "emoji": "emoji",
    "zoomin": "zoom",
    "lockdraw": "penlock",
    "lock": "padlock",
    "link": "link",
}

html = open("index.html", encoding="utf-8").read()
total = 0
for tool, key in MAP.items():
    d = icons[key]
    new_svg = ('<svg viewBox="0 0 56 56"><path fill="currentColor" fill-rule="evenodd" d="'
               + d + '"/></svg>')
    # 匹配 <button ... data-tool="xxx" ...> 后面紧跟的 <svg ...>...</svg>
    pat = re.compile(r'(<button[^>]*data-tool="' + tool + r'"[^>]*>\s*)(<svg\b.*?</svg>)', re.S)
    html, n = pat.subn(lambda m: m.group(1) + new_svg, html)
    print(f"  {tool:10s} -> {key:11s} 替换 {n} 处")
    if n == 0:
        raise SystemExit("没匹配到 data-tool=" + tool)

open("index.html", "w", encoding="utf-8", newline="").write(html)
print("\nindex.html 已更新, 共", sum(1 for _ in MAP), "个图标")
