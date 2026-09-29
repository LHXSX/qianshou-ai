from __future__ import annotations

import json

import pytest
from pydantic import ValidationError

from platform_v8.protocol import ws_schema as wsp


def test_old_hello_remains_compatible_and_is_detectably_legacy():
    frame = wsp.parse_incoming(json.dumps({
        "type": "hello",
        "v": "8.0",
        "payload": {
            "client_version": "8.0.9",
            "capabilities": {"cpu_cores": 4, "runtimes": ["python3"]},
        },
    }))
    assert isinstance(frame, wsp.Hello)
    assert frame.payload.capabilities["cpu_cores"] == 4
    assert frame.payload.client_build is None
    assert frame.payload.protocol_capabilities is None


def test_new_hello_capabilities_are_normalized_and_deduplicated():
    payload = wsp.HelloPayload(
        client_version="8.3.0",
        client_build=" 20260813.1 ",
        protocol_capabilities=[
            " Assignment-Token.V1 ",
            "assignment-token.v1",
            "ARTIFACT/V1",
        ],
    )
    assert payload.client_build == "20260813.1"
    assert payload.protocol_capabilities == [
        "assignment-token.v1",
        "artifact/v1",
    ]


def test_new_hello_capabilities_are_bounded():
    with pytest.raises(ValidationError):
        wsp.HelloPayload(
            client_version="8.3.0",
            protocol_capabilities=[f"cap-{i}" for i in range(33)],
        )
    with pytest.raises(ValidationError):
        wsp.HelloPayload(
            client_version="8.3.0",
            protocol_capabilities=["x" * 65],
        )
    with pytest.raises(ValidationError):
        wsp.HelloPayload(
            client_version="8.3.0",
            protocol_capabilities=["bad capability"],
        )
