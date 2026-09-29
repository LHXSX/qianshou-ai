"""Short-lived, purpose-scoped COS read credentials for Guangzhou reviewers.

Shanghai issues credentials only.  It never downloads source or media bytes.
This module never falls back to the legacy OSS STS development credential.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timezone
from uuid import UUID
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


BUCKET = "qs-task-evidence-prod-1463872884"
REGION = "ap-shanghai"
APP_ID = "1463872884"
TOKEN_TTL = 1800
BASE_PURPOSES = frozenset({"package", "security", "media", "runner", "sample"})
OPTIONAL_PURPOSES = frozenset({"attestor", "official-image", "file-result"})
PURPOSES = BASE_PURPOSES | OPTIONAL_PURPOSES
_SOURCE = "v8/account-*/publication/*/adapter/source.zip"
_RESULT = "v8/account-*/workload-*/shard-*/result/*/result.*"
FILE_RESULT_PATTERN = "v8/account-*/workload-*/shard-*/result/*/*"
FILE_HEALTH_KEY = "v8/healthcheck/file-verifier-v1.bin"
MEDIA_HEALTH_KEY = "v8/healthcheck/media-verifier-v1.bin"
_READ_ACTIONS = ("name/cos:GetObject", "name/cos:HeadObject",
                 "name/cos:GetObjectRetention")


class EvidenceReadCredentialError(RuntimeError):
    """No narrow, genuine COS STS credential can be issued."""


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        return None


def _config() -> tuple[str, str, str]:
    prefix = "V8_TASK_ADAPTER_EVIDENCE_OSS_"
    if (os.environ.get("V8_TASK_ADAPTER_EVIDENCE_ENABLED") != "1"
            or os.environ.get("V8_TASK_ADAPTER_EVIDENCE_COS_MD5_LOCK_VERIFIED") != "1"
            or os.environ.get(prefix + "PROVIDER") != "cos"
            or os.environ.get(prefix + "BUCKET") != BUCKET
            or os.environ.get(prefix + "REGION") != REGION
            or os.environ.get(prefix + "ENDPOINT") != "https://cos.ap-shanghai.myqcloud.com"):
        raise EvidenceReadCredentialError("dedicated production evidence bucket is unavailable")
    key_id = os.environ.get(prefix + "ACCESS_KEY_ID", "")
    secret = os.environ.get(prefix + "ACCESS_KEY_SECRET", "")
    if (not 8 <= len(key_id) <= 128 or not 8 <= len(secret) <= 256
            or not re.fullmatch(r"[A-Za-z0-9]+", key_id)):
        raise EvidenceReadCredentialError("COS credential signer is unavailable")
    return key_id, secret, os.environ[prefix + "ENDPOINT"]


def _attestor_source(owner_id: int | None, publication_id: str | None) -> str:
    if type(owner_id) is not int or owner_id < 1:
        raise EvidenceReadCredentialError("attestor source owner invalid")
    try:
        if not isinstance(publication_id, str) or str(UUID(publication_id)) != publication_id:
            raise ValueError("noncanonical publication id")
    except (TypeError, ValueError, AttributeError) as exc:
        raise EvidenceReadCredentialError("attestor source publication invalid") from exc
    return (f"v8/account-{owner_id}/publication/{publication_id}/adapter/source.zip")


def _official_result(receipt: dict | None, version_id: str | None, *,
                     now: int | None = None) -> str:
    if receipt is None and version_id is None:
        # Only the locked sentinel is readable before a task starts.  A
        # platform-owned worker cannot assume the buyer's account prefix.
        return MEDIA_HEALTH_KEY
    if receipt is None or version_id is None:
        raise EvidenceReadCredentialError("official image result read scope incomplete")
    worker_id = os.environ.get("V8_OFFICIAL_IMAGE_WORKER_ID", "")
    owner = os.environ.get("V8_OFFICIAL_IMAGE_WORKER_OWNER_ID", "")
    if not re.fullmatch(r"[1-9][0-9]*", owner):
        raise EvidenceReadCredentialError("official image worker owner unavailable")
    try:
        from platform_v8.services.artifact_issuance_receipt import official_image_read_scope
        return official_image_read_scope(receipt, version_id,
                                         worker_id=worker_id, now=now)
    except ValueError as exc:
        raise EvidenceReadCredentialError("official image signed result read scope invalid") from exc


def _resources(purpose: str, *, owner_id: int | None = None,
               publication_id: str | None = None,
               issuance_receipt: dict | None = None,
               object_version_id: str | None = None,
               now: int | None = None) -> list[str]:
    if purpose not in PURPOSES:
        raise EvidenceReadCredentialError("read credential purpose invalid")
    if purpose == "attestor":
        if issuance_receipt is not None or object_version_id is not None:
            raise EvidenceReadCredentialError("unexpected attestor result scope")
        object_pattern = _attestor_source(owner_id, publication_id)
    elif purpose == "official-image":
        if owner_id is not None or publication_id is not None:
            raise EvidenceReadCredentialError("unexpected official image owner scope")
        object_pattern = _official_result(issuance_receipt, object_version_id, now=now)
    else:
        if (owner_id is not None or publication_id is not None
                or issuance_receipt is not None or object_version_id is not None):
            raise EvidenceReadCredentialError("unexpected read credential scope")
        object_pattern = (FILE_RESULT_PATTERN if purpose == "file-result"
                          else (_RESULT if purpose == "media" else _SOURCE))
    patterns = ([object_pattern, FILE_HEALTH_KEY] if purpose == "file-result" else
                [object_pattern, MEDIA_HEALTH_KEY]
                if purpose == "media" or (purpose == "official-image"
                                         and object_pattern != MEDIA_HEALTH_KEY)
                else [object_pattern])
    return [f"qcs::cos:{REGION}:uid/{APP_ID}:{BUCKET}/{pattern}"
            for pattern in patterns]


def _authorization(secret_id: str, secret_key: str, body: bytes, timestamp: int) -> str:
    day = datetime.fromtimestamp(timestamp, timezone.utc).strftime("%Y-%m-%d")
    scope = f"{day}/sts/tc3_request"
    host = "sts.tencentcloudapi.com"
    canonical_request = "\n".join((
        "POST", "/", "",
        "content-type:application/json; charset=utf-8\nhost:" + host + "\n",
        "content-type;host", hashlib.sha256(body).hexdigest(),
    ))
    signing_text = "\n".join(("TC3-HMAC-SHA256", str(timestamp), scope,
                              hashlib.sha256(canonical_request.encode()).hexdigest()))

    def mac(key: bytes, value: str) -> bytes:
        return hmac.new(key, value.encode(), hashlib.sha256).digest()

    signing_key = mac(mac(mac(("TC3" + secret_key).encode(), day), "sts"), "tc3_request")
    signature = hmac.new(signing_key, signing_text.encode(), hashlib.sha256).hexdigest()
    return (f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, "
            f"SignedHeaders=content-type;host, Signature={signature}")


def issue_read_credential(purpose: str, *, owner_id: int | None = None,
                          publication_id: str | None = None,
                          issuance_receipt: dict | None = None,
                          object_version_id: str | None = None,
                          now: int | None = None) -> dict:
    """Return real Tencent STS only; never expose a master key or broad scope."""
    secret_id, secret_key, endpoint = _config()
    resources = _resources(purpose, owner_id=owner_id,
                           publication_id=publication_id,
                           issuance_receipt=issuance_receipt,
                           object_version_id=object_version_id, now=now)
    object_pattern = (_attestor_source(owner_id, publication_id)
                      if purpose == "attestor" else
                      (_official_result(issuance_receipt, object_version_id, now=now)
                       if purpose == "official-image" else
                       (FILE_RESULT_PATTERN if purpose == "file-result" else
                        (_RESULT if purpose == "media" else _SOURCE))))
    timestamp = int(time.time()) if now is None else now
    if type(timestamp) is not int or timestamp <= 0:
        raise EvidenceReadCredentialError("invalid STS request time")
    policy = {"version": "2.0", "statement": [{"effect": "allow",
        "action": list(_READ_ACTIONS), "resource": resources}]}
    role_name = "".join(part.capitalize() for part in purpose.split("-"))
    body = json.dumps({"Name": "qsEv" + role_name + "Read",
        "Policy": json.dumps(policy, separators=(",", ":")),
        "DurationSeconds": TOKEN_TTL}, separators=(",", ":"),
        ensure_ascii=False).encode("utf-8")
    headers = {
        "Authorization": _authorization(secret_id, secret_key, body, timestamp),
        "Content-Type": "application/json; charset=utf-8",
        "Host": "sts.tencentcloudapi.com", "X-TC-Action": "GetFederationToken",
        "X-TC-Version": "2018-08-13", "X-TC-Timestamp": str(timestamp),
        "X-TC-Region": REGION,
    }
    try:
        request = Request("https://sts.tencentcloudapi.com/", data=body,
                          headers=headers, method="POST")
        with build_opener(_NoRedirect()).open(request, timeout=8) as response:
            if response.status != 200:
                raise EvidenceReadCredentialError("COS STS refused read credential")
            raw = response.read(16 * 1024 + 1)
        if len(raw) > 16 * 1024:
            raise EvidenceReadCredentialError("COS STS response too large")
        content = json.loads(raw).get("Response")
        if not isinstance(content, dict) or content.get("Error"):
            raise EvidenceReadCredentialError("COS STS refused read credential")
        credentials = content.get("Credentials")
        if not isinstance(credentials, dict):
            raise EvidenceReadCredentialError("COS STS returned no credential")
        key_id = credentials.get("TmpSecretId")
        key_secret = credentials.get("TmpSecretKey")
        token = credentials.get("Token")
        expires = content.get("ExpiredTime") or credentials.get("ExpiredTime")
        if (not all(isinstance(value, str) and 8 <= len(value) <= 4096
                    for value in (key_id, key_secret, token))
                or type(expires) is not int or not timestamp + 300 <= expires <= timestamp + TOKEN_TTL + 60):
            raise EvidenceReadCredentialError("COS STS returned malformed or long-lived credential")
        response = {"schema": "task-adapter-evidence-read-credential.v1",
                "provider": "cos", "purpose": purpose, "bucket": BUCKET,
                "region": REGION, "endpoint": endpoint,
                "object_pattern": object_pattern,
                "access_key_id": key_id, "access_key_secret": key_secret,
                "session_token": token, "expires_at": expires}
        if purpose == "official-image" and object_version_id is not None:
            response["object_version_id"] = object_version_id
        return response
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, TypeError, KeyError) as exc:
        raise EvidenceReadCredentialError("COS STS read credential unavailable") from exc
