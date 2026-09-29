"""Isolated two-process contract tests. No Comfy or GPU is contacted."""
from __future__ import annotations

import multiprocessing
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest import mock
from contextlib import contextmanager
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import gpu_slot


@contextmanager
def _new_test_directory(label: str):
    """Keep only new test files under an explicit work root; never recurse-delete."""
    raw = (os.environ.get("H3_CANONICAL_TEST_ROOT") or "").strip()
    root = Path(raw) if raw else Path()
    if not raw or not root.is_absolute() or not root.is_dir():
        raise RuntimeError("H3_CANONICAL_TEST_ROOT must be an existing absolute test-work directory")
    if root.resolve().is_relative_to(Path(__file__).resolve().parents[2]):
        raise RuntimeError("H3_CANONICAL_TEST_ROOT must be outside the source checkout")
    directory = root / f"{label}-{uuid.uuid4().hex}"
    directory.mkdir()
    yield str(directory)


def _hold_lock(slot_file: str, ready, release) -> None:
    os.environ["GPU_SLOT_FILE"] = slot_file
    with mock.patch.object(gpu_slot, "_queue", return_value={"running": 0, "pending": 0}), \
         mock.patch.object(gpu_slot, "_free", return_value=None):
        with gpu_slot.reserve("h3", "http://127.0.0.1:1"):
            ready.set()  # H3 claimed, but has not yet submitted its prompt.
            if not release.wait(8):
                raise TimeoutError("test lease release signal missing")


def _try_claim(slot_file: str, kind: str, running: int, started, result) -> None:
    os.environ["GPU_SLOT_FILE"] = slot_file
    with mock.patch.object(gpu_slot, "_queue", return_value={"running": running, "pending": 0}), \
         mock.patch.object(gpu_slot, "_free", return_value=None):
        started.set()
        try:
            value = gpu_slot.claim(kind, "http://127.0.0.1:1")
            result.put(("claimed", value["occupant"]))
        except gpu_slot.GpuBusy as error:
            result.put(("busy", error.occupant))
        except Exception as error:
            result.put(("error", type(error).__name__))


def _initialize_slot(slot_file: str) -> None:
    """Only isolated test setup initializes files; the runtime must never do so."""
    slot = Path(slot_file)
    slot.write_text('{"occupant": null}', encoding="utf-8")
    slot.with_name(slot.name + ".lock").write_bytes(b"\0")


