# platform_v8 · e2e 集成测试

> W6 · 2026-05-26 · 后续每改动自动回归

## 设计

策略: **sqlite in-memory + 真实 service code (绕 HTTP 层)**

- 速度: 全套 < 1s · 适合开发期 + CI 每 push 跑
- 隔离: 每个测试独立 sqlite engine · 互不污染
- 真实度: 走真 SQLAlchemy schema + 真 service function · 比 mock 单测高一层契约保证
- 局限: PG-specific SQL (JSONB `->>` 操作符 / `CAST AS uuid` / `FOR UPDATE SKIP LOCKED`)
  在 sqlite 跑不通 · 这部分留生产烟测

## 跑法

```bash
# 本地
make test-e2e          # 只跑 e2e
make test-all          # unit + e2e

# 直接
PYTHONPATH=. V8_DATABASE_URL='sqlite:///:memory:' POSTGRES_PASSWORD=test \
  pytest platform_v8/tests/e2e/ -v
```

## 当前覆盖

| 文件 | 场景 | 用例数 |
|---|---|---|
| `test_e2e_ledger_lifecycle.py` | ledger.transfer 三方分账 · 幂等 · 多 workload 累加 | 5 |
| `test_e2e_workload_lifecycle.py` | escrow_hold → reward → release / refund / 多 workload 隔离 | 4 |
| `test_e2e_admin_api.py` | TestClient + admin API HTTP 路由 (jwt 缺则 skip) | 5 (skip 本地) |

## Fixture (`conftest.py`)

- `db_session`: 独立 sqlite + 全 v8 表 create + 接管 db._engine
- `seed_accounts`: 3 个标准账号 (admin=1, customer=100 [10 EDG], worker_owner=200)
- `seed_worker`: 注册一个 ONLINE worker · 接 owner=200
- 自动清 proxy._sessions / _node_sessions / _blacklist_workers

## 加新 e2e 步骤

1. 测试函数前加 `pytestmark = pytest.mark.e2e`
2. fixture 依赖: 用 `db_session` 拿 SQLAlchemy Session
3. 走真实 service function (不要 mock)
4. 用 `LedgerRepo.sum_balance / raw SQL SUM` 验账面
5. SQLite SUM 用 float · 浮点容差用 `abs(float(x)) < 1e-10`

## CI

`.github/workflows/ci.yml` 新加 `platform-v8` job:
- python 3.11 · 装 fastapi + sqlalchemy + pytest
- compile check 全部 .py
- 跑 `pytest platform_v8/tests/` (排除 api)
- 跑 `pytest platform_v8/tests/e2e/ -v` 明细输出
