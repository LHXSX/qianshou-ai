"""
提交任务业务

设计要点 (考虑全链路):
  1. 整个流程是 1 个 DB 事务: balance 检查 + escrow_hold + workload create
     任何失败 → 全部 rollback (get_session 自动)
  2. balance < budget → 400 (前端能识别)
  3. workload.status=CREATED · engine.lifecycle 后续推到 PLANNED
  4. 写审计
  5. 返回 workload 完整对象
"""
from __future__ import annotations
import logging
import os
import hashlib
import json
from copy import deepcopy
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from sqlalchemy.orm import Session

from platform_v8.core import (
    Workload, WorkloadSpec, WorkloadStatus, TaskKind, Runtime, AuditAction,
)
from platform_v8.storage.repo import WorkloadRepo, AccountRepo, AuditRepo
from platform_v8.services.economy import ledger as ledger_svc
from platform_v8.services.economy import balance as balance_svc
from platform_v8.services.storage_refs import (
    StorageReferenceError,
    canonicalize_owned_reference,
)
from platform_v8.services import film_media_compat as media_compat
from platform_v8.services import film_text_compat as text_compat

logger = logging.getLogger(__name__)


class SubmitWorkloadError(Exception):
    """提交任务失败 (余额不足 / 参数非法 / 等)"""
    pass


def zero_budget_allowed(*, is_admin: bool) -> bool:
    """Zero-cost workloads require an admin unless explicitly enabled."""
    return bool(is_admin) or os.getenv("EDGE_ALLOW_ZERO_BUDGET", "").lower() in (
        "1", "true", "yes",
    )


def _resolve_submit_execution_model(
    spec_dict: dict[str, Any], params: dict[str, Any]
) -> str:
    """spec 顶层或 params 声明的执行模型；未声明保持空串（不当成全员 legacy）。"""
    raw = str(
        spec_dict.get("execution_model") or params.get("execution_model") or ""
    ).strip()
    if not raw:
        return ""
    try:
        from platform_v8.services.marketplace.execution_model import (
            resolve_execution_model,
        )

        return resolve_execution_model({"execution_model": raw})
    except Exception:
        text = raw.lower().replace("-", "_")
        if text in ("runtime_v2", "runtimev2", "v2"):
            return "runtime_v2"
        return "legacy_script"


def _resolve_max_shards(spec_dict: dict[str, Any], task_spec_meta: Any) -> int:
    """Restore the public auto-sharding contract with registry as hard cap."""
    limit = max(1, int(getattr(task_spec_meta, "max_shards_limit", 1) or 1))
    requested = max(1, int(spec_dict.get("max_shards") or 1))
    return limit if spec_dict.get("auto_shard", True) else min(requested, limit)


@dataclass
class SubmitInput:
    owner_id: int
    name: str
    spec_dict: dict[str, Any]          # 前端传入的 spec (pydantic 已校验)
    budget: Decimal
    quote_token: str | None = None  # estimate 签发；普通账号必须在 5 分钟内确认
    request_id: str | None = None  # formal media idempotency, shared by all entry points
    # 审计上下文
    trace_id: str | None = None
    ip: str | None = None
    # 安全门禁 (S2-T2/T3 · 2026-06-07)
    is_admin: bool = False             # admin 可用 shell runtime + 任意 code_url
    private_media_admission: object | None = None  # Internal object, never HTTP data.
    private_semantic_admission: object | None = None  # Internal object, never HTTP data.


# ── 安全白名单 (S2-T2/T3) ────────────────────────────────────
# 高危 runtime · 普通用户禁用,避免节点 bash -c 任意命令(等价 RCE)
_DANGEROUS_RUNTIMES = {"shell", "bash", "sh", "zsh"}

