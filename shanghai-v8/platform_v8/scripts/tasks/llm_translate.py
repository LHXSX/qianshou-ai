#!/usr/bin/env python3
"""llm_translate — 批量翻译 (企业级 · 2026-06-07 S5 升级)

新增:
  - **batch 一次调多句**(默认 5 句/调 · 减 4/5 token 成本与延时)
  - endpoints fallback + 指数回退重试
  - 并发(默认 4 worker · 网络 I/O 密集)
  - 术语表(glossary)注入(品牌名/专有名词固定译法)
  - 检测源语言(简单中英判断 · 可选 source_lang)
  - 写全量 EC_OUTPUT_DIR/translations.jsonl
  - EC_PARAMS 统一参数

参数 (EC_PARAMS · 优先于 stdin.params):
  endpoint(s)     str/list
  model           str    默认 ec-master
  texts           list   待译文本
  target          str    目标语言名 (默认 英文)
  source          str    源语言名 (默认 自动)
  batch_size      int    单次调用打包几句 (默认 5 · 0=单条)
  concurrency     int    并发数 (默认 4)
  glossary        dict   {"千手算力":"Qianshou Compute", ...}
  temperature     float  默认 0.3 (翻译低温)
  timeout         int    单调用秒 (默认 30)
  retry           int    每次调用重试 (默认 2)
  api_key         str    Bearer
  preserve_format bool   保留行内格式(默认 true · 不让 LLM 增删行)
"""
import json
import os
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
    last_err = None
    for ep in endpoints:
        for attempt in range(retry + 1):
            try:
                return _post(ep, body, headers, timeout), ep
            except urllib.error.HTTPError as he:
                last_err = f"HTTP {he.code}@{ep}"
                if 400 <= he.code < 500 and he.code != 429:
                    break
            except Exception as exc:
                last_err = f"{exc}@{ep}"
            if attempt < retry:
                time.sleep(1.5 ** attempt)
    raise RuntimeError(last_err or "all endpoints failed")


def _build_system(target: str, source: str, glossary: dict, batch_mode: bool,
                  preserve_format: bool) -> str:
    parts = [f"你是专业翻译。把用户输入准确翻译成{target}。"]
    if source and source != "auto":
        parts.append(f"源语言: {source}。")
    parts.append("严格按要求输出,不要解释、不要寒暄、不要加引号或代码块。")
    if preserve_format:
        parts.append("保留原文换行和段落结构。")
    if glossary:
        terms = "\n".join(f"  {k} → {v}" for k, v in list(glossary.items())[:50])
        parts.append(f"\n术语表(严格遵守):\n{terms}\n")
    if batch_mode:
        parts.append(
            "用户每条文本前会有 [N] 编号 · "
            "请同样用 [N] 编号回译,一一对应,顺序不变。"
        )
    return "".join(parts)


