import re

checks = {
    '启动.vbs': ['Set sh = CreateObject("WScript.Shell")', 'sh.Run', 'server.py', 'port.txt', 'Next'],
    '停止.vbs': ['Set sh = CreateObject("WScript.Shell")', 'sh.Popup', 'MSXML.XMLHTTP', '__shutdown', 'On Error GoTo 0'],
}

for name, needles in checks.items():
    raw = open(name, 'rb').read()
    non_ascii = [b for b in raw if b > 127]
    print(name, '->', len(raw), 'bytes, non-ASCII bytes:', len(non_ascii))
    if non_ascii:
        print('   !! still contains non-ASCII')
        continue
    gbk = raw.decode('gbk', errors='strict')
    for n in needles:
        assert n in gbk, 'missing: ' + n
    print('   GBK decode OK, all key statements intact:', ', '.join(needles))
    n_if = len(re.findall(r'\bIf\b', gbk))
    n_endif = len(re.findall(r'\bEnd If\b', gbk))
    print('   If occurrences: %d, End If: %d, lines: %d' % (n_if, n_endif, len(gbk.splitlines())))
