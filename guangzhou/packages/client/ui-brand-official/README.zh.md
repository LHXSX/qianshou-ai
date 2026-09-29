---
description: "按构建选择侧栏与会话首屏中的 DeepSeek 或千手品牌填充；供选择或替换品牌呈现的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

[English](README.md) | 中文

## 概述

本包为 `official` DeepSeek Harness 构建和 `forge` 千手构建提供侧栏品牌。千手也在会话首屏复用同一个矢量标志。其他 profile 保留声明外壳的回退内容。选择匹配的构建 profile，或为其他品牌提供替代品牌包。本包不保留运行时状态，也不影响模型请求。

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

将本插件挂载到浏览器插件名单，然后以匹配部署品牌的 profile 构建客户端。

### 选择 profile

`DSH_CLIENT_BUILD_PROFILE=official` 选择 DeepSeek 侧栏标志与名称，并保留首屏声明方的回退内容。`forge` 选择本地化的千手侧栏品牌，并在首屏显示相同的千手标志。私人品牌会等待 locale 服务。其他 profile 取值让所有品牌 slot 保持声明方的回退内容；插件仍会加载，但不注册填充。

### 千手品牌

千手标志使用原生 SVG：一个中央协调点与六条弧形臂位于圆角底座内。32 单位 viewBox 保留一单位外侧留白与 2.5 单位臂线宽，在请求的 24px 收起轨道和 34px 展开侧栏或首屏尺寸下保持清晰。底座使用主题品牌强调色，中心与弧臂使用配套的前景色。标志没有位图资源或动画，在外壳的无障碍控件内作为装饰。

本地化名称采用两行排版，主标题保留完整高度，下方显示次级说明。空间有限时仅说明文字横向省略。[侧栏外壳](../ui-sidebar/README.zh.md#brand-and-new-session)负责按内容确定行高，并为周围控件留出安全距离。`forge` 构建还会用当前会话的模型目录、现有作曲栏工具和空的任务状态填充 `sidebar.right.tab.guide`，空会话首次挂载时展开该栏，并为智能体广场、工作流、文件与数据、模型与API注册四个产品页。

每个产品页都包含一句话定位、分组事实卡片、「从哪里用」的可执行清单，以及一条诚实的边界说明。页面显示的内容全部读自部署中已经在运行的服务：会话列表镜像（`ctx.sessions`）提供可寻址的子智能体名册与宿主上报的后台进程，会话模型目录（`ctx.modelDirectories`）提供已响应的服务商、读取失败的服务商与当前路由。数据源为空就显示空态，绝不填一个占位数字；数据源未挂载就在页面上写明。页面上的按钮只做已验证的跳转：回到对话、切换到四个产品面板之一、打开右侧栏的「文件」页签（真实的 `ctx.sidebarRight.openTab('files')`，且仅在会话为它提供工作区时出现）、以及打开名册里的子智能体会话。右栏目录行会选中当前 Session 模型。「更多模型」打开模型与API，「查看全部」打开任务中心。

### 替换品牌

使用其他品牌的部署不组合本包，而是组合一个占据侧栏与首屏 slot 的包。占据 slot 是组合路径；本包不提供运行时品牌配置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

嵌套的 `ctx.slots.inject()` 调用在声明存在时成组安装两个侧栏填充，并在声明消失时一并撤回。千手首屏填充独立等待自身声明，复用侧栏的 [`ForgeBrandMark`](src/client/ForgeBrand.tsx) 组件。两条注册路径都支持晚到的声明、重新声明与插件卸载，且不保留状态。浏览器半部是 [`src/client/index.ts`](src/client/index.ts)；node 半部是一个空 Loader 座位。浏览器标题由 `DSH_CLIENT_TITLE` 单独选择。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当品牌面不够用时阅读以下页面。它们从本包占据的 slot 进入渲染这些 slot 的外壳。

- [ui-sidebar](../ui-sidebar/README.zh.md)——声明 `sidebar.brand.mark` 与 `sidebar.brand.name` 并渲染其回退。
- [ui-conversation](../ui-conversation/README.zh.md)——在首屏声明 `conversation.hero.brand.mark`。
- [Web 客户端架构](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.zh.md)——浏览器插件行如何加载并注册 slot。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只贡献浏览器呈现；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了品牌呈现的供给方式。它们是当前包约束，不是品牌设计对比或任务积压。

- **只有一组填充**——替代呈现属于占据相同 slot 的另一个 Cordis 包。
- **浏览器标题独立**——`DSH_CLIENT_TITLE` 在构建时选择标题文本，而非通过 UI slot。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

**运行时不变式：** 不发布伴生入口。本包不保留可变状态；填充随其声明 slot 与插件生命周期安装和释放。
