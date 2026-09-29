---
description: "由设备主人为单条现有本地 Session 授予可撤销访问。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-session-connect

[English](README.md) | 中文

## 概述

这个私有 Host 包授权访问一条普通本地 Session（会话）。已认证的设备主人选择只读或允许发送文字、连接备注以及 1–1440 分钟有效期。云账号登录、退出和切换不改变这些设备主人授权；结束访问需要明确撤销。不能授权 subagent 的子会话。[主人界面](../../client/ui-qianshou-session-connect/README.zh.md) 管理连接，不改变原会话的模型或权限模式。

## 目录

- [存储与权限](#storage-and-authority)
- [文字、游标与回执](#text-cursors-and-receipts)
- [开发备注](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="storage-and-authority"></a>
## 存储与权限

`qianshouSessionConnect` 提供读取状态、创建和撤销的主人 RPC。独立 `/qianshou-connect` HTTP 前缀提供不含凭据的浏览器外壳，仅开放读取、发送和回执三个操作。它不下发主人 cookie，也不以主人 cookie 作为访问授权。Bearer 密钥通过 URL fragment 传入，随后从地址栏移除，仅保存在当前标签页存储中；数据库只保留 SHA-256 摘要。完整连接链接仅在创建时返回，请将它作为秘密保护。在同一个标签页打开第二个授权链接会替换该文档的凭据并加载新授权；被替换授权的未确认消息随之丢弃。

新数据库默认位于 `$DSH_HOME/qianshou/session-connect/v1.sqlite`，保存有数量上限的授权元数据和命令摘要，不复制 transcript（文本记录）。新目录和文件使用仅主人可读写的 POSIX 权限。数据未做静态加密，同一操作系统账号下的文件访问不受此授权机制保护。不兼容的格式会被拒绝，不导入旧库、云 token 或手机中继。

`publicOrigin` 为空时，仅允许实际回环地址和回环 socket 对端。显式 HTTPS origin 需要独立配置可达的 TLS 代理，并保留匹配的 Host；转发请求头不能授予信任。本包不修改服务监听地址，也不配置代理。请求数量、请求截止时间及保留授权和回执数量由部署配置控制。拒绝未读完的上传时，先完成响应再关闭 socket，响应刷新另有五秒上限。

<a id="text-cursors-and-receipts"></a>
## 文字、游标与回执

读取仅从现有 Session 日志投影已记录的用户和助手文字，省略工具、推理、文件和系统指令；不会自动脱敏用户写入普通文字的秘密。首次展示扫描最近 200 条日志事件，后续窗口每次最多扫描 200 条事件，每个响应最多 25 条文字。每条文字上限为 6000 UTF-8 字节，完整 JSON 响应上限为 240000 字节。按授权限定的游标包含最近一次历史替换标识，使历史改变后重置视图而不陷入重复分页。重启后同一授权的游标若领先持久化尾部，也会重置到实际保留的窗口。超过 100000 条事件的历史在检查后拒绝；底层 Session 检查仍负责读取日志，并非有文件字节上限的流式加载实现。

文字请求最多 4096 个字符和 12000 UTF-8 字节。数据库在投递前登记稳定的客户端请求编号；同时到来的相同请求共用一次操作，内容改变则冲突。真实 agent（智能体）仅在最终同步授权检查后接收消息，继续采用会话原有权限。`received` 在原 Session 持久化检查点完成后记录，表示接收而非任务完成。冷态日志中已持久化的 Inbox 插入也能恢复接收回执，无需激活 agent。`uncertain` 不触发自动重执行，接收方需要在 PC 核对；从未登记的编号返回 `rejected`，可以沿用同一编号重试。

HTTP 截止时间可以先结束响应，而底层 Session 激活仍在等待；该操作继续占用服务请求配额，迟到激活在入队前再次检查取消状态。dispose（资源释放）拒绝新工作、中止本包操作，并在待处理 Session 操作结束后关闭 SQLite；不宣称取消或回滚已接收工作。尚未结束的外部激活可能延迟卸载。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护工作背景——点击展开</summary>

受控本地测试不能证明跨设备交付；实际 Host、连接与接收设备的验收需分别记录。

</details>

<a id="model-experience"></a>
## Model Experience

### 明确授权的文字投递

#### What the model sees

获准发送文字的接收方，其消息成为所选 Session 中普通、已记录的 `user/message`。本包不增加隐藏提示词、工具 schema、账号凭据或接收方身份。只读访问与授权管理不调用模型。

#### Token effect

agent 处理已接收文字时，按所选会话的正常输入和输出消耗 token。轮询与回执核对不消耗模型 token。

#### KV Cache effect

投递追加普通输入，不改写已有提示词前缀。供应商缓存行为不属于本包职责。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- 本功能连接一台可达 PC，不提供云备份、离线多方写入同步或跨 PC 副本。窄连接页不提供手机中继、账号所有权共享、实时 token 流、附件、工具或权限审批。到期与撤销不能擦除已经查看或复制的文字。活跃命令回执不会为腾空间而被驱逐；容量不足时，需要可回收的过期或已撤销授权，或调整部署容量。

本库没有独立持久化缓存或重复 transcript，因此不提供运行时 invariant companion。本地 SQLite、真实 socket 与 Loader 组合的 Session/JSONL 测试使用合成数据；浏览器资产装配和实际可达设备操作仍须单独在运行程序中验收。参见[授权决策](../../../.agents/notes/implemented/architecture/2026-09-21-qianshou-session-connect.zh.md)。
