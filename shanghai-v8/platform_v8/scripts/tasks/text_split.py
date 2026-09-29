#!/usr/bin/env python3
"""text_split — 文本切分 (企业级 · 2026-06-07 S5 升级)

切分模式:
  - sentence    句子(中英标点切)
  - paragraph   段落(空行分隔)
  - lines       每 N 行
  - chars       每 N 字符
  - rag         **RAG 块**: 字符数 + overlap 重叠 (语义切分推荐)
  - tokens      估算 token (中文 1.5 字 ≈ 1 token · 英文 4 字 ≈ 1 token)

新增:
  - rag 模式带 overlap (默认 200 字符 · 防上下文断裂)
  - by_tokens 估算并切
  - 输出全量 + EC_OUTPUT_DIR/chunks.jsonl
  - 切分 metadata (chunk_id / start_offset / token_estimate)

参数 (EC_PARAMS · 优先于 stdin.params):
  mode           str    sentence/paragraph/lines/chars/rag/tokens
  count          int    lines/chars 模式的尺寸
  chunk_size     int    rag 模式块大小 (字符 · 默认 1000)
  overlap        int    rag 模式重叠 (字符 · 默认 200)
  target_tokens  int    tokens 模式目标 token 数 (默认 512)
  preview_count  int    stdout 返多少块 (默认 200)
"""
import json
import os
import re
import sys
import time


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _split_sentence(text: str) -> list:
    parts = re.split(r"(?<=[。！？!?\.])\s*", text)
    return [p.strip() for p in parts if p.strip()]


def _split_paragraph(text: str) -> list:
    return [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]


def _split_by_chars(text: str, n: int) -> list:
    return [text[i:i + n] for i in range(0, len(text), max(1, n))]


def _split_by_lines(text: str, n: int) -> list:
    lines = text.splitlines()
    n = max(1, n)
    return ["\n".join(lines[i:i + n]) for i in range(0, len(lines), n)]


def _estimate_tokens(s: str) -> int:
    """中日韩字符 1.5 字 ≈ 1 token, 英文 4 字 ≈ 1 token (粗估)"""
    cjk = sum(1 for c in s if "\u4e00" <= c <= "\u9fff" or "\u3000" <= c <= "\u30ff")
    other = len(s) - cjk
    return int(cjk / 1.5 + other / 4) + 1


def _split_rag(text: str, chunk_size: int, overlap: int) -> list:
    """RAG 切分:字符数 + overlap · 优先在句号/换行边界切"""
    if chunk_size <= 0:
        return [text]
    overlap = max(0, min(overlap, chunk_size - 1))
    chunks = []
    start = 0
    n = len(text)
    boundaries = "。！？\n!?."
    while start < n:
        end = min(start + chunk_size, n)
        # 尝试向后找最近的边界 · 但不超 chunk_size * 1.2
        if end < n:
            best = -1
            search_end = min(end + int(chunk_size * 0.2), n)
            for j in range(end, search_end):
                if text[j] in boundaries:
                    best = j + 1
                    break
            if best > 0:
                end = best
        chunk = text[start:end].strip()
        if chunk:
            chunks.append({"text": chunk, "start": start, "end": end})
        if end >= n:
            break
        start = max(start + 1, end - overlap)
    return chunks


def _split_tokens(text: str, target: int) -> list:
    """按估算 token · 累积达 target 切"""
    if target <= 0:
        return [text]
    chunks = []
    buf = []
    buf_tokens = 0
    start = 0
    cur_start = 0
    # 按句子聚合
    sents = _split_sentence(text)
    pos = 0
    for s in sents:
        s_tok = _estimate_tokens(s)
        if buf_tokens + s_tok > target and buf:
            chunks.append({
                "text": "".join(buf),
                "tokens_estimated": buf_tokens,
                "start": cur_start,
            })
            buf = []
            buf_tokens = 0
            cur_start = pos
        buf.append(s)
        buf_tokens += s_tok
        pos += len(s)
    if buf:
        chunks.append({
            "text": "".join(buf),
            "tokens_estimated": buf_tokens,
            "start": cur_start,
        })
    return chunks


