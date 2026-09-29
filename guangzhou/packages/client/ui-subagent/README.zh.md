---
description: "dsh Web 客户端的 subagent 对话目录、续接路由 UI 与 '@' 引用 source。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-subagent

[English](README.md) | 中文

## 概述

使用本包可浏览父会话下的每个 subagent 对话、打开任意后代，并查看其是否正在运行以及 token 用量和活跃轮次耗时。已完成的 one-shot 对话会作为只读执行记录打开。可继续对话在运行期间按提交顺序接收后续提示词，并独立提供 Stop。普通会话侧边栏会省略 subagent 对话，因此父会话页头目录是它们的导航入口。独立的 `@` source 会把运行中 child 的 label 插入用户消息，但不会把它解析成继续执行地址。

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

会话页头保留当前会话 title 作为谱系面包屑，并在会话存在 subagent 后代时，于页头操作行之前追加 `/` 数量触发器；触发器打开后代目录，统计仅含 subagent 的完整谱系、在普通 fork 处停止，并在任一计入统计的后代处于 `running` 时显示活动仍在进行。选择任意深度，即可用该子会话的确切 `{parentSessionId, childSessionId, mode}` 地址打开其对话。

### 协作团队

点击、键盘或悬停都可打开目录。顶部显示实际后代数量及运行中数量，每行都链接到真实子任务的文本记录；没有预设的虚构成员。inactive 行使用中性状态，因为不活跃本身不能证明成功。用户并行派工与模型委派任务使用同一持久化目录。

### 移出团队分支

每个健康目录条目都有垃圾桶按钮，紧凑面板也提供**移出团队**。确认框注明选中的员工及其全部下级。Host 持久保存接受的移出操作，并保留原会话日志。两处团队视图及计数同步更新；正在查看被移出的下级时，导航返回其直接父会话。运行中、排队中或状态无法确认的分支不能移出。若确认期间接到新任务，明确的拒绝提示会保留整个分支并说明下一步。

### 浏览目录

行显示 mode、`running`/`inactive` 活动状态与由日志支撑的可选 title；尾随列在上行显示提供方的持久化 token 用量总计，在下行显示活跃轮次耗时。键盘导航：ArrowRight/ArrowLeft 展开和折叠分支；ArrowUp/ArrowDown、Home、End 与 Escape 用于导航或关闭树。没有 label 的 one-shot 行回退到其会话 id；损坏、不受支持或不可用的行仍保持可读但禁用。

### 续接对话

确切 parent 存活时，可继续 child 保留普通输入 chrome：child 运行期间输入和 Send 保持可用，因为每条后续消息都会进入 child 的 FIFO inbox，而独立的 Stop 经由 `subagents/interruptByParent` 路由。确切 parent 不可用且 child 未在运行的可继续 child 会选用说明恢复路径的只读编辑器；此类 child 仍在运行期间，selector 会让位给普通编辑器——输入区与 Send 被禁用，但独立的 Stop 保持可用。

### `@` 引用 source

`@` source 仍然刻意保持独立且惰性：候选是从 `ctx.sessions.list` 零 RPC 得到的运行中 child；pick 会插入字面文本 `@label `，codec 投影为 `@label`。它不参与命令裁决，也不会把 label 解析成继续执行地址。

### 紧凑团队动态

`conversation.session.sidepanel` 插槽把紧凑团队动态挂载到独立布局区域。会话栏较宽时，新任务或恢复工作会在正文旁展开面板，不移动键盘焦点。窄栏中新任务保持收起；主动点击人数控件后，在正文上方展开限制高度的面板。两种模式都不会覆盖对话，收起后释放全部侧向空间。任务结束会标记控件，不宣称 CEO 已验收。条目依据当前根团队目录和会话摘要，显示任务、公开进展、工具名、实际最近使用的模型以及供应商已报告的 token 与缓存用量；不包含工具参数和推理内容。打开记录需要权威目录地址。面板与面包屑菜单共享目录观察，关闭一处不会停止另一处更新。活动卡片使用当前主题强调色。任务列表独立滚动并保持控制按钮可见。Escape 和收起按钮把焦点归还人数控件；打开后，焦点移至面板的收起按钮。两个控件都公开展开状态及关联面板。面板遵循减少动效设置。

