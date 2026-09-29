"""Single assignment-payload builder shared by PUSH, PULL, race, and recovery."""
from __future__ import annotations

from typing import Any
from platform_v8.engine.platform_relay_credential import inject_platform_relay_credential

from platform_v8.engine.privacy_titles import title_for_workload
from platform_v8.protocol import ws_schema as wsp
from platform_v8.protocol.capability_profile import (
    CapabilityProfile,
    is_legacy_profile,
    parse_profile,
)
from platform_v8.services.artifact_lease import (
    DEFAULT_LEASE_TTL_S,
    mint_lease_token,
)
from platform_v8.services.storage_refs import (
    StorageReferenceError,
    canonicalize_owned_reference,
    materialize_get_url,
)
from platform_v8.services import film_media_compat as media_compat


class AssignmentPayloadError(RuntimeError):
    """An assignment cannot be safely sent."""


# Runtime V2 多 op 共用一个 capability；客户端漏传 op 时按 task_type 补上。
_TASK_TYPE_DEFAULT_OP: dict[str, str] = {
    "text_replace": "replace",
    "dedup_lines": "dedup",
    "text_sort": "sort",
    "text_split": "split",
    "word_count": "word_count",
    "line_count": "line_count",
    "text_extract": "pii",
    "regex_extract": "regex",
    "text_mask": "mask",
    "url_parse": "url",
    "json_validate": "validate",
    "json_filter": "filter",
    "base64_encode": "encode",
    "base64_decode": "decode",
    "md5_batch": "md5",
    "crc32_batch": "crc32",
    "hash_batch": "sha256",
}


def ensure_capability_op(task_type: str, params: dict[str, Any] | None) -> dict[str, Any]:
    out = dict(params or {})
    if str(out.get("op") or "").strip():
        return out
    op = _TASK_TYPE_DEFAULT_OP.get(str(task_type or "").strip())
    if op:
        out["op"] = op
    return out


def _runtime_v2_dispatch_fields(
    workload: Any, params: dict[str, Any]
) -> tuple[str, str, str, str]:
    """Return (execution_model, runtime_api, capability, capability_version).

    Dual-path: callers must still send ``code_url`` + python3 so 8.4.x 千手节点
    can execute. Extra keys are ignored by old serde clients.
    """
    try:
        from platform_v8.engine import capabilities as cap_reg
        from platform_v8.engine.task_registry import get_spec
        from platform_v8.services.marketplace.execution_model import (
            EXEC_V2,
            resolve_from_workload,
        )

        exec_model = resolve_from_workload(workload)
        if exec_model != EXEC_V2:
            return "", "", "", ""
        required = cap_reg.normalize_capability_list(
            (params or {}).get("required_capabilities")
        )
        if not required:
            task_type = str(getattr(getattr(workload, "spec", None), "task_type", "") or "")
            required = cap_reg.resolve_required(get_spec(task_type))
        cap_name = str(required[0]["name"]) if required else ""
        cap_ver = str(required[0].get("version") or "") if required else ""
        return EXEC_V2, "2.0", cap_name, cap_ver
    except Exception:
        return "", "", "", ""


def _materialize_ref(
    owner_id: int,
    value: object,
    expires: int,
    *,
    allow_public_url: bool = False,
) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        canonicalize_owned_reference(owner_id, raw)
    except StorageReferenceError:
        if allow_public_url and raw.lower().startswith(("http://", "https://")):
            return raw
        raise AssignmentPayloadError("派发输入不是有效对象引用") from None
    try:
        return materialize_get_url(owner_id, raw, expires)
    except StorageReferenceError as exc:
        raise AssignmentPayloadError(str(exc)) from exc


def _routing(workload: Any, shard: Any, meta: dict[str, Any]) -> tuple:
    from platform_v8.engine.effective_task import (
        default_code_url,
        requires_python_executor,
        resolve_code_sha256,
        resolve_dispatch_task,
        resolve_shard_timeout_s,
    )

    task_type, code_url, task_spec = resolve_dispatch_task(workload, shard)
    if task_spec is not None:
        from platform_v8.engine.task_registry import resolve_tier_routing

        required_tier, fallback_tiers = resolve_tier_routing(task_spec)
        executor = getattr(task_spec.executor, "value", str(task_spec.executor))
        native_binary = task_spec.native_binary or ""
        onnx_model = task_spec.onnx_model or ""
    else:
        required_tier, fallback_tiers = "", ()
        executor, native_binary, onnx_model = "", "", ""
    if requires_python_executor(task_type, dict(meta.get("slice_meta") or {})):
        executor = "python3"
        native_binary = ""
        onnx_model = ""
        code_url = code_url or default_code_url(task_type)
    code_sha256 = resolve_code_sha256(task_type, code_url, meta)
    timeout_s = resolve_shard_timeout_s(workload, shard, task_spec)
    return (
        task_type, code_url, code_sha256, required_tier, fallback_tiers,
        executor, native_binary, onnx_model, timeout_s,
    )


