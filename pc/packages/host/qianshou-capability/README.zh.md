---
description: "只读的千手能力目录、调度器健康度与服务端价格估算，三层互不混同。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-capability

[English](README.md) | 中文

## 概述

`qianshouCapability` Remote 为会话卡片回答三个只读问题：上海注册表列了哪些能力、调度器为某个能力报了多少工作节点、服务端估算这个能力要多少钱。这里没有任何方法会提交任务、生成报价单号、锁定价格或预留资金。

## 目录

- [三层永不互相塌缩](#the-layers-never-collapse-into-one-another)
- [实时目录与本地契约副本](#live-names-and-local-contract-copy)
- [失败都有名字，绝不返回空](#failures-are-named-never-empty)
- [配置](#configuration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期事项](#known-limitations-and-deferred-work)

<a id="the-layers-never-collapse-into-one-another"></a>
## 三层永不互相塌缩

「被列出」不等于「能跑」：`catalog()` 与 `availability()` 返回 `catalog-only`，且 `availability()` 把 `declared` 与 `availableNow` 作为两个独立事实上报，所以「声明了四个工作节点、当前无人在线」读出来是可用数为零，而不是「不存在」。`availableNow` 是调度器在读取那一刻报的数，不是预留。

「估算」不等于「报价」：`estimate()` 返回 `estimate-only`，每个金额都按服务端给的十进制字符串逐字照抄。它同时给出 `fields`，把每个投影字段名映射回它来自的服务端字段，好让卡片能为每个数字标出处。报价、提交与账本属于第三、四层；本包没有对应方法。

<a id="live-names-and-local-contract-copy"></a>
## 实时目录与本地契约副本

`catalog()` 读取上海返回的 `registry_version` 和 `capabilities[]`，逐项校验能力名、实现列表与旧任务类型列表；过时或不合法的应答报 `invalid-response`，不会伪装为空目录。`loadContracts` 在启动时从同一个目录读 `capabilities.registry.json` 与 `intent.schema.json`，副本缺失、无法解析或结构不对就在那里大声失败，而不是拖到第一次请求。注册表名字必须小写、点分隔、至少两段；只有域名段必须以字母开头，因为注册表里就有 `render.3d`。

上海新列出的能力即使本地副本不认识，仍会显示在目录中，标题与估价落点不会编造。只有上海同时列出本地副本记录的 `legacy_task_types`，卡片才显示该估价落点。`estimate()` 提交本地副本为能力记录的第一个落点；副本没有落点的能力（例如 `accelerator.gpu`）会在不发请求的情况下被判为 `not-in-catalog`。卡片采集的意图子集是 `goal` 加可为空的 `budget`，按契约自身的 schema 节点校验；本地预算上限只回显给界面看，从不提交。

<a id="failures-are-named-never-empty"></a>
## 失败都有名字，绝不返回空

每次不成功的读取都会返回一个具名 `CapabilityFailureCode`，连同它读的那条路由，以及有 HTTP 应答时的状态码。服务端响应体、`detail` 文本与凭据值都不会到达调用方。`signed-out` 意味着没有存过账号令牌、一个请求都没发，它既不同于 `unavailable`，也不同于「空目录」。带 `detail.found === false` 的 404 是 `not-in-catalog`；本包无法逐字段投影的应答是 `invalid-response`。

账号令牌引用从构建后的 `qianshou-account` 包导出取得。正式 Host 不得导入该包的 TypeScript 源码路径：Electron 的普通 Node 模式不能执行 TypeScript 参数属性。

<a id="configuration"></a>
## 配置

`coreOrigin` 默认 `https://qianshousuanli.com`，必须是不带路径、凭据、查询与片段的 HTTPS 源；明文 HTTP 仅对回环测试服务器开放。`contractsDir` 默认空字符串，即选用仓库自带的 `contracts/v1` 副本，否则必须是同时放着两个契约文件的目录。

`timeoutMs` 默认 10000，约束单次尝试。`maxRetries` 默认 1，且只对读生效，因为 `POST` 估算严格只跑一次。`retryDelayMs` 默认 500，`maxResponseBytes` 默认 524288；超出该上限的响应体或非 JSON 的响应体一律不产出载荷，而不是做半截解析。`maxPending` 默认 3；超出的请求报 `busy`，不排隐藏队列。插件释放会中止在途请求，此后每个方法都报 `closed`。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护工作背景——点击展开</summary>

注册表元数据与本地别名不能授予平台审核状态或执行授权。

</details>

<a id="model-experience"></a>
## 模型体验

### 只读能力查询

#### 模型看到什么

什么都看不到。本插件不注册模型工具、不追加 Session 事件；`catalog()`、`availability()` 和 `estimate()` 只回答客户端 RPC。卡片决定展示给用户的内容，是之后另行写入的普通会话输入。

#### 词元影响

无。这些读取不增加模型词元。

#### KV Cache 影响

无。这些读取不改动模型上下文及其 KV 缓存。

## 已知限制与延期事项

<a id="known-limitations-and-deferred-work"></a>

- 报价、提交、取消与计费都不在这里。`estimate-only` 刻意不带 `quote_id`，所以本包里没有任何东西会被误当成锁定价格或已预留余额。
- 每次调用都是一次无缓存的新读取，所以相隔片刻的两次读取可以互相不一致；`checkedAt` 记录了每个视图的取数时刻。
- 标题只从本地注册表副本补全。服务端列出、而副本不认识的 id 仍然会被列出，只是没有标题也没有落点，不会被丢掉或改名。
- 调度器的 `by_impl` 计数点的是实现，不是节点，且本包不核验其中任何一个真能把活干下来。
- `contractsDir` 的默认值解析到仓库里的 `contracts/v1` 副本，而它只存在于源码检出中。打包后的桌面应用把同一份副本带进随包资源，并把 `QIANSHOU_CONTRACTS_DIR` 指向它；其他已安装的应用得自己设这个变量。
