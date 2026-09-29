---
description: "本机主人知识库：工作区访问、人工审核与真实 Session 工具。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-memory

[English](README.md) | 中文

## 概述

本服务管理当前操作系统用户和 `DSH_HOME` 数据目录的本机知识。它不是云账号私库：登录、退出或切换云账号不会转移或清空资料。本机主人资料可供本机授权智能体使用；工作区资料绑定稳定的登记 id。[记忆页面](../../client/ui-qianshou-memory/README.zh.md) 通过已鉴权的 `qianshouMemory` Remote 管理资料。主人操作不依赖账号插件、凭据或模型请求。

## 目录

- [归属与使用](#ownership-and-use)
- [审核、范围与保留](#review-scope-and-retention)
- [开发备注](#dev-note)
- [Model Experience](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="ownership-and-use"></a>
## 归属与使用

新格式默认路径为 `$DSH_HOME/qianshou/device-memory/v1.sqlite`，未设置 home 时使用 `~/.deepseek-harness`。`path` 可为隔离部署指定位置。本服务不会发现或导入旧 `qianshou/memory.sqlite`。第一版格式使用独立 application id 和随机库 id；未知格式在修改结构前拒绝。新文件与目录采用 POSIX 主人专属权限；这不是加密或操作系统沙箱。

`capacityBytes` 默认 134217728，限制保留标题、原文、来源、证据与序列化历史快照的字节数，不等于 SQLite 文件大小上限。`expiryIntervalMs` 默认 60000。单文档上限 512 KiB；临时资料保留 1–90 天，默认七天。读取前清理过期记录。重新打开同一个新格式数据库会恢复原有记录和库标识。

<a id="review-scope-and-retention"></a>
## 审核、范围与保留

主人保存即为已确认记录。编辑、接受和删除必须携带当前修订号；过时操作不会覆盖较新记录。智能体提议是工作区经验候选，带证据及真实 Session/工具调用来源。候选在接受前只读，不进入智能体检索、读取或计数。同一 Session/调用身份重复提交返回已有候选；删除或拒绝后同一调用不能使其复活。

每次智能体访问都会规范化实际 Session cwd，并匹配当前工作区登记。工具参数不能选择其他工作区。cwd 未登记或已不存在时，只能读取已确认的本机资料；提议必须具有已登记工作区。删除登记保留主人可见记录；相同路径以新 id 重新登记，不继承旧 id 资料。

变更、历史、FTS 索引和无正文回执在同一事务提交。删除、拒绝和过期清理会移除原文、历史和索引片段。回执仅保留 id、操作者、动作与修订号，不保留文档文字。Session 工具结果、导出文件和外部备份不变；SQLite 安全删除与 checkpoint 不承诺 SSD 或备份的法证擦除。

主人详情包含当前原文与最多两个历史版本。更多历史每页最多两个，要求当前修订未变。导出每页最多两个原文/历史记录或 100 条回执，所有页面绑定同一个库修订号；途中变更或到期清理会拒绝后续页。客户端完整文件导出上限由其所属 [UI 包](../../client/ui-qianshou-memory/README.zh.md) 说明。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护工作背景——点击展开</summary>

本地持久化与受控夹具不能证明所有者服务已部署；生产身份与检索验收需分别记录。

</details>

<a id="model-experience"></a>
## Model Experience

### 已确认资料检索与经验提议

#### 模型可见内容

可选 `./tools` 消费者在选定智能体预设中注册 `memory_search`、`memory_read` 和 `memory_propose`。搜索采用本机 Unicode 分词和 FTS5 关键词匹配，最多返回八条原文片段，不声称语义召回或事实验证。读取最多返回 3000 个 Unicode 码点及下一页偏移。工具 JSON 上限 32 KiB。提议上限 16000 UTF-8 字节，必须人工审核；工具不能写本机公共范围，不能批准、编辑或删除记录。文档是不可信参考资料。工具要求模型不保存凭据、隐藏推理或整段聊天；这不是自动秘密检测保证。实际工具结果沿用现有 Tool runtime 与 Session 日志，因此检索片段可能交给该 Session 选定的模型服务。本库自身不发起云同步或 embedding 请求。

#### Token 影响

工具描述与检索片段消耗普通工具上下文 token。本库不把全量资料注入隐藏系统提示词。通过主人界面保存和审核不消耗模型 token。

#### KV Cache 影响

检索增加普通日志中的工具调用和结果，不改写已有消息，也不替换 Session 提示词前缀。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 范围检查保护这些 API；具有完全授权的 Shell 仍能访问操作系统用户可读文件。Windows 权限、完整备份恢复、云账号资料库、向量 embedding、自动旧库迁移和自动事实学习不在本包内。主人导出是当前格式的备份，不代表已经实现恢复协议。

测试使用新建临时 SQLite 文件和真实 Loader、登记、AgentLoop 与 Session 装配。只有外部模型被确定性替代；这些检查不等于真实云模型自主检索验收。服务同步拥有事务与索引关系，因此不发布独立运行时 invariant 伴随插件。归属理由见[本机库决策](../../../.agents/notes/implemented/architecture/2026-09-21-qianshou-device-memory.zh.md)。
