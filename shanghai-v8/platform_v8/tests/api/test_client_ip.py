from __future__ import annotations

from starlette.requests import Request

from platform_v8.api.client_ip import client_ip


def _request(peer: str, forwarded_for: str = "") -> Request:
    headers = []
    if forwarded_for:
        headers.append((b"x-forwarded-for", forwarded_for.encode("ascii")))
    return Request({
        "type": "http",
        "method": "GET",
        "path": "/",
        "headers": headers,
        "client": (peer, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
        "query_string": b"",
    })


def test_untrusted_peer_cannot_spoof_forwarded_for(monkeypatch) -> None:
    monkeypatch.setenv("V8_TRUSTED_PROXIES", "127.0.0.1/32")
    assert client_ip(_request("203.0.113.9", "198.51.100.7")) == "203.0.113.9"


def test_trusted_proxy_uses_last_untrusted_forwarded_hop(monkeypatch) -> None:
    monkeypatch.setenv(
        "V8_TRUSTED_PROXIES",
        "127.0.0.1/32,10.0.0.0/8",
    )
    request = _request(
        "127.0.0.1",
        "192.0.2.99, 198.51.100.20, 10.0.0.8",
    )
    assert client_ip(request) == "198.51.100.20"


def test_spoofed_leftmost_value_does_not_replace_real_client(monkeypatch) -> None:
    monkeypatch.setenv("V8_TRUSTED_PROXIES", "127.0.0.1/32")
    request = _request("127.0.0.1", "203.0.113.200, 198.51.100.42")
    assert client_ip(request) == "198.51.100.42"
