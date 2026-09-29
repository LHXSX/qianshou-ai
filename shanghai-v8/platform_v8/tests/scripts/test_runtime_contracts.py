"""小杜主责脚本的运行时契约与安全护栏测试。"""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest


SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def _run(name: str, *, params: dict | None = None, stdin: str = "") -> tuple[int, dict]:
    env = os.environ.copy()
    env["EC_PARAMS"] = json.dumps(params or {})
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / f"{name}.py")],
        input=stdin,
        text=True,
        capture_output=True,
        env=env,
        timeout=20,
    )
    return proc.returncode, json.loads(proc.stdout.strip().splitlines()[-1])


@pytest.mark.parametrize("name", ["auto_post", "app_register", "video_view", "weibo_comment"])
def test_unintegrated_automation_never_claims_success(name: str):
    code, output = _run(name)
    assert code == 0
    assert output["status"] == "failed"
    assert output["failure_class"] == "feature_unavailable"
    assert output["contract_version"] == "1"


def test_url_check_rejects_loopback_without_network_access():
    code, output = _run("url_check", stdin="http://127.0.0.1:1\n")
    assert code == 0
    assert output["status"] == "ok"
    assert output["result"][0]["ok"] is False
    assert "禁止访问" in output["result"][0]["error"]


@pytest.mark.parametrize("name", ["price_monitor", "stock_monitor"])
def test_monitor_batches_do_not_truncate_and_reject_loopback(name: str):
    urls = [f"http://127.0.0.1:{9000 + i}/item" for i in range(12)]
    code, output = _run(name, params={"urls": urls})

    assert code == 0
    assert output["status"] == "ok"
    assert len(output["results"]) == len(urls)
    assert output["summary"]["total"] == len(urls)
    assert all(row["status"] == "error" for row in output["results"])
    assert all("禁止访问" in row["error"] for row in output["results"])


def test_pi_and_monte_carlo_expose_numeric_summary(script_runner):
    pi = script_runner("pi_compute", stdin="100")
    assert pi["contract_version"] == "1"
    assert 3.1 < pi["summary"]["value"] < 3.2

    monte = script_runner("monte_carlo", params={"samples": 1000, "parallel": 1})
    assert monte["contract_version"] == "1"
    assert monte["summary"]["value"] == monte["result"]


def test_pdf_slice_meta_maps_to_page_range(monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "pdf_to_text_under_test", SCRIPTS_DIR / "pdf_to_text.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("EC_SLICE_META", json.dumps({"page_start": 3, "page_end": 6}))
    assert module._apply_slice_meta({})["page_range"] == "3-6"


def test_media_slice_meta_supports_both_field_names(monkeypatch):
    spec = importlib.util.spec_from_file_location(
        "video_compress_under_test", SCRIPTS_DIR / "video_compress.py",
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setenv("EC_SLICE_META", json.dumps({"start_sec": 12, "end_sec": 18}))
    assert module._slice_window() == (12.0, 18.0)
