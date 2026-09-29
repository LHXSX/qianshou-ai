"""Private byte receipt for a fresh, locked pair of Windows Python venvs.

This source file is portable.  The receipt contains machine paths and stays
beside the prepared venvs outside the canonical source checkout.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path


RECEIPT_NAME = "prepare-receipt.json"
SCOPE = "qs_new4/E_light4_sage"
ROOT_ENTRIES = {
    "wheels", "api", "comfy", "prepare.log",
    "api-requirements.txt", "comfy-requirements.txt",
}


def fail(message: str) -> None:
    raise RuntimeError(message)


def digest(path: Path) -> str:
    hasher = hashlib.sha256()
    with path.open("rb") as reader:
        for block in iter(lambda: reader.read(8 * 1024 * 1024), b""):
            hasher.update(block)
    return hasher.hexdigest()


def physical(path: Path, *, directory: bool) -> Path:
    if not path.is_absolute():
        fail("准备环境路径必须为绝对路径")
    for part in (path, *path.parents):
        if part.exists() and (part.is_symlink() or getattr(part, "is_junction", lambda: False)()):
            fail("准备环境路径含 symlink 或 junction")
    if directory:
        if not path.is_dir():
            fail("准备环境目录缺失")
    elif not path.is_file() or path.stat().st_nlink != 1:
        fail("准备环境文件缺失或为多硬链接")
    return path.resolve(strict=True)


def tree_inventory(root: Path) -> dict:
    root = physical(root, directory=True)
    directories: set[str] = set()
    files: list[dict] = []

    def walk_error(error: OSError) -> None:
        raise error

    for current, dirs, names in os.walk(root, topdown=True, followlinks=False,
                                        onerror=walk_error):
        directory = Path(current)
        if directory != root:
            directories.add(directory.relative_to(root).as_posix())
        for name in dirs:
            child = directory / name
            if (not child.is_dir() or child.is_symlink() or
                    getattr(child, "is_junction", lambda: False)()):
                fail("准备环境含重定向目录")
        for name in names:
            path = directory / name
            if (not path.is_file() or path.is_symlink() or
                    getattr(path, "is_junction", lambda: False)() or
                    path.stat().st_nlink != 1):
                fail("准备环境含链接或非普通文件")
            before = path.stat()
            raw_sha256 = digest(path)
            after = path.stat()
            generation = lambda stat: (stat.st_dev, stat.st_ino, stat.st_size,
                                       stat.st_mtime_ns, stat.st_ctime_ns)
            if generation(before) != generation(after):
                fail("准备环境文件在摘要测量期间改变")
            files.append({"path": path.relative_to(root).as_posix(),
                          "size": after.st_size, "sha256": raw_sha256})
    return {"directories": sorted(directories),
            "files": sorted(files, key=lambda row: row["path"])}


def snapshot(prepared_root: Path, dependency_lock: Path, wheel_lock: Path,
             *, receipt_exists: bool) -> dict:
    root = physical(prepared_root, directory=True)
    dependency_lock = physical(dependency_lock, directory=False)
    wheel_lock = physical(wheel_lock, directory=False)
    expected_root_entries = ROOT_ENTRIES | ({RECEIPT_NAME} if receipt_exists else set())
    if {path.name for path in root.iterdir()} != expected_root_entries:
        fail("准备环境根目录文件集合不固定或含 needs-inspection")
    auxiliary = {}
    for name in ("prepare.log", "api-requirements.txt", "comfy-requirements.txt"):
        path = physical(root / name, directory=False)
        auxiliary[name] = {"size": path.stat().st_size, "sha256": digest(path)}
    dependency = json.loads(dependency_lock.read_text(encoding="utf-8"))
    wheels = json.loads(wheel_lock.read_text(encoding="utf-8"))
    if (dependency.get("scope") != SCOPE or wheels.get("scope") != SCOPE or
            dependency.get("schemaVersion") != 2 or wheels.get("schemaVersion") != 1 or
            wheels.get("target") != {"python": "3.12.10", "implementation": "CPython",
                                     "platform": "win_amd64"} or
            len(wheels.get("wheels", {})) != 128):
        fail("准备环境锁版本、目标或 wheel 数量不固定")
    expected_wheels = {row["filename"]: row["sha256"]
                       for row in wheels["wheels"].values()}
    if len(expected_wheels) != 128:
        fail("wheel 锁有重复文件名")
    wheel_inventory = tree_inventory(root / "wheels")
    if wheel_inventory["directories"] or {row["path"] for row in wheel_inventory["files"]} != set(expected_wheels):
        fail("wheelhouse 文件集合不等于 128 个锁定 wheel")
    for row in wheel_inventory["files"]:
        if row["sha256"] != expected_wheels[row["path"]]:
            fail("wheelhouse 原字节与来源锁不符")
    paths = {
        "apiPython": str(physical(root / "api" / "Scripts" / "python.exe", directory=False)),
        "comfyPython": str(physical(root / "comfy" / "Scripts" / "python.exe", directory=False)),
    }
    return {
        "schemaVersion": 1,
        "scope": SCOPE,
        "lockSha256": {
            "dependencies.lock.json": digest(dependency_lock),
            "python-wheels.lock.json": digest(wheel_lock),
        },
        "interpreters": paths,
        "auxiliary": auxiliary,
        "wheelhouse": wheel_inventory,
        "environments": {
            "api": tree_inventory(root / "api"),
            "comfy": tree_inventory(root / "comfy"),
        },
    }


def write_receipt(prepared_root: Path, dependency_lock: Path, wheel_lock: Path) -> Path:
    root = physical(prepared_root, directory=True)
    destination = root / RECEIPT_NAME
    if destination.exists():
        fail("准备回执已存在；拒绝覆盖")
    document = snapshot(root, dependency_lock, wheel_lock, receipt_exists=False)
    raw = (json.dumps(document, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":")) + "\n").encode("utf-8")
    # Exclusive creation avoids replacing a receipt another process created
    # after our snapshot.  Any interrupted partial file remains for inspection;
    # the prepare caller marks the root needs-inspection and never reuses it.
    with destination.open("xb") as writer:
        writer.write(raw)
        writer.flush()
        os.fsync(writer.fileno())
    return destination


def verify_receipt(receipt: Path, dependency_lock: Path, wheel_lock: Path,
                   api_python: Path, comfy_python: Path,
                   *, expected_sha256: str | None = None) -> str:
    receipt = physical(receipt, directory=False)
    if receipt.name != RECEIPT_NAME:
        fail("准备回执文件名不固定")
    before = receipt.stat()
    raw = receipt.read_bytes()
    after = receipt.stat()
    generation = lambda stat: (stat.st_dev, stat.st_ino, stat.st_size,
                               stat.st_mtime_ns, stat.st_ctime_ns)
    if generation(before) != generation(after):
        fail("准备回执在读取期间改变")
    raw_sha256 = hashlib.sha256(raw).hexdigest()
    if expected_sha256 is not None and raw_sha256 != expected_sha256:
        fail("准备回执原字节改变")
    try:
        recorded = json.loads(raw.decode("utf-8"))
    except (UnicodeError, ValueError):
        fail("准备回执不是有效 JSON")
    actual = snapshot(receipt.parent, dependency_lock, wheel_lock, receipt_exists=True)
    if recorded != actual:
        fail("准备回执与 128 wheel 或两个 venv 的当前字节/文件集合不符")
    if (actual["interpreters"]["apiPython"] != str(physical(api_python, directory=False)) or
            actual["interpreters"]["comfyPython"] != str(physical(comfy_python, directory=False))):
        fail("安装解释器不属于同一个已核准备环境")
    if generation(receipt.stat()) != generation(before) or digest(receipt) != raw_sha256:
        fail("准备回执在环境复核期间改变")
    return raw_sha256
