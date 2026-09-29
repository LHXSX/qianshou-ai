"""Normalize untrusted archive inputs into account-scoped file objects.

Workers must never receive an archive to unpack.  This module downloads the
submitted archive once, applies resource/path checks while extracting, uploads
safe members as ordinary account objects, and returns an immutable input batch.

Note (2026-08-17): Ally LAN QA hotpatch. Default MIN_FREE is 100MiB
(override EDGE_ARCHIVE_MIN_FREE_BYTES). EDGE_ARCHIVE_TMP_DIR selects a disk-backed
tmpdir when /tmp is tmpfs. Companion archive_normalization_jobs / storage_refs
synced from Ally the same day.
"""
from __future__ import annotations

import gzip
import hashlib
import logging
import os
import shlex
import stat
import subprocess
import shutil
import tarfile
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Iterator

import httpx

logger = logging.getLogger(__name__)

MAX_ARCHIVE_BYTES = int(os.getenv("EDGE_ARCHIVE_MAX_COMPRESSED_BYTES", 512 * 1024 * 1024))
MAX_MEMBERS = int(os.getenv("EDGE_ARCHIVE_MAX_MEMBERS", 10_000))
MAX_MEMBER_BYTES = int(os.getenv("EDGE_ARCHIVE_MAX_MEMBER_BYTES", 128 * 1024 * 1024))
MAX_EXPANDED_BYTES = int(os.getenv("EDGE_ARCHIVE_MAX_EXPANDED_BYTES", 2 * 1024 * 1024 * 1024))
MAX_RATIO = int(os.getenv("EDGE_ARCHIVE_MAX_RATIO", 100))
MIN_FREE_BYTES = int(os.getenv("EDGE_ARCHIVE_MIN_FREE_BYTES", 100 * 1024 * 1024))  # LAN/dev default 100MiB; prod override via env


class ArchiveNormalizationError(ValueError):
    """Archive cannot safely be converted to a multi-file input batch."""


@dataclass(frozen=True)
class NormalizedInput:
    object_key: str
    filename: str
    size_bytes: int
    sha256: str
    content_type: str = "application/octet-stream"


def _safe_member_name(name: str) -> str:
    raw = (name or "").replace("\\", "/")
    path = PurePosixPath(raw)
    first_part = path.parts[0] if path.parts else ""
    if (
        not raw
        or raw.startswith("/")
        or raw.startswith("//")
        or "\x00" in raw
        or ":" in first_part
    ):
        raise ArchiveNormalizationError("archive contains an unsafe member path")
    if any(part in ("", ".", "..") or len(part) > 128 for part in path.parts):
        raise ArchiveNormalizationError("archive contains a traversal or invalid member path")
    if len(path.parts) > 16:
        raise ArchiveNormalizationError("archive member path is too deep")
    return "/".join(path.parts)


def _copy_bounded(source, destination, *, total: list[int]) -> tuple[int, str]:
    digest = hashlib.sha256()
    written = 0
    while True:
        chunk = source.read(1024 * 1024)
        if not chunk:
            break
        written += len(chunk)
        total[0] += len(chunk)
        if written > MAX_MEMBER_BYTES or total[0] > MAX_EXPANDED_BYTES:
            raise ArchiveNormalizationError("archive expanded size exceeds the configured limit")
        digest.update(chunk)
        destination.write(chunk)
    if written == 0:
        raise ArchiveNormalizationError("archive contains an empty file")
    return written, digest.hexdigest()


