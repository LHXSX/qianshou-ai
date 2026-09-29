---
description: "独立的千手 AI 运营管理台服务：RBAC、审计链、IP 白名单与上游管理，统一在一个版本化 HTTP API 之下。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-admin-console

[English](README.md) | 中文

## 概述

千手 AI 运营管理台背后的独立服务。它在 `/api/qianshou/ai/admin` 下提供一个版本化 HTTP API，用于账号、订阅、支付与上游密钥的管理，并用会话 cookie、基于角色的权限和可选 IP 白名单守住每一条路由。各功能区的就绪状态按区上报：依赖缺失时显示为只读或不可用，而不是给一份空列表。本服务以独立进程运行，是自身审计链的唯一写入者。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

用 `createAdminService`（或 `node src/main.ts serve`）启动服务，并设置 `QIANSHOU_ADMIN_PORT`，默认 `7090`。运营人员通过 `/session/login` 与 `/session/login-totp` 登录；管理台前端随后读取 `/modules`、`/account/list`、`/subscription/list`、`/rbac/*`、`/audit/list` 以及支付与上游密钥路由。宿主插件可以直接从包入口导入 `createAdminService`、`API_PREFIX`、`SERVICE_VERSION`、`SESSION_COOKIE` 与 `peekJson`，而不必自己重写传输层。

<a id="understand-the-implementation"></a>
## 理解实现

`server.ts` 负责路由表、会话 cookie 与 JSON 预读；`rbac.ts` 计算角色权限并对角色或管理员变更做预检；`audit.ts` 记录谁改了什么；`cidr.ts`、`client-ip.ts` 与 `whitelist.ts` 解析并校验调用方地址；`data-sources.ts`、`pool.ts` 以及各上游模块通过显式适配器读写账号服务。`modules.ts` 把每个功能区标为就绪、只读或依赖不可用，因此上游接口缺失是可见的事实，而不是靠空数据去猜。

<a id="model-experience"></a>
## 模型体验

### 运营管理台服务

#### 模型看到的内容

什么都看不到：`createAdminService` 只做运营人员鉴权、账号与支付记录读取以及审计写入，不注册任何模型工具、提示词区段或会话事件。它返回的管理记录由管理台渲染，不会经由本包进入对话。

#### Token 影响

不影响 token。本包没有任何请求组装路径会产生模型输入。

#### KV Cache 影响

不影响 KV cache。本服务既不组装也不发送提供方模型请求，因此没有缓存前缀依赖它。

API管理模块复用会话、IP 与 RBAC，权限为 `apiConnections.read` 及高危 `apiConnections.manage`。POST `/api-connections/list|detail|preflight|apply|check` 仅向广州持久节点存储委托安全元数据。预检把节点、动作、原 UUID 与当前状态绑定到已有确认令牌；应用在双方审计中写明操作者、原因与前后值。响应丢失时只查原 ref，不自动重复应用。`self` 范围按已认证操作者的账号归属真实过滤。暂停阻止新派单，恢复要求新 epoch，吊销永久拒绝该设备凭据；未知执行租约保留实际状态，不生成假终态或假结算。统计只数唯一任务及上海实际结算回执，不虚构收益金额。

通过 `QIANSHOU_ADMIN_API_CONNECTIONS_BASE_URL`、`KEY_ID`、`KEY_REF`、`AUDIENCE`（后面三个也使用相同完整前缀）配置独立的 localhost 网关服务身份。网关 `mediaNodes.adminControl` 仅授予 `nodes.read`/`nodes.manage`；每次重新读取属主私有凭据引用，不使用环境回退、重定向、用户令牌或调度凭据。服务不可用时返回503，不返回空列表。公开 GET `/v1/nodes/probe?nonce=<UUID>` 只返回精确 schema/service/nonce/当前 Unix 秒并禁止缓存；可达不代表有资格或任务授权。

每次成功的 API 管理列表附带 `qianshou.api-platform-integration.v1`：对公开入口 `https://app.qianshousuanli.com` 发出全新匿名 nonce 探测，返回 ISO UTC 观察时间与白名单内的运行配置状态。可用 `QIANSHOU_ADMIN_API_CONNECTIONS_PUBLIC_BASE_URL` 明确设置公开地址；仅接受没有凭据、查询、私有 IP 或端口的根 HTTPS 域名。`QIANSHOU_ADMIN_API_CONNECTIONS_PROBE_TIMEOUT_MS` 为100至5000毫秒（默认1500）。没有可信运行投影时保持 `unknown`；探测200不会把元数据、交换、调度或正式就绪标成 ready。私有地址、凭据引用、令牌与本机 API 地址不会进入此投影。

POST `/api-connections/guide` 的请求是空 JSON 对象，复用 `apiConnections.read`，返回无凭据的 `2026-09-29.1` 版 JSON/Markdown。它写明真实的 POST 节点通道、登记、恢复、心跳及原 attempt 媒体路由。普通 PC 用户明确确认模式后由 Host 自动登记；外部机器的 AI 可按此协议实现，但复制说明不会取得身份、受审配方或执行资格。空能力、零空闲槽设备仍显示已登记、待验证；未知 GPU 提交只读恢复原 job，结算后只恢复交付。私有管理未配置时仍可读说明，依赖失败不会让设备数变成0。运行 `node --test packages/host/admin-console/tests/api-connections.node-test.mjs` 验证真实 HTTP/SQLite、范围过滤、新旧 challenge、超时和凭据投影。

## 已知限制与后续工作

节点能力摘要元组不含图像或视频类型。在受审签名的官方档位到能力映射接通前，安全管理投影返回 `modes: []`（尚未取得这两类模式资格）；不从自报名字推断正式接单资格。已登记的在线连接即使模式为空也保留在目录；研发服务健康不会创建设备登记。

<a id="known-limitations-and-deferred-work"></a>

- 本管理台与算力运营台彼此独立：两者不共享路由、角色表或工程，在这里授予的角色对那边没有任何作用。
- IP 白名单是可选配置。没有配置白名单时，任何能连到监听端口的地址都会被接受，因此部署必须绑定到内网接口并显式提供白名单。
- 上游接口缺失的功能区保持只读或不可用，不会退化成捏造的数据；这意味着一部分管理台区域要等账号服务先暴露相应接口。
- 审计链只覆盖会写它的那些路由；直接对上游服务执行的操作不会记录在这里。

<a id="dev-note"></a>
### 开发备注

保持本服务独立：不要引入算力运营台、它的角色表或它的工程。新增管理台区域时，路由、权限校验、审计条目与就绪状态行必须一起加；绝不要为了让某个页面可用而放宽角色。

`/models/overview` 用专用 `models.read` 服务身份读取当前工作台模型目录；`/discovery/overview` 从广州既有讨论区存储读取官方活动、可见置顶内容和待处理举报。`/order/overview` 将当前已核验管理员的上海账号 Bearer 转发到全局支付订单查询，并要求 `order.read` 与 `all` 数据范围。这三个入口提供真实只读数据；模型改绑、退款和工单写入仍是独立缺口。运行 `pnpm --filter @deepseek-ai/dsh-host-admin-console test:modules` 验证真实 HTTP、持久内容与服务/账号凭据分离。

作者发布记录管理通过真实账号、精确投稿与服务器 revision 执行撤回、下架、归档和恢复。生命周期权限由上海返回；没有匹配本机源的云历史仅在明确的管理读取中可见，不授予本机执行器。归档保留合同、权益与账本，恢复只恢复列表显示。
