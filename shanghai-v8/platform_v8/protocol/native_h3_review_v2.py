"""Exact v2 signatures bind path-free publication identity and one device configuration revision."""
from __future__ import annotations
import hashlib
import re
from .native_h3_review import raw, sign, signed, fresh
from .native_h3 import canonical, validate_order

TUPLE = ("publication_id", "owner_id", "device_id", "task_type", "capability_id", "contract_version",
         "contract_sha256", "artifact_digest", "source_digest", "logical_binding_sha256",
         "local_owner_config_digest", "device_binding_revision")
CHALLENGE_SCHEMA = "qianshou.native-h3-review-challenge.v2"
CHALLENGE_PURPOSE = "qianshou:native-h3-review-challenge.v2"
EXECUTION_SCHEMA = "qianshou.native-h3-review-execution.v2"
EXECUTION_PURPOSE = "qianshou:native-h3-review-execution.v2"
CHALLENGE_FIELDS = {"schema", "purpose", *TUPLE, "challenge_nonce", "challenge_input",
                    "challenge_input_sha256", "issued_at", "expires_at"}
EXECUTION_FIELDS = {"schema", "purpose", *TUPLE, "challenge_nonce", "challenge_input_sha256",
                    "challenge_result_sha256", "artifact", "issued_at", "expires_at"}
ARTIFACT_FIELDS = {"schema", "object_key", "object_version_id", "filename", "size_bytes",
                   "content_type", "sha256", "result_id"}


def validate_tuple(p):
    if (p.get("contract_version") != "v2" or p.get("capability_id") != "video.render"
            or type(p.get("owner_id")) is not int or not 1 <= p["owner_id"] <= 9007199254740991
            or type(p.get("device_binding_revision")) is not int
            or not 1 <= p["device_binding_revision"] <= 9007199254740991
            or any(not isinstance(p.get(k), str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", p[k])
                   for k in ("artifact_digest", "source_digest", "local_owner_config_digest"))
            or p["artifact_digest"] != p["source_digest"]
            or any(not isinstance(p.get(k), str) or not re.fullmatch(r"[0-9a-f]{64}", p[k])
                   for k in ("contract_sha256", "logical_binding_sha256"))):
        raise ValueError("native H3 v2 private revision or public tuple invalid")
    return p


def challenge(envelope, expected, roots, *, now):
    p = signed(envelope, roots, CHALLENGE_FIELDS)
    fresh(p, now=now)
    validate_tuple(p)
    if (p["schema"] != CHALLENGE_SCHEMA or p["purpose"] != CHALLENGE_PURPOSE
            or any(p[k] != expected[k] for k in TUPLE)
            or not isinstance(p["challenge_nonce"], str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", p["challenge_nonce"])):
        raise ValueError("native H3 v2 challenge binding mismatch")
    raw(p["challenge_nonce"], 32)
    recipe = p["challenge_input"]
    if not isinstance(recipe, dict) or set(recipe) - {"prompt", "seconds", "seed"} or "prompt" not in recipe:
        raise ValueError("native H3 v2 input invalid")
    validated = validate_order(input_kind="inline", inline_input=recipe["prompt"],
                               params={k: v for k, v in recipe.items() if k != "prompt"})
    if validated != recipe or p["challenge_input_sha256"] != hashlib.sha256(canonical(recipe)).hexdigest():
        raise ValueError("native H3 v2 input digest mismatch")
    return p


def execution(envelope, plan, roots, *, now):
    p = signed(envelope, roots, EXECUTION_FIELDS)
    fresh(p, now=now)
    validate_tuple(p)
    if (p["schema"] != EXECUTION_SCHEMA or p["purpose"] != EXECUTION_PURPOSE
            or any(p[k] != plan[k] for k in (*TUPLE, "challenge_nonce", "challenge_input_sha256"))
            or p["expires_at"] > plan["expires_at"] or p["issued_at"] < plan["issued_at"] - 60
            or not isinstance(p["artifact"], dict) or set(p["artifact"]) != ARTIFACT_FIELDS
            or p["artifact"]["filename"] != "result.mp4"
            or p["challenge_result_sha256"] != hashlib.sha256(canonical(p["artifact"])).hexdigest()):
        raise ValueError("native H3 v2 execution binding mismatch")
    return p
