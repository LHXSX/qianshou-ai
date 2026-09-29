"""Lease-bound file read grants. This module signs metadata and never reads object bytes."""
from __future__ import annotations

import base64
import hashlib
import os
import re
import time
from datetime import datetime, timezone
from urllib.parse import urlsplit, unquote
from uuid import UUID

from sqlalchemy import select

from platform_v8.protocol.artifact import parse_artifact_ref, validate_artifact_against_context
from platform_v8.protocol.generic_file import canonical, file_schema_sha256, validate_file_schema
from platform_v8.services.artifact_lease import verify_lease_token
from platform_v8.storage.repo import (
    AuditRepo, ResultVerificationRepo, ShardRepo, WorkloadRepo, WorkerRepo,
    shards_t, workloads_t, workers_t, task_adapter_publications_t as publications_t,
)

BINDING_KEY = "_file_attachment_bindings"
REQUEST_KEY = "file_attachments"
BINDING_SCHEMA = "qianshou.file-attachment-bindings.v1"
GRANT_SCHEMA = "qianshou.file-attachment-read-credential.v1"
_SHA = re.compile(r"sha256:[0-9a-f]{64}\Z")
_REQUEST_FIELDS = {"workload_id", "shard_id", "worker_id", "attempt", "lease_token",
                   "account_id", "task_type", "contract_sha256", "slot"}


class AttachmentCredentialError(ValueError):
    def __init__(self, reason: str, status_code: int = 403):
        super().__init__(reason)
        self.status_code = status_code


def _uuid(value: object) -> bool:
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (TypeError, ValueError):
        return False


def _digest(value: dict) -> str:
    return "sha256:" + hashlib.sha256(canonical(value)).hexdigest()


def _completed_asset(session, *, owner_id: int, source: dict, slot: dict) -> dict:
    if (not isinstance(source, dict) or set(source) != {"workload_id", "shard_id", "result_id"}
            or any(not _uuid(source.get(key)) for key in source)):
        raise AttachmentCredentialError("附件必须引用已完成的归属任务结果", 422)
    workload = WorkloadRepo.by_id(session, source["workload_id"])
    shard = ShardRepo.by_id(session, source["shard_id"])
    if (workload is None or int(workload.owner_id) != owner_id
            or getattr(workload.status, "value", None) != "DONE" or workload.result is None
            or shard is None or str(shard.workload_id) != str(workload.id)
            or getattr(shard.status, "value", None) != "DONE"):
        raise AttachmentCredentialError("附件来源未完成或不属于任务账号")
    artifact = parse_artifact_ref(shard.output_ref)
    if (artifact is None or artifact.result_id != source["result_id"]
            or not artifact.object_version_id or not 1 <= artifact.size_bytes <= slot["maxBytes"]
            or artifact.content_type not in slot["contentTypes"]):
        raise AttachmentCredentialError("附件结果不符合声明的版本、类型或界限", 422)
    try:
        validate_artifact_against_context(artifact, account_id=owner_id,
                                         workload_id=str(workload.id), shard_id=str(shard.id))
    except ValueError as exc:
        raise AttachmentCredentialError("附件结果归属上下文无效") from exc
    verified = (shard.metadata or {}).get("result_verification")
    record = ResultVerificationRepo.get(session, str(shard.id), int(shard.attempts))
    if (not isinstance(verified, dict) or record is None or record["state"] != "SUCCEEDED"
            or record["disposition"] not in {"VERIFIED", "ARTIFACT_VERIFIED"}
            or record["worker_id"] != str(shard.worker_id) or record["attempt"] != shard.attempts
            or record["artifact"] != artifact.model_dump(by_alias=True)
            or record["content_sha256"] != artifact.sha256
            or (record.get("evidence") or {}).get("output_ref") != artifact.to_storage_ref()
            or verified.get("sha256") != artifact.sha256 or verified.get("object_key") != artifact.object_key):
        raise AttachmentCredentialError("附件缺少同一版本的持久独立核验")
    # A verified locked-evidence result is a server-held fact, not a client receipt claim.
    # This initial path does not grant reads of arbitrary uploads or general bucket artifacts.
    receipt = verified.get("external_file_receipt")
    if (verified.get("semantic_contract") == "artifact-integrity.v1"
            and verified.get("disposition") == "ARTIFACT_VERIFIED" and isinstance(receipt, dict)):
        payload = receipt.get("payload", {})
        observed = payload.get("observed", {})
        if (payload.get("purpose") != "qianshou:file-bytes-verifier"
                or payload.get("object_version_id") != artifact.object_version_id
                or payload.get("result") != "pass"):
            raise AttachmentCredentialError("附件文件用途证明无效")
    elif (verified.get("semantic_contract") == "external-media.v1"
          and verified.get("disposition") == "VERIFIED"):
        receipt = verified.get("external_media_receipt")
        observed = receipt.get("observed", {}) if isinstance(receipt, dict) else {}
    else:
        raise AttachmentCredentialError("附件来源未经过独立锁定对象核验")
    if (not isinstance(observed, dict) or observed.get("sha256") != artifact.sha256
            or observed.get("size_bytes") != artifact.size_bytes):
        raise AttachmentCredentialError("附件字节证明与结果不一致")
    return {"source": dict(source), "artifact": artifact.model_dump(by_alias=True)}


