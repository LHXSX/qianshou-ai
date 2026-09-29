"""本机 / 云端 OpenAI 兼容模型智能挑选 · 供 AI 任务脚本共用。

约定:
  - params 为 auto/空/智能 → 按 /v1/models + 偏好列表挑选
  - 用户指定具体模型名 → 原样使用（调度侧已过滤）
  - 无可用模型 → 返回明确错误，禁止静默用错误默认名硬打
  - 默认引擎: llama.cpp (llama-server)；云端走同一 list_models
"""
from __future__ import annotations

import urllib.error
from typing import Iterable

from _llm_client import (
    DEFAULT_LOCAL_BASE,
    list_models,
    resolve_api_key,
    resolve_base_url,
    unreachable_hint,
)

DEFAULT_LLM_BASE = DEFAULT_LOCAL_BASE
# 兼容旧 import 名
DEFAULT_OLLAMA = DEFAULT_LOCAL_BASE

TEXT_PREFER = (
    "qwen2.5-7b",
    "qwen2.5:7b",
    "qwen3.5-4b",
    "qwen3.5:4b",
    "qwen2.5-1.5b",
    "qwen2.5:1.5b",
    "qwen2.5-3b",
    "qwen2.5:3b",
    "llama-3.2-1b",
    "llama3.2:1b",
)

VISION_PREFER = (
    "qwen2.5-vl",
    "qwen2.5vl",
    "qwen2.5vl:3b",
    "llava",
    "llava:7b",
    "minicpm-v",
    "minicpm-v4.6",
    "qwen3.5:4b",
)


def is_auto(name: str | None) -> bool:
    w = (name or "").strip().lower()
    return (not w) or w in ("auto", "automatic", "智能")


def model_match(want: str, have: Iterable[str]) -> bool:
    want = (want or "").strip()
    if is_auto(want):
        return True
    want_l = want.lower()
    for h in (str(x).strip() for x in (have or [])):
        if not h:
            continue
        h_l = h.lower()
        if h == want or h_l == want_l:
            return True
        if h.startswith(want + "-") or h.startswith(want + "_") or h.startswith(want + ":"):
            return True
        if want.startswith(h + "-") or want.startswith(h + "_") or want.startswith(h + ":"):
            return True
        # GGUF 文件名常含偏好子串
        if want_l in h_l or h_l in want_l:
            return True
    return False


def list_local_models(
    host: str = DEFAULT_LLM_BASE,
    timeout: float = 8.0,
    *,
    api_key: str = "",
) -> list[str]:
    return list_models(host, api_key=api_key, timeout=timeout)


def _first_match(prefer: Iterable[str], have: list[str]) -> str | None:
    for want in prefer:
        for h in have:
            if model_match(want, [h]):
                return h
    return None


def pick_text_model(have: list[str], prefer: Iterable[str] | None = None) -> str | None:
    have = [str(x).strip() for x in (have or []) if str(x).strip()]
    if not have:
        return None
    hit = _first_match(prefer or TEXT_PREFER, have)
    if hit:
        return hit
    for h in have:
        low = h.lower()
        if "qwen" in low and "vl" not in low and "vision" not in low:
            return h
    return have[0]


def pick_vision_model(have: list[str], prefer: Iterable[str] | None = None) -> str | None:
    have = [str(x).strip() for x in (have or []) if str(x).strip()]
    if not have:
        return None
    hit = _first_match(prefer or VISION_PREFER, have)
    if hit:
        return hit
    for h in have:
        low = h.lower()
        if any(k in low for k in ("vl", "llava", "vision", "minicpm", "bakllava")):
            return h
    return pick_text_model(have)


def resolve_model(
    requested: str | None,
    *,
    kind: str = "text",
    host: str = DEFAULT_LLM_BASE,
    have: list[str] | None = None,
    api_key: str = "",
    params: dict | None = None,
) -> str:
    """返回最终模型名。auto 时查 /v1/models；失败抛 RuntimeError。"""
    req = (requested or "").strip()
    if not is_auto(req):
        return req
    base = host
    key = api_key
    if params is not None:
        base = resolve_base_url(params, host=host if host != DEFAULT_LLM_BASE else None)
        key = key or resolve_api_key(params)
    models = have if have is not None else list_local_models(base, api_key=key)
    if kind == "vision":
        picked = pick_vision_model(models)
    else:
        picked = pick_text_model(models)
    if not picked:
        raise RuntimeError(
            "本机 LLM 无可用模型 · 请先用 llama-server 加载文本/视觉 GGUF 后再试"
        )
    return picked


def resolve_or_none(
    requested: str | None,
    *,
    kind: str = "text",
    host: str = DEFAULT_LLM_BASE,
    api_key: str = "",
    params: dict | None = None,
) -> tuple[str | None, str | None]:
    """(model, error)。成功 error=None。"""
    try:
        return (
            resolve_model(
                requested, kind=kind, host=host, api_key=api_key, params=params
            ),
            None,
        )
    except urllib.error.URLError as exc:
        return None, unreachable_hint(exc)
    except Exception as exc:
        return None, str(exc)
