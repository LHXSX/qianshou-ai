---
description: "由 Host 预检单个本地 SKILL.md，并以不覆盖方式安装到千手用户技能目录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-skill-import

[English](README.md) | 中文

## 概述

`qianshouSkillImport` Remote 只接收单个 `SKILL.md` 的完整 UTF-8 文本。`inspect(content)` 使用与 [`skill-filesystem`](../../skill/skill-filesystem/README.zh.md) 相同的解析器校验文本、检查受控目标路径，并返回元数据、SHA-256 摘要和短期有效的预检 ID。`install(inspectionId)` 只能消费该 ID 一次，把预检的原文写到 `<installRoot>/<name>/SKILL.md`，不覆盖现有目录或平铺的 `<name>.md`。安装响应不确定时，`verify(name, sha256)` 只读取该受控路径，返回 `matched`、`different` 或 `missing`。


## 目录

- [安装和回执](#doc-section-1)
- [模型体验](#doc-section-2)
- [已知限制与延期工作](#doc-section-3)
- [开发备注](#dev-note)

<a id="doc-section-1"></a>
## 安装和回执

`installRoot` 默认是 `$DSH_HOME/skills` 或 `~/.dsh/skills`，与文件系统技能提供方的用户目录一致。Host 配置若非空，必须是绝对路径；客户端不能指定写入位置。Host 拒绝根目录路径上的符号链接与非目录，以独占方式创建技能目录，先写私有临时文件，再无覆盖地发布最终文件，最后重读字节和解析后的名称。预检十分钟后失效、只能使用一次，最多保留十六份；Host 定时清除过期内容，插件卸载时清空全部待安装内容。每份请求最多 256 KiB 有效 UTF-8 文本；名称最多 64 字符、描述最多 1024 字符，正文不能为空。

`written` 回执只证明指定文件在发布后与预检摘要相符。`verify` 只接受最多 64 字符的 kebab-case 名称及 64 位小写 SHA-256 摘要；遇到符号链接、内容变化或超限文件时返回 `different`，不会读取链接目标。文件系统发现异步监视路径，而且某个会话可能优先使用项目或其他提供方的同名技能。客户端必须单独调用 `remote.skills.list({sessionId})`，核对返回的路径，才能说该技能对当前会话可调用。本 Remote 不上传服务器、不发布市场条目、不安装插件包，也不接受 HTTPS、Git、ZIP 或本地路径 spec。

仅供 Host 调用的 `authoringContext(name?)` 返回当前服务配置的用户技能根、只读文件系统就绪观测、合法技能名称对应的精确保存位置，以及已有目录或平铺文件的冲突。它不创建目录、不授予写权限。技能助手现有的 `qianshou_skill_authoring_template` 工具把这些事实与内嵌通用模板一起返回，制作技能无需从源码猜 home 或 watcher 配置。会话发现仍需单独核对。

`listLocal()` 返回指令摘要及能否本机归档。`archiveLocal({source, name, path, sha256})` 只接受当前用户根目录清单中的技能，拒绝已变更的字节、路径链接、受管安装标记及当前选定的节点执行目录，再把完整目录或平铺技能文件移到用户技能根旁私有的 `.qianshou-skill-archives/<id>`。目录中的嵌套链接随目录整体移动，不读取其目标。`archiveList()` 核对有界回执、由配置根推导的原位置、指令摘要、frontmatter 名称及平台可用的 OS 所有权。`restoreLocal({source, archiveId, sha256})` 不接受目标路径，同时拒绝同名目录和平铺文件。恢复逐项排他创建，保留可执行位和链接目标、不跟随链接，最后写入 `SKILL.md`；失败只清理自身未变化的条目，归档仍保留，成功也保留备份并标记该条已恢复。本机归档和恢复不撤销投稿、不修改权益或接单授权、不安装运行包，也不清除会话历史。已有接单绑定仍由接单设置管理，文件回执本身不代表当前可接单。

<a id="native-skill-draft"></a>

仅供 Host 调用的 `installNativeSkillDraft` 接收 catalog 生成的五个文件及当前作者核验回调，不开放远端目标路径或任意文件内容。它排他创建元数据，最后让 `SKILL.md` 可见，核验实际原生源码，再重核作者、上下文与修订。失败只移除本事务创建且未变化的文件和目录；外部改动的字节保留。回执仅证明本机草稿，不是云端投稿、设备授权或运行包安装。

<a id="doc-section-2"></a>
## 模型体验

### Remote 导入

#### 模型看到什么

`qianshouSkillImport` Remote 不注册模型工具或提示词。文件系统提供方日后在某个会话发现该文件时，由该提供方及技能工具决定目录和正文如何进入模型上下文。

#### Token 影响

本包没有直接影响。后续会话发现可能按提供方规则增加技能目录文本。

#### KV Cache 影响

本包没有直接影响。后续目录变化可能按提供方规则替换模型上下文。

## 已知限制与延期工作

<a id="doc-section-3"></a>

- Remote 只接收单个指令文件，因此原 bundle 中相对路径引用的 `references`、`scripts` 和 `assets` 不会随之安装。完整 bundle 导入需要独立的归档校验与目录原子发布。本包不下载链接，也不克隆 Git。

- 写盘回执不会强制文件系统提供方刷新，也不证明某个会话选中了此技能。监视器观测后，仍需查询会话技能目录并核对路径；同名技能可能继续遮蔽它。

<a id="dev-note"></a>
### 开发备注

无。
