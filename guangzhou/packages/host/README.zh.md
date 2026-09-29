---
description: "Web GUI Host 侧的包映射：HTTP 与 SPA 服务器、工作区目录选择实现、open-in-app 启动路由和插件清单投影。"
kind: "package-group"
---

# host/ — Web GUI 宿主侧

[English](README.md) | 中文

## 概述

`host/` 组提供 Web GUI 服务、本地应用与目录选择器入口、插件清单、已配对远程设备协调，以及简短录音的本地转写。浏览器传输位于 [`client/`](../client/README.zh.md)；组合后的 [`apps/cli`](../../apps/cli/README.zh.md) 在 Web 客户端旁加载 Host 能力。各包 README 定义自己的配置与限制。目录选择器后端通过同一接口彼此替换。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

各包 README 负责自身的 Host 约定与配置。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`webserver/`](webserver/README.zh.md) | 浏览器 HTTP 服务器：具名路由、upgrade、index 转换与回退席位 | `ctx.webServer` |
| [`frontend-static/`](frontend-static/README.zh.md) | 占据 webserver 回退席位的 SPA dist 服务器 | 消费 `ctx.webServer` |
| [`directory-picker/`](directory-picker/README.zh.md) | 工作区目录选择 seam：能力约定与错误词汇 | `ctx.directoryPicker` |
| [`directory-picker-native/`](directory-picker-native/README.zh.md) | 面向宿主屏幕前操作者的原生 OS 选择器后端 | 注册 `ctx.directoryPicker` |
| [`directory-picker-browse/`](directory-picker-browse/README.zh.md) | 应用内目录浏览器后端，也服务于远程客户端 | 注册 `ctx.directoryPicker` |
| [`directory-picker-auto/`](directory-picker-auto/README.zh.md) | 在启动时挂载匹配后端的宿主自适应选择器 | 挂载一个后端 |
| [`open-in-app/`](open-in-app/README.zh.md) | 在已安装应用中打开 workspace 目录的应用探测、图标与启动路由 | 消费 `ctx.webServer` |
| [`plugin-inventory/`](plugin-inventory/README.zh.md) | 当前 Loader 条目的只读投影 | Remote `pluginInventory/list` |
| [`remote-devices/`](remote-devices/README.zh.md) | 已配对设备协调与需对端批准的远程任务回执 | `ctx.remoteDevices` |
| [`connections/`](connections/README.zh.md) | 只读 SSH/GitHub 连接、真实探测和明确的员工授权 | `ctx.connections` |
| [`compute-core/`](compute-core/README.zh.md) | 鉴权算力查询、任务准入、本地执行和插件信任规划 | `ctx.computeCore` |
| [`compute-api/`](compute-api/README.zh.md) | 有证据范围的 edge-compute v8 HTTP 控制面只读适配器 | 由算力插件消费 |
| [`plugin-lifecycle/`](plugin-lifecycle/README.zh.md) | 已验证能力插件的事务暂存、激活、停用、回滚和移除 | 部署生命周期 API |
| [`platform-foundation/`](platform-foundation/README.zh.md) | 共用智能体、节点和设备身份、能力心跳及有界事件记录 | 进程内目录 API |
| [`node-contributor/`](node-contributor/README.zh.md) | 本机能力脱敏贡献、自主准入、租约绑定及待处理收益引用 | 提供方无关控制器 |
| [`platform-observability-contract/`](platform-observability-contract/README.zh.md) | 跨平台移动能力同步与有界可观测记录 | 元数据合同 |
| [`voice-local/`](voice-local/README.zh.md) | 有界的本地中文音频转文字请求 | 消费 `ctx.connection` |

-----

<a id="related-documentation"></a>
## 相关文档

先从传输与工作区记录的子系统参考读起，再看 Web Client 背后的分层决策。

- [HTTP 服务器子系统](../../docs/subsystems/web-server.zh.md)——webserver 的路由、匹配顺序与配置。
- [工作区子系统](../../docs/subsystems/workspace.zh.md)——目录选择器所喂给的工作区记录。
- [远程设备子系统](../../docs/subsystems/remote-devices.zh.md) — 配对身份与有限任务协调。
- [Web 配置树启动与传输分层](../../.agents/notes/implemented/architecture/2026-07-24-web-config-tree-boot-and-transport-layering.zh.md)——Web 传输各层的所有权。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
