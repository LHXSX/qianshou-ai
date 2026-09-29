---
description: "连接已有 SSH 和 GitHub 账户，通过明确的员工预设授权提供有界只读访问。"
kind: "package-reference"
---

# 连接中心

[English](README.md) | 中文

## 概述

保存公共 GitHub 账户或 SSH 目标，通过真实读取测试连接，再授权指定员工预设访问。GitHub 默认使用本机 `gh` 账户，也可使用 Host 解析的凭据引用。SSH 使用本机 OpenSSH 代理或指定的绝对密钥路径，并要求主机密钥已经受信任。仅保存设置不代表连接成功。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

将 `@deepseek-ai/dsh-host-connections` 与 Connection、Subprocess、Credentials、Agents、AgentPresets 一起挂载。仅在允许使用外部连接的预设中挂载 `@deepseek-ai/dsh-host-connections/tools`。每条连接还必须明确填写 `allowedPresets`；空授权列表不允许任何模型调用者访问。浏览器操作使用现有 Connection 认证路由。

配置字段包括 `statePath`、`sshCommand`、`ghCommand`、`timeoutMs`、`outputBytes`、`graceMs`、`maxConcurrent`。默认使用 `$DSH_HOME/qianshou/connections.json`、本机 `ssh`/`gh`、15 秒期限、256 KiB 输出、一秒终止宽限和四个并发读取。令牌值通过现有 Credentials 界面或 RPC 保存；连接记录只保存引用。

`GET /api/qianshou/connections` 返回公开视图和能力限制。`save`、`delete`、`probe` POST 路由接收草稿或 `{id}`。`github-repos` GET 路由接收 `id` 和从 1 开始的 `page`。探测结果包含 `ok`、时间、实际认证方式，以及身份/详情或稳定错误码。仓库分页包含公开元数据和可选 `nextPage`。没有任意命令端点。

SSH 测试启用 BatchMode 和 StrictHostKeyChecking，运行固定的 `uname -s && pwd && id -un` 命令。未知主机密钥、不可用凭据和无法访问的服务器都会明确失败；连接器不会自动接受指纹或索要密码。GitHub 读取公共 github.com 上的 `user` 和分页 `user/repos`。这些操作不会创建议题、克隆仓库、发布代码或部署变更。

<a id="understand-the-implementation"></a>
## 理解实现

[registry.ts](src/registry.ts) 拥有经过验证的非敏感元数据和活动操作。保存或删除连接会取消并等待在途读取结束，同时使旧探测证据失效。凭据引用变更会使匹配的探测失效。每次模型读取都会在异步工作前后验证准确的活动 Agent 及其实际组合预设。预设变化或连接被撤销后，不会返回迟到的成功结果。

[providers.ts](src/providers.ts) 执行 GitHub HTTP/CLI 与 OpenSSH 读取。[process.ts](src/process.ts) 使用现有 Subprocess 提供方完成环境清理、有界输出收集、取消和进程树退出。[routes.ts](src/routes.ts) 提供经过认证的用户操作；[tools.ts](src/tools.ts) 通过正常 `tools/pre-execute` 策略注册只读工具。原始 stderr 和秘密值不会进入公开错误载荷。

本包不提供 `./invariant` 附属入口：一个注册表拥有元数据版本、授权和在途读取；测试通过公开方法验证异步关系，不另设独立运行时投影。

<a id="further-exploration"></a>
## 进一步探索

- [凭据](../../credentials/credentials/README.zh.md) — 秘密引用和存储提供方。
- [子进程](../../subprocess/subprocess/README.zh.md) — 进程所有权和有界输出。
- [智能体预设](../../preset/agent-presets/README.zh.md) — 实际活动组合和员工授权。
- [工具](../../../docs/subsystems/tools.zh.md) — 策略和持久化工具调用记录。

<a id="model-experience"></a>
## 模型体验

### 外部连接读取

#### 模型看到什么

启用的预设获得四个固定工具：`connection_list`、`connection_probe`、`connection_github_repositories` 和 `connection_ssh_inspect`。结果包含真实公开元数据或稳定错误。秘密字面值、连接编辑和任意 SSH 命令不属于模型能力。标准 Tool 执行在 Session 日志中保留调用参数和结果，并应用现有权限策略。

#### Token 影响

四个 schema 为启用的预设增加请求上下文。连接列表和明确请求的仓库分页增加有界工具结果内容；只请求需要的分页。

#### KV Cache 影响

连接变化时工具定义保持固定。连接身份和探测结果进入工具结果，不改变 schema 前缀。启用或停用工具插件会改变可见 schema 集合。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 每个注册表文件由一个 Host 进程拥有；不支持外部编辑或多个活动 Host 共享该文件。探测是进程内证据，重启后不恢复。未实现 GitHub Enterprise 和交互式 OAuth/设备登录。SSH 支持已有代理/密钥认证和可信 known_hosts，不支持密码提示或交互式主机密钥登记。任意 SSH 执行及所有远程写操作都不属于此只读连接器，需要独立的经过批准的执行路径。模型 API 连接仍使用模型设置页面。本地测试夹具不能证明能够访问用户的真实服务器或 GitHub 账户。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作备注</summary>

无。

</details>
