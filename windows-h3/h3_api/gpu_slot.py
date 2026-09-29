"""One Comfy GPU. Claim a slot (z / seedvr / h3); switching unloads the previous weights."""
from __future__ import annotations

from contextlib import contextmanager
import hashlib
import json
import os
import stat
import time
import urllib.request
from pathlib import Path

if os.name == "nt":
    import ctypes
    from ctypes import wintypes
    import msvcrt

    _K32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _K32.CreateMutexW.argtypes = (wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR)
    _K32.CreateMutexW.restype = wintypes.HANDLE
    _K32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    _K32.WaitForSingleObject.restype = wintypes.DWORD
    _K32.ReleaseMutex.argtypes = (wintypes.HANDLE,)
    _K32.ReleaseMutex.restype = wintypes.BOOL
    _K32.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
    _K32.CreateFileW.restype = wintypes.HANDLE
    _K32.GetFileInformationByHandle.argtypes = (wintypes.HANDLE, wintypes.LPVOID)
    _K32.GetFileInformationByHandle.restype = wintypes.BOOL
    _K32.GetFinalPathNameByHandleW.argtypes = (wintypes.HANDLE, wintypes.LPWSTR,
                                               wintypes.DWORD, wintypes.DWORD)
    _K32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
    _K32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _K32.CloseHandle.restype = wintypes.BOOL

    _INVALID_HANDLE = ctypes.c_void_p(-1).value
    _GENERIC_READ = 0x80000000
    _GENERIC_WRITE = 0x40000000
    _FILE_READ_ATTRIBUTES = 0x80
    _FILE_SHARE_READ = 1
    _FILE_SHARE_WRITE = 2
    _OPEN_EXISTING = 3
    _FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    _FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
    _FILE_ATTRIBUTE_DIRECTORY = 0x10
    _FILE_ATTRIBUTE_REPARSE_POINT = 0x400
    _WAIT_OBJECT_0 = 0
    _WAIT_ABANDONED = 0x80

    class _FileInfo(ctypes.Structure):
        _fields_ = (("attributes", wintypes.DWORD),
                    ("creation_low", wintypes.DWORD), ("creation_high", wintypes.DWORD),
                    ("access_low", wintypes.DWORD), ("access_high", wintypes.DWORD),
                    ("write_low", wintypes.DWORD), ("write_high", wintypes.DWORD),
                    ("volume", wintypes.DWORD), ("size_high", wintypes.DWORD),
                    ("size_low", wintypes.DWORD), ("links", wintypes.DWORD),
                    ("index_high", wintypes.DWORD), ("index_low", wintypes.DWORD))


KINDS = ("z", "seedvr", "h3")
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


