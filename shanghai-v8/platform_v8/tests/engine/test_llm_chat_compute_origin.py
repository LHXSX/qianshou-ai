"""算力归属 (compute_origin) 标记的回归锁。

背景 (2026-09-18):
    llm_chat 这个「节点任务」节点本身零算力 —— 它的脚本只是用 urllib 打平台
    自己的 /api/v1/chat/completions(默认 https://www.qianshousuanli.com/...),
    由平台云端 LLM 代调; 而 local_llm_chat 才是节点本地出算力(required_software
    含 "local_llm")。注册表里两者此前没有任何字段能区分,导致调度器 / UI / 计费
    看到的都是"节点产出"。

本测试锁住:
  1. TaskTypeSpec 仍带 compute_origin / compute_origin_note 加法字段(默认 "node")
  2. llm_chat 被显式标成 platform_relay
  3. local_llm_chat 明确是 node, 且它与 llm_chat 的 required_software 语义未被改动
  4. 除 llm_chat 外没有别的 task_type 被误标成 platform_relay
  5. 未注册 task_type / DEFAULT_SPEC 回落 "node"
  6. compute_origin_fields() 只新增字段, 不改既有字段

任何一条被删改都会让此文件失败。
"""
from __future__ import annotations

import dataclasses

from platform_v8.engine import task_registry
from platform_v8.engine.task_registry import (
    COMPUTE_ORIGIN_NODE,
    COMPUTE_ORIGIN_PLATFORM_RELAY,
    COMPUTE_ORIGIN_VALUES,
    DEFAULT_SPEC,
    TASK_REGISTRY,
    TaskTypeSpec,
    compute_origin_fields,
    compute_origin_of,
    get_spec,
)


# ── 1. 字段存在性 + 默认值 ─────────────────────────────────────────────

def test_task_spec_still_declares_compute_origin_fields():
    """compute_origin / compute_origin_note 必须还在 (被删 = 本测试失败)。"""
    field_names = {f.name for f in dataclasses.fields(TaskTypeSpec)}
    assert "compute_origin" in field_names, "算力归属标记字段被删了"
    assert "compute_origin_note" in field_names

    origin_field = next(f for f in dataclasses.fields(TaskTypeSpec)
                        if f.name == "compute_origin")
    assert origin_field.default == COMPUTE_ORIGIN_NODE, "默认值必须仍是 node"


def test_compute_origin_vocabulary_is_stable():
    """下游/UI 依赖这两个字面量取值, 不能被改名。"""
    assert COMPUTE_ORIGIN_NODE == "node"
    assert COMPUTE_ORIGIN_PLATFORM_RELAY == "platform_relay"
    assert COMPUTE_ORIGIN_VALUES == ("node", "platform_relay")


def test_default_spec_is_node_origin():
    """未注册 task_type 的兜底 spec 必须仍是"节点出算力"(历史行为)。"""
    assert DEFAULT_SPEC.compute_origin == COMPUTE_ORIGIN_NODE


# ── 2. llm_chat 必须被标成"平台代调" ───────────────────────────────────

def test_llm_chat_is_marked_platform_relay():
    """核心断言: llm_chat = 平台代调, 节点零算力。"""
    spec = get_spec("llm_chat")
    assert spec.compute_origin == COMPUTE_ORIGIN_PLATFORM_RELAY, (
        "llm_chat 又变回未标记状态了 —— 它是平台代调, 必须能一眼区分于 local_llm_chat"
    )
    assert spec.compute_origin_note, "platform_relay 应带人类可读说明"
    assert "平台" in spec.compute_origin_note


def test_llm_chat_routing_and_requirements_unchanged():
    """禁止有人顺手改掉 llm_chat 的路由/依赖 (本次改动只加标记)。"""
    spec = get_spec("llm_chat")
    # 节点只转发 HTTP, 所以不要求任何本地软件; 历史坑: 填了会永远 WAITING
    assert spec.required_software == ()
    assert spec.executor.value == "http"
    assert spec.max_shards_limit == 10
    assert spec.slicer == "prompts_chunked"
    assert spec.aggregator == "manifest_only"


def test_local_llm_chat_is_marked_node_origin():
    """对照组: 节点本机跑模型的任务必须仍是 node + 要求 local_llm。"""
    spec = get_spec("local_llm_chat")
    assert spec.compute_origin == COMPUTE_ORIGIN_NODE
    assert spec.required_software == ("local_llm",)
    assert spec.executor.value == "python3"


def test_platform_relay_is_the_exception_not_the_rule():
    """只有 llm_chat 是平台代调; 其余任务默认 node (防批量误标)。"""
    relays = sorted(t.task_type for t in TASK_REGISTRY.values()
                    if t.compute_origin == COMPUTE_ORIGIN_PLATFORM_RELAY)
    assert relays == ["llm_chat"], f"意外的平台代调任务: {relays}"

    wrong = sorted(t.task_type for t in TASK_REGISTRY.values()
                   if t.compute_origin not in COMPUTE_ORIGIN_VALUES)
    assert wrong == [], f"非法 compute_origin 取值: {wrong}"

    nodes = [t for t in TASK_REGISTRY.values()
             if t.compute_origin == COMPUTE_ORIGIN_NODE]
    assert len(nodes) > 50, "绝大多数任务应仍是节点出算力"


# ── 3. 查询接口 ────────────────────────────────────────────────────────

def test_compute_origin_of_helper_contract():
    assert compute_origin_of("llm_chat") == COMPUTE_ORIGIN_PLATFORM_RELAY
    assert compute_origin_of("local_llm_chat") == COMPUTE_ORIGIN_NODE
    # 未注册 → 回落 node (向后兼容)
    assert compute_origin_of("__no_such_task_type__") == COMPUTE_ORIGIN_NODE


def test_compute_origin_fields_is_purely_additive():
    """本 helper 只返回新增字段名, 老消费方忽略即可。"""
    fields = compute_origin_fields(get_spec("llm_chat"))
    assert set(fields) == {"compute_origin", "compute_origin_note"}
    assert fields["compute_origin"] == COMPUTE_ORIGIN_PLATFORM_RELAY

    node_fields = compute_origin_fields(get_spec("local_llm_chat"))
    assert node_fields["compute_origin"] == COMPUTE_ORIGIN_NODE


def test_compute_origin_fields_tolerates_foreign_spec():
    """没有该字段的外来/老 spec 也必须给出合法值, 不能抛异常。"""
    class _Bare:
        task_type = "__bare__"

    fields = compute_origin_fields(_Bare())
    assert fields["compute_origin"] == COMPUTE_ORIGIN_NODE
    assert fields["compute_origin_note"] == ""


# ── 4. 标签模块不该引入未使用的常量 ────────────────────────────────────

def test_registry_module_exposes_origin_constant_pair():
    """两个常量都要能被 API 层 import 到 (序列化用同源定义)。"""
    assert getattr(task_registry, "COMPUTE_ORIGIN_NODE", None) == "node"
    assert getattr(task_registry, "COMPUTE_ORIGIN_PLATFORM_RELAY", None) == "platform_relay"
