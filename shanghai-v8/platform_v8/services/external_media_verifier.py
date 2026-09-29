"""Consume Guangzhou's signed media-verification receipts without media bytes.

The configured HTTPS verifier reads the object directly from storage. Shanghai
sends only an issued object key, bounded recipe/control metadata and a nonce;
it accepts only a purpose-pinned Ed25519 verdict bound to the exact attempt.
No endpoint or signing key is supplied by the worker, author or admin request.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import stat
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit
from uuid import uuid4

import httpx
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

_B64 = re.compile(r"[A-Za-z0-9_-]+={0,2}\Z")
_HEALTH_SCHEMA = "qianshou.external-media-health.v1"
_RESULT_SCHEMA = "qianshou.external-media-result.v1"
_REQUEST_SCHEMA = "qianshou.external-media-request.v1"
_MAX_RESPONSE_BYTES = 16 * 1024


class ExternalVerifierUnavailable(RuntimeError):
    """Network, configuration or unverifiable service response; retry safely."""


class ExternalMediaRejected(ValueError):
    """Trusted service verified that this exact artifact violates the contract."""


@dataclass(frozen=True)
class _Config:
    base_url: str
    token: str
    key_id: str
    public_key: Ed25519PublicKey
    ca_file: str | None


@dataclass(frozen=True)
class MediaPolicy:
    """Reviewed result policy, selected by the signed task contract."""
    input_contract: str
    result_strategy: str
    semantic_scope: str
    formats: tuple[str, ...]
    mime_types: dict[str, str]
    codecs: dict[str, str]
    dimensions: tuple[int, int]
    fps: int
    duration_ms: tuple[int, int]
    recipe_validator: Callable[..., dict[str, Any]]
    observed_validator: Callable[[dict[str, Any], dict[str, Any], dict[str, Any]], bool] | None = None


_MEDIA_POLICIES: dict[tuple[str, str], MediaPolicy] = {}


def register_media_policy(policy: MediaPolicy) -> None:
    """Only platform code may load a new independently verifiable policy."""
    if (not isinstance(policy, MediaPolicy) or not policy.input_contract
            or not policy.result_strategy or not policy.semantic_scope
            or not policy.formats or set(policy.formats) != set(policy.mime_types)
            or set(policy.formats) != set(policy.codecs)
            or not callable(policy.recipe_validator)
            or (policy.input_contract, policy.result_strategy) in _MEDIA_POLICIES):
        raise ValueError("media verification policy invalid or duplicate")
    _MEDIA_POLICIES[(policy.input_contract, policy.result_strategy)] = policy


def _reviewed_policy(task_type: str, spec: Any = None) -> MediaPolicy | None:
    if spec is None:
        from platform_v8.engine.task_registry import TASK_REGISTRY
        spec = TASK_REGISTRY.get(task_type)
    if (spec is None or getattr(spec, "task_type", None) != task_type
            or not (getattr(spec, "requires_verified_adapter", False)
                    or getattr(spec, "official_provider_id", "") ==
                    "qianshou:official-image-generation-v1")
            or not getattr(spec, "external_artifact_verifier_required", False)
            or getattr(spec, "adapter_output_kind", None) != "artifact_ref"):
        return None
    return _MEDIA_POLICIES.get((getattr(spec, "adapter_input_contract", ""),
                                getattr(spec, "adapter_result_strategy", "")))


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _decode(value: str, length: int) -> bytes:
    if not isinstance(value, str) or len(value) > 128 or not _B64.fullmatch(value):
        raise ValueError("invalid signature encoding")
    data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    if len(data) != length:
        raise ValueError("invalid signature length")
    return data


def _config() -> _Config | None:
    base = os.environ.get("V8_EXTERNAL_MEDIA_VERIFIER_URL", "").rstrip("/")
    token = os.environ.get("V8_EXTERNAL_MEDIA_VERIFIER_TOKEN", "")
    key = os.environ.get("V8_EXTERNAL_MEDIA_VERIFIER_PUBLIC_KEY", "")
    key_id = os.environ.get("V8_EXTERNAL_MEDIA_VERIFIER_KEY_ID", "")
    ca_file = os.environ.get("V8_EXTERNAL_MEDIA_VERIFIER_CA_FILE", "").strip()
    try:
        parsed = urlsplit(base)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username
                or parsed.password or parsed.query or parsed.fragment or len(base) > 1024
                or len(token) < 32 or len(token) > 2048
                or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", key_id)):
            return None
        if ca_file:
            path = Path(ca_file)
            metadata = path.lstat()
            if (not path.is_absolute() or not stat.S_ISREG(metadata.st_mode)
                    or (metadata.st_mode & 0o777) not in {0o600, 0o644}
                    or not 1 <= metadata.st_size <= 1024 * 1024):
                return None
        return _Config(base, token, key_id,
                       Ed25519PublicKey.from_public_bytes(_decode(key, 32)),
                       ca_file or None)
    except (OSError, ValueError, TypeError):
        return None


def _post(config: _Config, path: str, body: dict[str, Any]) -> dict[str, Any]:
    try:
        with httpx.Client(timeout=10.0, follow_redirects=False, trust_env=False,
                          verify=config.ca_file or True) as client:
            response = client.post(
                config.base_url + path,
                headers={"Authorization": "Bearer " + config.token,
                         "Content-Type": "application/json", "Accept": "application/json"},
                content=_canonical(body),
            )
        if response.status_code != 200 or len(response.content) > _MAX_RESPONSE_BYTES:
            raise ExternalVerifierUnavailable("Guangzhou media verifier unavailable")
        data = response.json()
        if not isinstance(data, dict):
            raise ValueError("response is not an object")
        return data
    except (httpx.HTTPError, json.JSONDecodeError, ValueError) as exc:
        raise ExternalVerifierUnavailable("Guangzhou media verifier unavailable") from exc


def _signed_payload(config: _Config, response: dict[str, Any], *, schema: str,
                    nonce: str) -> dict[str, Any]:
    try:
        if response.get("key_id") != config.key_id:
            raise ValueError("wrong verifier key")
        payload = response["payload"]
        if not isinstance(payload, dict) or len(_canonical(payload)) > _MAX_RESPONSE_BYTES:
            raise ValueError("invalid payload")
        config.public_key.verify(_decode(response["signature"], 64), _canonical(payload))
        now = int(time.time())
        issued = payload.get("issued_at")
        expires = payload.get("expires_at")
        if (payload.get("schema") != schema or payload.get("nonce") != nonce
                or not isinstance(issued, int) or isinstance(issued, bool)
                or not isinstance(expires, int) or isinstance(expires, bool)
                or issued > now + 30 or expires <= now or expires - issued > 60):
            raise ValueError("stale or unbound verifier response")
        return payload
    except (KeyError, TypeError, ValueError, InvalidSignature) as exc:
        raise ExternalVerifierUnavailable("Guangzhou media receipt signature invalid") from exc


def available(task_type: str, spec: Any = None) -> bool:
    """Live, signed challenge: configuration alone never makes intake ready."""
    policy = _reviewed_policy(task_type, spec)
    if policy is None:
        return False
    config = _config()
    if config is None:
        return False
    nonce = str(uuid4())
    try:
        response = _post(config, "/native-h3/result/health" if policy.input_contract == "h3-prompt-fixed-frame.v1" else "/health", {"schema": _REQUEST_SCHEMA,
                                               "kind": "health", "nonce": nonce,
                                               "task_type": task_type})
        payload = _signed_payload(config, response, schema=_HEALTH_SCHEMA, nonce=nonce)
        return (payload.get("task_type") == task_type
                and payload.get("status") == "ready"
                and payload.get("result_contract") == "artifact.v1"
                and payload.get("semantic_scope") == policy.semantic_scope
                and set(payload.get("formats") or []) >= set(policy.formats))
    except (ExternalVerifierUnavailable, TypeError, ValueError):
        return False


def publication_attest(body: dict[str, Any]) -> dict[str, Any]:
    """Ask Guangzhou to re-read locked samples and sign media publication evidence.

    Only control metadata assembled from Shanghai's persisted review leases is
    sent. A 409 is a real independent rejection, never a receipt to synthesize.
    """
    config = _config()
    if config is None:
        raise ExternalVerifierUnavailable("Guangzhou publication verifier is not configured")
    encoded = _canonical(body)
    if len(encoded) > 48 * 1024:
        raise ExternalMediaRejected("publication evidence metadata is too large")
    try:
        with httpx.Client(timeout=90.0, follow_redirects=False, trust_env=False,
                          verify=config.ca_file or True) as client:
            response = client.post(
                config.base_url + "/publication-attest",
                headers={"Authorization": "Bearer " + config.token,
                         "Content-Type": "application/json", "Accept": "application/json"},
                content=encoded,
            )
        if len(response.content) > 16 * 1024:
            raise ExternalVerifierUnavailable("Guangzhou publication response is too large")
        if response.status_code == 409:
            raise ExternalMediaRejected("Guangzhou independently rejected publication samples")
        if response.status_code != 200:
            raise ExternalVerifierUnavailable("Guangzhou publication verifier unavailable")
        report = response.json()
        if (not isinstance(report, dict) or report.get("status") != "passed"
                or not isinstance(report.get("receipt"), dict)):
            raise ExternalVerifierUnavailable("Guangzhou publication receipt missing")
        return report["receipt"]
    except (httpx.HTTPError, json.JSONDecodeError, ValueError) as exc:
        if isinstance(exc, (ExternalMediaRejected, ExternalVerifierUnavailable)):
            raise
        raise ExternalVerifierUnavailable("Guangzhou publication verifier unavailable") from exc


def verify(
    *, task_type: str, account_id: int, workload_id: str, shard_id: str,
    worker_id: str, attempt: int, artifact: dict[str, Any],
    recipe: str, output_format: str, include_raw_receipt: bool = False,
    reviewed_spec: Any = None,
) -> dict[str, Any]:
    """Return verified receipt metadata or reject; never fetch the object."""
    policy = _reviewed_policy(task_type, reviewed_spec)
    config = _config()
    if policy is None or config is None:
        raise ExternalVerifierUnavailable("Guangzhou media verifier is not configured")
    if output_format not in policy.formats:
        raise ExternalMediaRejected("unsupported media format")
    expected_mime = policy.mime_types[output_format]
    if artifact.get("content_type") != expected_mime:
        raise ExternalMediaRejected("artifact MIME type does not match requested output")
    if not isinstance(recipe, str) or len(recipe.encode("utf-8")) > (32 * 1024 if policy.input_contract == "h3-prompt-fixed-frame.v1" else 16 * 1024):
        raise ExternalMediaRejected("recipe is missing or too large")
    try:
        validated_recipe = policy.recipe_validator(input_kind="inline", inline_input=recipe,
                                                   params={"output_format": output_format})
    except ValueError as exc:
        raise ExternalMediaRejected("persisted media recipe is invalid") from exc
    recipe_sha256 = hashlib.sha256(recipe.encode("utf-8")).hexdigest()
    nonce = str(uuid4())
    object_version_id = artifact.get("object_version_id")
    if (not isinstance(object_version_id, str)
            or not re.fullmatch(r"[A-Za-z0-9_.~+-]{1,200}", object_version_id)
            or object_version_id == "null"):
        raise ExternalMediaRejected("exact media object version is missing")
    bound = {
        "task_type": task_type, "account_id": account_id,
        "workload_id": workload_id, "shard_id": shard_id,
        "worker_id": worker_id, "attempt": attempt,
        "object_key": artifact["object_key"],
        "object_version_id": object_version_id,
        "result_id": artifact["result_id"],
        "sha256": artifact["sha256"], "size_bytes": artifact["size_bytes"],
        "content_type": expected_mime, "output_format": output_format,
        "recipe_sha256": recipe_sha256,
    }
    verify_request = {"schema": _REQUEST_SCHEMA, "kind": "verify", "nonce": nonce,
                      **bound, "recipe": recipe}
    response = _post(config, "/native-h3/result/verify" if policy.input_contract == "h3-prompt-fixed-frame.v1" else "/verify", verify_request)
    payload = _signed_payload(config, response, schema=_RESULT_SCHEMA, nonce=nonce)
    if any(payload.get(key) != value for key, value in bound.items()):
        raise ExternalVerifierUnavailable("Guangzhou media receipt binding mismatch")
    if payload.get("result") == "fail":
        raise ExternalMediaRejected("Guangzhou media verifier rejected artifact")
    if payload.get("result") != "pass":
        raise ExternalVerifierUnavailable("Guangzhou media verdict missing")
    observed = payload.get("observed")
    codec = policy.codecs[output_format]
    receipt_id = payload.get("receipt_id")
    if (not isinstance(receipt_id, str) or not 1 <= len(receipt_id) <= 128
            or not isinstance(observed, dict)
            or observed.get("sha256") != artifact["sha256"]
            or observed.get("size_bytes") != artifact["size_bytes"]
            or observed.get("content_type") != expected_mime
            or observed.get("container_valid") is not True):
        raise ExternalVerifierUnavailable("Guangzhou media receipt lacks required checks")
    if policy.observed_validator is not None:
        if not policy.observed_validator(observed, artifact, validated_recipe):
            raise ExternalVerifierUnavailable("Guangzhou media receipt lacks image checks")
    elif (observed.get("decoded_frames_verified") is not True
            or observed.get("recipe_semantics_verified") is not True
            or observed.get("animation_semantics_verified") is not True
            or observed.get("text_semantics_verified") is not True
            or observed.get("codec") != codec
            or observed.get("width") != policy.dimensions[0]
            or observed.get("height") != policy.dimensions[1]
            or observed.get("fps") != policy.fps
            or not isinstance(observed.get("duration_ms"), int)
            or not policy.duration_ms[0] <= observed["duration_ms"] <= policy.duration_ms[1]):
        raise ExternalVerifierUnavailable("Guangzhou media receipt lacks required checks")
    result = {"receipt_id": receipt_id, "key_id": config.key_id,
              "receipt_sha256": hashlib.sha256(_canonical(payload)).hexdigest(),
              "observed": observed}
    if include_raw_receipt:
        # Only this internal review-sample path stores the authenticated,
        # bounded control request and Guangzhou's original signed response.
        # Neither item contains the GIF/MP4 bytes or a presigned storage URL.
        result["verify_request"] = verify_request
        result["verify_receipt"] = response
    return result


from platform_v8.services.workloads.reviewed_media_contract import validate_bar_chart_svg_order

register_media_policy(MediaPolicy(
    input_contract="bar-chart-svg-order.v1",
    result_strategy="external-media.v1",
    semantic_scope="full-recipe-v1",
    formats=("gif", "mp4"),
    mime_types={"gif": "image/gif", "mp4": "video/mp4"},
    codecs={"gif": "gif", "mp4": "h264"},
    dimensions=(640, 360), fps=20, duration_ms=(1000, 5000),
    recipe_validator=validate_bar_chart_svg_order,
))


def _static_image_observed(observed: dict[str, Any], artifact: dict[str, Any],
                           recipe: dict[str, Any]) -> bool:
    del artifact
    width, height = map(int, recipe["size"].split("x"))
    return (set(observed) == {"sha256", "size_bytes", "content_type", "container_valid",
                             "decoded_pixels_verified", "requested_dimensions_verified",
                             "prompt_semantics_verified", "codec", "width", "height"}
            and observed.get("decoded_pixels_verified") is True
            and observed.get("requested_dimensions_verified") is True
            and observed.get("prompt_semantics_verified") is False
            and observed.get("codec") == "png"
            and observed.get("width") == width
            and observed.get("height") == height)


from platform_v8.services.workloads.official_image_admission import validate_order

register_media_policy(MediaPolicy(
    input_contract="official-image-prompt.v1",
    result_strategy="external-media.v1",
    semantic_scope="decoded-static-image-v1",
    formats=("png",), mime_types={"png": "image/png"},
    codecs={"png": "png"}, dimensions=(0, 0), fps=0,
    duration_ms=(0, 0), recipe_validator=validate_order,
    observed_validator=_static_image_observed,
))


from platform_v8.protocol.native_h3 import validate_recipe as validate_native_h3_recipe

def _native_h3_observed(observed, artifact, recipe):
    return (observed.get("decoded_frames_verified") is True
        and observed.get("prompt_semantics_verified") is False
        and observed.get("codec") in {"h264","hevc","av1"}
        and type(observed.get("duration_ms")) is int and 4800<=observed["duration_ms"]<=5300
        and type(observed.get("width")) is int and 16<=observed["width"]<=4096
        and type(observed.get("height")) is int and 16<=observed["height"]<=4096)

register_media_policy(MediaPolicy(input_contract="h3-prompt-fixed-frame.v1",result_strategy="external-media.v1",
    semantic_scope="decoded-native-h3-v1",formats=("mp4",),mime_types={"mp4":"video/mp4"},
    codecs={"mp4":"h264"},dimensions=(0,0),fps=0,duration_ms=(4800,5300),
    recipe_validator=validate_native_h3_recipe,observed_validator=_native_h3_observed))
