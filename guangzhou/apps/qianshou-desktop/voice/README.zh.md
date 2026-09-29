---
description: "为千手 macOS arm64 桌面应用安装可选的本地识别及 Serena/Vivian 语音资源，保留既有设置。"
kind: "package-reference"
---

# 可选本地语音资源

[English](README.md) | 中文

桌面应用可直接使用可用的 macOS 系统声音朗读回复，无须下载神经语音模型。连续语音对话还需要本地语音识别。本安装器支持原生 Apple Silicon、macOS 15 及以上和 Python 3.13，不提供 Windows、Linux、Intel 或 Rosetta 的 MLX 支持。只有主动运行命令才会安装，保留应用数据目录和显式插件配置，不会重启应用或打断任务。

## 安装

1. 如有需要，先安装 [Homebrew](https://brew.sh/)，然后在终端运行下面的依赖安装命令。Apple 命令行工具可能打开系统安装界面，请等待完成。这些命令明确安装操作系统依赖，与应用安装分开执行。

```sh
xcode-select --install
brew install python@3.13 cmake ffmpeg
```

2. 设置下面的已安装应用路径。如果应用位于 `/Applications`，只修改该路径。先运行检查命令；它会报告缺失依赖，不下载或写入资源。

```sh
QIANSHOU_APP="$HOME/Applications/千手智能体.app"
/opt/homebrew/bin/python3.13 "$QIANSHOU_APP/Contents/Resources/app/voice/install.py" --asr --tts --check
```

3. 安装识别和可选的自然语音。请保留同一个终端窗口，以继续使用已设置的应用路径。识别会下载 190 MB 的量化 Whisper 模型并编译固定版本的 whisper.cpp；神经语音会下载约 2.32 GB 模型文件和锁定的 Python wheel。请额外预留编译产物、环境及下载缓存空间。下载时间取决于到 GitHub、Hugging Face 和 PyPI 的网络连接。

```sh
/opt/homebrew/bin/python3.13 "$QIANSHOU_APP/Contents/Resources/app/voice/install.py" --asr --tts
```

希望使用系统声音时只传 `--asr`；已经配置识别、只增加 Serena/Vivian 时只传 `--tts`。安装器核对完整字节数和 SHA-256 后才会公开下载资源。下载按文件恢复：已完整校验的文件会复用，中断的单个文件会重新下载。安装失败会保留原设置；按报错修复依赖或网络后，重新运行同一命令。

4. 等待活动任务完成，退出应用并重新打开。在语音控制中选择声音、试听，然后允许麦克风访问。试听会暂停监听，请准备好后点击恢复。神经模型冷启动可能比后续播报慢。资源安装成功不代表本机的麦克风权限、扬声器输出或识别质量已验证，请在应用中实际检查。

## 设置与故障处理

安装器写入 `~/.local/share/qianshou-agent/voice/voice-settings.json`，版本为 `1`，包含所选的 `asr: { binary, model }` / `tts: { python, worker, model }` 绝对路径。每次安装使用新的版本化编译目录，保留未选择的设置和未知字段，替换既有设置文件时生成私有备份。它不修改 `home/patch.yaml`、云端凭据、声音偏好或已有模型目录。桌面启动器在启动时读取该文件；已有显式插件设置和环境变量优先。部署字段见 [Host 语音配置](../../../packages/host/voice-local/README.zh.md)。

如果应用仍提示资源不可用，请检查安装后是否重新打开、默认设置路径是否存在，以及显式 Host 配置是否仍指向缺失的旧资源。SHA 不匹配会停止安装，请勿跳过校验或替换为未验证文件。输出的资源路径会指出冲突缓存；请保留供检查，可用空的 `--root` 目录诊断。自定义 `--root` 不会自动配置已打包应用。中断安装可能留下未使用的版本目录；安装器不会自动删除旧版本或用户文件。

系统朗读需要 macOS 提供的声音。若没有可用声音，请在 macOS 辅助功能 → 朗读内容 / 朗读与语音中添加，然后重新打开应用。未安装 ASR 资源时，文字聊天和系统朗读仍可使用；打开麦克风不代表已经具备识别能力。安装器不安装云端服务，也不使用 API 密钥。

## 资源来源

[asr.lock.json](asr.lock.json) 使用修订、字节数和 SHA-256 固定 [whisper.cpp](https://github.com/ggml-org/whisper.cpp) 源码及量化模型。[tts-model.lock.json](tts-model.lock.json) 固定 Qwen3-TTS CustomVoice 的 [MLX 社区转换模型](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit)，包含语音 tokenizer。这是上游 Qwen 模型的社区量化版本。模型权重按需下载，不放入应用安装包。

[requirements.lock.txt](requirements.lock.txt) 固定 Python 版本和适用 wheel 的哈希；[python-wheels.lock.json](python-wheels.lock.json) 记录 PyPI 下载来源。安装器只接受二进制 wheel，禁用依赖解析并运行 `pip check`。[worker.py](worker.py) 是无凭据的本地 JSONL worker，由 [worker.lock.json](worker.lock.json) 记录，使用固定采样、一致响度和保持音高的 1.5 倍语速。它离线加载模型，将输出限制在 Host 私有目录，只接受内置 Serena/Vivian 音色。源码许可证包含 [whisper.cpp](licenses/whisper.cpp.LICENSE)、[MLX Audio](licenses/mlx-audio.LICENSE) 和 [Qwen3-TTS](licenses/Qwen3-TTS.LICENSE)；下载的 wheel 保留各自的软件包许可证。

## 维护者检查

在本目录运行离线安装器测试。测试使用临时文件和模拟下载，不使用用户模型、麦克风或应用。新设备安装及实际录音、播放仍是独立的验收项目。

```sh
/opt/homebrew/bin/python3.13 -m unittest -v test_install.py
```
