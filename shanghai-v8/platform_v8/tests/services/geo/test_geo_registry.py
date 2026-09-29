"""
W2-4 · services/geo/registry.py 集成单测

覆盖:
  1. install() 后 task_registry 有 geo_query (mode=PULL)
  2. install() 幂等
  3. uninstall() 清掉
  4. lifecycle.start 切片时 · 给 geo_query workload 设 ShardMode.PULL (通过 W1-4 自动)
"""
from __future__ import annotations
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.engine import task_registry
from platform_v8.engine.task_registry import TaskMode


@pytest.fixture(autouse=True)
def _cleanup_state():
    task_registry.TASK_REGISTRY.pop("geo_query", None)
    from platform_v8.services.geo import registry as geo_reg
    geo_reg._installed = False
    yield
    task_registry.TASK_REGISTRY.pop("geo_query", None)
    geo_reg._installed = False


def test_install_registers_geo_query_pull_mode():
    from platform_v8.services.geo import registry as geo_reg
    geo_reg.install()
    
    spec = task_registry.get_spec("geo_query")
    assert spec.task_type == "geo_query"
    assert spec.mode == TaskMode.PULL  # 关键: PULL 模式
    assert spec.category == "ai"
    assert "params_only" in spec.accepted_input_kinds


def test_install_idempotent():
    from platform_v8.services.geo import registry as geo_reg
    geo_reg.install()
    geo_reg.install()
    geo_reg.install()
    # 不报错 + spec 仍然在
    assert task_registry.get_spec("geo_query").task_type == "geo_query"


def test_uninstall_clears():
    from platform_v8.services.geo import registry as geo_reg
    geo_reg.install()
    geo_reg.uninstall()
    spec = task_registry.get_spec("geo_query")
    # 被清掉后返 DEFAULT_SPEC
    assert spec is task_registry.DEFAULT_SPEC


def test_geo_query_spec_max_shards_limit():
    """单订单不超过 500 query (跟 orders.py 的硬限制对齐)"""
    from platform_v8.services.geo import registry as geo_reg
    geo_reg.install()
    spec = task_registry.get_spec("geo_query")
    assert spec.max_shards_limit == 500


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