if os.name == "nt":
    def _win_handle_info(handle):
        info = _FileInfo()
        if not _K32.GetFileInformationByHandle(handle, ctypes.byref(info)):
            raise RuntimeError("GPU slot handle identity is unavailable")
        return info


    def _win_final_path(handle) -> str:
        buffer = ctypes.create_unicode_buffer(32768)
        count = _K32.GetFinalPathNameByHandleW(handle, buffer, len(buffer), 1)
        if not count or count >= len(buffer):
            raise RuntimeError("GPU slot physical path is unavailable")
        return buffer.value.rstrip("\\").casefold()


    def _win_reject_reparse_chain(path: Path) -> None:
        for part in (path, *path.parents):
            try:
                info = part.lstat()
            except OSError as error:
                raise RuntimeError("GPU slot parent path is unavailable") from error
            if (part.is_symlink() or getattr(part, "is_junction", lambda: False)()
                    or getattr(info, "st_file_attributes", 0) &
                    getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0)):
                raise RuntimeError("GPU slot parent path is redirected")


    def _win_open_dir(path: Path):
        handle = _K32.CreateFileW(str(path), _FILE_READ_ATTRIBUTES,
                                  _FILE_SHARE_READ | _FILE_SHARE_WRITE, None,
                                  _OPEN_EXISTING,
                                  _FILE_FLAG_BACKUP_SEMANTICS | _FILE_FLAG_OPEN_REPARSE_POINT,
                                  None)
        if handle in (None, _INVALID_HANDLE):
            raise RuntimeError("GPU slot parent handle is unavailable")
        try:
            info = _win_handle_info(handle)
            if (info.attributes & _FILE_ATTRIBUTE_REPARSE_POINT
                    or not info.attributes & _FILE_ATTRIBUTE_DIRECTORY):
                raise RuntimeError("GPU slot parent is not a physical directory")
            return handle
        except Exception:
            _K32.CloseHandle(handle)
            raise


    class _WinSlotFiles:
        """One pinned parent, a held lock file and one stable state file."""

        def __init__(self, path: Path):
            self.slot = Path(os.path.abspath(path))
            self.parent = self.slot.parent
            self.parent_handle = None
            self.lock_stream = None
            self.state_stream = None
            _win_reject_reparse_chain(self.parent)
            if not self.parent.is_dir():
                raise RuntimeError("GPU slot parent must already exist")
            self.parent_handle = _win_open_dir(self.parent)
            try:
                anchor = Path(self.parent.anchor)
                anchor_handle = _win_open_dir(anchor)
                try:
                    suffix = self.parent.relative_to(anchor).parts
                    expected = _win_final_path(anchor_handle)
                    if suffix:
                        expected += "\\" + "\\".join(suffix).casefold()
                    self.parent_final = _win_final_path(self.parent_handle)
                    if self.parent_final != expected:
                        raise RuntimeError("GPU slot parent physical path changed")
                finally:
                    _K32.CloseHandle(anchor_handle)
                self.lock_stream = self._open_file(self.slot.name + ".lock", _OPEN_EXISTING)
                if self.lock_stream is None:
                    raise RuntimeError("GPU slot lock is not initialized; refusing claim")
                self.lock_stream.seek(0)
                if not self.lock_stream.read(1):
                    raise RuntimeError("GPU slot lock is empty; refusing claim")
            except Exception:
                self.close()
                raise

        def _check_parent(self) -> None:
            _win_reject_reparse_chain(self.parent)
            if _win_final_path(self.parent_handle) != self.parent_final:
                raise RuntimeError("GPU slot parent physical path changed")
            current = _win_open_dir(self.parent)
            try:
                original = _win_handle_info(self.parent_handle)
                observed = _win_handle_info(current)
                if ((original.volume, original.index_high, original.index_low) !=
                        (observed.volume, observed.index_high, observed.index_low)):
                    raise RuntimeError("GPU slot parent object changed")
                if _win_final_path(current) != self.parent_final:
                    raise RuntimeError("GPU slot parent physical path changed")
            finally:
                _K32.CloseHandle(current)

        def _open_file(self, name: str, disposition: int):
            self._check_parent()
            path = self.parent / name
            handle = _K32.CreateFileW(str(path), _GENERIC_READ | _GENERIC_WRITE, 0,
                                      None, disposition, _FILE_FLAG_OPEN_REPARSE_POINT, None)
            if handle in (None, _INVALID_HANDLE):
                if disposition == _OPEN_EXISTING and ctypes.get_last_error() == 2:
                    return None
                raise RuntimeError("GPU slot file cannot be opened exclusively")
            try:
                info = _win_handle_info(handle)
                if info.attributes & (_FILE_ATTRIBUTE_REPARSE_POINT | _FILE_ATTRIBUTE_DIRECTORY):
                    raise RuntimeError("GPU slot file is redirected or a directory")
                if info.links != 1:
                    raise RuntimeError("GPU slot file is hard linked")
                if _win_final_path(handle) != self.parent_final + "\\" + name.casefold():
                    raise RuntimeError("GPU slot file physical path changed")
                # OPEN_REPARSE_POINT and share=0 remain attached to this very object.
                fd = msvcrt.open_osfhandle(handle, os.O_RDWR | os.O_BINARY)
                handle = None
                return os.fdopen(fd, "r+b", buffering=0)
            finally:
                if handle is not None:
                    _K32.CloseHandle(handle)

        def read_state(self) -> dict:
            if self.state_stream is None:
                self.state_stream = self._open_file(self.slot.name, _OPEN_EXISTING)
                if self.state_stream is None:
                    raise RuntimeError("GPU slot state is not initialized; refusing claim")
            self.state_stream.seek(0)
            try:
                value = json.loads(self.state_stream.read().decode("utf-8"))
            except (OSError, UnicodeError, ValueError) as error:
                raise RuntimeError("GPU slot state is unreadable; refusing claim") from error
            if (not isinstance(value, dict) or "occupant" not in value or
                    value["occupant"] not in (None, *KINDS)):
                raise RuntimeError("GPU slot state is invalid; refusing claim")
            return value

        def write_state(self, info: dict) -> None:
            if self.state_stream is None:
                self.read_state()
            self._check_parent()
            raw = json.dumps(info, ensure_ascii=False).encode("utf-8")
            self.state_stream.seek(0)
            view = memoryview(raw)
            while view:
                written = self.state_stream.write(view)
                if not written:
                    raise RuntimeError("GPU slot state write was incomplete")
                view = view[written:]
            self.state_stream.truncate()
            self.state_stream.flush()
            os.fsync(self.state_stream.fileno())
            self.state_stream.seek(0)
            if self.state_stream.read() != raw:
                raise RuntimeError("GPU slot state write could not be verified")

        def close(self) -> None:
            for name in ("state_stream", "lock_stream"):
                stream = getattr(self, name, None)
                if stream is not None:
                    stream.close()
                    setattr(self, name, None)
            if self.parent_handle is not None:
                _K32.CloseHandle(self.parent_handle)
                self.parent_handle = None


    class _WinLease:
        def __init__(self, slot: Path):
            lexical = os.path.normcase(os.path.normpath(os.path.abspath(slot)))
            label = hashlib.sha256(lexical.encode("utf-8")).hexdigest()
            self.mutex = _K32.CreateMutexW(None, False, "Global\\QianshouH3Slot-" + label)
            if self.mutex in (None, _INVALID_HANDLE):
                raise RuntimeError("Global GPU slot mutex is unavailable")
            self.owned = False
            self.files = None
            try:
                result = _K32.WaitForSingleObject(self.mutex, 0)
                if result not in (_WAIT_OBJECT_0, _WAIT_ABANDONED):
                    raise RuntimeError("GPU slot is locked or unavailable; refusing claim")
                self.owned = True
                self.files = _WinSlotFiles(slot)
            except Exception:
                self.close()
                raise

        def close(self) -> None:
            try:
                if self.files is not None:
                    self.files.close()
                    self.files = None
            finally:
                if self.owned:
                    _K32.ReleaseMutex(self.mutex)
                    self.owned = False
                if self.mutex is not None:
                    _K32.CloseHandle(self.mutex)
                    self.mutex = None


