---
description: "查询千手算力能力、保存规划草稿，并以经过核验的文件运行本地任务插件。"
kind: "package-reference"
---

# 千手算力核心

[English](README.md) | 中文

## 概述

查询经过鉴权的算力目录，保存有上限的本地方案，把已确认方案通过核心开发者任务入口发布，并查看任务进度。通过精确版本的本地插件执行已准入任务，核验输入和输出文件。取消会等待执行结束再移除临时文件。目录条目不能证明节点在线、价格有效、正式报价或收益已结算。

## 目录

- [使用方式](#use-this-package)
- [实现原理](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用方式

在提供已鉴权 Connection 服务的 Host 组合中挂载 `@deepseek-ai/dsh-compute-core`。如果智能体需要查询能力和保存本地方案，另外挂载 `@deepseek-ai/dsh-compute-core/tools`。核心不会自动添加这些工具，也不会另启智能体循环。真实 Loader 组合测试覆盖挂载、本地路由、持久化、原生能力插件注册和结果消费。

`POST /api/qianshou/compute/plans/confirm` 把所有者的 `approved` 或 `declined` 决定写进已有本机草稿。它不报价、不提交、不扣费。`POST /api/qianshou/compute/plans/publish` 把已确认草稿 POST 到 `POST /api/v8/developer/tasks`，并保存返回的任务身份。没有 `authorization` 或 `workloadId` 的旧文件分别按 `pending` 和 `null` 读取。

配置由[插件入口](src/index.ts)负责。目录读取优先使用已登录的 `accountSession` access token；`tokenEnv` 仍是无账号插件时的显式覆盖。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `baseUrl` | 空 | 核心 HTTPS 来源；空值禁用远端查询。 |
| `tokenEnv` | `QIANSHOU_CORE_TOKEN` | 可选的 access token 环境变量覆盖。已登录的 `accountSession` 令牌优先。 |
| `statePath` | `$DSH_HOME/qianshou/compute-plans.json` | 私有草稿路径；任务元数据使用 `.tasks` 同级文件。 |
| `timeoutMs` | `15000` | 完整上游请求的超时。 |
| `maxResponseBytes` | `1048576` | 上游 JSON 字节上限。 |
| `maxRequestBytes` | `65536` | 本地路由 JSON 字节上限。 |
| `maxDrafts` | `100` | 本地草稿保留上限。 |
| `maxStoreBytes` | `4194304` | 每个本地存储文件的字节上限。 |
| `maxTaskRecords` | `1000` | 本地任务尝试保留上限。 |

-----

<a id="understand-the-implementation"></a>
## 实现原理

<details>
<summary>实现与提供方职责</summary>

[服务](src/service.ts)把有上限的核心查询、本地持久化和受控原生执行串起来。能力插件在[执行器注册表](src/executor.ts)登记精确版本。[本地运行器](src/local-task-runner.ts)把经过授权的输入流暂存到随机私有目录，调用执行器，核验输出文件，并等结果消费者结束后清理。原生与传输提供方必须在返回之前停止全部子工作。本地路径和凭据不进入浏览器安全的[协议](src/protocol.ts)。

[任务授权验证器](src/envelope-security.ts)绑定 `qianshou.task.assignment.v1` 签名域、任务信封、尝试号、租约和派发方时间。只有它生成的冻结进程凭据才进入[协调器](src/employee-task-coordinator.ts)；复制 `verified` 标记不能取得准入授权。信任密钥和节点授权仍由调度适配器负责。公开包入口通过同一次多入口构建共享验证器注册表。

[传输连接器](src/node-transport.ts)解析已鉴权邀请，并使用显式限量的顺序队列。无效帧、队列溢出或消费者失败都会关闭会话；关闭会等待当前投递完成。出站帧按允许字段重新构建。具体传输仍负责 TLS、真实 worker 协议和地址。[能力 manifest](src/capability-manifest.ts)核对元数据与注册版本，不加载下载的代码。

[常驻任务循环](src/resident-loop.ts)是与传输无关、由外部拉动的空闲智能体 tick 接缝。每次 tick 先发出已脱敏的心跳，再按顺序把已验证邀请交给协调器，并使用 `interactionPolicy: 'autonomous'`；重叠 tick 会按顺序排空，`close()` 会拒绝新任务。Host 适配器提供计时器、资源观察器、邀请队列和网络心跳。该接缝不会打开套接字、请求人为确认或执行插件代码。

[节点租约边界](src/node-lease.ts)为一次任务尝试明确记录所属节点、过期时间、撤销和幂等键。只有所属节点可以接受或完成租约，只有调度权限可以撤销；过期后接受会被拒绝。状态机是纯函数且状态不可变，作为未来传输/持久化适配器的合同，不携带媒体字节、本地路径、凭据、价格或上传地址。

[插件市场规划器](src/plugin-market.ts)会在返回冻结的暂存方案前核验解析后的 manifest、包摘要、宿主版本范围、显式权限和部署方提供的签名。它不会下载、解包、加载或执行包代码；后续事务式安装和进程隔离由部署适配器负责。GPU 与本地模型权限会标记为原生复核，上海继续只承担元数据控制面。

Host 构建完成后，在仓库根目录执行 `node --test packages/host/compute-core/tests/public-artifacts.test.mjs`，核验构建后公开入口间的 Ed25519 任务授权。该检查消费构建产物，源码行为测试单独运行。包不发布运行时 `./invariant`，因为每个注册表与存储拥有自己的状态，没有另一个独立投影。

</details>

-----

### 结果资产验收

[`result-assets.ts`](src/result-assets.ts) 将已核验的本地输出文件转换为不可变的 `qianshou.result-assets.v1` 清单。它复用工作区核验器检查 SHA-256、字节数、普通文件归属和总量上限，然后要求每个输出都有受信的能力描述。描述声明有界 MIME 类型，可选的不透明 `evidence://`、`artifact://` 或 `urn:` 语义证据引用（可带摘要）。资产 ID 根据 `(taskId, idempotencyKey, name, sha256)` 确定生成，未来传输提供方可据此幂等去重。清单只为节点侧读取器保留本地路径；媒体字节和证据不会发送到上海，本包不上传、不查询对象存储，也不结算。


<a id="further-exploration"></a>
## 延伸阅读

- [Connection 载体](../../client/connection/README.zh.md) — 已鉴权本地路由。
- [执行器与任务授权决策](../../../.agents/notes/implemented/architecture/2026-09-14-qianshou-unified-executor.zh.md) — 版本、准入与签名。
- [受控本地任务决策](../../../.agents/notes/implemented/architecture/2026-09-14-qianshou-managed-local-task.zh.md) — 文件生存期与退出。

-----

<a id="model-experience"></a>
## Model Experience

### 可选规划工具

#### What the model sees

显式加载的消费者提供 `compute_capabilities`、`compute_plan_draft` 和 `compute_workload_read`。它们通过现有可记录的工具链返回有上限的目录、本地草稿收据和任务摘要，不暴露凭据、付费提交、节点数或执行审批回调。能力描述仍是不可信参考文字。

#### Token effect

三个工具 schema 加入已启用智能体的请求；只有选定的目录页、有上限的目标和指定任务摘要加入工具结果内容。成功的 `compute_plan_draft` 还会把 `qianshou.task-card.v1` 观测写入 `tool/result.meta`，会话才能回放方案卡片。

#### KV Cache effect

目录数据变化时工具定义保持固定，实时数据进入已记录的结果。加载或卸载工具消费者会改变智能体的 schema 集合。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

部署接入仍承担以下责任：

- 私有目录、冻结信封与文件核验不等于 OS 沙箱，不能阻止有管理权限的操作或核验后的并发修改；原生插件需要进程隔离，资产服务器必须核验授权对象路径与摘要。
- 输入和传输提供方负责经鉴权的任务访问及取消。结果消费者须在返回前完成读取和上传，因为随后会删除任务目录。
- 真实 worker 租约、远端取消、输入下载 API、资产上传、硬件发现和 H3/图像/视频插件尚未接通常驻循环的传输或执行适配器；循环本身只编排心跳和已验证准入。
- 已发布的 web profile 用上海源站和已登录账号会话读取目录。正式报价、节点派发和结算仍未挂载。未知的开发者任务 POST 不会自动重试。目录不接受 `inline` 的会话目标会被拒绝。
- 价格、预算授权、付费提交、市场安装/签名与节点结算仍需独立验证接入。本地测试不能证明生产、移动真机或商店验收。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作备注</summary>

无。

</details>
