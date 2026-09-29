from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from platform_v8.api.v8.ws import (
    _persist_shard_progress,
    _resolve_strict_result_attempt,
)
from platform_v8.core import ShardMode, ShardStatus
from platform_v8.protocol.ws_schema import ShardProgressPayload, ShardResultPayload


def _shard(*, worker_id: str = "worker-1", attempt: int = 2):
    return SimpleNamespace(
        id="shard-1",
        workload_id="workload-1",
        status=ShardStatus.RUNNING,
        worker_id=worker_id,
        lease_by_node=worker_id,
        lease_expires_at=datetime(2026, 8, 12, 6, 0),
        attempts=attempt,
        mode=ShardMode.PULL,
        metadata={"timeout_s": 900},
    )


def _workload():
    return SimpleNamespace(
        owner_id=7,
        spec=SimpleNamespace(
            task_type="pdf_ocr",
            timeout_s=900,
            code_url="",
            params={},
        ),
    )


@pytest.mark.parametrize(
    ("worker_id", "payload_attempt"),
    [("stale-worker", 2), ("worker-1", 1)],
)
def test_stale_worker_or_attempt_progress_never_touches_lease(
    worker_id: str,
    payload_attempt: int,
):
    session = MagicMock()

    @contextmanager
    def _scope():
        yield session

    payload = ShardProgressPayload(
        shard_id="shard-1",
        pct=0.5,
        attempt=payload_attempt,
        lease_token="signed",
    )
    touch = MagicMock(return_value=True)
    with patch("platform_v8.storage.db.session_scope", _scope), patch(
        "platform_v8.storage.repo.ShardRepo.by_id",
        return_value=_shard(),
    ), patch(
        "platform_v8.storage.repo.ShardRepo.touch_progress", touch
    ):
        assert _persist_shard_progress(payload, worker_id) is None

    touch.assert_not_called()
    session.commit.assert_not_called()


def test_valid_pull_progress_verifies_token_and_renews_effective_lease():
    session = MagicMock()

    @contextmanager
    def _scope():
        yield session

    payload = ShardProgressPayload(
        shard_id="shard-1",
        pct=0.5,
        attempt=2,
        lease_token="signed",
    )
    touch = MagicMock(return_value=True)
    with patch("platform_v8.storage.db.session_scope", _scope), patch(
        "platform_v8.storage.repo.ShardRepo.by_id",
        return_value=_shard(),
    ), patch(
        "platform_v8.storage.repo.WorkloadRepo.by_id",
        return_value=_workload(),
    ), patch(
        "platform_v8.services.artifact_lease.verify_lease_token",
        return_value=True,
    ) as verify, patch(
        "platform_v8.storage.repo.ShardRepo.touch_progress", touch
    ):
        assert _persist_shard_progress(payload, "worker-1") == 7

    verify.assert_called_once_with(
        "signed",
        shard_id="shard-1",
        worker_id="worker-1",
        attempt=2,
    )
    assert touch.call_args.kwargs["lease_seconds"] == 945
    session.commit.assert_called_once()


def test_invalid_progress_credential_is_not_persisted():
    session = MagicMock()

    @contextmanager
    def _scope():
        yield session

    invalid = ShardProgressPayload(
        shard_id="shard-1",
        pct=0.2,
        attempt=2,
        lease_token="invalid",
    )
    touch = MagicMock(return_value=True)
    with patch("platform_v8.storage.db.session_scope", _scope), patch(
        "platform_v8.storage.repo.ShardRepo.by_id",
        return_value=_shard(),
    ), patch(
        "platform_v8.services.artifact_lease.verify_lease_token",
        return_value=False,
    ), patch(
        "platform_v8.storage.repo.ShardRepo.touch_progress", touch
    ):
        assert _persist_shard_progress(invalid, "worker-1") is None

    touch.assert_not_called()
    session.commit.assert_not_called()


def test_modern_failed_result_with_wrong_token_has_no_bound_attempt():
    session = MagicMock()

    @contextmanager
    def _scope():
        yield session

    payload = ShardResultPayload(
        shard_id="shard-1",
        ok=False,
        error="failed",
        lease_token="wrong",
    )
    with patch("platform_v8.storage.db.session_scope", _scope), patch(
        "platform_v8.storage.repo.ShardRepo.by_id",
        return_value=_shard(),
    ), patch(
        "platform_v8.services.artifact_lease.verify_lease_token",
        return_value=False,
    ) as verify:
        assert _resolve_strict_result_attempt(payload, "worker-1") is None

    verify.assert_called_once_with(
        "wrong",
        shard_id="shard-1",
        worker_id="worker-1",
        attempt=2,
    )


@pytest.mark.parametrize(
    "metadata",
    [
        {"worker_id": "other"},
        {"workload_id": "other"},
        {"attempt": 1},
    ],
)
def test_strict_result_client_metadata_must_match_current_assignment(metadata):
    session = MagicMock()

    @contextmanager
    def _scope():
        yield session

    payload = ShardResultPayload(
        shard_id="shard-1",
        ok=False,
        lease_token="signed",
        **metadata,
    )
    with patch("platform_v8.storage.db.session_scope", _scope), patch(
        "platform_v8.storage.repo.ShardRepo.by_id",
        return_value=_shard(),
    ), patch(
        "platform_v8.services.artifact_lease.verify_lease_token",
        return_value=True,
    ) as verify:
        assert _resolve_strict_result_attempt(payload, "worker-1") is None

    verify.assert_not_called()
