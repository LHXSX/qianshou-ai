---
description: "千手账号服务的共享客户端：注册、登录、2FA、令牌刷新、会话、订阅与微信登录。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-account

[English](README.md) | 中文

## 概述

千手账号服务在浏览器与手机两端的共享客户端。它负责注册、登录、TOTP/2FA 校验、令牌刷新、会话与订阅读取、推广快照以及微信 OAuth 跳转，并把每个响应规整为类型化记录。凭据始终放在调用方注入的 `TokenStore` 后面：access token 默认只存内存，refresh token 的落盘位置由嵌入方决定。本包不含界面、不含服务端，也没有模型面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

用 `createAccountClient` 构造 `AccountClient`，传入服务地址、`fetch` 实现和 `TokenStore`。注册、登录、2FA 校验、刷新、会话与订阅都由这个客户端发起；凭证只通过 store 的 `readAccess()` 与 `readRefresh()` 读取，不要从响应对象里取。需要相同传输超时与日志脱敏规则的调用方可以直接复用导出的 `sendRequest` 与 `redactForLog`。

`sendSms` 明确区分 `register` 和 `login` 用途，只在服务端确认发送后返回脱敏手机号与重发间隔。`loginPhone` 与密码登录一样返回令牌或 TOTP 挑战；`registerPhone` 只保存服务端真实返回的令牌。宿主必须核验 `/auth/me` 后再显示已登录身份。

<a id="understand-the-implementation"></a>
## 理解实现

`http.ts` 负责超时、请求头与脱敏规则；`endpoints.ts` 是路由表；`normalize.ts` 把响应转成 `types.ts` 里的类型化记录；`failures.ts` 区分传输失败与服务失败。`tokens.ts` 与 `session.ts` 默认把 access token 只放内存，把 refresh token 放在注入端口后面——长期凭据落在哪里是安全决策，不是实现细节。`wechat-login.ts` 只准备并校验 OAuth 跳转的浏览器这一段。

<a id="model-experience"></a>
## 模型体验

### 账号凭据客户端

#### 模型看到的内容

什么都看不到：本包是浏览器与手机界面背后的凭据与账号数据客户端，`createAccountClient` 不注册任何模型工具、提示词区段或会话事件。它返回的账号记录由调用方渲染，不会经由本包进入对话。

#### Token 影响

不影响 token。本包没有任何请求组装路径会产生模型输入。

#### KV Cache 影响

不影响 KV cache。本包既不组装也不发送提供方模型请求，因此没有缓存前缀依赖它。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 凭据落盘由嵌入方决定，不由本包决定：access token 默认只存内存，refresh token 放在调用方注入的端口后面，所以长期凭据落在哪里必须由提供该端口的一方写清楚。
- 授权仍在千手账号服务侧。本客户端不做镜像，客户端自己的校验不能授予档位、角色或权益。
- 微信适配器只覆盖浏览器这一段。AppSecret、code 换 token 与账号绑定仍属服务端工作；公共配置缺失时报明确的不可用状态，绝不伪造登录成功。
- 本包不含界面、路由或存储实现；每个嵌入界面自己负责展示与错误文案。

<a id="dev-note"></a>
### 开发备注

把传输、脱敏与规整规则留在本包，不要复制到各个界面。绝不把 access token 或 refresh token 的值写进日志、塞进错误对象或渲染到诊断文本里。账号服务新增响应形状时，在 `types.ts` 增加类型化记录并在旁边配规整函数，而不是静默放宽已有记录。
