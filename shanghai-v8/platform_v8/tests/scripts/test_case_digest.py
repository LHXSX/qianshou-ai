"""律所垂直 · case_digest(智能阅卷)单测 (2026-06-10)"""
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
openpyxl = pytest.importorskip("openpyxl")


def _run(script: str, stdin: str = "", params: Optional[dict] = None,
         env_extra: Optional[dict] = None, timeout: int = 25) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run([sys.executable, str(SCRIPTS_DIR / (script + ".py"))],
                          input=stdin, text=True, capture_output=True, env=env, timeout=timeout)
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"{script} no stdout · stderr={proc.stderr[:500]}")
    return json.loads(out.split("\n")[-1])


# ── Mock LLM:map 阶段返 tags/events/evidence;reduce 阶段返 summary/disputes ──
_port = 0
_server: Optional[HTTPServer] = None


class _Mock(BaseHTTPRequestHandler):
    def log_message(self, *_a, **_k):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        sysmsg = next((m["content"] for m in body.get("messages", []) if m["role"] == "system"), "")
        user = next((m["content"] for m in body.get("messages", []) if m["role"] == "user"), "")
        if "阅卷" in sysmsg and "正在阅卷" in sysmsg:
            # MAP 阶段
            tags = {}
            if "借款金额" in sysmsg:
                tags["借款金额"] = "50万元" if "50万" in user else ""
                tags["借款人"] = "张三" if "张三" in user else ""
            ans = json.dumps({
                "tags": tags,
                "events": [{"date": "2025-03-01", "desc": "签订借款协议", "page": "3"}] if "借款" in user else [],
                "evidence": [{"name": "借条", "proves": "借贷关系成立", "page": "5"}] if "借条" in user else [],
            }, ensure_ascii=False)
        else:
            # REDUCE 阶段
            ans = json.dumps({
                "case_summary": "原告张三诉被告李四民间借贷纠纷,借款50万未还。",
                "disputes": ["是否实际交付借款", "利息约定是否有效"],
                "plaintiff_claims": ["返还本金50万"],
                "defendant_claims": ["未实际收到借款"],
                "risk_notes": ["缺银行流水佐证交付"],
            }, ensure_ascii=False)
        resp = {"choices": [{"message": {"content": ans}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 80, "completion_tokens": 40}}
        data = json.dumps(resp).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@pytest.fixture(scope="module", autouse=True)
def _mock():
    global _port, _server
    s = socket.socket(); s.bind(("127.0.0.1", 0)); _port = s.getsockname()[1]; s.close()
    _server = HTTPServer(("127.0.0.1", _port), _Mock)
    threading.Thread(target=_server.serve_forever, daemon=True).start()
    time.sleep(0.05)
    yield
    _server.shutdown()


def _url():
    return f"http://127.0.0.1:{_port}/api/v1/chat/completions"


_CASE = "【第3页】2025年3月1日张三与李四签订借款协议,借款50万元。【第5页】借条一张为证。"


def test_digest_custom_tags():
    """自定义标签 → AI 照抽"""
    out = _run("case_digest", json.dumps({"text": _CASE}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False,
                       "tags": ["借款金额", "借款人"]})
    assert out["status"] == "ok"
    assert out["digest"]["tags"]["借款金额"] == "50万元"
    assert out["digest"]["tags"]["借款人"] == "张三"
    assert out["summary"]["tags"] == ["借款金额", "借款人"]


def test_digest_case_type_default_tags():
    """不给 tags · 用 case_type 默认标签"""
    out = _run("case_digest", json.dumps({"text": _CASE}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False,
                       "case_type": "借贷纠纷"})
    assert out["status"] == "ok"
    assert "借款金额" in out["summary"]["tags"]


def test_digest_timeline_and_evidence():
    out = _run("case_digest", json.dumps({"text": _CASE}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False,
                       "tags": ["借款金额"]})
    assert out["status"] == "ok"
    assert out["summary"]["events_found"] >= 1
    assert out["summary"]["evidence_found"] >= 1
    # 页码定位
    ev = out["digest"]["timeline"][0]
    assert ev.get("page")


def test_digest_reduce_summary():
    out = _run("case_digest", json.dumps({"text": _CASE}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False,
                       "tags": ["借款金额"]})
    assert out["digest"]["case_summary"]
    assert len(out["digest"]["disputes"]) >= 1
    assert out["digest"]["plaintiff_claims"]


def test_digest_mapreduce_multichunk():
    """大文本 → 多块 map-reduce · 标签跨块合并"""
    big = _CASE + ("\n其他卷宗内容。" * 800)  # 撑大触发分块
    out = _run("case_digest", json.dumps({"text": big}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False,
                       "tags": ["借款金额"], "chunk_chars": 2000})
    assert out["status"] == "ok"
    assert out["summary"]["chunks_processed"] >= 2
    assert out["digest"]["tags"]["借款金额"] == "50万元"


def test_digest_emit_excel(tmp_path):
    out = _run("case_digest", json.dumps({"text": _CASE}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": True, "tags": ["借款金额"]},
               env_extra={"EC_OUTPUT_DIR": str(tmp_path)})
    assert out["status"] == "ok"
    assert (tmp_path / "阅卷报告.xlsx").exists()
    wb = openpyxl.load_workbook(tmp_path / "阅卷报告.xlsx")
    assert "案件概要" in wb.sheetnames
    assert "事实时间线" in wb.sheetnames
    assert "证据清单" in wb.sheetnames


def test_digest_handwriting_review_flag():
    """疑似手写(待核)标记被计数"""
    out = _run("case_digest", json.dumps({"text": "【第1页】当事人王五(待核),争议金额不清。"}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False,
                       "tags": ["当事人"]})
    # mock 不一定返待核 · 这里只验证字段存在且不崩
    assert out["status"] == "ok"
    assert "review_flags" in out["summary"]


def test_digest_compose_excel_export(tmp_path):
    """case_digest 的 excel_payload 可喂 excel_export"""
    dg = _run("case_digest", json.dumps({"text": _CASE}),
              params={"endpoint": _url(), "retry": 0, "emit_excel": False, "tags": ["借款金额"]})
    exp = _run("excel_export", json.dumps(dg["excel_payload"]),
               env_extra={"EC_OUTPUT_DIR": str(tmp_path)})
    assert exp["status"] == "ok"
    assert (tmp_path / "阅卷报告.xlsx").exists()


def test_digest_no_input_fails():
    out = _run("case_digest", "", params={"endpoint": _url(), "emit_excel": False})
    assert out["status"] == "failed"


# ── OCR → 阅卷 衔接契约(防回归)──────────────────────────────
def test_ocr_digest_page_marker_contract():
    """ocr_image 产出的【第N页:文件名】必须能被 case_digest 解析(否则页码定位断)"""
    import importlib.util
    spec = importlib.util.spec_from_file_location("cd", SCRIPTS_DIR / "case_digest.py")
    cd = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(cd)
    cases = {
        "【第3页:卷一_p3.jpg】内容": "3",     # ocr_image 实际输出格式
        "【第 7 页】内容": "7",
        "===PAGE 12=== 内容": "12",
        "【第5页】内容": "5",
    }
    for text, expect in cases.items():
        m = cd._PAGE_RE.search(text)
        page = next((g for g in m.groups() if g), None) if m else None
        assert page == expect, f"页码解析失败: {text} → {page}(期望 {expect})"


def test_ocr_image_no_input_fails():
    out = _run("ocr_image", "", params={})
    assert out["status"] == "failed"


# ── 前端表单契约:字符串形参数(tags 逗号分隔 / modules 单选)必须能跑通 ──
def test_form_string_tags_and_modules():
    """企业端 Setup 表单传来的是字符串:tags='借款金额,担保方式' modules='timeline'
    必须正确解析(否则行业方案点进去填的标签全失效)"""
    out = _run("case_digest", json.dumps({"text": _CASE}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False,
                       "tags": "借款金额, 借款人", "modules": "timeline"})
    assert out["status"] == "ok"
    # 逗号分隔字符串 → 两个标签
    assert out["summary"]["tags"] == ["借款金额", "借款人"]
    assert out["digest"]["tags"]["借款金额"] == "50万元"
    # modules='timeline' → 含时间线,且不报错
    assert isinstance(out["digest"]["timeline"], list)
