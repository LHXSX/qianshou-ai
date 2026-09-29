"""Read-only loopback Comfy helpers for the controlled qs_new4 adapter.

This canonical module intentionally has no independent graph submission or CLI.
"""
from __future__ import annotations

import json
from pathlib import Path
import urllib.parse
import urllib.request


def request(base: str, route: str, body: dict | None = None) -> dict:
    parsed = urllib.parse.urlparse(base)
    if (parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "::1")
            or parsed.username or parsed.password or parsed.path or parsed.query or parsed.fragment
            or not isinstance(parsed.port, int) or not route.startswith("/")):
        raise ValueError("An explicit loopback Comfy HTTP base and absolute route are required")
    if body is not None and route != "/qs-h3/v1/source-attestation":
        raise ValueError("Canonical runner cannot submit graphs")
    data = None if body is None else json.dumps(body, ensure_ascii=False,
                                                sort_keys=True, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(base + route, data=data,
                                 headers={"Content-Type": "application/json"})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=30) as response:
        raw = response.read(2 * 1024 * 1024 + 1)
    if len(raw) > 2 * 1024 * 1024:
        raise RuntimeError("Comfy response exceeds the canonical limit")
    result = json.loads(raw) if raw else {}
    if not isinstance(result, dict):
        raise RuntimeError("Comfy returned a non-object response")
    return result


def idle(base: str) -> bool:
    queue = request(base, "/queue")
    if (not isinstance(queue.get("queue_running"), list)
            or not isinstance(queue.get("queue_pending"), list)):
        raise RuntimeError("Comfy queue response is malformed")
    return not queue["queue_running"] and not queue["queue_pending"]


def verify_sources(root: Path) -> None:
    """Check minimum source shape; the full manifest verifier is mandatory upstream."""
    if not root.is_absolute() or not root.is_dir():
        raise RuntimeError("Explicit existing Comfy source root is required")
    if not (root / "main.py").is_file() or not (root / "execution.py").is_file():
        raise RuntimeError("Canonical Comfy source root is incomplete")


if __name__ == "__main__":
    raise SystemExit("Standalone H3 benchmark or graph execution is disabled")
