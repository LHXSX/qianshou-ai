---
description: "已核对的 edge-compute v8 HTTP 控制面只读适配器。"
kind: "package-library"
---

# @deepseek-ai/dsh-host-compute-api

[English](README.md) | 中文

<a id="summary"></a>
## 概述

本包为宿主插件提供一个有界、带鉴权的 edge-compute v8 控制面只读客户端，覆盖当前底座源码清单已经核对的身份、任务类型、任务、分片元数据和结果元数据查询。它不提交任务、不报价、不取消任务、不下载媒体，也不实现调度和结算。

<a id="table-of-contents"></a>
## 目录

- [使用本包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

由部署拥有的凭证提供器创建 `createComputeApiClient({ baseUrl, accessToken, maxResponseBytes })`。客户端只向 `/api/v8` 下的路径发送 `GET`，加入 Bearer 令牌，限制响应字节数，校验端点对应的 JSON 容器，并把上游失败映射为稳定错误。客户端在内存中保留传入的凭证，但不持久化或记录它；凭证轮换后需创建新客户端。

方法对应 `GET /api/v8/auth/me`、`/developer/task-types`、`/workloads`、`/workloads/{id}`、`/workloads/{id}/shards` 和 `/workloads/{id}/result`。`workloads()` 返回没有外层包装的冻结数组，每条记录浅冻结；没有可见任务时返回空数组。对象包装或非对象条目会触发 `COMPUTE_API_RESPONSE_INVALID`。其他方法仍只接受对象。字段保持为底座拥有的不透明数据；调用方在交给界面或日志前选择可以安全展示的字段。

<a id="understand-the-implementation"></a>
## 实现说明

`src/index.ts` 负责 URL 校验、路径安全的 ID、请求头、有界流式读取、端点对应的 JSON 校验和错误映射。调用方在测试或部署传入 `fetch`；TLS、代理策略、凭证刷新、重试和限流由包外负责。本适配器不传输媒体字节。

<a id="model-experience"></a>
## 模型体验

无。本包不注册工具、提示词、模型调用或 Session 事件。

#### KV Cache 影响

无。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

- 报价、预估、创建和取消等写路由暂缺，等待核对幂等、预算和退款完整合同。
- 下载路由暂缺，媒体传输仍由节点、广州服务或工作台资产适配器负责。
- 单元测试没有证明真实端点、凭证、网络或生产验收。

<a id="dev-note"></a>
### 开发备注

[任务列表决策](../../../.agents/notes/implemented/bug-fix/2026-09-15-qianshou-workload-list-response.zh.md)记录源码版本和已核对的响应声明。扩展端点必须有源码证据和测试；源码检查与夹具测试不代表生产验收。
