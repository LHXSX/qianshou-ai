---
description: "通过注入的传输会话，把自主千手节点接入调度控制帧。"
kind: "package-reference"
---

# 千手调度控制适配器

[English](README.md) | 中文

## 概述

为自主贡献节点提供轻量、与传输无关的控制面门面。它组合现有的 `NodeSessionConnector` 建立一次鉴权会话，转发脱敏心跳和能力元数据，交付已经校验的任务邀请，并回报受限进度和结果清单。不保存凭据，不传输媒体字节，不报价、不提交付费任务，也不结算收益。

## 目录

- [使用此包](#use-this-package)
- [控制面边界](#control-plane-boundary)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用此包

使用部署方提供的 `NodeSessionConnector` 创建 `DispatchControlAdapter`。通过 `connect()` 传入一次性的访问令牌和初始心跳，使用 `onTaskOffer()` 订阅任务邀请，再使用 `publishHeartbeat()`、`reportProgress()` 和 `reportResult()` 发送控制帧。连接器仍负责端点允许列表、TLS 以及 WebSocket、HTTP 或 QUIC 的物理实现。

<a id="control-plane-boundary"></a>

## 控制面边界

适配器组合现有的 `node-protocol`、`node-session` 和 `node-transport` 契约。传入邀请已由连接器完成解析校验；签名核验和节点授权仍由部署适配器或调度服务负责。结果回报只包含名称、字节数和 SHA-256 摘要。输入获取、输出上传和任务执行仍在节点侧适配器完成。因此上海只接触调度元数据和控制帧。

<a id="model-experience"></a>

## 模型体验

### 调度控制接缝

#### 模型看到的内容

此包不暴露模型工具。智能体可以组合常驻循环和执行器注册表来处理已准入邀请；策略和本地执行由各自包独立决定。

#### Token 影响

不影响 token。`DispatchControlAdapter` 不注册任何模型输入，因此已准入邀请本身不会给请求增加内容。

#### KV Cache 影响

不影响 KV cache。本适配器既不组装也不发送提供方请求，因此没有缓存前缀依赖它。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与后续工作

- 不包含具体网络传输或生产端点，这里只是可注入接缝。
- 没有租约预留、报价、支付、结算、输入下载或资产上传 API。
- 适配器无法证明远端调度服务的签名或账户授权；这些校验必须在 `coordinateTask` 之前完成。

<a id="dev-note"></a>

### 开发备注

保持此包轻量。不要加入便捷 HTTP 客户端、归档加载器、模型运行时或媒体中继。新增协议字段前，必须先在 `compute-core` 中提供带版本的上游合同和固定夹具。
