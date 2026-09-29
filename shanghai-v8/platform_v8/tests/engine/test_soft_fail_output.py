"""软失败识别 + SQLite excluded_workers 写入."""
from __future__ import annotations

import json

from platform_v8.engine.aggregator import _soft_failure_message


def test_soft_failure_detects_v2_empty_input():
    raw = json.dumps(
        {"error": "无输入文件", "output_path": "", "elapsed_ms": 0},
        ensure_ascii=False,
    )
    assert _soft_failure_message(raw) == "无输入文件"


def test_soft_failure_ignores_ok_status():
    raw = json.dumps({"status": "ok", "error": "warn only", "output_path": "/tmp/x"})
    assert _soft_failure_message(raw) is None


def test_soft_failure_ignores_plain_text():
    assert _soft_failure_message("not-json") is None
    assert _soft_failure_message(None) is None