# code_url host 白名单 · 普通用户只能下平台脚本,不能让节点 GET 任意外部 URL
# (防供应链 RCE · admin 可绕过用于 skill-pack 测试)
def _code_url_host_allowed(code_url: str) -> bool:
    if not code_url:
        return True  # 空 url submit 层会自动填平台脚本
    import os as _os
    from urllib.parse import urlparse
    api_base = _os.environ.get("PUBLIC_API_BASE", "https://www.qianshousuanli.com")
    try:
        api_host = urlparse(api_base).hostname or ""
        url_host = urlparse(code_url).hostname or ""
    except Exception:
        return False
    if not url_host:
        return False
    allowed_hosts = {
        api_host,
        "www.qianshousuanli.com",
        "qianshousuanli.com",
        "localhost",
        "127.0.0.1",
    }
    if url_host in allowed_hosts:
        return True
    # 允许 skill-pack OSS 的 CDN(暂用前缀匹配)
    if url_host.endswith(".aliyuncs.com") or url_host.endswith(".oss-cn-hangzhou.aliyuncs.com"):
        return True
    return False


def input_ref_allowed(value: str, *, owner_id: int) -> bool:
    try:
        canonicalize_owned_reference(owner_id, value)
        return True
    except StorageReferenceError:
        return False


def _input_ref_allowed(value: str, *, is_admin: bool, owner_id: int = 0) -> bool:
    """Backward-compatible private alias for callers/tests."""
    del is_admin
    return input_ref_allowed(value, owner_id=owner_id)


def _validate_archive_input(
    *,
    input_ref: str,
    params: dict[str, Any],
    owner_id: int,
) -> None:
    """Validate archive ownership; content is normalized server-side afterwards."""
    if not input_ref_allowed(input_ref, owner_id=owner_id):
        raise SubmitWorkloadError("archive 必须为本账户对象或允许的存储地址")
    if not isinstance(params, dict):
        raise SubmitWorkloadError("archive params 格式错误")


def validate_submission_input_count(
    task_spec_meta: Any,
    *,
    input_kind: str,
    input_ref: str,
    input_refs: list[str],
) -> int:
    """Apply every file count that is knowable in the submission request."""
    from platform_v8.engine.task_registry import (
        InputCardinalityError,
        validate_input_file_count,
    )

    if input_kind == "archive":
        count = 1 if input_ref else 0
        archive_package = True
    elif input_kind == "single_file":
        count = 1 if input_ref else 0
        archive_package = False
    elif input_kind == "multi_file":
        count = len(input_refs)
        archive_package = False
    else:
        return 0
    try:
        validate_input_file_count(
            task_spec_meta,
            count,
            source=input_kind,
            archive_package=archive_package,
        )
    except InputCardinalityError as exc:
        raise SubmitWorkloadError(str(exc)) from exc
    return count


# 脚本侧硬依赖的业务参数 · 缺了派到节点只会 exit 1
# key=task_type · value=必填 params 字段名
_REQUIRED_TASK_PARAMS: dict[str, tuple[str, ...]] = {
    "seo_rank": ("keyword",),
}


def required_task_params(task_type: str) -> tuple[str, ...]:
    """Expose the same mandatory fields to catalog and quote validation."""
    normalized = str(task_type or "").strip()
    inherited = _REQUIRED_TASK_PARAMS.get(normalized, ())
    from platform_v8.engine.task_registry import TASK_REGISTRY
    declared = getattr(TASK_REGISTRY.get(normalized), "parameter_schema", {}) or {}
    fields = declared.get("required", [])
    return tuple(dict.fromkeys((*inherited, *fields)))


