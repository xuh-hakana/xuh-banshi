#!/usr/bin/env python3
import argparse, glob, hashlib, json, os, re, time
HOME = os.path.expanduser('~')
D = os.path.join(HOME, '.dsh/storages/xuhuan-error-watch')
OVR = []
ANSI = re.compile(r'\x1b\[[0-9;]*[A-Za-z]')
TS1 = re.compile(r'^\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d[^\]]*\]')
TS2 = re.compile(r'^\[\d\d:\d\d:\d\d\.\d{3}\]')
ERR = re.compile(r'\[(ERRO|ERROR|CRIT|CRITICAL|FATAL)\]')
WARN = re.compile(r'\[(WARN|WARNING)\]')
KW = re.compile(r'(?i)(失败|错误|异常|超时|拒绝|断开|failed|failure|error|'
                r'exception|traceback|timeout|refused|reset by peer|'
                r'unreachable|cannot connect|no such|not found|crash|'
                r'panic|out of memory|killed)')
IDUMP = re.compile(r'(Background on this error|Failed to |Error occurred|'
                   r'dbapi_error|IntegrityError|OperationalError|'
                   r'Traceback \(most recent)')
HARD = re.compile(r'(startup error:|Logging error in Loguru|'
                  r'Cannot verify the running|下载失败|'
                  r'Exception in thread|Fatal Python error)')
INFOX = re.compile(r'\[(INFO|DEBG|DEBUG)\]')
WIN = 400
AGG_SEC = 3600
DEFAULT_MUTE = [r'astrbot_plugin_banshi_auto\.main',
                r'Event loop watchdog enabled',
                r'WARNING: Retrying',
                r'规则匹配到赞美关键词',
                r'\[配置加载\]',
                r'Loguru Handler']
FRM = re.compile(r'File "([^"]+)", line (\d+)')
COR = re.compile(r'coro=<([\w.]+)')


def clean(s):
    return ANSI.sub('', s)


def isrec(l):
    return bool(TS1.match(l) or TS2.match(l))


def srcs():
    if OVR:
        return list(OVR)
    ps = [os.path.join(HOME, '.astrbot/logs/backend.log'),
          os.path.join(HOME, '.astrbot/logs/backend.log.1'),
          # 机器人自己写的报错（src/diag/report.js）：那些只在内存日志里出现过的问题
          os.path.join(HOME, '.astrbot/logs/xuhbot-error.log'),
          os.path.join(HOME, '.astrbot/logs/desktop.log'),
          os.path.join(HOME, '.astrbot/logs/event_loop_watchdog.log'),
          '/tmp/astrbot-backend.err.log',
          '/tmp/astrbot-backend.out.log']
    d = os.path.join(HOME, 'Library/Logs/DiagnosticReports')
    ps += sorted(glob.glob(d + '/astrbot-*.ips'))
    return [p for p in ps if os.path.exists(p)]


def norm(t):
    t = clean(t)
    t = TS1.sub('', t)
    t = TS2.sub('', t)
    t = re.sub(r'\[\d+\]', '', t)
    t = re.sub(r'\b[0-9a-f]{8,}\b', '#', t)
    t = re.sub(r'\d{3,}', 'N', t)
    return re.sub(r'\s+', ' ', t).strip()[:300]


def rkey(l):
    t = TS1.sub('', clean(l))
    t = TS2.sub('', t)
    i = t.find(']:')
    return t[:i] if i > 0 else t[:60]


def payload(l):
    t = clean(l)
    i = t.find(']:')
    return t[i + 2:].strip() if i > 0 else ''


def fp_of(head, block):
    exc, frm, cor = '', '', ''
    for l in reversed(block):
        s = l.rstrip()
        if s and not s.startswith((' ', '\t', 'Traceback')):
            exc = s[:200]
            break
    for l in reversed(block):
        m = FRM.search(l)
        if m:
            frm = os.path.basename(m.group(1)) + ':' + m.group(2)
            break
    for l in block:
        m = COR.search(l)
        if m:
            cor = m.group(1)
            break
    key = '|'.join([norm(head), norm(exc), frm, cor])
    h = hashlib.sha1(key.encode('utf-8', 'ignore'))
    return h.hexdigest()[:12]


