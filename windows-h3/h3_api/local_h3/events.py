"""In-process pub/sub for job realtime feedback."""
from __future__ import annotations

import asyncio
import json
import threading
import time
from collections import defaultdict, deque
from typing import Any, Callable, Optional

_lock = threading.Lock()
_subs: dict[str, list[Callable[[dict], None]]] = defaultdict(list)
_latest: dict[str, dict] = {}
_history: dict[str, deque] = defaultdict(lambda: deque(maxlen=100))


def publish(job_id: str, event: dict) -> None:
    """Publish an event for a job (thread-safe)."""
    payload = dict(event)
    payload.setdefault("job_id", job_id)
    payload.setdefault("ts", time.time())
    with _lock:
        _latest[job_id] = payload
        _history[job_id].append(payload)
        listeners = list(_subs.get(job_id, []))
        listeners += list(_subs.get("*", []))
    for fn in listeners:
        try:
            fn(payload)
        except Exception:
            pass


def latest(job_id: str) -> Optional[dict]:
    with _lock:
        return dict(_latest[job_id]) if job_id in _latest else None


def history(job_id: str, limit: int = 50) -> list[dict]:
    with _lock:
        items = list(_history.get(job_id) or [])
    return items[-limit:]


def subscribe(job_id: str, callback: Callable[[dict], None]) -> Callable[[], None]:
    """Subscribe to job events. Returns unsubscribe fn."""
    with _lock:
        _subs[job_id].append(callback)

    def _unsub() -> None:
        with _lock:
            lst = _subs.get(job_id) or []
            if callback in lst:
                lst.remove(callback)

    return _unsub


class AsyncQueue:
    """Bridge sync publish -> async consumer (SSE / WS)."""

    def __init__(self, job_id: str, loop: Optional[asyncio.AbstractEventLoop] = None):
        self.job_id = job_id
        self.queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        try:
            self._loop = loop or asyncio.get_running_loop()
        except RuntimeError:
            self._loop = loop or asyncio.get_event_loop()
        self._unsub = subscribe(job_id, self._on_event)
        snap = latest(job_id)
        if snap:
            self._put(snap)
        # replay recent history so late subscribers don't miss early events
        for ev in history(job_id, limit=20):
            self._put(ev)

    def _put(self, event: dict) -> None:
        def _inner():
            try:
                self.queue.put_nowait(event)
            except asyncio.QueueFull:
                try:
                    self.queue.get_nowait()
                except Exception:
                    pass
                try:
                    self.queue.put_nowait(event)
                except Exception:
                    pass

        self._loop.call_soon_threadsafe(_inner)

    def _on_event(self, event: dict) -> None:
        self._put(event)

    def close(self) -> None:
        if self._unsub:
            self._unsub()
            self._unsub = None  # type: ignore

    async def get(self, timeout: float = 15.0) -> Optional[dict]:
        try:
            return await asyncio.wait_for(self.queue.get(), timeout=timeout)
        except asyncio.TimeoutError:
            return None
