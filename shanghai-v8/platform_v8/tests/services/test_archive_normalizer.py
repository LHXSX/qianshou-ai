from __future__ import annotations

import subprocess
import sys
from contextlib import contextmanager
from types import SimpleNamespace
import zipfile

import pytest

from platform_v8.services.archive_normalizer import (
    ArchiveNormalizationError,
    _download_archive,
    _extract_7z,
    _scan_member,
    _extract_zip,
)


def test_zip_extraction_rejects_traversal_member(tmp_path):
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("../escape.txt", "no")

    with pytest.raises(ArchiveNormalizationError, match="unsafe|traversal"):
        list(_extract_zip(archive, tmp_path / "out"))


def test_zip_extraction_returns_hashed_regular_members(tmp_path):
    archive = tmp_path / "input.zip"
    output = tmp_path / "out"
    output.mkdir()
    with zipfile.ZipFile(archive, "w") as zf:
        zf.writestr("nested/one.txt", "hello")

    extracted = list(_extract_zip(archive, output))

    assert extracted[0][0] == "nested/one.txt"
    assert extracted[0][2] == 5
    assert len(extracted[0][3]) == 64


def test_production_archive_requires_scanner(tmp_path, monkeypatch):
    member = tmp_path / "member.txt"
    member.write_text("safe")
    monkeypatch.setenv("V8_ENV", "production")
    monkeypatch.delenv("EDGE_ARCHIVE_SCAN_COMMAND", raising=False)

    with pytest.raises(ArchiveNormalizationError, match="scanning is required"):
        _scan_member(member)


def test_7z_rejects_unsafe_directory_before_extractall(
    tmp_path,
    monkeypatch,
):
    extracted = []

    class _SevenZip:
        def __init__(self, *_args, **_kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def needs_password(self):
            return False

        def list(self):
            return [
                SimpleNamespace(
                    filename="../escape",
                    is_file=False,
                    is_directory=True,
                    is_symlink=False,
                    encrypted=False,
                ),
                SimpleNamespace(
                    filename="safe.txt",
                    is_file=True,
                    is_directory=False,
                    is_symlink=False,
                    encrypted=False,
                    uncompressed=4,
                    compressed=4,
                ),
            ]

        def extractall(self, **_kwargs):
            extracted.append(True)

    monkeypatch.setitem(
        sys.modules,
        "py7zr",
        SimpleNamespace(SevenZipFile=_SevenZip),
    )
    output = tmp_path / "out"
    output.mkdir()

    with pytest.raises(ArchiveNormalizationError, match="unsafe|traversal"):
        list(_extract_7z(tmp_path / "input.7z", output))

    assert extracted == []


def test_production_detection_error_fails_closed(tmp_path, monkeypatch):
    from platform_v8.services.auth import config

    member = tmp_path / "member.txt"
    member.write_text("safe")
    monkeypatch.setattr(
        config,
        "is_production",
        lambda: (_ for _ in ()).throw(RuntimeError("broken policy")),
    )

    with pytest.raises(ArchiveNormalizationError, match="policy"):
        _scan_member(member)


def test_production_scanner_timeout_fails_closed(tmp_path, monkeypatch):
    member = tmp_path / "member.txt"
    member.write_text("safe")
    monkeypatch.setenv("V8_ENV", "production")
    monkeypatch.setenv("EDGE_ARCHIVE_SCAN_COMMAND", "scanner --quiet")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            subprocess.TimeoutExpired("scanner", 60)
        ),
    )

    with pytest.raises(ArchiveNormalizationError, match="timed out"):
        _scan_member(member)


def test_nonproduction_missing_scanner_is_observable_and_allowed(
    tmp_path,
    monkeypatch,
    caplog,
):
    member = tmp_path / "member.txt"
    member.write_text("safe")
    monkeypatch.setenv("V8_ENV", "test")
    monkeypatch.delenv("EDGE_ARCHIVE_SCAN_COMMAND", raising=False)
    monkeypatch.delenv("EDGE_ARCHIVE_REQUIRE_SCAN", raising=False)

    with caplog.at_level("INFO"):
        _scan_member(member)

    assert "scanner=unconfigured" in caplog.text
    assert "member.txt" not in caplog.text


def test_archive_download_uses_owned_key_and_safe_stream(
    tmp_path,
    monkeypatch,
):
    from platform_v8.services import storage_refs, url_safety

    calls = {}
    chunks = iter((b"archive", b"-bytes", b""))

    monkeypatch.setattr(
        storage_refs,
        "materialize_get_url",
        lambda owner_id, key, expires: calls.update(
            owner_id=owner_id,
            key=key,
            expires=expires,
        ) or "https://objects.example.test/archive?secret=redacted",
    )

    @contextmanager
    def _safe_stream(url, *, policy):
        calls["url"] = url
        calls["policy"] = policy
        yield SimpleNamespace(
            status=200,
            read=lambda _amount: next(chunks),
        )

    monkeypatch.setattr(url_safety, "safe_stream", _safe_stream)
    destination = tmp_path / "archive.bin"

    _download_archive(
        7,
        "v8/account-7/input/archive.zip",
        destination,
    )

    assert destination.read_bytes() == b"archive-bytes"
    assert calls["key"] == "v8/account-7/input/archive.zip"
    assert calls["policy"].max_response_bytes > 0
