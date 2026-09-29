"""R-1 · scripts 可选 sha256 / meta 通道（不 fail-closed）。"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[3]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.engine.execution_plan import hash_local_task_script


def test_hash_local_task_script_ocr_image():
    digest = hash_local_task_script("ocr_image")
    assert digest is not None
    assert len(digest) == 64
    script = Path(__file__).resolve().parents[2] / "scripts" / "tasks" / "ocr_image.py"
    assert hashlib.sha256(script.read_bytes()).hexdigest() == digest
