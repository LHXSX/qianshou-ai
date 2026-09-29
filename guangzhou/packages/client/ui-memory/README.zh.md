---
description: "管理本机记忆、查看知识原文，并明确确认候选经验。"
kind: "package-reference"
---

# 千手记忆工作区

[English](README.md) | 中文

## 概述

打开**记忆与知识**，可以搜索已确认记录、查看原文及版本，并管理临时记忆、长期记忆、知识资料与经验。导入内容保留为文本。候选经验有独立审核视图，明确确认后才会进入常规检索。删除需要确认，因为 Host 会同时移除原文与全部版本。

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

侧栏入口打开经过鉴权的 Host 目录。可以按关键词搜索，也可以按层级、已确认/候选状态或工作区绝对路径筛选。目录每页显示 50 条。层级数量表示当前账号未过期的记录数，结果数量则遵循所选筛选条件。

新建记录，或导入不超过 512 KiB 的受支持 UTF-8 文本、Markdown、代码与 JSON 文件。导入会把完整解码文本及来源文件名填入本地草稿，保存后才持久化。标题最多 160 字，来源最多 2000 字，证据最多 4000 字。临时记录保留 1–90 天，默认七天。个人记录属于此本机账号，工作区记录必须指定绝对路径。编辑临时记录后，会从保存时间重新应用界面显示的保留天数。

选择条目后可查看原文、证据、来源、时间与保留的完整历史版本。候选经验在用户确认前只读；不采纳会移除候选及其历史。编辑、审核和删除都携带用户读到的 revision。发生冲突时保留编辑草稿并显示 Host 错误，重新打开条目可读取最新版本。JSON 导出下载 Host 的记录、版本和操作凭据，用于备份。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

浏览器在主面板与侧栏 slot 注册 `qianshou-memory`。控制器通过同源鉴权请求访问 Host 记忆接口，将修改串行化，忽略已被替代的列表与详情响应，并在插件卸载时中止未完成请求。页面在本地保留未保存草稿，丢弃前询问用户。文件导入严格按 UTF-8 解码，保留 BOM 和换行，不会解析或执行文本。React 文本和文本框显示原文，不把它当作 HTML。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [本机记忆 Host](../../host/memory-local/README.zh.md)：存储、访问边界、到期规则与模型工具。
- [控制器测试](tests/controller.client.spec.ts)：鉴权、带版本操作及过期响应。
- [导入测试](tests/import-text.client.spec.ts)：原文保留与不支持文件拒绝。

-----

<a id="model-experience"></a>
## 模型体验

### 浏览器控件

#### 模型看到什么

本浏览器包只注册面向用户的控件；模型记忆检索与候选提交工具由 `Host` 负责，包括 `memory_search` 和 `memory_read`。页面不会向模型发送提示词、工具 schema 或记忆内容。

#### Token 影响

页面不组装模型请求，因此没有直接的 token 影响。

#### KV Cache 影响

页面不组装或发送模型请求，因此没有直接的 KV cache 影响。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 搜索使用 Host 关键词索引，界面不宣称具备向量语义搜索或自动事实学习。
- 导入仅支持指定的 UTF-8 文本文件，不解析 PDF、图片、办公文档和二进制编码。
- 导出生成 JSON 备份，本包不负责恢复完整资料库。普通 JSON 文件导入会把文件存为原文。
- 条目可见或组件测试通过，不代表实际员工任务已经检索过记忆；这需要完整 Host 集成证据。

<a id="dev-note"></a>
### 开发备注

本包不发布独立 runtime invariant 入口。请求生命周期和过期响应归属由控制器测试验证；持久化与访问不变量由 Host 负责。