def _translate_one_batch(items: list, endpoints: list, model: str, system: str,
                         headers: dict, timeout: int, retry: int,
                         temperature: float, batch_mode: bool) -> tuple:
    """items: [(idx, text), ...] · 返 [(idx, translation, error)]"""
    if not items:
        return []
    if batch_mode and len(items) > 1:
        user_content = "\n".join(f"[{i+1}] {t}" for i, (_, t) in enumerate(items))
    else:
        user_content = items[0][1]

    body = {
        "model": model,
        "temperature": temperature,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user_content},
        ],
    }
    try:
        r, _ = _call_with_retry(endpoints, body, headers, timeout, retry)
        answer = (r.get("choices", [{}])[0]
                  .get("message", {}).get("content", "") or "").strip()
        usage = r.get("usage") or {}
    except Exception as exc:
        return [(idx, None, str(exc)[:200]) for idx, _ in items], 0, 0

    in_t = int(usage.get("prompt_tokens") or 0)
    out_t = int(usage.get("completion_tokens") or 0)

    if batch_mode and len(items) > 1:
        # 按 [N] 切分
        import re
        translations = {}
        parts = re.split(r"\[(\d+)\]\s*", answer)
        # parts 形如 ['', '1', '译文1\n', '2', '译文2', ...]
        for j in range(1, len(parts) - 1, 2):
            try:
                num = int(parts[j])
                translations[num] = parts[j + 1].strip()
            except ValueError:
                continue
        out_rows = []
        for n, (idx, _) in enumerate(items, 1):
            tr = translations.get(n)
            if tr:
                out_rows.append((idx, tr, None))
            else:
                out_rows.append((idx, None, "LLM 未返回 [N] 标号"))
        return out_rows, in_t, out_t

    return [(items[0][0], answer, None)], in_t, out_t


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

        endpoints = p.get("endpoints") or []
        if not endpoints and p.get("endpoint"):
            endpoints = [p["endpoint"]]
        if not endpoints:
            endpoints = ["https://www.qianshousuanli.com/api/v1/chat/completions"]

        model = p.get("model") or "ec-master"
        target = p.get("target") or "英文"
        source = p.get("source") or "auto"
        batch_size = max(0, min(20, int(p.get("batch_size") if p.get("batch_size") is not None else 5)))
        concurrency = max(1, min(16, int(p.get("concurrency") or 4)))
        temperature = float(p.get("temperature", 0.3))
        timeout = int(p.get("timeout") or 30)
        retry = int(p.get("retry") if p.get("retry") is not None else 2)
        glossary = p.get("glossary") or {}
        preserve_format = p.get("preserve_format", True)
        headers = {}
        # 主 endpoint 决定凭据归属：用户自带 api_key 优先；否则仅在打平台地址时
        # 附加 worker 凭据（平台派发层注入的 api_key 会先命中第一条）。
        _primary_ep = str(endpoints[0]) if endpoints else ""
        _ak = _relay_api_key(p, _primary_ep)
        if _ak:
            headers["Authorization"] = f"Bearer {_ak}"

        batch_mode = batch_size > 1
        effective_batch = batch_size if batch_size > 0 else 1
        system = _build_system(target, source, glossary, batch_mode, preserve_format)

        # 按 batch 拆
        batches = []
        for i in range(0, len(texts), effective_batch):
            batch = [(j, texts[j]) for j in range(i, min(i + effective_batch, len(texts)))]
            batches.append(batch)

        all_rows = [None] * len(texts)
        total_in = total_out = 0
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = {ex.submit(_translate_one_batch, b, endpoints, model, system,
                              headers, timeout, retry, temperature, batch_mode): b
                    for b in batches}
            for fu in as_completed(futs):
                try:
                    rows, in_t, out_t = fu.result()
                    total_in += in_t
                    total_out += out_t
                    for idx, tr, err in rows:
                        all_rows[idx] = {
                            "src": texts[idx],
                            **({"dst": tr} if tr else {"error": err or "unknown"}),
                        }
                except Exception as exc:
                    for idx, _ in futs[fu]:
                        all_rows[idx] = {"src": texts[idx], "error": str(exc)[:200]}

        # 写全量
        output_path = None
        out_dir = os.environ.get("EC_OUTPUT_DIR", "")
        if out_dir and os.path.isdir(out_dir):
            output_path = os.path.join(out_dir, "translations.jsonl")
            try:
                with open(output_path, "w", encoding="utf-8") as fh:
                    for r in all_rows:
                        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            except Exception:
                output_path = None

        ok_n = sum(1 for r in all_rows if r and "dst" in r)
        elapsed = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok", "schema_version": "v1", "task_type": "llm_translate",
            "elapsed_ms": elapsed,
            "summary": {
                "total": len(texts),
                "translated": ok_n,
                "failed": len(texts) - ok_n,
                "target": target, "source": source,
                "model": model,
                "batch_size": effective_batch,
                "concurrency": concurrency,
                "input_tokens": total_in,
                "output_tokens": total_out,
                "calls_total": len(batches),
                "output_path": output_path,
            },
            "result": all_rows,
            "results": all_rows,
            "summary_text": (
                f"✅ 翻译 {ok_n}/{len(texts)} → {target} · {model}\n"
                f"📦 {len(batches)} 次调用 (batch={effective_batch}) · "
                f"Token: in {total_in} / out {total_out}\n"
                f"⏱ {elapsed}ms"
                + (f"\n📁 {output_path}" if output_path else "")
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "llm_translate",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
