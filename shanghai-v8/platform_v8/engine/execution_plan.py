"""
ExecutionPlan 摘要解析及兼容帧构造（仅内存 · 不落库）。

当前 PUSH / PULL / 重连恢复使用 assignment_payload.build_assignment_payload。
兼容构造器保留摘要未知时的 wire 空串；摘要解析器仍返回 None。
"""
from __future__ import annotations

import hashlib
import logging
import os
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from platform_v8.core import Shard, Workload
from platform_v8.protocol import ws_schema as wsp
from platform_v8.services.artifact_lease import mint_lease_token

logger = logging.getLogger(__name__)

_SHA256_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_PLACEHOLDER_HASHES = frozenset({"", "tbd", "none", "null", "n/a"})


def normalize_code_sha256(raw: Any) -> str | None:
    """把空串 / TBD / 非 64 hex 当成缺失。合法值归一为小写 hex。"""
    if raw is None:
        return None
    text = str(raw).strip()
    if not text or text.lower() in _PLACEHOLDER_HASHES:
        return None
    if not _SHA256_RE.fullmatch(text):
        logger.warning("execution_plan · 忽略非法 code_sha256=%r", text[:80])
        return None
    return text.lower()


def resolve_scripts_dir() -> Path:
    """与 api/v8/scripts.py 同源候选目录 · 不 import API 层。"""
    env_dir = os.environ.get("EDGECOMPUTE_TASK_SCRIPTS_DIR")
    if env_dir and os.path.isdir(env_dir):
        return Path(env_dir)
    candidates = [
        Path(__file__).resolve().parents[1] / "scripts" / "tasks",
        Path("/opt/edge/platform_v8/scripts/tasks"),
        Path("/opt/edge/backend/scripts/tasks"),
        Path("/app/backend/scripts/tasks"),
    ]
    for c in candidates:
        if c.is_dir():
            return c
    return candidates[0]


def _official_script_stem(task_type: str, code_url: str) -> str | None:
    """仅当 URL 指向官方 /scripts/{task_type} 或 URL 为空时，才用本地脚本算 hash。"""
    if not task_type:
        return None
    if not code_url:
        return task_type
    path = urlparse(code_url).path or ""
    name = Path(path).name
    stem = Path(name).stem
    if stem == task_type:
        return task_type
    marker = f"/scripts/{task_type}"
    if marker in path:
        return task_type
    return None


def hash_local_task_script(task_type: str) -> str | None:
    """对 platform_v8/scripts/tasks/{task_type}.py 做 SHA-256；文件不存在则 None。"""
    if not task_type or not re.fullmatch(r"[A-Za-z0-9._-]+", task_type):
        return None
    target = (resolve_scripts_dir() / f"{task_type}.py").resolve()
    scripts_dir = resolve_scripts_dir().resolve()
    try:
        target.relative_to(scripts_dir)
    except ValueError:
        return None
    if not target.is_file():
        return None
    try:
        digest = hashlib.sha256(target.read_bytes()).hexdigest()
    except OSError as exc:
        logger.warning("execution_plan · 读脚本失败 task_type=%s: %s", task_type, exc)
        return None
    return digest


def resolve_code_sha256(
    *,
    task_type: str,
    code_url: str,
    shard_meta: dict[str, Any] | None = None,
) -> str | None:
    """优先 shard metadata；否则官方脚本本地文件；都没有就 None（不编造）。"""
    meta = shard_meta or {}
    from_meta = normalize_code_sha256(meta.get("code_sha256"))
    if from_meta:
        return from_meta
    stem = _official_script_stem(task_type, code_url)
    if not stem:
        return None
    return hash_local_task_script(stem)


def _created_at_ms(wl: Workload) -> int:
    try:
        if wl.created_at:
            return int(wl.created_at.timestamp() * 1000)
    except Exception:
        pass
    return 0


def _runtime_value(wl: Workload) -> str:
    runtime = wl.spec.runtime
    return runtime.value if hasattr(runtime, "value") else str(runtime)


def _resolve_executor_routing(task_type: str) -> tuple[str, tuple[str, ...], str, str, str]:
    """required_tier, fallback_tiers, executor, native_binary, onnx_model。"""
    try:
        from platform_v8.engine.task_registry import TASK_REGISTRY, resolve_tier_routing

        spec = TASK_REGISTRY.get(task_type)
        if spec is None:
            return "", (), "", "", ""
        req_tier, fb_tiers = resolve_tier_routing(spec)
        executor = getattr(spec.executor, "value", str(spec.executor))
        return (
            req_tier or "",
            tuple(fb_tiers or ()),
            executor or "",
            spec.native_binary or "",
            spec.onnx_model or "",
        )
    except Exception as exc:
        logger.debug("execution_plan · task_registry 路由失败 task_type=%s: %s", task_type, exc)
        return "", (), "", "", ""


