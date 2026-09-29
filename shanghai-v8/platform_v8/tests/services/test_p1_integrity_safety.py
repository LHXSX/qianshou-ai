from __future__ import annotations

import time

from platform_v8.services.economy.ledger import settlement_round_key
from platform_v8.services.oss_provider import sign_local_object, verify_local_object_sig
from platform_v8.services.url_safety import redact_url, safe_transport_error


def test_round_keys_are_distinct_per_resume() -> None:
    assert settlement_round_key("refund", "workload", 0) == "refund:workload"
    assert settlement_round_key("refund", "workload", 2) == "refund:workload:r2"


def test_local_signature_binds_upload_size(monkeypatch) -> None:
    monkeypatch.setenv("V8_LOCAL_OSS_SECRET", "integrity-test-private-secret-over-thirty-two-bytes")
    expires = int(time.time()) + 60
    token = sign_local_object("PUT", "v8/account-1/input/a.bin", expires, 123)
    assert verify_local_object_sig(
        "PUT", "v8/account-1/input/a.bin", expires, token, 123,
    )
    assert not verify_local_object_sig(
        "PUT", "v8/account-1/input/a.bin", expires, token, 124,
    )


def test_redact_url_removes_presigned_query() -> None:
    secret = "Signature=highly-sensitive-token"
    value = f"https://bucket.example/object.txt?{secret}&Expires=123"
    assert redact_url(value) == "https://bucket.example/object.txt?<redacted>"
    assert secret not in redact_url(value)


def test_transport_error_is_url_free() -> None:
    class ErrorWithResponse(Exception):
        response = type("Response", (), {"status_code": 403})()

    assert safe_transport_error(ErrorWithResponse()) == "object storage HTTP 403"
