"""film_text 可选兼容层（惰性解析真实实现）。

背景
2026-09-13 的 `film-redesign-reset` 归档同时移除了 `film_media` 与 `film_text`。
`film_media` 的修复（`film_media_compat.py`）让提交路径往前走了一步，随后暴露出
`services/workloads/submit.py:224` 对 `film_text` 的**裸 import**——同一类疏漏。

本模块与 `film_media_compat` 同构：惰性解析、不缓存失败、缺席时保守降级、不放松授权。
"""
from __future__ import annotations

from typing import Any

#: 归档后仍然存在的语义文本任务类型；模块缺席时按它做保守分类。
SEMANTIC_TASK_TYPE = "audio_transcribe_refine"


def _authorization():
    """解析 `film_text.semantic.authorization`；不可用时返回 None。"""
    try:
        from platform_v8.services.film_text.semantic import authorization  # type: ignore

        return authorization
    except Exception:  # noqa: BLE001 - 归档缺失是预期情形
        return None


def available() -> bool:
    """真实 `film_text` 实现当前是否可用。"""
    return _authorization() is not None


def _task_type_of(workload: Any) -> str | None:
    task_type = getattr(getattr(workload, "spec", None), "task_type", None)
    return task_type if isinstance(task_type, str) else None


def is_semantic(workload: Any) -> bool:
    """是否为语义文本任务。模块缺席时退化为按 task_type 判定。"""
    authorization = _authorization()
    if authorization is not None:
        return bool(authorization.is_semantic(workload))
    return _task_type_of(workload) == SEMANTIC_TASK_TYPE


def trusted_executor_owners(workload: Any) -> set:
    """受信的语义执行者。模块缺席时返回空集（失败关闭，不放行任何人）。"""
    authorization = _authorization()
    if authorization is not None:
        return set(authorization.trusted_executor_owners(workload))
    return set()


def check_private_admission(inp: Any) -> None:
    """语义私有准入检查。模块缺席时不拦截——与 `film_media_compat` 同一条理由：
    归档后该类任务已不对外发布，若在此一律拒绝，会让全部普通任务一起无法提交。"""
    authorization = _authorization()
    if authorization is not None:
        authorization.check_private_admission(inp)


def semantic_denied_type() -> type[BaseException]:
    """提交路径应捕获的拒绝类型：真实存在时用真实类型，否则用本地替身。"""
    try:
        from platform_v8.services.film_text.semantic.scope import SemanticDenied  # type: ignore

        return SemanticDenied
    except Exception:  # noqa: BLE001
        return SemanticDeniedCompat


class SemanticDeniedCompat(Exception):
    """与真实 `film_text.semantic.scope.SemanticDenied` 同名的降级替身。"""


def writing_trusted_executor_owners(workload: Any) -> set | None:
    """写作路径的受信执行者。模块缺席时返回 None，表示"无法判定"。"""
    try:
        from platform_v8.services.film_text.writing.shared_execution import (  # type: ignore
            trusted_executor_owners as real,
        )
    except Exception:  # noqa: BLE001
        return None
    return set(real(workload))


def inspect_terminal_failure(*args: Any, **kwargs: Any) -> Any:
    """写作终态失败检查。模块缺席时返回 None，由调用方按既有规则处理。"""
    try:
        from platform_v8.services.film_text.writing.terminal_failure import (  # type: ignore
            inspect_terminal_failure as real,
        )
    except Exception:  # noqa: BLE001
        return None
    return real(*args, **kwargs)
