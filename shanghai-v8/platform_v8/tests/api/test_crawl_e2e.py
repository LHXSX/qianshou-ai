"""
legacy crawl *HTTP* 路由已刻意卸下，相关 HTTP schema 也不在迁移链中。

状态说明（防后续误用）:
  - HTTP 面：/api/v8/admin/crawl、/api/v8/crawl 视为废弃，不应再挂载。
  - 引擎侧 ``services.crawl``（统一 workload / registry / aggregator）仍保留，
    并由单元测试覆盖，例如::

      platform_v8/tests/services/crawl/test_crawl_registry.py
      platform_v8/tests/services/crawl/test_unified_workload_create.py
      platform_v8/tests/services/crawl/test_aggregator_hook.py
      platform_v8/tests/services/crawl/test_verify_level_double_run.py

原整模块 HTTP e2e 已删除，避免长期 pytest.skip 形成盲区。
本文件只做路由哨兵：若有人重新挂载旧 HTTP 路径，测试失败并提示补回 HTTP e2e。

只检查路由表，不启动 TestClient/lifespan，避免污染其他模块进程内状态。
"""
from __future__ import annotations

_LEGACY_CRAWL_HTTP_PREFIXES = (
    "/api/v8/admin/crawl",
    "/api/v8/crawl",
)


def test_legacy_crawl_http_routers_remain_unmounted():
    from platform_v8.api.app import app

    mounted = [
        path
        for route in app.routes
        for path in [getattr(route, "path", "")]
        if any(
            path == prefix or path.startswith(prefix + "/")
            for prefix in _LEGACY_CRAWL_HTTP_PREFIXES
        )
    ]
    assert mounted == [], (
        "检测到 legacy crawl HTTP 路由已重新挂载: "
        f"{sorted(mounted)} · HTTP 面已废弃；若确需恢复，"
        "必须先补回 HTTP e2e，并更新本哨兵与迁移链说明"
    )
