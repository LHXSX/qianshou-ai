#!/usr/bin/env python3
"""
GEO 监测 · 节点端 LLM 查询脚本 (W2-5 · 2026-05-26)

输入 (stdin JSON · 由 executor 注入):
{
    "task_type": "geo_query",
    "params": {
        "keyword": "5000 元价位手机推荐",
        "llm_code": "kimi",
    },
    "slice_meta": {},  # 不用
    "workload_id": "...",
    "shard_id": "..."
}

但 workload.spec.params 里有全局参数 (brand_name + brand_aliases + llm_endpoints) ·
executor 把 workload.spec.params 跟 shard params merge · 节点收到的 params 是:
{
    "brand_id": 1,
    "brand_name": "Apple",
    "brand_aliases": ["苹果", "iPhone 厂商"],
    "category": "phone",
    "llm_endpoints": {
        "kimi": {"endpoint": "...", "auth_type": "bearer", "api_key": "sk-..."},
        ...
    },
    "keyword": "5000 元价位手机推荐",
    "llm_code": "kimi",
}

输出 (stdout · JSON):
{
    "ok": true,
    "llm_code": "kimi",
    "keyword": "...",
    "brand_name": "...",
    "response_text": "LLM 完整响应文本",
    "elapsed_ms": 3240,
    "response_hash": "sha256_hex",
    "tokens": {"prompt": 25, "completion": 312}
}

失败:
{"ok": false, "error": "...", "llm_code": "...", "keyword": "..."}

依赖: requests (节点 python3 自带 · 或 uv 装)
"""
from __future__ import annotations
import hashlib
import json
import sys
import time
from typing import Any


def main():
    # 1. 读 stdin params
    try:
        raw = sys.stdin.read()
        if not raw.strip():
            _err_exit("stdin empty · executor 没传 params")
            return
        ctx = json.loads(raw)
    except Exception as exc:
        _err_exit(f"parse stdin fail: {exc}")
        return
    
    # params 可能在 ctx 顶层 或 ctx['params']
    params = ctx.get("params") or ctx
    if not isinstance(params, dict):
        _err_exit(f"params 不是 dict · 是 {type(params).__name__}")
        return
    
    # 2. 必填校验
    keyword = params.get("keyword", "").strip()
    llm_code = params.get("llm_code", "").strip()
    brand_name = params.get("brand_name", "").strip()
    if not keyword or not llm_code or not brand_name:
        _err_exit(f"params 不全: keyword={bool(keyword)} llm_code={bool(llm_code)} brand={bool(brand_name)}")
        return
    
    # 3. 取 LLM endpoint
    llm_endpoints = params.get("llm_endpoints") or {}
    llm_cfg = llm_endpoints.get(llm_code)
    if not llm_cfg or not isinstance(llm_cfg, dict):
        _err_exit(f"LLM endpoint 未配置: {llm_code}")
        return
    
    endpoint = llm_cfg.get("endpoint", "")
    auth_type = llm_cfg.get("auth_type", "bearer")
    api_key = llm_cfg.get("api_key", "")
    
    if not endpoint:
        _err_exit(f"LLM {llm_code} endpoint 空")
        return
    
    # 4. 构造 prompt
    # MVP: 简单 prompt 模板 · 后续接 admin 配置
    prompt = _build_prompt(brand_name, keyword)
    
    # 5. 调 LLM API
    start = time.time()
    try:
        response_text, tokens = _call_llm(
            llm_code=llm_code,
            endpoint=endpoint,
            auth_type=auth_type,
            api_key=api_key,
            prompt=prompt,
        )
    except Exception as exc:
        _err_exit(f"LLM API 调用失败: {exc}", llm_code=llm_code, keyword=keyword)
        return
    
    elapsed_ms = int((time.time() - start) * 1000)
    
    # 6. 算 response_hash (反作弊用)
    response_hash = hashlib.sha256(response_text.encode("utf-8", errors="ignore")).hexdigest()
    
    # 7. 输出
    out = {
        "ok": True,
        "llm_code": llm_code,
        "keyword": keyword,
        "brand_name": brand_name,
        "response_text": response_text,
        "response_hash": response_hash,
        "elapsed_ms": elapsed_ms,
        "tokens": tokens,
    }
    print(json.dumps(out, ensure_ascii=False))


