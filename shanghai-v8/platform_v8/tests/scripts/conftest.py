"""S4-T4 · 2026-06-07 · 技能脚本 pytest 框架

约定:
  - 每个 task_type 一个 test_<task>.py
  - 通过 run_script(name, stdin, params) 用 subprocess 真跑脚本
  - 校验 stdout JSON 的 status / 关键字段
"""
from __future__ import annotations
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"


def run_script(
    name: str,
    stdin: str = "",
    params: Optional[dict] = None,
    timeout_s: int = 30,
    env_extra: Optional[dict] = None,
) -> dict:
    """跑一个 task_type 脚本 · 返回解析后的 JSON · 失败 raise"""
    script = SCRIPTS_DIR / f"{name}.py"
    assert script.exists(), f"脚本不存在: {script}"
    env = os.environ.copy()
    if params is not None:
        env["EC_PARAMS"] = json.dumps(params)
    if env_extra:
        env.update({str(k): str(v) for k, v in env_extra.items()})
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    proc = subprocess.run(
        [sys.executable, str(script)],
        input=stdin, text=True, capture_output=True,
        timeout=timeout_s, env=env,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"{name} exit={proc.returncode}\nstdout={proc.stdout[:500]}\nstderr={proc.stderr[:500]}"
        )
    last_line = proc.stdout.strip().split("\n")[-1] if proc.stdout.strip() else ""
    try:
        return json.loads(last_line)
    except json.JSONDecodeError:
        raise RuntimeError(f"{name} stdout 非 JSON: {proc.stdout[:500]}")


@pytest.fixture
def script_runner():
    return run_script
