---
description: "通过已认证的协调器配对协作电脑、提交需对端批准的远程任务，并查看持久化回执。"
kind: "package-reference"
---

# 远程设备协调器

[English](README.md) | 中文

## 概述

在千手主控中配对协作电脑、选择已授权目录，并提交命令、文件或桌面任务。每个任务均等待协作端批准，记录的回执区分已接受、执行中和已完成。可以请求取消或撤销设备，无需在浏览器列表或模型工具中暴露凭证。此包协调有限任务，不向远程机器分发 Harness Session。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[web-app 组合](../../bundle/web-app/cordis.patch.yml) 使用 Connection 和 WebServer 挂载协调器。浏览器请求保留 Connection 认证，原生设备使用单独的首次消息认证。它不改变主控默认监听地址，也不创建免认证网络入口。

此函数插件没有包专属配置字段。已提供 `connection`、`agents` 和 `jobs` 的自定义组合使用以下配置行挂载。`webServer` 是可选的：原生升级只在该服务存在时登记，因此 Electron 桌面仍能提供 `remoteDevices`。

```yaml
- name: '@deepseek-ai/dsh-host-remote-devices'
```

### 浏览器操作

`GET /api/qianshou/devices` 返回 `{ devices, jobs }`，只有公开设备元数据、授权目录元数据与任务状态；`POST /api/qianshou/pairings` 返回 `{ code, expiresAt, wsPath }`；`POST /api/qianshou/jobs` 接收 `{ deviceId, workspaceId, kind, payload }`；`POST /api/qianshou/job-cancel` 接收 `{ jobId }`；`POST /api/qianshou/device-revoke` 接收 `{ deviceId }`。后两者返回 `{ accepted: true }`，取消请求仍需对端回执确认。

### 更新准备

通过认证的 `GET /api/qianshou/update-readiness` 返回 `{ ready, busy: { agents, jobs, remoteJobs, admissions }, maintenance: { active, expiresAt, availableAt } }`。计数包含全部归属方、未发布的初始化、维护、两个待处理收件箱列表以及远端审批。`ready` 表示没有活动工作且没有租约；`availableAt` 单独标明准备冷却时间。时间戳使用 Unix 毫秒值，缺失时间为 null。

`POST /api/qianshou/update-prepare` 接收 `{}`，只有原子空闲准入成功才以 201 返回 `{ leaseId, expiresAt, ttlMs: 30000 }`。忙碌时返回 409 `UPDATE_BUSY` 和就绪信息；已有租约返回 409 `UPDATE_PREPARING`；五秒准备冷却期间返回 429 `UPDATE_RETRY_LATER`。`POST /api/qianshou/update-commit` 接收 `{ leaseId }`，在安装包校验后重新检查同一个仍有效的标识，返回 `{ committed: true, expiresAt }`；只有首次提交可将退出时限延长至最多额外 15 秒，重复提交不会续租。错误或过期的标识返回 409 `UPDATE_LEASE_EXPIRED`。

`POST /api/qianshou/update-cancel` 接收 `{ leaseId }` 并返回 `{ released }`；过期标识不能释放其他尝试。到期或插件销毁也会释放所有准入拒绝器。租约期间新智能体、收件箱、本地作业和远端任务的准入会明确失败；当前工作和草稿内容保留。这些 API 不负责安装包或停止进程。参阅[有界租约决策](src/update-readiness.ts)。

### 协作端安装包交付

`GET /api/qianshou/companion-downloads` 列出 `$DSH_HOME/qianshou/companion-downloads` 中已校验的发布文件；以 `/darwin-arm64`、`/win32-x64` 和 `/linux-x64` 结尾的固定 `GET` 路由将对应归档作为附件流式返回。这些路由与其他主控操作使用相同的 Connection 浏览器认证。它们供主控方下载，不是给接收方的公开网址；请下载后单独转交文件，不分享浏览器凭据。

准备各平台安装包后，运行协作端的 `scripts/prepare-downloads.py --output <DSH_HOME>/qianshou/companion-downloads`。脚本验证既有便携包校验值及 Mac 应用签名，创建 ZIP 并原子发布小型清单。宿主仅接受固定平台 id、有界归档及匹配文件名，在首次访问或文件变化后校验 SHA-256，拒绝符号链接文件，仅返回公开发布信息。归档流式传输，不会整体读入内存；断开或释放时取消流，不开放任意文件路径。缺失或校验不匹配的文件不会显示有效下载入口。暂存文件是受信的宿主用户发布输入，不构成操作系统隔离边界。