def _scan_member(path: Path) -> None:
    """Scan every member; production is fail-closed when no scanner exists."""
    command = os.getenv("EDGE_ARCHIVE_SCAN_COMMAND", "").strip()
    try:
        from platform_v8.services.auth.config import is_production
        production = is_production()
    except Exception as exc:
        raise ArchiveNormalizationError(
            "archive production policy could not be determined"
        ) from exc
    required = production or os.getenv("EDGE_ARCHIVE_REQUIRE_SCAN", "").lower() in {
        "1", "true", "yes",
    }
    if not command:
        if required:
            raise ArchiveNormalizationError("archive scanning is required but unavailable")
        logger.info(
            "archive.scan skipped · environment=non-production · scanner=unconfigured"
        )
        return
    try:
        argv = shlex.split(command)
    except ValueError as exc:
        raise ArchiveNormalizationError("archive scanner command is invalid") from exc
    if not argv:
        raise ArchiveNormalizationError("archive scanner command is empty")
    try:
        result = subprocess.run(
            [*argv, str(path)],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=60,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise ArchiveNormalizationError("archive scanner timed out") from exc
    except OSError as exc:
        raise ArchiveNormalizationError("archive scanner could not be started") from exc
    if result.returncode != 0:
        raise ArchiveNormalizationError("archive member was rejected by the scanner")


def _download_archive(owner_id: int, object_key: str, destination: Path) -> None:
    from platform_v8.services.storage_refs import materialize_get_url
    from platform_v8.services.url_safety import URLPolicy, safe_stream

    signed_url = materialize_get_url(owner_id, object_key, 600)
    seen = 0
    try:
        with safe_stream(
            signed_url,
            policy=URLPolicy(
                timeout=180,
                max_response_bytes=MAX_ARCHIVE_BYTES,
                max_redirects=2,
            ),
        ) as response:
            if not 200 <= response.status < 300:
                raise ArchiveNormalizationError(
                    "archive object download returned an invalid status"
                )
            with destination.open("xb") as out:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    seen += len(chunk)
                    if seen > MAX_ARCHIVE_BYTES:
                        raise ArchiveNormalizationError("archive compressed size exceeds the configured limit")
                    out.write(chunk)
    except ArchiveNormalizationError:
        raise
    except Exception as exc:
        raise ArchiveNormalizationError("archive object could not be downloaded") from exc


def _upload_member(owner_id: int, batch_id: str, item: NormalizedInput, source: Path) -> str:
    from platform_v8.services.oss_provider import get_oss_provider
    from platform_v8.services.storage_refs import validate_owned_object_key

    safe_name = Path(item.filename).name
    key = validate_owned_object_key(
        owner_id,
        f"v8/account-{owner_id}/normalized/{batch_id}/{item.sha256[:16]}-{safe_name}",
    )
    signed = get_oss_provider().presign_put(
        key, content_type=item.content_type, expires=900, max_size=item.size_bytes,
    )
    try:
        with source.open("rb") as data:
            response = httpx.put(
                signed.url,
                content=data,
                headers=signed.headers,
                timeout=180,
                follow_redirects=False,
            )
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise ArchiveNormalizationError("normalized archive member could not be uploaded") from exc
    return key


def _extract_zip(archive: Path, output: Path) -> Iterator[tuple[str, Path, int, str]]:
    total = [0]
    with zipfile.ZipFile(archive) as zf:
        infos = [info for info in zf.infolist() if not info.is_dir()]
        if not 1 <= len(infos) <= MAX_MEMBERS:
            raise ArchiveNormalizationError("archive member count exceeds the configured limit")
        for index, info in enumerate(infos):
            if info.flag_bits & 0x1:
                raise ArchiveNormalizationError("encrypted archives are not supported")
            if stat.S_ISLNK((info.external_attr >> 16) & 0o170000):
                raise ArchiveNormalizationError("archive links are not supported")
            name = _safe_member_name(info.filename)
            if info.file_size > MAX_MEMBER_BYTES or (
                info.compress_size and info.file_size > info.compress_size * MAX_RATIO
            ):
                raise ArchiveNormalizationError("archive member exceeds size or compression ratio limit")
            target = output / f"{index:05d}-{Path(name).name}"
            with zf.open(info, "r") as source, target.open("xb") as dest:
                size, digest = _copy_bounded(source, dest, total=total)
            yield name, target, size, digest


def _extract_tar(archive: Path, output: Path) -> Iterator[tuple[str, Path, int, str]]:
    total = [0]
    with tarfile.open(archive, "r:*") as tf:
        members = [member for member in tf.getmembers() if member.isfile()]
        if not 1 <= len(members) <= MAX_MEMBERS:
            raise ArchiveNormalizationError("archive member count exceeds the configured limit")
        for index, member in enumerate(members):
            if member.issym() or member.islnk() or member.isdev() or member.isfifo():
                raise ArchiveNormalizationError("archive links and special files are not supported")
            name = _safe_member_name(member.name)
            if member.size > MAX_MEMBER_BYTES:
                raise ArchiveNormalizationError("archive member exceeds the configured size limit")
            source = tf.extractfile(member)
            if source is None:
                raise ArchiveNormalizationError("archive member cannot be read")
            target = output / f"{index:05d}-{Path(name).name}"
            with source, target.open("xb") as dest:
                size, digest = _copy_bounded(source, dest, total=total)
            yield name, target, size, digest


def _extract_gzip(archive: Path, output: Path) -> Iterator[tuple[str, Path, int, str]]:
    total = [0]
    stem = archive.name.removesuffix(".gz") or "payload"
    target = output / f"00000-{Path(stem).name}"
    with gzip.open(archive, "rb") as source, target.open("xb") as dest:
        size, digest = _copy_bounded(source, dest, total=total)
    yield Path(stem).name, target, size, digest


def _extract_7z(archive: Path, output: Path) -> Iterator[tuple[str, Path, int, str]]:
    """Validate the complete 7z member table before extraction."""
    try:
        import py7zr
    except ImportError as exc:
        raise ArchiveNormalizationError("7z parser is not installed") from exc
    with py7zr.SevenZipFile(archive, mode="r") as seven:
        try:
            if seven.needs_password():
                raise ArchiveNormalizationError("encrypted archives are not supported")
            all_infos = list(seven.list())
        except ArchiveNormalizationError:
            raise
        except Exception as exc:
            raise ArchiveNormalizationError(
                "archive metadata could not be inspected"
            ) from exc

        infos = []
        seen_names: set[str] = set()
        for info in all_infos:
            try:
                filename = getattr(info, "filename")
                if not isinstance(filename, str):
                    raise TypeError("filename metadata is not text")

                def _flag(name: str, default=False) -> bool:
                    value = getattr(info, name, default)
                    return bool(value() if callable(value) else value)

                is_file = _flag("is_file")
                is_directory = _flag("is_directory")
                is_symlink = _flag("is_symlink")
                encrypted = _flag("encrypted") or _flag("is_encrypted")
            except Exception as exc:
                raise ArchiveNormalizationError(
                    "archive contains invalid member metadata"
                ) from exc
            name = _safe_member_name(filename)
            if (
                name in seen_names
                or is_file == is_directory
                or is_symlink
                or encrypted
            ):
                raise ArchiveNormalizationError(
                    "archive links, duplicates, and special entries are not supported"
                )
            seen_names.add(name)
            mode = getattr(info, "posix_mode", getattr(info, "mode", None))
            if mode is not None:
                try:
                    file_type = stat.S_IFMT(int(mode))
                except (TypeError, ValueError) as exc:
                    raise ArchiveNormalizationError(
                        "archive contains invalid member metadata"
                    ) from exc
                if file_type and not (
                    (is_file and stat.S_ISREG(file_type))
                    or (is_directory and stat.S_ISDIR(file_type))
                ):
                    raise ArchiveNormalizationError(
                        "archive links and special entries are not supported"
                    )
            if is_file:
                infos.append(info)
        if not 1 <= len(infos) <= MAX_MEMBERS:
            raise ArchiveNormalizationError("archive member count exceeds the configured limit")
        total_size = 0
        for info in infos:
            try:
                uncompressed = int(info.uncompressed)
                compressed = int(info.compressed or 0)
            except (AttributeError, TypeError, ValueError) as exc:
                raise ArchiveNormalizationError(
                    "archive contains invalid size metadata"
                ) from exc
            if uncompressed < 0 or compressed < 0:
                raise ArchiveNormalizationError(
                    "archive contains invalid size metadata"
                )
            if uncompressed > MAX_MEMBER_BYTES:
                raise ArchiveNormalizationError("archive contains an unsafe or oversized member")
            total_size += uncompressed
            if total_size > MAX_EXPANDED_BYTES or uncompressed > max(1, compressed) * MAX_RATIO:
                raise ArchiveNormalizationError("archive member exceeds size or compression ratio limit")
        seven.extractall(path=output)

    output_root = output.resolve()
    for extracted_path in output.rglob("*"):
        try:
            extracted_path.resolve().relative_to(output_root)
        except ValueError as exc:
            raise ArchiveNormalizationError(
                "archive extraction escaped its workspace"
            ) from exc
        if extracted_path.is_symlink():
            raise ArchiveNormalizationError(
                "archive extraction produced an invalid member"
            )

    normalized_output = output.parent / "normalized"
    normalized_output.mkdir()
    total = [0]
    for index, info in enumerate(infos):
        name = _safe_member_name(info.filename)
        source_path = output / name
        try:
            source_path.resolve().relative_to(output_root)
        except ValueError as exc:
            raise ArchiveNormalizationError(
                "archive extraction escaped its workspace"
            ) from exc
        if not source_path.is_file() or source_path.is_symlink():
            raise ArchiveNormalizationError("archive extraction produced an invalid member")
        target = normalized_output / f"{index:05d}-{Path(name).name}"
        with source_path.open("rb") as source, target.open("xb") as dest:
            size, digest = _copy_bounded(source, dest, total=total)
        source_path.unlink()
        yield name, target, size, digest


def _detect_format(path: Path) -> str:
    with path.open("rb") as source:
        magic = source.read(600)
    if magic.startswith(b"PK\x03\x04") or magic.startswith(b"PK\x05\x06"):
        return "zip"
    if magic.startswith(b"7z\xbc\xaf'\x1c"):
        return "7z"
    if magic.startswith(b"Rar!\x1a\x07"):
        return "rar"
    if magic.startswith(b"\x1f\x8b"):
        return "tar.gz" if tarfile.is_tarfile(path) else "gz"
    if tarfile.is_tarfile(path):
        return "tar"
    raise ArchiveNormalizationError("unsupported archive format")


def normalize_archive_to_batch(
    *,
    owner_id: int,
    object_key: str,
    task_type: str,
    max_shards: int,
    batch_id: str | None = None,
) -> dict:
    """Return server-created ``input_batch.v1`` and normalized object keys."""
    from platform_v8.services.storage_refs import canonicalize_owned_reference

    try:
        object_key = canonicalize_owned_reference(owner_id, object_key)
    except Exception as exc:
        raise ArchiveNormalizationError(
            "archive must belong to the submitting account"
        ) from exc
    tmp_parent = (os.getenv("EDGE_ARCHIVE_TMP_DIR") or "").strip()
    if tmp_parent:
        Path(tmp_parent).mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ec-archive-", dir=tmp_parent or None) as root:
        workspace = Path(root)
        if shutil.disk_usage(workspace).free < MIN_FREE_BYTES:
            raise ArchiveNormalizationError(
                "archive normalization disk capacity is temporarily unavailable"
            )
        archive = workspace / "archive.bin"
        extracted = workspace / "members"
        extracted.mkdir()
        _download_archive(owner_id, object_key, archive)
        digest = hashlib.sha256()
        with archive.open("rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        archive_sha = digest.hexdigest()
        upload_batch_id = str(batch_id or archive_sha)
        archive_format = _detect_format(archive)
        if archive_format == "zip":
            members = _extract_zip(archive, extracted)
        elif archive_format in {"tar", "tar.gz"}:
            members = _extract_tar(archive, extracted)
        elif archive_format == "gz":
            members = _extract_gzip(archive, extracted)
        elif archive_format == "7z":
            members = _extract_7z(archive, extracted)
        elif archive_format == "rar":
            raise ArchiveNormalizationError("RAR support is disabled until a controlled extractor is enabled")

        # Extraction is completed and cardinality is validated before the
        # first scan/upload.  This prevents over-limit archives from leaving a
        # silently truncated or partially uploaded normalized batch.
        extracted_members = list(members)
        from platform_v8.engine.task_registry import (
            get_spec,
            validate_file_shard_capacity,
            validate_input_file_count,
        )

        task_spec = get_spec(task_type)
        try:
            validate_input_file_count(
                task_spec,
                len(extracted_members),
                source="archive 解压成员",
            )
            validate_file_shard_capacity(
                task_spec,
                len(extracted_members),
                max_shards,
            )
        except ValueError as exc:
            raise ArchiveNormalizationError(str(exc)) from exc

        entries: list[dict] = []
        uploaded_keys: list[str] = []
        try:
            for index, (name, path, size, digest) in enumerate(extracted_members):
                _scan_member(path)
                item = NormalizedInput("", name, size, digest)
                key = _upload_member(owner_id, upload_batch_id, item, path)
                uploaded_keys.append(key)
                entries.append({
                    "index": index,
                    "name": name,
                    "object_key": key,
                    "size_bytes": size,
                    "sha256": digest,
                    "content_type": item.content_type,
                })
        except Exception:
            # Best effort only: provider implementations may not offer a native
            # server-side delete, but never intentionally retain known partial
            # batch members after a failed normalization.
            try:
                from platform_v8.services.oss_provider import get_oss_provider
                provider = get_oss_provider()
            except Exception:
                provider = None
            for key in uploaded_keys:
                try:
                    if provider is not None:
                        provider.delete_object(key)
                except Exception:
                    pass
            raise
        if not entries:
            raise ArchiveNormalizationError("archive contains no regular files")
        return {
            "schema": "input_batch.v1",
            "source_archive": object_key,
            "source_sha256": archive_sha,
            "format": archive_format,
            "entries": entries,
        }
