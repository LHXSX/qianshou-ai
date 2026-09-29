---
description: "查看已接入的算力能力，保存尚无报价的本机任务草稿。"
kind: "package-reference"
---

# 千手共享算力工作区

[English](README.md) | 中文

## 概述

可选的**共享算力**面板显示本机算力桥接服务返回的连接状态、列出已注册能力，并保存本机任务要求。已保存卡片在所有者确认并发布前保持无报价草稿。确认只写本机。发布请 Host 创建开发者任务。本包不提供接受报价、付款界面或分配节点的操作。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [任务卡片状态投影](#task-card-projection)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在受支持的 profile 中，与算力 Host 桥接服务一起启用浏览器插件。插件在主面板与侧栏 slot 注册 `qianshou-compute`，并在 `tool.call.toolview` 上注册 `compute_plan_draft`，复用智能体的 React 应用、共享控件、主题变量与语言服务，不依赖千手旧桌面客户端。

刷新读取 `GET /api/qianshou/compute/status`、`/capabilities` 与 `/plans`。是否存在配置，与任务查询、报价和提交是否已接入分别展示。刷新失败或数据格式错误会清空能力目录，避免继续显示过时的可用状态。目录为空时，不提供默认能力，并禁止创建草稿。

选择可用能力，填写任务目标、以元为单位的预算上限，并可选填并发节点上限。预算最多两位小数，转换为安全整数的人民币分。零元表示不接受付费执行。手动节点上限为 1 到 64；这是协议限制，不是在线节点数量。自动匹配以 `null` 表示，不会选择或预留节点。

保存将任务要求提交到 `/api/qianshou/compute/plans`。会话卡片上的确认会把 `{ id, decision }` 发到 `/api/qianshou/compute/plans/confirm`。发布会把 `{ id }` 发到 `/api/qianshou/compute/plans/publish`。Host 持久化草稿、本机授权和返回的任务身份；浏览器不使用 local storage 保存凭据或方案。卡片把用户预算与**尚无正式报价**分开展示。保存失败后保留表单供修改。控制器防止重复提交，表单另有同步保护，避免状态发布前连续点击。

-----

<a id="understand-the-implementation"></a>
## 理解实现

控制器读取三个资源后，一次发布完整结果。接口解析器拒绝错误的状态结构、重复能力、无效任务要求、非草稿状态和非空报价。不提供默认价格、编造的提速预估、预填能力或虚构节点数量。网络请求通过智能体现有传输方式使用同源鉴权 Fetch。

<a id="task-card-projection"></a>
## 任务卡片状态投影

`src/client/status-card.ts` 导出版本化、与提供方无关的 `qianshou.task-card.v1` 投影。`projectComputeTaskCard()` 将能力可用性、调度中心的并行建议、报价有效期、明确授权、提交状态、任务进度、结果可用性和稳定错误码折叠为一个不可变对象。卡片因此可以渲染规划、等待授权、执行、完成或失败，而不需要导入提供方 SDK 或发起请求。渲染缓存或事件中的卡片前使用 `parseComputeTaskCard()` 做边界校验。该投影只携带控制面元数据，不包含凭据、媒体字节、付款调用或网络提交行为。`compute_plan_draft` 的会话行把已持久化的 `tool/result.meta` 投影成这张卡片，并叠加上 Host 存储的 `authorization` 与 `workloadId`。确认和拒绝只改写本机授权字段。发布请 Host POST 开发者任务路由。

`RETURNED` 投影为 `returned` 阶段、`waiting` 进度和结果可用，不代表已验收或已结算。只有核心的 `SETTLED` 状态投影为 `completed`。`PAUSED` 和 `OFFLINE` 保留各自阶段、受阻进度和累计进度值，直到后续任务状态改变。已有任务一律投影为 `submitted`，即使调用方仍保留较早的 `ready` 提交值，也不能通过此投影再次成为新接单候选。

解析器校验嵌套枚举、可空字段、规范时间戳、非负安全整数价格和节点数、有界进度、观测时点的报价有效性以及生命周期一致性。无效载荷抛出 `INVALID_COMPUTE_TASK_CARD`，有效数据返回原对象。校验不认证数据来源、不授权执行，也不验证结果质量。免费任务可以在无报价时保持 `ready`，是否接单仍受消费方智能体策略约束。

`apply()` 管理控制器与语言字典。slot 注册等待所属 slot 就绪，所属 slot 或插件卸载时移除，slot 再次声明时可重新注册。插件卸载会中止请求并忽略迟到响应。组件只接收框架绑定的快照和普通回调，不导入其他功能插件的运行时代码或 Host 服务。

-----

<a id="further-exploration"></a>
## 延伸阅读

- [算力核心协议](../../host/compute-core/README.zh.md)：共享任务要求与连接类型。
- [控制器测试](tests/controller.client.spec.ts)：鉴权失败、错误响应、重复提交与卸载。
- [页面测试](tests/page.client.spec.tsx)：空能力目录、用户预算与无报价草稿卡片。
- [Web 样式](../../../docs/web-styling.zh.md)：共享主题变量与组件归属。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器算力面板

#### What the model sees

没有模型可见内容。本浏览器插件为用户显示 `qianshou-compute` 连接和能力控件，不注册模型工具、提示词区段或会话事件。

#### Token effect

不影响 token。读取能力和保存本机草稿不会向模型请求添加内容。

#### KV Cache 影响

不影响 KV cache。本包既不组装也不发送提供方请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本包尚未实现正式报价、账单、退款和结果领取。本机确认草稿不是上海任务身份。
- 会话目标不能把目录里的文件型输入种类发布出去。未知的 Host 发布不会从本页自动重试。
- 页面不安装插件、不配置核心凭据，也不开启闲置资源贡献。
- 已配置连接或本机测试成功，不代表生产账号访问、节点可用性、付费执行或结算已经验证。

<a id="dev-note"></a>
### 开发备注

本包不发布独立 runtime invariant。页面展示单一 Host 所有的数据投影；接口解析和生命周期测试覆盖本地前提，持久化、计价与访问不变量由 Host 和算力核心负责。
