#!/usr/bin/env python3
"""llm_classify — 文本分类 (企业级 · 2026-06-07 S5 升级)

新增:
  - **多标签**(multi_label · 一文可多个标签)
  - **置信度**(让 LLM 输出 JSON {labels:[...], confidence:0-1})
  - 批量(单调用打包多文本)
  - 并发 worker
  - endpoints fallback + 重试
  - 自定义提示词 (extra_instructions)
  - 标签匹配更鲁棒(标签别名 · 大小写/中英)
  - 标签分布统计 + top 错误样例

参数 (EC_PARAMS · 优先于 stdin.params):
  endpoint(s)        str/list
  model              str    默认 ec-master
  texts              list   待分类
  labels             list   标签列表(必填)
  label_aliases      dict   { "正面": ["positive","好评"] } 别名映射
  multi_label        bool   默认 false (单选 · true=多选)
  return_confidence  bool   默认 true · 让 LLM 返置信度
  batch_size         int    单调用打包文本数 (默认 5)
  concurrency        int    并发 (默认 4)
  extra_instructions str    追加 system 提示
  temperature        float  默认 0
  timeout            int    默认 30
  retry              int    默认 2
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed


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


def _call_with_retry(endpoints: list, body: dict, headers: dict,
                     timeout: int, retry: int) -> tuple:
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


def _build_system(labels: list, multi_label: bool, return_confidence: bool,
                  extra: str, batch_mode: bool) -> str:
    parts = ["你是文本分类器。"]
    label_str = ", ".join(labels)
    if multi_label:
        parts.append(f"为每条文本选择 0 个或多个标签(从 [{label_str}] 中选)。")
    else:
        parts.append(f"为每条文本选择**一个**最合适的标签(从 [{label_str}] 中选)。")
    if return_confidence:
        if batch_mode:
            parts.append('每条文本输出一行 JSON: {"id":N,"labels":["X"],"confidence":0.95}'
                         + (' (id 与输入 [N] 对应,labels 数组允许多个)' if multi_label else ''))
        else:
            parts.append('输出一行 JSON: {"labels":["X"],"confidence":0.95}')
    else:
        if batch_mode:
            parts.append("每条文本输出一行: [N] 标签1,标签2")
        else:
            parts.append("只输出标签名(允许多个用逗号分隔)。")
    parts.append("严格按格式 · 不要解释。")
    if extra:
        parts.append(extra)
    return "\n".join(parts)


def _normalize(s: str) -> str:
    return re.sub(r"\s+", "", s.lower())


def _match_labels(text: str, labels: list, aliases: dict) -> list:
    """从 LLM 返的字符串里提取标签(含别名匹配)"""
    matched = []
    text_low = _normalize(text)
    for lab in labels:
        if _normalize(lab) in text_low:
            matched.append(lab)
            continue
        for alias in (aliases.get(lab) or []):
            if _normalize(alias) in text_low:
                matched.append(lab)
                break
    return matched


def _process_batch(items: list, endpoints: list, model: str, system: str,
                   labels: list, aliases: dict, headers: dict, timeout: int,
                   retry: int, temperature: float, multi_label: bool,
                   return_confidence: bool, batch_mode: bool) -> tuple:
    """items: [(idx, text)] · 返 ([(idx, result_dict)], in_t, out_t)"""
    if batch_mode and len(items) > 1:
        user = "\n".join(f"[{i+1}] {t}" for i, (_, t) in enumerate(items))
    else:
        user = items[0][1]
    body = {
        "model": model, "temperature": temperature,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
    }
    try:
        r, _ = _call_with_retry(endpoints, body, headers, timeout, retry)
        answer = (r.get("choices", [{}])[0]
                  .get("message", {}).get("content", "") or "").strip()
        usage = r.get("usage") or {}
    except Exception as exc:
        return [(idx, {"error": str(exc)[:200]}) for idx, _ in items], 0, 0

    in_t = int(usage.get("prompt_tokens") or 0)
    out_t = int(usage.get("completion_tokens") or 0)

    rows = []
    if batch_mode and len(items) > 1:
        lines = [l.strip() for l in answer.splitlines() if l.strip()]
        # 按 [N] / id 映射
        per_idx = {}
        for line in lines:
            # 形态 1: JSON {"id":N, "labels":..., "confidence":...}
            if return_confidence and line.startswith("{"):
                try:
                    obj = json.loads(line)
                    if isinstance(obj, dict) and "id" in obj:
                        per_idx[int(obj["id"])] = obj
                        continue
                except Exception:
                    pass
            # 形态 2: [N] 标签1,标签2
            m = re.match(r"\[(\d+)\]\s*(.+)", line)
            if m:
                per_idx[int(m.group(1))] = {"raw": m.group(2)}
        for n, (idx, txt) in enumerate(items, 1):
            data = per_idx.get(n)
            if not data:
                rows.append((idx, {"text": txt[:120], "labels": [], "confidence": 0,
                                   "error": "LLM 未返此 id"}))
                continue
            # 解析 labels
            if "labels" in data:
                lbs = data["labels"] if isinstance(data["labels"], list) else [data["labels"]]
                lbs = [l for l in lbs if l in labels]
            else:
                lbs = _match_labels(data.get("raw", ""), labels, aliases)
            if not multi_label and len(lbs) > 1:
                lbs = lbs[:1]
            rows.append((idx, {
                "text": txt[:120],
                "labels": lbs,
                "confidence": float(data.get("confidence") or 0),
            }))
    else:
        idx, txt = items[0]
        # 单条 · 优先 JSON 解析
        data = None
        if return_confidence and answer.startswith("{"):
            try:
                data = json.loads(answer)
            except Exception:
                pass
        if data and "labels" in data:
            lbs = data["labels"] if isinstance(data["labels"], list) else [data["labels"]]
            lbs = [l for l in lbs if l in labels]
            conf = float(data.get("confidence") or 0)
        else:
            lbs = _match_labels(answer, labels, aliases)
            conf = 0.0
        if not multi_label and len(lbs) > 1:
            lbs = lbs[:1]
        rows.append((idx, {"text": txt[:120], "labels": lbs, "confidence": conf}))

    return rows, in_t, out_t


def main():
    t0 = time.time()
    try:
        p = _params()
        raw = sys.stdin.read()
        stdin_obj: dict = {}
        if raw.lstrip().startswith(("{", "[")):
            try:
                stdin_obj = json.loads(raw) or {}
                merged = dict(stdin_obj.get("params") or {})
                merged.update(p)
                p = merged
            except Exception:
                stdin_obj = {}

        texts = (p.get("texts") or stdin_obj.get("texts")
                 or stdin_obj.get("lines") or [])
        if not texts and raw and not raw.lstrip().startswith(("{", "[")):
            texts = [l for l in raw.splitlines() if l.strip()]
        if not texts:
            raise ValueError("无输入文本")
        texts = [str(t) for t in texts]

        labels = p.get("labels") or ["positive", "neutral", "negative"]
        if not isinstance(labels, list) or len(labels) < 2:
            raise ValueError("labels 至少 2 个")
        aliases = p.get("label_aliases") or {}
        multi_label = bool(p.get("multi_label", False))
        return_confidence = bool(p.get("return_confidence", True))
        batch_size = max(1, min(20, int(p.get("batch_size") or 5)))
        concurrency = max(1, min(16, int(p.get("concurrency") or 4)))
        temperature = float(p.get("temperature", 0))
        timeout = int(p.get("timeout") or 30)
        retry = int(p.get("retry") if p.get("retry") is not None else 2)
        extra = p.get("extra_instructions") or ""

        endpoints = p.get("endpoints") or ([p["endpoint"]] if p.get("endpoint") else [])
        if not endpoints:
            endpoints = ["https://www.qianshousuanli.com/api/v1/chat/completions"]
        model = p.get("model") or "ec-master"
        headers = {}
        # 主 endpoint 决定凭据归属：用户自带 api_key 优先；否则仅在打平台地址时
        # 附加 worker 凭据（平台派发层注入的 api_key 会先命中第一条）。
        _primary_ep = str(endpoints[0]) if endpoints else ""
        _ak = _relay_api_key(p, _primary_ep)
        if _ak:
            headers["Authorization"] = f"Bearer {_ak}"

        batch_mode = batch_size > 1
        system = _build_system(labels, multi_label, return_confidence, extra, batch_mode)

        batches = []
        for i in range(0, len(texts), batch_size):
            batches.append([(j, texts[j]) for j in range(i, min(i + batch_size, len(texts)))])

        all_rows = [None] * len(texts)
        total_in = total_out = 0
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = {ex.submit(_process_batch, b, endpoints, model, system,
                              labels, aliases, headers, timeout, retry,
                              temperature, multi_label, return_confidence,
                              batch_mode): b for b in batches}
            for fu in as_completed(futs):
                rows, in_t, out_t = fu.result()
                total_in += in_t
                total_out += out_t
                for idx, res in rows:
                    all_rows[idx] = res

        # 分布统计
        counts = {l: 0 for l in labels}
        counts["unknown"] = 0
        counts["error"] = 0
        for r in all_rows:
            if not r:
                counts["error"] += 1
                continue
            if r.get("error"):
                counts["error"] += 1
                continue
            lbs = r.get("labels") or []
            if not lbs:
                counts["unknown"] += 1
            for l in lbs:
                if l in counts:
                    counts[l] += 1

        elapsed = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok", "schema_version": "v1", "task_type": "llm_classify",
            "elapsed_ms": elapsed,
            "summary": {
                "total": len(texts),
                "processed": sum(1 for r in all_rows if r and not r.get("error")),
                "labels": labels,
                "distribution": counts,
                "multi_label": multi_label,
                "model": model,
                "input_tokens": total_in,
                "output_tokens": total_out,
                "calls_total": len(batches),
                "batch_size": batch_size,
            },
            "result": all_rows,
            "results": all_rows,
            "summary_text": (
                f"✅ 分类 {sum(1 for r in all_rows if r and not r.get('error'))}/{len(texts)} · {model}\n"
                f"📊 分布: " + " · ".join(f"{l}:{counts[l]}" for l in labels) + "\n"
                f"📦 {len(batches)} 调用 (batch={batch_size}) · "
                f"in {total_in}/out {total_out} tok · {elapsed}ms"
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "llm_classify",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
