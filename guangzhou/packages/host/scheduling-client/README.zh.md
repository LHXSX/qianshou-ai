---
description: "自主千手节点与调度控制面之间的提供方无关桥接。"
kind: "package-library"
---

# 千手调度客户端

[English](README.md) | 中文

## 概述

`SchedulingClient` 是自主智能体与调度中心之间的窄适配边界。它组合部署方提供的鉴权传输和已核对的只读算力 API，定义版本化心跳、邀请、接受/拒绝、进度、结果元数据和撤销帧；不会打开套接字，也不会猜测未记录的路由。

## 目录

- [控制面边界](#control-plane-boundary)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="control-plane-boundary"></a>
## 控制面边界

`qianshou.scheduler.control.v1` 帧只含任务与资产元数据。输入/输出字节、本地路径、凭据、价格和上传地址保留在节点或未来的传输适配器中。`readCatalogue()` 通过[算力 API 客户端](../compute-api/README.zh.md)查询 `/api/v8/auth/me`、`/api/v8/developer/task-types` 和 `/api/v8/workloads`，无需建立节点连接。它返回身份和任务类型对象，以及没有外层包装的只读任务数组。它不发送写请求。传输层负责 TLS、令牌交换、地址白名单和重连策略。

决策按 `(taskId, attempt)` 幂等。重复相同的接受/拒绝不会重复发送帧；冲突决策安全失败。后续适配器可持久化该映射，并在交给常驻循环前核验已签名的邀请/撤销。

<a id="model-experience"></a>
## 模型体验

无。本客户端提供给 Host 组合使用，不注册模型工具。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 本包不包含生产 WebSocket/HTTP 实现、租约签名核验、持久化幂等存储、远端取消、媒体上传、支付或结算。扩展路由前必须先取得最新 API 源码证据和合同夹具。

<a id="dev-note"></a>
### 开发备注

保持包的提供方无关和轻量。上海仍只承担控制面；媒体传输属于贡献节点、广州服务或工作台。
