---
description: "千手本机资料页面：主人明确审核与有界导出。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qianshou-memory

[English](README.md) | 中文

## 概述

千手构建在侧栏增加“记忆与知识”，打开独立主区域页面。其他构建不注册界面。页面明确说明资料属于当前本机数据目录，不属于登录的云账号；切换云账号不会迁移或删除资料。[Host 包](../../host/qianshou-memory/README.zh.md) 负责存储、范围校验和保留。

## 目录

- [使用](#use)
- [请求与导出生命周期](#request-and-export-lifetime)
- [开发备注](#dev-note)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use"></a>
## 使用

选择资料范围、按关键词检索或新建资料。保存会提交草稿；选择 UTF-8 文本文件只导入未保存草稿。文件导入接受支持的文本扩展名，最多 512 KiB，拒绝无效 UTF-8 与 NUL 字节，不扫描目录、不打开旧数据库。迟到的文件读取不会覆盖较新的编辑或选择。

智能体候选在明确接受前只读。拒绝与删除须通过说明实际删除范围的确认。原文和历史按纯文本呈现；详情最多包含两个历史原文，“读取更早版本”请求下一有界页面。修订冲突保留主人草稿，并提供明确放弃草稿的重新读取操作。

<a id="request-and-export-lifetime"></a>
## 请求与导出生命周期

controller 分别管理列表、详情、变更和页面响应归属。改变范围或选择会丢弃过时读取；关闭页面使未完成读取与导出失效；重连保留草稿但丢弃先前传输结果。已提交的 Host 变更不会因关闭页面而被宣称回滚。

导出先收齐修订号一致的分页，再创建一个 `qianshou-device-memory.json` 下载。完整导出按序列化页面字节限制为 16 MiB。失败、途中变更、关闭页面或超限均不生成不完整文件。超限提示要求主人保留原库；本版不支持大库导出。原文、历史和回执采用 Host 格式，设计上不含云凭据。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护工作背景——点击展开</summary>

知识写入与导出结果由 Host 控制器拥有；界面缓存不能证明当前所有者或操作已经完成。

</details>

<a id="model-experience"></a>
## Model Experience

### 主人知识管理

#### 模型可见内容

`qianshouMemory` Remote 提供主人管理操作。页面不暴露模型工具，也不增加聊天消息。保存的已确认资料仅通过 Host 范围工具提供；接受候选是人工决定，不表示训练或自动事实核验。界面说明检索片段可能进入当前选定模型的工具上下文。

#### Token 影响

主人管理与导出不调用模型，也不消耗模型 token。

#### KV Cache 影响

界面操作不改变先前模型消息或提示词前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 页面不实现完整备份恢复、云同步、文档 OCR 或云账号私人 namespace。系统文件下载与真实 Host 装配必须在组件测试之外进行运行验收。本包不发布 invariant 伴随插件：它呈现 Host 快照，没有需要独立核对的持久业务状态。
