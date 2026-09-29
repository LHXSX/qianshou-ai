#!/usr/bin/env python3
"""llm_summarize — 文本摘要 (企业级 · 2026-06-07 S5 升级)

本地 extractive · 不依赖 LLM · 零 API 成本。

新增:
  - 多算法 method: extractive_tf (默认) / lead_n / textrank_lite
  - 多语言句子切分(中文 。!? + 英文 . !? + 换行)
  - 关键词输出 (top_keywords)
  - 大文本分块(> 50KB 自动分块摘要后合并)
  - max_length 中文字符计数(原版按字节)
  - 输入支持: stdin JSON / stdin 纯文本 / EC_PARAMS.text / EC_INPUT_DIR(批处理)

参数 (EC_PARAMS):
  text             str   直接传文本(若没传走 stdin / EC_INPUT_DIR)
  max_length       int   摘要最大字符数 (默认 200)
  method           str   extractive_tf (默认) / lead_n / textrank_lite
  lead_n           int   lead_n 模式取前 N 句 (默认 3)
  top_keywords     int   关键词数量 (默认 8)
  language         str   zh / en / auto (默认 auto)
"""
import json
import os
import re
import sys
import time


# 多语言句子切分:中日韩 ?!.句号 + 换行
_SENT_END_RE = re.compile(r"(?<=[。！？!?\.])\s+|\n+")
# 词:中日韩字符独立计 + 英文/数字单词
_WORD_RE = re.compile(r"[\u4e00-\u9fa5]|[\u3040-\u309f]|[\u30a0-\u30ff]|[A-Za-z0-9]+")
# 简单停用词(中英常见)
_STOPWORDS = set("的 一 了 是 在 我 有 和 也 这 那 你 他 她 们 就 都 而 与 及 或 等".split()) | \
             set("the a an of and or to in is are was were be have has had do does this that these those for with on at by".split())


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def split_sentences(text: str) -> list:
    """多语言句子切分 · 中英混合 OK"""
    if not text:
        return []
    sents = _SENT_END_RE.split(text)
    return [s.strip() for s in sents if s.strip()]


def _tokenize(text: str) -> list:
    return [t.lower() for t in _WORD_RE.findall(text)]


def _word_freq(text: str) -> dict:
    wf: dict = {}
    for w in _tokenize(text):
        if w in _STOPWORDS:
            continue
        wf[w] = wf.get(w, 0) + 1
    return wf


def _score_sentence(sent: str, wf: dict) -> float:
    toks = _tokenize(sent)
    if not toks:
        return 0
    return sum(wf.get(w, 0) for w in toks if w not in _STOPWORDS) / max(len(toks), 1)


def _summarize_chunk(text: str, max_len: int, method: str, lead_n: int) -> tuple:
    """单块摘要 · 返 (summary_text, sentence_count)"""
    sents = split_sentences(text)
    if not sents:
        return "", 0

    if method == "lead_n":
        chosen = sents[:max(1, lead_n)]
        summary = "".join(chosen)[:max_len]
        return summary, len(sents)

    # extractive_tf / textrank_lite 都先算词频
    wf = _word_freq(text)
    if method == "textrank_lite":
        # 简化 textrank:句子得分 = TF + 与首句 token 重叠加成
        first_toks = set(_tokenize(sents[0])) if sents else set()
        chosen_idx = {0}
        scored = []
        for i, s in enumerate(sents[1:], start=1):
            base = _score_sentence(s, wf)
            overlap = len(set(_tokenize(s)) & first_toks) * 0.1
            scored.append((base + overlap, i))
        scored.sort(reverse=True)
        for _, i in scored:
            chosen_idx.add(i)
            if sum(len(sents[j]) for j in chosen_idx) > max_len:
                break
        return "".join(sents[i] for i in sorted(chosen_idx))[:max_len], len(sents)

    # extractive_tf (默认)
    chosen_idx = {0} if sents else set()
    scored = sorted(
        ((_score_sentence(s, wf), i) for i, s in enumerate(sents) if i != 0),
        reverse=True,
    )
    for _, i in scored:
        chosen_idx.add(i)
        if sum(len(sents[j]) for j in chosen_idx) > max_len:
            break
    return "".join(sents[i] for i in sorted(chosen_idx))[:max_len], len(sents)


