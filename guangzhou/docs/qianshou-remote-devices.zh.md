# 千手智能体跨设备协作设计

[English](qianshou-remote-devices.md) | 中文

本文记录本项目 2026-09-13 的实现边界和后续跨设备部署路径。用户目标是 macOS 主控统一调度 Windows、macOS、Linux 设备，既能执行开发任务，也能查看屏幕和操作键鼠。当前代码交付包含主控设备协调器与独立千手协作端；外部设备、网络入口、桌面权限尚需在目标机器验收。

## 两条独立通道

开发任务使用协作端主动建立的 TLS WebSocket：千手智能体浏览器 → 已认证 Connection API → 设备协调器 → 对应协作端的本地审批 → 执行与回执。浏览器仍使用 Harness 原有会话认证，设备使用单独的一次性配对码和长期凭证；不复用浏览器 Cookie 作为设备身份。主控和协作端均可独立启动，同机联调允许 loopback 明文 WS，不同主机必须 WSS。

桌面采用已经安装的 RustDesk：协作端本地批准 `desktop` 任务 → 启动 RustDesk 并回传公开连接 ID → 主控启动自己的 RustDesk 连接该 ID → RustDesk 完成被控方确认、画面与键鼠传输。此阶段不在千手进程嵌入 RustDesk 源码，也不传输或设置 RustDesk 密码。RustDesk 自建服务器的 hbbs 负责 ID/连接协商，hbbr 提供中继；官方 Pro 的管理能力不应误称为 OSS 内置。依据 [官方自建指南](https://rustdesk.com/docs/en/self-host/)、[客户端说明](https://rustdesk.com/docs/en/client/) 和 [官方仓库许可证](https://github.com/rustdesk/rustdesk/blob/master/LICENCE)。

## 已实现的最小双端协议

公开 HTTP 接口与帧类型定义在 [remote-devices](../packages/host/remote-devices/README.zh.md)。主控在现有端口注册 `/qianshou-device`，拒绝浏览器 Origin，首帧五秒内认证。配对码五分钟有效、只使用一次，长期凭证随机产生，主控仅保存 SHA-256 摘要。协作端使用 Electron safeStorage 加密保存凭证，并拒绝 Linux 的 `basic_text` 明文后端。设备撤销立即阻止旧连接与旧凭证继续工作。

支持目录列表、读文件、写文件、命令和桌面请求，每个任务都需要协作端用户批准。授权目录只由本机文件选择器添加，控制端传来的目录 ID 必须对应已有授权。文件任务检查路径穿越、绝对路径和符号链接；命令只限定起始工作目录，依然具有本机用户权限，因此界面显示完整命令并明确说明当前没有 shell 沙箱。取消和断线终止本次子进程组，五分钟超时终止长命令。

状态采用稳定任务 ID、完整输出快照、确认回执和不可逆终态。重连重发未完成任务，但协作端按 ID 去重，不自动重复执行；协作端进程重启后把未结束任务标记为中断。连接内序号防止旧输出回退，替换连接不会让旧实例继续写结果。主控状态以原子文件持久化，凭证摘要和任务结果不通过设备列表泄露密钥。

## 为什么没有直接把现有 SDK 当作远端客户端

本仓库 [SDK Client](../packages/sdk/client/README.zh.md) 通过本机子进程上的 stdio JSON-RPC 管理 Harness 会话；其初始化、会话提示和关闭协议并不是网络设备注册、配对或租约协议。现有 Session Controller 有会话取消能力，而 SDK 的进程关闭语义不能当作任意共享会话的单任务取消。既有浏览器 Gateway 的 WebSocket 重连也不等于跨机器任务的持久去重。

下一阶段可以在每台协作端机器启动当地 Harness 运行时，把该机文件和 shell 放在同一能力边界内，再将规划任务提交给真实远端会话。必须同时接通会话归属、取消、持久回执和模型配置，不能让远端 shell 与主控本地文件工具指向不同机器后仍声称是同一工作区。当前五种有限任务是已实现接口，自动把总设计师的子智能体分配到远端会话仍属于后续集成。

## 跨平台和网络选择

首选先在私有覆盖网络或已认证 HTTPS 反向代理后测试单台目标设备。Tailscale 可提供设备间私网连通和默认拒绝的访问规则，但其 Tailscale SSH 服务端支持范围是 Linux 与特定 macOS CLI 形态，不能据此声称 Windows 已有同类服务端；Windows 开发任务可选官方 OpenSSH Server，或使用本项目协作端的主动连接。依据 [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)、[访问策略](https://tailscale.com/docs/reference/syntax/policy-file) 和 [Microsoft OpenSSH 安装文档](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)。

公网部署需要明确主控域名、有效 TLS 证书、设备配对流程、反向代理访问控制和审计保留策略；本次实现不会自动监听公网或调整端口转发。mTLS 设备证书、远程升级签名、策略化无人值守和命令沙箱均为未来增强，当前使用经过 TLS 保护的随机设备凭证，不能把它描述为已经实现 mTLS。

macOS 桌面控制需要系统屏幕录制和辅助功能授权；Linux Wayland 与登录屏幕存在环境限制，必须按目标设备实际桌面会话验收；Windows 还需实测登录态、UAC 与后台会话范围。依据 [RustDesk macOS 指南](https://rustdesk.com/docs/en/client/mac/) 和 [Linux 指南](https://rustdesk.com/docs/en/client/linux/)。应用本身不绕过这些权限。

如果后续必须把远程桌面直接嵌入浏览器，可评估 Apache Guacamole：它通过浏览器、Web 服务、guacd 到 RDP/VNC/SSH 的转换提供浏览器客户端，不能自动替代 NAT 后面的主动设备客户端；其 Apache-2.0 许可与 RustDesk AGPL-3.0 不同。依据 [Guacamole 架构](https://guacamole.apache.org/doc/gug/guacamole-architecture.html) 和 [官方许可证](https://github.com/apache/guacamole-server/blob/main/LICENSE)。当前避免自建 WebRTC 屏幕协议；完整方案还需要采集、输入授权、编解码、信令和 TURN，而不仅是一条视频连接。依据 [WebRTC TURN 指南](https://webrtc.org/getting-started/turn-server)。

## 验证分期

阶段一是当前本机交付：真实 WebSocket 双端配对、审批前不执行、限定文件操作、命令输出与取消、拒绝浏览器 Origin、一次性配对、撤销与断线去重，加上两个 Electron 应用的启动检查。这些测试只证明本机代码链路，不证明公网连接或另一台操作系统已完成安装。

阶段二在各选定设备验证安装与实际连接：用户明确目标设备和网络入口，目标机安装协作端并选择工作目录，完成 TLS 配对，执行带可核对输出的测试任务，检查取消与重连，然后安装或使用已有 RustDesk 并由目标用户授予权限，实测屏幕、键盘、鼠标和主动断开。保存应用版本、目标系统、连接方式和结果，不记录密码或私钥。

阶段三才扩展到远程 Harness 会话、真实子智能体调度、能力分组和可配置审批，再考虑 mTLS、OS 沙箱、应用签名与升级、Guacamole 嵌入。当前未提供的目标设备地址和系统权限属于外部验收依赖，不应描述为代码已自动完成的步骤。
