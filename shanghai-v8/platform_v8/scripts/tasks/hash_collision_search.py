#!/usr/bin/env python3
"""
hash_collision_search.py — 哈希前缀碰撞搜索（CPU 压力测试 / Proof-of-Work）

任务：从 nonce=0 开始递增，找到首个 SHA256(prefix + str(nonce)) 以 N 个零开头的 nonce

输入优先级（仅单份文本）:
  1. EC_PARAMS.prefix / text / inline_input
  2. EC_INPUT_DIR 下恰好 1 个文件
  3. stdin 纯文本
  - 多文件 → 明确失败（避免静默用默认 prefix 假成功）

参数（EC_PARAMS 优先，其次环境变量）:
  target_zeros / TARGET_ZEROS  目标前缀零数量，默认 4（千次级更适合演示）
  max_nonce / MAX_NONCE        最多尝试次数，默认 5e7
"""
from __future__ import annotations

import hashlib
import json
import os
import sys
import time
from pathlib import Path


def _load_params() -> dict:
    try:
        raw = json.loads(os.environ.get("EC_PARAMS", "{}") or "{}")
    except Exception:
        return {}
    return raw if isinstance(raw, dict) else {}


def _int_param(params: dict, *keys: str, default: int) -> int:
    for key in keys:
        if key in params and params[key] is not None and str(params[key]).strip() != "":
            try:
                return int(params[key])
            except (TypeError, ValueError):
                pass
        env = os.environ.get(key)
        if env is not None and str(env).strip() != "":
            try:
                return int(env)
            except (TypeError, ValueError):
                pass
    return default


def _read_prefix(params: dict) -> tuple[str | None, str | None]:
    """返回 (prefix, error)。error 非空表示应失败。"""
    for key in ("prefix", "text", "inline_input"):
        val = params.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip(), None

    input_dir = os.environ.get("EC_INPUT_DIR", "").strip()
    if input_dir and os.path.isdir(input_dir):
        files = sorted(
            p for p in Path(input_dir).rglob("*")
            if p.is_file() and not p.name.startswith(".")
        )
        if len(files) > 1:
            names = ", ".join(p.name for p in files[:5])
            return None, (
                f"哈希碰撞搜索只支持单份文本输入，收到 {len(files)} 个文件"
                f"（{names}{'…' if len(files) > 5 else ''}）。"
                "请改用 1 个文本文件，或在参数里填 prefix。"
            )
        if len(files) == 1:
            text = files[0].read_text(encoding="utf-8", errors="replace").strip()
            if text:
                return text, None
            return None, f"输入文件为空: {files[0].name}"

    raw = sys.stdin.buffer.read()
    text = raw.decode("utf-8", errors="replace").strip()
    if text:
        # 若 stdin 是 JSON 包装，尽量抽出 prefix
        if text.startswith("{"):
            try:
                obj = json.loads(text)
                if isinstance(obj, dict):
                    for key in ("prefix", "text", "inline_input"):
                        val = obj.get(key) or (obj.get("params") or {}).get(key)
                        if isinstance(val, str) and val.strip():
                            return val.strip(), None
            except Exception:
                pass
        return text, None

    return None, None  # 允许默认 prefix


def main() -> int:
    t0 = time.perf_counter()
    params = _load_params()
    target_zeros = max(1, min(8, _int_param(params, "target_zeros", "TARGET_ZEROS", default=4)))
    max_nonce = max(1, _int_param(params, "max_nonce", "MAX_NONCE", default=50_000_000))

    prefix, err = _read_prefix(params)
    if err:
        print(json.dumps({
            "status": "failed",
            "schema_version": "v1",
            "task_type": "hash_collision_search",
            "error": err,
            "summary_text": f"❌ {err}",
        }, ensure_ascii=False))
        return 1

    if not prefix:
        prefix = "edgecompute"

    target_prefix = "0" * target_zeros
    found_nonce = -1
    found_hash = ""
    n = 0
    enc_prefix = prefix.encode("utf-8")
    for nonce in range(max_nonce):
        n += 1
        h = hashlib.sha256(enc_prefix + str(nonce).encode("ascii")).hexdigest()
        if h.startswith(target_prefix):
            found_nonce = nonce
            found_hash = h
            break

    elapsed_ms = int((time.perf_counter() - t0) * 1000)
    throughput = int(n / max(elapsed_ms / 1000.0, 1e-6))
    summary = {
        "prefix": prefix,
        "target_zeros": target_zeros,
        "max_nonce": max_nonce,
        "hash_count": n,
        "found": found_nonce >= 0,
        "found_nonce": found_nonce,
        "found_hash": found_hash,
        "throughput_hash_per_sec": throughput,
    }
    if found_nonce >= 0:
        result_lines = [
            f"nonce={found_nonce}",
            f"hash={found_hash}",
            f"verify: sha256({prefix!r} + str({found_nonce})) starts with {target_prefix!r}",
        ]
    else:
        result_lines = [f"未在 {max_nonce} 次内找到前缀 {target_prefix!r}"]

    summary_text = (
        "═══════════════ 哈希碰撞搜索（PoW） ═══════════════\n"
        f"  prefix 输入：  {prefix!r}\n"
        f"  目标零数：     {target_zeros}\n"
        f"  哈希尝试数：   {n:>12,d}\n"
        f"  吞吐：         {throughput:>12,d}  hash/秒\n"
        f"  耗时：         {elapsed_ms:>12,d} ms\n"
        f"  结果：         {'✓ 找到 nonce=' + str(found_nonce) if found_nonce >= 0 else '✗ 未找到'}\n"
        f"  hash：         {found_hash or '-'}\n"
        "═════════════════════════════════════════════════\n"
    )
    out = {
        "status": "ok",
        "schema_version": "v1",
        "task_type": "hash_collision_search",
        "elapsed_ms": elapsed_ms,
        "summary": summary,
        "result_lines": result_lines,
        "duplicate_groups": [],
        "summary_text": summary_text,
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
