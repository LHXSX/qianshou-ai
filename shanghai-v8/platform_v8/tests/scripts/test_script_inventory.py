"""生产任务脚本基线门禁。

生产真相源仅为 platform_v8/scripts/tasks/。本测试刻意不执行外部网络、
GPU、OCR 或媒体工具；它确保每个脚本至少可被 Python 编译，并防止脚本
目录在没有同步运行矩阵的情况下悄然扩大。
"""
from __future__ import annotations

import py_compile
from pathlib import Path


SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"
EXPECTED_SCRIPT_COUNT = 92


def _production_scripts() -> list[Path]:
    return sorted(
        path for path in SCRIPTS_DIR.glob("*.py")
        if not path.name.startswith("_")
    )


def test_production_script_inventory_is_stable():
    scripts = _production_scripts()
    assert len(scripts) == EXPECTED_SCRIPT_COUNT, (
        "生产脚本数量变化时，必须同步更新 "
        "platform_v8/scripts/TASK_RUNTIME_MATRIX.md 和对应 smoke test"
    )


def test_every_production_script_compiles():
    errors: list[str] = []
    for script in _production_scripts():
        try:
            py_compile.compile(str(script), doraise=True)
        except py_compile.PyCompileError as exc:
            errors.append(f"{script.name}: {exc.msg}")
    assert not errors, "\n".join(errors)