def task_input_form_contract(spec: Any) -> dict[str, Any]:
    """Generate a client form from the reviewed task registry, not a category.

    The developer API owns upload staging and task submission. This schema
    describes only the input portion that a generic client may ask for.
    """
    kinds = [kind for kind in spec.accepted_input_kinds if kind != "stream"]
    declared = getattr(spec, "parameter_schema", {}) or {}
    params_schema = deepcopy(declared) if declared else {
        "type": "object", "properties": {}, "required": [],
        "additionalProperties": False,
    }
    required_params = set(required_task_params(spec.task_type))
    properties = params_schema.get("properties", {})
    form_ready = (isinstance(properties, dict)
                  and required_params.issubset(properties)
                  and not ("params_only" in kinds and not declared))
    variants = []
    for kind in kinds:
        fields: dict[str, Any] = {
            "input_kind": {"const": kind},
            "params": params_schema,
        }
        required = ["input_kind"]
        if kind == "inline":
            fields["inline_input"] = (deepcopy(spec.inline_input_form)
                                      if getattr(spec, "inline_input_form", None)
                                      else {"type": "string", "maxLength": 1000000,
                                            "title": "输入文字"})
            required.append("inline_input")
        elif kind in {"single_file", "archive"}:
            fields["input_ref"] = {"type": "string", "minLength": 1,
                                   "maxLength": 2048, "title": "已上传文件"}
            required.append("input_ref")
        elif kind == "multi_file":
            fields["input_refs"] = {
                "type": "array", "minItems": 1, "maxItems": 100,
                "items": {"type": "string", "minLength": 1, "maxLength": 2048},
                "title": "已上传文件",
            }
            required.append("input_refs")
        elif kind == "params_only":
            required.append("params")
        variants.append({"type": "object", "properties": fields,
                         "required": required, "additionalProperties": False})
    return {
        "form_schema_version": "qianshou.task-input-form.v1",
        "input_schema": {"oneOf": variants},
        "params_schema": params_schema,
        "form_ready": bool(form_ready and variants),
    }


def _validate_required_task_params(task_type: str, params: dict[str, Any]) -> None:
    """提交期校验必填业务参数 · 避免无效派发。"""
    needed = required_task_params(task_type)
    p = params if isinstance(params, dict) else {}
    missing: list[str] = []
    for key in needed:
        val = p.get(key)
        if val is None or (isinstance(val, str) and not val.strip()):
            missing.append(key)
    if missing:
        raise SubmitWorkloadError(
            f"缺少必填参数: {', '.join(missing)} "
            f"(task_type={task_type})"
        )
    # For explicitly declared form fields, quote and submit apply the same
    # scalar type/range constraints. Internal _developer_* metadata is left to
    # its own contract and is not interpreted as a form field.
    from platform_v8.engine.task_registry import TASK_REGISTRY
    declared = getattr(TASK_REGISTRY.get(task_type), "parameter_schema", {}) or {}
    for key, rule in declared.get("properties", {}).items():
        if key not in p or not isinstance(rule, dict):
            continue
        value = p[key]
        kind = rule.get("type")
        if kind == "integer":
            valid = type(value) is int
            if valid and "minimum" in rule:
                valid = value >= rule["minimum"]
            if valid and "maximum" in rule:
                valid = value <= rule["maximum"]
        elif kind == "number":
            valid = type(value) in (int, float)
            if valid and "minimum" in rule:
                valid = value >= rule["minimum"]
            if valid and "maximum" in rule:
                valid = value <= rule["maximum"]
        elif kind == "string":
            valid = isinstance(value, str)
            if valid and "minLength" in rule:
                valid = len(value) >= rule["minLength"]
            if valid and "maxLength" in rule:
                valid = len(value) <= rule["maxLength"]
        elif kind == "boolean":
            valid = type(value) is bool
        else:
            valid = False
        if valid and "enum" in rule:
            valid = value in rule["enum"]
        if not valid:
            raise SubmitWorkloadError(f"参数 {key} 不符合已审阅输入合同 (task_type={task_type})")


