---
description: "千手中由设备主人明确授权的逐会话连接控件。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qianshou-session-connect

[English](README.md) | 中文

## 概述

千手构建在普通 Session（会话）顶部增加“会话连接”。其他 profile 无需该功能的 Remote 即可正常激活，且不注册界面；subagent 的子会话不显示入口。[Host](../../host/qianshou-session-connect/README.zh.md) 负责授权、存储、可达地址和命令投递。


## 目录

- [使用方法](#doc-section-1)
- [Model Experience](#doc-section-2)
- [Known Limitations and Deferred Work](#doc-section-3)
- [开发备注](#dev-note)

<a id="doc-section-1"></a>
## 使用方法

打开入口先看 Host 返回的地址范围：默认回环地址只在这台电脑可用；若已配置 HTTPS 地址，仍须在目标设备实际验证网络可达。默认直接点“创建仅查看私密链接”，Host 收到自动填写的备注、只读权限和 60 分钟有效期。备注、文字发送权限、有效期和可选设备标记收在“连接设置”中；选择文字发送时，界面明确说明接收方可按该会话现有权限发起工作。所有操作均不修改当前 provider、模型或权限模式。

创建成功后优先显示一次性完整链接和复制按钮，旧连接列表默认折叠但仍可展开撤销。关闭面板或切换 Session 会清除显示的链接，旧授权元数据不能还原秘密。创建期间关闭面板会丢弃迟到的界面响应，但不会撤销已授权的 Host 提交；重新打开可以检查并撤销新创建的授权。撤销操作限定所选 Session 和授权，随后清除显示链接并重新读取状态。错误采用固定的本地化文案，不展示任意远端诊断文字。

独立接收页由 Host 包拥有，不加载本主人界面或全局 Remote 依赖。接收方的文字和投递回执必须经过接收页的窄 API，不能使用这些主人操作。

<a id="doc-section-2"></a>
## Model Experience

### 主人的连接控件

#### What the model sees

`qianshouSessionConnect` 主人界面不注册模型工具或提示词。唯一与模型相关的选择，是允许另行授权的接收方通过 Host 发送普通文字。打开面板、创建或撤销授权都不发送用户消息。

#### Token effect

主人控件不消耗模型 token。已接收的对方消息使用所选会话的正常模型路由，具体由 Host 文档说明。

#### KV Cache effect

面板不修改对话历史或模型提示词前缀。

## Known Limitations and Deferred Work

<a id="doc-section-3"></a>

- 界面不提供云账号授权绑定、设备发现、手机中继、二维码登记或云副本控件。默认回环地址无法被其他设备访问。剪贴板是否可用取决于浏览器或桌面外壳；复制失败后链接仍可手动选择。除组件测试外，完整浏览器与 Host 装配必须在运行程序中验收。本组件只保存可丢弃的 Host 状态视图，因此不提供运行时 invariant companion。

<a id="dev-note"></a>
### 开发备注

无。
