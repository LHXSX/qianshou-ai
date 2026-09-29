"""Exact object/immutable version STS grants for the Guangzhou media service.

The existing production COS signer stays on Shanghai. No media bytes, master
credentials, broad result glob or publication review scope leave this module.
"""
import hashlib
import json
import re
import time
from uuid import UUID
from urllib.request import Request, build_opener, ProxyHandler
from sqlalchemy import select, insert, update
from platform_v8.services import media_channel as channel
from platform_v8.services.media_profiles import MediaProfileError
from platform_v8.storage.media_repo import objects_t, MediaRepo
from platform_v8.storage.repo import WorkloadRepo, AccountRepo

BUCKET = "qs-task-evidence-prod-1463872884"
REGION = "ap-shanghai"
APP_ID = "1463872884"
TTL = 900
TICKET_FIELDS = {"schema", "purpose", "accountId", "assetId", "role", "sha256", "size_bytes",
                 "content_type", "object_key", "nonce", "issued_at", "expires_at"}


def _uuid(value):
    try:
        return isinstance(value, str) and str(UUID(value)) == value
    except (ValueError, TypeError):
        return False


def _declaration(asset_id, sha256, size_bytes, content_type, *, input_asset):
    allowed = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}
    if not input_asset:
        allowed["video/mp4"] = "mp4"
    if (not _uuid(asset_id) or not isinstance(sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", sha256)
            or type(size_bytes) is not int or not 1 <= size_bytes <= (16777216 if input_asset else 67108864)
            or content_type not in allowed):
        raise MediaProfileError("媒体对象必须为精确asset/hash/大小和允许的MIME声明")
    return allowed[content_type]


def _primary():
    # This production module may be absent in older source exports. Never
    # substitute development OSS credentials or copy secrets as a fallback.
    try:
        from platform_v8.services.workers import task_adapter_evidence_sts
        task_adapter_evidence_sts._config()
        return task_adapter_evidence_sts
    except Exception:
        raise MediaProfileError("quote_unavailable: 专用生产COS STS签发器未接通") from None


def policy(purpose, row, *, version=None):
    resource = f"qcs::cos:{REGION}:uid/{APP_ID}:{BUCKET}/{row['object_key']}"
    if "*" in row["object_key"] or "?" in row["object_key"]:
        raise MediaProfileError("媒体STS禁止泛路径")
    if purpose.endswith("-write"):
        return {"version": "2.0", "statement": [{"effect": "allow", "action": ["name/cos:PutObject"],
            "resource": [resource], "condition": {"string_equal": {
                "cos:object-lock-mode": "COMPLIANCE", "cos:content-type": row["content_type"]},
                "numeric_equal": {"cos:content-length": row["size_bytes"]}}}]}
    if not isinstance(version, str) or not re.fullmatch(r"[A-Za-z0-9_.~+-]{1,200}", version) or version.lower() == "null":
        raise MediaProfileError("媒体只读授权必须绑定非空不可变版本")
    return {"version": "2.0", "statement": [
        {"effect": "allow", "action": ["name/cos:GetObject", "name/cos:HeadObject"],
         "resource": [resource], "condition": {"string_equal": {"cos:versionid": version}}},
        {"effect": "allow", "action": ["name/cos:GetObjectRetention"], "resource": [resource]}]}


def _sts(purpose, row, *, version=None):
    primary = _primary()
    try:
        secret_id, secret_key, endpoint = primary._config()
    except Exception:
        raise MediaProfileError("quote_unavailable: 专用生产COS STS签发器不可用") from None
    now = int(time.time())
    grant_policy = policy(purpose, row, version=version)
    body = channel.canonical({"Name": "qsFormalMedia" + ("Write" if purpose.endswith("-write") else "Read"),
        "Policy": json.dumps(grant_policy, separators=(",", ":")), "DurationSeconds": TTL})
    req = Request("https://sts.tencentcloudapi.com/", data=body, method="POST", headers={
        "Authorization": primary._authorization(secret_id, secret_key, body, now),
        "Content-Type": "application/json; charset=utf-8", "Host": "sts.tencentcloudapi.com",
        "X-TC-Action": "GetFederationToken", "X-TC-Version": "2018-08-13",
        "X-TC-Timestamp": str(now), "X-TC-Region": REGION})
    try:
        with build_opener(ProxyHandler({}), channel._NoRedirect()).open(req, timeout=8) as response:
            raw = response.read(16385)
        if len(raw) > 16384:
            raise ValueError("STS response bound")
        data = json.loads(raw).get("Response")
        if not isinstance(data, dict) or data.get("Error"):
            raise ValueError("STS refused")
        credentials = data.get("Credentials", {})
        expires = data.get("ExpiredTime") or credentials.get("ExpiredTime")
        values = [credentials.get(k) for k in ("TmpSecretId", "TmpSecretKey", "Token")]
        if (not all(isinstance(v, str) and 8 <= len(v) <= 4096 for v in values)
                or values[0] == secret_id or values[1] == secret_key
                or type(expires) is not int or not now + 300 <= expires <= now + TTL + 60):
            raise ValueError("not genuine short-lived scoped STS")
        return {"credential": {"schema": f"qianshou.{purpose}-credential.v1", "provider": "cos",
            "purpose": purpose, "bucket": BUCKET, "region": REGION, "endpoint": endpoint,
            "access_key_id": values[0], "access_key_secret": values[1], "session_token": values[2],
            "prefix": row["object_key"].rsplit("/", 1)[0] + "/", "expires_at": expires},
            "object_key": row["object_key"], "retention_until": row["retention_until"], "object_version_id": version}
    except Exception:
        raise MediaProfileError("quote_unavailable: 精确媒体COS STS授权不可用") from None


def _freeze(s, key, values, *, version=None):
    existing = s.execute(select(objects_t).where(objects_t.c.id == key).with_for_update()).one_or_none()
    if existing:
        row = dict(existing._mapping)
        if any(row[k] != v for k, v in values.items() if k != "retention_until"):
            raise MediaProfileError("媒体对象声明已冻结，不能换asset/key/hash/账号")
    else:
        s.execute(insert(objects_t).values(id=key, **values))
        row = dict(s.execute(select(objects_t).where(objects_t.c.id == key)).one()._mapping)
    if version is not None:
        policy("formal-media-input-read", row, version=version)
        if row["object_version_id"] is not None and row["object_version_id"] != version:
            raise MediaProfileError("媒体对象版本已冻结，不能替换或重新生成")
        s.execute(update(objects_t).where(objects_t.c.id == key).values(object_version_id=version))
    return row


def input_grant(s, ticket, *, version=None):
    stored = False
    raw = ticket.get("payload") if isinstance(ticket, dict) else None
    if version and isinstance(raw, dict) and _uuid(raw.get("assetId")):
        old = s.execute(select(objects_t.c.declaration).where(
            objects_t.c.id == f"input:{raw.get('accountId')}:{raw['assetId']}")).one_or_none()
        stored = old is not None and old.declaration == ticket
    payload = channel.verify(ticket, schema="qianshou.formal-media-asset-upload.v1",
        purpose="qianshou:formal-media-asset-upload", stored_receipt=stored)
    ext = _declaration(payload.get("assetId"), payload.get("sha256"), payload.get("size_bytes"),
                       payload.get("content_type"), input_asset=True)
    owner = payload.get("accountId")
    key = f"v8/account-{owner}/media-assets/{payload['assetId']}/input.{ext}"
    account = AccountRepo.by_id(s, owner) if type(owner) is int and owner > 0 else None
    if (set(payload) != TICKET_FIELDS or account is None or not account.is_active
            or not _uuid(payload.get("nonce"))
            or payload.get("role") not in {"reference", "first_frame", "last_frame"}
            or payload.get("object_key") != key or payload["expires_at"] - payload["issued_at"] > 300):
        raise MediaProfileError("媒体输入上传ticket身份/用途/对象不合法")
    row = _freeze(s, f"input:{owner}:{payload['assetId']}", {"account_id": owner, "asset_id": payload["assetId"],
        "purpose": "input", "object_key": key, "sha256": payload["sha256"], "size_bytes": payload["size_bytes"],
        "content_type": payload["content_type"], "declaration": ticket, "retention_until": int(time.time()) + 48 * 3600}, version=version)
    return _sts("formal-media-input-read" if version else "formal-media-input-write", row, version=version)


def result_grant(s, body, *, read=False):
    w = WorkloadRepo.by_id_for_update(s, body["taskId"])
    a = MediaRepo.attempt(s, body["taskId"], lock=True)
    if (w is None or a is None or body["attemptId"] != a["attempt_id"] or body["leaseEpoch"] != a["lease_epoch"]
            or (not read and (w.is_terminal or int(time.time()) >= a["lease_expires_at"]))):
        raise MediaProfileError("媒体输出授权不是当前有效订单/设备租约")
    ext = _declaration(body["assetId"], body["sha256"], body["size_bytes"], body["content_type"], input_asset=False)
    video = w.spec.media_profile["capability"] == "video"
    if video != (body["content_type"] == "video/mp4"):
        raise MediaProfileError("媒体输出MIME与官方能力不一致")
    key = f"v8/account-{w.owner_id}/workload-{w.id}/shard-{a['attempt_id']}/result/{body['assetId']}/result.{ext}"
    declaration = {k: body[k] for k in ("taskId", "attemptId", "leaseEpoch", "assetId", "sha256", "size_bytes", "content_type")}
    old = s.execute(select(objects_t.c.id).where(objects_t.c.id == "result:" + a["attempt_id"])).first()
    if read and old is None:
        raise MediaProfileError("媒体输出尚无冻结写入授权，不能签读新对象")
    row = _freeze(s, "result:" + a["attempt_id"], {"account_id": w.owner_id, "asset_id": body["assetId"],
        "purpose": "result", "object_key": key, "sha256": body["sha256"], "size_bytes": body["size_bytes"],
        "content_type": body["content_type"], "declaration": declaration, "retention_until": int(time.time()) + 48 * 3600},
        version=body.get("object_version_id") if read else None)
    return _sts("formal-media-result-read" if read else "formal-media-result-write", row,
                version=body.get("object_version_id") if read else None)
