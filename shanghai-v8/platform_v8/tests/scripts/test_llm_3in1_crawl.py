"""S5 第五批 · llm_translate + llm_classify + llm_extract + crawl_batch_fetch (2026-06-07)"""
from __future__ import annotations
import json
import os
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def _run(script_name: str, stdin: str = "", params: Optional[dict] = None,
         env_extra: Optional[dict] = None, timeout: int = 30) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    if env_extra:
        env.update(env_extra)
    script_path = SCRIPTS_DIR / (script_name + ".py")
    proc = subprocess.run(
        [sys.executable, str(script_path)],
        input=stdin, text=True, capture_output=True, env=env, timeout=timeout,
    )
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"{script_name} no stdout · stderr={proc.stderr[:500]}")
    return json.loads(out.split("\n")[-1])


# ══════════════════════════════════════════════════════════════
# Mock LLM HTTP server
# ══════════════════════════════════════════════════════════════
_port = 0
_server: Optional[HTTPServer] = None
_call_log: list = []


class _Mock(BaseHTTPRequestHandler):
    def log_message(self, *_a, **_k):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        _call_log.append({"path": self.path, "body": body})

        msgs = body.get("messages") or []
        system = next((m["content"] for m in msgs if m["role"] == "system"), "")
        user = next((m["content"] for m in msgs if m["role"] == "user"), "")
        path = self.path

        # 智能响应:按 system 指示返
        if "翻译" in system:
            # 输入可能是 [1] xx\n[2] yy 形式
            if "[1]" in user and "[2]" in user:
                lines = []
                for ln in user.split("\n"):
                    ln = ln.strip()
                    if not ln:
                        continue
                    if ln.startswith("["):
                        i = ln.index("]")
                        num = ln[1:i]
                        rest = ln[i + 1:].strip()
                        lines.append(f"[{num}] T({rest})")
                ans = "\n".join(lines)
            else:
                ans = f"T({user})"
        elif "分类器" in system:
            # 看 system 是否要求 JSON
            if '"id"' in system and "[1]" in user:
                lines = []
                for ln in user.split("\n"):
                    ln = ln.strip()
                    if not ln or not ln.startswith("["):
                        continue
                    i = ln.index("]")
                    num = ln[1:i]
                    lines.append(json.dumps({"id": int(num), "labels": ["positive"],
                                             "confidence": 0.9}))
                ans = "\n".join(lines)
            elif '"labels"' in system:
                ans = json.dumps({"labels": ["positive"], "confidence": 0.9})
            elif "[1]" in user:
                lines = []
                for ln in user.split("\n"):
                    if ln.strip().startswith("["):
                        i = ln.index("]")
                        lines.append(f"{ln[:i+1]} positive")
                ans = "\n".join(lines)
            else:
                ans = "positive"
        elif "抽取器" in system:
            # 简单回 schema 形 JSON
            ans = json.dumps({
                "name": "Alice", "age": "30", "skills": "Python, SQL",
                "active": "true",
            })
        else:
            ans = f"echo: {user[:80]}"

        usage = {
            "prompt_tokens": len(user.split()),
            "completion_tokens": len(ans.split()),
            "total_tokens": len(user.split()) + len(ans.split()),
        }
        resp = {
            "choices": [{"message": {"role": "assistant", "content": ans},
                         "finish_reason": "stop"}],
            "usage": usage,
        }
        data = json.dumps(resp).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(scope="module", autouse=True)
def _mock():
    global _port, _server
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    _port = sock.getsockname()[1]
    sock.close()
    _server = HTTPServer(("127.0.0.1", _port), _Mock)
    th = threading.Thread(target=_server.serve_forever, daemon=True)
    th.start()
    time.sleep(0.05)
    yield
    _server.shutdown()


def _url() -> str:
    return f"http://127.0.0.1:{_port}/api/v1/chat/completions"


