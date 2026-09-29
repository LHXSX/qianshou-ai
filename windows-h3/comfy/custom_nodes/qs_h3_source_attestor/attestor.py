"""Read-only, in-process source witness for the fixed Qianshou H3 graph.

No model is loaded here. Each source is opened exclusively for a short read,
then reopened and rehashed for every request against its boot generation.
Only public relative identities and digests leave the process.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import hmac
import inspect
import ipaddress
import json
import marshal
import os
from pathlib import Path, PurePosixPath
import re
import secrets
import stat
import sys
import threading
from types import CodeType, ModuleType
from typing import Mapping


class SourceIdentityError(RuntimeError):
    pass


_VHS_FORMATS = frozenset({
    "16bit-png.json", "8bit-png.json", "av1-webm.json", "ffmpeg-gif.json",
    "ffv1-mkv.json", "gifski.json", "h264-mp4.json", "h265-mp4.json",
    "nvenc_av1-mp4.json", "nvenc_h264-mp4.json", "nvenc_hevc-mp4.json",
    "ProRes.json", "webm.json",
})
_V3_GRAPH_CLASSES = frozenset({
    "BasicGuider", "ImageFromBatch", "MiniMaxH3ImageToVideo",
    "RandomNoise", "SamplerCustomAdvanced", "VAEDecodeAudio",
})
_V1_GRAPH_METHODS = {
    "CLIPLoader": "load_clip",
    "LayerUtility: PurgeVRAM V2": "purge_vram_v2",
    "LoadImage": "load_image",
    "LoraLoaderBypassModelOnly": "load_lora_model_only",
    "PathchSageAttentionKJ": "patch",
    "QSH3BenchmarkDualClock": "build",
    "SaveImage": "save_images",
    "UNETLoader": "load_unet",
    "VAEDecode": "decode",
    "VAELoader": "load_vae",
    "VHS_VideoCombine": "combine_video",
}
_FIXED_CLASS_NAMES = {name: name for name in _V3_GRAPH_CLASSES | _V1_GRAPH_METHODS.keys()}
_FIXED_CLASS_NAMES["LayerUtility: PurgeVRAM V2"] = "PurgeVRAM_V2"
_FIXED_CLASS_NAMES["VHS_VideoCombine"] = "VideoCombine"


def _fail(message: str) -> None:
    raise SourceIdentityError(message)


def _sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _json_sha256(value: object) -> str:
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True,
                     separators=(",", ":"), allow_nan=False).encode("utf-8")
    return _sha256(raw)


def _relative(value: str) -> str:
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        _fail("invalid relative source path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in value.split("/")):
        _fail("invalid relative source path")
    return path.as_posix()


def _is_reparse(path: Path) -> bool:
    info = os.lstat(path)
    if stat.S_ISLNK(info.st_mode):
        return True
    return bool(getattr(info, "st_file_attributes", 0) & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0))


def _no_reparse_ancestors(path: Path) -> None:
    path = Path(os.path.abspath(path))
    for candidate in reversed((path, *path.parents)):
        if candidate.exists() and _is_reparse(candidate):
            _fail("source path contains a reparse point")


def loopback_request_ok(listener: str, local: str, remote: str) -> bool:
    """Require a direct loopback listener and a direct loopback TCP request."""
    try:
        return all(ipaddress.ip_address(value).is_loopback
                   for value in (listener, local, remote))
    except ValueError:
        return False


def _actual_function(method: object):
    """Return the callable Python actually invokes; never follow __wrapped__."""
    if inspect.ismethod(method):
        function = method.__func__
    elif inspect.isfunction(method):
        function = method
    else:
        _fail("fixed graph execution target is not a Python method")
    code = getattr(function, "__code__", None)
    if not isinstance(code, CodeType):
        _fail("fixed graph execution method has no Python code")
    return function


def _method_fingerprint(method: object) -> str:
    code = _actual_function(method).__code__
    # This is an in-process generation witness, not a public source identity.
    return _sha256(marshal.dumps(code))


def _loaded_method_matches_source(method: object, raw: bytes,
                                  declaring_class: str, method_name: str) -> bool:
    """Match the actual callable to the exact pinned class scope and code."""
    function = _actual_function(method)
    code = function.__code__
    qualname = declaring_class + "." + method_name
    if (code.co_name != method_name or code.co_qualname != qualname or
            function.__qualname__ != qualname):
        return False
    try:
        compiled = compile(raw, code.co_filename, "exec", dont_inherit=True)
    except (SyntaxError, UnicodeError):
        return False
    pending = [compiled]
    while pending:
        current = pending.pop()
        for value in current.co_consts:
            if isinstance(value, CodeType):
                if (value.co_name == declaring_class.rsplit(".", 1)[-1] and
                        value.co_qualname == declaring_class):
                    return any(isinstance(child, CodeType) and
                               child.co_qualname == qualname and child == code
                               for child in value.co_consts)
                pending.append(value)
    return False


if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt

    _K32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _K32.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                 wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    _K32.CreateFileW.restype = wintypes.HANDLE
    _K32.GetFileInformationByHandle.argtypes = (wintypes.HANDLE, wintypes.LPVOID)
    _K32.GetFileInformationByHandle.restype = wintypes.BOOL
    _K32.GetFileInformationByHandleEx.argtypes = (wintypes.HANDLE, wintypes.DWORD,
                                                 wintypes.LPVOID, wintypes.DWORD)
    _K32.GetFileInformationByHandleEx.restype = wintypes.BOOL
    _K32.GetFinalPathNameByHandleW.argtypes = (wintypes.HANDLE, wintypes.LPWSTR,
                                               wintypes.DWORD, wintypes.DWORD)
    _K32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    _K32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _K32.CloseHandle.restype = wintypes.BOOL

    _INVALID_HANDLE = ctypes.c_void_p(-1).value
    _GENERIC_READ = 0x80000000
    _FILE_READ_ATTRIBUTES = 0x80
    _FILE_SHARE_READ = 1
    _FILE_SHARE_WRITE = 2
    _FILE_SHARE_DELETE = 4
    _OPEN_EXISTING = 3
    _FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _FILE_ATTRIBUTE_DIRECTORY = 0x10
    _FILE_ATTRIBUTE_REPARSE_POINT = 0x400
    _VOLUME_NAME_GUID = 1

    class _FILETIME(ctypes.Structure):
        _fields_ = (("low", wintypes.DWORD), ("high", wintypes.DWORD))

    class _BY_HANDLE_FILE_INFORMATION(ctypes.Structure):
        _fields_ = (
            ("attributes", wintypes.DWORD),
            ("creation", _FILETIME),
            ("access", _FILETIME),
            ("write", _FILETIME),
            ("volume", wintypes.DWORD),
            ("size_high", wintypes.DWORD),
            ("size_low", wintypes.DWORD),
            ("links", wintypes.DWORD),
            ("index_high", wintypes.DWORD),
            ("index_low", wintypes.DWORD),
        )

    class _FILE_BASIC_INFO(ctypes.Structure):
        _fields_ = (
            ("creation", ctypes.c_longlong), ("access", ctypes.c_longlong),
            ("write", ctypes.c_longlong), ("change", ctypes.c_longlong),
            ("attributes", wintypes.DWORD),
        )


def _open_windows(path: Path, directory: bool = False, shared_read: bool = False):
    desired = _FILE_READ_ATTRIBUTES if directory else _GENERIC_READ
    sharing = ((_FILE_SHARE_READ | _FILE_SHARE_WRITE | _FILE_SHARE_DELETE)
               if directory else (_FILE_SHARE_READ if shared_read else 0))
    flags = _FILE_FLAG_OPEN_REPARSE_POINT | (_FILE_FLAG_BACKUP_SEMANTICS if directory else 0)
    handle = _K32.CreateFileW(str(path), desired, sharing, None, _OPEN_EXISTING, flags, None)
    if handle in (None, _INVALID_HANDLE):
        _fail("source handle cannot be opened")
    return handle


def _handle_info(handle) -> tuple[int, int, int, int, int, int, int]:
    data = _BY_HANDLE_FILE_INFORMATION()
    if not _K32.GetFileInformationByHandle(handle, ctypes.byref(data)):
        _fail("source handle identity cannot be read")
    basic = _FILE_BASIC_INFO()
    if not _K32.GetFileInformationByHandleEx(handle, 0, ctypes.byref(basic), ctypes.sizeof(basic)):
        _fail("source change generation cannot be read")
    size = (data.size_high << 32) | data.size_low
    file_index = (data.index_high << 32) | data.index_low
    write_ticks = (data.write.high << 32) | data.write.low
    return data.attributes, data.volume, file_index, write_ticks, basic.change, size, data.links


def _final_path(handle) -> str:
    buffer = ctypes.create_unicode_buffer(32768)
    count = _K32.GetFinalPathNameByHandleW(handle, buffer, len(buffer), _VOLUME_NAME_GUID)
    if not count or count >= len(buffer):
        _fail("physical source path cannot be resolved")
    return buffer.value.rstrip("\\").casefold()


@dataclass(frozen=True)
class Witness:
    raw_sha256: str
    size: int
    generation: tuple


def _posix_witness(before, after, data: bytes) -> Witness:
    """Keep POSIX ctime in the private generation, even if bytes are restored."""
    fields = ("st_dev", "st_ino", "st_mtime_ns", "st_ctime_ns", "st_size", "st_nlink")
    generation = tuple(getattr(after, field) for field in fields)
    if tuple(getattr(before, field) for field in fields) != generation or len(data) != after.st_size:
        _fail("source changed during measurement")
    return Witness(_sha256(data), len(data), generation)


class PhysicalReader:
    """Read exact physical files under short exclusive handles."""

    def __init__(self, root: Path, *, shared_read: bool = False):
        self.root = Path(os.path.abspath(root))
        if not self.root.is_dir():
            _fail("source root is missing")
        _no_reparse_ancestors(self.root)
        self._shared_read = shared_read
        self._held = []
        if os.name != "nt":
            # The distributed attestor targets Windows; tests may use POSIX.
            self._root_final = str(self.root.resolve(strict=True))
            self._root_handle = None
            return
        self._root_handle = _open_windows(self.root, directory=True)
        info = _handle_info(self._root_handle)
        if info[0] & _FILE_ATTRIBUTE_REPARSE_POINT or not info[0] & _FILE_ATTRIBUTE_DIRECTORY:
            _fail("source root is not a physical directory")
        self._root_final = _final_path(self._root_handle)
        anchor = Path(self.root.anchor)
        anchor_handle = _open_windows(anchor, directory=True)
        try:
            anchor_info = _handle_info(anchor_handle)
            if anchor_info[0] & _FILE_ATTRIBUTE_REPARSE_POINT:
                _fail("installation volume anchor is a reparse point")
            components = self.root.relative_to(anchor).parts
            expected = _final_path(anchor_handle)
            if components:
                expected += "\\" + "\\".join(components).casefold()
            if self._root_final != expected:
                _fail("source root physical path differs from pinned volume path")
        finally:
            _K32.CloseHandle(anchor_handle)

    def probe(self, relative: str, *, return_bytes: bool = False,
              hold: bool = False):
        rel = _relative(relative)
        path = self.root.joinpath(*rel.split("/"))
        if os.name != "nt":
            _no_reparse_ancestors(path)
            if not path.is_file() or path.stat().st_nlink != 1:
                _fail("source is not a unique regular file")
            if not str(path.resolve(strict=True)).startswith(self._root_final + os.sep):
                _fail("source resolved outside installation")
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
            stream = os.fdopen(descriptor, "rb", buffering=0)
            try:
                before = os.fstat(stream.fileno())
                data = stream.read()
                after = os.fstat(stream.fileno())
                witness = _posix_witness(before, after, data)
                if hold:
                    self._held.append(stream)
                    stream = None
                return (witness, data) if return_bytes else witness
            finally:
                if stream is not None:
                    stream.close()

        _no_reparse_ancestors(path)
        handle = _open_windows(path, shared_read=self._shared_read)
        stream = None
        try:
            before = _handle_info(handle)
            if before[0] & (_FILE_ATTRIBUTE_REPARSE_POINT | _FILE_ATTRIBUTE_DIRECTORY) or before[6] != 1:
                _fail("source is a link, directory or hard link")
            expected = self._root_final + "\\" + rel.replace("/", "\\").casefold()
            if _final_path(handle) != expected:
                _fail("source physical path differs from pinned installation")
            descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)
            handle = None  # descriptor now owns the Windows handle
            stream = os.fdopen(descriptor, "rb", buffering=0)
            data = stream.read()
            after = _handle_info(msvcrt.get_osfhandle(stream.fileno()))
            if before != after or len(data) != after[5]:
                _fail("source changed during measurement")
            witness = Witness(_sha256(data), len(data), after)
            if hold:
                self._held.append(stream)
                stream = None
            return (witness, data) if return_bytes else witness
        finally:
            if stream is not None:
                stream.close()
            if handle is not None:
                _K32.CloseHandle(handle)

    def close(self) -> None:
        for stream in self._held:
            stream.close()
        self._held.clear()
        if self._root_handle is not None:
            _K32.CloseHandle(self._root_handle)
            self._root_handle = None


class PythonProcessIdentity:
    """Freeze the actual loaded venv, its config and its Windows base image.

    Only a SHA of this private, path-bearing record crosses the loopback route.
    The API independently constructs the same record from prepared, held files.
    """

    def __init__(self):
        self._venv = Path(sys.executable)
        self._prefix = Path(sys.prefix)
        self._base = Path(getattr(sys, "_base_executable", ""))
        if (not all(path.is_absolute() for path in (self._venv, self._prefix, self._base)) or
                self._venv.name.casefold() != "python.exe" or
                self._venv.parent.name.casefold() != "scripts" or
                os.path.normcase(str(self._venv.parent.parent)) !=
                os.path.normcase(str(self._prefix))):
            _fail("Comfy is not running inside its prepared Python venv")
        self._cfg = self._prefix / "pyvenv.cfg"
        self._readers = {
            "sysExecutable": PhysicalReader(self._venv.parent, shared_read=True),
            "pyvenvCfg": PhysicalReader(self._prefix, shared_read=True),
            "baseExecutable": PhysicalReader(self._base.parent, shared_read=True),
        }
        self._paths = {"sysExecutable": self._venv, "pyvenvCfg": self._cfg,
                       "baseExecutable": self._base}
        self._first_witness = None
        self._first_record = None
        self.check()

    def _record(self, field: str) -> tuple[dict, Witness, bytes]:
        path = self._paths[field]
        reader = self._readers[field]
        before = path.stat()
        witness, raw = reader.probe(path.name, return_bytes=True)
        after = path.stat()
        generation = tuple(int(getattr(after, key)) for key in
                           ("st_dev", "st_ino", "st_size", "st_mtime_ns"))
        if (tuple(int(getattr(before, key)) for key in
                  ("st_dev", "st_ino", "st_size", "st_mtime_ns")) != generation or
                generation[2] != witness.size or
                (os.name == "nt" and
                 (generation[1] != witness.generation[2] or
                  generation[3] != (witness.generation[3] - 116444736000000000) * 100))):
            _fail("Python runtime file changed during attestation")
        return ({"path": os.path.normcase(str(path.resolve(strict=True))),
                 "generation": list(generation), "sha256": witness.raw_sha256},
                witness, raw)

    def check(self) -> str:
        if (os.path.normcase(str(Path(sys.executable))) != os.path.normcase(str(self._venv)) or
                os.path.normcase(str(Path(sys.prefix))) != os.path.normcase(str(self._prefix)) or
                os.path.normcase(str(Path(getattr(sys, "_base_executable", "")))) !=
                os.path.normcase(str(self._base))):
            _fail("loaded Python runtime identity changed")
        rows, witnesses, raws = {}, {}, {}
        for field in ("sysExecutable", "pyvenvCfg", "baseExecutable"):
            rows[field], witnesses[field], raws[field] = self._record(field)
        if len(raws["pyvenvCfg"]) > 65536:
            _fail("prepared Python venv configuration is invalid")
        try:
            lines = raws["pyvenvCfg"].decode("utf-8-sig").splitlines()
            values = [value.strip() for line in lines if "=" in line
                      for key, value in [line.split("=", 1)]
                      if key.strip().lower() == "executable"]
        except UnicodeError as error:
            raise SourceIdentityError("prepared Python venv configuration is invalid") from error
        if (len(values) != 1 or not Path(values[0]).is_absolute() or
                not os.path.samefile(values[0], self._base)):
            _fail("loaded Python base image differs from venv configuration")
        record = {"schemaVersion": "qs.h3.python-runtime.v1",
                  "sysPrefix": os.path.normcase(str(self._prefix.resolve(strict=True))),
                  **rows}
        if self._first_witness is None:
            self._first_witness, self._first_record = witnesses, record
        elif witnesses != self._first_witness or record != self._first_record:
            _fail("loaded Python runtime changed after process start")
        return _json_sha256(record)

    def close(self) -> None:
        for reader in self._readers.values():
            reader.close()


class SourceAttestor:
    def __init__(self, comfy_root: Path, manifest_path: Path,
                 class_mappings: Mapping[str, type], *, python_runtime=None):
        self._lock = threading.RLock()
        self._reader = PhysicalReader(comfy_root)
        if not Path(manifest_path).is_absolute():
            _fail("manifest path must be absolute")
        manifest_path = Path(os.path.abspath(manifest_path))
        self._manifest_reader = PhysicalReader(manifest_path.parent, shared_read=True)
        self._manifest_file = manifest_path.name
        self._manifest_witness, raw = self._manifest_reader.probe(
            self._manifest_file, return_bytes=True)
        self.manifest_sha256 = _sha256(raw)
        try:
            manifest = json.loads(raw.decode("utf-8"))
        except (UnicodeError, ValueError) as error:
            raise SourceIdentityError("private source manifest is invalid") from error
        if not isinstance(manifest, dict):
            _fail("private source manifest is not an object")
        self._manifest = manifest
        self._classes = class_mappings
        self._files = self._entries(manifest, "runtimeSourceFiles", suffix=".py")
        self._aux = self._entries(manifest, "runtimeAuxiliaryFiles", suffix=".json")
        self._required = manifest.get("requiredGraphClassTypes")
        if (not isinstance(self._required, list) or not self._required
                or any(not isinstance(name, str) or not name for name in self._required)
                or self._required != sorted(set(self._required))):
            _fail("fixed graph class list is invalid")
        self._exclude = self._inventory_excludes(manifest)
        self._validate_inventory()
        self._boot_files = {}
        for rel, entry in {**self._files, **self._aux}.items():
            witness = self._reader.probe(rel)
            if witness.size != entry["size"] or witness.raw_sha256 != entry["rawSha256"]:
                _fail("source manifest differs from installed bytes")
            self._boot_files[rel] = witness
        self._process_token = secrets.token_hex(32)
        self._ffmpeg = None
        self._ffmpeg_reader = None
        self._ffmpeg_path = None
        self._class_generation = None
        self._python_runtime = python_runtime if python_runtime is not None else PythonProcessIdentity()

    @property
    def registry(self) -> Mapping[str, type]:
        return self._classes

    @staticmethod
    def _entries(manifest: dict, field: str, *, suffix: str) -> dict[str, dict]:
        values = manifest.get(field)
        if not isinstance(values, list):
            _fail("source manifest lacks runtime file inventory")
        result = {}
        for entry in values:
            if not isinstance(entry, dict) or entry.get("area") != "comfy":
                continue
            rel = _relative(entry.get("path"))
            if not rel.endswith(suffix) or rel in result:
                _fail("source manifest has duplicate or invalid paths")
            if (not isinstance(entry.get("size"), int) or entry["size"] < 0
                    or not isinstance(entry.get("rawSha256"), str)
                    or not re.fullmatch(r"[0-9a-f]{64}", entry["rawSha256"])
                    or not isinstance(entry.get("origin"), str) or not entry["origin"]):
                _fail("source manifest has invalid file identity")
            result[rel] = entry
        if not result:
            _fail("source manifest has no Comfy files")
        return result

    @staticmethod
    def _inventory_excludes(manifest: dict) -> set[str]:
        roots = [item for item in manifest.get("runtimeInventoryRoots", [])
                 if isinstance(item, dict) and item.get("area") == "comfy"]
        if roots != [{"area": "comfy", "relativeDir": ".", "extension": ".py", "recursive": True}]:
            _fail("Comfy Python inventory contract differs")
        excludes = [item for item in manifest.get("runtimeInventoryExcludeDirs", [])
                    if isinstance(item, dict) and item.get("area") == "comfy"]
        result = {_relative(item.get("relativeDir")) for item in excludes}
        if len(result) != len(excludes):
            _fail("Comfy Python inventory exclusion is duplicated")
        if result != {
            ".git", "custom_nodes/ComfyUI-KJNodes/.git",
            "custom_nodes/ComfyUI_LayerStyle/.git",
            "custom_nodes/ComfyUI-VideoHelperSuite/.git",
            "models", "input", "output", "temp", "user",
        }:
            _fail("Comfy Python inventory exclusions differ")
        return result

    def _validate_inventory(self) -> None:
        actual = set()
        for current, dirs, files in os.walk(self._reader.root, topdown=True, followlinks=False):
            current_path = Path(current)
            accepted = []
            for name in dirs:
                path = current_path / name
                rel = path.relative_to(self._reader.root).as_posix()
                if rel in self._exclude:
                    continue
                if name == "__pycache__":
                    _fail("Comfy source tree contains old Python bytecode")
                if _is_reparse(path):
                    _fail("unlisted source directory is a reparse point")
                accepted.append(name)
            dirs[:] = accepted
            for name in files:
                if name.endswith((".pyc", ".pyo")):
                    _fail("Comfy source tree contains old Python bytecode")
                if name.endswith(".py"):
                    rel = (current_path / name).relative_to(self._reader.root).as_posix()
                    if _is_reparse(current_path / name):
                        _fail("Python inventory contains a reparse point")
                    actual.add(rel)
        if actual != set(self._files):
            _fail("Comfy Python inventory differs from private manifest")

        aux_roots = [item for item in self._manifest.get("runtimeAuxiliaryInventoryDirs", [])
                     if isinstance(item, dict) and item.get("area") == "comfy"]
        expected_aux_root = "custom_nodes/ComfyUI-VideoHelperSuite/video_formats"
        if aux_roots != [{"area": "comfy", "relativeDir": expected_aux_root,
                          "extension": ".json", "recursive": False}]:
            _fail("Comfy format inventory contract differs")
        folder = self._reader.root.joinpath(*expected_aux_root.split("/"))
        if _is_reparse(folder) or not folder.is_dir():
            _fail("Comfy video formats directory is not physical")
        aux_actual = set()
        for child in folder.iterdir():
            if not child.is_file() or child.suffix != ".json" or _is_reparse(child):
                _fail("Comfy video formats include an unknown entry")
            aux_actual.add(child.relative_to(self._reader.root).as_posix())
        if {Path(rel).name for rel in aux_actual} != _VHS_FORMATS:
            _fail("Comfy VHS format set differs from fixed source")
        if aux_actual != set(self._aux):
            _fail("Comfy video formats differ from private manifest")

    def _class_origin(self, class_type: str) -> tuple[dict, tuple]:
        cls = self._classes.get(class_type)
        if not inspect.isclass(cls):
            _fail("fixed graph node class is not registered")
        if cls.__qualname__ != _FIXED_CLASS_NAMES.get(class_type):
            _fail("fixed graph class identity differs from supported recipe")
        module_name = cls.__module__
        module = sys.modules.get(module_name)
        if not isinstance(module, ModuleType):
            _fail("fixed graph class module is not loaded")
        source = inspect.getsourcefile(cls)
        module_file = getattr(module, "__file__", None)
        if not source or not module_file:
            _fail("fixed graph class has no Python source file")
        source_path = Path(os.path.abspath(source))
        module_path = Path(os.path.abspath(module_file))
        if source_path != module_path:
            _fail("fixed graph class module and source differ")
        try:
            rel = source_path.relative_to(self._reader.root).as_posix()
        except ValueError:
            _fail("fixed graph class source is outside installed Comfy")
        entry = self._files.get(rel)
        if entry is None:
            _fail("fixed graph class source is outside pinned inventory")
        witness, class_raw = self._reader.probe(rel, return_bytes=True)
        if witness != self._boot_files[rel]:
            _fail("fixed graph class source changed after process start")
        method_name = getattr(cls, "FUNCTION", None)
        v3 = class_type in _V3_GRAPH_CLASSES
        expected_method = "EXECUTE_NORMALIZED" if v3 else _V1_GRAPH_METHODS.get(class_type)
        if method_name != expected_method:
            _fail("fixed graph execution method differs from supported recipe")
        method = getattr(cls, method_name, None)
        function = _actual_function(method)
        method_path = Path(os.path.abspath(function.__code__.co_filename))
        try:
            method_rel = method_path.relative_to(self._reader.root).as_posix()
        except ValueError:
            _fail("fixed graph execution method is outside installed Comfy")
        method_entry = self._files.get(method_rel)
        if method_entry is None:
            _fail("fixed graph execution method is outside pinned inventory")
        method_witness = self._reader.probe(method_rel)
        if method_witness != self._boot_files[method_rel]:
            _fail("fixed graph execution method source changed after process start")
        override = None
        descriptor = None
        if v3:
            if method_rel != "comfy_api/latest/_io.py" or function.__module__ != "comfy_api.latest._io":
                _fail("Comfy V3 normalized wrapper is outside pinned framework")
            framework_module = sys.modules.get("comfy_api.latest._io")
            if (not isinstance(framework_module, ModuleType) or
                    function.__globals__ is not framework_module.__dict__):
                _fail("Comfy V3 normalized wrapper has foreign globals")
            bases = cls.__mro__
            core = next((base for base in bases if base.__name__ == "_ComfyNodeBaseInternal" and
                         base.__module__ == "comfy_api.latest._io"), None)
            node = next((base for base in bases if base.__name__ == "ComfyNode" and
                         base.__module__ == "comfy_api.latest._io"), None)
            if core is None or node is None or bases.index(node) >= bases.index(core):
                _fail("Comfy V3 node base differs from pinned framework")
            for base in bases[:bases.index(core)]:
                if "FUNCTION" in base.__dict__ or "EXECUTE_NORMALIZED" in base.__dict__:
                    _fail("Comfy V3 normalized wrapper was shadowed")
            descriptor = core.__dict__.get("EXECUTE_NORMALIZED")
            function_descriptor = core.__dict__.get("FUNCTION")
            selector = getattr(function_descriptor, "f", None)
            if (not isinstance(descriptor, classmethod) or descriptor.__func__ is not function or
                    type(function_descriptor) is not getattr(framework_module, "classproperty", None) or
                    not inspect.isfunction(selector) or
                    selector.__globals__ is not framework_module.__dict__ or
                    not _loaded_method_matches_source(
                        selector, self._reader.probe(method_rel, return_bytes=True)[1],
                        "_ComfyNodeBaseInternal", "FUNCTION") or
                    function.__qualname__ != "_ComfyNodeBaseInternal.EXECUTE_NORMALIZED"):
                _fail("Comfy V3 normalized wrapper descriptor differs")
            override_descriptor = cls.__dict__.get("execute")
            override = getattr(cls, "execute", None)
            override_function = _actual_function(override)
            if (not isinstance(override_descriptor, classmethod) or
                    override_descriptor.__func__ is not override_function or
                    override_function.__module__ != module_name or
                    override_function.__globals__ is not module.__dict__ or
                    Path(os.path.abspath(override_function.__code__.co_filename)) != source_path):
                _fail("Comfy V3 execute override is outside class source")
            if (not _loaded_method_matches_source(
                    method, self._reader.probe(method_rel, return_bytes=True)[1],
                    "_ComfyNodeBaseInternal", "EXECUTE_NORMALIZED") or
                    not _loaded_method_matches_source(override, class_raw,
                                                      cls.__qualname__, "execute")):
                _fail("Comfy V3 loaded method differs from pinned source")
            override_generation = (id(override_descriptor), id(override_function),
                                   _method_fingerprint(override))
        else:
            if (method_rel != rel or function.__module__ != module_name or
                    function.__globals__ is not module.__dict__):
                _fail("fixed graph execution method is outside class source")
            if cls.__dict__.get("FUNCTION") != method_name:
                _fail("fixed graph V1 method selector was replaced")
            descriptor = cls.__dict__.get(method_name)
            direct_function = (descriptor.__func__ if isinstance(
                descriptor, (classmethod, staticmethod)) else descriptor)
            if direct_function is not function or not _loaded_method_matches_source(
                    method, class_raw, cls.__qualname__, method_name):
                _fail("fixed graph V1 loaded method differs from pinned class source")
            override_generation = None
        generation = (id(cls), id(function), method_name, _method_fingerprint(method),
                      id(descriptor), method_rel, method_witness.generation,
                      override_generation)
        return {
            "classType": class_type,
            "moduleName": module_name,
            "classQualname": cls.__qualname__,
            "moduleRelativePath": rel,
            "sourceOrigin": entry["origin"],
            "sourceRawSha256": witness.raw_sha256,
            "sourceSize": witness.size,
            "methodRelativePath": method_rel,
            "methodSourceRawSha256": method_witness.raw_sha256,
            "methodSourceSize": method_witness.size,
        }, generation

    def _ffmpeg_identity(self) -> str:
        video_cls = self._classes.get("VHS_VideoCombine")
        if not inspect.isclass(video_cls):
            _fail("VHS video node is not registered")
        video_module = sys.modules.get(video_cls.__module__)
        selected = getattr(video_module, "ffmpeg_path", None)
        if not isinstance(selected, str) or not selected or not Path(selected).is_absolute():
            _fail("VHS selected ffmpeg executable is unavailable")
        path = Path(os.path.abspath(selected))
        if self._ffmpeg is None:
            # The API holds its own read-only encoder handle for the entire
            # job.  Compatible FILE_SHARE_READ still excludes writers while
            # allowing both processes to attest the same physical binary.
            reader = PhysicalReader(path.parent, shared_read=True)
            witness = reader.probe(path.name)
            self._ffmpeg_reader = reader
            self._ffmpeg = witness
            self._ffmpeg_path = os.path.normcase(str(path))
        elif os.path.normcase(str(path)) != self._ffmpeg_path:
            _fail("VHS selected a different ffmpeg executable")
        witness = self._ffmpeg_reader.probe(path.name)
        if witness != self._ffmpeg:
            _fail("VHS ffmpeg executable changed after attestation")
        return witness.raw_sha256

    def verify_custom_node_roots(self, registered: list[str]) -> None:
        """Reject extra_model_paths that register executable nodes outside this tree."""
        if not isinstance(registered, list) or len(registered) != 1:
            _fail("Comfy custom node roots differ from pinned installation")
        configured = Path(os.path.abspath(registered[0]))
        expected = self._reader.root / "custom_nodes"
        if os.path.normcase(str(configured)) != os.path.normcase(str(expected)):
            _fail("Comfy custom node root differs from pinned installation")
        _no_reparse_ancestors(configured)
        if os.name == "nt":
            handle = _open_windows(configured, directory=True)
            try:
                info = _handle_info(handle)
                if (info[0] & _FILE_ATTRIBUTE_REPARSE_POINT
                        or not info[0] & _FILE_ATTRIBUTE_DIRECTORY
                        or _final_path(handle) != self._reader._root_final + "\\custom_nodes"):
                    _fail("Comfy custom node root is not physical")
            finally:
                _K32.CloseHandle(handle)
        elif configured.resolve(strict=True) != expected:
            _fail("Comfy custom node root is not physical")

    def verify_prompt_handler(self, server: object,
                              expected_guard: object | None = None) -> None:
        """Prove the registered queue handler is the patched, loaded core code."""
        if getattr(server, "qs_h3_prompt_guard_required_v1", None) is not True:
            _fail("canonical queue-admission guard capability is missing")
        routes = getattr(server, "routes", ())
        matches = [item for item in routes
                   if getattr(item, "method", None) == "POST" and
                   getattr(item, "path", None) == "/prompt"]
        if len(matches) != 1:
            _fail("canonical prompt handler is unavailable")
        handler = getattr(matches[0], "handler", None)
        code = getattr(handler, "__code__", None)
        source_path = self._reader.root / "server.py"
        if (not isinstance(code, CodeType) or
                os.path.normcase(os.path.abspath(code.co_filename)) !=
                os.path.normcase(str(source_path))):
            _fail("registered prompt handler did not load from pinned Comfy core")
        witness, raw = self._reader.probe("server.py", return_bytes=True)
        if witness != self._boot_files.get("server.py"):
            _fail("Comfy prompt handler source changed after process start")
        compiled = compile(raw, code.co_filename, "exec", dont_inherit=True)
        pending = [compiled]
        candidates = []
        while pending:
            current = pending.pop()
            for value in current.co_consts:
                if isinstance(value, CodeType):
                    pending.append(value)
                    if value.co_name == "post_prompt":
                        candidates.append(value)
        if (len(candidates) != 1 or candidates[0] != code or
                "qs_h3_prompt_guard" not in code.co_freevars or
                not {"qs_h3_expected_process_token", "qs_h3_source_identity_changed"}
                .issubset(set(code.co_consts))):
            _fail("registered prompt handler does not enforce canonical queue admission")
        if expected_guard is not None:
            checker = getattr(server, "qs_h3_prompt_guard_is", None)
            if not callable(checker) or checker(expected_guard) is not True:
                _fail("registered queue guard callback changed")

    def attest(self, request: dict) -> dict:
        with self._lock:
            python_runtime_sha = self._python_runtime.check()
            if not isinstance(request, dict) or set(request) != {
                    "schemaVersion", "classTypes", "sourceManifestSha256"}:
                _fail("invalid source attestation request")
            if request["schemaVersion"] != 1 or request["classTypes"] != self._required:
                _fail("requested graph class set differs from fixed recipe")
            if request["sourceManifestSha256"] != self.manifest_sha256:
                _fail("source manifest digest differs")
            manifest_now = self._manifest_reader.probe(self._manifest_file)
            if manifest_now != self._manifest_witness:
                _fail("source manifest changed after process start")
            self._validate_inventory()
            for rel, previous in self._boot_files.items():
                if self._reader.probe(rel) != previous:
                    _fail("source file changed after process start")
            snapshot = [(name, self._classes.get(name)) for name in self._required]
            result = [self._class_origin(name) for name in self._required]
            if snapshot != [(name, self._classes.get(name)) for name in self._required]:
                _fail("fixed graph node registration changed during attestation")
            rows = [row for row, _ in result]
            generation = tuple(value for _, value in result)
            if self._class_generation is None:
                self._class_generation = generation
            elif generation != self._class_generation:
                _fail("fixed graph node code changed after first attestation")
            ffmpeg_sha = self._ffmpeg_identity()
            self._validate_inventory()
            if self._manifest_reader.probe(self._manifest_file) != self._manifest_witness:
                _fail("source manifest changed during attestation")
            if snapshot != [(name, self._classes.get(name)) for name in self._required]:
                _fail("fixed graph node registration changed during attestation")
            return {
                "schemaVersion": 1,
                "processToken": self._process_token,
                "sourceManifestSha256": self.manifest_sha256,
                "classOrigins": rows,
                "classOriginSha256": _json_sha256(rows),
                "ffmpegSha256": ffmpeg_sha,
                "pythonRuntimeSha256": python_runtime_sha,
            }

    def guard_submission(self, expected_process_token: str) -> None:
        """Synchronously re-attest the same process at Comfy queue admission."""
        if (not isinstance(expected_process_token, str) or
                not re.fullmatch(r"[0-9a-f]{64}", expected_process_token)):
            _fail("missing or invalid Comfy process token")
        with self._lock:
            if not hmac.compare_digest(expected_process_token, self._process_token):
                _fail("Comfy process token changed")
            result = self.attest({
                "schemaVersion": 1,
                "classTypes": self._required,
                "sourceManifestSha256": self.manifest_sha256,
            })
            if not hmac.compare_digest(result["processToken"], expected_process_token):
                _fail("Comfy process token changed during queue admission")

    def close(self) -> None:
        self._reader.close()
        self._manifest_reader.close()
        if self._ffmpeg_reader is not None:
            self._ffmpeg_reader.close()
        self._python_runtime.close()
