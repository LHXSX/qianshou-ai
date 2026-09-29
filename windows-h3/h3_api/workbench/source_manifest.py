"""Verify the exact canonical H3/Comfy source inventory at each job boundary.

The public identity is SHA256 of the shipped manifest's UTF-8 bytes. Local
installation paths and file generation metadata are checked, never published.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
from threading import RLock

if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt

    _kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    _create_file = _kernel.CreateFileW
    _create_file.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                             ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    _create_file.restype = wintypes.HANDLE
    _final_path = _kernel.GetFinalPathNameByHandleW
    _final_path.argtypes = [wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD]
    _final_path.restype = wintypes.DWORD

    class _ByHandleInfo(ctypes.Structure):
        _fields_ = [("attributes", wintypes.DWORD), ("creation_high", wintypes.DWORD),
                    ("creation_low", wintypes.DWORD), ("access_high", wintypes.DWORD),
                    ("access_low", wintypes.DWORD), ("write_high", wintypes.DWORD),
                    ("write_low", wintypes.DWORD), ("volume", wintypes.DWORD),
                    ("size_high", wintypes.DWORD), ("size_low", wintypes.DWORD),
                    ("links", wintypes.DWORD), ("index_high", wintypes.DWORD),
                    ("index_low", wintypes.DWORD)]

    _file_info = _kernel.GetFileInformationByHandle
    _file_info.argtypes = [wintypes.HANDLE, ctypes.POINTER(_ByHandleInfo)]
    _file_info.restype = wintypes.BOOL
    _close_handle = _kernel.CloseHandle
    _close_handle.argtypes = [wintypes.HANDLE]
    _close_handle.restype = wintypes.BOOL


_SHA = re.compile(r"[0-9a-f]{64}\Z")
_AREAS = ("h3_api", "comfy")


class SourceManifestError(RuntimeError):
    pass


def _is_reparse(path: Path) -> bool:
    try:
        details = path.lstat()
    except OSError as error:
        raise SourceManifestError("Canonical source path is unavailable") from error
    return bool(path.is_symlink() or getattr(path, "is_junction", lambda: False)() or
                getattr(details, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def _reject_reparse_chain(path: Path) -> None:
    for piece in (path, *path.parents):
        if _is_reparse(piece):
            raise SourceManifestError("Canonical source path contains a reparse point")


def _absolute_existing(path: Path, *, directory: bool) -> Path:
    if not path.is_absolute() or not path.exists():
        raise SourceManifestError("Canonical source root or manifest must be an existing absolute path")
    _reject_reparse_chain(path)
    resolved = path.resolve(strict=True)
    if directory != resolved.is_dir():
        raise SourceManifestError("Canonical source path has the wrong file type")
    return resolved


def _relative_source_path(value: object, suffix: str = ".py") -> str:
    if not isinstance(value, str) or not value or "\\" in value or value.startswith("/"):
        raise SourceManifestError("Invalid relative canonical source path")
    path = PurePosixPath(value)
    if path.as_posix() != value or any(part in ("", ".", "..") for part in value.split("/")) or path.suffix != suffix:
        raise SourceManifestError("Invalid relative canonical source path")
    return value


def _generation(path: Path) -> tuple[int, int, int, int]:
    info = path.stat()
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns)


def _physical_name(value: str | Path) -> str:
    name = str(value)
    if name.startswith("\\\\?\\UNC\\"):
        name = "\\\\" + name[8:]
    elif name.startswith("\\\\?\\"):
        name = name[4:]
    return os.path.normcase(os.path.normpath(name))


def _checked_bytes(path: Path, physical_path: Path, *, max_bytes: int | None = None) -> tuple[bytes, tuple[int, int, int, int]]:
    """Read from one exclusive handle and check its final physical target."""
    _reject_reparse_chain(path)
    if os.name != "nt":
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        with os.fdopen(os.open(path, flags), "rb") as stream:
            before = os.fstat(stream.fileno())
            if max_bytes is not None and before.st_size > max_bytes:
                raise SourceManifestError("Canonical file exceeds the byte limit")
            if _physical_name(path.resolve(strict=True)) != _physical_name(physical_path):
                raise SourceManifestError("Canonical source physical path changed")
            raw = stream.read(None if max_bytes is None else max_bytes + 1)
            after = os.fstat(stream.fileno())
    else:
        handle = _create_file(str(path), 0x80000000, 0, None, 3, 0x00200000, None)
        if handle == wintypes.HANDLE(-1).value:
            raise SourceManifestError("Canonical source exclusive handle is unavailable")
        transferred = False
        try:
            info = _ByHandleInfo()
            if not _file_info(handle, ctypes.byref(info)):
                raise SourceManifestError("Canonical source handle identity is unavailable")
            if info.attributes & (0x400 | 0x10):
                raise SourceManifestError("Canonical source is redirected or a directory")
            if info.links != 1:
                raise SourceManifestError("Canonical source hard links are not permitted")
            capacity = 32768
            buffer = ctypes.create_unicode_buffer(capacity)
            count = _final_path(handle, buffer, capacity, 0)
            if count == 0 or count >= capacity:
                raise SourceManifestError("Canonical source final path is unavailable")
            if _physical_name(buffer.value) != _physical_name(physical_path):
                raise SourceManifestError("Canonical source physical path changed")
            fd = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            transferred = True
            with os.fdopen(fd, "rb") as stream:
                before = os.fstat(stream.fileno())
                if max_bytes is not None and before.st_size > max_bytes:
                    raise SourceManifestError("Canonical file exceeds the byte limit")
                raw = stream.read(None if max_bytes is None else max_bytes + 1)
                after = os.fstat(stream.fileno())
        finally:
            if not transferred:
                _close_handle(handle)
    first = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
    last = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
    if getattr(after, "st_nlink", 1) != 1:
        raise SourceManifestError("Canonical source hard links are not permitted")
    if (first != last or len(raw) != last[2] or
            (max_bytes is not None and len(raw) > max_bytes)):
        raise SourceManifestError("Canonical source changed while being read")
    return raw, last


class _HeldFile:
    """Freeze an API source handle so bytes cannot be edited between stages."""

    def __init__(self, path: Path):
        self.path = path
        self._lock = RLock()
        _reject_reparse_chain(path)
        if os.name == "nt":
            handle = _create_file(str(path), 0x80000000, 1, None, 3, 0x00200000, None)
            if handle == wintypes.HANDLE(-1).value:
                raise SourceManifestError("Canonical source boot handle is unavailable")
            try:
                info = _ByHandleInfo()
                if not _file_info(handle, ctypes.byref(info)) or info.attributes & (0x400 | 0x10) or info.links != 1:
                    raise SourceManifestError("Canonical source boot handle is redirected or linked")
                self.stream = os.fdopen(msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY), "rb")
            except Exception:
                _close_handle(handle)
                raise
        else:
            self.stream = os.fdopen(os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb")
        self.expected_path = path
        self.read()  # verify the held handle's physical target immediately

    def read(self) -> tuple[bytes, tuple[int, int, int, int]]:
        with self._lock:
            return self._read_locked()

    def close(self) -> None:
        stream = getattr(self, "stream", None)
        if stream is not None and not stream.closed:
            stream.close()

    def __del__(self):
        self.close()

    def _read_locked(self) -> tuple[bytes, tuple[int, int, int, int]]:
        _reject_reparse_chain(self.path)
        if os.name == "nt":
            handle = msvcrt.get_osfhandle(self.stream.fileno())
            buffer = ctypes.create_unicode_buffer(32768)
            count = _final_path(handle, buffer, len(buffer), 0)
            if count == 0 or count >= len(buffer) or _physical_name(buffer.value) != _physical_name(self.expected_path):
                raise SourceManifestError("Canonical source held handle physical path changed")
        elif _physical_name(self.path.resolve(strict=True)) != _physical_name(self.expected_path):
            raise SourceManifestError("Canonical source held handle physical path changed")
        before = os.fstat(self.stream.fileno())
        path_info = self.path.stat()
        if (before.st_dev, before.st_ino) != (path_info.st_dev, path_info.st_ino):
            raise SourceManifestError("Canonical source path no longer names the startup file")
        self.stream.seek(0)
        raw = self.stream.read()
        after = os.fstat(self.stream.fileno())
        first = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
        last = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)
        if first != last or len(raw) != last[2] or getattr(after, "st_nlink", 1) != 1:
            raise SourceManifestError("Canonical source changed on a held handle")
        return raw, last


class RuntimeSourceManifest:
    def __init__(self, api_root: Path, comfy_root: Path, manifest_path: Path):
        if not sys.dont_write_bytecode:
            raise SourceManifestError("Canonical H3 and Comfy must start with Python -B")
        self.roots = {
            "h3_api": _absolute_existing(Path(api_root), directory=True),
            "comfy": _absolute_existing(Path(comfy_root), directory=True),
        }
        self.manifest_path = _absolute_existing(Path(manifest_path), directory=False)
        self._manifest_held = _HeldFile(self.manifest_path)
        raw, manifest_generation = self._manifest_held.read()
        self.sha256 = hashlib.sha256(raw).hexdigest()
        try:
            document = json.loads(raw.decode("utf-8"))
        except (UnicodeError, ValueError) as error:
            raise SourceManifestError("Canonical manifest is not valid UTF-8 JSON") from error
        if not isinstance(document, dict) or document.get("schemaVersion") != 1:
            raise SourceManifestError("Unsupported canonical manifest schema")
        rows = document.get("runtimeSourceFiles")
        if not isinstance(rows, list) or not rows:
            raise SourceManifestError("Canonical runtime source list is missing")
        self.entries: dict[tuple[str, str], tuple[int, str, str]] = {}
        auxiliary = document.get("runtimeAuxiliaryFiles")
        if not isinstance(auxiliary, list) or not auxiliary:
            raise SourceManifestError("Canonical runtime auxiliary list is missing")
        for row, suffix in ([(row, ".py") for row in rows] +
                            [(row, ".json") for row in auxiliary]):
            if not isinstance(row, dict) or row.get("area") not in _AREAS:
                raise SourceManifestError("Invalid canonical runtime source area")
            area = row["area"]
            relative = _relative_source_path(row.get("path"), suffix)
            size, raw_sha, origin = row.get("size"), row.get("rawSha256"), row.get("origin")
            if (type(size) is not int or size < 0 or not isinstance(raw_sha, str) or
                    not _SHA.fullmatch(raw_sha) or not isinstance(origin, str) or not origin):
                raise SourceManifestError("Invalid canonical runtime source identity")
            key = (area, relative)
            if key in self.entries:
                raise SourceManifestError("Duplicate canonical runtime source")
            self.entries[key] = (size, raw_sha, origin)
        inventory = document.get("runtimeInventoryRoots")
        expected_inventory = [{"area": area, "relativeDir": ".", "extension": ".py", "recursive": True}
                              for area in _AREAS]
        if (not isinstance(inventory, list) or len(inventory) != len(expected_inventory) or
                any(not isinstance(item, dict) for item in inventory) or
                {tuple(sorted(item.items())) for item in inventory} !=
                {tuple(sorted(item.items())) for item in expected_inventory}):
            raise SourceManifestError("Canonical runtime inventory scope is incomplete")
        excludes = document.get("runtimeInventoryExcludeDirs")
        if not isinstance(excludes, list):
            raise SourceManifestError("Canonical inventory exclusions are missing")
        self.excludes: dict[str, set[str]] = {area: set() for area in _AREAS}
        for row in excludes:
            if not isinstance(row, dict) or row.get("area") not in _AREAS:
                raise SourceManifestError("Invalid canonical inventory exclusion")
            area = row["area"]
            relative = row.get("relativeDir")
            if (not isinstance(relative, str) or not relative or "\\" in relative or
                    relative.startswith("/") or any(part in ("", ".", "..") for part in relative.split("/"))):
                raise SourceManifestError("Invalid canonical inventory exclusion path")
            self.excludes[area].add(relative)
        expected_excludes = {
            "h3_api": set(),
            "comfy": {".git", "custom_nodes/ComfyUI-KJNodes/.git",
                      "custom_nodes/ComfyUI_LayerStyle/.git",
                      "custom_nodes/ComfyUI-VideoHelperSuite/.git",
                      "models", "input", "output", "temp", "user"},
        }
        if self.excludes != expected_excludes or len(excludes) != sum(map(len, expected_excludes.values())):
            raise SourceManifestError("Canonical inventory exclusions differ from the fixed scope")
        aux_inventory = document.get("runtimeAuxiliaryInventoryDirs")
        expected_aux = [{"area": "comfy", "relativeDir": "custom_nodes/ComfyUI-VideoHelperSuite/video_formats",
                         "extension": ".json", "recursive": False}]
        if aux_inventory != expected_aux:
            raise SourceManifestError("Canonical auxiliary inventory scope is incomplete")
        required_classes = document.get("requiredGraphClassTypes")
        if (not isinstance(required_classes, list) or not required_classes or
                any(not isinstance(value, str) or not value for value in required_classes) or
                required_classes != sorted(set(required_classes))):
            raise SourceManifestError("Canonical graph class set is missing or unordered")
        self.required_graph_class_types = tuple(required_classes)
        self._held_api = {
            key: _HeldFile(self.roots["h3_api"] / Path(key[1]))
            for key in self.entries if key[0] == "h3_api"
        }
        self._first_generation: dict[tuple[str, str], tuple[int, int, int, int]] | None = None
        self._manifest_generation: tuple[int, int, int, int] | None = manifest_generation
        self.check()  # freeze private file generations at controlled startup

    def _inventory(self) -> set[tuple[str, str]]:
        actual: set[tuple[str, str]] = set()
        for area, root in self.roots.items():
            for current, dirs, files in os.walk(root, topdown=True, followlinks=False):
                directory = Path(current)
                _reject_reparse_chain(directory)
                for name in dirs[:]:
                    relative_dir = (directory / name).relative_to(root).as_posix()
                    if relative_dir in self.excludes[area]:
                        dirs.remove(name)
                        continue
                    if _is_reparse(directory / name):
                        raise SourceManifestError("Canonical source directory is redirected")
                for name in files:
                    if name.endswith((".pyc", ".pyo")):
                        raise SourceManifestError("Canonical runtime bytecode is not permitted")
                    if not name.endswith(".py"):
                        continue
                    file = directory / name
                    _reject_reparse_chain(file)
                    relative = file.relative_to(root).as_posix()
                    actual.add((area, relative))
        aux_root = self.roots["comfy"] / "custom_nodes/ComfyUI-VideoHelperSuite/video_formats"
        _reject_reparse_chain(aux_root)
        if not aux_root.is_dir():
            raise SourceManifestError("Canonical VHS format source is unavailable")
        for file in aux_root.iterdir():
            _reject_reparse_chain(file)
            if file.is_file() and file.suffix == ".json":
                actual.add(("comfy", file.relative_to(self.roots["comfy"]).as_posix()))
        return actual

    def check(self) -> str:
        """Verify exact inventory, bytes and the private startup generation."""
        manifest_raw, manifest_after = self._manifest_held.read()
        if hashlib.sha256(manifest_raw).hexdigest() != self.sha256:
            raise SourceManifestError("Canonical manifest changed after startup")
        if self._manifest_generation is not None and manifest_after != self._manifest_generation:
            raise SourceManifestError("Canonical manifest file generation changed; restart and self-test")
        actual = self._inventory()
        if actual != set(self.entries):
            raise SourceManifestError("Canonical runtime source inventory changed")
        generation: dict[tuple[str, str], tuple[int, int, int, int]] = {}
        for key, (size, expected_sha, _origin) in self.entries.items():
            area, relative = key
            file = self.roots[area] / Path(relative)
            raw, after = (self._held_api[key].read() if key[0] == "h3_api"
                          else _checked_bytes(file, file))
            if after[2] != size:
                raise SourceManifestError("Canonical runtime source size changed")
            if hashlib.sha256(raw).hexdigest() != expected_sha:
                raise SourceManifestError("Canonical runtime source bytes changed")
            generation[key] = after
        if self._first_generation is not None and generation != self._first_generation:
            raise SourceManifestError("Canonical source file generation changed; restart and self-test")
        self._first_generation = generation
        self._manifest_generation = manifest_after
        return self.sha256


class FrozenBinary:
    """Private file generation and byte digest for a local ffmpeg executable."""

    def __init__(self, path: Path):
        self.path = _absolute_existing(Path(path), directory=False)
        self._held = _HeldFile(self.path)
        self.first_generation: tuple[int, int, int, int] | None = None
        self.sha256: str | None = None
        self.check()

    def check(self) -> str:
        raw, after = self._held.read()
        digest = hashlib.sha256(raw).hexdigest()
        if self.first_generation is not None and after != self.first_generation:
            raise SourceManifestError("Delivery encoder generation changed; restart and self-test")
        if self.sha256 is not None and digest != self.sha256:
            raise SourceManifestError("Delivery encoder bytes changed; restart and self-test")
        self.first_generation = after
        self.sha256 = digest
        return digest


class FrozenOptionalFile:
    """Freeze both presence and bytes of a private Comfy configuration file."""

    def __init__(self, path: Path):
        path = Path(path)
        if not path.is_absolute():
            raise SourceManifestError("Private configuration path must be absolute")
        _reject_reparse_chain(path.parent)
        self.path = path
        self._held = _HeldFile(path) if path.exists() else None
        self._generation = None
        self._sha256 = None
        self.check()

    def check(self) -> str | None:
        _reject_reparse_chain(self.path.parent)
        if self._held is None:
            if self.path.exists() or self.path.is_symlink():
                raise SourceManifestError("Private Comfy configuration appeared after startup")
            return None
        raw, generation = self._held.read()
        digest = hashlib.sha256(raw).hexdigest()
        if self._generation is not None and generation != self._generation:
            raise SourceManifestError("Private Comfy configuration generation changed")
        if self._sha256 is not None and digest != self._sha256:
            raise SourceManifestError("Private Comfy configuration bytes changed")
        self._generation, self._sha256 = generation, digest
        return digest
