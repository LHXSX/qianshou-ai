"""Offline author signature for the exact six-file local order adapter.

The signer proves which enrolled publisher signed which bytes. It does not
prove immutable storage, independent execution or safe results; those remain
separate publication evidence roles. Shanghai API never reads package bytes.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import stat
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any

FILES = (
    "package.json", "pnpm-lock.yaml", "local-adapter.json",
    "src/adapter.mjs", "src/assemble_gif.py", "src/encode_frames.swift",
)
SCHEMA = "qianshou.order-adapter-author-manifest.v1"
ARCHIVE_FORMAT = "zip-source-v1"
PACKAGE_INVENTORY_ALGORITHM = "qianshou.bar-chart-package.v4"
SOURCE_PACKAGE_INVENTORY_ALGORITHM = "qianshou.source-package.v1"
_SOURCE_REQUIRED_FILES = frozenset({
    "package.json", "pnpm-lock.yaml", "local-adapter.json",
})
_SOURCE_ENTRY_FILES = frozenset({"src/adapter.mjs", "src/adapter.quickjs.js"})
_SOURCE_SEGMENT = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*\Z")
_PNPM_VOLATILE_METADATA = {
    "node_modules/.modules.yaml": ("prunedAt", "storeDir"),
    "node_modules/.pnpm-workspace-state-v1.json": ("lastValidatedTimestamp",),
}
_PNPM_ROOT_SHIMS = {
    "node_modules/.pnpm/node_modules/.bin/semver",
    "node_modules/.pnpm/sharp@0.35.3/node_modules/sharp/node_modules/.bin/semver",
}
_KEY_ID = re.compile(r"[A-Za-z0-9_.-]{1,64}\Z")
_B64 = re.compile(r"[A-Za-z0-9_-]+={0,2}\Z")
_VERSION = re.compile(r"[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}\Z")


class PackageProvenanceError(ValueError):
    pass


def _canonical(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _decode(value: Any, length: int) -> bytes:
    if not isinstance(value, str) or len(value) > 128 or not _B64.fullmatch(value):
        raise PackageProvenanceError("base64url encoding invalid")
    try:
        data = base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))
    except (ValueError, TypeError) as exc:
        raise PackageProvenanceError("base64url encoding invalid") from exc
    if len(data) != length:
        raise PackageProvenanceError("key or signature length invalid")
    return data


def _regular_bytes(path: Path, *, max_size: int = 2_000_000) -> bytes:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > max_size:
        raise PackageProvenanceError("adapter contains a link, special file or oversized file")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        opened = os.fstat(descriptor)
        if not stat.S_ISREG(opened.st_mode) or opened.st_ino != metadata.st_ino:
            raise PackageProvenanceError("adapter file changed while reading")
        with os.fdopen(descriptor, "rb", closefd=False) as file:
            content = file.read(max_size + 1)
        if len(content) != metadata.st_size or len(content) > max_size:
            raise PackageProvenanceError("adapter file changed while reading")
        return content
    finally:
        os.close(descriptor)


def _package_digest(root: Path, source_hex: str, *, python_path: str | Path,
                    swift_path: str | Path) -> str:
    """Mirror pinned-svg-video.ts v4: normalize only known pnpm install noise.

    This inventory is not proof of hermetic execution. Independent runner
    execution and the immutable source archive are separate approval gates.
    """
    dependencies = root / "node_modules"
    if not stat.S_ISDIR(dependencies.lstat().st_mode):
        raise PackageProvenanceError("node_modules is not an installed directory")
    digest = hashlib.sha256()
    digest.update((PACKAGE_INVENTORY_ALGORITHM + "\0").encode("ascii"))
    digest.update(source_hex.encode("ascii") + b"\0")
    entries = 0
    total_bytes = 0
    package_root = str(root.resolve(strict=True))

    def normalized_install_bytes(raw: bytes, key: str) -> bytes:
        if key in _PNPM_VOLATILE_METADATA:
            try:
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise ValueError("pnpm metadata must be an object")
                for field in _PNPM_VOLATILE_METADATA[key]:
                    value.pop(field, None)
                return _canonical(value)
            except (ValueError, UnicodeError) as exc:
                raise PackageProvenanceError("pnpm install metadata invalid") from exc
        if "/.bin/" in key:
            if key not in _PNPM_ROOT_SHIMS:
                raise PackageProvenanceError("unrecognized pnpm executable shim")
            try:
                return raw.decode("utf-8").replace(
                    package_root, "@PACKAGE_ROOT@").encode("utf-8")
            except UnicodeError as exc:
                raise PackageProvenanceError("pnpm executable shim invalid") from exc
        return raw

    def hash_file(path: Path, key: str, limit: int) -> None:
        nonlocal total_bytes
        metadata = path.lstat()
        total_bytes += metadata.st_size
        if (not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit
                or total_bytes > 384 * 1024 * 1024):
            raise PackageProvenanceError("installed dependency file invalid")
        descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        try:
            opened = os.fstat(descriptor)
            if not stat.S_ISREG(opened.st_mode) or opened.st_ino != metadata.st_ino:
                raise PackageProvenanceError("installed dependency changed while reading")
            actual = 0
            special = key in _PNPM_VOLATILE_METADATA or "/.bin/" in key
            special_bytes = bytearray() if special else None
            with os.fdopen(descriptor, "rb", closefd=False) as file:
                while chunk := file.read(128 * 1024):
                    actual += len(chunk)
                    if actual > metadata.st_size:
                        raise PackageProvenanceError("installed dependency grew while reading")
                    if special_bytes is not None:
                        special_bytes.extend(chunk)
                    else:
                        if actual == len(chunk):
                            digest.update(f"f\0{key}\0{metadata.st_size}\0".encode("utf-8"))
                        digest.update(chunk)
            if actual != metadata.st_size:
                raise PackageProvenanceError("installed dependency changed while reading")
            if special_bytes is not None:
                normalized = normalized_install_bytes(bytes(special_bytes), key)
                digest.update(f"f\0{key}\0{len(normalized)}\0".encode("utf-8"))
                digest.update(normalized)
            elif actual == 0:
                digest.update(f"f\0{key}\0{metadata.st_size}\0".encode("utf-8"))
        finally:
            os.close(descriptor)

    def visit(base: Path, directory: Path, prefix: str, *, pillow: bool = False) -> None:
        nonlocal entries
        for name in sorted(os.listdir(directory)):
            # Python bytecode encodes local interpreter/path/timestamp noise.
            # Only the installed Pillow tree may omit it; node_modules and
            # source files remain byte-for-byte pinned.
            if pillow and name == "__pycache__":
                continue
            if pillow and name.endswith(".pyc"):
                raise PackageProvenanceError("untracked Pillow bytecode outside __pycache__")
            path = directory / name
            relative_name = f"{prefix}/{path.relative_to(base).as_posix()}"
            metadata = path.lstat()
            entries += 1
            if entries > 5000:
                raise PackageProvenanceError("installed dependency tree too large")
            if stat.S_ISDIR(metadata.st_mode):
                digest.update(f"d\0{relative_name}\0".encode("utf-8"))
                visit(base, path, prefix, pillow=pillow)
            elif stat.S_ISLNK(metadata.st_mode):
                target = path.resolve(strict=True)
                if not target.is_relative_to(base.resolve()):
                    raise PackageProvenanceError("installed dependency link escapes package")
                # Absolute and relative links to the same in-tree entry are
                # equivalent after relocation; the target bytes are walked.
                target_name = target.relative_to(base.resolve()).as_posix()
                digest.update(f"l\0{relative_name}\0{target_name}\0".encode("utf-8"))
            elif stat.S_ISREG(metadata.st_mode):
                hash_file(path, relative_name, 32 * 1024 * 1024)
            else:
                raise PackageProvenanceError("installed dependency entry invalid")

    visit(dependencies, dependencies, "node_modules")
    if entries < 2 or total_bytes < 1_000_000:
        raise PackageProvenanceError("installed dependency tree incomplete")
    python_entry = Path(python_path)
    if not python_entry.is_absolute():
        raise PackageProvenanceError("selected Python path must be absolute")
    python = python_entry.resolve(strict=True)
    swift = Path(swift_path).resolve(strict=True)
    python_prefix = python_entry.parent.parent.resolve(strict=True)
    # The selected path and symlink spelling are locators, not package bytes.
    # The resolved interpreter contents are hashed below.
    hash_file(python, "runtime/python", 64 * 1024 * 1024)
    hash_file(swift, "runtime/swift-entry", 64 * 1024 * 1024)
    try:
        config = _regular_bytes(python_prefix / "pyvenv.cfg", max_size=16 * 1024)
    except FileNotFoundError:
        config = None
    if config is not None:
        try:
            fields: dict[str, str] = {}
            for line in config.decode("utf-8").splitlines():
                if not line.strip():
                    continue
                key, separator, value = line.partition("=")
                key = key.strip().lower()
                if (not separator or key not in {"home", "include-system-site-packages",
                        "version", "executable", "command", "prompt"} or key in fields):
                    raise ValueError("noncanonical Python venv configuration")
                value = value.strip()
                if not value or "\0" in value or len(value) > 4096:
                    raise ValueError("Python venv configuration value invalid")
                fields[key] = value
            if fields.get("include-system-site-packages") != "false":
                raise ValueError("system site packages are not isolated")
            version = fields.get("version", "")
            if not re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,3}", version):
                raise ValueError("Python venv version invalid")
            executable = fields.get("executable")
            if executable:
                executable_path = Path(executable)
                if not executable_path.is_absolute():
                    raise ValueError("Python venv executable path invalid")
                # A relocated venv may name a different absolute location, but
                # its base interpreter must still be byte-identical.
                if hashlib.sha256(_regular_bytes(executable_path, max_size=64 * 1024 * 1024)).digest() != hashlib.sha256(
                        _regular_bytes(python, max_size=64 * 1024 * 1024)).digest():
                    raise ValueError("Python venv base interpreter differs")
            if fields.get("home") and not Path(fields["home"]).is_absolute():
                raise ValueError("Python venv home path invalid")
            if executable and fields.get("home") and Path(executable).parent.resolve(strict=True) != Path(fields["home"]).resolve(strict=True):
                raise ValueError("Python venv home and executable differ")
        except (UnicodeError, OSError, ValueError) as exc:
            raise PackageProvenanceError("Python venv configuration invalid") from exc
        digest.update(f"python-venv\0{version}\0false\0{fields.get('prompt', '')}\0".encode("utf-8"))
    try:
        with tempfile.TemporaryDirectory(prefix="qs-pillow-probe-") as cache_dir:
            probe = subprocess.run(
                [str(python_path), "-I", "-B", "-X", f"pycache_prefix={cache_dir}", "-c",
                 'import json, PIL; print(json.dumps({"file": PIL.__file__, "version": PIL.__version__}))'],
                check=True, capture_output=True, text=True, timeout=5,
                env={"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "HOME": tempfile.gettempdir(),
                     "LANG": "C"},
            )
        if len(probe.stdout) > 4096:
            raise PackageProvenanceError("Pillow probe too large")
        identity = json.loads(probe.stdout.strip())
        pillow_file = identity["file"]
        version = identity["version"]
        if not isinstance(pillow_file, str) or not isinstance(version, str):
            raise PackageProvenanceError("Pillow identity invalid")
    except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as exc:
        if isinstance(exc, PackageProvenanceError):
            raise
        raise PackageProvenanceError("isolated Pillow runtime unavailable") from exc
    digest.update(f"pillow-version\0{version}\0".encode("utf-8"))
    pillow_dir = Path(pillow_file).parent.resolve(strict=True)
    if pillow_dir == python_prefix or not pillow_dir.is_relative_to(python_prefix):
        raise PackageProvenanceError("Pillow outside selected Python runtime")
    site_packages = pillow_dir.parent
    visit(pillow_dir, pillow_dir, "PIL", pillow=True)
    pillow_extra = re.compile(r"pillow(?:\.libs|-[^/]+\.dist-info)\Z", re.IGNORECASE)
    for name in sorted(item for item in os.listdir(site_packages) if pillow_extra.fullmatch(item)):
        path = site_packages / name
        if not stat.S_ISDIR(path.lstat().st_mode):
            raise PackageProvenanceError("Pillow metadata entry invalid")
        digest.update(f"d\0{name}\0".encode("utf-8"))
        visit(path, path, name)
    return digest.hexdigest()


def inventory(directory: str | Path, *, python_path: str | Path | None = None,
              swift_path: str | Path | None = None) -> dict[str, Any]:
    """Recompute exactly the installed-order-adapter.ts SHA-256 algorithm."""
    root = Path(directory)
    for folder in (root, root / "src"):
        metadata = folder.lstat()
        if not stat.S_ISDIR(metadata.st_mode):
            raise PackageProvenanceError("adapter directory must not be a symlink")
    digest = hashlib.sha256()
    file_rows: list[dict[str, Any]] = []
    contents: dict[str, bytes] = {}
    for name in FILES:
        data = _regular_bytes(root / name)
        if not data:
            raise PackageProvenanceError("adapter source file must not be empty")
        contents[name] = data
        digest.update(name.encode("utf-8") + b"\0" + str(len(data)).encode("ascii") + b"\0" + data)
        file_rows.append({"path": name, "size_bytes": len(data),
                          "sha256": hashlib.sha256(data).hexdigest()})
    try:
        package = json.loads(contents["package.json"])
        descriptor = json.loads(contents["local-adapter.json"])
    except (ValueError, UnicodeError) as exc:
        raise PackageProvenanceError("adapter manifest JSON invalid") from exc
    if (not isinstance(package, dict) or not isinstance(descriptor, dict)
            or not isinstance(package.get("version"), str)
            or not _VERSION.fullmatch(package["version"])
            or descriptor.get("schema") != "qianshou.local-adapter-candidate.v1"
            or descriptor.get("taskType") != "bar_chart_svg_v1"
            or descriptor.get("inputKind") != "inline_json"
            or descriptor.get("outputKind") != "local_artifact_manifest"):
        raise PackageProvenanceError("adapter contract declaration invalid")
    source_hex = digest.hexdigest()
    package_hex = (_package_digest(root, source_hex, python_path=python_path,
                                   swift_path=swift_path)
                   if python_path is not None and swift_path is not None else None)
    return {"task_type": "bar_chart_svg_v1", "capability_id": "video.render",
            "artifact_digest": "sha256:" + source_hex,
            "package_digest": "sha256:" + package_hex if package_hex else None,
            "version": package["version"], "files": file_rows,
            "platform_dispatchable_claim": descriptor.get("platformDispatchable") is True}


def _canonical_source_archive(contents: dict[str, bytes]) -> bytes:
    """The sole ZIP representation accepted by both the author and buyer."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_STORED,
                         allowZip64=False) as archive:
        for name in FILES:
            data = contents[name]
            if not 1 <= len(data) <= 2_000_000:
                raise PackageProvenanceError("source file size invalid")
            info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = (stat.S_IFREG | 0o644) << 16
            info.compress_type = zipfile.ZIP_STORED
            archive.writestr(info, data)
    return output.getvalue()


