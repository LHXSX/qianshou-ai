"""S5 第四批 · llm_chat + embedding + text_extract + text_split (2026-06-07)

llm_chat / embedding 跑 mock endpoint 子 HTTP 服务 · 不依赖外部
"""
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
         env_extra: Optional[dict] = None, timeout: int = 15) -> dict:
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
# Mock LLM HTTP server (用于 llm_chat / embedding 离线测试)
# ══════════════════════════════════════════════════════════════
_mock_server = None
_mock_port = 0
_mock_calls = []


class _MockHandler(BaseHTTPRequestHandler):
    def log_message(self, *_a, **_k):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        _mock_calls.append({"path": self.path, "body": body})

        # 路径模拟失败
        if "/fail" in self.path:
            self.send_response(503)
            self.end_headers()
            self.wfile.write(b'{"error":"server unavailable"}')
            return

        if "embeddings" in self.path:
            inputs = body.get("input") or []
            data = [{"embedding": [float(i % 5), 0.5, -0.5, 1.0]} for i in range(len(inputs))]
            resp = {"data": data, "model": body.get("model")}
        else:
            # chat
            msgs = body.get("messages") or []
            last = msgs[-1]["content"] if msgs else ""
            resp = {
                "choices": [{
                    "message": {"role": "assistant", "content": f"echo: {last[:50]}"},
                    "finish_reason": "stop",
                }],
                "usage": {
                    "prompt_tokens": len(last.split()),
                    "completion_tokens": 5,
                    "total_tokens": len(last.split()) + 5,
                },
                "model": body.get("model"),
            }
        data_b = json.dumps(resp).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data_b)))
        self.end_headers()
        self.wfile.write(data_b)


@pytest.fixture(scope="module", autouse=True)
def _mock_http():
    global _mock_server, _mock_port
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    _mock_port = sock.getsockname()[1]
    sock.close()
    _mock_server = HTTPServer(("127.0.0.1", _mock_port), _MockHandler)
    th = threading.Thread(target=_mock_server.serve_forever, daemon=True)
    th.start()
    time.sleep(0.05)
    yield
    _mock_server.shutdown()


def _mock_url(path: str = "/api/v1/chat/completions") -> str:
    return f"http://127.0.0.1:{_mock_port}{path}"


# ══════════════════════════════════════════════════════════════
# llm_chat
# ══════════════════════════════════════════════════════════════

def test_llm_single_prompt():
    out = _run("llm_chat", "Hello",
               params={"endpoint": _mock_url(), "retry": 0, "timeout": 5})
    assert out["status"] == "ok"
    assert "echo: Hello" in out["result_text"]
    assert out["summary"]["calls_total"] == 1
    assert out["summary"]["calls_ok"] == 1


def test_llm_batch_prompts():
    out = _run("llm_chat", "",
               params={"endpoint": _mock_url(), "retry": 0,
                       "prompts": ["你好", "再见", "谢谢"]})
    assert out["status"] == "ok"
    assert out["summary"]["calls_ok"] == 3
    assert len(out["results"]) == 3


def test_llm_fallback_endpoint():
    """主 endpoint 失败 · 切到备 endpoint"""
    out = _run("llm_chat", "test",
               params={
                   "endpoints": [_mock_url("/fail/chat"), _mock_url()],
                   "retry": 0, "timeout": 5,
               })
    assert out["status"] == "ok"
    # 应使用第二个 endpoint
    assert out["results"][0]["endpoint"].endswith("/chat/completions")


