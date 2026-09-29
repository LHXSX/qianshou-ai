"""S5 第三批 · csv_to_json + llm_summarize 单测 (2026-06-07)
pdf_ocr 需 PaddleOCR 1.5G 模型 · 仅做错误回路测
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def _run(
    script_name: str,
    stdin: str = "",
    params: Optional[dict] = None,
    env_extra: Optional[dict[str, str]] = None,
) -> dict:
    """script_name 不含 .py 后缀 · 自动加"""
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    if env_extra:
        env.update(env_extra)
    script_path = SCRIPTS_DIR / (script_name if script_name.endswith(".py") else script_name + ".py")
    proc = subprocess.run(
        [sys.executable, str(script_path)],
        input=stdin, text=True, capture_output=True, env=env, timeout=15,
    )
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"{script_name} no stdout · stderr={proc.stderr[:500]} rc={proc.returncode}")
    return json.loads(out.split("\n")[-1])


# ══════════════════════════════════════════════════════════════
# csv_to_json
# ══════════════════════════════════════════════════════════════

def test_csv_basic_with_types():
    """带表头 · 自动类型推断"""
    csv_text = "name,age,score,active\nAlice,30,95.5,true\nBob,25,80,false\n"
    out = _run("csv_to_json", csv_text)
    assert out["status"] == "ok"
    assert out["summary"]["row_count"] == 2
    assert out["summary"]["columns"] == ["name", "age", "score", "active"]
    # 类型推断
    preview = out["summary"]["preview"]
    assert preview[0]["age"] == 30
    assert preview[0]["score"] == 95.5
    assert preview[0]["active"] is True
    assert "result.jsonl" in out["result_files_b64"]


def test_csv_tab_separator():
    """TAB 分隔自动识别"""
    csv_text = "a\tb\tc\n1\t2\t3\n4\t5\t6\n"
    out = _run("csv_to_json", csv_text)
    assert out["status"] == "ok"
    assert out["summary"]["delimiter"] == "\t"
    assert out["summary"]["row_count"] == 2


def test_csv_max_rows_truncate():
    """超 max_rows · truncated 标记"""
    lines = ["x,y"]
    for i in range(50):
        lines.append(f"{i},{i*2}")
    csv_text = "\n".join(lines)
    out = _run("csv_to_json", csv_text, params={"max_rows": 10})
    assert out["status"] == "ok"
    assert out["summary"]["row_count"] == 10
    assert out["summary"]["truncated"] is True


def test_csv_skip_comments():
    csv_text = "# 头部注释\nname,age\n# 另一注释\nAlice,30\nBob,25\n"
    out = _run("csv_to_json", csv_text)
    assert out["status"] == "ok"
    assert out["summary"]["row_count"] == 2


def test_csv_bom_removed():
    """UTF-8 BOM 自动去除"""
    csv_with_bom = "\ufeffname,age\nAlice,30\n"
    out = _run("csv_to_json", csv_with_bom)
    assert out["status"] == "ok"
    # 列名首字符不含 \ufeff
    assert out["summary"]["columns"] == ["name", "age"]


def test_csv_json_array_format():
    csv_text = "k,v\nA,1\nB,2\n"
    out = _run("csv_to_json", csv_text, params={"output_format": "json_array"})
    assert out["status"] == "ok"
    assert "result_array" in out
    assert isinstance(out["result_array"], list)
    assert out["result_array"][0]["k"] == "A"


def test_csv_include_lines_false():
    csv_text = "a,b\n1,2\n"
    out = _run("csv_to_json", csv_text, params={"include_lines": False})
    assert out["status"] == "ok"
    assert "result_lines" not in out
    assert "result_array" not in out
    # summary 仍有 preview
    assert out["summary"]["preview"][0]["a"] == 1


def test_csv_empty_rows_skipped():
    csv_text = "a,b\n,,\n1,2\n,,\n3,4\n"
    out = _run("csv_to_json", csv_text)
    assert out["status"] == "ok"
    assert out["summary"]["row_count"] == 2  # 空行被跳


def test_csv_multi_file_outputs_downloadable_files(tmp_path):
    (tmp_path / "000-orders.csv").write_text(
        "id,amount\n1,12.5\n2,20\n",
        encoding="utf-8",
    )
    (tmp_path / "001-users.csv").write_text(
        "name,active\nAlice,true\nBob,false\n",
        encoding="utf-8",
    )

    out = _run(
        "csv_to_json",
        params={"output_format": "jsonl"},
        env_extra={
            "EC_INPUT_KIND": "multi_file",
            "EC_INPUT_DIR": str(tmp_path),
        },
    )

    assert out["status"] == "ok"
    assert out["summary"]["file_count"] == 2
    assert out["summary"]["row_count"] == 4
    assert set(out["result_files_b64"]) == {"orders.jsonl", "users.jsonl"}

    import base64
    orders = base64.b64decode(out["result_files_b64"]["orders.jsonl"]).decode("utf-8")
    assert json.loads(orders.splitlines()[0]) == {"id": 1, "amount": 12.5}


# ══════════════════════════════════════════════════════════════
# llm_summarize
# ══════════════════════════════════════════════════════════════

def test_summarize_extractive_basic():
    text = "这是第一句重要内容。这是第二句也很关键。第三句普通。第四句也是普通文字。第五句话题相关。"
    out = _run("llm_summarize", text, params={"max_length": 30, "method": "extractive_tf"})
    assert out["status"] == "ok"
    assert out["summary"]["method"] == "extractive_tf"
    assert len(out["result_text"]) > 0
    assert len(out["result_text"]) <= 30


def test_summarize_lead_n():
    text = "句一。句二。句三。句四。句五。"
    out = _run("llm_summarize", text, params={"method": "lead_n", "lead_n": 2, "max_length": 100})
    assert out["status"] == "ok"
    assert out["summary"]["method"] == "lead_n"
    # lead_2 应该至少包含前两句的内容
    assert "句一" in out["result_text"]
    assert "句二" in out["result_text"]


def test_summarize_textrank_lite():
    text = "关键技术是核心 AI。核心 AI 改变 行业。其他内容不太相关。"
    out = _run("llm_summarize", text, params={"method": "textrank_lite", "max_length": 50})
    assert out["status"] == "ok"
    assert out["summary"]["method"] == "textrank_lite"


def test_summarize_keywords():
    text = "千手 千手 千手 算力 算力 平台 平台 平台 节点"
    out = _run("llm_summarize", text, params={"top_keywords": 3})
    assert out["status"] == "ok"
    kws = out["result_keywords"]
    assert len(kws) <= 3
    # 千手 / 平台 应在 top
    words = [k["word"] for k in kws]
    assert "千" in words or "手" in words or "平" in words or "台" in words


def test_summarize_empty_input():
    out = _run("llm_summarize", "")
    assert out["status"] == "failed"


def test_summarize_english():
    text = "Quick brown fox jumps over the lazy dog. The dog barks loudly. The fox runs away. End of story."
    out = _run("llm_summarize", text, params={"max_length": 80})
    assert out["status"] == "ok"
    assert "result_text" in out


def test_summarize_invalid_method_falls_back():
    out = _run("llm_summarize", "hello world. test sentence.",
               params={"method": "unknown_method"})
    assert out["status"] == "ok"
    assert out["summary"]["method"] == "extractive_tf"  # fallback


# ══════════════════════════════════════════════════════════════
# pdf_ocr · 仅错误回路(完整跑需 PaddleOCR 1.5GB)
# ══════════════════════════════════════════════════════════════

def test_pdf_ocr_no_input():
    out = _run("pdf_ocr", "")
    assert out["status"] == "failed"
    err = out.get("error", "") + out.get("summary_text", "")
    assert "无输入" in err or "PDF" in err
