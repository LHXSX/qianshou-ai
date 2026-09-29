"""film_media 可选兼容层（惰性解析真实实现）。

背景（2026-09-15 核查）
`/opt/qianshou-archive/film-redesign-reset-20260913/` 于 2026-09-13 同时归档了
`film_media` 与 `film_text` 两个模块。代码里 `film_text` 的所有调用点**都已用
try/except 包住并优雅降级**（见 `engine/planner.py::_film_writing_executor_scope`），
`film_media` 的 5 处调用点漏了同样处理，后果：

- `services/workloads/submit.py` 每次提交都先 import 它 → **所有任务提交 500**
- `engine/planner.py`、`engine/assignment_payload.py`、`services/result_verifier.py`
  在媒体路径上抛异常

设计要点

1. **惰性**：真实实现**按需解析、不缓存失败**。这样将来恢复 `film_media` 时无需重启，
   也避免"兼容层在导入期抓取真实实现"可能造成的循环导入。
2. **同构**：语义与 `film_text` 的既有降级保持一致——模块缺席按 task_type 保守分类。
3. **不放松授权**：`trusted_executor_owners` 在缺席时返回**空集**（失败关闭），
   绝不放行任何执行者。
"""
from __future__ import annotations

from typing import Any

#: 归档后仍然存在的媒体任务类型；模块缺席时按它做保守分类。
MEDIA_TASK_TYPE = "qianshou_film_media"


def _authorization():
    """解析 `film_media.authorization`；不可用时返回 None。"""
    try:
        from platform_v8.services.film_media import authorization  # type: ignore

        return authorization
    except Exception:  # noqa: BLE001 - 归档缺失是预期情形
        return None


def available() -> bool:
    """真实 `film_media` 实现当前是否可用。"""
    return _authorization() is not None


def _task_type_of(workload: Any) -> str | None:
    task_type = getattr(getattr(workload, "spec", None), "task_type", None)
    return task_type if isinstance(task_type, str) else None


def is_media(workload: Any) -> bool:
    """是否为媒体任务。模块缺席时退化为按 task_type 判定。"""
    authorization = _authorization()
    if authorization is not None:
        return bool(authorization.is_media(workload))
    return _task_type_of(workload) == MEDIA_TASK_TYPE


def trusted_executor_owners(workload: Any) -> set:
    """受信的媒体执行者。模块缺席时返回空集（失败关闭，不放行任何人）。"""
    authorization = _authorization()
    if authorization is not None:
        return set(authorization.trusted_executor_owners(workload))
    return set()


def check_private_admission(inp: Any) -> None:
    """私有媒体准入检查。

    模块缺席时**不拦截**——这是刻意的，且与 `film_text` 的降级一致：
    归档后媒体任务类型已不对外发布，提交路径的整体准入由 task_type 与预算校验承担。
    若在此处一律拒绝，会让**全部非媒体任务**一起无法提交，正是本次故障的表现。
    """
    authorization = _authorization()
    if authorization is not None:
        authorization.check_private_admission(inp)


def media_denied_type() -> type[BaseException]:
    """提交路径应捕获的拒绝类型：真实存在时用真实类型，否则用本地替身。"""
    try:
        from platform_v8.services.film_media.claims import MediaDenied  # type: ignore

        return MediaDenied
    except Exception:  # noqa: BLE001
        return MediaDeniedCompat


class MediaDeniedCompat(Exception):
    """与真实 `film_media.claims.MediaDenied` 同名的降级替身。"""


def validate_media_result(payload: Any, workload: Any, shard: Any) -> dict:
    """媒体结果校验。模块缺席时返回空结论，由调用方按既有规则处理。"""
    try:
        from platform_v8.services.film_media.result_verification import (  # type: ignore
            validate_media_result as real,
        )
    except Exception:  # noqa: BLE001
        return {}
    return dict(real(payload, workload, shard))
