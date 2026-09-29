# 本机供给参考

[English](README.md) | 中文

本目录负责本机硬件观测、主人贡献策略，以及已核查 Edge HTTP 响应的窄适配。带认证的 Host 门面负责路由和后台刷新。此库不启动应用，也不创建账户、调度器、执行租约或账本。

## Host 接入

通过 `querySupplySnapshot(signal?)`、`updateSupplyPolicy(completePolicy, signal?)` 和 `close()` 使用 [SupplyController](controller.ts)。[公开 DTO](types.ts) 不含令牌或账户余额。初始策略必须显式设置所有字段；首次使用的 Host 策略为关闭且无启用服务。`FileSupplyPolicyStore` 接收 Host 私有数据目录下的独立绝对路径，复用 atomic-write 工具以 0600 权限保存。一个 Host 实例拥有一个策略文件；控制器串行化自身写入，不协调多个独立进程。

Host 提供真实前台任务、语音状态和活动任务数。未知值会阻止接单。贡献开启期间，Host 必须响应活动变化并定时刷新；快照在观测时应用策略，控制器不自行创建计时器。`close()` 中止未完成的探测和发布，并撤回后续供给。撤回不等于取消正在执行的服务端租约。

所有超时和响应、进程字节上限均由组合层显式配置。注入的探测和传输端口必须响应 AbortSignal。更新策略会中止旧的排队观测，先撤回再保存，随后重新探测。保存失败保留旧策略。若保存成功而探测失败，新策略仍已保存：错误后应刷新，不能假定更新回滚。

## 策略字段

`mode` 为 off、idle 或 allowed。两种开启模式都优先保障前台任务和语音。idle 模式还要求测得的空闲秒数达到配置阈值。`maxConcurrency` 是至少为 1 的安全整数；`minIdleSeconds` 和 `minFreeMemoryBytes` 是非负安全整数。活动任务数必须已知且低于上限，可用内存必须达到阈值。

启用服务 ID 唯一，由字母、数字、下划线、点、冒号或连字符组成，长度为 1–256，最多 128 项。主人费率设置唯一引用已启用 ID；`amountMinor` 是非负安全整数，`unit` 非空白且最长 64 字符，`currency` 为三个大写字母。这些是主人偏好，不是平台报价、预留或已发布资费。主人未填写时不生成价格。

## 真实观测

[本机探测](local-probe.ts) 读取操作系统 CPU、内存事实，并执行有界 GPU 查询。Apple 统一内存不会显示为独立显存。Windows AdapterRAM 可能受驱动报告限制。Linux 当前通过 nvidia-smi 探测 NVIDIA；失败时明确返回未知或探测错误，不生成 GPU。空闲状态当前使用 macOS IOHIDSystem；其他平台在接入适合的 Host 探测前保持未知。

工具条目仅在配置的版本命令成功退出后标为 verified。这证明可执行程序能够启动，不代表所有任务或插件能力已通过端到端自检。工具命令和参数来自可信 Host 配置，不接收调用方 shell 文本。Ollama 发现只接受显式配置的字面回环地址，并读取 `/api/tags`。已安装模型保持 pending，原因是 `MODEL_INFERENCE_NOT_VERIFIED`；不会执行推理、下载或读取云端凭据。智能体配置的云模型不属于本机已安装供给。

`eligibility.ready` 只描述本机接单条件。未注入已认证发布端口时，`advertisingState` 为 `not-connected`，发布 ID 为空。真实端口负责把已验证本机服务映射到现有服务端能力，并只返回确认的 ID。适配器不把本机工具版本推断成平台能力版本。

## 现有 Edge HTTP 合同

[EdgeSupplyApi](edge-api.ts) 接受 HTTPS 源地址，或用于本机服务及 SSH 隧道的字面回环 HTTP。它从 Host 管理的 provider 获取 bearer token，拒绝重定向，限制流式响应大小，支持取消，并返回不包含上游错误文本的稳定错误。`queryIdentity` 读取 `/api/v8/auth/me`；`queryCapabilities` 读取 `/api/v8/developer/task-types`；任务列表和详情使用 `/api/v8/workloads` 与 `/api/v8/workloads/{id}`。列表直接返回数组，详情直接返回对象。能力目录为 `{ok, items, total}`，不证明节点在线或能力版本。

`queryQuote` 使用现有不冻结预算的 `POST /api/v8/economy/quote` 合同：任务类型、非负工作量、速度 t24/t8/t2、质量 standard/double/high。金额字符串保留十进制精度。`authority: estimate-only` 是本地投影，表示响应不预留资金，也不授权提交。本模块没有启用提交或取消操作。

源码核查基于 上海 V8 源码快照：`platform_v8/api/v8/developer.py:439`、`economy.py:528`、`protocol/http_schema.py:261` 和 `api/v8/workloads.py`。源码存在不等于生产验收。真实 Worker 分配使用 shard_id、已认证 worker_id 和从 0 开始的 attempt，附带服务端签发的不透明 lease_token（`protocol/ws_schema.py:175`、`services/artifact_lease.py:33`）。其 HMAC 不签署智能体的完整能力信封。不得映射为本地自造租约，或声称客户端能在没有服务端密钥时验证 HMAC。旧取消帧没有 attempt，安全接入前需要明确的核对策略。

## 验证与待接入部分

在仓库根运行 `node node_modules/typescript/bin/tsc -p packages/host/compute-core/tests/local-supply/tsconfig.json` 和 `node node_modules/vitest/vitest.mjs run packages/host/compute-core/tests/local-supply`。测试使用隔离临时策略文件和回环 HTTP。组合进 compute-core 时，此库需要现有 `@deepseek-ai/dsh-atomic-write` 工作区依赖；仓库测试和类型检查配置会解析源码别名。

真实接入需要测试账户 access-token provider、已认证 Worker 登记及心跳、隔离任务空间，以及避免生产收费的规则。现有 Edge 启动入口支持独立 SQLite 测试环境；它不能共享生产数据库、Redis、文件存储、凭据或会话。真实跨机验收还需要智能体自己的隔离规划会话、已授权工具、真实模型执行、服务端租约及结果验收，以及结果字节返回。固定 runner、模拟 LLM、适配器测试通过或隔离测试环境均不等于生产完成。
