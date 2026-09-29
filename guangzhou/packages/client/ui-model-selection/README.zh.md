---
description: "Web GUI 的模型选择：/model 弹窗与 composer 模型位共用一份按提供方分组的会话级目录；供模型路由的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

[English](README.md) | 中文

## 概述

Web GUI 允许用户通过 `/model` 或 composer 手动选择模型与推理（reasoning）强度，也可以启用按任务自动选择。两个界面共用按提供方分组的目录和路由策略。自动选择仅使用当前提供方已加载的候选模型；手动锁定模型后仍可保留自动推理强度。composer 显示最近实际使用的模型与最新路由理由。运行中的任务保留已解析的选择。如果没有适配器服务该路由，composer 会保持停用，直至路由恢复可用。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `ui-conversation` 及命令包一起挂载本插件；composer 随即显示模型位，`/model` 则以弹窗打开同一份目录。两个界面都显示 Host 报告的当前策略。手动选择优先显示目录名称，缺少名称时显示提供方／模型 id；不在目录中不会使一条可路由的选择失效。

### 模型与推理强度

模型按提供方分组。composer 的模型列表显示模型名称；`/model` 还显示提供方名称与目录说明，对匹配的内置说明使用当前语言，外部说明保持原文。手动选择模型会锁定该提供方／模型对。推理强度已经设为自动时，两个入口都会保留这项独立策略；否则使用所选模型公布的默认值，弹窗重选同一路由时会保留显式推理强度。composer 提供已公布的推理强度和独立的自动推理强度选项；选择显式推理强度不会把自动模型策略改成手动。不提供任意推理强度输入。

### 自动选择

选择唯一的**自动**入口，可以同时启用自动模型与自动推理强度。只有当前提供方已加载包含当前模型、共有 1–64 个模型的目录时，该入口才可用。入口记录这些候选 id；不会跨提供方选择，也不会引入其他员工配置的接口。`/model` 中的同一入口提交相同策略。之后手动选择的模型优先生效，同时保留此前启用的自动推理强度。

菜单说明提供方边界，以及每项新任务会增加一次简短路由请求。**最近使用**一行显示请求记录中的实际模型与推理强度，后面的说明来自 Host 最新的路由决策。这些记录与长期保存的自动偏好分开呈现；不会预测选择或模拟任务状态。

### 不可路由的会话

当 Host 报告没有适配器服务该会话的路由时，本插件注册一个 composer 阻塞块，输入框随之停用并显示本插件自己的文案；恢复后无需重新加载即清除。首次加载之前或加载失败之后的 `null` 绝不阻断；目录成员关系同样不阻断——一条仍在服务、只是不公布该模型的路由不在分组里，却可用。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两个入口共用一份由 `ModelDirectoryResolver`（`ctx.modelDirectories`）持有的会话级目录：`/model` popupSelect 贡献项（经 `ctx.commandUi` 注册）与 composer 的具名 `conversation.input.model` 位都经 `session.models` 加载会话的建议目录、经 `session.selectModel` 通过同一个 `ModelDirectory` 实例提交，因此任一入口所做的切换正是另一个入口接下来显示的。目录加载与选择共享一个代次计数器，旧响应不会覆盖新结果；连接重置丢弃所有常驻投影，并在显示前重新拉取 Host 恢复的选择。目录按会话惰性解析，随会话作用域一并 dispose（资源释放）；已寻址 subagent 会话不公开任一入口。每份常驻目录都会直接在转发的 `llm/adapters-updated` 与 `settings/document-updated` owner 事件上重拉。

`routing-selection.ts` 为两个入口构造选择，分别保存 `routing.model` 与 `routing.effort` 开关。目录分别公开长期策略、请求记录中的 `lastUsed` 选择和最新 `autoDecision` 理由。候选校验、任务分类与执行由 Host 负责；该 UI 不自行发送分类请求，也不静默扩大候选列表。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当仅了解模型界面还不够时，请阅读以下页面。这些页面从浏览器界面逐步深入到命令弹窗外壳与选择约定。

- [ui-commands](../ui-commands/README.zh.md)——`/model` 贡献项注册进的 popupSelect 外壳。
- [ui-conversation](../ui-conversation/README.zh.md)——声明 composer 的 `conversation.input.model` 位与 composer 阻塞块。
- [dsh-agent-default-model](../../core/agent-default-model/README.zh.md)——为从未选择的会话提供默认模型的默认模型服务。
- [任务自动路由](../../../.agents/notes/implemented/architecture/2026-09-14-qianshou-task-auto-routing.zh.md)——Host 的任务边界、提供方隔离与失败行为。
- [客户端包映射](../README.zh.md)——相邻的浏览器 UI 包。

-----

<a id="model-experience"></a>
## 模型体验

间接通过 `session.selectModel`，Host 按每项已接收的人类任务解析自动选择，保持运行中任务的选择稳定，记录路由失败而不静默切换提供方或重试执行，并隔离员工指定的绑定。

#### KV Cache 影响

切换路由可能减少提供方侧后续请求的缓存复用，或使其失效；提示词前缀本身不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了当前模型选择界面。它们是当前包约束，不是通用模型路由器对比或任务积压。

- **无创建期或已寻址 subagent 选择**——两个入口都要求既有普通会话的 agent（智能体）；没有可纳入会话创建的草稿阶段模型选择，subagent 继续执行也有意不公开独立的模型选择约定。
- **自动候选有明确范围**——启用自动需要当前提供方已加载 1–64 个模型，且包含当前模型。这不代表搜索账户内的所有提供方，也不代表目录说明可以为模型质量排序。
- **目录名仅供呈现**——选择与持久化使用提供方／模型／推理强度 id；目录查询或确切模型元数据查询失败的提供方以不可选失败行列出，重新加载前保持原样。
- **不能任意输入推理强度**——显式等级来自确切模型的适配器元数据。既没有推理元数据、也没有正在使用的自动策略时，不显示 Effort 行；自动推理强度不会虚构未公布等级的支持。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 command contribution，HMR（热模块替换）安全性测试证明该注册的 dispose 能正确完成；它不发出 Cordis 事件，也不持有跨插件可变状态。
