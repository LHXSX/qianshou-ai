"""sync_client_manifests · 无签名平台不得写入 binary.json"""
from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_sync():
    path = Path(__file__).resolve().parents[2] / "scripts" / "ops" / "sync_client_manifests.py"
    spec = importlib.util.spec_from_file_location("sync_client_manifests", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_build_binary_json_skips_windows_without_signature() -> None:
    sync = _load_sync()
    release = {
        "version": "8.3.1",
        "release_notes": "notes",
        "products": [
            {
                "id": "qianshou-standard",
                "downloads": [
                    {
                        "platform": "macos-arm64",
                        "available": True,
                        "url": "https://dl.example/macos/v8.3.1/a.dmg",
                        "url_ota": "https://dl.example/macos/v8.3.1/千手节点.app.tar.gz",
                        "signature": "mac-sig",
                    },
                    {
                        "platform": "windows-x64",
                        "available": True,
                        "url": "https://dl.example/windows/v8.3.1/千手节点_8.3.1_x64-setup.exe",
                    },
                ],
            }
        ],
    }
    binary = sync.build_binary_json(release)
    assert binary["version"] == "8.3.1"
    assert "darwin-aarch64" in binary["platforms"]
    assert "windows-x86_64" not in binary["platforms"]


def test_build_binary_json_includes_windows_with_nsis_and_sig() -> None:
    sync = _load_sync()
    release = {
        "version": "8.3.1",
        "products": [
            {
                "id": "qianshou-standard",
                "downloads": [
                    {
                        "platform": "windows-x64",
                        "available": True,
                        "url": "https://dl.example/windows/v8.3.1/千手节点_8.3.1_x64-setup.exe",
                        "url_ota": "https://dl.example/windows/v8.3.1/千手节点_8.3.1_x64-setup.nsis.zip",
                        "signature": "win-sig",
                    },
                ],
            }
        ],
    }
    binary = sync.build_binary_json(release)
    win = binary["platforms"]["windows-x86_64"]
    assert win["url"].endswith(".nsis.zip")
    assert win["signature"] == "win-sig"
