---
description: "为已认证客户端配置本地中文转写与可选神经语音，提供有界请求、私有文件和取消处理。"
kind: "package-reference"
---

# @deepseek-ai/dsh-host-voice-local

[English](README.md) | 中文

## 概述

浏览器客户端可使用 whisper.cpp 转写简短中文录音，并通过可选的本地 Qwen3-TTS worker 合成回复。语音数据留在接收请求的 Host 上。请求具有明确限制并可取消；本地模型需单独安装。将转写文字发送给 Agent 仍由客户端单独执行。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

已认证客户端需要本地转写或神经语音时使用此包。它不打开麦克风，也不派发 Session 消息。

### 配置与前置条件

[web-app 组合](../../bundle/web-app/cordis.patch.yml) 使用现有 [Connection](../../client/connection/README.zh.md) 服务挂载这个函数插件。自定义组合在提供 Connection 后使用相同的插件配置行：

```yaml
- name: '@deepseek-ai/dsh-host-voice-local'
  config:
    uploadTimeoutMs: 30000
    recognitionTimeoutMs: 90000
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `uploadTimeoutMs` | `30000` | 读取音频请求体的最长时间，单位毫秒 |
| `recognitionTimeoutMs` | `90000` | 识别器进程的最长运行时间，单位毫秒 |

两个字段均接受不超过 `2147483647` 的正整数。默认可执行文件为 `~/.local/share/forge-voice/whisper.cpp/build/bin/whisper-cli`；默认模型为 `~/.local/share/forge-voice/models/ggml-small-q5_1.bin`。Host 环境可通过 `FORGE_WHISPER_BINARY` 和 `FORGE_WHISPER_MODEL` 覆盖路径。此包不下载或安装这两个文件。

### 请求与错误

两条路由均由 Connection 认证。`GET /api/forge/voice/status` 返回 `{ available, engine: 'whisper.cpp', language: 'zh' }`；可用性只检查可执行文件和模型的访问权限，不验证识别准确率。`POST /api/forge/voice/transcribe` 接收 WAV 请求体并返回 `{ text }`。空字符串表示识别器未输出文字，或仅输出了方括号包围的非语音标记。

请求必须使用 `audio/wav`、`audio/wave` 或 `audio/x-wav`，内容为 16 kHz 单声道 PCM16 音频，样本时长介于 0.1–120 秒。完整上传限制为 3,844,096 字节。即使 `Content-Length` 缺失或不实，也会检查实际流式字节；调用方不能提交服务端文件路径。

错误返回 `{ error }`：不支持的媒体为 `INVALID_AUDIO`（415），字节超限为 `INVALID_AUDIO`（413），PCM 格式错误为 `INVALID_AUDIO`（400），缺少识别资源为 `VOICE_UNAVAILABLE`（503），并发请求为 `VOICE_BUSY`（429）。上传或识别超时返回 `VOICE_TIMEOUT`（504）；调用方取消或插件释放返回 `REQUEST_ABORTED`（499）。其他识别失败返回 `TRANSCRIPTION_FAILED`（500）。响应禁用缓存。

### 可选神经语音

同时配置 `ttsPythonPath`、`ttsWorkerPath` 和 `ttsModelPath`，分别指定受信任 Python 可执行文件、JSONL worker 脚本和完整本地 Qwen3-TTS CustomVoice 模型目录的绝对路径。三个路径全部留空时，Host 会一起读取启动器环境变量 `FORGE_TTS_PYTHON`、`FORGE_TTS_WORKER` 和 `FORGE_TTS_MODEL`。显式路径整组优先；不完整的配置组不会借用环境路径。没有资源时禁用合成；部分缺失或相对路径会导致插件配置失败。客户端不能要求安装模型、调用云端合成、克隆声音或指定可执行文件路径。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `ttsDefaultSpeaker` | `Vivian` | 请求省略时使用的预设；仅允许 `Vivian` 和 `Serena` |
| `ttsMaxTextChars` | `500` | 每请求 Unicode 码点限制，可配置为 1 至 2000 |
| `ttsRequestTimeoutMs` | `180000` | 排队、冷加载与合成的总期限，最多 600000 毫秒 |
| `ttsMaxOutputBytes` | `8388608` | 完整 WAV 限制，范围为 46 字节至 32 MiB |
| `ttsMaxQueuedRequests` | `2` | 单个活动操作之外的等待请求数，范围为 0 至 8 |
| `ttsIdleTimeoutMs` | `300000` | 已加载 worker 的空闲保留时间，最多 3600000 毫秒 |

`GET /api/forge/voice/tts/status` 返回 `{ available, ready, engine: 'qwen3-tts', speakers: ['Vivian', 'Serena'], defaultSpeaker }`。`available` 检查配置路径和可读模型资源，不证明权重完整或合成可用。`ready` 表示正在运行的 worker 已确认模型加载完成。`POST /api/forge/voice/synthesize` 接收 JSON `{ text, speaker? }`，返回 24 kHz 单声道 PCM16 WAV，并拒绝未知字段。完整 JSON 请求体限制为 16 KiB，使用 `uploadTimeoutMs`。两个端点均使用 Connection 认证并禁用缓存，不另开服务端口。

缺少资源返回 `TTS_UNAVAILABLE`（503），活动及等待请求超限返回 `TTS_BUSY`（429），JSON、文字或音色无效返回 `INVALID_TEXT`（400），媒体类型不支持返回 415，声明的请求体超限返回 413。请求超时返回 `TTS_TIMEOUT`（504），取消返回 `REQUEST_ABORTED`（499）。worker 错误、WAV 格式错误或超限、输出路径不匹配均返回 `SYNTHESIS_FAILED`（500），不附带 worker 诊断信息。只有明确不可用时，客户端才可选择系统声音；神经合成请求失败必须对用户可见。

受信任 worker 接收 `--model <directory> --output-dir <private-root>`，stdout 每行写一个 JSON 对象。它仅在本地加载完成后发送 `{ "type": "ready" }`；接收 `{ id, text, speaker, outputPath }` 后回复 `{ id, ok: true, path }` 或 `{ id, ok: false, error }`。成功回复必须指向原请求的精确路径。普通模型日志写入 stderr。worker 必须将输出限制在其根目录内，使用固定的自然聊天风格，并拒绝截断语音；Host 独立检查输出文件与 WAV 格式。Python 接收明确限定的环境，启用 Hugging Face 离线模式，不继承 Host 凭证。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部 — 点击展开</summary>

路由负责请求从有界上传到识别器结束的完整生命周期。取消会释放阻塞的请求体读取器，不等待无响应的传输层取消回调。固定容量缓冲区避免大量微小分块放大所保留的上传元数据。插件释放时取消活动操作，并等待请求结束。

引擎将文件写入独占创建的临时目录，使用私有 POSIX 权限，并直接启动配置的可执行文件，不经过 shell。取消会强制停止识别器；清理必须等到进程真正触发 close 事件，才删除音频和转写文件。子进程接收明确限定的小型环境，不继承 Host 的秘密变量。它以 Host 用户权限运行；这些措施不构成操作系统沙箱。

| 源文件 | 职责 |
|---|---|
| [index.ts](src/index.ts) | 配置、认证路由、上传限制与请求生命周期 |
| [wav.ts](src/wav.ts) | PCM 格式与样本限制 |
| [engine.ts](src/engine.ts) | 资源探测、本地进程与私有文件清理 |
| [tts-config.ts](src/tts-config.ts) | 明确解析神经模型资源与限制 |
| [tts-routes.ts](src/tts-routes.ts) | 神经语音状态、有界 JSON 请求与 WAV 响应 |
| [tts-engine.ts](src/tts-engine.ts) | 串行队列、期限与 PCM 验证 |
| [tts-process.ts](src/tts-process.ts) | 常驻 JSONL 进程与私有输出根目录 |

[生命周期决策](../../../.agents/notes/implemented/feature/2026-09-13-bounded-local-voice-transcription.zh.md) 记录备选方案与验证。此包不发布 `./invariant` companion：它没有需要核对的独立发布观测值，而是在准入和结束时验证自己负责的请求。

神经合成使用独立名额和常驻进程。取消等待中的请求不会影响活动合成；取消活动请求会先强制停止其进程组，再清理文件。下一个准入任务会加载新 worker。空闲关闭与插件释放也会等待进程真正关闭；请求子目录和 worker 私有根目录均按其归属生命周期删除。[神经语音决策](../../../.agents/notes/implemented/feature/2026-09-13-bounded-neural-speech.zh.md) 记录此进程策略。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connection](../../client/connection/README.zh.md) — 已认证的 Fetch 传输
- [Conversation UI](../../client/ui-conversation/README.zh.md) — Session 输入归属
- [Chat UI](../../client/ui-chat/README.zh.md) — 浏览器语音控件
- [生命周期决策](../../../.agents/notes/implemented/feature/2026-09-13-bounded-local-voice-transcription.zh.md) — 理由与测试边界

-----

<a id="model-experience"></a>
## 模型体验

无，因为此包将转写文字或合成音频返回给已认证客户端，不注册 Agent 提示词、工具或 Session 消息。

#### KV Cache 影响

无直接影响。此包不创建或修改 LLM 请求前缀。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

此本地转写端点具有以下范围限制：

- **仅支持中文 WAV** — 语言固定为 `zh`；不支持任意编码、流式中间转写或语言选择。
- **整个 Host 仅一个请求** — 识别器繁忙时拒绝另一个上传，不进行排队。资源需单独安装；状态探测成功不代表识别可用。
- **平台验证** — 真实进程清理测试使用 POSIX 可执行文件。Windows 的二进制选择、环境、权限和进程取消需要原生验收；此包不声称已完成。
- **神经模型部署与延迟** — 模型安装、兼容的 MLX 运行时和真实设备试听验收是独立要求。冷加载和完整 WAV 生成会延迟播放；不提供流式音频响应或首声延迟保证。麦克风回声消除与全双工打断属于客户端职责，不能由这些路由证明。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