def freeze_file_attachments(session, *, owner_id: int, task_type: str,
                            file_schema: dict, reviewed_binding: dict,
                            requested: object) -> dict:
    """Called before workload/ledger writes; owner supplies source IDs, never object data."""
    schema = validate_file_schema(file_schema)
    if (not isinstance(reviewed_binding, dict)
            or reviewed_binding.get("schema") != "qianshou.reviewed-workload-contract.v1"
            or not isinstance(reviewed_binding.get("contract_sha256"), str)
            or not _SHA.fullmatch(reviewed_binding["contract_sha256"])
            or reviewed_binding.get("file_schema_sha256") != file_schema_sha256(schema)):
        raise AttachmentCredentialError("缺少冻结的已审核文件合同", 422)
    requested = {} if requested is None else requested
    if (not isinstance(requested, dict) or set(requested) != {slot["name"] for slot in schema["inputs"]}
            or len(canonical(requested)) > 2048):
        raise AttachmentCredentialError("附件引用必须恰好对应已审核输入槽", 422)
    bindings = {slot["name"]: _completed_asset(session, owner_id=owner_id,
                  source=requested[slot["name"]], slot=slot) for slot in schema["inputs"]}
    frozen = {"schema": BINDING_SCHEMA, "account_id": owner_id, "task_type": task_type,
              "contract_sha256": reviewed_binding["contract_sha256"],
              "file_schema_sha256": file_schema_sha256(schema), "attachments": bindings}
    return {**frozen, "bindings_sha256": _digest(frozen)}


def reviewed_file_publication(session, task_type: str, contract_sha256: str) -> tuple[dict, object]:
    from platform_v8.services.workers import task_adapter_publications as publications
    from platform_v8.services.workers.task_adapter_review_issuer import task_contract_sha256
    state = publications.market_readiness(session, task_type)
    if not state["ready"]:
        raise AttachmentCredentialError("已审核文件合同当前不可执行", 409)
    row = session.execute(select(publications_t).where(
        publications_t.c.id == state["publication_id"], publications_t.c.status == "approved",
        publications_t.c.task_type == task_type)).mappings().first()
    spec = publications._spec_for_row(dict(row)) if row is not None else None
    if (spec is None or not spec.adapter_file_schema
            or task_contract_sha256(dict(row), spec) != contract_sha256):
        raise AttachmentCredentialError("文件合同与派单冻结摘要不一致", 409)
    return dict(row), spec


def _lease_expiry(token: str) -> int:
    try:
        raw = base64.urlsafe_b64decode(token + "=" * (-len(token) % 4))
        if base64.urlsafe_b64encode(raw).rstrip(b"=").decode() != token:
            raise ValueError("noncanonical lease")
        return int(raw.split(b".", 2)[0])
    except (ValueError, UnicodeError) as exc:
        raise AttachmentCredentialError("租约无效") from exc


