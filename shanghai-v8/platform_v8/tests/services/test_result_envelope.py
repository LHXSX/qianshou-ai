"""result_envelope · 三种 shapes（JSON / 纯文本 / 空）的读路径契约。

对应真实故障：workload 1fd84b88-613f-4673-8091-6d9e8c8938ff 的分片
output_ref 是 75 字纯文本，聚合层认不出 → 落库成
{'results':[],'result_text':''} 空壳 → 读取端读到空白。
"""
from __future__ import annotations

import json

import pytest

from platform_v8.services.result_envelope import (
    ENVELOPE_SCHEMA_VERSION,
    is_empty_result_shell,
    normalize_result_envelope,
    plain_text_body,
    reconcile_with_shard_texts,
    wrap_plain_shard_result,
)

# 复现样本的原文（75 字符）
SAMPLE = '我无法从当前可用工具中读取到确切的主机名（只知运行环境为 Windows、用户目录为 `C:\\Users\\qianshou`），并且已确认收到该任务。'
# 样本 workload 落库的那个空壳
SHELL = json.dumps({
    "status": "ok",
    "schema_version": "v1",
    "task_type": "llm_chat",
    "summary": {},
    "results": [],
    "pages": [],
    "result_text": "",
    "summary_text": "合并 1 个分片 · 共 0 条记录",
}, ensure_ascii=False)

JSON_BODY = json.dumps({
    "status": "ok",
    "schema_version": "v1",
    "task_type": "hash_batch",
    "results": [{"hash": "abc", "input": "line"}],
    "result_text": "abc\tline",
}, ensure_ascii=False)


# ── 形状判定 ────────────────────────────────────────────────
def test_sample_is_75_chars():
    """样本原文长度固定为 75，后面所有断言都以它为据。"""
    assert len(SAMPLE) == 75


@pytest.mark.parametrize("blank", ["", "   ", "\n\t", None, 42])
def test_plain_text_body_rejects_blank_and_non_str(blank):
    assert plain_text_body(blank) is None


def test_plain_text_body_accepts_only_non_json():
    assert plain_text_body(SAMPLE) == SAMPLE
    assert plain_text_body(" " + SAMPLE + " ") == SAMPLE
    assert plain_text_body(JSON_BODY) is None
    assert plain_text_body("42") is None
    assert plain_text_body('"quoted"') is None


# ── JSON 形状：必须逐字节不变（最重要回归面）─────────────────
def test_json_is_returned_byte_identical_and_same_object():
    out = normalize_result_envelope(JSON_BODY)
    assert out == JSON_BODY
    assert out.encode("utf-8") == JSON_BODY.encode("utf-8")
    assert out is JSON_BODY            # 不 re-dump，直接原对象返回
    assert not is_empty_result_shell(JSON_BODY)


# ── 纯文本形状：包装成合法信封，原文一字不改 ─────────────────
def test_plain_text_wrapped_into_envelope_keeps_text_verbatim():
    out = normalize_result_envelope(SAMPLE)
    assert isinstance(out, str)
    data = json.loads(out)
    assert data["result_text"] == SAMPLE
    assert data["results"] == [{"answer": SAMPLE}]
    assert data["status"] == "ok"
    assert data["schema_version"] == ENVELOPE_SCHEMA_VERSION
    # 原文逐字符保留。注意 out 是 JSON 文本：Windows 路径里的反斜杠会被
    # JSON 规则转义成 \\，所以不能拿原文直接做子串匹配，要看「解出来」的值。
    assert data["result_text"] == SAMPLE
    assert len(data["result_text"]) == 75
    # 信封里确实存在这段文本的 JSON 转义形式
    assert json.dumps(SAMPLE, ensure_ascii=False)[1:-1] in out


def test_aggregator_wrapper_maps_plain_text_and_ignores_others():
    wrapped = wrap_plain_shard_result(SAMPLE)
    assert isinstance(wrapped, dict)
    assert wrapped["result_text"] == SAMPLE
    assert wrapped["shard_text"] == SAMPLE
    # 非纯文本一律 None，调用方保持原有分支
    assert wrap_plain_shard_result(JSON_BODY) is None
    assert wrap_plain_shard_result("") is None
    assert wrap_plain_shard_result(None) is None


# ── 空形状：保持空，不凭空造内容 ─────────────────────────────
@pytest.mark.parametrize("blank", ["", "   "])
def test_empty_stays_empty(blank):
    assert normalize_result_envelope(blank) == blank
    assert not is_empty_result_shell(blank)
    assert reconcile_with_shard_texts(blank, []) == blank


def test_empty_shell_needs_shard_text_to_become_non_empty():
    """空壳本身没有正文；只有分片文本才能救活它。"""
    assert is_empty_result_shell(SHELL)
    assert reconcile_with_shard_texts(SHELL, []) == SHELL        # 无分片 → 原样
    assert reconcile_with_shard_texts(SHELL, ["", "  "]) == SHELL


# ── 调和：空壳 → 分片正文（本次故障的实际修复点）──────────────
def test_sample_shell_yields_the_75_char_text():
    reconciled = reconcile_with_shard_texts(SHELL, [normalize_result_envelope(SAMPLE)])
    assert reconciled != SHELL
    data = json.loads(reconciled)
    assert data["result_text"] == SAMPLE
    assert len(data["result_text"]) == 75


# ── 不许误伤：有内容 / 有 URL / artifact 都不算空壳 ───────────
@pytest.mark.parametrize("raw", [
    JSON_BODY,
    json.dumps({"status": "ok", "result_text": "X"}, ensure_ascii=False),
    json.dumps({"status": "ok", "text": "X"}, ensure_ascii=False),
    json.dumps({"status": "ok", "results": [{"a": 1}]}, ensure_ascii=False),
    json.dumps({"status": "ok", "download_url": "http://x/y.zip"}, ensure_ascii=False),
    json.dumps({"status": "ok", "preview_urls": ["http://x/a.jpg"]}, ensure_ascii=False),
    json.dumps({"status": "ok", "stats": {"n": 1}}, ensure_ascii=False),
    json.dumps({"status": "ok", "result_lines": ["a"]}, ensure_ascii=False),
    json.dumps({"schema": "artifact.v1", "object_key": "v8/account-1/a"}, ensure_ascii=False),
    SAMPLE,          # 纯文本在归一之后不会再是纯文本；保守不动
])
def test_not_treated_as_empty_shell(raw):
    assert not is_empty_result_shell(raw)
    assert reconcile_with_shard_texts(raw, ["shard-text"]) == raw


def test_manifest_with_only_download_url_is_not_clobbered():
    """media/zip 任务只有 URL 没有正文，不能被当空壳改写。"""
    manifest = json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "download_url": "http://192.168.2.215:8000/api/v8/oss/local/download/v8/account-1/r.zip",
        "summary": {"download_kind": "zip", "total_files": 1},
    }, ensure_ascii=False)
    assert not is_empty_result_shell(manifest)
    assert reconcile_with_shard_texts(manifest, ["oops"]) == manifest
