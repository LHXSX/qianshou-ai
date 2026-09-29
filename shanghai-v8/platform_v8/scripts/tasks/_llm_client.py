"""OpenAI 兼容 LLM 客户端 · 本机 llama.cpp (llama-server) + 预留云端。

约定:
  - local 默认 http://127.0.0.1:8080 · /v1/chat/completions · /v1/models
  - cloud 同一协议 · 需 llm_base_url + llm_api_key（本期可仅透传，未配则报错）
  - 视觉走 OpenAI 多模态 content 数组 (image_url data URI)
  - 过渡期仍可读 ollama_host / OLLAMA_BASE_URL，但默认不再指向 Ollama
"""
from __future__ import annotations

import base64
import json
import os
import re
import urllib.error
import urllib.request
from typing import Any

DEFAULT_LOCAL_BASE = "http://127.0.0.1:8080"
DEFAULT_BACKEND = "local"

# 过渡期旧 env / params
_LEGACY_HOST_KEYS = ("llm_base_url", "ollama_host", "base_url")
_LEGACY_ENV = ("LLAMA_CPP_BASE_URL", "LLM_BASE_URL", "OLLAMA_BASE_URL")


def normalize_backend(raw: str | None) -> str:
    b = (raw or "").strip().lower() or DEFAULT_BACKEND
    if b in ("llama_cpp", "llamacpp", "llama.cpp", "local_llm"):
        return "local"
    if b in ("cloud", "openai", "openai_compat", "remote"):
        return "cloud"
    if b == "local":
        return "local"
    return b


def resolve_base_url(
    params: dict | None = None,
    *,
    backend: str | None = None,
    host: str | None = None,
) -> str:
    """解析 API base（不含路径尾）。host 显式传入优先。"""
    p = params or {}
    if host and str(host).strip():
        return str(host).strip().rstrip("/")

    b = normalize_backend(backend or p.get("llm_backend") or os.environ.get("LLM_BACKEND"))
    if b == "cloud":
        for key in ("llm_base_url", "api_base", "openai_base_url"):
            v = str(p.get(key) or "").strip()
            if v:
                return v.rstrip("/")
        env = (
            os.environ.get("LLM_CLOUD_BASE_URL")
            or os.environ.get("OPENAI_BASE_URL")
            or ""
        ).strip()
        if env:
            return env.rstrip("/")
        raise RuntimeError(
            "cloud 后端未配置 llm_base_url / LLM_CLOUD_BASE_URL（云端接口已预留）"
        )

    for key in _LEGACY_HOST_KEYS:
        v = str(p.get(key) or "").strip()
        if v:
            return v.rstrip("/")
    for env_key in _LEGACY_ENV:
        v = (os.environ.get(env_key) or "").strip()
        if v:
            return v.rstrip("/")
    return DEFAULT_LOCAL_BASE


def resolve_api_key(params: dict | None = None, *, backend: str | None = None) -> str:
    p = params or {}
    b = normalize_backend(backend or p.get("llm_backend") or os.environ.get("LLM_BACKEND"))
    key = str(p.get("llm_api_key") or p.get("api_key") or "").strip()
    if key:
        return key
    if b == "cloud":
        return (
            os.environ.get("LLM_CLOUD_API_KEY")
            or os.environ.get("OPENAI_API_KEY")
            or ""
        ).strip()
    return (os.environ.get("LLM_API_KEY") or "").strip()


def list_models(
    base_url: str | None = None,
    *,
    api_key: str = "",
    timeout: float = 8.0,
) -> list[str]:
    """GET /v1/models → id 列表。"""
    base = (base_url or DEFAULT_LOCAL_BASE).rstrip("/")
    url = f"{base}/v1/models"
    headers = {"Accept": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, method="GET", headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        body = json.loads(resp.read().decode("utf-8") or "{}")
    data = body.get("data") or body.get("models") or []
    out: list[str] = []
    for m in data:
        if isinstance(m, dict):
            name = str(m.get("id") or m.get("name") or m.get("model") or "").strip()
        else:
            name = str(m or "").strip()
        if name:
            out.append(name)
    return out


def _image_data_url(image_b64: str, mime: str = "image/jpeg") -> str:
    raw = (image_b64 or "").strip()
    if raw.startswith("data:"):
        return raw
    return f"data:{mime};base64,{raw}"


def _normalize_messages(messages: list[dict]) -> list[dict]:
    """把 Ollama 风格 images[] 转成 OpenAI multimodal content。"""
    out: list[dict] = []
    for msg in messages:
        role = str(msg.get("role") or "user")
        content = msg.get("content")
        images = msg.get("images")
        if images and isinstance(content, str):
            parts: list[dict[str, Any]] = [{"type": "text", "text": content}]
            for img in images:
                if not img:
                    continue
                if isinstance(img, (bytes, bytearray)):
                    b64 = base64.b64encode(bytes(img)).decode("ascii")
                else:
                    b64 = str(img)
                parts.append(
                    {
                        "type": "image_url",
                        "image_url": {"url": _image_data_url(b64)},
                    }
                )
            out.append({"role": role, "content": parts})
        else:
            out.append({"role": role, "content": content})
    return out


def _strip_think(text: str) -> str:
    return re.sub(r"<think>[\s\S]*?</think>", "", text or "", flags=re.I).strip()


def chat_completion(
    *,
    messages: list[dict],
    model: str,
    base_url: str | None = None,
    api_key: str = "",
    temperature: float = 0.2,
    max_tokens: int | None = None,
    timeout: int = 600,
) -> str:
    """POST /v1/chat/completions · 返回 assistant 文本。失败抛 URLError/RuntimeError。"""
    base = (base_url or DEFAULT_LOCAL_BASE).rstrip("/")
    url = f"{base}/v1/chat/completions"
    body_obj: dict[str, Any] = {
        "model": model,
        "messages": _normalize_messages(messages),
        "temperature": temperature,
        "stream": False,
    }
    if max_tokens is not None:
        body_obj["max_tokens"] = max_tokens
    body = json.dumps(body_obj).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(url, data=body, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read().decode("utf-8", errors="replace"))
    choices = data.get("choices") or []
    if not choices:
        raise RuntimeError(f"LLM 返回空 choices: {data!r}"[:500])
    msg = choices[0].get("message") or {}
    content = msg.get("content")
    if isinstance(content, list):
        # 少数实现返回 content parts
        texts = [
            str(p.get("text") or "")
            for p in content
            if isinstance(p, dict) and p.get("type") in (None, "text")
        ]
        content = "".join(texts)
    return _strip_think(str(content or ""))


def generate(
    prompt: str,
    *,
    model: str,
    base_url: str | None = None,
    api_key: str = "",
    temperature: float = 0.2,
    images: list[str] | None = None,
    timeout: int = 600,
    max_tokens: int | None = None,
) -> str:
    message: dict[str, Any] = {"role": "user", "content": prompt}
    if images:
        message["images"] = list(images)
    return chat_completion(
        messages=[message],
        model=model,
        base_url=base_url,
        api_key=api_key,
        temperature=temperature,
        max_tokens=max_tokens,
        timeout=timeout,
    )


def unreachable_hint(exc: BaseException | None = None) -> str:
    suffix = f" ({exc})" if exc else ""
    return (
        "本地 LLM 不可达 · 请确认本机 llama-server 已启动"
        f"（默认 {DEFAULT_LOCAL_BASE}）{suffix}"
    )
