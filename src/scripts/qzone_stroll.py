# -*- coding: utf-8 -*-
"""
qzone_stroll.py — 虚幻逛 QQ 空间：转发 + 自己发动态（主人 2026-10-23 定）

用法：
  python qzone_stroll.py <napcat_ws_url> <masterQQ> <masters逗号分隔> <selfQQ> [--dry|--pick]
  python qzone_stroll.py ... --do <qq>|<tid>|<感想>     第二段：直接转发（Node 侧已挑好）
  python qzone_stroll.py ... --post <内容>              发一条自己的说说

铁律（主人 2026-10-23 定，2026-11-18 改为「永久不转重复的」）：
  * **转过的永久绝不转同一条，不设条数上限**——这是硬标准，不是概率引导：挑选阶段就排除
    全部转过的（按 tid 或 同一人+相同正文 双重判重），--do 阶段转发前再查一次，双保险。
    2026-11-18 修：档案统一到 src/data/qzone-history.json（跟 Node 侧同一份），
    以前 Python 读写 scripts/data、Node 读写 src/data，两份分家 → 10-23 转过的 11-18 又转了一遍。
  * 主人的动态**优先**，但不是唯一——其他好友的可转的也一起进候选（top3 随机挑，更像人）。
  * 主人的**原创**说说（非转发、有正文）落盘到 data/qzone-master-moods.jsonl，
    只作为她自己发动态时的选题/口味参考（不进学说话、不抄原文）。
输出：一行 JSON（Node 侧解析）
"""
import sys, json, asyncio, re, os, datetime

ROOT = os.path.dirname(os.path.abspath(__file__))
# 2026-11-18 修：档案统一到 src/data/（Node 侧 qq.js/core.js 读的那份）。
# 原来写 scripts/data/ → Python 和 Node 各记各的，10-23 转过的 11-18 又转了一遍。
HIST_FILE = os.path.join(os.path.dirname(ROOT), 'data', 'qzone-history.json')
MASTER_FILE = os.path.join(ROOT, 'data', 'qzone-master-moods.jsonl')
HISTORY_KEEP = 0            # 0 = 不截断：主人令「永久不转重复的」，丢掉旧档就可能再转
DEDUP_WINDOW = 0            # 0 = 全历史：不设限，不再只看最近 N 条


def clean_text(t):
    return re.sub(r'\s+', ' ', re.sub(r'\\+[tn]', ' ', str(t or ''))).strip()


def norm_text(t):
    return re.sub(r'[\s，。！？、~～…!.?:：;；"\'「」『』()（）【】\[\]-]', '', str(t or ''))


def load_hist():
    try:
        with open(HIST_FILE, 'r', encoding='utf-8') as f:
            h = json.load(f) or {}
    except Exception:
        h = {}
    h.setdefault('reposts', [])
    h.setdefault('posts', [])
    return h


def save_hist(h):
    os.makedirs(os.path.dirname(HIST_FILE), exist_ok=True)
    tmp = HIST_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(h, f, ensure_ascii=False, indent=1)
    os.replace(tmp, HIST_FILE)


def seen_recent(h, qq, tid, text):
    """全部历史转发里有没有这条：tid 相同，或 同一人+归一化正文相同（防 tid 变体）。
    主人 2026-11-18 令「不设限，永久不转重复的」——不截断到最近 N 条，扫全部 reposts。"""
    n = norm_text(text)
    for r in h['reposts']:                 # 全历史，不设限
        if tid and str(r.get('tid') or '') == str(tid):
            return True
        if str(r.get('qq') or '') == str(qq) and n and n == norm_text(r.get('text')):
            return True
    return False


def record_repost(h, qq, tid, text):
    h['reposts'].append({
        't': datetime.datetime.now().isoformat(timespec='seconds'),
        'qq': str(qq), 'tid': str(tid), 'text': clean_text(text)[:120],
    })
    if HISTORY_KEEP > 0:                   # 默认 0=不截断，永久留档
        h['reposts'] = h['reposts'][-HISTORY_KEEP:]


def is_repost_mood(m):
    """转发别人的说说，正文一般是空的或带 //@转发链——这类不算原创，不学习。"""
    c = str(m.get('content') or '')
    return (not c.strip()) or ('//@' in c) or c.strip().startswith('//')


