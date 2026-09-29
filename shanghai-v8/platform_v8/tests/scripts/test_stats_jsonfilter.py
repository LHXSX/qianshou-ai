"""S5 第三批 b · statistics_summary + json_filter 单测 (2026-06-07)"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def _run(script_name: str, stdin: str = "", params: Optional[dict] = None,
         env_extra: Optional[dict] = None) -> dict:
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    if env_extra:
        env.update(env_extra)
    script_path = SCRIPTS_DIR / (script_name + ".py")
    proc = subprocess.run(
        [sys.executable, str(script_path)],
        input=stdin, text=True, capture_output=True, env=env, timeout=15,
    )
    out = proc.stdout.strip()
    if not out:
        raise RuntimeError(f"{script_name} no stdout · stderr={proc.stderr[:500]}")
    return json.loads(out.split("\n")[-1])


# ══════════════════════════════════════════════════════════════
# statistics_summary
# ══════════════════════════════════════════════════════════════

def test_stats_plain_numbers():
    out = _run("statistics_summary", "1 2 3 4 5 6 7 8 9 10")
    assert out["status"] == "ok"
    assert out["mode"] == "single_column"
    s = out["summary"]
    assert s["count"] == 10
    assert s["mean"] == 5.5
    assert s["median"] == 5.5


def test_stats_json_data_field():
    out = _run("statistics_summary",
               json.dumps({"data": [10, 20, 30, 40, 50]}))
    assert out["status"] == "ok"
    s = out["summary"]
    assert s["count"] == 5
    assert s["mean"] == 30.0


def test_stats_multi_column_auto():
    """list of dict 自动多列模式"""
    rows = [{"a": 1, "b": 10, "label": "x"},
            {"a": 2, "b": 20, "label": "y"},
            {"a": 3, "b": 30, "label": "z"}]
    out = _run("statistics_summary", json.dumps(rows))
    assert out["status"] == "ok"
    assert out["mode"] == "multi_column"
    assert set(out["summary"].keys()) == {"a", "b"}  # label 非数值列被自动跳
    assert out["summary"]["a"]["count"] == 3
    assert out["summary"]["b"]["mean"] == 20.0


def test_stats_outliers_iqr():
    """IQR 检测异常值"""
    out = _run("statistics_summary",
               json.dumps({"data": [1, 2, 3, 4, 5, 6, 7, 8, 9, 100]}),
               params={"outlier_method": "iqr"})
    assert out["status"] == "ok"
    assert out["summary"]["outliers_count"] >= 1
    assert 100 in out["summary"]["outliers_sample"]


def test_stats_histogram():
    out = _run("statistics_summary",
               "1 2 3 4 5 6 7 8 9 10",
               params={"histogram_bins": 5})
    assert out["status"] == "ok"
    hist = out["summary"]["histogram"]
    assert hist["bins"] == 5
    assert sum(hist["counts"]) == 10


def test_stats_skewness_kurtosis():
    """偏度峰度字段存在"""
    out = _run("statistics_summary", "1 2 3 4 5 6 7 8 9 10")
    assert out["status"] == "ok"
    assert "skewness" in out["summary"]
    assert "kurtosis" in out["summary"]


def test_stats_nan_inf_filtered():
    out = _run("statistics_summary", json.dumps({"data": [1, 2, 3, None, "bad", "Infinity"]}))
    # NaN/inf/None/字符串都被过滤 · 剩 3 个有效
    assert out["status"] == "ok"
    assert out["summary"]["count"] == 3


def test_stats_empty_fails():
    out = _run("statistics_summary", "")
    assert out["status"] == "failed"


# ══════════════════════════════════════════════════════════════
# json_filter
# ══════════════════════════════════════════════════════════════

def test_filter_passthrough_no_filter():
    """无 filter · 透传"""
    lines = '{"a":1}\n{"a":2}\n{"a":3}\n'
    out = _run("json_filter", lines)
    assert out["status"] == "ok"
    assert out["summary"]["matched_rows"] == 3


def test_filter_single_eq():
    """单条件 · 等于"""
    lines = '{"name":"alice","age":30}\n{"name":"bob","age":25}\n'
    out = _run("json_filter", lines,
               params={"filters": [{"key": "name", "op": "==", "value": "alice"}]})
    assert out["status"] == "ok"
    assert out["summary"]["matched_rows"] == 1


def test_filter_multi_and():
    """AND 多条件"""
    lines = ('{"a":1,"b":10}\n{"a":1,"b":20}\n{"a":2,"b":10}\n')
    out = _run("json_filter", lines, params={
        "filters": [
            {"key": "a", "op": "==", "value": 1},
            {"key": "b", "op": "==", "value": 10},
        ],
        "logic": "AND",
    })
    assert out["status"] == "ok"
    assert out["summary"]["matched_rows"] == 1


def test_filter_multi_or():
    lines = '{"x":1}\n{"x":2}\n{"x":3}\n'
    out = _run("json_filter", lines, params={
        "filters": [
            {"key": "x", "op": "==", "value": 1},
            {"key": "x", "op": "==", "value": 3},
        ],
        "logic": "OR",
    })
    assert out["status"] == "ok"
    assert out["summary"]["matched_rows"] == 2


def test_filter_nested_key():
    """nested key user.email"""
    lines = '{"user":{"email":"a@x.com"}}\n{"user":{"email":"b@x.com"}}\n'
    out = _run("json_filter", lines, params={
        "filters": [{"key": "user.email", "op": "==", "value": "a@x.com"}],
    })
    assert out["status"] == "ok"
    assert out["summary"]["matched_rows"] == 1


def test_filter_regex():
    lines = '{"name":"alice"}\n{"name":"bob"}\n{"name":"alex"}\n'
    out = _run("json_filter", lines, params={
        "filters": [{"key": "name", "op": "regex", "value": "^al"}],
    })
    assert out["status"] == "ok"
    assert out["summary"]["matched_rows"] == 2


def test_filter_gt_numeric():
    lines = '{"v":5}\n{"v":10}\n{"v":15}\n'
    out = _run("json_filter", lines, params={
        "filters": [{"key": "v", "op": "gt", "value": 7}],
    })
    assert out["summary"]["matched_rows"] == 2


def test_filter_sort_and_limit():
    lines = '{"v":3}\n{"v":1}\n{"v":2}\n'
    out = _run("json_filter", lines, params={"sort_by": "v", "limit": 2})
    assert out["status"] == "ok"
    parsed = [json.loads(l) for l in out["result_lines"]]
    assert parsed[0]["v"] == 1
    assert parsed[1]["v"] == 2


def test_filter_sort_desc():
    lines = '{"v":3}\n{"v":1}\n{"v":2}\n'
    out = _run("json_filter", lines, params={"sort_by": "-v", "limit": 1})
    parsed = [json.loads(l) for l in out["result_lines"]]
    assert parsed[0]["v"] == 3


def test_filter_project_nested():
    lines = '{"user":{"name":"alice","age":30}}\n'
    out = _run("json_filter", lines, params={"project": ["user.name"]})
    parsed = json.loads(out["result_lines"][0])
    # 投影后顶层是 user.name 的最后一段
    assert parsed == {"name": "alice"}


def test_filter_legacy_env_compat():
    """老 ENV 兼容 · FILTER_KEY/FILTER_OP/FILTER_VALUE"""
    lines = '{"a":"x"}\n{"a":"y"}\n'
    out = _run("json_filter", lines, env_extra={
        "FILTER_KEY": "a", "FILTER_OP": "==", "FILTER_VALUE": "x",
    })
    assert out["summary"]["matched_rows"] == 1


def test_filter_multi_file_json_arrays(tmp_path):
    (tmp_path / "000-first.json").write_text(
        json.dumps([{"v": 1}, {"v": 3}], ensure_ascii=False),
        encoding="utf-8",
    )
    (tmp_path / "001-second.json").write_text(
        json.dumps([{"v": 2}, {"v": 4}], ensure_ascii=False),
        encoding="utf-8",
    )

    out = _run(
        "json_filter",
        params={"filters": [{"key": "v", "op": "gte", "value": 3}]},
        env_extra={
            "EC_INPUT_KIND": "multi_file",
            "EC_INPUT_DIR": str(tmp_path),
        },
    )

    assert out["status"] == "ok"
    assert out["summary"]["input_files"] == 2
    assert out["summary"]["input_rows"] == 4
    assert [json.loads(line)["v"] for line in out["result_lines"]] == [3, 4]


def test_filter_multi_file_jsonl(tmp_path):
    (tmp_path / "000-first.jsonl").write_text(
        '{"name":"alice"}\n{"name":"bob"}\n',
        encoding="utf-8",
    )
    (tmp_path / "001-second.jsonl").write_text(
        '{"name":"amy"}\n',
        encoding="utf-8",
    )

    out = _run(
        "json_filter",
        params={"filters": [{"key": "name", "op": "regex", "value": "^a"}]},
        env_extra={
            "EC_INPUT_KIND": "multi_file",
            "EC_INPUT_DIR": str(tmp_path),
        },
    )

    assert out["summary"]["input_files"] == 2
    assert out["summary"]["matched_rows"] == 2
