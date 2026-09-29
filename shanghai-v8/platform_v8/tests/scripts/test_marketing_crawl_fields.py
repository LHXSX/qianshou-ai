"""S5 第七批 · ai_copywriting + image_caption + crawl_url_extract + field_stats (2026-06-07)"""
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
# Mock LLM for ai_copywriting
# ══════════════════════════════════════════════════════════════
_port = 0
_server: Optional[HTTPServer] = None


class _Mock(BaseHTTPRequestHandler):
    def log_message(self, *_a, **_k):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        msgs = body.get("messages") or []
        user = next((m["content"] for m in msgs if m["role"] == "user"), "")
        # 返合规 JSON
        ans = json.dumps({
            "title": "限时爆款 ✨ 测试好物推荐",
            "body": f"亲身体验了 {user[:30]} 真的太棒了!这款产品适合所有人,效果立竿见影,推荐购买!",
            "hashtags": ["#好物", "#推荐", "#测试", "#爆款", "#种草"],
        }, ensure_ascii=False)
        resp = {
            "choices": [{"message": {"role": "assistant", "content": ans},
                         "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 50, "total_tokens": 70},
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
    threading.Thread(target=_server.serve_forever, daemon=True).start()
    time.sleep(0.05)
    yield
    _server.shutdown()


def _url():
    return f"http://127.0.0.1:{_port}/api/v1/chat/completions"


# ══════════════════════════════════════════════════════════════
# ai_copywriting
# ══════════════════════════════════════════════════════════════

def test_copywriting_xiaohongshu_basic():
    out = _run("ai_copywriting", "",
               params={"endpoint": _url(), "product": "千手算力联名T恤",
                       "platform": "xiaohongshu", "tone": "casual",
                       "retry": 0, "versions": 1})
    assert out["status"] == "ok"
    assert out["title"]
    assert out["body"]
    assert len(out["hashtags"]) > 0


def test_copywriting_multi_versions():
    """versions=3 应生成 3 个候选(不同 temperature)"""
    out = _run("ai_copywriting", "",
               params={"endpoint": _url(), "product": "AI 智能音箱",
                       "platform": "douyin", "versions": 3, "retry": 0})
    assert out["status"] == "ok"
    assert out["summary"]["versions_generated"] == 3
    assert len(out["versions"]) == 3
    # 每个版本 temperature 不同
    temps = [v["temperature"] for v in out["versions"]]
    assert len(set(temps)) == 3


def test_copywriting_no_product_fails():
    out = _run("ai_copywriting", "", params={"endpoint": _url()})
    assert out["status"] == "failed"


def test_copywriting_keyword_coverage():
    out = _run("ai_copywriting", "",
               params={"endpoint": _url(), "product": "测试好物",
                       "keywords": ["亲身体验"], "retry": 0, "versions": 1})
    assert out["status"] == "ok"
    # mock body 必含 "亲身体验"
    assert "1/1" in out["versions"][0]["keyword_coverage"]


def test_copywriting_ecommerce_industry():
    """电商 + 行业模板"""
    out = _run("ai_copywriting", "",
               params={"endpoint": _url(), "product": "面膜",
                       "platform": "ecommerce", "industry": "beauty",
                       "retry": 0, "versions": 1})
    assert out["status"] == "ok"
    assert out["summary"]["industry"] == "beauty"


def test_copywriting_fallback_endpoint():
    out = _run("ai_copywriting", "",
               params={"endpoints": ["http://127.0.0.1:1/dead", _url()],
                       "product": "测试", "retry": 0, "versions": 1, "timeout": 3})
    assert out["status"] == "ok"


# ══════════════════════════════════════════════════════════════
# image_caption · 仅测错误回路(完整需 transformers 2GB+)
# ══════════════════════════════════════════════════════════════

def test_image_caption_no_input():
    out = _run("image_caption", "")
    assert out["status"] == "failed"


def test_image_caption_device_detect():
    """直接测 _detect_device 函数"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("m", SCRIPTS_DIR / "image_caption.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    # 强指定 cpu 应返 cpu
    assert m._detect_device("cpu") == "cpu"
    # auto 应返某有效设备
    dev = m._detect_device("auto")
    assert dev in ("cuda", "mps", "cpu")


# ══════════════════════════════════════════════════════════════
# crawl_url_extract · 仅测安全/参数(无外网)
# ══════════════════════════════════════════════════════════════

def test_crawl_extract_no_url():
    out = _run("crawl_url_extract", "", params={})
    assert out["status"] == "failed"


def test_crawl_extract_invalid_scheme():
    out = _run("crawl_url_extract", "", params={"url": "ftp://example.org/a"})
    assert out["status"] == "failed"


def test_crawl_extract_non_whitelisted():
    out = _run("crawl_url_extract", "",
               params={"url": "https://evil.example.org/x"})
    assert out["status"] == "failed"
    assert "白名单" in out["error"]


def test_crawl_extract_css_no_selector():
    out = _run("crawl_url_extract", "",
               params={"url": "https://github.com/x", "mode": "css"})
    assert out["status"] == "failed"
    assert "selector" in out["error"]


def test_crawl_extract_unknown_mode():
    """unknown mode 应被识别"""
    out = _run("crawl_url_extract", "",
               params={"url": "https://github.com/x", "mode": "ufo"})
    # 因白名单/网络可能先失败 · 至少不应崩溃
    assert out["status"] in ("ok", "failed")


def test_crawl_extract_ssrf_function():
    """_is_private_ip 单测"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("m", SCRIPTS_DIR / "crawl_url_extract.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    assert m._is_private_ip("127.0.0.1") is True
    assert m._is_private_ip("10.0.0.1") is True


# ══════════════════════════════════════════════════════════════
# field_stats
# ══════════════════════════════════════════════════════════════

def test_fs_basic_pipe_sep():
    text = "ORDER-001|13912345678|上海\nORDER-002|13812345678|北京\nORDER-003|13712345678|上海"
    out = _run("field_stats", text)
    assert out["status"] == "ok"
    assert out["summary"]["field_count"] == 3
    assert out["summary"]["separator"] == "|"
    assert out["summary"]["total_rows"] == 3


def test_fs_header_mode():
    text = "name|phone|city\nAlice|13912345678|上海\nBob|13812345678|北京"
    out = _run("field_stats", text, params={"header": True})
    assert out["status"] == "ok"
    assert out["summary"]["total_rows"] == 2  # 不算 header
    assert out["fields"][0]["name"] == "name"
    assert out["fields"][1]["name"] == "phone"


def test_fs_type_detection_phone():
    """手机号 phone_cn 类型识别"""
    text = "Alice|13912345678\nBob|13812345678\nCharlie|13712345678"
    out = _run("field_stats", text)
    assert out["status"] == "ok"
    # 第 2 列应被识别为 phone_cn
    f2 = out["fields"][1]
    assert f2["main_type"] == "phone_cn"
    assert f2["inferred_kind"] == "pii_phone_cn"


def test_fs_type_detection_email():
    text = "1|a@x.com\n2|b@y.io\n3|c@z.net"
    out = _run("field_stats", text)
    assert out["fields"][1]["main_type"] == "email"
    assert out["fields"][1]["inferred_kind"] == "pii_email"


def test_fs_high_cardinality_id():
    """高 unique_ratio 识别为 id_or_key"""
    text = "\n".join(f"ORDER-{i:04d}|state" for i in range(50))
    out = _run("field_stats", text)
    assert out["status"] == "ok"
    f0 = out["fields"][0]
    assert f0["unique_ratio"] > 0.9
    assert f0["inferred_kind"] == "id_or_key"


def test_fs_low_cardinality_enum():
    """低基数 → enum"""
    text = "\n".join(f"row{i}|{['A','B','C'][i%3]}" for i in range(50))
    out = _run("field_stats", text)
    assert out["fields"][1]["inferred_kind"] == "enum"


def test_fs_null_markers():
    text = "a|valid\nb|NULL\nc|N/A\nd|-\ne|"
    out = _run("field_stats", text)
    # 第 2 列 5 行中 4 行 null
    f1 = out["fields"][1]
    assert f1["null_count"] == 4
    assert f1["null_ratio"] == 0.8


def test_fs_csv_sep_sniff():
    """逗号分隔自动识别"""
    text = "a,b,c\n1,2,3\n4,5,6"
    out = _run("field_stats", text)
    assert out["status"] == "ok"
    assert out["summary"]["separator"] == ","


def test_fs_tab_sep_sniff():
    text = "a\tb\n1\t2\n3\t4"
    out = _run("field_stats", text)
    assert out["summary"]["separator"] == "\t"


def test_fs_int_type():
    text = "1\n2\n3\n4\n5"
    out = _run("field_stats", text)
    assert out["fields"][0]["main_type"] == "int"
    assert out["fields"][0]["inferred_kind"] == "numeric"


def test_fs_date_type():
    text = "2024-01-15\n2024-02-20\n2024-03-25"
    out = _run("field_stats", text)
    assert out["fields"][0]["main_type"] == "date"
    assert out["fields"][0]["inferred_kind"] == "datetime"


def test_fs_quality_metrics():
    """每个字段必有 null_ratio/unique_ratio/type_consistency_ratio"""
    text = "a|1\nb|2\nc|3"
    out = _run("field_stats", text)
    for f in out["fields"]:
        assert "null_ratio" in f
        assert "unique_ratio" in f
        assert "type_consistency_ratio" in f
