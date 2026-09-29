from __future__ import annotations

import pytest

from platform_v8.services.workloads.submit import (
    SubmitWorkloadError,
    _resolve_submit_execution_model,
    _validate_archive_input,
    input_ref_allowed,
)


def test_input_keys_are_scoped_to_the_submitting_account() -> None:
    assert input_ref_allowed("v8/account-17/input/report.pdf", owner_id=17)
    assert not input_ref_allowed("v8/account-18/input/report.pdf", owner_id=17)
    assert input_ref_allowed("uploads/tenant_17/task_pending/report.pdf", owner_id=17)
    assert not input_ref_allowed("uploads/tenant_18/task_pending/report.pdf", owner_id=17)


def test_file_input_urls_reject_loopback_even_if_configured(monkeypatch) -> None:
    monkeypatch.setenv("EDGE_ALLOWED_INPUT_URL_HOSTS", "localhost,files.example.test")
    assert not input_ref_allowed("http://localhost/file.pdf", owner_id=17)
    assert not input_ref_allowed("https://files.example.test/object.pdf", owner_id=17)


def test_archive_requires_an_account_scoped_object_key() -> None:
    _validate_archive_input(
        input_ref="v8/account-17/input/batch.zip",
        params={},
        owner_id=17,
    )
    with pytest.raises(SubmitWorkloadError, match="archive"):
        _validate_archive_input(
            input_ref="v8/account-18/input/batch.zip",
            params={},
            owner_id=17,
        )


def test_submit_execution_model_from_spec_or_params() -> None:
    assert _resolve_submit_execution_model({}, {}) == ""
    assert (
        _resolve_submit_execution_model({"execution_model": "runtime_v2"}, {})
        == "runtime_v2"
    )
    assert (
        _resolve_submit_execution_model({}, {"execution_model": "runtime-v2"})
        == "runtime_v2"
    )
