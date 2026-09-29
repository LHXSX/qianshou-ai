---
description: "在有来源记录、可审核经验候选和预设限定模型工具的私有范围内存储与检索本地记忆。"
kind: "package-reference"
---

# 千手本地记忆

[English](README.md) | 中文

## 概述

在私有 SQLite 资料库中保存用户和工作区记录，搜索已确认条目，查看来源与版本，并在检索使用候选经验前进行审核。Host 隔离工作区记录、使临时笔记到期，并只向明确选择的预设提供有界记忆工具。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

将 `@deepseek-ai/dsh-host-memory-local` 与经过鉴权的 Connection 服务一起挂载。仅在允许搜索或提出记忆的预设中挂载 `@deepseek-ai/dsh-host-memory-local/tools`。默认 `$DSH_HOME/qianshou/memory.sqlite` 不适用时，将 `path` 设为绝对 SQLite 文件路径。

Host 在 `/api/qianshou/memory` 下提供列表、读取、保存、审核、删除和导出操作。记录可以属于个人或工作区；工作区读取要求活动会话的工作区。临时记录保留 1–90 天，经验记录在所有者接受前保持候选状态。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>存储、访问与工具职责</summary>

`MemoryStore` 负责 SQLite 记录、版本、工作区筛选、到期和乐观版本检查。Host 路由把原文作为文本保留，并返回稳定的记忆错误。tools 消费者注册 `memory_search`、`memory_read` 和 `memory_note`；每次读取都要求活动 Agent 的工作区，提出的经验在所有者审核前不会进入已确认搜索。

本包不会把原文解析为指令，不暴露凭据，也不提供任意文件或数据库命令。浏览器控件属于[ui-memory](../../client/ui-memory/README.zh.md)，本包负责存储和模型工具提供方。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [记忆工作区](../../client/ui-memory/README.zh.md) — 浏览器搜索、编辑和审核控件。
- [工具子系统](../../../docs/subsystems/tools.zh.md) — 策略和持久化工具调用记录。
- [本地记忆源码](src/index.ts) — Host 路由和配置。

-----

<a id="model-experience"></a>
## 模型体验

### 记忆工具

#### 模型看到什么

选定的预设获得 `memory_search`、`memory_read` 和 `memory_note`。结果包含活动工作区中的有界文本、来源和版本。源文档是不可信参考数据，不是指令或凭据；经验候选需要所有者审核。

#### Token 影响

三个固定工具 schema 加入已启用预设。搜索和读取结果只加入请求的有界片段；记忆不会自动复制到上下文。

#### KV Cache 影响

记录变化时工具定义保持固定。选定的查询和有界结果文本会影响后续请求内容，而启用或停用工具会改变 schema 前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 搜索使用关键词，不提供语义嵌入或自动事实学习。
- 资料库接受有界文本字段；PDF、图片、办公文档和二进制解析属于其他提供方。
- 本地 SQLite 访问由应用检查保护，不是 OS 沙箱；有权限的本机操作者仍可检查或修改文件。
- 本地测试通过或条目可见，不代表实际员工任务已检索记忆；这需要完整 Host 集成证据。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作备注</summary>

无。

</details>