def test_llm_messages_multi_turn():
    msgs = [
        {"role": "system", "content": "你是助手"},
        {"role": "user", "content": "1"},
        {"role": "assistant", "content": "1"},
        {"role": "user", "content": "继续"},
    ]
    out = _run("llm_chat", "",
               params={"endpoint": _mock_url(), "messages": msgs, "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["calls_total"] == 1
    assert "echo: 继续" in out["result_text"]


def test_llm_cost_estimate():
    out = _run("llm_chat", "hello world test prompt",
               params={"endpoint": _mock_url(), "retry": 0,
                       "price_per_1k": {"input": 0.005, "output": 0.015}})
    assert out["status"] == "ok"
    assert out["summary"]["estimated_cost_cny"] is not None
    assert out["summary"]["estimated_cost_cny"] >= 0


def test_llm_no_input_fails():
    out = _run("llm_chat", "", params={"endpoint": _mock_url(), "retry": 0})
    assert out["status"] == "failed"


# ══════════════════════════════════════════════════════════════
# embedding
# ══════════════════════════════════════════════════════════════

def test_embedding_basic():
    out = _run("embedding", "文本一\n文本二\n文本三",
               params={"endpoint": _mock_url("/api/v1/embeddings"), "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["vectors_generated"] == 3
    assert out["summary"]["dimensions"] == 4


def test_embedding_batch_split():
    """5 batch_size · 12 文本 = 3 batches"""
    texts = [f"text-{i}" for i in range(12)]
    out = _run("embedding", "",
               params={"endpoint": _mock_url("/api/v1/embeddings"),
                       "texts": texts, "batch_size": 5, "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["vectors_generated"] == 12


def test_embedding_normalize():
    """归一化后 L2 模 ≈ 1"""
    import math
    out = _run("embedding", "test",
               params={"endpoint": _mock_url("/api/v1/embeddings"),
                       "normalize": True, "retry": 0})
    assert out["status"] == "ok"
    v = out["result_vectors"][0]
    norm = math.sqrt(sum(x * x for x in v))
    assert abs(norm - 1.0) < 1e-5


def test_embedding_similarity_matrix():
    out = _run("embedding", "a\nb\nc",
               params={"endpoint": _mock_url("/api/v1/embeddings"),
                       "compute_similarity": True, "retry": 0})
    assert out["status"] == "ok"
    sim = out["result_similarity"]
    assert len(sim) == 3
    assert len(sim[0]) == 3
    # 对角线 ≈ 1
    for i in range(3):
        assert sim[i][i] > 0.99


def test_embedding_fail_endpoint():
    out = _run("embedding", "test",
               params={"endpoint": _mock_url("/fail/emb"), "retry": 0})
    assert out["status"] == "failed"


# ══════════════════════════════════════════════════════════════
# text_extract
# ══════════════════════════════════════════════════════════════

def test_extract_basic_types():
    text = "联系 alice@example.com 或 13912345678,网站 https://example.com"
    out = _run("text_extract", text)
    assert out["status"] == "ok"
    assert "alice@example.com" in [m["value"] for m in out["result"]["email"]]
    assert "13912345678" in [m["value"] for m in out["result"]["phone"]]


def test_extract_email_tld_strict():
    """email TLD ≥ 2 字符 · 防误匹配"""
    text = "假邮箱 a@b.c 真邮箱 alice@x.io"
    out = _run("text_extract", text)
    emails = [m["value"] for m in out["result"].get("email", [])]
    assert "alice@x.io" in emails
    assert "a@b.c" not in emails


def test_extract_credit_card_luhn():
    """Luhn 校验过滤非法卡号"""
    text = "合法 4532015112830366,非法 1234567812345678"
    out = _run("text_extract", text)
    cards = [m["value"] for m in out["result"].get("credit_card", [])]
    # 4532...0366 是有效的 Luhn 测试卡号
    assert any("4532" in c for c in cards)
    # 1234...5678 Luhn 不过
    assert not any(c == "1234567812345678" for c in cards)


def test_extract_ipv4_strict():
    """严格 IPv4 段 0-255"""
    text = "好 192.168.1.1 不合法 999.999.999.999"
    out = _run("text_extract", text, params={"types": ["ipv4"]})
    ips = [m["value"] for m in out["result"].get("ipv4", [])]
    assert "192.168.1.1" in ips
    assert "999.999.999.999" not in ips


def test_extract_mask_output():
    text = "手机 13912345678 邮箱 alice@example.com"
    out = _run("text_extract", text, params={"mask_output": True})
    assert out["status"] == "ok"
    assert "masked_text" in out
    assert "13912345678" not in out["masked_text"]
    assert "alice@example.com" not in out["masked_text"]


def test_extract_filter_types():
    text = "alice@x.com 13912345678"
    out = _run("text_extract", text, params={"types": ["email"]})
    assert "email" in out["result"]
    assert "phone" not in out["result"]


def test_extract_location_metadata():
    text = "first line\nemail at line2 alice@x.io"
    out = _run("text_extract", text)
    emails = out["result"].get("email", [])
    assert emails[0]["line"] == 2
    assert emails[0]["start"] > 0


# ══════════════════════════════════════════════════════════════
# text_split
# ══════════════════════════════════════════════════════════════

def test_split_sentence():
    text = "第一句。第二句!第三句?最后一句."
    out = _run("text_split", text, params={"mode": "sentence"})
    assert out["status"] == "ok"
    assert out["summary"]["chunks"] == 4


def test_split_paragraph():
    text = "段落一\n\n段落二\n\n段落三"
    out = _run("text_split", text, params={"mode": "paragraph"})
    assert out["summary"]["chunks"] == 3


def test_split_chars_with_count():
    text = "a" * 100
    out = _run("text_split", text, params={"mode": "chars", "count": 25})
    assert out["summary"]["chunks"] == 4


def test_split_lines_with_count():
    text = "\n".join(str(i) for i in range(20))
    out = _run("text_split", text, params={"mode": "lines", "count": 5})
    assert out["summary"]["chunks"] == 4


def test_split_rag_overlap():
    """RAG 模式 · chunk_size=50 overlap=10 · 验证重叠"""
    text = "abcdefghij" * 20  # 200 字符
    out = _run("text_split", text,
               params={"mode": "rag", "chunk_size": 50, "overlap": 10})
    assert out["status"] == "ok"
    chunks = out["result_chunks"]
    assert len(chunks) >= 4
    # 第二块起点 < 第一块终点(有 overlap)
    assert chunks[1]["start"] < chunks[0]["end"]


def test_split_tokens_mode():
    """tokens 模式 · 句子聚合到目标 token"""
    text = "第一句。第二句。第三句。" * 10
    out = _run("text_split", text,
               params={"mode": "tokens", "target_tokens": 30})
    assert out["status"] == "ok"
    chunks = out["result_chunks"]
    assert len(chunks) >= 2
    for c in chunks:
        # 不应远超 target
        assert c["tokens_estimated"] <= 60


def test_split_unknown_mode_fails():
    out = _run("text_split", "x", params={"mode": "unknown"})
    assert out["status"] == "failed"


def test_split_chunk_id_assigned():
    """每块都带 chunk_id"""
    out = _run("text_split", "a。b。c.", params={"mode": "sentence"})
    chunks = out["result_chunks"]
    for i, c in enumerate(chunks):
        assert c["chunk_id"] == i
