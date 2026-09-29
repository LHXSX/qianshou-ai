---
description: "按住语音转写到原会话，显式选择松开发送，并随时停止本地系统朗读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qianshou-voice

[English](README.md) | 中文

## 概述

按住麦克风控件录制一句话，松开后把识别文字加入原草稿。通过菜单显式选择后，可从空草稿进入普通消息队列。已完成回复支持使用真实枚举到的本地系统声音朗读，并可随时停止。识别依赖单独配置的本地 Host 引擎；界面动画不能证明设备或任务成功。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当前千手 profile 禁用此浏览器插件，因此不显示麦克风与朗读控件。启用时，它会在 Conversation、Chat、Session UI 和生成的 `qianshouVoice` Remote 旁装配。插件复用现有插槽，不拥有独立的模型或权限设置；上游 profile 不增加语音控件。Host 资源配置由 [qianshou-voice](../../host/qianshou-voice/README.zh.md) 管理。

默认松开转文字。松开发送要求草稿为空且没有附件，智能体忙时始终排队。草稿修订、附件集合、Session 实例、待处理交互或输入阻断变化时，不会自动插入或发送；识别结果可由用户明确加入同一会话草稿。以斜线开头的文字保留在草稿中，等待手动检查。

松开鼠标及 Space/Enter 结束一次录音；上滑、Esc、指针捕获丢失或窗口失焦会取消。屏幕阅读器激活可切换开始与结束。识别反馈显示在输入卡片上方；权限拒绝、引擎不可用、忙碌、超时或空结果均显示明确状态，不覆盖草稿。

只有存在匹配界面语言的本地系统声音时，才允许开始朗读。停止、新朗读、开始录音、回复视图卸载或离开窗口都会取消所属输出。启动与播放是不同状态；枚举声音和播放回调不能证明扬声器真实可闻。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[控制器](src/client/controller.ts) 在权限或识别前固定实际 Session 绑定，并管理一次采集代际。[采集器](src/client/capture.ts) 通过临时 Blob 模块加载包内固定 AudioWorklet，等待最后一帧后停止媒体轨道并关闭音频图。加载结束或取消时释放模块 URL，丢弃迟到的授权结果。[认证二进制上传](src/client/api.ts) 携带原会话和预期 cwd，不把音频写入 Remote 参数日志。

Conversation 管理带修订校验的编辑追加与提交回执；语音插件既不展开并重建引用卡片，也不另建 prompt 路径。[系统朗读](src/client/speech.ts) 管理声音发现、发声回调、有界播放与取消。本包不发布运行时 invariant companion：此界面没有独立的持久 Session 或模型投影；设备和 ASR 输出仍需明确的集成验收。长期设计理由见[语音归属决策](../../../.agents/notes/implemented/feature/2026-09-21-session-bound-voice-input.zh.md)。

</details>

<a id="model-experience"></a>
## Model Experience

### 普通用户文字

#### What the model sees

本包使用 `SessionInput.commitExternalText` 追加纯文字。只有经过普通 Session 输入接收的文字才进入既有模型与 CEO 流程；单纯转文字只改变本地草稿。录音、系统声音对象与界面进度不会成为模型消息，本包不增加模型工具或系统提示词。

#### Token effect

接收后的文字产生普通用户消息 token。录音、识别进度、草稿插入及本地朗读本身不增加模型 token。

#### KV Cache effect

本包不改写历史消息或添加提示词前缀；接收后的消息通过普通输入路径追加到已有会话。

## Known Limitations and Deferred Work

源码和受控测试的证据范围小于设备验收。

- 识别依赖另行安装的本地资源和 Host 状态，客户端不会自行下载模型。
- 浏览器、开发 Electron、签名安装包及各操作系统分别需要真实麦克风和扬声器验收。
- 每个页面有一个输入/输出归属，不宣称独立桌面窗口之间已协调。
- 首版没有连续监听、神经 TTS 或自动朗读。系统输出排除代码块与图片地址，并拒绝超过 20,000 字符的回复。
- 语音识别可能有误，请检查转写文字；草稿变化会阻止自动应用，保护用户内容。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护工作背景——点击展开</summary>

受控夹具不能证明真实录音、可闻声音或模型任务完成；应按具体运行版本和设备分别记录这些结果。

</details>