def build_assignment_payload(
    shard: Any,
    workload: Any,
    *,
    worker_id: str,
    attempt: int | None = None,
    requester_name: str = "",
    requester_avatar: str = "",
    created_at_ms: int = 0,
    reward: float | None = None,
    input_expires: int = 3600,
    capability_profile: str | None = None,
) -> wsp.ShardAssignPayload:
    """Build a complete worker payload and fail closed if object signing fails."""
    from platform_v8.services.media_profiles import require_formal_media_channel, MediaProfileError, is_media
    if is_media(workload):
        raise AssignmentPayloadError("quote_unavailable: 正式媒体仅通过持久化广州派发合同执行，禁止旧 shard_assign")
    try:
        require_formal_media_channel(workload)
    except MediaProfileError as exc:
        raise AssignmentPayloadError(str(exc)) from None
    meta = dict(shard.metadata or {})
    try:
        (
            task_type, code_url, code_sha256, required_tier, fallback_tiers,
            executor, native_binary, onnx_model, timeout_s,
        ) = _routing(workload, shard, meta)
    except Exception as exc:
        raise AssignmentPayloadError("无法解析分片派发路由") from exc

    from platform_v8.services.file_assignment_contract import project_file_assignment_contract
    try:
        file_contract = project_file_assignment_contract(workload, task_type=task_type)
    except (ValueError, TypeError, KeyError) as exc:
        raise AssignmentPayloadError("文件派单冻结元数据无效") from exc

    owner_id = int(workload.owner_id)
    input_kind = str(meta.get("input_kind") or workload.spec.input_kind or "single_file")
    profile = (
        parse_profile(capability_profile)
        if capability_profile is not None
        else CapabilityProfile.SECURE_ARTIFACT_V1
    )
    legacy_route = is_legacy_profile(profile)
    if profile == CapabilityProfile.UNSUPPORTED:
        raise AssignmentPayloadError("节点协议能力不支持 ONESHOT 派发")
    if legacy_route:
        from platform_v8.engine.effective_task import legacy_python_fallback

        if input_kind == "stream":
            raise AssignmentPayloadError("legacy 节点不支持 STREAM 输入")
        code_url = legacy_python_fallback(task_type, code_url)
        if not code_url:
            raise AssignmentPayloadError("任务缺少可执行 Python fallback")
        required_tier, fallback_tiers = "", ()
        executor, native_binary, onnx_model = "python3", "", ""
    allow_public_url = input_kind == "stream"
    meta_refs = [str(r).strip() for r in (meta.get("input_refs") or []) if str(r).strip()]
    wl_refs = [
        str(r).strip()
        for r in (getattr(workload.spec, "input_refs", None) or [])
        if str(r).strip()
    ]
    # 分片 metadata 已带本片 input_refs（files_chunked 子集）时必须沿用；
    # 切勿用「workload 全量更长」覆盖，否则每个节点都会处理全部文件。
    # 仅当本片缺 refs（如部分 single 切片）时回退 workload 列表。
    if not meta_refs and wl_refs:
        meta_refs = wl_refs
    input_ref = _materialize_ref(
        owner_id,
        shard.input_ref or (meta_refs[0] if meta_refs else ""),
        input_expires,
        allow_public_url=allow_public_url,
    )
    input_refs = [
        _materialize_ref(
            owner_id, ref, input_expires, allow_public_url=allow_public_url,
        )
        for ref in meta_refs
    ]
    native_args: list[str] = []
    if executor == "native":
        native_args = list(meta.get("native_args") or [])
        if not native_args:
            try:
                from platform_v8.engine.native_args_templates import render_native_args

                native_args = render_native_args(
                    task_type=task_type,
                    params=dict(meta.get("params") or workload.spec.params or {}),
                    slice_meta=dict(meta.get("slice_meta") or {}),
                )
            except Exception:
                native_args = []

    lease_attempt = int(shard.attempts if attempt is None else attempt)
    if file_contract is not None and (type(shard.attempts) is not int or shard.attempts < 0
            or (attempt is not None and type(attempt) is not int) or lease_attempt != shard.attempts):
        raise AssignmentPayloadError("文件派单必须绑定当前分片 attempt")
    if reward is None:
        reward = float(workload.budget) / max(int(shard.total or 1), 1)
    params = ensure_capability_op(
        task_type,
        dict(meta.get("params") or workload.spec.params or {}),
    )
    # 2026-09-18 · C-1 修复配套：平台 LLM 中继类任务在派发时补上 worker 凭据。
    # 为什么在这一层做：/api/v1/chat/completions 与 /api/v1/embeddings 不再免鉴权，
    # 而 8 个中继脚本默认就打平台自己的那个地址 —— 只有鉴权没有凭据会让它们全部 401。
    # 本函数只在「确认会打平台地址」时才注入，且从不覆盖调用方自带的 api_key。
    params = inject_platform_relay_credential(task_type, params)
    from platform_v8.services.workers.native_h3_task_lease import assignment_lease
    try:
        native_device_lease = assignment_lease(task_type=task_type, shard_id=str(shard.id),
            workload_id=str(workload.id), worker_id=str(worker_id), attempt=lease_attempt)
    except (ValueError, TypeError, KeyError) as exc:
        raise AssignmentPayloadError("原生派单冻结身份无效") from exc
    if native_device_lease is not None and ("native_device_lease" in params or "nativeDeviceLease" in params):
        raise AssignmentPayloadError("派单身份不能由任务参数提供")
    lease_token = mint_lease_token(
        shard_id=str(shard.id), worker_id=str(worker_id), attempt=lease_attempt,
        ttl_s=max(DEFAULT_LEASE_TTL_S, int(timeout_s) + 45),
    )
    if media_compat.is_media(workload):
        if str(worker_id) not in media_compat.trusted_executor_owners(workload) or task_type != "qianshou_film_media":
            raise AssignmentPayloadError("MEDIA_ASSIGNMENT_NOT_AUTHORIZED")
        params["_media_execution"] = {
            "workloadId": str(workload.id), "shardId": str(shard.id),
            "workerId": str(worker_id), "attempt": lease_attempt, "leaseToken": lease_token,
        }
    exec_model, runtime_api, cap_name, cap_ver = _runtime_v2_dispatch_fields(
        workload, params
    )
    return wsp.ShardAssignPayload(
        account_id=int(workload.owner_id),
        shard_id=str(shard.id),
        workload_id=str(workload.id),
        attempt=lease_attempt,
        index=shard.index,
        total=shard.total,
        task_type=task_type,
        runtime=(
            "python3"
            if legacy_route
            else (
                workload.spec.runtime.value
                if hasattr(workload.spec.runtime, "value")
                else str(workload.spec.runtime)
            )
        ),
        code_url=code_url,
        code_sha256=code_sha256,
        input_kind=input_kind,
        input_ref=input_ref,
        input_refs=input_refs,
        input_manifest=dict(meta.get("input_manifest") or {}),
        file_contract=file_contract,
        native_device_lease=native_device_lease,
        verification_policy=(
            (lambda _p: "artifact" if _p == "accept" else _p)(
                str(getattr(workload.spec, "verification_policy", "quarantine") or "quarantine")
            )
        ),
        inline_input=(
            meta.get("inline_input")
            if "inline_input" in meta
            else workload.spec.inline_input
        ),
        slice_meta=dict(meta.get("slice_meta") or {}),
        params=params,
        timeout_s=timeout_s,
        reward=float(reward),
        workload_name=title_for_workload(workload),
        requester_name=requester_name,
        requester_avatar=requester_avatar,
        created_at_ms=created_at_ms,
        required_tier=required_tier,
        fallback_tiers=list(fallback_tiers),
        executor=executor,
        native_binary=native_binary,
        native_args=[] if legacy_route else native_args,
        onnx_model=onnx_model,
        lease_token=lease_token,
        execution_model=exec_model,
        runtime_api=runtime_api,
        capability=cap_name,
        capability_version=cap_ver,
    )
