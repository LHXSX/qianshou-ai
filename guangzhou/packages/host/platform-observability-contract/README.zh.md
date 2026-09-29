---
description: "千手智能体跨平台能力同步与受限可观测性记录合同。"
kind: "package-reference"
---

# 千手平台可观测性合同

[English](README.md) | 中文

## 概述

这个轻量 Host 包为 iOS、Android、桌面和 Web 智能体定义统一元数据合同，校验能力心跳、游标同步请求和脱敏可观测事件。它不携带凭据、路径、媒体字节、推送传输、支付或执行权限。

## 目录

- [使用此包](#use-this-package)
- [职责归属](#ownership)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用此包

在控制面边界调用 `parseMobileCapabilityHeartbeat`，通过 `parseMobileSyncRequest` 处理有上限的游标分页。智能体上报 `surface` 与策略层控制的 `acceptance`：`autonomous` 允许调度器考虑租约，`policy-paused` 与 `policy-reject` 是确定性的策略结果。转发诊断前调用 `parseObservabilityEvent`；属性键会拒绝密钥、路径和媒体字段。

<a id="ownership"></a>

## 职责归属

平台基础包负责身份；调度负责已鉴权租约和任务执行；客户端适配器负责操作系统生命周期与本地通知 API。部署可以将这些记录映射到 APNs、FCM、桌面 IPC 或 WebSocket，而无需修改本合同。

<a id="model-experience"></a>

## 模型体验

无。本包不注册工具、提示词或模型调用。

### KV 缓存影响

无。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与后续工作

- 同步是版本化元数据合同；持久游标、重放窗口和推送交付需要单独验收的适配器。
- 接单状态是策略输入，不是授权或支付决定。
- 可观测事件是有边界的诊断记录；日志和指标存储属于部署职责。

<a id="dev-note"></a>

## 开发备注

保持移动端和诊断记录与供应商无关。禁止向信封加入令牌、本地路径、二进制载荷或支付字段。
