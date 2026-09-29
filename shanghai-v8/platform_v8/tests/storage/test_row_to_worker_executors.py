"""R-1 · _row_to_worker 必须恢复 supported_executors / native_binaries / onnx_models。"""
from __future__ import annotations

import json
import sys
from datetime import datetime
from types import SimpleNamespace
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.core.enums import WorkerStatus
from platform_v8.storage.repo import _row_to_worker


def _fake_row(capabilities: dict) -> SimpleNamespace:
    return SimpleNamespace(
        id="w-test-1",
        owner_id=1,
        name="test-node",
        status=WorkerStatus.ONLINE.value,
        capabilities=capabilities,
        load=0.0,
        active_shards=0,
        reputation=0.5,
        capability_score=10.0,
        last_seen=datetime.utcnow(),
        registered_at=datetime.utcnow(),
        client_version="8.2.0",
        hw_tier="B",
        hw_score=50.0,
        rep_main=60,
        rep_stability=60,
        rep_correctness=60,
        rep_speed=60,
        rep_resource=60,
        onboarding_status="active",
    )


def test_row_to_worker_restores_executor_fields():
    caps = {
        "cpu_cores": 8,
        "memory_gb": 16,
        "supported_executors": ["native", "onnx", "http"],
        "native_binaries": ["ffmpeg", "pdftotext"],
        "onnx_models": ["rapid_ocr_v1"],
        "runtime_tiers": ["lite"],
        "software": ["pillow"],
    }
    worker = _row_to_worker(_fake_row(caps))
    assert worker.capabilities.supported_executors == ["native", "onnx", "http"]
    assert worker.capabilities.native_binaries == ["ffmpeg", "pdftotext"]
    assert worker.capabilities.onnx_models == ["rapid_ocr_v1"]
    assert worker.capabilities.runtime_tiers == ["lite"]


def test_row_to_worker_restores_from_json_string_blob():
    caps = {
        "supported_executors": ["http"],
        "native_binaries": [],
        "onnx_models": ["clip_vit_b32_v1"],
    }
    worker = _row_to_worker(_fake_row(json.dumps(caps)))
    assert worker.capabilities.supported_executors == ["http"]
    assert worker.capabilities.native_binaries == []
    assert worker.capabilities.onnx_models == ["clip_vit_b32_v1"]


def test_row_to_worker_missing_executor_fields_default_empty():
    worker = _row_to_worker(_fake_row({"cpu_cores": 2}))
    assert worker.capabilities.supported_executors == []
    assert worker.capabilities.native_binaries == []
    assert worker.capabilities.onnx_models == []


def test_row_to_worker_keeps_installed_apps_and_ignores_unknown_keys():
    caps = {
        "cpu_cores": 4,
        "installed_apps": [{"slug": "demo", "name": "Demo", "version": "1.0"}],
        "client_kind": "eco-client",
        "not_a_real_field": True,
    }
    worker = _row_to_worker(_fake_row(caps))
    assert worker.capabilities.installed_apps[0]["slug"] == "demo"


def test_capabilities_from_stored_drops_unknown_keys():
    from platform_v8.core import WorkerCapabilities

    cap = WorkerCapabilities.from_stored({
        "cpu_cores": 8,
        "installed_apps": [{"slug": "x"}],
        "client_kind": "eco-client",
    })
    assert cap.cpu_cores == 8
    assert cap.installed_apps == [{"slug": "x"}]
    assert not hasattr(cap, "client_kind")