def _top_keywords(text: str, n: int = 8) -> list:
    wf = _word_freq(text)
    top = sorted(wf.items(), key=lambda kv: kv[1], reverse=True)[:n]
    return [{"word": w, "count": c} for w, c in top]


def _read_input(p: dict) -> tuple:
    """返 (text, source) · source 标 'param' / 'stdin' / 'file'"""
    if p.get("text"):
        return p["text"], "param"

    # EC_INPUT_DIR 单文件
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        for fname in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, fname)
            if os.path.isfile(fp):
                try:
                    with open(fp, "r", encoding="utf-8", errors="replace") as fh:
                        return fh.read(), "file"
                except Exception:
                    continue

    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    if not raw:
        return "", "none"
    s = raw.strip()
    if s.startswith("{") or s.startswith("["):
        try:
            obj = json.loads(s)
            if isinstance(obj, dict):
                if obj.get("text"):
                    if obj.get("params"):
                        p.update(obj["params"])
                    return obj["text"], "stdin"
        except Exception:
            pass
    return raw, "stdin"


def main() -> int:
    t0 = time.time()
    p = _params()
    try:
        text, source = _read_input(p)
        text = (text or "").strip()
        if not text:
            raise ValueError("输入文本为空")

        max_len = max(20, min(5000, int(p.get("max_length", 200))))
        method = p.get("method", "extractive_tf")
        if method not in ("extractive_tf", "lead_n", "textrank_lite"):
            method = "extractive_tf"
        lead_n = int(p.get("lead_n") or 3)

        # 大文本分块(> 50KB)
        CHUNK_SIZE = 50 * 1024
        chunks_processed = 1
        if len(text) > CHUNK_SIZE:
            # 按段落切块
            chunks = []
            cur = []
            cur_len = 0
            for para in text.split("\n\n"):
                cur.append(para)
                cur_len += len(para)
                if cur_len > CHUNK_SIZE:
                    chunks.append("\n\n".join(cur))
                    cur = []
                    cur_len = 0
            if cur:
                chunks.append("\n\n".join(cur))
            # 每块摘要 max_len / N · 再合并 → 最终二次摘要
            per_chunk_max = max(50, max_len * 2 // len(chunks))
            partials = []
            for ch in chunks:
                s, _ = _summarize_chunk(ch, per_chunk_max, method, lead_n)
                partials.append(s)
            chunks_processed = len(chunks)
            # 合并后做二次摘要(防总长超 max_len)
            merged = "\n".join(partials)
            summary, sent_count = _summarize_chunk(merged, max_len, method, lead_n)
        else:
            summary, sent_count = _summarize_chunk(text, max_len, method, lead_n)

        # 关键词
        top_k_n = max(0, min(20, int(p.get("top_keywords") or 8)))
        keywords = _top_keywords(text, top_k_n) if top_k_n > 0 else []

        elapsed = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok",
            "schema_version": "v1",
            "task_type": "llm_summarize",
            "elapsed_ms": elapsed,
            "summary": {
                "input_length": len(text),
                "output_length": len(summary),
                "method": method,
                "sentence_count": sent_count,
                "chunks_processed": chunks_processed,
                "compression_ratio": round(len(summary) / max(1, len(text)), 3),
                "source": source,
                "language_hint": p.get("language", "auto"),
            },
            "result_text": summary,
            "result_keywords": keywords,
            "summary_text": (
                f"✅ 文本摘要 ({method})\n"
                f"📏 {len(text):,} 字 → {len(summary):,} 字 "
                f"({round(len(summary)/max(1,len(text))*100,1)}%)\n"
                f"📦 块数: {chunks_processed} · 句数: {sent_count}\n"
                f"🔑 关键词: {', '.join(k['word'] for k in keywords[:5])}\n"
                f"⏱ {elapsed}ms"
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "llm_summarize", "error": str(e),
            "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
