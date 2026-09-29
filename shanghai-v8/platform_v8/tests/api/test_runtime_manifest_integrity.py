"""R-1 · Runtime manifest revision + content_sha256（不验签）。"""
from __future__ import annotations

import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.api.v8.bundles import (
    attach_manifest_integrity,
    canonical_manifest_digest,
    verify_manifest_content_sha256,
)


def _sample_body() -> dict:
    return {
        "ok": True,
        "platform": "macos-arm64",
        "schema_version": "6",
        "tiers": {"lite": {"packages": ["pillow"], "software": ["pillow"]}},
        "mirrors": [{"label": "x", "index_url": "https://example.test/simple"}],
    }


def test_attach_manifest_integrity_sets_revision_and_digest():
    out = attach_manifest_integrity(_sample_body())
    assert len(out["content_sha256"]) == 64
    assert out["revision"] == out["content_sha256"]
    assert out["content_sha256"] == canonical_manifest_digest(out)
    ok, reason = verify_manifest_content_sha256(out)
    assert ok is True
    assert reason is None


def test_digest_changes_when_tiers_mutate():
    a = attach_manifest_integrity(_sample_body())
    mutated = dict(_sample_body())
    mutated["tiers"] = {"lite": {"packages": ["pillow", "numpy"], "software": ["pillow"]}}
    b = attach_manifest_integrity(mutated)
    assert a["content_sha256"] != b["content_sha256"]
    assert a["revision"] != b["revision"]


def test_tampered_body_fails_verify():
    out = attach_manifest_integrity(_sample_body())
    out["tiers"]["lite"]["packages"] = ["evil"]
    ok, reason = verify_manifest_content_sha256(out)
    assert ok is False
    assert reason and "mismatch" in reason


def test_missing_digest_warns_but_ok():
    body = _sample_body()
    ok, reason = verify_manifest_content_sha256(body)
    assert ok is True
    assert reason == "missing content_sha256"


def test_tbd_digest_warns_but_ok():
    body = {**_sample_body(), "content_sha256": "TBD"}
    ok, reason = verify_manifest_content_sha256(body)
    assert ok is True
    assert reason == "placeholder content_sha256"