# ════════════════════════════════════════════════════════════════
# LLM API 调用 (6 LLM 适配)
# ════════════════════════════════════════════════════════════════
def _call_llm(
    *,
    llm_code: str,
    endpoint: str,
    auth_type: str,
    api_key: str,
    prompt: str,
) -> tuple[str, dict]:
    """返 (response_text, tokens_dict)"""
    import requests  # type: ignore
    
    timeout = 60
    
    # 6 LLM 大部分用 OpenAI-compatible chat completion 协议 (Kimi/豆包/DeepSeek/GPT-4)
    # Claude 用 messages API (不同 schema)
    # 文心一言用 ERNIE API (不同 schema)
    
    if llm_code == "claude":
        return _call_anthropic(endpoint, api_key, prompt, timeout)
    elif llm_code == "wenxin":
        return _call_baidu(endpoint, api_key, prompt, timeout)
    else:
        # OpenAI-compatible (kimi / doubao / deepseek / gpt-4)
        return _call_openai_compatible(
            endpoint, api_key, prompt, timeout,
            model=_default_model_for(llm_code),
        )


def _call_openai_compatible(
    endpoint: str, api_key: str, prompt: str, timeout: int,
    *, model: str,
) -> tuple[str, dict]:
    import requests  # type: ignore
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
        "max_tokens": 800,
    }
    resp = requests.post(endpoint, headers=headers, json=body, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    text = data["choices"][0]["message"]["content"]
    usage = data.get("usage") or {}
    return text, {
        "prompt": usage.get("prompt_tokens", 0),
        "completion": usage.get("completion_tokens", 0),
    }


def _call_anthropic(endpoint: str, api_key: str, prompt: str, timeout: int) -> tuple[str, dict]:
    import requests  # type: ignore
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    body = {
        "model": "claude-3-5-sonnet-20241022",
        "max_tokens": 800,
        "messages": [{"role": "user", "content": prompt}],
    }
    resp = requests.post(endpoint, headers=headers, json=body, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    text = data["content"][0]["text"]
    usage = data.get("usage") or {}
    return text, {
        "prompt": usage.get("input_tokens", 0),
        "completion": usage.get("output_tokens", 0),
    }


def _call_baidu(endpoint: str, api_key: str, prompt: str, timeout: int) -> tuple[str, dict]:
    """百度文心一言 (ERNIE) · 简化版 · 真实 access_token 需要 refresh"""
    import requests  # type: ignore
    # MVP: 假设 api_key 已经是 access_token (admin 维护刷新)
    url = f"{endpoint}?access_token={api_key}"
    headers = {"Content-Type": "application/json"}
    body = {"messages": [{"role": "user", "content": prompt}]}
    resp = requests.post(url, headers=headers, json=body, timeout=timeout)
    resp.raise_for_status()
    data = resp.json()
    text = data.get("result") or ""
    usage = data.get("usage") or {}
    return text, {
        "prompt": usage.get("prompt_tokens", 0),
        "completion": usage.get("completion_tokens", 0),
    }


def _default_model_for(llm_code: str) -> str:
    """6 LLM 默认 model 名 (admin 可在 endpoint 里覆盖)"""
    return {
        "kimi": "moonshot-v1-8k",
        "doubao": "doubao-pro-32k",
        "deepseek": "deepseek-chat",
        "gpt-4": "gpt-4o",
    }.get(llm_code, llm_code)


# ════════════════════════════════════════════════════════════════
# helpers
# ════════════════════════════════════════════════════════════════
def _build_prompt(brand_name: str, keyword: str) -> str:
    """构造发给 LLM 的 prompt
    
    MVP: 简单模板 · 询问 LLM 关于 brand+keyword 的看法 + 推荐
    P2: 接 admin 配置的 prompt 模板
    """
    return (
        f"请用中文 1-2 段回答: 关于 \"{keyword}\" · 你会推荐哪些品牌/产品? "
        f"请客观介绍 · 不要直接说 \"{brand_name}\" 一定最好 · 给出对比和理由."
    )


def _err_exit(msg: str, **extra: Any):
    out = {"ok": False, "error": msg[:500], **extra}
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(1)


if __name__ == "__main__":
    main()
