"""planner._filter_by_requirements · 能力硬过滤单测 (E4)

覆盖:
  1. 无 required_software → 全员保留
  2. 缺 software → 剔除
  3. 具备 software → 保留
  4. min_memory / gpu 硬闸

跑法:
  cd platform_v8 && python -m pytest tests/engine/test_planner_requirements_filter.py -q
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.core import Worker
from platform_v8.core.enums import WorkerStatus
from platform_v8.core.worker import WorkerCapabilities
from platform_v8.engine import planner


def _mk_worker(*, name: str, software=None, mem_mb=8192, gpu=0):
    return Worker(
        id=str(uuid.uuid4()),
        owner_id=1,
        name=name,
        status=WorkerStatus.ONLINE,
        capabilities=WorkerCapabilities(
            software=list(software or []),
            total_memory_mb=mem_mb,
            memory_gb=round(mem_mb / 1024, 2),
            gpu_count=gpu,
        ),
        load=0.1,
        active_shards=0,
        reputation=0.5,
        capability_score=50.0,
        registered_at=datetime.now(timezone.utc) - timedelta(days=30),
    )


def _mk_workload(task_type: str):
    return SimpleNamespace(spec=SimpleNamespace(task_type=task_type))


def _mk_spec(*, software=(), min_memory_mb=0, requires_gpu=False):
    return SimpleNamespace(
        required_software=tuple(software),
        min_memory_mb=min_memory_mb,
        requires_gpu=requires_gpu,
    )


def test_filter_noop_when_no_requirements():
    workers = [_mk_worker(name="a", software=[]), _mk_worker(name="b", software=["pillow"])]
    with patch("platform_v8.engine.task_registry.get_spec", return_value=_mk_spec()):
        out = planner._filter_by_requirements(workers, _mk_workload("noop_filter"))
    assert [w.name for w in out] == ["a", "b"]


def test_allowed_worker_ids_reads_admin_dispatch_constraint():
    chosen = _mk_worker(name="chosen")
    other = _mk_worker(name="other")
    workload = SimpleNamespace(
        spec=SimpleNamespace(
            requirements={"allowed_worker_ids": [chosen.id, chosen.id, ""]},
        ),
    )

    allowed = planner._allowed_worker_ids(workload)

    assert allowed == {chosen.id}
    assert [worker.name for worker in [chosen, other] if worker.id in allowed] == ["chosen"]


def test_allowed_worker_ids_ignores_invalid_requirement_shape():
    workload = SimpleNamespace(
        spec=SimpleNamespace(requirements={"allowed_worker_ids": "not-a-list"}),
    )

    assert planner._allowed_worker_ids(workload) == set()


def test_filter_drops_missing_software():
    ok = _mk_worker(name="ok", software=["transformers", "pillow"])
    bad = _mk_worker(name="bad", software=["pillow"])
    lite = _mk_worker(name="lite", software=["python3"])
    with patch(
        "platform_v8.engine.task_registry.get_spec",
        return_value=_mk_spec(software=("transformers", "pillow")),
    ):
        out = planner._filter_by_requirements([ok, bad, lite], _mk_workload("image_caption"))
    assert [w.name for w in out] == ["ok"]


def test_filter_memory_and_gpu():
    low = _mk_worker(name="low", software=["onnxruntime"], mem_mb=1024, gpu=0)
    gpu = _mk_worker(name="gpu", software=["onnxruntime"], mem_mb=16384, gpu=1)
    with patch(
        "platform_v8.engine.task_registry.get_spec",
        return_value=_mk_spec(software=("onnxruntime",), min_memory_mb=8192, requires_gpu=True),
    ):
        out = planner._filter_by_requirements([low, gpu], _mk_workload("need_gpu"))
    assert [w.name for w in out] == ["gpu"]


def test_ollama_model_match_helpers():
    assert planner._ollama_model_match("qwen2.5:1.5b", ["qwen2.5:1.5b"]) is True
    assert planner._ollama_model_match("qwen2.5:1.5b", ["qwen2.5:1.5b-q4_K_M"]) is True
    assert planner._ollama_model_match("qwen2.5:1.5b", ["llama3.2:1b"]) is False
    assert planner._ollama_model_match("", ["anything"]) is True
    assert planner._is_auto_ollama_model("auto") is True
    assert planner._is_auto_ollama_model("AUTO") is True
    assert planner._is_auto_ollama_model("智能") is True
    assert planner._ollama_model_match("auto", ["llama3.2:1b"]) is True


def test_filter_ollama_model_auto_accepts_any_with_models():
    """auto / 空 · 不按模型名过滤 · 有 ollama_models 的节点都可入选。"""
    a = _mk_worker_ollama(name="a", models=["llama3.2:1b"])
    b = _mk_worker_ollama(name="b", models=["qwen3.5:4b"])
    empty = _mk_worker_ollama(name="empty", models=[])
    wl = SimpleNamespace(
        spec=SimpleNamespace(
            task_type="audio_transcribe_refine",
            params={"ollama_model": "auto"},
        )
    )
    with patch(
        "platform_v8.engine.task_registry.get_spec",
        return_value=_mk_spec(software=("local_llm",)),
    ):
        out = planner._filter_by_requirements([a, b, empty], wl)
    # empty 仍有 local_llm software · 应入选；模型匹配在 auto 时跳过
    assert {w.name for w in out} == {"a", "b", "empty"}


def test_filter_ollama_vision_model_required():
    ok = _mk_worker_ollama(name="ok", models=["qwen3.5:4b", "llava:7b"])
    bad = _mk_worker_ollama(name="bad", models=["llama3.2:1b"])
    wl = SimpleNamespace(
        spec=SimpleNamespace(
            task_type="video_analyze",
            params={"ollama_model": "auto", "vision_model": "llava:7b"},
        )
    )
    with patch(
        "platform_v8.engine.task_registry.get_spec",
        return_value=_mk_spec(software=("local_llm",)),
    ):
        out = planner._filter_by_requirements([ok, bad], wl)
    assert [w.name for w in out] == ["ok"]


def test_filter_local_llm_accepts_legacy_ollama_software_only():
    """过渡期：任务要 local_llm，节点只报 ollama + ollama_models 仍可派。"""
    node = _mk_worker_ollama(
        name="legacy",
        models=["qwen2.5:1.5b"],
        software=["ollama"],
    )
    # 清掉新字段，模拟旧心跳
    node.capabilities.llm_models = []
    node.capabilities.llm_backend = ""
    wl = SimpleNamespace(
        spec=SimpleNamespace(
            task_type="local_llm_chat",
            params={"model": "qwen2.5:1.5b"},
        )
    )
    with patch(
        "platform_v8.engine.task_registry.get_spec",
        return_value=_mk_spec(software=("local_llm",)),
    ):
        out = planner._filter_by_requirements([node], wl)
    assert [w.name for w in out] == ["legacy"]


def _mk_worker_ollama(*, name: str, models=None, software=None):
    models = list(models or [])
    return Worker(
        id=str(uuid.uuid4()),
        owner_id=1,
        name=name,
        status=WorkerStatus.ONLINE,
        capabilities=WorkerCapabilities(
            software=list(software or ["local_llm", "ollama"]),
            llm_models=models,
            ollama_models=models,
            llm_backend="llama_cpp",
            total_memory_mb=8192,
            memory_gb=8.0,
        ),
        load=0.1,
        active_shards=0,
        reputation=0.5,
        capability_score=50.0,
        registered_at=datetime.now(timezone.utc) - timedelta(days=30),
    )


def test_filter_ollama_model_required():
    ok = _mk_worker_ollama(name="ok", models=["qwen2.5:1.5b", "llama3.2:1b"])
    bad = _mk_worker_ollama(name="bad", models=["llama3.2:1b"])
    none = _mk_worker_ollama(name="none", models=[])
    wl = SimpleNamespace(
        spec=SimpleNamespace(
            task_type="local_llm_chat",
            params={"model": "qwen2.5:1.5b"},
        )
    )
    with patch(
        "platform_v8.engine.task_registry.get_spec",
        return_value=_mk_spec(software=("local_llm",)),
    ):
        out = planner._filter_by_requirements([ok, bad, none], wl)
    assert [w.name for w in out] == ["ok"]


def test_filter_ollama_implied_by_models_without_software_tag():
    """hb 探针可能未把 local_llm 写入 software · 但有 llm_models 仍应可派。"""
    node = _mk_worker_ollama(name="models-only", models=["qwen3.5:4b"], software=["ffmpeg"])
    wl = SimpleNamespace(
        spec=SimpleNamespace(
            task_type="local_llm_chat",
            params={"model": "qwen3.5:4b"},
        )
    )
    with patch(
        "platform_v8.engine.task_registry.get_spec",
        return_value=_mk_spec(software=("local_llm",)),
    ):
        out = planner._filter_by_requirements([node], wl)
    assert [w.name for w in out] == ["models-only"]


def test_filter_ollama_model_prefix():
    tagged = _mk_worker_ollama(name="tagged", models=["qwen2.5:1.5b-instruct-q4_K_M"])
    wl = SimpleNamespace(
        spec=SimpleNamespace(
            task_type="local_llm_chat",
            params={"ollama_model": "qwen2.5:1.5b"},
        )
    )
    with patch(
        "platform_v8.engine.task_registry.get_spec",
        return_value=_mk_spec(software=("local_llm",)),
    ):
        out = planner._filter_by_requirements([tagged], wl)
    assert [w.name for w in out] == ["tagged"]