def presign_attachment(artifact: dict, expires: int) -> str:
    """COS signing only. No HEAD, GET, download or byte relay occurs in Shanghai."""
    from platform_v8.services.workers import task_adapter_evidence_storage as storage
    try:
        provider = storage.provider()
        if provider._full_key(artifact["object_key"]) != artifact["object_key"]:
            raise ValueError("object prefix differs")
        endpoint = urlsplit(provider.config.endpoint)
        expected_hosts = {endpoint.hostname, provider.bucket + "." + str(endpoint.hostname)}
        url = provider._public.generate_presigned_url("get_object", Params={
            "Bucket": provider.bucket, "Key": artifact["object_key"],
            "VersionId": artifact["object_version_id"]}, ExpiresIn=expires, HttpMethod="GET")
        parsed = urlsplit(url)
        from urllib.parse import parse_qs
        import os
        core_host = urlsplit(os.environ.get("PUBLIC_API_BASE", "https://www.qianshousuanli.com")).hostname
        if (parsed.scheme != "https" or parsed.hostname not in expected_hosts
                or parsed.hostname == core_host or parsed.port not in {None, 443}
                or parsed.username or parsed.password or parsed.fragment
                or unquote(parsed.path) != "/" + artifact["object_key"]
                or parse_qs(parsed.query).get("versionId") != [artifact["object_version_id"]]):
            raise ValueError("storage did not issue exact-version HTTPS credential")
        return url
    except Exception as exc:
        raise AttachmentCredentialError("精确版本附件存储授权不可用", 503) from exc


