"""
R-1 · ExecutionPlan 构造器 + PUSH/PULL/恢复黄金帧

覆盖:
  1. normalize_code_sha256 拒绝空串 / TBD
  2. 官方脚本 URL 带上本地文件 sha256；未知 URL 不编造
  3. 同一 workload 经 PUSH/PULL/恢复入口得到相同核心字段
     （code_url + code_sha256 + executor + required_tier）
"""
from __future__ import annotations

import hashlib
import json
import sys
import uuid
from datetime import datetime
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.core import Shard, Workload, WorkloadSpec
from platform_v8.core.enums import Runtime, ShardMode, ShardStatus, WorkloadStatus
from platform_v8.engine import pull_dispatcher
from platform_v8.engine.execution_plan import (
    hash_local_task_script,
    make_shard_assign_payload,
    normalize_code_sha256,
    resolve_code_sha256,
)
from platform_v8.protocol import ws_schema as wsp


def _mk_shard(workload_id: str, **kw) -> Shard:
    return Shard(
        id=str(uuid.uuid4()),
        workload_id=workload_id,
        index=0,
        total=2,
        status=ShardStatus.PENDING,
        mode=ShardMode.ONESHOT,
        input_ref="https://oss.example/in.png",
        metadata={"params": {"lang": "chi_sim"}},
        **kw,
    )


def _mk_workload(*, task_type: str, code_url: str, wid: str | None = None) -> Workload:
    return Workload(
        id=wid or str(uuid.uuid4()),
        owner_id=7,
        name="黄金帧 OCR",
        status=WorkloadStatus.RUNNING,
        spec=WorkloadSpec(
            task_type=task_type,
            runtime=Runtime.PYTHON3,
            code_url=code_url,
            input_kind="single_file",
            params={"lang": "chi_sim"},
            timeout_s=180,
        ),
        budget=2.0,
        created_at=datetime(2026, 8, 13, 5, 0, 0),
    )


def test_normalize_code_sha256_rejects_placeholders():
    assert normalize_code_sha256(None) is None
    assert normalize_code_sha256("") is None
    assert normalize_code_sha256("   ") is None
    assert normalize_code_sha256("TBD") is None
    assert normalize_code_sha256("tbd") is None
    assert normalize_code_sha256("not-a-hash") is None
    good = "A" * 64
    assert normalize_code_sha256(good) == "a" * 64


def test_resolve_code_sha256_official_script_hashes_local_file():
    local = hash_local_task_script("ocr_image")
    assert local is not None
    assert len(local) == 64
    script = Path(__file__).resolve().parents[2] / "scripts" / "tasks" / "ocr_image.py"
    assert hashlib.sha256(script.read_bytes()).hexdigest() == local

    url = "https://qianshousuanli.com/api/v8/scripts/ocr_image.py"
    assert resolve_code_sha256(task_type="ocr_image", code_url=url) == local


def test_resolve_code_sha256_unknown_url_does_not_invent():
    got = resolve_code_sha256(
        task_type="ocr_image",
        code_url="https://example.invalid/custom-pack.py",
    )
    assert got is None


def test_resolve_code_sha256_metadata_wins():
    expected = "b" * 64
    got = resolve_code_sha256(
        task_type="ocr_image",
        code_url="https://qianshousuanli.com/api/v8/scripts/ocr_image.py",
        shard_meta={"code_sha256": expected},
    )
    assert got == expected


def _core(p: wsp.ShardAssignPayload) -> dict:
    return {
        "code_url": p.code_url,
        "code_sha256": p.code_sha256,
        "executor": p.executor,
        "required_tier": p.required_tier,
        "native_binary": p.native_binary,
        "onnx_model": p.onnx_model,
        "fallback_tiers": list(p.fallback_tiers),
        "task_type": p.task_type,
        "runtime": p.runtime,
    }


def test_push_pull_recover_same_core_payload():
    """三条路径共用 make_shard_assign_payload · 黄金字段必须一致。"""
    wl = _mk_workload(
        task_type="ocr_image",
        code_url="https://qianshousuanli.com/api/v8/scripts/ocr_image.py",
    )
    sh = _mk_shard(wl.id)
    kwargs = dict(
        worker_id="worker-gold",
        requester_name="alice",
        requester_avatar="",
        created_at_ms=1_776_000_000_000,
    )

    push_p = make_shard_assign_payload(sh, wl, **kwargs)
    pull_p = pull_dispatcher._shard_to_assign_payload(sh, wl, **kwargs)
    recover_p = make_shard_assign_payload(sh, wl, **kwargs)

    assert _core(push_p) == _core(pull_p) == _core(recover_p)
    assert push_p.code_url.endswith("/scripts/ocr_image.py")
    assert push_p.code_sha256 == hash_local_task_script("ocr_image")
    assert push_p.executor == "onnx"
    assert push_p.required_tier == "ocr"
    assert push_p.onnx_model == "rapid_ocr_v1"
    assert "lite" in push_p.fallback_tiers

    push_frame = json.loads(wsp.build_shard_assign_from_payload(push_p))
    pull_frame = json.loads(wsp.build_pull_assign(shards=[pull_p]))
    recover_frame = json.loads(wsp.build_shard_assign_from_payload(recover_p))

    for frame in (push_frame, recover_frame):
        assert frame["type"] == "shard_assign"
        body = frame["payload"]
        assert body["code_url"] == push_p.code_url
        assert body["code_sha256"] == push_p.code_sha256
        assert body["executor"] == "onnx"
        assert body["required_tier"] == "ocr"

    pull_body = pull_frame["payload"]["shards"][0]
    assert pull_body["code_url"] == push_p.code_url
    assert pull_body["code_sha256"] == push_p.code_sha256
    assert pull_body["executor"] == "onnx"
    assert pull_body["required_tier"] == "ocr"


def test_legacy_fields_still_present_when_sha_missing():
    wl = _mk_workload(task_type="unknown_task_zzz", code_url="https://example.invalid/x.py")
    sh = _mk_shard(wl.id)
    p = make_shard_assign_payload(sh, wl, worker_id="w")
    dumped = p.model_dump()
    assert "code_url" in dumped
    assert "executor" in dumped
    assert "required_tier" in dumped
    assert dumped["code_sha256"] is None


def test_build_shard_assign_accepts_optional_sha():
    text = wsp.build_shard_assign(
        shard_id="s1",
        workload_id="w1",
        task_type="ocr_image",
        code_url="https://qianshousuanli.com/api/v8/scripts/ocr_image.py",
        code_sha256="c" * 64,
        executor="onnx",
        required_tier="ocr",
    )
    data = json.loads(text)
    assert data["payload"]["code_sha256"] == "c" * 64
    assert data["payload"]["code_url"].endswith("ocr_image.py")
    assert data["payload"]["executor"] == "onnx"
