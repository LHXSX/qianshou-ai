"""律所垂直 · contract_review + excel_export 单测 (2026-06-10)"""
from __future__ import annotations
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import Optional

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"

openpyxl = pytest.importorskip("openpyxl")


def _run(script: str, stdin: str = "", params: Optional[dict] = None,
         env_extra: Optional[dict] = None, timeout: int = 20) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    if env_extra:
        env.update(env_extra)
    proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / (script + ".py"))],
        input=stdin, text=True, capture_output=True, env=env, timeout=timeout,
    )
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"{script} no stdout · stderr={proc.stderr[:500]}")
    return json.loads(out.split("\n")[-1])


# ══════════════════════════════════════════════════════════════
# excel_export
# ══════════════════════════════════════════════════════════════

def test_excel_columns_rows(tmp_path):
    out = _run("excel_export",
               json.dumps({"columns": ["姓名", "年龄"], "rows": [["张三", 30], ["李四", 25]]}),
               params={"filename": "t.xlsx"},
               env_extra={"EC_OUTPUT_DIR": str(tmp_path)})
    assert out["status"] == "ok"
    assert out["summary"]["total_rows"] == 2
    assert out["summary"]["sheets"] == 1
    assert (tmp_path / "t.xlsx").exists()
    # 真能被 openpyxl 打开
    wb = openpyxl.load_workbook(tmp_path / "t.xlsx")
    ws = wb.active
    assert ws.cell(row=1, column=1).value == "姓名"


def test_excel_records_infer_columns(tmp_path):
    out = _run("excel_export",
               json.dumps({"records": [{"a": 1, "b": 2}, {"a": 3, "c": 4}]}),
               env_extra={"EC_OUTPUT_DIR": str(tmp_path)})
    assert out["status"] == "ok"
    # 列 = a,b,c 并集
    assert out["summary"]["total_rows"] == 2


def test_excel_multi_sheet(tmp_path):
    payload = {"sheets": [
        {"name": "表一", "columns": ["x"], "rows": [["1"], ["2"]]},
        {"name": "表二", "records": [{"k": "v"}]},
    ]}
    out = _run("excel_export", json.dumps(payload),
               env_extra={"EC_OUTPUT_DIR": str(tmp_path)})
    assert out["status"] == "ok"
    assert out["summary"]["sheets"] == 2
    assert out["summary"]["sheet_names"] == ["表一", "表二"]


def test_excel_base64_roundtrip(tmp_path):
    import base64, io
    out = _run("excel_export",
               json.dumps({"columns": ["a"], "rows": [["x"]]}),
               env_extra={"EC_OUTPUT_DIR": str(tmp_path)})
    assert "result_file_base64" in out
    raw = base64.b64decode(out["result_file_base64"])
    wb = openpyxl.load_workbook(io.BytesIO(raw))  # base64 是真 xlsx
    assert wb.active.cell(row=1, column=1).value == "a"


def test_excel_no_data_fails():
    out = _run("excel_export", json.dumps({}))
    assert out["status"] == "failed"


# ══════════════════════════════════════════════════════════════
# Mock LLM(返合同要素+风险 JSON)
# ══════════════════════════════════════════════════════════════
_port = 0
_server: Optional[HTTPServer] = None


class _Mock(BaseHTTPRequestHandler):
    def log_message(self, *_a, **_k):
        pass

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(n).decode("utf-8")) if n else {}
        user = next((m["content"] for m in body.get("messages", []) if m["role"] == "user"), "")
        # 根据合同文本里有没有"违约"决定是否返违约条款(测规则补漏)
        has_breach = "违约" in user
        elements = {
            "contract_title": "技术服务合同",
            "party_a": "甲方科技有限公司",
            "party_b": "乙方网络有限公司",
            "subject_matter": "软件开发服务",
            "amount": "人民币 50 万元",
            "payment_terms": "分三期支付",
            "performance_period": "2026-01 至 2026-12",
            "liability_breach": "按合同总额 10% 承担违约金" if has_breach else "未约定",
            "dispute_resolution": "提交沈阳仲裁委",
            "termination": "未约定",
            "confidentiality": "双方保密 3 年",
            "effective_condition": "签字盖章生效",
            "sign_date": "2026-01-15",
        }
        risks = [{"clause": "争议解决", "level": "low", "issue": "仲裁地较远", "suggestion": "可约定本地"}]
        ans = json.dumps({"elements": elements, "risks": risks}, ensure_ascii=False)
        resp = {"choices": [{"message": {"content": ans}, "finish_reason": "stop"}],
                "usage": {"prompt_tokens": 100, "completion_tokens": 50}}
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


