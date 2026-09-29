---
description: "在设备工作区配对协作电脑、分配需对端确认的任务，并查看真实远程结果。"
kind: "package-reference"
---

# 千手设备工作区

[English](README.md) | 中文

## 概述

打开**设备**，可以配对协作端、选择已授权目录、提交命令或文件任务，并查看实际结果。每个任务均等待协作端确认。桌面任务请求启动 RustDesk；主控原生窗口可以打开返回的设备 ID。此页面不虚构设备或任务进度。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

千手 web 组合通过常规客户端 bundle 挂载本包。打开**设备**生成配对码，然后在协作端输入。提交任务前选择在线设备及其授权目录。取消操作会等待协作端确认；撤销配对会断开该设备。

可选中转区在支持中转的桌面主控内可用，通过原生文件对话框导入专属注册信息，显示 FRPC 实际连接状态，只复制公开主控地址。邀请草稿仅在明确选择后使用该地址，生成配对码仍是单独操作。浏览器和旧外壳显示升级提示。启用、关闭、隐私与验证范围见[桌面中转指南](../../../apps/qianshou-desktop/relay/README.zh.md)。

### 下载与接收方指引

接入区域始终提供协作端官网下载入口，同时列出当前主控已校验的真实归档，包含版本、大小、SHA-256 及验收状态。本机归档链接保留浏览器认证，由主控方下载并单独转交文件。官网是公开链接，其平台可用性、签名与验证范围由官网下载页展示。

填写非回环 HTTPS 主控 origin 并生成新配对码后，可点击「复制完整接入说明」。存在本机归档时，邀请保留文件名、校验值和私有转交说明；否则使用公开官网下载页。两种说明都包含平台启动步骤、地址、配对码及有效期、工作区选择和本地确认要求，不含浏览器登录凭据。地址校验只验证格式，跨机连通性仍需验证。剪贴板失败会显示，复制时重新检查配对码是否有效。文件、命令与桌面操作继续遵守既有确认语义。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[控制器](src/client/controller.ts)在视图挂载期间轮询已认证协调器。它串行执行变更，卸载时取消请求，并拒绝过期响应。[页面](src/client/DevicesPage.tsx)管理选择和草稿；协调器管理设备及任务状态。[控制器测试](tests/controller.client.spec.ts)覆盖认证、错误、重复变更防护和卸载竞态。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [远程协调器](../../host/remote-devices/README.zh.md)：任务归属与认证。
- [远程协作](../../../docs/qianshou-remote-devices.zh.md)：配对与部署边界。
- [协作端](../../../apps/qianshou-companion/README.zh.md)：本地确认与执行。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包提供人类使用的设备控制界面，不添加提示词或工具；面向模型的远程任务工具属于协调器的独立工具入口。

#### KV Cache 影响

不直接影响 token 或 KV 缓存；本包既不组装也不发送模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- Shell 工作目录不是操作系统沙箱。文件边界由协作端执行。
- 桌面控制需要实际目标电脑安装 RustDesk 并完成系统授权。启动器返回成功不能单独证明远程连接成功。
- 设备信息和任务历史由单一协调器提供。本包不导出独立运行时 invariant 入口；生命周期和并发检查位于控制器测试中。

<a id="dev-note"></a>
### 开发备注

无。
