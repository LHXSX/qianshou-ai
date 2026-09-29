"""client updater · binary 缺平台时回落 CDN latest.json

不直接 import bundles 模块顶层(需 fastapi)；只测纯解析逻辑副本的契约，
实现以 bundles._resolve_tauri_manifest_for_platform 为准。
"""
from __future__ import annotations

from typing import Any


def _plat_update_info(manifest: dict[str, Any] | None, plat_key: str) -> dict[str, Any] | None:
    if not manifest:
        return None
    info = (manifest.get("platforms") or {}).get(plat_key)
    if not isinstance(info, dict):
        return None
    url = str(info.get("url") or "").strip()
    sig = str(info.get("signature") or "").strip()
    if not url or not sig:
        return None
    return info


def _resolve(
    local: dict[str, Any] | None,
    cdn: dict[str, Any] | None,
    plat_key: str,
) -> dict[str, Any] | None:
    if _plat_update_info(local, plat_key) is not None:
        return local
    if _plat_update_info(cdn, plat_key) is not None:
        return cdn
    return local


def test_plat_update_info_requires_url_and_signature() -> None:
    assert _plat_update_info(None, "windows-x86_64") is None
    assert _plat_update_info({"platforms": {}}, "windows-x86_64") is None
    assert (
        _plat_update_info(
            {"platforms": {"windows-x86_64": {"url": "https://x/a.nsis.zip"}}},
            "windows-x86_64",
        )
        is None
    )
    info = _plat_update_info(
        {
            "platforms": {
                "windows-x86_64": {
                    "url": "https://x/a.nsis.zip",
                    "signature": "sig",
                }
            }
        },
        "windows-x86_64",
    )
    assert info is not None
    assert info["signature"] == "sig"


def test_resolve_falls_back_to_cdn_when_local_missing_platform() -> None:
    local = {
        "version": "8.3.1",
        "platforms": {
            "darwin-aarch64": {
                "url": "https://dl.example/a.app.tar.gz",
                "signature": "mac",
            }
        },
    }
    cdn = {
        "version": "8.3.1",
        "platforms": {
            "windows-x86_64": {
                "url": "https://dl.example/a.nsis.zip",
                "signature": "win",
            }
        },
    }
    assert _resolve(local, cdn, "windows-x86_64") is cdn
    assert _resolve(local, cdn, "darwin-aarch64") is local