def submit_workload(s: Session, inp: SubmitInput) -> Workload:
    """
    提交任务 · 返回 Workload · 失败抛 SubmitWorkloadError
    """
    # All public/developer/product entry points converge here. Admin/contract
    # budget permission cannot invent the missing media execution channel.
    from platform_v8.services.media_profiles import require_formal_media_channel, MediaProfileError, is_media
    try:
        if is_media(inp.spec_dict):
            from platform_v8.services.media_channel import submit_media
            return submit_media(s, inp)
        require_formal_media_channel(inp.spec_dict)
    except (MediaProfileError, ValueError) as exc:
        raise SubmitWorkloadError(str(exc)) from None
    try:
        media_compat.check_private_admission(inp)
    except Exception as exc:  # noqa: BLE001 - 仅转译媒体拒绝，其余照常上抛
        if isinstance(exc, media_compat.media_denied_type()):
            raise SubmitWorkloadError(str(exc)) from None
        raise
    try:
        text_compat.check_private_admission(inp)
    except Exception as exc:  # noqa: BLE001 - 仅转译语义拒绝，其余照常上抛
        if isinstance(exc, text_compat.semantic_denied_type()):
            raise SubmitWorkloadError(str(exc)) from None
        raise
    # 先校验值，但余额检查必须等服务端重算可执行价格后再做。
    if not inp.budget.is_finite() or inp.budget < 0:
        raise SubmitWorkloadError("budget 必须是非负有限金额")

    # 3. 解析 spec
    try:
        kind_str = inp.spec_dict.get("kind", "DATA_PROCESSING")
        task_type = inp.spec_dict.get("task_type", "")
        code_url = inp.spec_dict.get("code_url", "")
        from platform_v8.engine.task_registry import get_spec as _get_task_spec
        from platform_v8.services.workers.task_adapter_publications import callable_task_spec
        callable_task_spec(s, task_type)

        # 2026-05-18 v8 收口: code_url 自动 resolve
        # 如果用户没传 code_url · 自动用 /api/v8/scripts/{task_type}.py
        # 节点端会 GET 这个 URL 拉脚本跑 (适配 dedup_lines / base64_encode / 等 30+ 脚本)
        if (not code_url and task_type and task_type not in ("shell", "llm_infer")
                and not _get_task_spec(task_type).requires_verified_adapter
                and not getattr(_get_task_spec(task_type), "official_provider_id", "")):
            import os as _os
            api_base = _os.environ.get("PUBLIC_API_BASE", "https://www.qianshousuanli.com")
            code_url = f"{api_base}/api/v8/scripts/{task_type}.py"

        # 2026-05-18 · input_kind 推断
        # 若 spec 没传 input_kind · 按 task_registry 默认 (向后兼容旧客户端)
        task_spec_meta = _get_task_spec(task_type)
        verification_policy = str(
            getattr(task_spec_meta, "settlement_policy", "quarantine")
            or "quarantine"
        )
        requested_policy = inp.spec_dict.get("verification_policy")
        if (
            requested_policy is not None
            and str(requested_policy).strip()
            and str(requested_policy).strip() != verification_policy
        ):
            raise SubmitWorkloadError(
                "verification_policy 由 task registry 决定，调用方不能覆盖"
            )
        input_kind = str(inp.spec_dict.get("input_kind") or "")
        if not input_kind:
            # 老客户端没传 · 看哪个字段有值
            if inp.spec_dict.get("inline_input"):
                input_kind = "inline"
            elif inp.spec_dict.get("input_refs"):
                input_kind = "multi_file"
            elif inp.spec_dict.get("input_ref"):
                input_kind = "single_file"
            else:
                input_kind = task_spec_meta.default_input_kind
        if input_kind not in task_spec_meta.accepted_input_kinds:
            if task_spec_meta.exact_input_kinds:
                raise SubmitWorkloadError(
                    f"task_type={task_type} 只接受 {', '.join(task_spec_meta.accepted_input_kinds)}"
                )
            # 2026-05-20 · 改"容忍"为"强制纠正"
            # 否则 image_* 任务客户端误填 params_only · 节点不下 input · 脚本空 stdin 失败
            # 策略: 若 spec 有 input_ref → 改 single_file · 否则用 task 默认
            corrected = (
                "single_file" if inp.spec_dict.get("input_ref")
                else "multi_file" if inp.spec_dict.get("input_refs")
                else task_spec_meta.default_input_kind
            )
            if task_spec_meta.exact_input_kinds:
                raise SubmitWorkloadError("已审核接单技能不接受该输入类型")
            logger.warning("workload.submit · task_type=%s 不接受 input_kind=%s · 强制纠正 → %s · accepted=%s",
                           task_type, input_kind, corrected, task_spec_meta.accepted_input_kinds)
            input_kind = corrected

        # 强制纠正后必须再次验证；此前 multi_file 会被错误地放进仅单文件的任务。
        if input_kind not in task_spec_meta.accepted_input_kinds:
            raise SubmitWorkloadError(
                f"task_type={task_type} 不支持 input_kind={input_kind} "
                f"(允许: {', '.join(task_spec_meta.accepted_input_kinds)})"
            )

        input_ref = str(inp.spec_dict.get("input_ref") or "")
        input_refs_raw = inp.spec_dict.get("input_refs") or []
        if not isinstance(input_refs_raw, list) or any(
            not isinstance(item, str) or not item.strip() for item in input_refs_raw
        ):
            raise SubmitWorkloadError("input_refs 必须是非空字符串数组")
        input_refs = [item.strip() for item in input_refs_raw]
        # 兼容企业端旧包：multi_file 时偶发同时带 input_ref=input_refs[0]
        # 有合法 input_refs 时忽略多余的 input_ref，避免误杀提交。
        if input_kind == "multi_file" and input_refs:
            input_ref = ""
        if input_kind == "single_file" and (not input_ref or input_refs):
            raise SubmitWorkloadError("single_file 必须只提供 input_ref")
        if input_kind == "multi_file" and (input_ref or not input_refs):
            raise SubmitWorkloadError("multi_file 必须只提供非空 input_refs")
        if input_kind == "archive" and (not input_ref or input_refs):
            raise SubmitWorkloadError("archive 必须只提供 1 个原始包 input_ref")
        submitted_file_count = validate_submission_input_count(
            task_spec_meta,
            input_kind=input_kind,
            input_ref=input_ref,
            input_refs=input_refs,
        )
        refs_to_check = input_refs if input_kind == "multi_file" else [input_ref]
        if input_kind in ("single_file", "multi_file", "archive"):
            try:
                canonical_refs = [
                    canonicalize_owned_reference(inp.owner_id, ref)
                    for ref in refs_to_check
                ]
            except StorageReferenceError as exc:
                raise SubmitWorkloadError(str(exc)) from exc
            if input_kind == "multi_file":
                input_refs = canonical_refs
            else:
                input_ref = canonical_refs[0]
        elif input_kind == "stream" and input_ref:
            try:
                from platform_v8.services.url_safety import validate_url

                validate_url(input_ref)
            except Exception as exc:
                raise SubmitWorkloadError("stream input_ref URL 不符合安全策略") from exc
        params = dict(inp.spec_dict.get("params") or {})
        if getattr(task_spec_meta, "official_provider_id", ""):
            from platform_v8.services.workloads.official_image_admission import require_ready
            try:
                require_ready(s, input_kind=input_kind,
                              inline_input=inp.spec_dict.get("inline_input"),
                              params=params, spec=inp.spec_dict)
            except ValueError as exc:
                raise SubmitWorkloadError(str(exc)) from exc
        if task_spec_meta.requires_verified_adapter:
            if inp.spec_dict.get("code_url"):
                raise SubmitWorkloadError("本机适配器任务不接受调用方 code_url")
            if input_kind == "inline" and (input_ref or input_refs):
                raise SubmitWorkloadError("inline 适配器任务不能同时提供文件引用")
        if task_spec_meta.requires_verified_adapter:
            from platform_v8.services.workloads.reviewed_adapter_contract import (
                validate_reviewed_order,
            )
            try:
                validate_reviewed_order(
                    task_spec_meta,
                    input_kind=input_kind,
                    inline_input=inp.spec_dict.get("inline_input"),
                    params=params,
                )
            except ValueError as exc:
                raise SubmitWorkloadError(str(exc)) from exc
        if task_spec_meta.requires_verified_adapter:
            from platform_v8.services.workers.task_adapter_publications import market_readiness
            state = market_readiness(s, task_type)
            if not state["ready"]:
                reason_code = ("EXTERNAL_ARTIFACT_VERIFIER_REQUIRED" if
                               task_spec_meta.external_artifact_verifier_required else
                               "TASK_ADAPTER_PUBLICATION_NOT_READY")
                raise SubmitWorkloadError(
                    reason_code + ": " + "；".join(state["reasons"])
                )
            # Freeze the reviewed machine contract at order creation. A later
            # publication or task registry refresh must never turn an older
            # result into a different kind of verified deliverable.
            from platform_v8.services.workers.task_adapter_review_issuer import (
                task_contract_sha256,
            )
            from platform_v8.storage.repo import task_adapter_publications_t
            from sqlalchemy import select
            reviewed_row = s.execute(select(task_adapter_publications_t).where(
                task_adapter_publications_t.c.id == state["publication_id"],
            )).mappings().one()
            reviewed_binding = {
                "schema": "qianshou.reviewed-workload-contract.v1",
                "contract_sha256": task_contract_sha256(dict(reviewed_row), task_spec_meta),
                "result_strategy": task_spec_meta.adapter_result_strategy,
                "output_kind": task_spec_meta.adapter_output_kind,
                "output_schema_sha256": "sha256:" + hashlib.sha256(
                    json.dumps(
                        task_spec_meta.adapter_output_schema,
                        sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                        allow_nan=False,
                    ).encode("utf-8")
                ).hexdigest(),
                "contract_version": reviewed_row["contract_version"],
            }
        else:
            reviewed_binding = None
        if reviewed_binding is not None and getattr(task_spec_meta, "adapter_file_schema", None):
            from platform_v8.protocol.generic_file import file_schema_sha256
            reviewed_binding["file_schema_sha256"] = file_schema_sha256(task_spec_meta.adapter_file_schema)
        if task_spec_meta.external_artifact_verifier_required:
            verification_policy = ("artifact" if getattr(task_spec_meta, "adapter_file_schema", None)
                                   else "semantic")  # Byte-only policy still requires an independent signature.
        archive_pending = input_kind == "archive"
        if input_kind == "archive":
            _validate_archive_input(
                input_ref=input_ref,
                params=params,
                owner_id=inp.owner_id,
            )
            if "multi_file" not in task_spec_meta.accepted_input_kinds:
                raise SubmitWorkloadError(
                    f"task_type={task_type} 尚未实现 archive 批处理合同"
                )
            # Archive bytes are deliberately not downloaded inside this
            # transaction or the request worker. A durable NORMALIZING
            # workload is created below, then a background worker converts it
            # to the ordinary multi_file contract before lifecycle.start().

        # max_shards 约束 (task_registry 限制最多能切几片)
        max_shards = _resolve_max_shards(inp.spec_dict, task_spec_meta)
        if input_kind in ("single_file", "multi_file"):
            from platform_v8.engine.task_registry import (
                ShardCapacityError,
                validate_file_shard_capacity,
            )

            try:
                validate_file_shard_capacity(
                    task_spec_meta,
                    submitted_file_count,
                    max_shards,
                )
            except ShardCapacityError as exc:
                raise SubmitWorkloadError(str(exc)) from exc

        # ── S2-T3 · 普通用户禁高危 runtime ──
        runtime_str = str(inp.spec_dict.get("runtime", "python3")).lower()
        if runtime_str in _DANGEROUS_RUNTIMES and not inp.is_admin:
            raise SubmitWorkloadError(
                f"runtime={runtime_str} 仅 admin 可用 (普通用户禁 shell · 防 RCE)"
            )

        # ── S2-T2 · code_url host 白名单 ──
        if not inp.is_admin and not _code_url_host_allowed(code_url):
            raise SubmitWorkloadError(
                f"code_url host 不在白名单 (防供应链 RCE) · 仅允许平台脚本 / skill-pack: {code_url[:80]}"
            )

        exec_model = _resolve_submit_execution_model(inp.spec_dict, params)
        if exec_model:
            params.setdefault("execution_model", exec_model)

        requirements = inp.spec_dict.get("requirements", {}) or {}
        if not isinstance(requirements, dict):
            raise SubmitWorkloadError("requirements 必须是对象")
        if "_reviewed_task_contract" in requirements or "_file_attachment_bindings" in requirements:
            raise SubmitWorkloadError("调用方不能声明已审核任务合同")
        frozen_attachments = None
        if getattr(task_spec_meta, "adapter_file_schema", None):
            from platform_v8.services.file_attachment_credentials import freeze_file_attachments
            frozen_attachments = freeze_file_attachments(
                s, owner_id=inp.owner_id, task_type=task_type,
                file_schema=task_spec_meta.adapter_file_schema, reviewed_binding=reviewed_binding,
                requested=requirements.get("file_attachments"))
        elif "file_attachments" in requirements:
            raise SubmitWorkloadError("任务未声明文件输入合同")

        spec = WorkloadSpec(
            kind=TaskKind(kind_str) if kind_str in TaskKind.__members__ else TaskKind.DATA_PROCESSING,
            task_type=task_type,
            runtime=Runtime(inp.spec_dict.get("runtime", "python3")),
            code_url=code_url,
            input_kind=input_kind,
            input_ref=input_ref,
            input_refs=input_refs,
            inline_input=inp.spec_dict.get("inline_input"),
            params=params,
            max_shards=max_shards,
            verification_policy=verification_policy,
            redundancy_factor=int(inp.spec_dict.get("redundancy_factor", 1)),
            timeout_s=int(inp.spec_dict.get("timeout_s", 300)),
            requirements={
                **requirements,
                **({"_reviewed_task_contract": reviewed_binding}
                   if reviewed_binding is not None else {}),
                **({"_file_attachment_bindings": frozen_attachments}
                   if frozen_attachments is not None else {}),
            },
            execution_model=exec_model,
        )
    except (ValueError, KeyError) as exc:
        raise SubmitWorkloadError(f"spec 格式错误: {exc}")

    # 2026-05-24 · crawl_* task_type 必须经 URL 白名单校验 (合规第一层防御 · 节点脚本是第二层)
    # 不通过 → 拒绝提交 · 余额不扣 · 不会派单
    if spec.task_type.startswith("crawl_"):
        try:
            from platform_v8.services.crawl import whitelist as crawl_wl
            params = spec.params or {}
            urls_to_check: list[str] = []
            if isinstance(params.get("url"), str) and params["url"]:
                urls_to_check.append(params["url"])
            if isinstance(params.get("urls"), list):
                urls_to_check.extend([u for u in params["urls"] if isinstance(u, str) and u])
            if not urls_to_check:
                raise SubmitWorkloadError(
                    f"crawl 任务 {spec.task_type} 缺少 params.url / params.urls"
                )
            ok, reason, _details = crawl_wl.check_urls_allowed(s, urls_to_check)
            if not ok:
                raise SubmitWorkloadError(
                    f"crawl URL 白名单校验失败: {reason} · "
                    "请联系管理员添加 (POST /api/v8/admin/crawl-whitelist)"
                )
            logger.info("workload.submit · crawl 白名单通过 · task=%s urls=%d",
                        spec.task_type, len(urls_to_check))
        except SubmitWorkloadError:
            raise
        except Exception as e:
            # 白名单服务异常 · 保守拒绝 (合规不能放行)
            logger.error("workload.submit · crawl 白名单校验异常: %s", e)
            raise SubmitWorkloadError(f"crawl 白名单服务异常 · 暂时拒绝提交: {e}")

    # 业务必填参数 · 缺了就进节点也必失败 · 提交期直接拒
    _validate_required_task_params(spec.task_type, spec.params or {})

    # 付费准入：全部 HTTP 入口最终走此处，不能仅在 /workloads 路由校验。
    # 普通账号须出示同账号、同 spec、未过期且版本仍有效的报价，确认金额
    # 必须与此刻服务端重新计算的价完全一致。直到这些检查结束前不写 workload/ledger。
    from platform_v8.services.economy import task_pricing as task_pricing_svc
    from platform_v8.services.economy import workload_quote as workload_quote_svc
    try:
        priced_spec = workload_quote_svc.pricing_spec(
            inp.spec_dict, session=s, account_id=inp.owner_id,
        )
        effective_budget, price_quote, pricing_mode = task_pricing_svc.resolve_effective_budget(
            s, spec=priced_spec, client_budget=inp.budget,
            account_id=inp.owner_id, is_admin=inp.is_admin,
        )
        if pricing_mode == "server_price":
            if price_quote.price_basis.startswith("default("):
                raise SubmitWorkloadError("当前任务尚未配置服务端价目，暂不能提交")
            workload_quote_svc.verify_confirmation(
                inp.quote_token, account_id=inp.owner_id,
                spec=inp.spec_dict, quote=price_quote,
            )
            if not effective_budget.is_finite() or effective_budget <= 0:
                raise SubmitWorkloadError("当前任务没有有效的正数服务端价格，暂不能提交")
            if inp.budget != effective_budget:
                raise SubmitWorkloadError(
                    f"确认金额与最新报价不一致（应为 {effective_budget} 元），请重新获取报价"
                )
    except workload_quote_svc.WorkloadQuoteError as exc:
        raise SubmitWorkloadError(str(exc)) from None
    except (ValueError, ArithmeticError) as exc:
        raise SubmitWorkloadError(f"任务价格无法核对: {exc}") from exc

    # 特殊合同仍可使用明确授权的客户端预算；免费执行只允许 admin 或既有
    # EDGE_ALLOW_ZERO_BUDGET 测试开关。余额和锁款一律以最终金额为准。
    if effective_budget == 0 and not zero_budget_allowed(is_admin=inp.is_admin):
        raise SubmitWorkloadError("budget 必须 > 0（零预算任务仅 admin 可提交）")
    if effective_budget > 0:
        current_balance = balance_svc.get_balance(s, inp.owner_id)
        if current_balance < effective_budget:
            raise SubmitWorkloadError(
                f"余额不足 (当前 {current_balance} · 需要 {effective_budget})"
            )

    # 4. 创建 workload (生成 uuid · 写 DB)
    workload = Workload(
        owner_id=inp.owner_id,
        name=inp.name,
        spec=spec,
        status=(
            WorkloadStatus.NORMALIZING
            if archive_pending else WorkloadStatus.CREATED
        ),
        budget=effective_budget,
    )
    workload = WorkloadRepo.create(s, workload)

    # 5. escrow_hold (在同一事务里写账本)
    if effective_budget > 0:
        ledger_svc.escrow_hold(
            s,
            account_id=inp.owner_id,
            amount=effective_budget,
            workload_id=workload.id,
            note=f"提交任务: {inp.name}",
        )

    # 6. 审计
    AuditRepo.write(
        s,
        action=AuditAction.WORKLOAD_SUBMIT,
        actor_account_id=inp.owner_id,
        actor_kind="user",
        target_kind="workload",
        target_id=workload.id,
        trace_id=inp.trace_id,
        ip=inp.ip,
        detail={
            "name": inp.name,
            "task_type": spec.task_type,
            "budget": str(effective_budget),
            "pricing_mode": pricing_mode,
            "price_basis": price_quote.price_basis,
            "settings_version": price_quote.settings_version,
        },
    )

    logger.info("workload.submit · id=%s owner=%s task_type=%s budget=%s",
                workload.id, inp.owner_id, spec.task_type, effective_budget)

    # 2026-05-18 实时推送 · 新任务事件
    try:
        from platform_v8.api.v8.events import publish_event_sync
        publish_event_sync("workload.created", {
            "workload_id": str(workload.id),
            "owner_id": inp.owner_id,
            "name": inp.name,
            "task_type": spec.task_type,
            "budget": float(effective_budget),
        }, owner_id=inp.owner_id)
    except Exception:
        pass

    # 7. 链路 5 接 engine.lifecycle.start(workload.id) hook
    return workload