class GpuBusy(Exception):
    def __init__(self, occupant: str, queue: dict):
        self.occupant = occupant
        self.queue = queue
        super().__init__(f"gpu busy occupant={occupant} running={queue.get('running')} pending={queue.get('pending')}")


def slot_path() -> Path:
    raw = (os.environ.get("GPU_SLOT_FILE") or "").strip()
    if not raw:
        raise RuntimeError("GPU_SLOT_FILE must be configured for this device")
    path = Path(raw).expanduser()
    if not path.is_absolute():
        raise RuntimeError("GPU_SLOT_FILE must be an absolute path")
    if path.resolve().is_relative_to(Path(__file__).resolve().parent):
        raise RuntimeError("GPU_SLOT_FILE must be outside the installed source tree")
    return path


def _lock_path() -> Path:
    p = slot_path()
    return p.with_name(p.name + ".lock")


def peek() -> dict:
    if os.name == "nt":
        lease = _WinLease(slot_path())
        try:
            return lease.files.read_state()
        finally:
            lease.close()
    p = slot_path()
    if not p.is_file():
        return {"occupant": None}
    try:
        value = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise RuntimeError("GPU slot state is unreadable; refusing claim") from error
    if (not isinstance(value, dict) or "occupant" not in value or
            value["occupant"] not in (None, *KINDS)):
        raise RuntimeError("GPU slot state is invalid; refusing claim")
    return value


