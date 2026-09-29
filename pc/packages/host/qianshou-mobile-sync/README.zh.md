---
description: "千手手机中继的 PC 侧会话端口：查所有者后读取、并把文本最多一次地送进原会话。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-mobile-sync

[English](README.md) | 中文

## 概述

手机是这台 PC 会话的一个窗口，不是第二个干活的地方。本包按当前登录的账号把这台 PC 注册到中继，回答五个被转发的读取操作，并把手机来的一条文本命令最多一次地送进原会话。会话日志始终是唯一的历史；本包只记录哪些请求被认领过、以及关于它们能证明什么。

## 目录

- [每次触碰会话的前后都查所有者](#the-owner-is-checked-on-both-sides-of-every-session-touch)
- [一条命令最多被采纳一次](#one-command-is-admitted-at-most-once)
- [身份与存储](#identity-and-storage)
- [配置](#configuration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期事项](#known-limitations-and-deferred-work)

<a id="the-owner-is-checked-on-both-sides-of-every-session-touch"></a>
## 每次触碰会话的前后都查所有者

每个被转发的请求都点名中继为手机核验过的账号。这个主体在触碰会话之前与之后各与本机当前登录账号比一次，不一致就是明确的 `PC_WINDOW_OWNER_CHANGED` 拒绝，而不是悄悄放过。未登录的 PC 以 `PC_WINDOW_NOT_SIGNED_IN` 拒绝。登出或切换账号会在旧注册离开中继之前先撤销全部绑定。

一个绑定同时点名四个轴：账号、PC、原会话、手机。四个轴都参与存储键，所以两个账号或两台 PC 不会撞车。属于别台 PC 的绑定对本机即未知。`access` 对未知或已撤销的绑定回答 `unauthorized`，好让手机提供重新配对而不是读到一个错误；而所有者变更仍然是拒绝。

<a id="one-command-is-admitted-at-most-once"></a>
## 一条命令最多被采纳一次

手机给的 `requestId` 是整个端口的幂等键。请求在触碰会话之前先被持久认领，这一步既定下它在该绑定收据流里的位置，也推导出会话看到的请求身份。同一 id 同一内容返回已存的收据；同一 id 不同内容是 `PC_WINDOW_REQUEST_CONFLICT`。同一条命令的两次并发重试会合并为一次采纳。

只有会话的持久化屏障才能把认领变成 `received`。采纳失败时，本包去问会话日志请求是否已经到达 —— 因为无论哪个方向，日志是唯一的证据：失败之前已经发生的采纳会被报成 `received`，而无法证明的尝试保持 `uncertain` 并记下原因。`uncertain` 从不允许自动重发，已 `received` 的结果也绝不会被后来的失败原因覆盖。只有 `sync` 页在 `notReceivedIds` 里报出的 id 才是本机从未认领过、可以再发一次的。

同一部手机重新配对会恢复被撤销的绑定而不回退它的收据游标，所以一次重连不会把已采纳的命令当成新命令重放。

<a id="identity-and-storage"></a>
## 身份与存储

本机身份是一个不透明 id：配置值优先，否则严格读取 `DSH_HOME` 下的私有文件，只有文件缺失才生成一个 UUID 并以仅所有者可读的权限写入。格式错误、来源不符或超长的身份文件一律被拒绝，因为悄悄生成一个替代品会让这台机器在中继上注册成另一台 PC。

专用 SQLite 数据库带自己的 application id，拒绝任何其他文件，包括 session-connect 的数据库。它只存绑定与收据：没有会话历史、没有消息文本、没有任何凭据。命令内容以 SHA-256 摘要保存，这足以发现同一 id 下内容被换掉。

<a id="configuration"></a>
## 配置

`relayUrl` 默认是广州网关主机加手机-PC 中继前缀。`pcId`、`pcIdPath`、`path` 默认为空，即把身份文件与数据库解析到 `$DSH_HOME/qianshou/mobile-sync` 之下。

`accountPollMs` 默认 2000，按间隔读账号快照 —— 因为账号插件不发布变更事件。`pollWaitMs` 默认 25000，且必须小于 `requestTimeoutMs`（默认 40000）；反过来会在加载时立刻被拒。`reconnectMinMs` 与 `reconnectMaxMs` 默认 1000 与 30000。`replyCacheSize` 默认 256，好让中继的重复投递无需重新执行即可应答。`maxBindings` 默认 100，`maxReceipts` 默认 10000，`maxRequests` 默认 8，`sessionTimeoutMs` 默认 15000。

`serveInbound` 为真时，这台 PC 不再长轮询。它登记广州已经在转发的 `POST /api/qianshou/account/adopt-browser`、`POST /api/qianshou/account/state` 和五条 `/api/qianshou/mobile/pc-window/*`，并维持一条暂停的上海 worker 心跳，`window_origin` 是 `https://pc.qianshousuanli.com` 或 `https://pc-win.qianshousuanli.com`。上海确认的 worker id 就是绑定里的 `pcId`。只有 `deviceId` 的 bootstrap 选择最近的非空会话。手机文字作为普通用户消息进入该会话。worker 套接字上的任务分配会被拒绝。`accountOrigin` 默认 `https://qianshousuanli.com`。`windowOrigin` 为空时跟随本进程的操作系统。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护工作背景——点击展开</summary>

本地准入回执不能证明手机客户端已部署或设备已经实际配对。

</details>

<a id="model-experience"></a>
## 模型体验

### 已准入的伴随设备指令

#### 模型看到什么

被采纳的命令会成为原会话里一条普通的 `user` 消息，与在这台 PC 上打出来的那条无从区分。其余一切都不会到达模型：绑定、收据、游标与状态 Remote 从不参与模型请求。

#### 词元影响

被采纳的命令按其文本消耗普通会话词元。读取、收据与状态不产生词元。

#### KV Cache 影响

被采纳的消息像任何用户消息一样延长会话上下文。其他操作都不改动上下文及其 KV 缓存。

## 已知限制与延期事项

<a id="known-limitations-and-deferred-work"></a>

- 本链路调用的 `/pc/*` 中继端点是本包的提议，已部署的网关尚未提供，所以还没有任何「手机到 PC」的端到端验收。测试覆盖所有者检查、幂等采纳、身份解析、存储、relay-link 的重连与退避、应答缓存、注册状态迁移，以及 account-watch 的轮询投递。
- `cancel` 会被解析、随后以 `PC_WINDOW_ACTION_UNSUPPORTED` 拒绝；从手机打断正在跑的回合需要先有一个取消端口。
- 收据证明的是采纳，不是任务完成；而收据缺失也从不意味着未投递。
