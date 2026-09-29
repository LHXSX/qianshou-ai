---
description: "千手本地语音识别与可选神经网络语音：绑定真实会话，通过认证 Connection 上传音频或合成。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-voice

[English](README.md) | 中文

## 概述

`qianshouVoice` Remote 返回本地识别器状态。认证 Connection Fetch 通过 `POST /api/qianshou/voice/transcribe?sessionId=…&workspaceRoot=…` 接收有大小限制的 WAV，返回 `{ text }`。预期工作区必须与当前真实 Session 的不可变 `header.cwd` 相等，不能用于选择服务端文件。上传和识别全程要求同一个 Session 实例仍然存活。服务不会创建用户消息或调用对话模型。

同一插件还注册可选神经网络语音路由：`GET /api/qianshou/voice/tts/status` 与 `POST /api/qianshou/voice/tts/synthesize`。合成在认证且绑定 Session 的请求上返回 `audio/wav`。产品窗口的朗读仍使用系统语音；这些 Host 路由不替代客户端播放。

## 目录

- [配置](#configuration)
- [音频与生命周期](#audio-and-lifecycle)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="configuration"></a>
## 配置

`binaryPath`、`modelPath` 默认为空，对应 `not-configured`。配置资源时两项必须同时为管理员选定的本机 whisper.cpp 资产绝对路径。启动不扫描旧目录、不查询环境凭据、不下载或安装资源。[资源准备](../../../qianshou/voice/README.zh.md)在明确指定的私有目录核验固定 ASR 资源。

`uploadTimeoutMs` 默认 30000，`recognitionTimeoutMs` 默认 90000，`threads` 默认 4，`maxResultBytes` 默认 65536，`maxProcessOutputBytes` 默认 2097152。可用状态只表示可访问配置的可执行文件和模型，不等于模型加载或识别成功。状态包含忙闲、安全原因码与音频限制，不暴露资源路径。

神经网络语音使用 `ttsPythonPath`、`ttsWorkerPath`、`ttsModelPath`。三项须同为绝对路径，或三项全空。全空时 assets 为 undefined，合成保持关闭（`not-configured`）。部分填写或相对路径在插件加载时失败。内置说话人仅 Vivian 与 Serena，不提供声音克隆。`ttsDefaultSpeaker` 默认 Vivian，`ttsMaxTextChars` 默认 500，`ttsRequestTimeoutMs` 默认 180000，`ttsMaxOutputBytes` 默认 8388608，`ttsIdleTimeoutMs` 默认 300000。

<a id="audio-and-lifecycle"></a>
## 音频与生命周期

协议为 RIFF/WAVE，单个 PCM16、单声道、16 kHz 的 data 块，时长 0.1–120 秒。完整请求含元数据最多 3,844,096 字节。块长度、补齐字节、音频帧和 RIFF 总长均独立于 Content-Length 检查。PCM 全零时直接返回空文本，不进行推理。其他静音或噪音仍可能误识别；复核和发送策略属于客户端。

一次请求从上传到原生进程关闭、临时目录清理完成期间独占 Host 识别槽位。并发请求返回 `VOICE_BUSY`，不隐藏排队。请求取消、Session 释放和插件卸载会终止识别并等待实际结束。异步操作后重新检查 Session 实例，因此同 ID 的新 Session 不会接收旧结果。固定本机进程使用最小环境、固定参数，不经 shell。音频只写入随机 0700 目录中的 0600 输入文件，成功和失败均清理。输出文件和最终 UTF-8 JSON（含转义）有字节上限。响应不包含进程 stderr 或本机路径。

神经网络合成接收有界 JSON 体 `{ text, speaker? }`，独占一个 worker 槽位且不隐藏排队（忙时返回 `TTS_BUSY`）；在资产已配置且可访问时返回 24 kHz PCM WAV。并发合成、取消、Session 释放与插件卸载遵循与识别相同的 Session 准入与清理规则。空资产配置不会启动 worker。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护工作背景——点击展开</summary>

冷启动总时限包含操作系统启动进程的时间。超时夹具隔离临时目录，在发起请求时监听拒绝，并且只在真实启动事件后读取 PID；这些夹具不能证明真实模型语音验收。

</details>

<a id="model-experience"></a>
## 模型体验

### 本地识别

#### 模型看到的内容

`qianshouVoice.status` 和转写路由均不向模型传递内容。本插件不提供模型工具，不写 Session 事件。音频与识别文本不自动持久化或发送给模型，只有后续明确的输入框动作才会创建普通会话输入。

#### Token 影响

识别与状态查询不增加模型 token，后续用户消息按普通会话计入 token。

#### KV Cache 影响

本地识别不更改模型上下文或 KV 缓存。

### 本地神经网络语音

#### 模型看到的内容

神经网络语音状态与合成路由均不向模型传递内容：不提供模型工具，不写 Session 事件。合成音频不自动持久化或发送给模型。

#### Token 影响

神经网络语音状态与合成不增加模型 token。

#### KV Cache 影响

神经网络语音不更改模型上下文或 KV 缓存。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 本批使用固定 small-q5_1 权重进行中文识别，不提供语音活动检测、声纹识别或实时流式识别。可选的 Host 神经网络语音仅限 Vivian 与 Serena 预设，不提供声音克隆；系统朗读仍由客户端负责。准备脚本目前仅针对 macOS arm64；Windows/Linux 打包、实际麦克风权限和设备质量须单独验收。测试识别进程与离线合成音频不能代替真人麦克风测试。本机可执行文件必须是设备所有者选择的可信原生程序，不是任意不可信脚本或通用命令执行接口。

包内测试通过真实 Cordis Loader、SessionStore 和 Connection 注册配合受控识别子进程与神经网络语音 worker 验证取消、清理、字节校验以及不写 Session。产品 profile 和物理认证传输在整合阶段另外验证。不提供 invariant 模块，因为各槽位、子进程和临时文件由同一操作持有，生命周期测试检查其真实清理结果。