def learn_master_moods(ms):
    """主人原创说说 → data/qzone-master-moods.jsonl（按 tid 去重，只追加新的）。"""
    have = set()
    if os.path.exists(MASTER_FILE):
        try:
            with open(MASTER_FILE, 'r', encoding='utf-8') as f:
                for line in f:
                    try:
                        have.add(str(json.loads(line).get('tid')))
                    except Exception:
                        pass
        except Exception:
            pass
    added = 0
    for m in (ms or []):
        tid = str(m.get('tid') or m.get('key') or '')
        c = clean_text(m.get('content'))
        if not tid or tid in have or is_repost_mood(m) or not c:
            continue
        rec = {'t': datetime.datetime.now().isoformat(timespec='seconds'), 'tid': tid,
               'text': c[:200], 'time': str(m.get('created_time') or '')}
        try:
            with open(MASTER_FILE, 'a', encoding='utf-8') as f:
                f.write(json.dumps(rec, ensure_ascii=False) + '\n')
            have.add(tid)
            added += 1
        except Exception:
            pass
    return added


async def amain():
    args = [a for a in sys.argv[1:]]
    dry = "--dry" in args or "--pick" in args
    do_raw = ""
    if "--do" in args:
        i = args.index("--do")
        if i + 1 < len(args):
            do_raw = args[i + 1]
        args = args[:i] + args[i + 2:]
    post_text = ""
    if "--post" in args:
        i = args.index("--post")
        if i + 1 < len(args):
            post_text = args[i + 1]
        args = args[:i] + args[i + 2:]
    # 2026-11-17 主人令「逛人物列表的人的空间并评论」：
    #   --moods <qq>|<num>              只读，拉这个人最近的说说（给 Node 侧挑与生成用）
    #   --do-comment <qq>|<tid>|<内容>  给一条说说发评论，发完复查 cmtnum 是否真 +1
    moods_raw = ""
    if "--moods" in args:
        i = args.index("--moods")
        if i + 1 < len(args):
            moods_raw = args[i + 1]
        args = args[:i] + args[i + 2:]
    comment_raw = ""
    if "--do-comment" in args:
        i = args.index("--do-comment")
        if i + 1 < len(args):
            comment_raw = args[i + 1]
        args = args[:i] + args[i + 2:]
    # 2026-11-17 主人令「QQ 动态测完自删」：发一条测试说说 → 拿 tid → 立刻删掉。
    probe_text = ""
    if "--post-probe" in args:
        i = args.index("--post-probe")
        if i + 1 < len(args):
            probe_text = args[i + 1]
        args = args[:i] + args[i + 2:]
    args = [a for a in args if a not in ("--dry", "--pick")]
    ws_url = args[0] if args else "ws://127.0.0.1:3001"
    master = args[1] if len(args) > 1 else ""
    masters = set((args[2] if len(args) > 2 else "").split(",")) - {""}
    masters.add(master)
    self_qq = args[3] if len(args) > 3 else ""

    out = {"ok": False}

    def bail(stage, msg):
        out["error"] = str(msg)[:300]
        out["stage"] = stage
        print(json.dumps(out, ensure_ascii=False))
        sys.exit(0)

    try:
        from qzone_sdk import NapCatAuthProvider, QZoneClient
    except Exception as e:
        bail("import", "qzone-sdk 没装上：" + str(e))

    try:
        auth = NapCatAuthProvider(ws_url=ws_url, timeout=12)
        client = QZoneClient(auth_provider=auth, timeout=20)
    except Exception as e:
        bail("auth", "连 NapCat 拿 Cookie 失败：" + str(e))

    hist = load_hist()

    # ---- 只读：拉某人最近的说说（Node 侧逛空间评论用；不参与转发判重）----
    if moods_raw:
        parts = moods_raw.split("|")
        mqq = parts[0].strip()
        num = 10
        if len(parts) > 1 and parts[1].strip().isdigit():
            num = max(1, min(50, int(parts[1].strip())))
        if not mqq.isdigit():
            bail("moods", "QQ 号不对：" + mqq)
        try:
            ms = await client.get_friend_moods(mqq, num=num)
        except TypeError:
            # 2026-11-17 实测：腾讯对某些人返回 code=0、total=10、msglist=null，
            # qzone_sdk 直接 `for msg in data.get("msglist", [])` → None 不可迭代抛 TypeError。
            # 这不是失败、不是限流，是「这人的说说没下发内容」——当空列表继续逛下一个。
            ms = []
        except Exception as e:
            out.update(ok=False, stage="moods", error="拉说说失败：" + str(e)[:200])
            print(json.dumps(out, ensure_ascii=False))
            return
        items = []
        for m in (ms or []):
            tid = str(m.get("tid") or m.get("key") or "")
            if not tid:
                continue
            items.append({
                "tid": tid,
                "text": clean_text(m.get("content")),
                "time": str(m.get("created_time") or ""),
                "cmtnum": int(m.get("cmtnum") or 0),
                "fwdnum": int(m.get("fwdnum") or 0),
                "pics": len(m.get("pic") or []),
                "pic0": (m.get("pic") or [{}])[0].get("url", "") if m.get("pic") else "",
                "rt_tid": str(m.get("rt_tid") or ""),
                "rt_uin": str(m.get("rt_uin") or ""),
                "rt_text": clean_text(m.get("rt_content")),
                "name": str(m.get("name") or ""),
            })
        out.update(ok=True, qq=mqq, moods=items)
        print(json.dumps(out, ensure_ascii=False))
        return

    # ---- 给一条说说发评论（一个动态只发一条：判重由 Node 侧本地记录兜底）----
    # 2026-11-18 主人令「一定要用能规避风险的」：
    #   这里原来一条评论要发 3 次网页请求 —— 发前拉一次列表查 cmtBefore、
    #   发送后再拉一次查 cmtAfter。而 cmtnum 已被证实**不实时**（主人打开链接亲眼看
    #   到评论在，字段仍是 0），这两次复查既判断不了成败，又是最容易被风控盯上的
    #   重复请求。现在改成：评论数由 Node 侧（它刚拉过这一人的说说）作为第 4 段传
    #   进来，只写记录、不再请求。**一条评论 = 1 次网页请求**。
    if comment_raw:
        # 只切前两刀：qq | tid | 剩下全是正文。
        # 正文里万一带竖线也不能被切开（原来 split("|", 2) 会把正文截断）。
        # 评论数从**末尾**的 |数字 认出来，取走它剩下的还回正文。
        parts = comment_raw.split("|", 2)
        if len(parts) < 3:
            bail("comment", "--do-comment 参数格式错：要 qq|tid|内容[|评论数]")
        cqq, ctid = parts[0].strip(), parts[1].strip()
        rest = parts[2]
        before = None
        mtail = re.search(r"\|(\d+)$", rest)
        if mtail:
            rest, before = rest[:mtail.start()], int(mtail.group(1))
        ctext = rest
        if not cqq.isdigit() or not ctid:
            bail("comment", "QQ 号或 tid 不对：" + cqq + " / " + ctid)
        if not ctext.strip():
            bail("comment", "评论内容是空的")
        fid = cqq + "_" + ctid + "__1"       # qzone 的 topicId 口径：{原作者uin}_{tid}__1
        try:
            r = await client.comment(target_qq=cqq, fid=fid, content=ctext)
        except Exception as e:
            out.update(ok=False, commented=False, stage="comment", error="评论异常：" + str(e)[:200])
            print(json.dumps(out, ensure_ascii=False))
            return
        okc = bool(r and r.get("success"))
        out.update(ok=okc, commented=okc, fid=fid, tid=ctid,
                   cmtBefore=before,
                   stage="comment",
                   error="" if okc else ("评论失败：" + str((r or {}).get("message") or "")[:150]))
        print(json.dumps(out, ensure_ascii=False))
        return


    # ---- 测上限：发一条测试说说 → 拿 tid → 立刻自删（2026-11-17 主人令）----
    # 成功判据 = publish 成功且 delete 成功（没删掉绝不算成功，主人空间不能留测试串）。
    if probe_text:
        tid = ""
        published = False
        try:
            r = await client.publish(content=probe_text[:10000], visible=4)  # visible=4 仅自己可见，双保险
            published = bool(r and r.get("success"))
            tid = str((r or {}).get("tid") or "")
        except Exception as e:
            out.update(ok=False, stage="publish", error="发测试说说失败：" + str(e)[:200])
            print(json.dumps(out, ensure_ascii=False))
            return
        if not published or not tid:
            out.update(ok=False, stage="publish", error="发测试说说没成功或没拿到 tid：" + str(r)[:150])
            print(json.dumps(out, ensure_ascii=False))
            return
        # 立即自删：这是硬要求，删不掉必须报出来
        deleted = False
        del_err = ""
        try:
            dr = await client.delete(tid=tid)
            deleted = bool(dr and dr.get("success"))
            del_err = str((dr or {}).get("message") or "")[:150]
        except Exception as e:
            del_err = str(e)[:200]
        out.update(ok=bool(deleted), stage="delete" if not deleted else "done",
                   tid=tid, deleted=deleted, chars=len(probe_text),
                   error=("" if deleted else ("说说发出去了但没删掉，tid=" + tid + "：" + del_err)))
        print(json.dumps(out, ensure_ascii=False))
        return

    # ---- 发自己的说说 ----
    if post_text:
        try:
            r = await client.publish(content=post_text[:200], visible=1)
            if r and r.get("success"):
                hist['posts'].append({'t': datetime.datetime.now().isoformat(timespec='seconds'),
                                      'text': post_text[:200]})
                if HISTORY_KEEP > 0:           # 默认 0=不截断（posts 也是永久留档）
                    hist['posts'] = hist['posts'][-HISTORY_KEEP:]
                save_hist(hist)
                # 2026-11-17：把 tid 带回去 —— 客户端的「她发过的」要能对回空间里那一条
                out.update(ok=True, posted=True, note='说说发出去了', tid=str((r or {}).get('tid') or ''))
            else:
                out.update(posted=False, error='发说说失败：' + str((r or {}).get('message'))[:150], stage='publish')
            print(json.dumps(out, ensure_ascii=False))
        except Exception as e:
            out.update(posted=False, error='发说说失败：' + str(e)[:200], stage='publish')
            print(json.dumps(out, ensure_ascii=False))
        return

    # ---- 拉候选：主人说说（总是拉，主人优先）+ 好友动态（总是拉，好友的也转） ----
    pool = []
    master_log = []
    for mq in sorted(masters - {""}):
        if not mq.isdigit():
            continue
        try:
            ms = await client.get_friend_moods(mq, num=10)
        except Exception as e:
            master_log.append(mq + ":" + str(e)[:60])
            continue
        learn_master_moods(ms)                      # 主人原创说说落盘（学习素材）
        for m in (ms or []):
            if not (m.get("tid") or m.get("key")):
                continue
            pool.append({
                "qq": str(m.get("uin") or mq),
                "tid": m.get("tid") or m.get("key") or "",
                "text": clean_text(m.get("content")),
                "images": len(m.get("pic") or []),
                "isMaster": True,
                "from": "主人说说",
            })
    try:
        feeds = await client.get_feed_list(page=1, count=20)
        for f in (feeds or []):
            qq = str(f.get("opuin") or f.get("uin") or "")
            if (self_qq and qq == str(self_qq)) or qq in masters:
                continue                            # 自己的不转；主人的上面已加过，别重复
            pool.append({
                "qq": qq,
                "tid": f.get("key") or "",
                "text": clean_text(f.get("content")),
                "images": len(f.get("images") or []),
                "isMaster": False,
                "from": "好友动态",
            })
    except Exception as e:
        if not pool:
            bail("feeds", "主人说说和好友动态都拉不到：" + str(e))
        master_log.append("feeds:" + str(e)[:60])

    # 硬标准：转过的永久剔除，不设条数上限，挑选阶段就排除
    fresh = [x for x in pool if not seen_recent(hist, x['qq'], x['tid'], x['text'])]
    if not fresh:
        out.update(ok=True, picked=None, note='这轮没得挑（能看的最近都转过一遍了）'
                   + ('；' + '；'.join(master_log) if master_log else ''))
        print(json.dumps(out, ensure_ascii=False))
        return

    # ---- 第二段：直接转发（qq|tid|感想|正文），转发前再查一次 ----
    if do_raw:
        parts = do_raw.split("|", 3)
        if len(parts) < 2:
            bail("forward", "--do 参数格式错：要 qq|tid|感想|正文（后两段可空）")
        fqq, ftid = parts[0].strip(), parts[1].strip()
        comment = parts[2] if len(parts) > 2 else ""
        ftext = parts[3] if len(parts) > 3 else ""     # 正文带过来，判重记录才有同人+同文指纹
        if seen_recent(hist, fqq, ftid, ftext):
            out.update(ok=True, reposted=False, error='这条以前转过了（永久不转重复的）', stage='forward')
            print(json.dumps(out, ensure_ascii=False))
            return
        try:
            await client.forward(target_qq=fqq, tid=ftid, content=comment)
            record_repost(hist, fqq, ftid, ftext)
            save_hist(hist)
            out.update(ok=True, reposted=True, comment=comment[:120])
            print(json.dumps(out, ensure_ascii=False))
        except Exception as e:
            out.update(reposted=False, error='转发失败：' + str(e)[:200], stage='forward')
            print(json.dumps(out, ensure_ascii=False))
        return

    def score(x):
        s = 40 if x.get("isMaster") else 0          # 主人优先，但不是唯一
        if x.get("text"):
            s += min(len(x["text"]), 60)
        if x.get("images"):
            s += 10
        return s

    fresh.sort(key=score, reverse=True)
    import random
    pick = random.choice(fresh[:3])                 # 前 3 随机挑一个，别每回都盯同一个人
    out.update(ok=True, picked={
        "qq": pick["qq"], "tid": pick["tid"], "text": pick["text"][:120],
        "isMaster": pick["isMaster"], "from": pick["from"], "name": pick.get("name") or "",
    })
    if dry:
        out["reposted"] = False
        out["note"] = "dry 只看没转"
        print(json.dumps(out, ensure_ascii=False))
        return

    try:
        await client.forward(target_qq=pick["qq"], tid=pick["tid"], content="")
        record_repost(hist, pick["qq"], pick["tid"], pick["text"])
        save_hist(hist)
        out["reposted"] = True
    except Exception as e:
        out["reposted"] = False
        out["error"] = "转发失败：" + str(e)[:200]
        out["stage"] = "forward"
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(amain())
