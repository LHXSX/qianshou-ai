"""平台 LLM 中继凭据注入 + /api/v1 鉴权的回归锁 (离线 · 不访问外网)。

背景 (2026-09-18 · C-1 生产安全修复):
    `POST /api/v1/chat/completions` 与 `POST /api/v1/embeddings` 此前**完全免鉴权**，
    与同功能的 `/api/v8/chat/completions`（要求 get_current_account）不一致。
    实测：无凭证 POST 空 body → 400 VALIDATION_ERROR（穿过了鉴权层）；
    带 body → 200 真出 LLM 结果。等于任何人可拿平台密钥白嫖。

本测试锁三件事：
  1. 两个 v1 端点**必须**带 `Depends(get_current_account)` —— 拿掉就红；
  2. 限流键**不得**再取客户端可伪造的 `X-Forwarded-For` 首值 —— 改回去就红；
  3. 凭据注入**只在**任务确实会打平台地址时发生 —— 误注入给第三方就红
     （那是比原漏洞更严重的凭据外泄）。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from platform_v8.engine.platform_relay_credential import (
    RELAY_CREDENTIAL_ENV,
    _RELAY_TASK_TYPES,
    inject_platform_relay_credential,
    is_platform_host,
    relays_via_platform,
)

REPO = Path(__file__).resolve().parents[2]
AI_PY = REPO / "api" / "v8" / "ai.py"


# ── 1. 鉴权必须存在 ────────────────────────────────────────────────
def test_v1_endpoints_require_authentication():
    """两个 v1 端点都必须声明 get_current_account 依赖。

    C-1 就是这个断言缺失造成的：同功能 v8 有鉴权、v1 没有。
    """
    text = AI_PY.read_text(encoding="utf-8")
    # 分别抓两个端点函数签名
    for route, marker in (
        ('@v1_router.post("/chat/completions"', "v1_chat_completions"),
        ('@v1_router.post("/embeddings"', "v1_embeddings"),
    ):
        idx = text.index(route)
        block = text[idx:idx + 700]
        assert marker in block, f"{route} 结构变了，测试需同步"
        assert "Depends(get_current_account)" in block, (
            f"{route} 丢了鉴权依赖 —— /api/v1 又变成免鉴权匿名入口"
        )


def test_v1_endpoints_use_account_scoped_rate_limit_key():
    """限流键必须带账号维度，且不再读 X-Forwarded-For 首值。"""
    text = AI_PY.read_text(encoding="utf-8")
    for marker in ("v1_chat_completions", "v1_embeddings"):
        idx = text.index(marker)
        block = text[idx:idx + 500]
        assert "_v1_client_ip(request, current.id)" in block, (
            f"{marker} 的限流键没带账号维度 —— 单账号可耗尽全局配额"
        )


def test_rate_limit_key_ignores_forgeable_xff():
    """C-1 放大器：伪造 X-Forwarded-For 不得改变限流键。

    旧实现取 ``X-Forwarded-For`` 的**首值** → 每请求换一个假 IP 即绕过
    60/小时护栏（实测 70 次伪造请求全部 200）。
    """
    from platform_v8.api.v8.ai import _v1_client_ip

    class _Req:
        def __init__(self, headers, peer="10.0.0.9"):
            self.headers = headers
            self.client = type("C", (), {"host": peer})()

    # 伪造 XFF（追加/链式/单值）一律不得成为限流键
    for forged in ("1.2.3.4", "1.2.3.4, 5.6.7.8", "9.9.9.9,10.0.0.1"):
        key = _v1_client_ip(_Req({"x-forwarded-for": forged}))
        assert "1.2.3.4" not in key and "9.9.9.9" not in key, (
            f"伪造的 XFF 值 {forged!r} 仍被当成限流键 —— 可绕过限流"
        )

    # nginx 用 $remote_addr 覆写的 X-Real-IP 才是可信来源
    assert _v1_client_ip(_Req({"x-real-ip": "203.0.113.7"})) == "203.0.113.7"
    # X-Real-IP 被伪造成长度超限 / 逗号链 → 退回 TCP 对端
    assert _v1_client_ip(_Req({"x-real-ip": "1.1.1.1,2.2.2.2"})) == "10.0.0.9"
    assert _v1_client_ip(_Req({"x-real-ip": "x" * 60})) == "10.0.0.9"
    assert _v1_client_ip(_Req({"x-real-ip": "evil.example.com"})) == "10.0.0.9"
    # 账号维度参与键
    assert _v1_client_ip(_Req({"x-real-ip": "203.0.113.7"}), 42) == "acct42:203.0.113.7"


def test_relay_host_allowlist_accepts_host_and_host_port(monkeypatch):
    """QS_PLATFORM_RELAY_HOSTS 写 host 或 host:port 都要能匹配。

    真实踩过的坑：URL 侧会剥掉端口，而白名单条目没剥 → ``127.0.0.1:8080``
    形式的条目永远匹配不上，测试和灰度环境都会静默失效。
    """
    for entry in ("relay.example.internal", "relay.example.internal:8443"):
        monkeypatch.setenv("QS_PLATFORM_RELAY_HOSTS", entry)
        assert is_platform_host("https://relay.example.internal/api/v1/chat/completions"), (
            f"白名单条目 {entry!r} 未生效"
        )
        assert is_platform_host("https://relay.example.internal:8443/api/v1/embeddings")
    monkeypatch.setenv("QS_PLATFORM_RELAY_HOSTS", "relay.example.internal")
    assert not is_platform_host("https://other.example.internal/api/v1/chat/completions")


def test_embedding_uses_its_own_env_var_not_script_base_url(monkeypatch):
    """embedding 看的是 AI_EMBED_BASE_URL，不是 AI_SCRIPT_BASE_URL。

    真实踩过的坑：平台 .env 里 AI_SCRIPT_BASE_URL=https://api.deepseek.com，
    若把 embedding 也绑到这个变量上，平台环境会被误判成「第三方」
    → 该注入的凭据不注入 → embedding 任务 401。
    """
    monkeypatch.setenv(RELAY_CREDENTIAL_ENV, "qs_test00000000000000000000000000")
    monkeypatch.setenv("AI_SCRIPT_BASE_URL", "https://api.deepseek.com")
    monkeypatch.delenv("AI_EMBED_BASE_URL", raising=False)
    out = inject_platform_relay_credential("embedding", {})
    assert out.get("api_key"), "embedding 默认打平台却没注入凭据 → 会 401"

    # 真配了外部 embedding 供应商 → 不注入平台凭据
    monkeypatch.setenv("AI_EMBED_BASE_URL", "https://api.vendor-embed.example")
    out2 = inject_platform_relay_credential("embedding", {})
    assert "api_key" not in out2, "外部 embedding 供应商却拿到了平台凭据 —— 凭据外泄"


def test_embedding_injects_when_base_env_unset(monkeypatch):
    """未设 AI_EMBED_BASE_URL 时 embedding 回退平台默认地址 → 注入凭据。"""
    monkeypatch.setenv(RELAY_CREDENTIAL_ENV, "qs_test00000000000000000000000000")
    monkeypatch.delenv("AI_EMBED_BASE_URL", raising=False)
    out = inject_platform_relay_credential("embedding", {})
    assert out.get("api_key")


def test_rate_limit_window_actually_blocks_repeat_callers(monkeypatch):
    """同一限流键打满窗口后必须被拒（护栏本身没被我改坏）。"""
    from platform_v8.api.v8 import ai as ai_mod

    monkeypatch.setattr(ai_mod, "_V1_RL_MAX", 3)
    monkeypatch.setattr(ai_mod, "_V1_RL", {})
    key = "acct1:203.0.113.7"
    assert [ai_mod._v1_rate_limited(key) for _ in range(3)] == [False, False, False]
    assert ai_mod._v1_rate_limited(key) is True, "打满窗口后未拒绝 —— 限流失效"
    # 另一个 key 不受影响
    assert ai_mod._v1_rate_limited("acct2:203.0.113.7") is False


# ── 2. 凭据注入的边界 ──────────────────────────────────────────────
def test_platform_host_detection():
    assert is_platform_host("https://www.qianshousuanli.com/api/v1/chat/completions")
    assert is_platform_host("https://qianshousuanli.com/api/v1/embeddings")
    assert is_platform_host("www.qianshousuanli.com")
    assert is_platform_host("https://www.qianshousuanli.com:443/api/v1/x")
    # 第三方 / 本机服务都不算平台
    assert not is_platform_host("https://api.deepseek.com/v1/chat/completions")
    assert not is_platform_host("http://127.0.0.1:8000/api/v1/chat/completions")
    assert not is_platform_host("http://localhost:8000/api/v1/chat/completions")
    assert not is_platform_host("")
    assert not is_platform_host("evil-qianshousuanli.com")


def test_relay_scope_covers_all_platform_default_scripts():
    """8 个默认打平台 v1 地址的脚本都要在注入白名单里。

    漏一个 → 那个任务类型升级后直接 401（功能回归）。
    """
    for task_type in ("llm_chat", "llm_classify", "llm_extract", "llm_translate",
                      "ai_copywriting", "case_digest", "contract_review", "embedding"):
        assert task_type in _RELAY_TASK_TYPES, (
            f"{task_type} 不在中继凭据注入白名单 → 会 401"
        )


def test_relay_scope_excludes_unrelated_task_types():
    assert not relays_via_platform("image_resize", {})
    assert not relays_via_platform("audio_transcode", {})


def test_no_credential_when_endpoint_is_third_party(monkeypatch):
    """显式第三方 endpoint → 绝不注入平台凭据（防凭据外泄）。"""
    monkeypatch.setenv(RELAY_CREDENTIAL_ENV, "qs_test00000000000000000000000000")
    params = {"endpoint": "https://api.deepseek.com/v1/chat/completions"}
    out = inject_platform_relay_credential("llm_chat", params)
    assert "api_key" not in out, "平台凭据被注入到第三方 endpoint —— 凭据外泄"


def test_no_credential_when_base_env_points_at_third_party(monkeypatch):
    """无显式 endpoint 但 AI_SCRIPT_BASE_URL 指向外部 → 不注入。"""
    monkeypatch.setenv(RELAY_CREDENTIAL_ENV, "qs_test00000000000000000000000000")
    monkeypatch.setenv("AI_SCRIPT_BASE_URL", "https://api.deepseek.com")
    out = inject_platform_relay_credential("ai_copywriting", {})
    assert "api_key" not in out, "base 指向第三方却注入了平台凭据 —— 凭据外泄"


def test_credential_injected_for_platform_default(monkeypatch):
    """无 endpoint + base 指向平台（或未设）→ 必须注入凭据。"""
    monkeypatch.setenv(RELAY_CREDENTIAL_ENV, "qs_test00000000000000000000000000")
    monkeypatch.delenv("AI_SCRIPT_BASE_URL", raising=False)
    out = inject_platform_relay_credential("llm_chat", {"prompt": "hi"})
    assert out["api_key"] == "qs_test00000000000000000000000000"

    monkeypatch.setenv("AI_SCRIPT_BASE_URL", "https://www.qianshousuanli.com")
    out2 = inject_platform_relay_credential("case_digest", {})
    assert out2.get("api_key") == "qs_test00000000000000000000000000"


def test_existing_api_key_is_never_overwritten(monkeypatch):
    """用户/调用方自带的 api_key 优先，不被平台凭据覆盖。"""
    monkeypatch.setenv(RELAY_CREDENTIAL_ENV, "qs_platform00000000000000000000")
    monkeypatch.delenv("AI_SCRIPT_BASE_URL", raising=False)
    out = inject_platform_relay_credential("llm_chat", {"api_key": "USER_KEY"})
    assert out["api_key"] == "USER_KEY"


def test_missing_credential_fails_closed(monkeypatch):
    """没配凭据时不注入、也不放行 —— 结果是 401 可见失败，不是静默匿名。"""
    monkeypatch.delenv(RELAY_CREDENTIAL_ENV, raising=False)
    monkeypatch.delenv("AI_SCRIPT_BASE_URL", raising=False)
    out = inject_platform_relay_credential("llm_chat", {"prompt": "hi"})
    assert "api_key" not in out


def test_injection_does_not_mutate_caller_params(monkeypatch):
    """注入不得原地改调用方 dict（避免污染 workload.spec.params）。"""
    monkeypatch.setenv(RELAY_CREDENTIAL_ENV, "qs_test00000000000000000000000000")
    monkeypatch.delenv("AI_SCRIPT_BASE_URL", raising=False)
    original = {"prompt": "hi"}
    out = inject_platform_relay_credential("llm_chat", original)
    assert "api_key" not in original, "原始 params 被就地修改"
    assert out["api_key"] == "qs_test00000000000000000000000000"


# ── 3. 节点脚本侧凭据链路 ──────────────────────────────────────────
@pytest.mark.parametrize("script", ["llm_chat.py", "llm_classify.py",
                                    "llm_extract.py", "llm_translate.py"])
def test_node_scripts_carry_credentials(script):
    """4 个节点脚本必须能把凭据放进 Authorization，且只在打平台时用平台凭据。"""
    text = (REPO / "scripts" / "tasks" / script).read_text(encoding="utf-8")
    assert "_relay_api_key" in text, f"{script} 丢了凭据解析"
    assert "QS_PLATFORM_RELAY_API_KEY" in text, f"{script} 丢了节点凭据环境变量"
    assert 'headers["Authorization"]' in text, f"{script} 不再携带 Authorization"
    assert "qianshousuanli.com" in text, f"{script} 丢了平台默认 endpoint 判定"
    # 绝不能把本机地址当平台（会把平台凭据发给本机其它服务）
    assert '"127.0.0.1", "localhost"' not in text, (
        f"{script} 把 127.0.0.1/localhost 当成平台主机 —— 可能外泄凭据"
    )
