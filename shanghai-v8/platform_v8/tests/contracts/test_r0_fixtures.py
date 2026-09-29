"""Parse the same R0 JSON fixtures as eco-client contracts/runtime-api/fixture.test.ts."""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
_CONTRACTS = _ROOT / "apps" / "eco-client" / "contracts"
_RT = _CONTRACTS / "runtime-api"
_PV = _CONTRACTS / "provider-api"


def _load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    spec.loader.exec_module(mod)
    return mod


_rt = _load("r0_runtime_types", _RT / "types.py")
_pv = _load("r0_provider_types", _PV / "types.py")


def test_app_manifest_v2_fixture():
    raw = json.loads((_RT / "fixtures" / "app-manifest-v2.min.json").read_text())
    m = _rt.assert_app_manifest_v2_shape(raw)
    assert m["executionModel"] == "runtime_v2"
    assert m["requiresCapabilities"][0]["name"] == "media.probe"
    assert "required_tier" not in m


def test_capability_invoke_and_error_fixtures():
    inv = json.loads((_RT / "fixtures" / "capability-invoke.request.json").read_text())
    assert inv["method"] == "capability.invoke"
    assert inv["params"]["capability"] == "doc.pdf.text"
    assert all(not h.startswith("/") for h in inv["params"]["inputHandles"])

    err = json.loads((_RT / "fixtures" / "error.sample.json").read_text())
    assert err["ok"] is False
    assert err["code"] == "CAPABILITY_NOT_FOUND"


def test_provider_handshake_fixture():
    raw = json.loads((_PV / "fixtures" / "provider-handshake.json").read_text())
    h = _pv.assert_provider_handshake(raw)
    assert h["providerProtocol"] == "1.0"
    assert h["capabilities"][0]["name"] == "media.probe"
