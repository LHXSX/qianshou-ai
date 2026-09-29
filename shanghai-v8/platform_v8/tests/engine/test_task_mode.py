"""
W0-4 · task_registry.py TaskMode + register_dynamic + list_by_mode 单测

覆盖:
  1. TaskMode enum 三值齐全 (ONESHOT/SESSION/PULL)
  2. 现有 53 task 默认 mode = ONESHOT (向后兼容)
  3. register_dynamic 注册新 task · TASK_REGISTRY 多一条
  4. register_dynamic 幂等 (同 spec 重复注册不告警)
  5. register_dynamic 不同 spec 覆盖 + 警告
  6. list_by_mode 过滤正确
  7. get_spec 未注册 task → DEFAULT_SPEC (mode 应是 ONESHOT)
"""
from __future__ import annotations

import pytest

from platform_v8.engine import task_registry
from platform_v8.engine.task_registry import (
    TaskMode, TaskTypeSpec, TASK_REGISTRY, DEFAULT_SPEC,
    get_spec, list_by_mode, register_dynamic,
)


def _mk_test_spec(task_type: str, mode: TaskMode = TaskMode.ONESHOT,
                  description: str = "test") -> TaskTypeSpec:
    return TaskTypeSpec(
        task_type=task_type, category="test", description=description,
        accepted_input_kinds=("params_only",), default_input_kind="params_only",
        slicer="single", aggregator="inline_concat", mode=mode,
    )


@pytest.fixture(autouse=True)
def _cleanup_test_keys():
    """每个用例后清掉本测注册的 task_type · 防污染其他用例"""
    yield
    for k in ("__test_oneshot", "__test_session", "__test_pull",
              "__test_register", "__test_duplicate",
              "__test_preserve_static_sharding"):
        TASK_REGISTRY.pop(k, None)


# ─────────── 用例 1 · TaskMode 三值齐全 ───────────
def test_task_mode_three_values():
    values = {m.value for m in TaskMode}
    assert values == {"oneshot", "session", "pull"}
    assert TaskMode.ONESHOT.value == "oneshot"
    assert TaskMode.SESSION.value == "session"
    assert TaskMode.PULL.value == "pull"


# ─────────── 用例 2 · 内置 task 默认 ONESHOT ───────────
def test_builtin_tasks_default_oneshot():
    """静态内置 task 保持默认 ONESHOT；动态 task 可以声明其他模式。"""
    for spec in task_registry._TASKS:
        assert spec.mode == TaskMode.ONESHOT, \
            f"{spec.task_type} mode 应为 ONESHOT · 实际 {spec.mode}"


# ─────────── 用例 3 · DEFAULT_SPEC 也是 ONESHOT ───────────
def test_default_spec_is_oneshot():
    assert DEFAULT_SPEC.mode == TaskMode.ONESHOT


# ─────────── 用例 4 · get_spec 未注册返 default ───────────
def test_get_spec_unknown_returns_default_oneshot():
    spec = get_spec("totally_unknown_task_xyz_999")
    assert spec is DEFAULT_SPEC
    assert spec.mode == TaskMode.ONESHOT


# ─────────── 用例 5 · register_dynamic 新增 ───────────
def test_register_dynamic_adds_new():
    before_count = len(TASK_REGISTRY)
    new_spec = _mk_test_spec("__test_register", mode=TaskMode.SESSION)
    register_dynamic(new_spec)
    assert len(TASK_REGISTRY) == before_count + 1
    stored = TASK_REGISTRY["__test_register"]
    assert stored.mode == TaskMode.SESSION
    assert stored.accepted_input_kinds == ("params_only",)
    assert get_spec("__test_register").mode == TaskMode.SESSION


# ─────────── 用例 6 · register_dynamic 幂等 ───────────
def test_register_dynamic_idempotent(caplog):
    import logging
    caplog.set_level(logging.WARNING)
    spec = _mk_test_spec("__test_duplicate", mode=TaskMode.PULL)
    register_dynamic(spec)
    register_dynamic(spec)  # 重复注册相同 spec · 不该 warning
    warnings = [r for r in caplog.records if r.levelno == logging.WARNING]
    assert not any("__test_duplicate" in r.message and "重复" in r.message
                   for r in warnings), "幂等注册不该警告"


# ─────────── 用例 7 · register_dynamic 不同 spec 覆盖 + 警告 ───────────
def test_register_dynamic_overrides_with_warning(caplog):
    import logging
    caplog.set_level(logging.WARNING)
    s1 = _mk_test_spec("__test_duplicate", mode=TaskMode.SESSION, description="v1")
    s2 = _mk_test_spec("__test_duplicate", mode=TaskMode.PULL, description="v2")
    register_dynamic(s1)
    register_dynamic(s2)
    assert get_spec("__test_duplicate").mode == TaskMode.PULL
    assert get_spec("__test_duplicate").description == "v2"
    # 应有警告
    assert any("__test_duplicate" in r.message and "重复" in r.message
               for r in caplog.records)


def test_skill_manifest_cannot_downgrade_static_sharding():
    task_type = "__test_preserve_static_sharding"
    register_dynamic(TaskTypeSpec(
        task_type=task_type,
        category="test",
        description="static",
        accepted_input_kinds=("multi_file",),
        default_input_kind="multi_file",
        slicer="files_chunked",
        aggregator="zip_files",
        max_shards_limit=20,
    ))
    register_dynamic(
        TaskTypeSpec(
            task_type=task_type,
            category="test",
            description="manifest",
            accepted_input_kinds=("single_file",),
            default_input_kind="single_file",
            slicer="single",
            aggregator="inline_concat",
            max_shards_limit=1,
        ),
        preserve_static_sharding=True,
    )

    merged = get_spec(task_type)
    assert merged.slicer == "files_chunked"
    assert merged.aggregator == "zip_files"
    assert merged.max_shards_limit == 20
    assert merged.accepted_input_kinds == ("multi_file",)


# ─────────── 用例 8 · list_by_mode 过滤 ───────────
def test_list_by_mode_filters():
    register_dynamic(_mk_test_spec("__test_session", mode=TaskMode.SESSION))
    register_dynamic(_mk_test_spec("__test_pull", mode=TaskMode.PULL))

    session_list = list_by_mode(TaskMode.SESSION)
    pull_list = list_by_mode(TaskMode.PULL)
    oneshot_list = list_by_mode(TaskMode.ONESHOT)

    assert any(s.task_type == "__test_session" for s in session_list)
    assert any(s.task_type == "__test_pull" for s in pull_list)
    # oneshot list 应包含现有 53 task · 但不含 __test_session/__test_pull
    assert all(s.task_type not in ("__test_session", "__test_pull")
               for s in oneshot_list)
    assert len(oneshot_list) >= 20  # 现有 30 task · 加 register_dynamic 不会少于 20


# ─────────── 用例 9 · TaskMode 是 str enum (JSON 序列化兼容) ───────────
def test_task_mode_is_str_enum():
    """TaskMode 继承 str · 方便 JSON 序列化 + 跟字符串比较"""
    assert TaskMode.SESSION == "session"
    assert TaskMode.ONESHOT == "oneshot"
    import json
    s = json.dumps({"mode": TaskMode.SESSION.value})
    assert s == '{"mode": "session"}'


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
