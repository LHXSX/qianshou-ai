#!/usr/bin/env python3
"""llm_extract — 结构化抽取 (企业级 · 2026-06-07 S5 升级)

新增:
  - **批量 texts**(支持一文一抽,而不是仅单 text)
  - schema 类型强转 (string/int/float/bool/list)
  - schema required 字段缺失时报警
  - 容错 JSON 解析(去 markdown / 修补常见错误 / 找 {} 最长块)
  - endpoints fallback + 重试
  - 并发 worker
  - few-shot 示例注入

参数 (EC_PARAMS · 优先 stdin.params):
  endpoint(s)     str/list
  model           str    默认 ec-master
  text            str    单 text(向后兼容)
  texts           list   批量 text
  schema          dict   { "name": "string", "age": "int", "skills": "list", ... }
  schema_required list   必填字段(缺则 row.warnings 标注)
  examples        list   few-shot 示例 [{"input":"...","output":{...}}, ...]
  concurrency     int    默认 4
  timeout         int    默认 60
  retry           int    默认 2
  temperature     float  默认 0
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed


_TYPE_COERCE = {
    "string": str, "str": str, "text": str,
    "int": int, "integer": int,
    "float": float, "number": float, "double": float,
    "bool": bool, "boolean": bool,
    "list": list, "array": list,
    "dict": dict, "object": dict,
}


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




def _post(url: str, body: dict, headers: dict, timeout: int):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    h = {"Content-Type": "application/json", **headers}
    req = urllib.request.Request(url, data=data, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _call_with_retry(endpoints, body, headers, timeout, retry):
    last = None
    for ep in endpoints:
        for attempt in range(retry + 1):
            try:
                return _post(ep, body, headers, timeout), ep
            except urllib.error.HTTPError as he:
                last = f"HTTP {he.code}@{ep}"
                if 400 <= he.code < 500 and he.code != 429:
                    break
            except Exception as exc:
                last = f"{exc}@{ep}"
            if attempt < retry:
                time.sleep(1.5 ** attempt)
    raise RuntimeError(last or "all endpoints failed")


def _extract_json(text: str):
    """从 LLM 响应里抠 JSON · 容错 markdown / 前后噪音"""
    s = text.strip()
    # 去 markdown 代码块
    if s.startswith("```"):
        s = re.sub(r"^```\w*\n?", "", s)
        s = re.sub(r"\n?```$", "", s)
        s = s.strip()
    # 直接试
    try:
        return json.loads(s)
    except Exception:
        pass
    # 找最长 { ... } 或 [ ... ] 块
    for opener, closer in [("{", "}"), ("[", "]")]:
        start = s.find(opener)
        end = s.rfind(closer)
        if start >= 0 and end > start:
            try:
                return json.loads(s[start:end + 1])
            except Exception:
                continue
    return None


def _coerce_one(value, type_name: str):
    """按 schema 类型强转"""
    target = _TYPE_COERCE.get((type_name or "string").lower(), str)
    if value is None:
        return None
    if target is bool:
        if isinstance(value, bool):
            return value
        s = str(value).strip().lower()
        return s in ("true", "1", "yes", "y", "是", "对")
    if target is int:
        try:
            return int(float(value))
        except Exception:
            return None
    if target is float:
        try:
            return float(value)
        except Exception:
            return None
    if target is list:
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            # 用逗号或换行切
            parts = re.split(r"[,，;；\n]", value)
            return [p.strip() for p in parts if p.strip()]
        return [value]
    if target is dict:
        return value if isinstance(value, dict) else {"value": value}
    return str(value)


def _apply_schema(raw_obj, schema: dict, required: list) -> tuple:
    """按 schema 校验+强转 · 返 (cleaned, warnings)"""
    if not isinstance(raw_obj, dict):
        return {"_raw": raw_obj}, ["LLM 返回非 dict"]
    cleaned = {}
    warnings = []
    for field, ftype in schema.items():
        cleaned[field] = _coerce_one(raw_obj.get(field), ftype)
    for r in required:
        v = cleaned.get(r)
        if v is None or (isinstance(v, (str, list, dict)) and len(v) == 0):
            warnings.append(f"必填字段 {r} 缺失或空")
    # 多余字段保留
    for k, v in raw_obj.items():
        if k not in cleaned:
            cleaned[k] = v
    return cleaned, warnings


def _build_system(schema: dict, examples: list) -> str:
    parts = [
        "你是结构化抽取器。从用户文本中按 JSON schema 抽取字段,只输出 JSON,不要任何解释、代码块、说明。",
        f"schema: {json.dumps(schema, ensure_ascii=False)}",
    ]
    if examples:
        for ex in examples[:3]:
            parts.append(
                f"\n示例输入: {ex.get('input', '')}\n"
                f"示例输出: {json.dumps(ex.get('output', {}), ensure_ascii=False)}"
            )
    parts.append("\n规则:不存在的字段返 null;list 类型用 JSON 数组;严格 JSON 格式。")
    return "\n".join(parts)


def _extract_one(text: str, idx: int, endpoints: list, model: str,
                 system: str, schema: dict, required: list,
                 headers: dict, timeout: int, retry: int, temperature: float) -> dict:
    body = {
        "model": model, "temperature": temperature,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
    }
    try:
        r, _ = _call_with_retry(endpoints, body, headers, timeout, retry)
        answer = (r.get("choices", [{}])[0]
                  .get("message", {}).get("content", "") or "").strip()
        usage = r.get("usage") or {}
    except Exception as exc:
        return {"index": idx, "error": str(exc)[:200],
                "in_t": 0, "out_t": 0}

    raw = _extract_json(answer)
    if raw is None:
        return {"index": idx, "raw_answer": answer[:500],
                "error": "JSON 解析失败",
                "in_t": int(usage.get("prompt_tokens") or 0),
                "out_t": int(usage.get("completion_tokens") or 0)}

    cleaned, warns = _apply_schema(raw, schema, required)
    return {
        "index": idx, "data": cleaned,
        "warnings": warns,
        "in_t": int(usage.get("prompt_tokens") or 0),
        "out_t": int(usage.get("completion_tokens") or 0),
    }


def main():
    t0 = time.time()
    try:
        p = _params()
        raw = sys.stdin.read()
        stdin_obj: dict = {}
        if raw.lstrip().startswith(("{", "[")):
            try:
                stdin_obj = json.loads(raw) or {}
                # 兼容 obj.schema 和 obj.params.schema
                merged = dict(stdin_obj.get("params") or {})
                merged.update(p)
                # stdin 顶层兼容(老消费方常这样传)
                for top_key in ("schema", "schema_required", "examples"):
                    if top_key not in merged and stdin_obj.get(top_key) is not None:
                        merged[top_key] = stdin_obj[top_key]
                p = merged
            except Exception:
                stdin_obj = {}

        schema = p.get("schema") or {}
        if not isinstance(schema, dict) or not schema:
            raise ValueError("缺 schema (字段名→类型)")
        required = p.get("schema_required") or []
        examples = p.get("examples") or []

        # 输入文本
        texts = p.get("texts") or stdin_obj.get("texts") or []
        if not texts:
            single = p.get("text") or stdin_obj.get("text")
            if single:
                texts = [single]
            elif raw and not raw.lstrip().startswith(("{", "[")):
                texts = [raw]
        if not texts:
            raise ValueError("无输入 text/texts")
        texts = [str(t) for t in texts]

        endpoints = p.get("endpoints") or ([p["endpoint"]] if p.get("endpoint") else [])
        if not endpoints:
            endpoints = ["https://www.qianshousuanli.com/api/v1/chat/completions"]
        model = p.get("model") or "ec-master"
        concurrency = max(1, min(16, int(p.get("concurrency") or 4)))
        timeout = int(p.get("timeout") or 60)
        retry = int(p.get("retry") if p.get("retry") is not None else 2)
        temperature = float(p.get("temperature", 0))
        headers = {}
        # 主 endpoint 决定凭据归属：用户自带 api_key 优先；否则仅在打平台地址时
        # 附加 worker 凭据（平台派发层注入的 api_key 会先命中第一条）。
        _primary_ep = str(endpoints[0]) if endpoints else ""
        _ak = _relay_api_key(p, _primary_ep)
        if _ak:
            headers["Authorization"] = f"Bearer {_ak}"

        system = _build_system(schema, examples)

        results = [None] * len(texts)
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = {ex.submit(_extract_one, t, i, endpoints, model, system,
                              schema, required, headers, timeout, retry,
                              temperature): i
                    for i, t in enumerate(texts)}
            for fu in as_completed(futs):
                r = fu.result()
                results[r["index"]] = r

        ok_n = sum(1 for r in results if r and "data" in r)
        total_in = sum(r.get("in_t", 0) for r in results if r)
        total_out = sum(r.get("out_t", 0) for r in results if r)
        elapsed = int((time.time() - t0) * 1000)

        # 单 text 模式 · 兼容老消费方
        is_single = len(texts) == 1
        first = results[0] or {}
        first_data = first.get("data") or first.get("raw_answer") or {}

        out = {
            "status": "ok", "schema_version": "v1", "task_type": "llm_extract",
            "elapsed_ms": elapsed,
            "summary": {
                "total": len(texts),
                "extracted": ok_n,
                "failed": len(texts) - ok_n,
                "schema_fields": list(schema.keys()),
                "schema_required": required,
                "model": model,
                "input_tokens": total_in,
                "output_tokens": total_out,
            },
            "result": first_data if is_single else None,
            "results": results,
            "summary_text": (
                f"✅ 抽取 {ok_n}/{len(texts)} · {model}\n"
                f"📊 字段: {', '.join(list(schema.keys())[:6])}\n"
                f"📊 Token: in {total_in} / out {total_out} · ⏱ {elapsed}ms"
            ),
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "llm_extract",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
