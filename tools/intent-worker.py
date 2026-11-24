#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
intent-worker.py —— 意图分类常驻小工（被 src/intent-router.js 用 spawn 拉起）

落点：
  src/intent-router.js 的 spawnWorker() 用数组参数拉起它：
    <python> tools/intent-worker.py --model-dir <模型目录> --threads 2 --model-file encoder-woq8.onnx
  之后按行喂 JSON，按行收回 JSON。一条进程常驻，避免每条消息都重新加载模型（实测 load ~190ms，冷启一次就够）。

为什么 stdout 只许放 JSON：
  Node 那边是「一行一个响应」按行解析的。任何一句闲聊、一个 warning 打进 stdout 都会让那一行
  解析失败，那条消息就永久 pending 到超时。所以：日志 / 告警一律 sys.stderr，stdout 只留 JSON。

为什么 temperature 用 rejection_policy.json 的 2.3961…，不用 head_meta.json 的 1.0：
  head_meta 里写的是训练时的 1.0；校准后的温度在 rejection_policy.json（v5）里。用 1.0 会让
  置信度整体虚高（softmax 更尖），minConfidence=0.70 那道闸就形同虚设，145 条真实闲聊的误判
  会明显上升。只有 rejection_policy.json 缺失时才回退 head_meta。

为什么 padding_side 用 left：
  推理口径要与 SetFit / SentenceTransformer 对齐（官方 ONNX_INFERENCE.md 的写法）。
  注意：本工一次只 encode 一条（batch=1），永远不会有 padding 发生，left/right 对结果没有影响；
  这里设成 left 纯粹是为了口径一致，免得以后改成批量推理时踩坑。

为什么 tokenizer 用 tokenizers 库，不用 transformers.AutoTokenizer：
  两者结果一致（同一个 tokenizer.json），但 transformers 导入要好几秒，常驻进程里是纯浪费；
  tokenizers 直接 from_file 只要 ~300ms。pad token 从 tokenizer_config.json 里取名字再查 id，
  不写死 151643，换模型也不会错。
