---
description: "面向订阅、任务预算、支付意图、退款和节点收益的提供方无关商业合同。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-billing-contract

[English](README.md) | 中文

<a id="use-this-package"></a>

## 概述

这是千手商业状态的轻量纯数据边界。它校验版本化的订阅权益、任务预算授权、报价确认、幂等支付意图、退款与 webhook 事件以及节点收益账目。不执行网络请求、支付、权益发放、退款、结算或任务提交。

## 目录

- [使用本包](#use-this-package)
- [架构边界](#architecture-boundary)
- [模型体验](#model-experience)
- [已知限制和后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="architecture-boundary"></a>

## 使用本包

在适配器边界调用 `parse*` 函数，并把返回的不可变记录保存到账户或平台存储。金额使用整数人民币分，时间使用规范的 UTC ISO 字符串。每个写入适配器都应复用给定的幂等键，并保留提供方事件 ID 与载荷摘要用于去重。

<a id="model-experience"></a>

## 架构边界

这些合同有意把报价确认、任务预算授权和支付意图分开。支付成功事件本身不能授权任务执行；调度器仍须核对账户归属、报价新鲜度、预算状态和策略。节点收益采用追加式账目事实，并通过明确的冲正链接表达回滚。Webhook 记录只包含不透明的提供方引用和摘要，不保存原始载荷或凭据。

未来可以在这些合同后面实现 Apple StoreKit、Google Play Billing、网页支付提供方、订阅服务和平台账本适配器。适配器负责签名验证、服务端凭证、幂等存储、权益策略、货币换算、退款处理和收益合规。本包不臆造任何提供方 API。

<a id="known-limitations-and-deferred-work"></a>

## 模型体验

本包不贡献模型工具、提示词或智能体动作。宿主可以通过鉴权界面只读展示权益和支付状态。用户确认与支付界面属于平台适配器。

<a id="dev-note"></a>

## 已知限制和后续工作

- 在明确多币种记账与舍入规则前，仅接受 CNY。
- 合同是跨进程记录；持久化存储、事务隔离和对账任务仍由平台实现。
- StoreKit、Play Billing、网页结账、税费、收益提现和真实 webhook 签名校验暂未实现。

### 开发备注

保持本包无传输依赖。不要加入 fetch、SDK 导入、银行卡数据、凭证原文或自动扣费决策。语义变更应新增版本化合同，不要静默放宽现有记录。
