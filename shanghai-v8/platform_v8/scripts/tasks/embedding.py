#!/usr/bin/env python3
"""embedding — 文本向量化 (企业级 · 2026-06-07 S5 升级)

新增:
  - 分批续传 (batch_size · 默认 32 · 防 OOM)
  - 自动重试 + endpoints fallback
  - L2 归一化 (normalize 默认 false · 开启后向量便于 cosine)
  - 相似度计算 (compute_similarity · 余弦)
  - 全量结果写 EC_OUTPUT_DIR/embeddings.jsonl(stdout 仍仅回 preview)
  - EC_PARAMS 统一参数

参数 (EC_PARAMS · 优先于 stdin.params):
  endpoint(s)     str/list
  model           str    (默认 ec-embedding)
  texts           list   优先级:EC_PARAMS.texts > stdin.texts > stdin 每行一文本
  batch_size      int    (默认 32 · 最大 256)
  timeout         int    (默认 60)
  retry           int    (默认 2)
  normalize       bool   L2 归一化 (默认 false)
  compute_similarity     bool · 输出两两余弦相似度(N≤20 才算)
  api_key         str    Bearer
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.request


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _post(url: str, body: dict, headers: dict, timeout: int):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    h = {"Content-Type": "application/json", **headers}
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _call_one_batch(endpoints: list, body: dict, headers: dict,
                    timeout: int, retry: int) -> tuple:
    last_err = None
    for ep in endpoints:
        for attempt in range(retry + 1):
            try:
                return _post(ep, body, headers, timeout), ep
            except urllib.error.HTTPError as he:
                last_err = f"HTTP {he.code} @ {ep}"
                if 400 <= he.code < 500 and he.code != 429:
                    break
            except Exception as exc:
                last_err = f"{exc} @ {ep}"
            if attempt < retry:
                time.sleep(1.5 ** attempt)
    raise RuntimeError(last_err or "全部 endpoint 失败")


def _l2_normalize(vec: list) -> list:
    n = math.sqrt(sum(x * x for x in vec)) or 1.0
    return [x / n for x in vec]


def _cosine(a: list, b: list) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def main():
    t0 = time.time()
    try:
        p = _params()
        raw = sys.stdin.read()
        stdin_obj: dict = {}
        if raw.lstrip().startswith(("{", "[")):
            try:
                stdin_obj = json.loads(raw) or {}
                merged = dict(stdin_obj.get("params") or {})
                merged.update(p)
                p = merged
            except Exception:
                stdin_obj = {}

        # 文本来源
        texts = (p.get("texts") or stdin_obj.get("texts")
                 or stdin_obj.get("lines") or [])
        if not texts and raw and not raw.lstrip().startswith(("{", "[")):
            texts = [l for l in raw.splitlines() if l.strip()]
        if not texts:
            raise ValueError("无输入文本(EC_PARAMS.texts / stdin.texts / stdin 每行)")
        texts = [str(t) for t in texts]

        # endpoints
        endpoints = p.get("endpoints") or []
        if not endpoints and p.get("endpoint"):
            endpoints = [p["endpoint"]]
        if not endpoints:
            endpoints = ["https://www.qianshousuanli.com/api/v1/embeddings"]

        model = p.get("model") or "ec-embedding"
        batch_size = max(1, min(256, int(p.get("batch_size") or 32)))
        timeout = int(p.get("timeout") or 60)
        retry = int(p.get("retry") if p.get("retry") is not None else 2)
        normalize = bool(p.get("normalize", False))
        headers = {}
        if p.get("api_key"):
            headers["Authorization"] = f"Bearer {p['api_key']}"

        # 分批
        vectors: list = []
        errors: list = []
        used_ep = None
        for i in range(0, len(texts), batch_size):
            chunk = texts[i: i + batch_size]
            body = {"model": model, "input": chunk}
            try:
                r, used_ep = _call_one_batch(endpoints, body, headers, timeout, retry)
                batch_vecs = [d["embedding"] for d in (r.get("data") or [])]
                if normalize:
                    batch_vecs = [_l2_normalize(v) for v in batch_vecs]
                vectors.extend(batch_vecs)
            except Exception as exc:
                errors.append({"batch_start": i, "batch_size": len(chunk),
                              "error": str(exc)[:300]})
                # 失败批用占位 None 维持索引对齐
                vectors.extend([None] * len(chunk))

        # 相似度矩阵(小批可算)
        similarity = None
        if p.get("compute_similarity") and len(texts) <= 20:
            similarity = []
            for i in range(len(texts)):
                row = []
                for j in range(len(texts)):
                    if vectors[i] is None or vectors[j] is None:
                        row.append(None)
                    else:
                        row.append(round(_cosine(vectors[i], vectors[j]), 6))
                similarity.append(row)

        # 写全量到 EC_OUTPUT_DIR
        output_path = None
        out_dir = os.environ.get("EC_OUTPUT_DIR", "")
        if out_dir and os.path.isdir(out_dir):
            output_path = os.path.join(out_dir, "embeddings.jsonl")
            try:
                with open(output_path, "w", encoding="utf-8") as fh:
                    for idx, (t, v) in enumerate(zip(texts, vectors)):
                        fh.write(json.dumps({
                            "index": idx, "text": t, "embedding": v,
                        }, ensure_ascii=False) + "\n")
            except Exception as exc:
                errors.append({"stage": "write_output", "error": str(exc)[:200]})
                output_path = None

        ok_n = sum(1 for v in vectors if v is not None)
        if ok_n == 0:
            print(json.dumps({
                "status": "failed", "task_type": "embedding",
                "error": "所有 batch 失败", "errors": errors,
                "summary_text": "❌ embedding 全失败 · 检查 endpoint",
            }, ensure_ascii=False))
            return 1

        dim = next((len(v) for v in vectors if v is not None), 0)
        elapsed = int((time.time() - t0) * 1000)
        # 预览(最多 20 个 · 完整在 output_path)
        preview = vectors[:20]
        print(json.dumps({
            "status": "ok", "schema_version": "v1", "task_type": "embedding",
            "elapsed_ms": elapsed,
            "summary": {
                "total": len(texts),
                "vectors_generated": ok_n,
                "vectors_failed": len(texts) - ok_n,
                "dimensions": dim,
                "model": model,
                "normalized": normalize,
                "endpoint": used_ep,
                "output_path": output_path,
                "batch_size": batch_size,
            },
            "result_vectors": preview,
            "result_similarity": similarity,
            "errors": errors,
            "summary_text": (
                f"✅ 向量化 {ok_n}/{len(texts)} · {model} · dim={dim} · "
                f"{elapsed}ms"
                + (f"\n📁 全量: {output_path}" if output_path else "")
                + (f"\n⚠️ {len(errors)} batch 失败" if errors else "")
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "embedding",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
