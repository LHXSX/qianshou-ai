"""读结果入口对「纯文本 output_ref」的行为（JSON / 纯文本 / 空 三种形状）。

历史故障：workload 1fd84b88-613f-4673-8091-6d9e8c8938ff 的分片
output_ref 是 75 字纯文本；聚合层认不出 → 落库成
{'results':[],'result_text':''} 空壳 → 读取端读到空白/摘要。
"""
from __future__ import annotations

import json

import pytest

from platform_v8.api.v8 import workloads

SAMPLE = '我无法从当前可用工具中读取到确切的主机名（只知运行环境为 Windows、用户目录为 `C:\\Users\\qianshou`），并且已确认收到该任务。'
SHELL = json.dumps({
    "status": "ok", "schema_version": "v1", "task_type": "llm_chat",
    "summary": {}, "results": [], "pages": [], "result_text": "",
    "summary_text": "合并 1 个分片 · 共 0 条记录",
}, ensure_ascii=False)


def test_sample_length_is_75():
    assert len(SAMPLE) == 75


# ── 入口 A · GET /{id}/result 用到的形状归一 ─────────────────
def test_entry_result_normalize_three_shapes():
    # JSON → 逐字节不变
    js = json.dumps({"status": "ok", "results": [{"a": 1}]}, ensure_ascii=False)
    assert workloads._normalize_result_envelope(js) == js
    # 纯文本 → 信封
    env = json.loads(workloads._normalize_result_envelope(SAMPLE))
    assert env["result_text"] == SAMPLE
    assert env["results"] == [{"answer": SAMPLE}]
    # 空 → 原样
    assert workloads._normalize_result_envelope("") == ""


def test_entry_result_shell_is_detected_and_rescued():
    assert workloads._is_empty_result_shell(SHELL) is True
    rescued = workloads._is_empty_result_shell(workloads._normalize_result_envelope(SAMPLE))
    assert rescued is False


# ── 入口 B · GET /{id}/download 取正文（曾因同名双定义 500）──
def test_entry_download_extracts_text_body_from_plain_text():
    raw = workloads._normalize_result_envelope(SAMPLE)
    got = workloads._human_text_from_manifest(raw, "llm_chat", owner_id=1)
    assert got is not None
    body, ext = got
    assert body.rstrip("\n") == SAMPLE
    assert ext == ".txt"


def test_entry_download_accepts_owner_id_keyword():
    """双定义被合并前的回归点：旧代码这里稳定抛 TypeError → /download 500。"""
    raw = json.dumps({"status": "ok", "text": "hello"}, ensure_ascii=False)
    assert workloads._human_text_from_manifest(raw, "pdf_to_text", owner_id=1) == (
        "hello\n", ".txt",
    )


def test_entry_download_json_result_unchanged():
    """既有 JSON 结果的可读正文抽取必须保持原样。"""
    raw = json.dumps({
        "status": "ok",
        "results": [{"hash": "abc", "input": "line"}],
    }, ensure_ascii=False)
    body, ext = workloads._human_text_from_manifest(raw, "hash_batch", owner_id=1)
    assert ext == ".jsonl"
    assert json.loads(body.strip())["hash"] == "abc"


def test_entry_download_empty_result_yields_nothing():
    assert workloads._human_text_from_manifest("", "llm_chat", owner_id=1) is None


# ── 入口 C · 开发者接口共用同一判据 ──────────────────────────
def test_developer_entry_shares_single_predicate():
    from platform_v8.services.result_envelope import (
        is_empty_result_shell as shared_predicate,
    )
    assert workloads._is_empty_result_shell(SHELL) is shared_predicate(SHELL)


def test_wrap_shard_result_used_by_aggregators():
    from platform_v8.services.result_envelope import wrap_plain_shard_result
    wrapped = wrap_plain_shard_result(SAMPLE)
    assert wrapped is not None
    # manifest_only 读 result_text；lines_merge 读 result_lines 回退
    assert wrapped["result_text"] == SAMPLE
    assert wrap_plain_shard_result(json.dumps({"results": []})) is None
    assert wrap_plain_shard_result("") is None
