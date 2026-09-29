"""Offline regression for the two public-release route gates.

No database, provider request, payout, or production service is touched.
"""

from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.responses import StreamingResponse
from fastapi.testclient import TestClient

from platform_v8.api.deps import get_current_account, get_session
from platform_v8.api.v8 import ai, demo, economy
from platform_v8.services.ai import guard as ai_guard
from platform_v8.services.ai import tools as ai_tools
from platform_v8.services.economy import settlement


def _client(*routers, account=None):
    app = FastAPI()
    for router in routers:
        app.include_router(router)
    # Prevent even an auth failure from opening the production database.
    app.dependency_overrides[get_session] = lambda: object()
    if account is not None:
        app.dependency_overrides[get_current_account] = lambda: account
    return TestClient(app)


@pytest.mark.parametrize("authorization", [None, "Bearer invalid"])
def test_legacy_ai_rejects_unauthenticated_without_llm_call(monkeypatch, authorization):
    monkeypatch.setenv("V8_JWT_SECRET", "offline-test-secret-longer-than-32-characters")
    calls = []

    async def forbidden_llm(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("unauthenticated request reached LLM")

    monkeypatch.setattr(ai, "_call_llm", forbidden_llm)
    client = _client(ai.router)
    headers = {"Authorization": authorization} if authorization else {}
    response = client.post(
        "/api/v8/ai/pipeline/chat",
        headers=headers,
        json={"messages": [{"role": "user", "content": "hello"}]},
    )
    assert response.status_code == 401
    assert calls == []


def test_legacy_ai_authenticated_request_preserves_sse(monkeypatch):
    account = SimpleNamespace(id=7)
    seen = {}

    async def fake_agent_chat(request, current):
        seen["account"] = current
        seen["body"] = await request.json()

        async def chunks():
            yield 'data: {"stage":"done"}\n\n'

        return StreamingResponse(chunks(), media_type="text/event-stream")

    monkeypatch.setattr(ai, "agent_chat", fake_agent_chat)
    client = _client(ai.router, account=account)
    response = client.post(
        "/api/v8/ai/pipeline/chat",
        json={"stream": False, "messages": [{"role": "user", "content": "hello"}]},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert seen["account"] is account
    assert seen["body"]["stream"] is True


def test_legacy_ai_authenticated_agent_path_uses_mock_provider(monkeypatch):
    account = SimpleNamespace(id=7, username="offline", role="personal", balance=0)
    calls = []

    async def fake_context(_current):
        return {}

    async def fake_llm(messages, tools, model):
        calls.append({"messages": messages, "tools": tools, "model": model})
        return {"choices": [{"message": {"content": "offline reply"}}]}

    monkeypatch.setattr(ai, "_build_ai_context_brief", fake_context)
    monkeypatch.setattr(ai, "_call_llm", fake_llm)
    monkeypatch.setattr(ai_tools, "get_tools_for_user", lambda _role: [])
    monkeypatch.setattr(ai_guard, "guard_user_prompt", lambda *_args: (True, None))
    monkeypatch.setattr(ai_guard, "sanitize_output", lambda value: value)
    client = _client(ai.router, account=account)
    response = client.post(
        "/api/v8/ai/pipeline/chat",
        json={"stream": False, "messages": [{"role": "user", "content": "hello"}]},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/event-stream")
    assert "offline reply" in response.text
    assert len(calls) == 1


def test_old_withdraw_returns_gone_without_writing_ledger(monkeypatch):
    calls = []

    def forbidden_withdraw(*args, **kwargs):
        calls.append((args, kwargs))
        raise AssertionError("old withdrawal endpoint reached settlement")

    monkeypatch.setattr(settlement, "request_withdraw", forbidden_withdraw)
    client = _client(economy.router, account=SimpleNamespace(id=7))
    response = client.post(
        "/api/v8/economy/withdraw",
        json={"amount": "9.99", "note": "offline test"},
    )
    assert response.status_code == 410
    assert calls == []


def test_old_withdraw_still_requires_authentication():
    client = _client(economy.router)
    response = client.post("/api/v8/economy/withdraw", json={"amount": "9.99"})
    assert response.status_code == 401


def _post_demo(client, path):
    if path.endswith("/from-images"):
        return client.post(path, files={"files": ("page.png", b"offline-image", "image/png")})
    return client.post(path, json={"text": "offline case text"})


@pytest.mark.parametrize("path", [
    "/api/v8/demo/case-digest",
    "/api/v8/demo/case-digest/from-images",
])
def test_demo_ai_anonymous_cannot_run_script(monkeypatch, path):
    monkeypatch.setenv("V8_DEMO_AI_POST_ENABLED", "1")
    monkeypatch.setenv("AI_SCRIPT_API_KEY", "offline-test-only")

    def forbidden_script(*_args, **_kwargs):
        raise AssertionError("anonymous demo request launched script")

    monkeypatch.setattr(demo, "_run_script", forbidden_script)
    response = _post_demo(_client(demo.router), path)
    assert response.status_code == 401


@pytest.mark.parametrize("path", [
    "/api/v8/demo/case-digest",
    "/api/v8/demo/case-digest/from-images",
])
def test_demo_ai_stays_closed_by_default_even_when_logged_in(monkeypatch, path):
    monkeypatch.delenv("V8_DEMO_AI_POST_ENABLED", raising=False)
    monkeypatch.setenv("AI_SCRIPT_API_KEY", "offline-test-only")

    def forbidden_script(*_args, **_kwargs):
        raise AssertionError("disabled demo request launched script")

    monkeypatch.setattr(demo, "_run_script", forbidden_script)
    client = _client(demo.router, account=SimpleNamespace(id=7))
    response = _post_demo(client, path)
    assert response.status_code == 503
    status = client.get("/api/v8/demo/case-digest/status")
    assert status.json()["ai_ready"] is False
    assert status.json()["enabled"] is False


@pytest.mark.parametrize("path", [
    "/api/v8/demo/case-digest",
    "/api/v8/demo/case-digest/from-images",
])
def test_demo_ai_explicit_opt_in_uses_mock_script(monkeypatch, path):
    monkeypatch.setenv("V8_DEMO_AI_POST_ENABLED", "1")
    monkeypatch.setenv("AI_SCRIPT_API_KEY", "offline-test-only")
    monkeypatch.setattr(demo, "_ocr_available", lambda: True)
    calls = []

    def fake_script(script, **kwargs):
        calls.append(script.name)
        if script.name == "ocr_image.py":
            return {"status": "ok", "result_text": "offline OCR", "summary": {}}
        return {"status": "ok", "summary": {}, "digest": {}, "summary_text": "done"}

    monkeypatch.setattr(demo, "_run_script", fake_script)
    client = _client(demo.router, account=SimpleNamespace(id=7))
    response = _post_demo(client, path)
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert calls == (["ocr_image.py", "case_digest.py"] if path.endswith("/from-images")
                     else ["case_digest.py"])