def _resolve_native_args(
    *,
    executor: str,
    task_type: str,
    shard_meta: dict[str, Any],
    wl: Workload,
) -> list[str]:
    if executor != "native":
        return []
    native_args = list(shard_meta.get("native_args") or [])
    if native_args:
        return native_args
    try:
        from platform_v8.engine.native_args_templates import render_native_args

        return render_native_args(
            task_type=task_type,
            params=dict(shard_meta.get("params") or wl.spec.params or {}),
            slice_meta=dict(shard_meta.get("slice_meta") or {}),
        )
    except Exception:
        return []


def make_shard_assign_payload(
    sh: Shard,
    wl: Workload,
    *,
    worker_id: str = "",
    requester_name: str = "",
    requester_avatar: str = "",
    created_at_ms: int | None = None,
) -> wsp.ShardAssignPayload:
    """兼容 ExecutionPlan → ShardAssignPayload 构造器。

    摘要缺失显式编码为 wire 空串，保留未知解析结果；lease_token 按 worker 现算。
    当前派发路径使用 assignment_payload.build_assignment_payload。
    """
    shard_meta = dict(sh.metadata or {})
    from platform_v8.services.file_assignment_contract import project_file_assignment_contract
    file_contract = project_file_assignment_contract(wl, task_type=wl.spec.task_type)
    file_attempt = {}
    if file_contract is not None:
        if type(sh.attempts) is not int or sh.attempts < 0:
            raise ValueError("文件派单必须绑定当前分片 attempt")
        file_attempt = {"attempt": sh.attempts}
    req_tier, fb_tiers, executor, native_binary, onnx_model = _resolve_executor_routing(
        wl.spec.task_type
    )
    native_args = _resolve_native_args(
        executor=executor,
        task_type=wl.spec.task_type,
        shard_meta=shard_meta,
        wl=wl,
    )
    resolved_code_sha256 = resolve_code_sha256(
        task_type=wl.spec.task_type,
        code_url=wl.spec.code_url,
        shard_meta=shard_meta,
    )
    code_sha256 = "" if resolved_code_sha256 is None else resolved_code_sha256
    token_worker = worker_id or str(getattr(sh, "lease_by_node", "") or sh.worker_id or "")

    # R7 · V2 JobSpec 展平（老节点 ignore）。不剥 code_url / required_tier。
    from platform_v8.engine.assignment_payload import _runtime_v2_dispatch_fields

    exec_model, runtime_api, cap_name, cap_ver = _runtime_v2_dispatch_fields(
        wl, dict(shard_meta.get("params") or wl.spec.params or {})
    )

    return wsp.ShardAssignPayload(
        shard_id=str(sh.id),
        workload_id=str(wl.id),
        account_id=int(wl.owner_id),
        **file_attempt,
        index=sh.index,
        total=sh.total,
        task_type=wl.spec.task_type,
        runtime=_runtime_value(wl),
        code_url=wl.spec.code_url,
        code_sha256=code_sha256,
        input_kind=str(shard_meta.get("input_kind") or wl.spec.input_kind or "single_file"),
        input_ref=sh.input_ref,
        input_refs=list(shard_meta.get("input_refs") or []),
        file_contract=file_contract,
        inline_input=(
            shard_meta.get("inline_input")
            if "inline_input" in shard_meta
            else wl.spec.inline_input
        ),
        slice_meta=dict(shard_meta.get("slice_meta") or {}),
        params=dict(shard_meta.get("params") or wl.spec.params or {}),
        timeout_s=wl.spec.timeout_s,
        reward=float(wl.budget) / max(sh.total, 1),
        workload_name=wl.name or "",
        requester_name=requester_name,
        requester_avatar=requester_avatar,
        created_at_ms=_created_at_ms(wl) if created_at_ms is None else created_at_ms,
        required_tier=req_tier,
        fallback_tiers=list(fb_tiers),
        executor=executor,
        native_binary=native_binary,
        native_args=native_args,
        onnx_model=onnx_model,
        lease_token=mint_lease_token(
            shard_id=str(sh.id),
            worker_id=token_worker,
            **file_attempt,
        ),
        execution_model=exec_model,
        runtime_api=runtime_api,
        capability=cap_name,
        capability_version=cap_ver,
    )