MUTE = []


def load_mute(d):
    global MUTE
    MUTE = []
    p = os.path.join(d, 'mute.txt')
    try:
        if not os.path.exists(p):
            with open(p, 'w', encoding='utf-8') as f:
                f.write('# 一行一个正则，命中即不入队' + chr(10))
        cur = open(p, encoding='utf-8', errors='ignore').read()
        add = [x for x in DEFAULT_MUTE if x not in cur]
        if add:
            with open(p, 'a', encoding='utf-8') as f:
                for x in add:
                    f.write(x + chr(10))
    except Exception:
        pass
    if not os.path.exists(p):
        return
    for l in open(p, encoding='utf-8', errors='ignore'):
        l = l.strip()
        if not l or l.startswith('#'):
            continue
        try:
            MUTE.append(re.compile(l))
        except Exception:
            pass


def sig_of(l):
    return hashlib.sha1(norm(l).encode('utf-8', 'ignore')).hexdigest()[:12]


def pri_of(l):
    return 'high' if ERR.search(l) else 'mid'


def blocks(lines):
    out, i, n = [], 0, len(lines)
    while i < n:
        l = clean(lines[i])
        if any(m.search(l) for m in MUTE):
            i += 1
            continue
        rec = isrec(l)
        hit = (bool(ERR.search(l)) or l.startswith('Traceback (most')
               or 'future: <Task finished' in l
               or 'exception was never retrieved' in l)
        if not hit and rec and WARN.search(l) and KW.search(l):
            hit = True
        if not hit and rec and IDUMP.search(l):
            hit = True
        if not hit and HARD.search(l):
            hit = True
        if (not hit and rec and INFOX.search(l)
                and KW.search(l) and not WARN.search(l)):
            hit = True
        if not hit:
            i += 1
            continue
        p = payload(l)
        if out and p.startswith('|') and rkey(out[-1][0]) == rkey(l):
            out[-1].append(p.lstrip('|').strip())
            i += 1
            continue
        b = [l]
        j = i + 1
        while j < n and not isrec(clean(lines[j])):
            b.append(clean(lines[j]))
            j += 1
            if len(b) >= WIN:
                break
        while b and not b[-1].strip():
            b.pop()
        out.append(b)
        i = max(j, i + 1)
    return out


def load(d):
    p = os.path.join(d, 'state.json')
    if os.path.exists(p):
        try:
            return json.load(open(p, encoding='utf-8'))
        except Exception:
            pass
    return {'files': {}, 'seen': {}, 'pushTimes': []}


def save(d, st):
    now = time.time()
    st['seen'] = dict((k, v) for k, v in st['seen'].items()
                      if now - v < 604800)
    st['pushTimes'] = [t for t in st.get('pushTimes', []) if now - t < 3600]
    p = os.path.join(d, 'state.json')
    with open(p + '.tmp', 'w', encoding='utf-8') as f:
        json.dump(st, f, ensure_ascii=False)
    os.replace(p + '.tmp', p)


def qread(d):
    p = os.path.join(d, 'queue.jsonl')
    rows = []
    if not os.path.exists(p):
        return rows
    for line in open(p, encoding='utf-8'):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except Exception:
            pass
    return rows


def qwrite(d, rows):
    p = os.path.join(d, 'queue.jsonl')
    with open(p + '.tmp', 'w', encoding='utf-8') as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
    os.replace(p + '.tmp', p)


def report(fp, block, src, meta=None):
    meta = meta or {}
    body = '\n'.join(x[:400] for x in block)
    t = time.strftime('%Y-%m-%d %H:%M:%S')
    out = ['# 虚幻报错 · ' + t, '指纹: ' + fp, '来源: ' + src,
           '优先级: ' + str(meta.get('pri', 'high'))]
    if int(meta.get('n', 1)) > 1:
        out.append('同类重复: %d 次/小时' % int(meta.get('n', 1)))
    out += ['', '--- 报错 ---', body, '', '--- 处理协议 ---',
            '1. error_search 查旧条目，没命中再 error_list',
            '2. 按 traceback 的文件:行 定位、改',
            '3. error_add 留痕 class=local section=xuhbot',
            '4. --ack ' + fp + ' 后重新布防 --arm', '']
    return re.sub(r'\d{6,}', '<num>', '\n'.join(out))