# ══════════════════════════════════════════════════════════════
# contract_review
# ══════════════════════════════════════════════════════════════

def test_contract_basic_extraction():
    out = _run("contract_review",
               json.dumps({"text": "本合同由甲方与乙方签订,含违约责任条款。"}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False})
    assert out["status"] == "ok"
    r = out["results"][0]
    assert r["elements"]["party_a"] == "甲方科技有限公司"
    assert r["elements"]["amount"] == "人民币 50 万元"
    assert "review_score" in r


def test_contract_rule_based_missing_clause():
    """合同文本没'违约' → mock 返 liability_breach=未约定 → 规则补高风险"""
    out = _run("contract_review",
               json.dumps({"text": "本合同由甲方与乙方签订,标的为软件开发。"}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False})
    assert out["status"] == "ok"
    r = out["results"][0]
    clauses = [x["clause"] for x in r["risks"]]
    # 违约责任缺失应被规则识别为高风险
    assert "违约责任" in clauses
    # termination 未约定也应补(medium)
    assert "解除/终止" in clauses
    assert out["summary"]["total_high_risks"] >= 1


def test_contract_multi_and_excel_payload():
    out = _run("contract_review", "",
               params={"endpoint": _url(), "retry": 0, "emit_excel": False,
                       "contracts": [
                           {"name": "合同A.pdf", "text": "甲方乙方违约责任齐全的合同正文" * 3},
                           {"name": "合同B.pdf", "text": "缺条款的简单合同正文" * 3},
                       ]})
    assert out["status"] == "ok"
    assert out["summary"]["contracts_total"] == 2
    # excel_payload 三 sheet
    names = [s["name"] for s in out["excel_payload"]["sheets"]]
    assert names == ["审查汇总", "风险清单", "合同要素"]


def test_contract_emit_excel_file(tmp_path):
    out = _run("contract_review",
               json.dumps({"contracts": [{"name": "c.pdf", "text": "甲方乙方违约责任合同" * 3}]}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": True},
               env_extra={"EC_OUTPUT_DIR": str(tmp_path)})
    assert out["status"] == "ok"
    assert out["summary"]["excel_path"]
    assert (tmp_path / "合同审查报告.xlsx").exists()
    wb = openpyxl.load_workbook(tmp_path / "合同审查报告.xlsx")
    assert "审查汇总" in wb.sheetnames
    assert "风险清单" in wb.sheetnames
    assert "合同要素" in wb.sheetnames


def test_contract_excel_pipeline_compose(tmp_path):
    """contract_review 的 excel_payload 能直接喂 excel_export(可组合验证)"""
    rev = _run("contract_review",
               json.dumps({"text": "甲方乙方违约责任合同正文" * 3}),
               params={"endpoint": _url(), "retry": 0, "emit_excel": False})
    payload = rev["excel_payload"]
    exp = _run("excel_export", json.dumps(payload),
               env_extra={"EC_OUTPUT_DIR": str(tmp_path)})
    assert exp["status"] == "ok"
    assert exp["summary"]["sheets"] == 3
    assert (tmp_path / "合同审查报告.xlsx").exists()


def test_contract_no_input_fails():
    out = _run("contract_review", "", params={"endpoint": _url(), "emit_excel": False})
    assert out["status"] == "failed"