def main():
    t0 = time.time()
    try:
        p = _params()
        raw = sys.stdin.read()
        text = raw
        if raw.lstrip().startswith(("{", "[")):
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    text = obj.get("text", raw)
                    merged = dict(obj.get("params") or {})
                    merged.update(p)
                    p = merged
            except Exception:
                pass

        if not str(text or "").strip():
            input_dir = os.environ.get("EC_INPUT_DIR", "")
            parts: list[str] = []
            if input_dir and os.path.isdir(input_dir):
                for fname in sorted(os.listdir(input_dir)):
                    fp = os.path.join(input_dir, fname)
                    if not os.path.isfile(fp) or fname.startswith("."):
                        continue
                    if fname == "input_manifest.v1.json":
                        continue
                    try:
                        with open(fp, "r", encoding="utf-8", errors="replace") as fh:
                            parts.append(fh.read())
                    except Exception:
                        continue
            text = "\n".join(parts)

        if not str(text or "").strip():
            raise ValueError("输入文本为空")

        mode = (p.get("mode") or "sentence").lower()

        if mode == "sentence":
            raw_chunks = _split_sentence(text)
            chunks = [{"text": c, "start": text.find(c, 0 if i == 0 else 0)}
                      for i, c in enumerate(raw_chunks)]
        elif mode == "paragraph":
            raw_chunks = _split_paragraph(text)
            chunks = [{"text": c} for c in raw_chunks]
        elif mode == "lines":
            n = int(p.get("count") or 10)
            chunks = [{"text": c, "lines": n} for c in _split_by_lines(text, n)]
        elif mode == "chars":
            n = int(p.get("count") or 1000)
            chunks = [{"text": c, "start": i * n} for i, c in enumerate(_split_by_chars(text, n))]
        elif mode == "rag":
            cs = int(p.get("chunk_size") or 1000)
            ov = int(p.get("overlap") or 200)
            chunks = _split_rag(text, cs, ov)
        elif mode == "tokens":
            tgt = int(p.get("target_tokens") or 512)
            chunks = _split_tokens(text, tgt)
        else:
            raise ValueError(f"未知 mode={mode}(支持 sentence/paragraph/lines/chars/rag/tokens)")

        # 加 chunk_id + token 估算
        for i, c in enumerate(chunks):
            c["chunk_id"] = i
            if "tokens_estimated" not in c:
                c["tokens_estimated"] = _estimate_tokens(c["text"])

        # 写全量到 EC_OUTPUT_DIR
        out_dir = os.environ.get("EC_OUTPUT_DIR", "")
        output_path = None
        if out_dir and os.path.isdir(out_dir):
            output_path = os.path.join(out_dir, "chunks.jsonl")
            try:
                with open(output_path, "w", encoding="utf-8") as fh:
                    for c in chunks:
                        fh.write(json.dumps(c, ensure_ascii=False) + "\n")
            except Exception:
                output_path = None

        preview_n = max(1, min(1000, int(p.get("preview_count") or 200)))
        elapsed = int((time.time() - t0) * 1000)
        avg_len = sum(len(c["text"]) for c in chunks) / max(1, len(chunks))
        avg_tok = sum(c["tokens_estimated"] for c in chunks) / max(1, len(chunks))
        print(json.dumps({
            "status": "ok", "schema_version": "v1", "task_type": "text_split",
            "elapsed_ms": elapsed,
            "summary": {
                "input_bytes": len(text.encode("utf-8")),
                "input_chars": len(text),
                "chunks": len(chunks),
                "avg_chunk_len": round(avg_len, 1),
                "avg_tokens_estimated": round(avg_tok, 1),
                "mode": mode,
                "output_path": output_path,
            },
            "result_chunks": chunks[:preview_n],
            "summary_text": (
                f"✅ 切分 {len(chunks)} 块 · mode={mode} · "
                f"avg={round(avg_len,1)} 字 / ~{int(avg_tok)} tok · {elapsed}ms"
                + (f"\n📁 全量: {output_path}" if output_path else "")
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "text_split",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
