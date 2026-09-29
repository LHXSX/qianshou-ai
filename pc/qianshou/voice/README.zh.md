# 本地 ASR 资源准备

[English](README.md) | 中文

本目录只准备固定 whisper.cpp 与 small-q5_1 资源，不改全局环境、旧工程或用户配置，不下载神经网络朗读模型。脚本要求 macOS arm64、Python 3.12 以上、已有 CMake 与 Xcode 命令行工具。设备麦克风授权和真人识别另行验收。

使用明确指定的绝对私有目录（0700，当前用户所有），先执行 `python3 -B qianshou/voice/prepare.py --root /absolute/private/asr --check` 检查前置条件，再去掉 `--check` 下载并编译。`--jobs` 默认为 4，可设为 1–32。脚本不自动安装依赖；仅在指定目录写入下载缓存、源码、构建、许可和 `manifest.json`。模型约 190 MB，编译还需要额外空间。已有资源必须仍匹配锁，任何字节数或 SHA-256 不符均拒绝使用，不覆盖用户文件。安装锁防止同目录并行写入；失败留下的源码/构建须由所有者检查，脚本不自动删除它们。

成功后把 manifest 中的 `binaryPath` 和 `modelPath` 明确传给 Host `qianshou-voice` 配置。缺少配置时 UI 应显示资源不可用，不宣称识别已完成。源码与模型锁在 `asr.lock.json`；资源更新必须同步锁、许可和真实识别验收，不跟随上游 latest。下载失败时可在同目录缓存中放入来自同一官方 URL 的完整文件再重跑，但仍需通过原锁；不要关闭 TLS 验证或修改锁来接受不完整内容。

`licenses/whisper.cpp.LICENSE` 来自固定 whisper.cpp 源码，`licenses/Whisper.LICENSE` 为 OpenAI Whisper 的 MIT 许可。固定模型卡声明 MIT；部署或分发须保留这两份许可及资源锁。源码地址和固定模型卡分别为 [whisper.cpp](https://github.com/ggml-org/whisper.cpp)、[small-q5_1 固定模型仓库](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1)。模型权重不提交到本仓库。

普通代码测试使用受控本机进程，不下载模型。实际识别使用明确标记的系统离线合成或官方音频，记录 WAV 哈希、音频参数、模型哈希、识别文本和运行时间。它只能验证该安装的本地 ASR；真人麦克风、其他系统、打包安装及噪声效果不是此结果的组成部分。