def read_new(st, path, start0):
    if not os.path.exists(path):
        return []
    info = st['files'].get(path, {})
    size = os.path.getsize(path)
    ino = os.stat(path).st_ino
    off = info.get('offset', size)
    if start0:
        off = 0
    if info.get('inode') not in (None, ino) or size < off:
        off = 0
    if size <= off:
        st['files'][path] = {'offset': size, 'inode': ino}
        return []
    with open(path, 'rb') as f:
        f.seek(off)
        chunk = f.read()
    text = chunk.decode('utf-8', 'ignore')
    cut = text.rfind('\n')
    if cut < 0:
        return []
    done = text[:cut + 1]
    st['files'][path] = {'offset': off + len(done.encode('utf-8')),
                         'inode': ino}
    return done.splitlines()


def scan(d, st, dry=False, start0=False):
    found = []
    now = time.time()
    agg = st.setdefault('agg', {})
    for path in srcs():
        # 默认增量：--dry-run 不再强制从头读整份日志（1.6MB 全扫 2.2s）；
        # 要全量重扫显式加 --from-start。
        lines = read_new(st, path, start0)
        bl = blocks(lines)
        if path.endswith('.ips') and lines and not bl:
            bl = [['崩溃报告 ' + os.path.basename(path)] + lines[:20]]
        for b in bl:
            if not b:
                continue
            fp = fp_of(b[0], b)
            sig = sig_of(b[0])
            meta = {'pri': pri_of(b[0])}
            a0 = agg.get(sig) or {}
            if not dry and a0 and now - a0.get('ts', 0) < AGG_SEC:
                a0['count'] = int(a0.get('count', 1)) + 1
                a0['ts'] = now
                agg[sig] = a0
                meta['n'] = a0['count']
                found.append((fp, b, path, meta))
                continue
            meta['n'] = int(a0.get('count', 1))
            if dry:
                found.append((fp, b, path, meta))
                continue
            last = st['seen'].get(fp, 0)
            st['seen'][fp] = now
            if now - last < 86400:
                continue
            if len(st.get('pushTimes', [])) >= 5:
                continue
            st['pushTimes'].append(now)
            agg[sig] = {'ts': now, 'count': 1, 'fp': fp}
            found.append((fp, b, path, meta))
    return found


def push(d, found):
    rows = qread(d)
    now = int(time.time())
    for fp, b, p, m in found:
        sig = sig_of(b[0])
        hit = None
        for r in rows:
            if r.get('fp') == fp or (r.get('sig') == sig
                                     and not r.get('acked')):
                hit = r
                break
        if hit is not None:
            hit['sig'] = sig
            hit['n'] = max(int(hit.get('n', 1)), int(m.get('n', 1)))
            continue
        rows.append({'ts': now, 'fp': fp, 'source': p, 'sig': sig,
                     'pri': m.get('pri', 'high'),
                     'n': int(m.get('n', 1)), 'acked': False})
    qwrite(d, rows)