设备页提供各平台安装说明及可复制邀请。接收方使用的地址必须为非回环 HTTPS origin，且不含凭据、路径、查询或片段。格式合格始终标注为连通性未验证。本包不会创建公开网站或 TLS/VPN 入口，也不会把浏览器登录网址变成可分享链接。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

协调器负责设备身份、活动连接归属与持久任务回执。浏览器和可选的模型工具均通过该负责方提交；协作端负责批准和执行。

### 原生传输

原生伴侣主动连接同一端口的 `/qianshou-device`。带浏览器 `Origin` 的升级请求会被拒绝。首帧必须在五秒内发送 `pair` 或 `auth`，分别携带一次性配对码或者设备 ID 与凭证，并包含名称、平台、架构和工作目录列表。成功后以 `job`、`cancel`、`job-event`、`ack`、`heartbeat` 交换任务和完整输出快照。具体类型与输入上限见 [protocol.ts](src/protocol.ts)。

### 状态和边界

任务状态为 `awaiting-approval`、`running`、`completed`、`failed`、`rejected`、`cancelled`、`interrupted`。稳定任务 ID、连接内递增序号和终态不可逆规则阻止重复执行回执覆盖结果；连接恢复会重新发送未结束任务，但伴侣只恢复审批队列或同步已有回执，不自动执行。设备被撤销或连接被替换后，旧连接不能继续报告任务。持久文件为 `$DSH_HOME/qianshou/devices.json`，目录权限 0700、文件权限 0600，只保留凭证摘要；最多保留 200 条已结束任务和 100 条活动任务。

协作端支持 `command`、`read`、`write`、`list`、`desktop` 五类任务，本机逐项批准是执行的必要条件。目录限制由伴侣实施，远端报告的路径不会成为主控文件系统路径。Shell 命令仅限定起始目录，不是操作系统沙箱。桌面任务转交已安装的 RustDesk，不把桌面透视图或鼠标协议混入任务 RPC。

本包的本机检查见 [测试目录](tests)：配对、审批前不执行、取消、撤销与文件边界。当前源码闭包不含协作端应用；跨设备验收还需实际协作端与目标设备。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connection](../../client/connection/README.zh.md) — 浏览器认证与 Fetch 路由
- [浏览器操作](#use-this-package) — 人工配对与任务入口
- [任务协议](src/protocol.ts) — 协作端本地批准与执行消息
- [已知限制](#known-limitations-and-deferred-work) — 部署与目标机器验收

-----

<a id="model-experience"></a>
## 模型体验

### 远程任务工具

#### 模型看到什么

明确选定的预设通过 `@deepseek-ai/dsh-host-remote-devices/tools` 在标准 Tools 注册器中启用 `remote_device_list`、`remote_task_submit`、`remote_task_status` 和 `remote_task_cancel`。仅加载 Host 服务不会授予模型工具。定义说明提交后仍需本机批准、取消需要终态回执；模型看到真实设备、工作区 ID 和分页结果，不能生成配对码、取得凭据或撤销设备。状态默认返回 12,000 个回执字符，每页最多 50,000 字符。

#### Token 影响

只有启用这些工具的预设才增加四个固定工具 schema 的请求上下文。设备元数据与所请求的回执页进入工具结果；大页消耗更多 token，应只读取任务需要的内容。

#### KV Cache 影响

设备状态变化不改变工具定义。设备名称和结果进入工具回复，不进入 schema 前缀。启用或停用工具插件会改变可见 schema 前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

协调器保留以下执行边界：

- **本机用户执行** — 远程命令经本机批准后执行，没有操作系统沙箱；文件工作区边界由协作端实施。
- **有限任务协议** — 这些工具尚未实现远程 Harness Session 派发和子智能体自动分发。
- **目标机器验收** — 跨设备 TLS 与 RustDesk 屏幕/键鼠操作需要真实目标机器；本地协议测试不能证明这些能力。
- **单一状态负责方** — 一个服务协调设备和回执，并验证认证、输入、连接归属与终态转换，因此此包不发布空的 `./invariant` companion。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