def _lock_enter():
    if os.name == "nt":
        return _WinLease(slot_path())
    lp = _lock_path()
    if not lp.parent.is_dir():
        raise RuntimeError("GPU slot parent must already exist")
    fh = open(lp, "a+b")
    try:
        fh.flush()
        fh.seek(0)
        if fh.read(1) == b"":
            fh.write(b"\0")
            fh.flush()
        fh.seek(0)
        if os.name == "nt":
            import msvcrt

            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl

            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError as error:
        fh.close()
        raise RuntimeError("GPU slot is locked or unreadable; refusing claim") from error
    return fh


def _lock_exit(fh):
    if os.name == "nt":
        fh.close()
        return
    try:
        if os.name == "nt":
            import msvcrt

            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    finally:
        fh.close()


def _comfy(comfy_base: str, path: str, payload: dict | None = None, timeout: float = 30):
    url = comfy_base.rstrip("/") + path
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
        method="POST" if data is not None else "GET",
    )
    with _OPENER.open(req, timeout=timeout) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else {}


def _queue(comfy_base: str) -> dict:
    try:
        q = _comfy(comfy_base, "/queue", timeout=8)
        if (not isinstance(q, dict) or
                not isinstance(q.get("queue_running"), list) or
                not isinstance(q.get("queue_pending"), list)):
            raise ValueError("Malformed Comfy queue response")
        return {
            "running": len(q["queue_running"]),
            "pending": len(q["queue_pending"]),
        }
    except Exception as error:
        raise RuntimeError("Comfy queue is unavailable; refusing GPU claim") from error


def _free(comfy_base: str) -> None:
    payload = {"unload_models": True, "free_memory": True}
    _comfy(comfy_base, "/free", payload, timeout=45)
    time.sleep(0.8)
    _comfy(comfy_base, "/free", payload, timeout=45)
    time.sleep(1.0)


def _claim_locked(kind: str, comfy_base: str, lease=None) -> dict:
    if kind not in KINDS:
        raise ValueError(kind)
    prev = lease.files.read_state() if os.name == "nt" else peek()
    occupant = prev.get("occupant")
    q = _queue(comfy_base)
    busy = bool(q.get("running") or q.get("pending"))
    if busy and occupant != kind:
        raise GpuBusy(str(occupant or "comfy"), q)
    if occupant != kind:
        _free(comfy_base)
    info = {
        "occupant": kind,
        "pid": os.getpid(),
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "unloaded": occupant != kind,
        "prev": occupant,
    }
    if os.name == "nt":
        lease.files.write_state(info)
    else:
        slot_path().write_text(json.dumps(info, ensure_ascii=False), encoding="utf-8")
    return info


@contextmanager
def reserve(kind: str, comfy_base: str):
    """Hold one cross-process GPU lease through submit/render completion."""
    handle = _lock_enter()
    try:
        yield _claim_locked(kind, comfy_base, handle)
    finally:
        _lock_exit(handle)


def claim(kind: str, comfy_base: str) -> dict:
    """Short claim for legacy peers; H3 rendering uses reserve() instead."""
    with reserve(kind, comfy_base) as info:
        return info