def build_source_archive(directory: str | Path, output_path: str | Path) -> dict[str, Any]:
    """Create a deterministic portable ZIP of the six reviewed source files.

    This is author tooling only. It does not upload or certify immutable OSS
    storage, nor does it embed the seller's machine-specific node_modules.
    """
    root = Path(directory).resolve(strict=True)
    target = Path(output_path)
    if target.exists() or target.is_relative_to(root):
        raise PackageProvenanceError("archive output exists or is inside adapter")
    source = inventory(root)
    temporary = None
    try:
        contents = {name: _regular_bytes(root / name) for name in FILES}
        archive_bytes = _canonical_source_archive(contents)
        with tempfile.NamedTemporaryFile(dir=target.parent, prefix=".order-adapter-",
                                         suffix=".zip", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(archive_bytes)
        result = inspect_source_archive(temporary)
        if result["artifact_digest"] != source["artifact_digest"]:
            raise PackageProvenanceError("archive source digest changed while packaging")
        os.link(temporary, target)
        return {**result, "archive_path": str(target)}
    except FileExistsError as exc:
        raise PackageProvenanceError("archive output already exists") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def inspect_source_archive(path: str | Path) -> dict[str, Any]:
    """Bounded local archive inspection for authors and buyer implementations."""
    source = Path(path)
    raw = _regular_bytes(source, max_size=16 * 1024 * 1024)
    if not raw:
        raise PackageProvenanceError("source archive size or type invalid")
    file_digest = hashlib.sha256()
    contents: dict[str, bytes] = {}
    try:
        with zipfile.ZipFile(io.BytesIO(raw), "r") as archive:
            if archive.namelist() != list(FILES):
                raise PackageProvenanceError("archive must contain exactly six source files")
            for info in archive.infolist():
                mode = info.external_attr >> 16
                if (info.compress_type != zipfile.ZIP_STORED or not stat.S_ISREG(mode)
                        or not 1 <= info.file_size <= 2_000_000 or info.flag_bits & 0x1
                        or info.date_time != (1980, 1, 1, 0, 0, 0)):
                    raise PackageProvenanceError("archive entry metadata invalid")
                data = archive.read(info)
                if len(data) != info.file_size:
                    raise PackageProvenanceError("archive entry changed during read")
                contents[info.filename] = data
                file_digest.update(info.filename.encode("utf-8") + b"\0"
                                   + str(len(data)).encode("ascii") + b"\0" + data)
    except (zipfile.BadZipFile, RuntimeError, EOFError) as exc:
        raise PackageProvenanceError("source archive invalid") from exc
    if raw != _canonical_source_archive(contents):
        raise PackageProvenanceError("source archive has noncanonical ZIP bytes")
    return {"archive_format": ARCHIVE_FORMAT,
            "archive_digest": "sha256:" + hashlib.sha256(raw).hexdigest(),
            "archive_size_bytes": len(raw),
            "artifact_digest": "sha256:" + file_digest.hexdigest()}


def sign_author_manifest(directory: str | Path, *, owner_id: int,
                         publisher_key_id: str, private_key_file: str | Path,
                         python_path: str | Path, swift_path: str | Path) -> dict[str, Any]:
    """Publisher action; a signature alone is never an approval receipt."""
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    except ImportError as exc:
        raise PackageProvenanceError("Ed25519 signing dependencies unavailable") from exc
    if type(owner_id) is not int or owner_id < 1 or not _KEY_ID.fullmatch(publisher_key_id):
        raise PackageProvenanceError("publisher identity invalid")
    path = Path(private_key_file)
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_mode & 0o077:
        raise PackageProvenanceError("publisher private key permissions invalid")
    try:
        signer = serialization.load_pem_private_key(path.read_bytes(), password=None)
    except (TypeError, ValueError) as exc:
        raise PackageProvenanceError("publisher private key invalid") from exc
    if not isinstance(signer, Ed25519PrivateKey):
        raise PackageProvenanceError("publisher key must be Ed25519")
    package = inventory(directory, python_path=python_path, swift_path=swift_path)
    if package["package_digest"] is None:
        raise PackageProvenanceError("complete installed package digest unavailable")
    payload = {"schema": SCHEMA, "owner_id": owner_id,
               "publisher_key_id": publisher_key_id, **package}
    return {"key_id": publisher_key_id, "payload": payload,
            "signature": base64.urlsafe_b64encode(signer.sign(_canonical(payload))).rstrip(b"=").decode("ascii")}


def verify_author_manifest(directory: str | Path, envelope: Any, *, owner_id: int,
                           publisher_roots: dict[str, dict[str, str]],
                           python_path: str | Path, swift_path: str | Path) -> dict[str, Any]:
    """Independent auditor uses operator-enrolled owner keys, never request keys."""
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as exc:
        raise PackageProvenanceError("Ed25519 verification dependencies unavailable") from exc
    try:
        if not isinstance(envelope, dict) or len(_canonical(envelope)) > 16 * 1024:
            raise PackageProvenanceError("author manifest missing or too large")
        payload = envelope["payload"]
        key_id = envelope["key_id"]
        if not isinstance(payload, dict) or not _KEY_ID.fullmatch(key_id):
            raise PackageProvenanceError("author manifest invalid")
        enrolled = publisher_roots.get(str(owner_id), {}).get(key_id)
        if not enrolled:
            raise PackageProvenanceError("publisher key is not enrolled for owner")
        Ed25519PublicKey.from_public_bytes(_decode(enrolled, 32)).verify(
            _decode(envelope["signature"], 64), _canonical(payload))
        expected = {"schema": SCHEMA, "owner_id": owner_id,
                    "publisher_key_id": key_id,
                    **inventory(directory, python_path=python_path,
                                swift_path=swift_path)}
        if payload != expected:
            raise PackageProvenanceError("signed package bytes or owner do not match")
        return {"publisher_signature_verified": True, "publisher_owner_id": owner_id,
                "publisher_key_id": key_id,
                "artifact_digest": expected["artifact_digest"],
                "package_digest": expected["package_digest"],
                "platform_dispatchable_claim": expected["platform_dispatchable_claim"]}
    except (KeyError, TypeError, InvalidSignature, ValueError) as exc:
        if isinstance(exc, PackageProvenanceError):
            raise
        raise PackageProvenanceError("author signature or package invalid") from exc


def verify_enrolled_manifest_metadata(envelope: Any, *, owner_id: int,
                                      artifact_digest: str, package_digest: str,
                                      publisher_roots: dict[str, dict[str, str]],
                                      publication_id: str | None = None,
                                      task_type: str | None = None,
                                      capability_id: str | None = None,
                                      version: str | None = None) -> dict[str, Any]:
    """Verify source/owner/runtime claims without fetching archive bytes in Shanghai.

    This confirms who signed the claims. The independently signed package
    evidence must separately bind them to a versioned immutable archive.
    """
    try:
        from cryptography.exceptions import InvalidSignature
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    except ImportError as exc:
        raise PackageProvenanceError("Ed25519 verification dependencies unavailable") from exc
    try:
        if not isinstance(envelope, dict) or len(_canonical(envelope)) > 64 * 1024:
            raise PackageProvenanceError("author manifest missing or too large")
        payload = envelope["payload"]
        key_id = envelope["key_id"]
        if not isinstance(payload, dict) or not isinstance(key_id, str) or not _KEY_ID.fullmatch(key_id):
            raise PackageProvenanceError("author manifest invalid")
        owner_roots = publisher_roots.get(str(owner_id))
        if not isinstance(owner_roots, dict):
            raise PackageProvenanceError("publisher key is not enrolled for owner")
        enrolled = owner_roots.get(key_id)
        if not enrolled:
            raise PackageProvenanceError("publisher key is not enrolled for owner")
        Ed25519PublicKey.from_public_bytes(_decode(enrolled, 32)).verify(
            _decode(envelope["signature"], 64), _canonical(payload))
        expected_schema = ("qianshou.order-adapter-author-manifest.v2"
                           if publication_id is not None else SCHEMA)
        algorithm = payload.get("inventory_algorithm")
        if publication_id is not None and (
                set(payload) != {"schema", "publication_id", "owner_id", "publisher_key_id",
                                 "task_type", "capability_id", "inventory_algorithm",
                                 "artifact_digest", "package_digest", "version", "files",
                                 "platform_dispatchable_claim"}
                or algorithm not in {PACKAGE_INVENTORY_ALGORITHM,
                                     SOURCE_PACKAGE_INVENTORY_ALGORITHM,
                                     "qianshou.native-binding-package.v1"}):
            raise PackageProvenanceError("author manifest inventory algorithm invalid")
        if (payload.get("schema") != expected_schema or payload.get("owner_id") != owner_id
                or payload.get("publisher_key_id") != key_id
                or (publication_id is not None
                    and payload.get("publication_id") != publication_id)
                or (publication_id is not None and task_type is None)
                or (publication_id is None and payload.get("task_type") != "bar_chart_svg_v1")
                or (task_type is not None and payload.get("task_type") != task_type)
                or (capability_id is not None and payload.get("capability_id") != capability_id)
                or (version is not None and payload.get("version") != version)
                or payload.get("artifact_digest") != artifact_digest
                or payload.get("package_digest") != package_digest
                or payload.get("platform_dispatchable_claim") is not True
                or not isinstance(payload.get("files"), list)):
            raise PackageProvenanceError("author manifest is not bound to approved adapter")
        files = payload["files"]
        if algorithm == PACKAGE_INVENTORY_ALGORITHM:
            if (payload.get("task_type") != "bar_chart_svg_v1"
                    or [item.get("path") for item in files] != list(FILES)):
                raise PackageProvenanceError("legacy author manifest file inventory invalid")
        elif algorithm in {SOURCE_PACKAGE_INVENTORY_ALGORITHM, "qianshou.native-binding-package.v1"}:
            if not 4 <= len(files) <= 128:
                raise PackageProvenanceError("source package file count invalid")
            total_bytes = 0
            paths: list[str] = []
            for item in files:
                if not isinstance(item, dict) or set(item) != {"path", "size_bytes", "sha256"}:
                    raise PackageProvenanceError("source package file metadata invalid")
                path, size, digest = item["path"], item["size_bytes"], item["sha256"]
                if (not isinstance(path, str) or not 1 <= len(path) <= 240
                        or any(not _SOURCE_SEGMENT.fullmatch(part) or part in {".", ".."}
                               for part in path.split("/"))):
                    raise PackageProvenanceError("source package path invalid")
                if type(size) is not int or not 1 <= size <= 2_000_000:
                    raise PackageProvenanceError("source package file size invalid")
                if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
                    raise PackageProvenanceError("source package file digest invalid")
                paths.append(path)
                total_bytes += size
            if (paths != sorted(set(paths), key=lambda path: path.encode("utf-8"))
                    or not _SOURCE_REQUIRED_FILES.issubset(paths)
                    or (paths != ["local-adapter.json", "package.json", "pnpm-lock.yaml", "task-definition.json"]
                        if algorithm == "qianshou.native-binding-package.v1"
                        else len(_SOURCE_ENTRY_FILES.intersection(paths)) != 1)
                    or total_bytes > 16 * 1024 * 1024):
                raise PackageProvenanceError("source package inventory invalid")
        return {"key_id": key_id, "public_key": enrolled, "envelope": envelope}
    except (KeyError, TypeError, ValueError, InvalidSignature, AttributeError) as exc:
        if isinstance(exc, PackageProvenanceError):
            raise
        raise PackageProvenanceError("author signature or metadata invalid") from exc
