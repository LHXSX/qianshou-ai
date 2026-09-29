"""Resolve client IPs only through explicitly trusted reverse proxies."""
from __future__ import annotations

import ipaddress
import os

from fastapi import Request


def _trusted_proxy_networks() -> list[ipaddress.IPv4Network | ipaddress.IPv6Network]:
    configured = os.environ.get(
        "V8_TRUSTED_PROXIES",
        "127.0.0.1/32,::1/128",
    )
    networks: list[ipaddress.IPv4Network | ipaddress.IPv6Network] = []
    for raw in configured.split(","):
        value = raw.strip()
        if not value:
            continue
        try:
            networks.append(ipaddress.ip_network(value, strict=False))
        except ValueError:
            continue
    return networks


def _is_trusted_proxy(value: str, networks) -> bool:
    try:
        address = ipaddress.ip_address(value)
    except ValueError:
        return False
    return any(address in network for network in networks)


def client_ip(request: Request) -> str:
    """Return the last untrusted hop, ignoring spoofed left-most XFF values."""
    peer = request.client.host if request.client else "unknown"
    networks = _trusted_proxy_networks()
    if not _is_trusted_proxy(peer, networks):
        return peer

    forwarded = request.headers.get("X-Forwarded-For", "")
    hops = [hop.strip() for hop in forwarded.split(",") if hop.strip()]
    for hop in reversed(hops):
        if not _is_trusted_proxy(hop, networks):
            try:
                return str(ipaddress.ip_address(hop))
            except ValueError:
                continue
    return peer
