---
description: "供千手宿主插件共用的身份、能力和事件记录。"
kind: "package-reference"
---

# 千手平台基础

[English](README.md) | 中文

## 概述

本轻量 Host 包为独立插件提供统一的智能体、节点和配对设备身份、能力上报、心跳以及有界控制面事件词汇。它复用现有的 `SessionId`、`ComputeNodeId`、`DeviceId` 和节点能力记录，不包含模型运行时、媒体字节、传输、支付或具体插件实现。

## 目录

- [使用本包](#use-this-package)
- [职责归属](#ownership)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

使用 `PlatformDirectory.register` 登记经过校验的参与者，使用 `heartbeat` 更新存活和容量，使用 `publish` 发布经过传输解码的事件。`parsePlatformEvent` 是线上的准入函数。`registrationFromNodeHeartbeat` 把现有的 `qianshou.node.v1` 心跳转换为平台登记，不复制路径或凭证。目录只存在于进程内并返回克隆快照；部署可以在自己的适配器中持久化或传输这些快照。

<a id="ownership"></a>

## 职责归属

身份签发仍由 Session、算力调度或配对设备鉴权模块负责。能力实现拥有执行和输出文件。传输适配器拥有 TLS、鉴权和重试。本包只校验共用元数据，并隔离事件监听器异常，避免一个观察者阻断控制面发布。

<a id="model-experience"></a>

## 模型体验

无。本包不注册工具、提示词、模型调用或面向用户的界面。

### KV Cache 影响

无。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与延期工作

- 目录只存在于进程内；崩溃恢复和持久化参与者租约由部署适配器负责。
- 在核对调度传输合同前，本包不定义事件签名、重放窗口或网络投递。
- 能力记录只描述可用性，不授予执行或消费授权。

<a id="dev-note"></a>

## 开发备注

保持本包只承载元数据。传输、持久化或执行适配器应拆为独立包，并配套自己的证据和生命周期测试。
