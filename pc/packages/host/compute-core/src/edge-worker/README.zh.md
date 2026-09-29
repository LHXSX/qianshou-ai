# 隔离 Edge 节点传输

[English](README.md) | 中文

本模块使用已核查的 Edge WebSocket 协议，通过字面量回环地址连接明确隔离的服务。它不安装应用、下载代码、执行任务、创建账户或授权生产费用。宿主提供认证身份、真实硬件、执行策略和自主会话回调。

## 合同与宿主职责

使用 [connection.ts](connection.ts) 的 `EdgeWorkerConnection` 和 [types.ts](types.ts) 中的数据类型。`connect(signal?)` 发送 hello/auth，初始保持暂停。宿主确定任务授权后，通过 `updateMode('running')` 允许接收任务。`onOffer(offer, signal)` 收到任务数据和取消信号。宿主独立检查允许的任务、输入范围、工具和工作区，再创建隔离智能体会话。网络能力标签或代码地址不代表执行授权。

真实路径为 `/api/v8/ws/worker`，子协议为 `edgecompute.v8`，帧版本为 `8.0`。`client_version: 8.0.0` 表示底座通讯协议，不是智能体产品版本。源码依据为 上海 V8 源码快照，其中 `platform_v8/protocol/ws_schema.py` 和 `services/artifact_lease.py` 定义原生任务与租约。节点身份来自 `auth_ok`，必须匹配配置的主人账户。可选 `workerId` 用于重连已经确认的同一节点。

任务身份为 `{workerId, workloadId, shardId, attempt}`，原生 attempt 从零开始。服务端不透明令牌只保存在私有映射，不进入任务数据、智能体提示、结果回执或公开事件。它不是整个智能体能力信封的签名。执行模型、能力和版本为空时仍保留空值。`codeUrl` 与 `codeSha256` 仅为不可信任务数据；本传输不会下载或运行代码。

`reportProgress(identity, fraction)` 使用原租约。`complete(identity, {inlineOutputUtf8, elapsedMs})` 发送已有原始文本结果形式，只返回 `sent-awaiting-verification`，不声称已验收、已取回结果或已结算。宿主随后查询权威任务状态并获取结果。会话编号和工具调用出处保存在宿主证据中，不添加推测的服务端字段。本模块尚未实现文件产物上传。

## 取消与生命周期

宿主必须遵循回调的 AbortSignal。关闭或断线会中止活跃会话，`close()` 等待其结束。旧 `shard_cancel` 不含 attempt；适配器以 `EDGE_CANCEL_RECONCILIATION_REQUIRED` 关闭，不猜测应取消哪个本地重试。活跃任务收到冲突 attempt 也需对账。同一个投递身份在单次连接内最多回调一次；跨连接的持久对账由宿主负责。

切换暂停会更新后续供给心跳状态，不取消正在执行的租约。首版用于有界隔离测试会话，尚未实现生产重连、能力发布、登录界面或持久结果发送队列。若注入的 `onOffer` 忽略取消信号，`close()` 可能无法等待结束。

## 验证与证据

在仓库根运行 `node node_modules/typescript/bin/tsc -p packages/host/compute-core/tests/edge-worker/tsconfig.json` 和 `node node_modules/vitest/vitest.mjs run packages/host/compute-core/tests/edge-worker`。聚焦测试覆盖原生零 attempt、身份绑定、私有令牌、原始输出、重复投递、主人不匹配、范围拒绝和取消等待。仓库测试别名解析供给错误模块使用的既有 atomic-write 依赖。

单独授权的上海环境使用独立 SQLite、Redis、存储和新注册账户。真实身份、目录、任务、报价 HTTP 与 WebSocket 认证心跳已通过 SSH 跨机验证。另一个固定脚本传输检查使用原始结果字节达到权威 DONE；明确不算自主智能体验收。零预算测试产生零金额 ESCROW_RELEASE 记录，余额仍为零。没有复制生产数据库、凭据或真实账务数据。

源码缺口要求两项仅隔离候选修复：Film 接入与规划依赖只在原任务条件下导入；Film 仍调用原授权，缺少依赖明确失败。九项聚焦 Python 测试通过。原生产源码未改。其他 SQLite 诊断、开发者空目录、可选 Writing 模块缺失仍为集成限制。生产能力授权、完整签名信封映射与商业结算尚未验证。