class GpuSlotProcessTest(unittest.TestCase):
    def test_two_process_conflict_and_release(self) -> None:
        ctx = multiprocessing.get_context("spawn")
        with _new_test_directory("h3-gpu-slot-process") as directory:
            slot_file = str(Path(directory) / "slot.json")
            _initialize_slot(slot_file)
            with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": slot_file}), \
                 mock.patch.object(gpu_slot, "_queue", return_value={"running": 0, "pending": 0}), \
                 mock.patch.object(gpu_slot, "_free", return_value=None):
                self.assertEqual(gpu_slot.claim("h3", "http://127.0.0.1:1")["occupant"], "h3")

            ready, release = ctx.Event(), ctx.Event()
            holder = ctx.Process(target=_hold_lock, args=(slot_file, ready, release))
            holder.start()
            try:
                self.assertTrue(ready.wait(8), "first process did not hold the lock")
                started, result = ctx.Event(), ctx.Queue()
                contender = ctx.Process(target=_try_claim, args=(slot_file, "seedvr", 1, started, result))
                contender.start()
                try:
                    self.assertTrue(started.wait(8), "second process did not attempt claim")
                    self.assertEqual(result.get(timeout=8), ("error", "RuntimeError"))
                    release.set()
                finally:
                    release.set()
                    contender.join(8)
                    if contender.is_alive():
                        contender.terminate()
                        contender.join(3)
                self.assertEqual(contender.exitcode, 0)
            finally:
                release.set()
                holder.join(8)
                if holder.is_alive():
                    holder.terminate()
                    holder.join(3)
            self.assertEqual(holder.exitcode, 0)
            with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": slot_file}):
                self.assertEqual(gpu_slot.peek()["occupant"], "h3")

            started, result = ctx.Event(), ctx.Queue()
            busy = ctx.Process(target=_try_claim, args=(slot_file, "seedvr", 1, started, result))
            busy.start()
            try:
                self.assertEqual(result.get(timeout=8), ("busy", "h3"))
            finally:
                busy.join(8)
                if busy.is_alive():
                    busy.terminate()
                    busy.join(3)
            self.assertEqual(busy.exitcode, 0)

            started, result = ctx.Event(), ctx.Queue()
            successor = ctx.Process(target=_try_claim, args=(slot_file, "seedvr", 0, started, result))
            successor.start()
            try:
                self.assertEqual(result.get(timeout=8), ("claimed", "seedvr"))
            finally:
                successor.join(8)
                if successor.is_alive():
                    successor.terminate()
                    successor.join(3)
            self.assertEqual(successor.exitcode, 0)
            with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": slot_file}):
                self.assertEqual(gpu_slot.peek()["occupant"], "seedvr")

    def test_queue_and_free_errors_keep_slot_unchanged(self) -> None:
        with _new_test_directory("h3-gpu-slot-error") as directory:
            slot_file = str(Path(directory) / "slot.json")
            _initialize_slot(slot_file)
            with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": slot_file}):
                with mock.patch.object(gpu_slot, "_queue", return_value={"running": 0, "pending": 0}), \
                     mock.patch.object(gpu_slot, "_free", return_value=None):
                    gpu_slot.claim("h3", "http://127.0.0.1:1")
                with mock.patch.object(gpu_slot, "_queue", side_effect=RuntimeError("offline")):
                    with self.assertRaisesRegex(RuntimeError, "offline"):
                        gpu_slot.claim("seedvr", "http://127.0.0.1:1")
                self.assertEqual(gpu_slot.peek()["occupant"], "h3")
                with mock.patch.object(gpu_slot, "_queue", return_value={"running": 0, "pending": 0}), \
                     mock.patch.object(gpu_slot, "_free", side_effect=RuntimeError("unload failed")):
                    with self.assertRaisesRegex(RuntimeError, "unload failed"):
                        gpu_slot.claim("seedvr", "http://127.0.0.1:1")
                self.assertEqual(gpu_slot.peek()["occupant"], "h3")

    @unittest.skipUnless(os.name == "nt", "Windows physical handle contract")
    def test_parent_junction_cannot_redirect_live_lease(self) -> None:
        ctx = multiprocessing.get_context("spawn")
        with _new_test_directory("h3-gpu-slot-junction") as directory:
            base = Path(directory)
            parent = base / "owner"
            parent.mkdir()
            slot = parent / "slot.json"
            outside = base / "outside"
            outside.mkdir()
            _initialize_slot(str(slot))
            with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": str(slot)}), \
                 mock.patch.object(gpu_slot, "_queue", return_value={"running": 0, "pending": 0}), \
                 mock.patch.object(gpu_slot, "_free", return_value=None):
                gpu_slot.claim("h3", "http://127.0.0.1:1")
            for name in (slot.name, slot.name + ".lock"):
                (outside / name).write_bytes((parent / name).read_bytes())
            outside_before = {name: (outside / name).read_bytes()
                              for name in (slot.name, slot.name + ".lock")}
            ready, release = ctx.Event(), ctx.Event()
            holder = ctx.Process(target=_hold_lock, args=(str(slot), ready, release))
            holder.start()
            try:
                self.assertTrue(ready.wait(8), "holder did not acquire the GPU lease")
                for name, raw in outside_before.items():
                    incoming = outside / (name + ".incoming")
                    incoming.write_bytes(raw)
                    with self.assertRaises(OSError):
                        os.replace(incoming, parent / name)
                    self.assertEqual(incoming.read_bytes(), raw)
                archived = base / "archived-owner"
                swapped = False
                try:
                    parent.rename(archived)
                except OSError as error:
                    if getattr(error, "winerror", None) not in (5, 32):
                        raise
                else:
                    created = subprocess.run(
                        ["cmd", "/c", "mklink", "/J", str(parent), str(outside)],
                        capture_output=True, text=True, timeout=10, check=False,
                    )
                    self.assertEqual(created.returncode, 0, "isolated junction creation failed")
                    swapped = True
                started, result = ctx.Event(), ctx.Queue()
                contender = ctx.Process(target=_try_claim,
                                        args=(str(slot), "seedvr", 0, started, result))
                contender.start()
                try:
                    self.assertTrue(started.wait(8), "contender did not attempt claim")
                    self.assertEqual(result.get(timeout=8), ("error", "RuntimeError"))
                finally:
                    contender.join(8)
                    if contender.is_alive():
                        contender.terminate()
                        contender.join(3)
                self.assertEqual(contender.exitcode, 0)
                for name, raw in outside_before.items():
                    self.assertEqual((outside / name).read_bytes(), raw)
                if swapped:
                    with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": str(slot)}):
                        with self.assertRaises(RuntimeError):
                            gpu_slot.peek()
            finally:
                release.set()
                holder.join(8)
                if holder.is_alive():
                    holder.terminate()
                    holder.join(3)
            self.assertEqual(holder.exitcode, 0)

    @unittest.skipUnless(os.name == "nt", "Windows physical handle contract")
    def test_preexisting_junction_and_hardlinked_leaves_refused(self) -> None:
        with _new_test_directory("h3-gpu-slot-links") as directory:
            base = Path(directory)
            actual = base / "actual"
            actual.mkdir()
            actual_slot = actual / "slot.json"
            actual_slot.write_text('{"occupant": null}', encoding="utf-8")
            (actual / "slot.json.lock").write_bytes(b"\0")
            outside_before = {name: (actual / name).read_bytes()
                              for name in ("slot.json", "slot.json.lock")}
            link = base / "owner-junction"
            created = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(link), str(actual)],
                capture_output=True, text=True, timeout=10, check=False,
            )
            self.assertEqual(created.returncode, 0, "isolated junction creation failed")
            with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": str(link / "slot.json")}):
                with self.assertRaises(RuntimeError):
                    gpu_slot.peek()
            for name, raw in outside_before.items():
                self.assertEqual((actual / name).read_bytes(), raw)

            for linked_name in ("slot.json", "slot.json.lock"):
                with self.subTest(linked_name=linked_name):
                    owner = base / ("hardlink-" + linked_name.replace(".", "-"))
                    owner.mkdir()
                    slot = owner / "slot.json"
                    if linked_name == "slot.json":
                        os.link(actual_slot, slot)
                    else:
                        slot.write_text('{"occupant": null}', encoding="utf-8")
                        os.link(actual / "slot.json.lock", owner / "slot.json.lock")
                    with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": str(slot)}):
                        with self.assertRaises(RuntimeError):
                            gpu_slot.peek()
            for name, raw in outside_before.items():
                self.assertEqual((actual / name).read_bytes(), raw)

    @unittest.skipUnless(os.name == "nt", "Windows physical handle contract")
    def test_runtime_refuses_uninitialized_files_and_redirect_gap_creates_nothing(self) -> None:
        with _new_test_directory("h3-gpu-slot-no-create") as directory:
            base = Path(directory)
            owner = base / "owner"
            owner.mkdir()
            slot = owner / "slot.json"
            with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": str(slot)}):
                with self.assertRaisesRegex(RuntimeError, "lock is not initialized"):
                    gpu_slot.peek()
            self.assertFalse(slot.exists())
            self.assertFalse((owner / "slot.json.lock").exists())

            (owner / "slot.json.lock").write_bytes(b"\0")
            with mock.patch.dict(os.environ, {"GPU_SLOT_FILE": str(slot)}):
                with self.assertRaisesRegex(RuntimeError, "state is not initialized"):
                    gpu_slot.peek()
            self.assertFalse(slot.exists())

            slot.write_text('{"occupant": null}', encoding="utf-8")
            outside = base / "outside-empty"
            outside.mkdir()
            redirected = base / "redirected-owner"
            created = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(redirected), str(outside)],
                capture_output=True, text=True, timeout=10, check=False,
            )
            self.assertEqual(created.returncode, 0, "isolated junction creation failed")
            files = gpu_slot._WinSlotFiles(slot)
            try:
                original_check = files._check_parent
                trusted_parent = files.parent

                def swap_after_check() -> None:
                    files.parent = trusted_parent
                    original_check()
                    files.parent = redirected  # fault injection exactly after validated path check

                with mock.patch.object(files, "_check_parent", side_effect=swap_after_check):
                    self.assertIsNone(files._open_file(slot.name, gpu_slot._OPEN_EXISTING))
                    self.assertIsNone(files._open_file(slot.name + ".lock", gpu_slot._OPEN_EXISTING))
                self.assertEqual(list(outside.iterdir()), [])
            finally:
                files.close()
            self.assertEqual(slot.read_bytes(), b'{"occupant": null}')
            self.assertEqual((owner / "slot.json.lock").read_bytes(), b"\0")

if __name__ == "__main__":
    unittest.main()
