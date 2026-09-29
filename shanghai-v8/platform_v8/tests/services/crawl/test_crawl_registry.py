"""
W4-D3 · crawl registry install/uninstall 单测 (2026-05-26)
"""
from __future__ import annotations
import sys
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.engine import task_registry
from platform_v8.engine.task_registry import TaskMode
from platform_v8.services.crawl import install, uninstall


def setup_function(_fn):
    uninstall()


def teardown_function(_fn):
    uninstall()


def test_install_registers_crawl_subtask():
    """install 后 task_registry 含 crawl_subtask · mode=PULL"""
    assert "crawl_subtask" not in task_registry.TASK_REGISTRY
    install()
    assert "crawl_subtask" in task_registry.TASK_REGISTRY
    spec = task_registry.TASK_REGISTRY["crawl_subtask"]
    assert spec.mode == TaskMode.PULL
    assert spec.task_type == "crawl_subtask"
    assert spec.category == "data"
    assert "python3" in spec.runtimes
    assert spec.max_shards_limit >= 100_000


def test_install_is_idempotent():
    """重复 install 不报错"""
    install()
    install()
    install()
    assert "crawl_subtask" in task_registry.TASK_REGISTRY


def test_uninstall_clears_registry():
    install()
    uninstall()
    assert "crawl_subtask" not in task_registry.TASK_REGISTRY