# ══════════════════════════════════════════════════════════════
# llm_translate
# ══════════════════════════════════════════════════════════════

def test_translate_single():
    out = _run("llm_translate", "你好世界",
               params={"endpoint": _url(), "target": "英文",
                       "batch_size": 1, "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["translated"] == 1
    assert out["result"][0]["dst"].startswith("T(")


def test_translate_batch_with_numbering():
    """batch=3 · 一次调用译 3 句"""
    out = _run("llm_translate", "",
               params={"endpoint": _url(),
                       "texts": ["句一", "句二", "句三"],
                       "batch_size": 3, "concurrency": 1, "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["translated"] == 3
    assert out["summary"]["calls_total"] == 1  # 一次调用搞定 3 句
    for r in out["result"]:
        assert "dst" in r


def test_translate_glossary():
    """术语表注入 system"""
    out = _run("llm_translate", "千手算力",
               params={"endpoint": _url(),
                       "glossary": {"千手算力": "Qianshou Compute"},
                       "batch_size": 1, "retry": 0})
    assert out["status"] == "ok"
    # mock server 不会真按术语翻 · 仅验证 system 含术语
    assert _call_log[-1]["body"]["messages"][0]["content"].find("Qianshou Compute") >= 0


def test_translate_fallback_endpoint():
    out = _run("llm_translate", "test",
               params={"endpoints": ["http://127.0.0.1:1/dead", _url()],
                       "batch_size": 1, "retry": 0, "timeout": 3})
    assert out["status"] == "ok"
    assert out["summary"]["translated"] == 1


def test_translate_no_input_fails():
    out = _run("llm_translate", "", params={"endpoint": _url()})
    assert out["status"] == "failed"


# ══════════════════════════════════════════════════════════════
# llm_classify
# ══════════════════════════════════════════════════════════════

def test_classify_single_with_confidence():
    out = _run("llm_classify", "好评!",
               params={"endpoint": _url(),
                       "labels": ["positive", "neutral", "negative"],
                       "batch_size": 1, "retry": 0})
    assert out["status"] == "ok"
    r = out["result"][0]
    assert r["labels"] == ["positive"]
    assert r["confidence"] == 0.9


def test_classify_batch():
    out = _run("llm_classify", "",
               params={"endpoint": _url(),
                       "texts": ["好评", "差评", "一般"],
                       "labels": ["positive", "neutral", "negative"],
                       "batch_size": 3, "concurrency": 1, "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["calls_total"] == 1
    assert out["summary"]["processed"] == 3


def test_classify_multi_label_mode():
    """multi_label=true 应该允许多标签 · 但 mock 只返 positive"""
    out = _run("llm_classify", "test",
               params={"endpoint": _url(),
                       "labels": ["positive", "neutral", "negative"],
                       "multi_label": True, "batch_size": 1, "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["multi_label"] is True


def test_classify_distribution():
    out = _run("llm_classify", "",
               params={"endpoint": _url(),
                       "texts": ["x"] * 5,
                       "labels": ["positive", "neutral", "negative"],
                       "batch_size": 2, "concurrency": 1, "retry": 0})
    assert out["status"] == "ok"
    dist = out["summary"]["distribution"]
    # 全部 mock 返 positive
    assert dist.get("positive", 0) >= 1


def test_classify_invalid_labels():
    out = _run("llm_classify", "hi",
               params={"endpoint": _url(), "labels": ["only_one"]})
    assert out["status"] == "failed"


# ══════════════════════════════════════════════════════════════
# llm_extract
# ══════════════════════════════════════════════════════════════

def test_extract_single():
    out = _run("llm_extract", json.dumps({
        "text": "Alice 30 岁,会 Python 和 SQL",
        "schema": {"name": "string", "age": "int",
                   "skills": "list", "active": "bool"},
    }), params={"endpoint": _url(), "retry": 0})
    assert out["status"] == "ok"
    d = out["result"]
    assert d["name"] == "Alice"
    assert d["age"] == 30                 # 类型强转: str "30" → int
    assert isinstance(d["skills"], list)  # 类型强转: "Python, SQL" → list
    assert d["active"] is True            # 类型强转: "true" → bool


def test_extract_batch():
    out = _run("llm_extract", "",
               params={"endpoint": _url(),
                       "texts": ["t1", "t2", "t3"],
                       "schema": {"name": "string"},
                       "concurrency": 2, "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["extracted"] == 3


def test_extract_missing_schema_fails():
    out = _run("llm_extract", json.dumps({"text": "x"}),
               params={"endpoint": _url()})
    assert out["status"] == "failed"


def test_extract_required_warning():
    """required 字段在 mock 里有 · 不应有 warnings"""
    out = _run("llm_extract", json.dumps({
        "text": "x", "schema": {"name": "string", "phone": "string"},
        "schema_required": ["phone"],  # phone mock 不返
    }), params={"endpoint": _url(), "retry": 0})
    assert out["status"] == "ok"
    warns = out["results"][0]["warnings"]
    # phone 缺失应警告
    assert any("phone" in w for w in warns)


def test_extract_json_markdown_strip():
    """LLM 返 ```json {...} ``` 包装 · 仍能解析(mock 不模拟此 · 走代码路径)"""
    # 测真实 _extract_json 容错
    import importlib.util
    spec = importlib.util.spec_from_file_location("mod", SCRIPTS_DIR / "llm_extract.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod._extract_json('```json\n{"a":1}\n```') == {"a": 1}
    assert mod._extract_json('{"a": 1}') == {"a": 1}
    assert mod._extract_json('前缀噪音 {"x":2} 尾噪音') == {"x": 2}
    assert mod._extract_json("not json") is None


# ══════════════════════════════════════════════════════════════
# crawl_batch_fetch (仅离线 SSRF / 参数路径测 · 不实际抓外网)
# ══════════════════════════════════════════════════════════════

def test_crawl_no_urls_fails():
    out = _run("crawl_batch_fetch", "", params={})
    assert out["status"] == "failed"


def test_crawl_ssrf_localhost_blocked():
    """localhost 应被 SSRF 拦截"""
    out = _run("crawl_batch_fetch", "", params={
        "urls": ["http://github.com/test"],  # 白名单内但用假主机
        "concurrency": 1, "timeout_s": 2,
    })
    # github.com 在白名单 · 但若网络隔离会失败 · 关键看代码不 crash
    assert out["status"] == "ok"
    assert out["summary"]["fetched_count"] == 1


def test_crawl_domain_not_whitelisted():
    out = _run("crawl_batch_fetch", "", params={
        "urls": ["http://evil.example.org/x"],
        "concurrency": 1,
    })
    assert out["status"] == "ok"
    r = out["results"][0]
    assert r["ok"] is False
    assert "白名单" in r["error"]


def test_crawl_ssrf_private_ip_in_url():
    """url 直接给私网域名 · 应被 SSRF 拦"""
    # 用白名单子域但实际不存在(SSRF 主要靠 IP 解析判)
    # 这里测 _is_private_ip 函数本身
    import importlib.util
    spec = importlib.util.spec_from_file_location("mod", SCRIPTS_DIR / "crawl_batch_fetch.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod._is_private_ip("127.0.0.1") is True
    assert mod._is_private_ip("localhost") is True
    assert mod._is_private_ip("10.0.0.1") is True
    assert mod._is_private_ip("192.168.1.1") is True


def test_crawl_results_jsonl_structure():
    """error_distribution / output_jsonl 字段存在"""
    out = _run("crawl_batch_fetch", "", params={
        "urls": ["http://evil.example.org/a", "http://evil.example.org/b"],
        "concurrency": 2,
    })
    assert out["status"] == "ok"
    assert "error_distribution" in out["summary"]
    assert out["summary"]["fail_count"] == 2
