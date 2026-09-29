#!/usr/bin/env python3
"""
采集子任务 · 节点端 runner 脚本 (W4-D4 · 2026-05-26)

输入 (stdin JSON · 由 executor 注入):
{
    "task_type": "crawl_subtask",
    "params": {
        # workload.spec.params (全局 · 配方)
        "crawl_order_id": 123,
        "recipe_id": 1,
        "datasource_id": 2,
        "parser_type": "json|html|text",
        "verify_level": 1,
        "unit_price_edg": "0.0001",
        "webhook_url": "",
        # shard.metadata (本片业务参数 · executor merge 时合入)
        "params": {                                # 客户上传的本行参数
            "url": "https://example.com/api?id=42",
            "url_template": "...",                 # 兼容老 recipe
            "method": "GET",
            "headers": {"User-Agent": "EdgeCompute/1.0"},
            "timeout_ms": 30000,
            "parser_config": {"json_path": "$.data"},
        },
        "crawl_seq": 7,
    },
    "workload_id": "crawl_order_123",
    "shard_id": "..."
}

输出 (stdout · JSON):
{
    "ok": true,
    "result_oss_url": "https://oss.example.com/crawl/abc.json",
    "result_hash": "sha256_hex",
    "result_size_bytes": 12345,
    "elapsed_ms": 240,
    "parser_type": "json"
}

失败:
{"ok": false, "error": "...", "url": "...", "elapsed_ms": ...}

MVP 注意:
  - 实际 OSS 上传逻辑由节点的 oss_client 模块负责 (这里只算 hash + 返 inline JSON)
  - 节点 executor 见 ok=true + result_oss_url 为空时 · 走 inline 输出
  - 大输出 (>1MB) 节点应该自己上传 OSS 后返 URL
"""
from __future__ import annotations
import hashlib
import json
import sys
import time
from typing import Any


def main() -> None:
    # 1. 读 stdin
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            _err_exit("stdin empty · executor 没传 params")
            return
        ctx = json.loads(raw)
    except Exception as exc:
        _err_exit(f"parse stdin fail: {exc}")
        return

    params = ctx.get("params") or ctx
    if not isinstance(params, dict):
        _err_exit(f"params 不是 dict · 是 {type(params).__name__}")
        return

    # 2. 拿配方字段 + 本片 params
    parser_type = (params.get("parser_type") or "text").lower()
    body_params = params.get("params") or {}
    if not isinstance(body_params, dict):
        body_params = {}

    # URL 来源 (优先级): body_params.url > body_params.url_template (老兼容)
    url = (body_params.get("url") or body_params.get("url_template") or "").strip()
    if not url:
        _err_exit("crawl_subtask · body.url 缺失")
        return

    method = (body_params.get("method") or "GET").upper()
    headers = body_params.get("headers") or {}
    timeout_ms = int(body_params.get("timeout_ms") or 30000)
    parser_config = body_params.get("parser_config") or {}

    # 3. HTTP fetch · 公网 URL、每跳重定向、响应体均受安全护栏限制
    from _script_safety import open_public_url, read_limited
    if method not in {"GET", "HEAD"}:
        _err_exit("crawl_subtask 仅允许 GET/HEAD")
        return
    max_response_bytes = min(
        max(1, int(body_params.get("max_response_bytes") or 2 * 1024 * 1024)),
        5 * 1024 * 1024,
    )
    start = time.time()
    try:
        resp, checked_url = open_public_url(
            url,
            method=method,
            headers=headers if isinstance(headers, dict) else {},
            timeout_s=max(1, min(timeout_ms / 1000.0, 30)),
            max_bytes=max_response_bytes,
        )
        with resp:
            status_code = int(getattr(resp, "status", 200))
            content = b"" if method == "HEAD" else read_limited(resp, max_response_bytes)
        elapsed_ms = int((time.time() - start) * 1000)
    except Exception as exc:
        elapsed_ms = int((time.time() - start) * 1000)
        _err_exit(f"http fail: {exc}", url=url, elapsed_ms=elapsed_ms)
        return

    if not (200 <= status_code < 400):
        _err_exit(
            f"http {status_code}",
            url=url, elapsed_ms=elapsed_ms,
            status_code=status_code,
        )
        return

    # 4. parse (MVP: 只做最小验证 · 大解析由聚合层做)
    parsed = _parse(content, parser_type=parser_type, parser_config=parser_config)
    if not parsed.get("ok"):
        _err_exit(parsed.get("error", "parse_fail"), url=url, elapsed_ms=elapsed_ms)
        return

    # 5. 算 hash + 输出
    result_hash = hashlib.sha256(content).hexdigest()
    out = {
        "ok": True,
        "contract_version": "1",
        "checked_url": checked_url,
        # MVP: 大输出走 OSS · 但节点 oss_client 集成在 W4 后续 · 这里 inline
        "result_oss_url": "",  # 空 · 节点 executor 走 inline_output (output_ref=stdout JSON)
        "result_hash": result_hash,
        "result_size_bytes": len(content),
        "elapsed_ms": elapsed_ms,
        "parser_type": parser_type,
        # 调试: 保留前 256 字节预览 (节点 admin 排查用 · 生产可关)
        "preview": content[:256].decode("utf-8", errors="replace"),
    }
    print(json.dumps(out, ensure_ascii=False))


def _parse(content: bytes, *, parser_type: str, parser_config: dict) -> dict:
    """最小校验 · 真正业务解析放服务端 aggregator (节点只搬运 + sanity check)"""
    if parser_type == "json":
        try:
            json.loads(content.decode("utf-8", errors="replace"))
            return {"ok": True}
        except Exception as exc:
            return {"ok": False, "error": f"json parse fail: {exc}"}
    if parser_type == "html":
        # MVP · 仅校验非空
        if not content.strip():
            return {"ok": False, "error": "html empty"}
        return {"ok": True}
    # text / 其他 · 通过
    return {"ok": True}


def _err_exit(msg: str, **extra: Any) -> None:
    out = {"ok": False, "error": msg, **extra}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0)  # exit 0 让 executor 拿到 stdout · 它判 ok=false 自己处理


if __name__ == "__main__":
    main()
