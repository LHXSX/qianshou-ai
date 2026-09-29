"""本机 LLM 模型智能挑选（_llm_pick · _ollama_pick 兼容层）。"""
from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_HELPER = Path(__file__).resolve().parents[2] / "scripts" / "tasks" / "_llm_pick.py"
_spec = importlib.util.spec_from_file_location("_llm_pick", _HELPER)
assert _spec and _spec.loader
# 保证同目录 _llm_client 可被导入
import sys

sys.path.insert(0, str(_HELPER.parent))
pick = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pick)


def test_is_auto():
    assert pick.is_auto("") is True
    assert pick.is_auto("auto") is True
    assert pick.is_auto("AUTO") is True
    assert pick.is_auto("智能") is True
    assert pick.is_auto("qwen2.5:7b") is False


def test_pick_text_prefers_ordered():
    have = ["llama3.2:1b", "qwen2.5:1.5b-q4_K_M", "other:1b"]
    assert pick.pick_text_model(have) == "qwen2.5:1.5b-q4_K_M"


def test_pick_text_falls_back_to_qwen_then_first():
    assert pick.pick_text_model(["foo:1b", "qwen-custom:9b"]) == "qwen-custom:9b"
    assert pick.pick_text_model(["zzz:1b", "aaa:1b"]) == "zzz:1b"


def test_pick_vision_prefers_vl():
    have = ["qwen2.5:7b", "llava:7b", "qwen2.5vl:3b"]
    assert pick.pick_vision_model(have) == "qwen2.5vl:3b"


def test_resolve_model_keeps_explicit():
    assert pick.resolve_model("my-model:1b", kind="text", have=["other"]) == "my-model:1b"


def test_resolve_model_auto_picks_and_fails_empty():
    assert (
        pick.resolve_model("auto", kind="text", have=["qwen2.5:7b", "llama3.2:1b"])
        == "qwen2.5:7b"
    )
    with pytest.raises(RuntimeError, match="无可用模型"):
        pick.resolve_model("auto", kind="text", have=[])
