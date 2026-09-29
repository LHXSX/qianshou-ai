"""Fixed-origin service transport; no caller-selected URLs or ambient admin credentials."""
from __future__ import annotations
import os
import stat as stat_module
import re
from pathlib import Path
from urllib.parse import urlsplit
import httpx

class GatewayError(Exception):
    def __init__(self, code: str, status: int = 503):
        super().__init__(code); self.code = code; self.status = status

class Gateway:
    def __init__(self, origin: str, secret_file: str):
        url = urlsplit(origin)
        if url.username or url.password or url.query or url.fragment or url.path not in ("", "/"):
            raise GatewayError("checkout_unavailable")
        if url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("127.0.0.1", "localhost", "::1")):
            raise GatewayError("checkout_unavailable")
        if not Path(secret_file).is_absolute(): raise GatewayError("checkout_unavailable")
        self.origin = origin.rstrip("/"); self.secret_file = Path(secret_file)

    def call(self, action: str, payload: dict) -> dict:
        if action not in ("quote", "fulfil", "query"): raise GatewayError("invalid_action")
        try:
            with self.secret_file.open() as stream:
                stat = os.fstat(stream.fileno())
                if not stat_module.S_ISREG(stat.st_mode) or stat.st_uid != os.getuid() or stat.st_mode & 0o077 or stat.st_size > 4096:
                    raise GatewayError("checkout_unavailable")
                token = stream.read().strip()
            if not re.fullmatch(r'[A-Za-z0-9_-]{43,256}', token): raise GatewayError("checkout_unavailable")
            with httpx.Client(timeout=httpx.Timeout(8, connect=3), follow_redirects=False, trust_env=False) as client:
                response = client.post(self.origin + "/internal/subscriptions/cny/" + action,
                                       json=payload, headers={"authorization": "Bearer " + token})
            if len(response.content) > 32768: raise GatewayError("gateway_response_invalid")
            result = response.json()
            if not isinstance(result, dict): raise GatewayError("gateway_response_invalid")
            if response.status_code != 200 or result.get("ok") is not True:
                code = result.get("code")
                allowed = {"order_not_fulfilled", "order_conflict", "payment_quote_mismatch", "downgrade-not-allowed", "already-subscribed", "persistence_unavailable", "quote_terms_changed"}
                raise GatewayError(code if code in allowed else "gateway_unavailable", response.status_code)
            return result
        except GatewayError: raise
        except Exception: raise GatewayError("gateway_outcome_unknown") from None

def configured_gateway() -> Gateway:
    origin = os.environ.get("V8_SUBSCRIPTION_GATEWAY_ORIGIN", "")
    secret = os.environ.get("V8_SUBSCRIPTION_SERVICE_SECRET_FILE", "")
    if not origin or not secret: raise GatewayError("checkout_unavailable")
    return Gateway(origin, secret)