def main():
    global D, OVR
    ap = argparse.ArgumentParser()
    ap.add_argument('--arm', action='store_true')
    ap.add_argument('--once', action='store_true')
    ap.add_argument('--collect', action='store_true')
    ap.add_argument('--status', action='store_true')
    ap.add_argument('--ack')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--poll', action='store_true')
    ap.add_argument('--from-start', action='store_true')
    ap.add_argument('--sweep', action='store_true')
    ap.add_argument('--timeout', type=int, default=3600)
    ap.add_argument('--interval', type=int, default=3)
    ap.add_argument('--files')
    ap.add_argument('--dir')
    # 2026-11-25：手动/外部补报一条（机器人侧 src/diag/report.js 写的是同一个文件，这里给人工留个口）
    ap.add_argument('--report', nargs=2, metavar=('AREA', 'MSG'))
    a = ap.parse_args()
    if a.report:
        area, msg = a.report
        line = '[%s] [ERRO] [%s] %s\n' % (
            time.strftime('%Y-%m-%d %H:%M:%S'), area, clean(msg).replace('\n', ' ')[:400])
        p = os.path.join(HOME, '.astrbot/logs/xuhbot-error.log')
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, 'a', encoding='utf-8') as f:
            f.write(line)
        print('已写入 ' + p + '：' + line.strip())
        return
    if a.dir:
        D = a.dir
    if a.files:
        OVR = a.files.split(',')
    d = D
    os.makedirs(d, exist_ok=True)
    load_mute(d)
    st = load(d)

    if a.poll:
        # 一次调用拿到：增量扫描结果 + 队列状态 + 未处理指纹（省掉 status→once 两次往返）
        found = scan(d, st)
        save(d, st)
        if found:
            push(d, found)
        un = [r for r in qread(d) if not r.get('acked')]
        print(json.dumps({'n_src': len(srcs()), 'seen': len(st['seen']),
                          'unacked': len(un), 'push_hour': len(st.get('pushTimes', [])),
                          'new': len(found),
                          'unacked_fps': [r.get('fp') for r in un][:10]},
                         ensure_ascii=False))
        return

    if a.status:
        un = [r for r in qread(d) if not r.get('acked')]
        print(json.dumps({'n_src': len(srcs()), 'seen': len(st['seen']),
                          'unacked': len(un),
                          'push_hour': len(st.get('pushTimes', []))},
                         ensure_ascii=False))
        return

    if a.ack:
        rows = qread(d)
        for r in rows:
            if r.get('fp') == a.ack:
                r['acked'] = True
        qwrite(d, rows)
        print('ACKED ' + a.ack)
        return

    if a.sweep:
        found = scan(d, st, dry=True, start0=True)
        uniq, seen_sig, nmid = [], set(), 0
        for fp, b, p, m in found:
            if m.get('pri') != 'high':
                nmid += 1
                continue
            s = re.sub(r'[0-9]+', 'N',
                       norm(payload(b[0]) or b[0]))[:70]
            if s in seen_sig:
                continue
            seen_sig.add(s)
            uniq.append((fp, b, p, m))
        push(d, uniq)
        print('SWEEP %d high, skipped_mid %d' % (len(uniq), nmid))
        return

    if a.dry_run:
        found = scan(d, st, dry=True, start0=a.from_start)
        print('命中 %d 块' % len(found))
        for fp, b, p, m in found:
            print('  [%s] %s :: %s' % (fp, os.path.basename(p), b[0][:120]))
        return

    if a.once:
        found = scan(d, st, start0=a.from_start)
        save(d, st)
        push(d, found)
        for fp, b, p, m in found:
            print(report(fp, b, p, m))
        print('NEW %d' % len(found))
        return

    if a.collect:
        while True:
            found = scan(d, st)
            if found:
                push(d, found)
                os.makedirs(os.path.join(d, 'reports'), exist_ok=True)
                now = int(time.time())
                for fp, b, p, m in found:
                    rp = os.path.join(d, 'reports',
                                      str(now) + '-' + fp + '.log')
                    with open(rp, 'w', encoding='utf-8') as f:
                        f.write(report(fp, b, p, m))
            save(d, st)
            time.sleep(a.interval)

    deadline = time.time() + a.timeout
    while time.time() < deadline:
        found = scan(d, st)
        save(d, st)
        if found:
            push(d, found)
            for fp, b, p, m in found:
                print(report(fp, b, p, m))
            print('ARM_DONE')
            return
        un = [r for r in qread(d) if not r.get('acked')]
        if un:
            print('积压未处理 %d 条' % len(un))
            return
        time.sleep(a.interval)
    print('ARM_TIMEOUT')


if __name__ == '__main__':
    main()
