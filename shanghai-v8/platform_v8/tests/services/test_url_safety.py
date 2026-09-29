from __future__ import annotations

import socket

import pytest

from platform_v8.services import url_safety


class _Response:
    def __init__(self, status=200, headers=None, body=b"ok"):
        self.status = status
        self.headers = headers or {}
        self._body = body

    def read(self, amount=-1):
        if amount < 0:
            amount = len(self._body)
        out, self._body = self._body[:amount], self._body[amount:]
        return out

    def close(self):
        pass


def _dns(ip):
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 80))]


def test_redirect_to_loopback_is_rejected_on_next_hop(monkeypatch):
    answers = iter([_dns("8.8.8.8"), _dns("127.0.0.1")])
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: next(answers))

    class _Connection:
        def __init__(self, host, port, pinned_ip, timeout):
            assert pinned_ip == "8.8.8.8"

        def request(self, *_a, **_k):
            pass

        def getresponse(self):
            return _Response(302, {"Location": "http://localhost/private"})

        def close(self):
            pass

    monkeypatch.setattr(url_safety, "_PinnedHTTPConnection", _Connection)
    with pytest.raises(url_safety.UnsafeURLError):
        url_safety.safe_open("http://public.example/start")


def test_connection_uses_validated_pinned_ip(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: _dns("8.8.4.4"))
    seen = {}

    class _Connection:
        def __init__(self, host, port, pinned_ip, timeout):
            seen.update(host=host, pinned_ip=pinned_ip)

        def request(self, method, path, headers):
            seen.update(path=path, host_header=headers["Host"])

        def getresponse(self):
            return _Response()

        def close(self):
            pass

    monkeypatch.setattr(url_safety, "_PinnedHTTPConnection", _Connection)
    with url_safety.safe_open("http://public.example/file?token=secret") as response:
        assert response.read() == b"ok"
    assert seen["pinned_ip"] == "8.8.4.4"
    assert seen["host"] == "public.example"
    assert seen["host_header"] == "public.example"


def test_sensitive_query_is_not_exposed_in_transport_error(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *_a, **_k: _dns("8.8.8.8"))

    class _Connection:
        def __init__(self, *_a, **_k):
            pass

        def request(self, *_a, **_k):
            raise RuntimeError("request failed for ?token=secret")

        def close(self):
            pass

    monkeypatch.setattr(url_safety, "_PinnedHTTPConnection", _Connection)
    with pytest.raises(url_safety.SafeHTTPError) as exc:
        url_safety.safe_open("http://public.example/file?token=secret")
    assert "secret" not in str(exc.value)
    assert "token" not in str(exc.value)