def issue_read_credential(session, *, node_account_id: int, request: dict,
                          now: int | None = None) -> dict:
    if (not isinstance(request, dict) or set(request) != _REQUEST_FIELDS
            or any(not _uuid(request.get(key)) for key in ("workload_id", "shard_id", "worker_id"))
            or type(request.get("attempt")) is not int or not 1 <= request["attempt"] <= 1_000_000
            or type(request.get("account_id")) is not int or request["account_id"] < 1
            or not isinstance(request.get("task_type"), str) or not re.fullmatch(r"[a-z][a-z0-9_]{2,63}", request["task_type"])
            or not isinstance(request.get("contract_sha256"), str) or not _SHA.fullmatch(request["contract_sha256"])
            or not isinstance(request.get("slot"), str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,31}", request["slot"])
            or not isinstance(request.get("lease_token"), str) or not 1 <= len(request["lease_token"]) <= 2048):
        raise AttachmentCredentialError("附件授权请求字段无效", 422)
    now = int(time.time()) if now is None else now
    # Never accept the legacy helper's development fallback for a storage credential.
    if not (os.getenv("V8_ARTIFACT_LEASE_SECRET", "").strip() or os.getenv("V8_JWT_SECRET", "").strip()):
        raise AttachmentCredentialError("生产租约签名配置不可用", 503)
    # Hold current assignment and immutable workload rows through signing. Reassignment must wait.
    session.execute(select(shards_t.c.id).where(shards_t.c.id == request["shard_id"]).with_for_update()).first()
    session.execute(select(workloads_t.c.id).where(workloads_t.c.id == request["workload_id"]).with_for_update()).first()
    session.execute(select(workers_t.c.id).where(workers_t.c.id == request["worker_id"]).with_for_update()).first()
    shard = ShardRepo.by_id(session, request["shard_id"])
    workload = WorkloadRepo.by_id(session, request["workload_id"])
    worker = WorkerRepo.by_id(session, request["worker_id"])
    if shard is None or workload is None:
        raise AttachmentCredentialError("任务不存在", 404)
    if (worker is None or int(worker.owner_id) != node_account_id
            or getattr(worker.status, "value", None) not in {"ONLINE", "BUSY"}
            or getattr(worker, "onboarding_status", None) == "banned"
            or str(shard.workload_id) != str(workload.id)
            or int(workload.owner_id) != request["account_id"]
            or workload.spec.task_type != request["task_type"]):
        raise AttachmentCredentialError("节点、账号或任务绑定不一致")
    status = getattr(shard.status, "value", None)
    holder = str(shard.lease_by_node if status == "LEASED" else shard.worker_id or "")
    if (status not in {"LEASED", "DISPATCHED", "RUNNING"} or holder != request["worker_id"]
            or shard.attempts != request["attempt"]
            or getattr(workload.status, "value", None) not in {"PLANNED", "RUNNING", "WAITING_FOR_WORKERS"}
            or not verify_lease_token(request["lease_token"], shard_id=request["shard_id"],
                                      worker_id=request["worker_id"], attempt=request["attempt"])):
        raise AttachmentCredentialError("节点不持有当前有效派单租约")
    expires_at = min(now + 60, _lease_expiry(request["lease_token"]))
    if shard.lease_expires_at is not None:
        expiry = shard.lease_expires_at.replace(tzinfo=timezone.utc) if shard.lease_expires_at.tzinfo is None else shard.lease_expires_at
        expires_at = min(expires_at, int(expiry.timestamp()))
    if expires_at <= now + 5:
        raise AttachmentCredentialError("当前租约剩余时间不足")
    requirements = workload.spec.requirements or {}
    contract = requirements.get("_reviewed_task_contract", {})
    if contract.get("contract_sha256") != request["contract_sha256"]:
        raise AttachmentCredentialError("请求与冻结审核合同不一致", 409)
    publication, spec = reviewed_file_publication(session, request["task_type"], request["contract_sha256"])
    schema = validate_file_schema(spec.adapter_file_schema)
    slot = next((slot for slot in schema["inputs"] if slot["name"] == request["slot"]), None)
    frozen = requirements.get(BINDING_KEY)
    if not isinstance(frozen, dict) or slot is None:
        raise AttachmentCredentialError("派单缺少已冻结声明槽", 409)
    if (set(frozen) != {"schema", "account_id", "task_type", "contract_sha256", "file_schema_sha256", "attachments", "bindings_sha256"}
            or frozen["bindings_sha256"] != _digest({k: v for k, v in frozen.items() if k != "bindings_sha256"})
            or frozen["schema"] != BINDING_SCHEMA or frozen["account_id"] != workload.owner_id
            or frozen["task_type"] != request["task_type"] or frozen["contract_sha256"] != request["contract_sha256"]
            or frozen["file_schema_sha256"] != file_schema_sha256(schema)
            or not isinstance(frozen["attachments"], dict)
            or set(frozen["attachments"]) != {slot["name"] for slot in schema["inputs"]}):
        raise AttachmentCredentialError("已冻结附件合同无效", 409)
    binding = frozen["attachments"][request["slot"]]
    if (not isinstance(binding, dict) or set(binding) != {"source", "artifact"}
            or _completed_asset(session, owner_id=int(workload.owner_id), source=binding["source"], slot=slot) != binding):
        raise AttachmentCredentialError("附件来源与冻结版本不一致", 409)
    from platform_v8.services.workers.file_device_attestation import authorized_file_device
    if not authorized_file_device(session, worker=worker, publication=publication,
                                  contract_sha256=request["contract_sha256"]):
        raise AttachmentCredentialError("设备尚无同一文件合同的独立安装挑战证明")
    artifact = binding["artifact"]
    url = presign_attachment(artifact, expires_at - now)
    AuditRepo.write(session, action="file_attachment.read_credential", actor_account_id=node_account_id,
                    actor_kind="account", target_kind="shard", target_id=request["shard_id"],
                    detail={key: request[key] for key in ("workload_id", "worker_id", "attempt", "account_id", "task_type", "contract_sha256", "slot")})
    return {"schema": GRANT_SCHEMA, **{key: request[key] for key in _REQUEST_FIELDS - {"lease_token"}},
            "object_key": artifact["object_key"], "object_version_id": artifact["object_version_id"],
            "sha256": artifact["sha256"], "size_bytes": artifact["size_bytes"],
            "content_type": artifact["content_type"], "file_schema_sha256": frozen["file_schema_sha256"],
            "bindings_sha256": frozen["bindings_sha256"], "url": url,
            "method": "GET", "expires_at": expires_at}