× 按钮仅从此面板隐藏已结束记录；页脚可批量隐藏，并提供撤销与恢复。这些操作不会将员工移出团队。显示偏好保存在本机浏览器，按根会话和已观测的任务版本隔离，刷新后保留，原会话与结果不受影响。正在执行及需要反馈的任务保持可见；员工恢复工作或收到新任务版本时自动重新出现。保存失败会在面板内提示，当次显示仍可撤销。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

目录与编辑器行为由 [Web subagent 对话笔记](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.zh.md) 与[当前轮次中断笔记](../../../.agents/notes/implemented/feature/2026-08-06-continuable-subagent-interrupt.zh.md) 规定。

### 目录派生

页头谱系 renderer 通过标准 `useSessions` 钩子读取 `subagentsByParent` 与会话摘要。紧凑树仍以直接目录为权威依据：每个健康行的 `hasChildren` 提示在交互前决定是否显示展开控件；每层目录仅在其中至少一个健康行是分支时才预留展开列；展开分支时会立即为每个已知直接后代预留一行禁用的加载行，随后再用该 child 的权威目录懒加载结果替换。每个可见分支都会上报给运行时，使成员帧只在树正被消费的位置触发去抖动刷新。

Host 回执与 `api-session/subagents-retired` 事件共用 Session Manager 的幂等移出流程。已移出的 id 会阻止在途旧列表、目录与控制帧重新添加成员；Host 的持久化过滤在刷新后提供相同的成员关系。参见[团队移出笔记](../../../.agents/notes/implemented/feature/2026-09-14-qianshou-subagent-retirement.zh.md)。

### 耗时与 token

token 用量总计为四个互不重叠的 `tokenUsage` 桶之和。耗时会累加已完成的 `subagentTiming` 轮次，仅在运行中 child 存在未结束轮次时每秒递增一次，并在 child 变为 inactive 后冻结；被中断的未结束轮次以其同一切面的 `active.through` 为上界，绝不使用更新的会话元数据。

### 编辑器选举

one-shot child 始终选用只读编辑器。可继续 child 仅在其确切 parent 不可用且 child 未在运行时选用只读编辑器；否则普通编辑器的会话会经 `subagents/prompt` 路由提示词。本包绝不接收宿主上下文，也不调用面向模型的工具。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

以下页面覆盖对话界面、宿主 seam 与设计笔记。

- [ui-conversation](../ui-conversation/README.zh.md)——承载页头操作与编辑器链的聊天界面。
- [ui-input-trigger](../ui-input-trigger/README.zh.md)——承载 `@` source 的建议机制。
- [subagent](../../subagent/subagent/README.zh.md)——可继续 child 背后的宿主能力 seam。
- [Web subagent 对话](../../../.agents/notes/implemented/feature/2026-07-27-web-subagent-conversations.zh.md)——目录与编辑器规范。
- [当前轮次中断](../../../.agents/notes/implemented/feature/2026-08-06-continuable-subagent-interrupt.zh.md)——独立 Stop 的语义。

-----

<a id="model-experience"></a>
## 模型体验

### 用户提示词中的 subagent label 文本

#### 模型看到的内容

只有 `@` 引用 source 会影响模型输入：pick 的候选以字面文本 `@label` 进入普通用户消息，没有专用内容块或宿主侧解析。浏览目录、导航 child 与查看持久化 transcript（文本记录）都不会添加提示词 section；已接收的继续交互内容会经宿主 subagent 适配器成为普通 FIFO 用户消息。

#### Token 影响

有条件且仅追加：字面 `@label` 或用户后续消息只会向对应的新用户消息增加 token。目录与 transcript 操作增加零模型 token。

#### KV Cache 影响

仅追加。本包绝不改写更早的请求 token。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制定义目录能显示什么、`@` 引用意味着什么；它们是当前包约束。

- **目录没有持久化结果**：活动状态与计时无法区分完成、失败或取消，且 UI 不公开 Activation 身份；停止能力仅限编辑器上针对运行中可继续 child 的当前轮次 Stop。
- **已移出分支没有恢复或归档浏览入口**：日志仍保留在磁盘，但活动目录链接不能重新打开已移出的分支。
- **`@` 引用仍是显示标题文本**：重复或改名后的 label 会有歧义，因此它们刻意不获得继续执行语义。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。插件只注册一个 slash source，其资源释放已由 HMR（热模块替换）安全规范验证；它不发出 Cordis 事件，也不持有跨插件可变状态。
