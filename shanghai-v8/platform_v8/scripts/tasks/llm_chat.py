#!/usr/bin/env python3
"""llm_chat — LLM 对话 (企业级 · 2026-06-07 S5 升级)

新增:
  - 批量(prompts: [...])  · 一次调多 prompt
  - 多轮对话(messages: [...])
  - endpoints 列表 fallback (主备双活)
  - 自动重试 (5xx / timeout · 指数回退)
  - top_p / seed / stop 等高级参数
  - 单调用 timeout 可配
  - 费用估算 (token × 单价)

参数 (EC_PARAMS · 优先于 stdin.params):
  endpoint        str    单 endpoint
  endpoints       list   多 endpoint fallback (优先 endpoints)
  model           str    模型名 (默认 ec-master)
  system          str    system prompt
  prompts         list   批量 prompts (优先 stdin.prompts > prompt > text)
  messages        list   多轮对话 OpenAI 格式 (优先级最高)
  temperature     float  默认 0.7
  top_p           float  默认 1.0
  max_tokens      int    默认 1000
  seed            int    复现性(部分模型支持)
  stop            list   停止序列
  api_key         str    Authorization header (Bearer)
  timeout         int    单调用秒 (默认 60)
  retry           int    重试次数 (默认 2 = 共 3 次)
  retry_backoff   float  指数回退基数 (默认 1.5)
  price_per_1k    obj    {"input":0.005,"output":0.015} 估算费
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request

# ── 算力归属 (2026-09-18 · 加法字段) ──────────────────────────────────
# 本脚本**不在节点出算力**: 它只是用 urllib 打平台自己的 HTTP LLM 接口
# (默认 https://www.qianshousuanli.com/api/v1/chat/completions · 模型 ec-master)。
# 产出里必须能看出"这是平台代调" + 实际调用到的 endpoint/model · 供
# 调度器 / UI / 计费对账区分它和 local_llm_chat (那个才是节点本地出算力)。
COMPUTE_ORIGIN_PLATFORM_RELAY = "platform_relay"
COMPUTE_ORIGIN_LABEL = "平台代调"
COMPUTE_ORIGIN_NOTE = "节点零算力 · 平台云端 LLM 代调"


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


# ════════════════════════════════════════════════════════════════════
# 平台中继凭据 (2026-09-18 · C-1 安全修复配套)
#
# /api/v1/chat/completions 与 /api/v1/embeddings 已不再免鉴权（与 v8 同套
# get_current_account）。本脚本默认就打平台自己的这两个地址，因此必须带凭据，
# 否则会被 401。
#
# 凭据来源按优先级：
#   1. EC_PARAMS.api_key   —— 平台派发层确认「会打平台地址」时注入；用户自带也走这里
#   2. QS_PLATFORM_RELAY_API_KEY 环境变量 —— 节点本机配置的服务凭据
#
# 只在 endpoint 确实属于平台时才附加平台凭据：脚本允许用户传自己的 endpoint
# （自建网关/第三方），无条件附加等于把平台密钥泄露给第三方。
# ════════════════════════════════════════════════════════════════════
_PLATFORM_RELAY_KEY_ENV = "QS_PLATFORM_RELAY_API_KEY"
# 只认平台自己的公网主机名。**不含 127.0.0.1/localhost** —— 否则指向本机
# 服务的 endpoint 会拿到平台凭据（既无意义又等于把凭据发给本机其它服务）。
# 需要时用 QS_PLATFORM_RELAY_HOSTS 追加。
_PLATFORM_RELAY_HOSTS = ("www.qianshousuanli.com", "qianshousuanli.com")


def _platform_host_of(url) -> str:
    raw = str(url or "").strip().lower()
    if not raw:
        return ""
    if "://" in raw:
        raw = raw.split("://", 1)[1]
    raw = raw.split("/", 1)[0].split("?", 1)[0]
    if raw.startswith("["):
        return raw[1:raw.index("]")] if "]" in raw else ""
    if raw.count(":") == 1:
        raw = raw.split(":", 1)[0]
    return raw


def _is_platform_endpoint(url) -> bool:
    # 白名单条目允许写 host 或 host:port —— 一律归一到 host 再比对，
    # 否则 "127.0.0.1:8080" 这类条目永远匹配不上（真实踩过的坑）。
    hosts = set(_PLATFORM_RELAY_HOSTS)
    for item in str(os.environ.get("QS_PLATFORM_RELAY_HOSTS") or "").split(","):
        h = _platform_host_of("http://" + item.strip()) if item.strip() else ""
        if h:
            hosts.add(h)
    host = _platform_host_of(url)
    return bool(host) and host in hosts


def _relay_api_key(params: dict, endpoint) -> str:
    """该 endpoint 应使用的凭据；不该带平台凭据时返回 ""。"""
    explicit = str((params or {}).get("api_key") or "").strip()
    if explicit:
        return explicit
    env_key = str(os.environ.get(_PLATFORM_RELAY_KEY_ENV) or "").strip()
    if not env_key:
        return ""
    return env_key if _is_platform_endpoint(endpoint) else ""


def _public_http_error(code: int, raw: str):
    """Return (owner-visible Chinese or HTTP code, retryable). Never keep URL or provider body."""
    retryable = not (400 <= code < 500 and code != 429)
    try:
        body = json.loads(raw)
        detail = body.get("detail") if isinstance(body, dict) else None
        msg = None
        if isinstance(detail, dict):
            msg = detail.get("message")
            if detail.get("retryable") is False:
                retryable = False
        elif isinstance(detail, str):
            msg = detail
        if isinstance(msg, str):
            text = msg.strip()
            if (8 <= len(text) <= 160
                    and any("\u4e00" <= c <= "\u9fff" for c in text)
                    and not any(c in text for c in "/\\:@?&=%<>\"'")):
                if isinstance(detail, dict):
                    retryable = detail.get("retryable") is True
                return text, retryable
    except Exception:
        pass
    return f"HTTP {code}", retryable


def _post(url: str, body: dict, headers: dict, timeout: int):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    h = {"Content-Type": "application/json", **headers}
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _call_with_retry(endpoints: list, body: dict, headers: dict,
                     timeout: int, retry: int, backoff: float) -> tuple:
    """endpoints fallback · 单 endpoint 重试 · 返 (response_obj, used_endpoint)"""
    last_err = None
    for ep in endpoints:
        for attempt in range(retry + 1):
            try:
                r = _post(ep, body, headers, timeout)
                return r, ep
            except urllib.error.HTTPError as he:
                raw = he.read()[:800].decode("utf-8", "replace")
                last_err, retryable = _public_http_error(he.code, raw)
                if not retryable:
                    break
            except (urllib.error.URLError, TimeoutError):
                last_err = "访问文字接口网络失败。"
            except Exception:
                last_err = "访问文字接口失败，原因不明。"
            if attempt < retry:
                time.sleep(backoff ** attempt)
    raise RuntimeError(last_err or "全部文字接口都调用失败。")


def _collect_prompts(p: dict, stdin_obj: dict) -> list:
    """messages > prompts > prompt > text · 返 [(messages, label), ...]"""
    # 1. messages 模式(完整对话)
    msgs = p.get("messages") or stdin_obj.get("messages")
    if msgs and isinstance(msgs, list):
        return [(msgs, "multi_turn")]

    # 2. prompts 批量
    system = p.get("system") or stdin_obj.get("system") or "你是一个有帮助的助手"
    prompts = p.get("prompts") or stdin_obj.get("prompts")
    if prompts and isinstance(prompts, list):
        return [
            ([{"role": "system", "content": system},
              {"role": "user", "content": str(pr)}], f"prompt_{i}")
            for i, pr in enumerate(prompts)
        ]

    # 3. 单 prompt
    prompt = (p.get("prompt") or stdin_obj.get("prompt")
              or stdin_obj.get("text") or "").strip()
    if not prompt:
        return []
    return [([{"role": "system", "content": system},
              {"role": "user", "content": prompt}], "prompt_0")]


def main():
    t0 = time.time()
    try:
        p = _params()
        raw = sys.stdin.read()
        stdin_obj = {}
        if raw.lstrip().startswith(("{", "[")):
            try:
                stdin_obj = json.loads(raw) or {}
                # stdin.params 合并(EC_PARAMS 仍优先)
                merged = dict(stdin_obj.get("params") or {})
                merged.update(p)
                p = merged
            except Exception:
                stdin_obj = {"text": raw}
        elif raw.strip():
            stdin_obj = {"text": raw}

        # endpoints
        endpoints = p.get("endpoints") or []
        _endpoint_caller_supplied = bool(endpoints or p.get("endpoint"))
        if not endpoints and p.get("endpoint"):
            endpoints = [p["endpoint"]]
        if not endpoints:
            endpoints = ["https://www.qianshousuanli.com/api/v1/chat/completions"]

        model = p.get("model") or "ec-master"
        timeout = int(p.get("timeout") or 60)
        retry = int(p.get("retry") if p.get("retry") is not None else 2)
        backoff = float(p.get("retry_backoff") or 1.5)
        headers = {}
        # 主 endpoint 决定凭据归属：用户自带 api_key 优先；否则仅在打平台地址时
        # 附加 worker 凭据（平台派发层注入的 api_key 会先命中第一条）。
        _primary_ep = str(endpoints[0]) if endpoints else ""
        _ak = _relay_api_key(p, _primary_ep)
        if _ak:
            headers["Authorization"] = f"Bearer {_ak}"

        call_args = {
            "temperature": float(p.get("temperature", 0.7)),
            "top_p": float(p.get("top_p", 1.0)),
            "max_tokens": int(p.get("max_tokens", 1000)),
        }
        if p.get("stop"):
            call_args["stop"] = p["stop"]
        if p.get("seed") is not None:
            call_args["seed"] = int(p["seed"])

        # 收集 prompts
        tasks = _collect_prompts(p, stdin_obj)
        if not tasks:
            raise ValueError("无 prompt/prompts/messages/text 输入")

        # 调用
        results = []
        errors = []
        total_in = total_out = 0
        for messages, label in tasks:
            body = {"model": model, "messages": messages, **call_args}
            try:
                r, used_ep = _call_with_retry(endpoints, body, headers,
                                              timeout, retry, backoff)
                answer = (r.get("choices", [{}])[0]
                          .get("message", {}).get("content", "") or "")
                usage = r.get("usage") or {}
                in_t = int(usage.get("prompt_tokens") or 0)
                out_t = int(usage.get("completion_tokens") or 0)
                total_in += in_t
                total_out += out_t
                results.append({
                    "label": label,
                    "answer": answer,
                    "input_tokens": in_t,
                    "output_tokens": out_t,
                    "endpoint": used_ep,
                    "compute_origin": COMPUTE_ORIGIN_PLATFORM_RELAY,
                    "compute_origin_note": COMPUTE_ORIGIN_NOTE,
                    "endpoint_caller_supplied": _endpoint_caller_supplied,
                    "finish_reason": (r.get("choices", [{}])[0].get("finish_reason")
                                      or "unknown"),
                })
            except Exception as exc:
                errors.append({"label": label, "error": str(exc)[:300]})

        if not results:
            print(json.dumps({
                "status": "failed", "task_type": "llm_chat",
                "error": "所有调用失败",
                "errors": errors,
                "summary_text": "❌ LLM 全部失败 · " + (errors[0]["error"] if errors else ""),
            }, ensure_ascii=False))
            return 1

        # 费用估算
        price = p.get("price_per_1k") or {}
        cost = None
        if isinstance(price, dict) and (price.get("input") or price.get("output")):
            cost = round(total_in / 1000 * float(price.get("input") or 0)
                         + total_out / 1000 * float(price.get("output") or 0), 6)

        elapsed = int((time.time() - t0) * 1000)
        first = results[0]
        used_endpoint = first.get("endpoint") or ""
        out = {
            "status": "ok", "schema_version": "v1", "task_type": "llm_chat",
            "elapsed_ms": elapsed,
            "summary": {
                "model": model,
                "calls_total": len(tasks),
                "calls_ok": len(results),
                "calls_failed": len(errors),
                "input_tokens": total_in,
                "output_tokens": total_out,
                "total_tokens": total_in + total_out,
                "estimated_cost_cny": cost,
                "endpoints": endpoints,
                "compute_provenance": {
                    "compute_origin": COMPUTE_ORIGIN_PLATFORM_RELAY,
                    "compute_origin_note": COMPUTE_ORIGIN_NOTE,
                    "endpoint_caller_supplied": _endpoint_caller_supplied,
                    "platform_endpoints": list(endpoints),
                    "model": model,
                },
            },
            "results": results,
            "errors": errors,
            "result_text": first["answer"],  # 兼容老消费方
            "summary_text": (
                f"✅ LLM {len(results)}/{len(tasks)} 调用成功 · {model}\n"
                f"📊 Token: in {total_in} / out {total_out} / total {total_in + total_out}"
                + (f" · ¥{cost:.4f}" if cost is not None else "") + "\n"
                f"☁️ 算力归属: {COMPUTE_ORIGIN_LABEL} ({COMPUTE_ORIGIN_PLATFORM_RELAY})"
                f" · 实际调用 {used_endpoint or '?'} · {model}\n"
                f"⏱ {elapsed}ms\n"
                f"💬 首回答:\n{first['answer'][:500]}"
            ),
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "llm_chat",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
