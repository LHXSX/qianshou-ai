# 上海 V8 公开候选：离线测试复现记录

此页记录 2026-09-30 对基线提交 `d2443efd` 的测试结果，不代表现网验收或生产部署可重建。测试环境为 macOS arm64；下面的命令创建了 Python 3.12.13 的新虚拟环境。`requirements-test.txt` 固定了本次使用的 Python 包版本；它仅覆盖离线 pytest 环境。生产 PostgreSQL 驱动、OCR／媒体／云供应商等可选依赖及部署配置尚未锁定。请在隔离环境中操作，不要连接现网数据库或 Redis。

从本目录运行：

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements-test.txt
PYTHONPYCACHEPREFIX="$PWD/.pytest_cache/repro-bytecode" .venv/bin/python -m pytest -q
```

完整收集当前在 **4 个错误**后中止；没有修改、删除或默认跳过这些测试：

- `platform_v8/tests/api/test_runtime_manifest_integrity.py` 引用本候选 `platform_v8/api/v8/bundles.py` 中不存在的 3 个 manifest digest 函数。
- `platform_v8/tests/contracts/test_r0_fixtures.py` 引用未随 V8 包提供的 `apps/eco-client/contracts/runtime-api/types.py` 与 provider 合同。
- `platform_v8/tests/services/test_marketplace_v2_author.py` 引用本候选 `platform_v8/services/marketplace/apps.py` 中不存在的 `_merge_v2_author_fields_into_body`。
- `platform_v8/tests/services/test_settlement_safety.py` 引用本候选 `platform_v8/engine/task_registry.py` 中不存在的 `_resolve_settlement_policy`。

只为诊断其余测试，可显式绕过上述 4 个文件（这不是发布用通过门禁）：

```sh
PYTHONPYCACHEPREFIX="$PWD/.pytest_cache/repro-bytecode" .venv/bin/python -m pytest -q --tb=no --disable-warnings \
  --ignore=platform_v8/tests/api/test_runtime_manifest_integrity.py \
  --ignore=platform_v8/tests/contracts/test_r0_fixtures.py \
  --ignore=platform_v8/tests/services/test_marketplace_v2_author.py \
  --ignore=platform_v8/tests/services/test_settlement_safety.py
```

新虚拟环境中的诊断结果为 **1219 passed、47 failed、63 skipped、4 warnings（46.11 秒）**。失败包括：候选缺少 `contracts/v1/capabilities.registry.json`，使能力注册表相关断言失败；`platform_v8/scripts/ops/sync_client_manifests.py` 未包含在公开候选却仍被测试引用；`platform_v8/scripts/tasks/` 实际有 96 个生产脚本，而旧测试和运行矩阵写 92 个；批量切片、动态任务注册、manifest/settlement 等测试与当前源码行为不一致。TOTP、受信设备、归档提交等失败还需逐项检查，不能仅归因于旧测试。部分 e2e 或可选能力测试因环境条件跳过；本次没有配置独立 PostgreSQL、Redis 或真实设备。

发布前应先确定这些跨目录合同与运维脚本的公开边界，取得可以发布的确切来源，再对齐生产代码和测试并重新跑完整收集与全量测试。不得为了让测试通过而伪造合同、弱化调度／结算校验或把失败改成无条件跳过。