"""

import argparse
import json
import os
import sys
import time


def log(msg):
    """所有日志走 stderr，stdout 只留 JSON。"""
    try:
        sys.stderr.write(str(msg) + "\n")
        sys.stderr.flush()
    except Exception:
        pass


def emit(obj):
    """回一行 JSON 并立刻 flush（Node 那边按行读，不 flush 就会一直等）。"""
    sys.stdout.write(json.dumps(obj, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


def die(msg):
    """加载失败：ERROR 打到 stderr，退出码 1。Node 那边靠退出码做退避重启。"""
    log("ERROR: " + str(msg))
    sys.exit(1)


def load_json(path, what):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        die("读不到 %s（%s）：%s" % (what, path, e))


def main():
    ap = argparse.ArgumentParser(description="意图分类常驻小工：stdin/stdout 逐行 JSON")
    ap.add_argument("--model-dir", required=True, help="模型目录（含 head_meta.json / tokenizer.json / *.onnx）")
    ap.add_argument("--threads", type=int, default=2, help="ORT intra_op 线程数")
    ap.add_argument("--model-file", default="encoder-woq8.onnx",
                    help="ONNX 文件名。默认 encoder-woq8.onnx（本模型目录里没有 encoder.onnx）")
    ap.add_argument("--max-length", type=int, default=1024, help="截断长度")
    args = ap.parse_args()

    md = args.model_dir
    if not os.path.isdir(md):
        die("模型目录不存在：" + md)

    # ---- 1. 元数据 ----
    meta = load_json(os.path.join(md, "head_meta.json"), "head_meta.json")
    labels = meta.get("labels") or []
    if not labels:
        die("head_meta.json 里没有 labels")
    domains = meta.get("intent_domains") or {}
    prefix = meta.get("prompt_prefix") or ""

    # 校准温度：优先 rejection_policy.json，其次 head_meta.temperature
    temperature = None
    pol_path = os.path.join(md, "rejection_policy.json")
    if os.path.exists(pol_path):
        policy = load_json(pol_path, "rejection_policy.json")
        try:
            t = float(policy.get("temperature"))
            if t > 0:
                temperature = t
        except Exception:
            temperature = None
    if temperature is None:
        try:
            temperature = float(meta.get("temperature") or 1.0)
        except Exception:
            temperature = 1.0
    if temperature <= 0:
        temperature = 1.0

    # labels.json 只用来校验顺序一致（顺序错 = 全部标签错位，必须早发现）
    lp = os.path.join(md, "labels.json")
    if os.path.exists(lp):
        try:
            lj = load_json(lp, "labels.json")
            l2 = lj.get("labels") if isinstance(lj, dict) else lj
            if isinstance(l2, list) and len(l2) != len(labels):
                die("labels.json 与 head_meta.labels 条数不一致（%d vs %d）" % (len(l2), len(labels)))
        except SystemExit:
            raise
        except Exception as e:
            log("WARN: labels.json 校验跳过：" + str(e))

    # ---- 2. tokenizer ----
    try:
        from tokenizers import Tokenizer
    except Exception as e:
        die("缺 tokenizers 库：%s" % e)

    tok_path = os.path.join(md, "tokenizer.json")
    if not os.path.exists(tok_path):
        die("缺 tokenizer.json：" + tok_path)
    try:
        tok = Tokenizer.from_file(tok_path)
    except Exception as e:
        die("tokenizer 加载失败：%s" % e)

    pad_token = "<|endoftext|>"
    try:
        with open(os.path.join(md, "tokenizer_config.json"), "r", encoding="utf-8") as f:
            tcfg = json.load(f)
        pad_token = tcfg.get("pad_token") or pad_token
    except Exception:
        pass
    pad_id = tok.token_to_id(pad_token)
    if pad_id is None:
        pad_id = 0
        log("WARN: 词表里没有 pad_token %r，pad_id 退回 0" % pad_token)
    try:
        tok.enable_truncation(max_length=int(args.max_length))
        tok.enable_padding(pad_id=pad_id, pad_token=pad_token, direction="left")
    except Exception as e:
        log("WARN: tokenizer padding/truncation 配置失败（batch=1 时无影响）：" + str(e))

    # ---- 3. ONNX session ----
    try:
        import numpy as np
        import onnxruntime as ort
    except Exception as e:
        die("缺 numpy / onnxruntime：%s" % e)

    model_file = args.model_file or "encoder-woq8.onnx"
    model_path = os.path.join(md, model_file)
    if not os.path.exists(model_path):
        alt = os.path.join(md, "encoder.onnx")
        if os.path.exists(alt):
            log("WARN: 没有 %s，改用 encoder.onnx" % model_file)
            model_path = alt
        else:
            die("找不到模型文件：%s" % model_path)

    try:
        so = ort.SessionOptions()
        so.intra_op_num_threads = max(1, int(args.threads))
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess = ort.InferenceSession(model_path, so, providers=["CPUExecutionProvider"])
    except Exception as e:
        die("ONNX session 建立失败（%s）：%s" % (model_path, e))

    try:
        coef = np.load(os.path.join(md, "head_coef.npy"))
        intercept = np.load(os.path.join(md, "head_intercept.npy"))
    except Exception as e:
        die("读不到 head_coef.npy / head_intercept.npy：%s" % e)
    if coef.shape[0] != len(labels):
        die("head_coef 行数 %d 与标签数 %d 不符" % (coef.shape[0], len(labels)))

    # ---- 4. 单条推理 ----
    def infer(text):
        t0 = time.perf_counter()
        enc = tok.encode(prefix + text)  # 口径：prompt_prefix + text
        ids = np.asarray([enc.ids], dtype=np.int64)
        am = np.asarray([enc.attention_mask], dtype=np.int64)
        emb = sess.run(None, {"input_ids": ids, "attention_mask": am})[0]
        logits = (emb @ coef.T + intercept) / temperature
        logits = logits - logits.max(axis=-1, keepdims=True)
        probs = np.exp(logits)
        probs = probs / probs.sum(axis=-1, keepdims=True)
        row = probs[0]
        order = row.argsort()[::-1][:3]
        top3 = [[labels[int(i)], round(float(row[int(i)]), 4)] for i in order]
        best = int(order[0])
        label = labels[best]
        return {
            "label": label,
            "domain": domains.get(label, ""),
            "conf": round(float(row[best]), 4),
            "top3": top3,
            "ms": int(round((time.perf_counter() - t0) * 1000)),
        }

    # ---- 5. 进程内 warmup（跑完这条才算就绪，Node 的 ping 会等到它之后） ----
    # 必须用「接近真实长度」的句子预热，不能只喂一个短词：短词只跑几个 token，JIT/内存池
    # 还没按真实序列长度展开，第一条真实请求仍会 1.3s 左右（实测），容易撞 classifyTimeoutMs。
    try:
        w0 = time.perf_counter()
        for s in (
            "预热",
            "帮我把 config 里那个端口的配置改成 8000，顺便看一下日志里有没有报错",
            "这个报错帮我看看，感觉是依赖没装好，脚本跑不起来",
        ):
            infer(s)
        warm_ms = int(round((time.perf_counter() - w0) * 1000))
    except Exception as e:
        die("warmup 失败：%s" % e)

    log("ready: labels=%d threads=%d model=%s temperature=%.4f warmup=%dms"
        % (len(labels), max(1, int(args.threads)), os.path.basename(model_path), temperature, warm_ms))

    # ---- 6. 主循环：逐行收 JSON，逐行回 JSON ----
    for raw in sys.stdin:
        line = raw.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            emit({"id": None, "ok": False, "error": "bad-json"})
            continue

        rid = req.get("id")
        try:
            if req.get("cmd") == "ping":
                emit({"id": rid, "ok": True, "labels": len(labels)})
                continue

            text = req.get("text")
            if not isinstance(text, str) or not text.strip():
                emit({"id": rid, "ok": False, "error": "empty-text"})
                continue

            # 单条失败只回 ok:false，绝不退出进程（退出会拖垮 Node 侧重启逻辑之外的所有在途请求）
            out = infer(text)
            out["id"] = rid
            out["ok"] = True
            emit(out)
        except Exception as e:
            emit({"id": rid, "ok": False, "error": "infer-failed: %s" % e})


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except KeyboardInterrupt:
        sys.exit(0)
    except Exception as e:  # 兜底：未预期异常也要留下 ERROR 痕迹并给非 0 退出码
        log("ERROR: 未预期异常：%s" % e)
        sys.exit(1)
