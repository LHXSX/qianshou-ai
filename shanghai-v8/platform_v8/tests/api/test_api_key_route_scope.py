"""A long-lived developer key must not become an account-wide access token."""

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException
from starlette.requests import Request

from platform_v8.api.deps import get_current_account


def _request(path: str) -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": path,
            "scheme": "https",
            "server": ("example.test", 443),
            "headers": [],
        }
    )


@pytest.mark.parametrize(
    "path",
    [
        "/api/v8/auth/me",
        "/api/v8/workloads",
        "/api/v8/workers",
        "/api/v8/developer/keys",
    ],
)
def test_developer_key_cannot_authenticate_unscoped_routes(path: str) -> None:
    session = Mock()
    with (
        patch("platform_v8.api.deps._enforce_api_key_burst_limit"),
        patch("platform_v8.api.deps.ApiKeyRepo.resolve_key") as resolve,
        pytest.raises(HTTPException) as error,
    ):
        get_current_account(_request(path), authorization="Bearer qs_test-secret", session=session)

    assert error.value.status_code == 403
    resolve.assert_not_called()
    session.commit.assert_not_called()


@pytest.mark.parametrize("path", ["/api/v8/developer/tasks", "/api/v8/files/upload-url"])
def test_developer_key_is_resolved_for_scoped_routes(path: str) -> None:
    session = Mock()
    account = SimpleNamespace(
        id=17,
        is_active=True,
        role=SimpleNamespace(value="user"),
    )
    request = _request(path)
    with (
        patch("platform_v8.api.deps._enforce_api_key_burst_limit"),
        patch("platform_v8.api.deps.ApiKeyRepo.resolve_key", return_value=(account, ["files", "workloads"])) as resolve,
    ):
        assert get_current_account(request, authorization="Bearer qs_test-secret", session=session) is account

    resolve.assert_called_once()
    assert request.state.auth_via == "api_key"
    assert request.state.account_id == 17
    session.commit.assert_called_once()
