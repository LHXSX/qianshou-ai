# 上海 V8 公开候选：离线测试复现记录

此页记录 2026-09-30 对基线提交 `d2443efd` 的测试结果，不代表现网验收或生产部署可重建。测试环境为 macOS arm64；下面的命令创建了 Python 3.12.13 的新虚拟环境。`requirements-test.txt` 固定了本次使用的 Python 包版本；它仅覆盖离线 pytest 环境。生产 PostgreSQL 驱动、OCR／媒体／云供应商等可选依赖及部署配置尚未锁定。请在隔离环境中操作，不要连接现网数据库或 Redis。

本候选仓的 13 个 P0 安全修复源码文件与离线审阅清单的修复后 SHA-256 完全一致。补入 `platform_v8/tests/api/test_p0_models_oss.py` 后，清单中的源码和测试共 19/19 个文件匹配。对该候选仓运行账号/API Key、Worker WebSocket、模型与 OSS、文件、送达及 CORS 的 9 个定向测试文件，结果为 **75 passed、3 warnings**。这些测试使用 SQLite 内存库与模拟的外部依赖。

**现网维护回执（2026-09-30）：**13 文件 P0 包经整目录原子切换上线，发布回执为 `v8-p0-security-20260930-172efc0f92c0-r2`；随后 3 文件的在线节点池、能力目录和公开模型字段修复经同样方式上线，回执为 `v8-p0-security-20260930-disclosure-r3`。两个发布器均核对旧版基线哈希、完整目录摘要、新进程及连续健康／就绪探测；首次发布脚本对 systemd 停机后的 `TasksCurrent=[not set]` 解析失败，旧版被自动恢复，R2 修正并通过 9 项发布器控制流程测试。R3 后只读复核了 3/3 文件哈希及整树摘要、公开模型列表／10 条详情／目录的字段白名单、未登录节点池 401、`status=all` 403；6 台节点均在重启后继续心跳。没有进行生产写请求、授权用户跨账号读取、真实任务租约、媒体生产或结算验收。本仓源码、现网服务和可独立重建的部署包是三个不同证据层级。

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

要把本仓作为可独立重建的生产部署包，仍须确定这些跨目录合同与运维脚本的分发边界，对齐生产代码和测试并重新跑完整收集与全量测试。不得为了让测试通过而伪造合同、弱化调度／结算校验或把失败改成无条件跳过。源码公开不等于完整测试通过或生产部署能力已交付。
