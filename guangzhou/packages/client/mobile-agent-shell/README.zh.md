---
description: "与提供方无关的移动端智能体宿主，负责生命周期、游标同步、任务卡片和策略驱动的无人干预接单。"
kind: "package-library"
---

# 千手移动端智能体宿主

[English](README.md) | 中文

## 概述

这个 Client 包为 iOS、Android、桌面和 Web 宿主定义轻量、与提供方无关的端口。它组合现有平台心跳与游标合同、现有授权类型和算力任务卡片投影。宿主负责本地生命周期事实与确定性的任务卡片策略判断；嵌入适配器负责登录、鉴权同步和操作系统 API。

本包不打开 APNs 或 FCM，不提交 workload，不传输媒体，不保存令牌，不处理支付，也不授予权益。`accept` 只表示策略允许调度适配器继续处理，不表示任务已经接单或执行。

## 目录

- [使用此包](#use-this-package)
- [产品边界参考](#product-boundary-reference)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用此包

使用明确的 `MobileAuthPort`、能力读取器、元数据同步适配器和 `MobileAcceptancePolicy` 创建 `MobileAgentShell`。操作系统宿主通过 `setSurface` 和 `setOnline` 更新状态；发送心跳时调用 `createHeartbeat`；鉴权后用 `sync` 请求一个游标页。把事件收到或缓存的任务卡片传给 `receiveTaskCard`，它先解析现有的 `qianshou.task-card.v1` 投影，再执行策略判断。

本包从 `lib/index.js` 导出库，不注册 Cordis 插件，也没有浏览器插件入口。[构建配置](tsdown.config.ts)使用 Client 阶段的库预设，依据见[构建决策](../../../.agents/notes/implemented/bug-fix/2026-09-15-mobile-shell-library-build.zh.md)。

策略必须明确后台运行选择、本机并发上限以及无报价卡片是否可以接收。带报价的卡片要求现有卡片授权为 `approved`；报价过期、能力不可用、未登录、离线、挂起或达到容量上限时会保持等待。`markTaskStarted` 和 `markTaskFinished` 只维护宿主持有的容量计数，不执行任务。

`MobileAgentShell.sync` 校验 `qianshou.mobile.sync.v1`，检查回执身份与单调递增的 revision，然后提交回传的游标和运行任务数。传输是 HTTPS、WebSocket、IPC 还是其他方式由适配器决定。持久游标、推送交付和服务端租约权威属于本包之外。

<a id="product-boundary-reference"></a>
## 产品边界参考

扣子公开资料呈现轻量对话入口、可复用模板和工作流，并把插件作为可添加到 Agent 或工作流节点的工具集合。插件文档还区分本地设备连接与 Web/移动端查看，用户协议规定插件审核和第三方 API 责任。千手借鉴“入口加可组合能力加状态面板”的交互边界，同时把执行放在桌面或共享节点，保持上海只负责控制面，并让无人干预接单受显式本地策略约束。本包不包含扣子代码、SDK 或提供方协议，也不宣称兼容扣子。

2026-09-15 查阅来源：[扣子模板库](https://www.coze.cn/gallery)、[扣子插件介绍](https://docs.coze.cn/guides_plugin)、[创建插件](https://docs.coze.cn/create-plugin)和[用户协议](https://docs.coze.cn/guides_terms-of-service)。

<a id="further-exploration"></a>
## 延伸阅读

- [平台可观测性合同](../../host/platform-observability-contract/README.zh.md)：心跳、游标和有边界的诊断记录。
- [算力任务卡片投影](../ui-compute/README.zh.md)：控制面卡片字段与结果状态。
- [授权类型](../../credentials/authorization/README.zh.md)：面向用户的授权流程词汇。

<a id="model-experience"></a>
## 模型体验

无。本包不暴露模型工具、提示词或会话事件。

### Token effect

无。移动生命周期和任务卡片判断不会组装模型请求。

### KV Cache 影响

无。本宿主不持有或修改模型上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与后续工作

- 原生 Keychain 或 Keystore 存储、OAuth 界面、APNs 与 FCM 注册、WorkManager 和 BGProcessingTask 调度属于嵌入宿主职责。
- 真实任务提交、鉴权租约、结果领取、媒体传输、支付、权益对账和推送重放未在此实现。
- iOS 与 Android 的前台、后台、进程终止、温度、电量、网络和商店审核仍需真机与渠道证据。

<a id="dev-note"></a>
### 开发备注

本包不发布 runtime invariant。宿主是带显式端口的纯客户端适配层；解析、生命周期、策略和过期回执由本包 Client 测试覆盖。
