---
description: "将手机命令绑定原 PC 会话，区分本地保存和经过验证的 PC 回执。"
kind: "package-library"
---

# 千手手机到 PC 的命令窗口

[English](README.md) | 中文

## 概述

本库为指定账号、PC 和原会话保留手机命令。它区分尚未送达的本地输入、接收情况不确定的命令和经过验证的 PC 回执。它不把手机变成算力节点，不把 PC 会话复制成独立历史，也不自行连接账号或网关。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [验证](#verification)
- [继续阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>

## 使用本包

嵌入此库的 PC 窗口应用向 `PcWindowController` 提供已认证的适配器、时钟、稳定的请求标识和持久存储。`IndexedDbWindowJournalStore` 实现浏览器持久化；存储失败会报告，不会悄悄退回内存。本包属于库依赖，不是可安装的配置档、手机后台工作节点或移动应用。

接收输入前，绑定当前账号、目标 PC、原会话和来源设备。适配器不可用或没有授权时，不展示本地会话投影。已经授权的离线输入保存为 `queued`，表示**尚未送达**，可在发送前撤回。`enqueue` 在本地持久化后返回，不等待任何 PC 任务完成。快照向嵌入界面提供错误和送达状态，由界面负责本地化文案。

`flush` 独立尝试各个待送达命令。`refresh` 重新核查账号访问权限，从保存的游标读取真实回执，只重试明确确认未接收的命令。传输失败后，接收情况不确定的命令不会被静默重发或显示成已取消。`disconnect` 隐藏当前数据并中止本地请求，不取消 PC 任务。`forget` 删除绑定来源的本地记录；原 PC 历史和任务仍由 PC 管理。

<a id="understand-the-implementation"></a>

## 理解实现

<details>
<summary>实现细节 — 点击展开</summary>

记录存储用户命令回显、回执观察和回执游标，不保存模型密钥、余额或替代会话日志。IndexedDB 键包含账号、目标 PC、原会话和来源设备。比较并保存的修订号用于拒绝多个浏览器窗口的竞争写入。重连会先等待已有本地提交结束再读取记录；恢复的 `delivering` 记录转为 `uncertain`，因为 PC 可能已经接收了它。

命令保留明确的有效期和请求标识。独立输入对应已有 PC `SessionParallelRequest`；追加说明和取消携带明确目标及预期修订。已认证的适配器必须核查设备归属、支持的动作、有效期、当前目标修订和接收去重，然后才能调用 PC 方法。本库不会把取消命令直接映射为 `ISession.cancel`，因为当前签名没有修订前置条件。伴随客户端的文件和终端协议不能证明手机会话网关已经建立。

回执解析在更新状态前核对完整来源、命令标识和修订。独立派发被接收时必须返回子会话。旧观察不会覆盖新观察；更新的回执不能改变已接收的子会话或逆转终态送达决定。取消命令被接收不等于确认已取消。`received` 永远不表示任务完成、成果验收或资金结算。适配器接通后，PC 结果仍通过原 Session 的已有历史和跟随流读取。

</details>

<a id="verification"></a>

## 验证

运行 `node node_modules/vitest/vitest.mjs run --config packages/client/pc-window-bridge/tests/vitest.config.ts` 执行使用测试夹具的送达及边界测试，覆盖独立命令、接收不确定、过期、来源与游标不匹配、修订顺序、不支持的取消和持久化失败。测试适配器既不登录账号，也不执行真实 PC 任务。

运行 `node packages/client/pc-window-bridge/tests/browser/verify.mjs` 检查真实 Chrome IndexedDB 的页面重载、命名空间隔离、竞争写入拒绝和明确删除。脚本写入 `.artifacts/mobile-pc-window-browser/evidence.json`，将网关响应标明为测试夹具，并删除测试数据库。它不能证明真实手机、真实账号或已安装应用可用。

<a id="further-exploration"></a>

## 继续阅读

- [控制器合同](src/controller.ts)：生命周期和可观察的送达状态。
- [PC Session 类型](../../api/session-controller/src/types.ts)：已有独立接收标识。
- [PC Session 使用方](../../api/session-controller/src/client/contract/session.ts)：已有会话操作。
- [实现决策](../../../.agents/notes/implemented/feature/2026-09-15-qianshou-pc-window-outbox.zh.md)：回执及持久化边界的原因。

<a id="model-experience"></a>

## 模型体验

### 本地命令送达

#### 模型可见内容

`PcWindowController` 不发起模型请求，也不追加 Session 事件。经过验证的 PC 适配器负责将已接收用户内容送入已有会话记录入口。

#### Token 影响

本地记录写入和回执核对不调用模型，也不复制会话。

#### KV Cache 影响

不增加提示前缀，也不改变模型缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 尚未安装生产同账号 PC 网关或回执适配器。内部端口类型不指定线上地址。嵌入应用必须提供已认证的适配器，类型声明不能证明已获授权。
- 本包没有实现登录、设备注册、后台送达、推送、语音、移动界面、任务结果文件、订阅、支付或可安装的手机 App，也不注册手机贡献、能力心跳或无人值守接单。
- 本地记录最多保留 500 个命令，由调用方明确选择有效期，不暗示重试次数、额度、价格、分润或保留政策。用户文本保存在本地；切换账号会隐藏该投影，明确调用忘记操作才会删除对应来源的存储。
- 回执游标只恢复命令观察。同账号读取完整原 PC 会话及真实双端控制仍属于独立集成验收。已有 PC 语音、数字人、团队、记忆和设备功能不在本包修改范围内。

<a id="dev-note"></a>

### 开发备注

源码属于保留 0.2.1 集成时的独立 taskcards 输入。根依赖图和真实适配器装配由主集成人负责。对应的 Host 项目引用是 `session-controller/tsconfig.host.json`；聚合配置没有开启 composite，不能作为直接引用。模块检查不能证明生产网关或移动端通过验收。
