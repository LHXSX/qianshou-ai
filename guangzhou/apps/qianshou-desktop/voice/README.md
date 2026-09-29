---
description: "Install optional local recognition and Serena/Vivian speech for the Qianshou macOS arm64 desktop app without replacing existing settings."
kind: "package-reference"
---

# Optional local voice resources

English | [中文](README.zh.md)

The desktop app can read replies with an available macOS system voice without downloading neural models. Continuous voice conversation also needs local speech recognition. This installer supports native Apple Silicon, macOS 15 or later, and Python 3.13; it does not supply Windows, Linux, Intel, or Rosetta MLX support. It installs only when you run it, preserves the application home and explicit plugin configuration, and never restarts the app or interrupts tasks.

## Install

1. Install [Homebrew](https://brew.sh/) if needed, then run the prerequisite commands below in Terminal. Apple Command Line Tools may open a system installer; wait for it to finish. These are explicit operating-system dependency installations, separate from the app.

```sh
xcode-select --install
brew install python@3.13 cmake ffmpeg
```

2. Set the installed app path below. If you placed the app in `/Applications`, change only that path. Run the check; it reports missing prerequisites without downloading or writing resources.

```sh
QIANSHOU_APP="$HOME/Applications/千手智能体.app"
/opt/homebrew/bin/python3.13 "$QIANSHOU_APP/Contents/Resources/app/voice/install.py" --asr --tts --check
```

3. Install recognition and optional natural speech. Keep the same Terminal window so the app path remains set. Recognition downloads a 190 MB quantized Whisper model and builds pinned whisper.cpp source; neural speech downloads about 2.32 GB of model files plus locked Python wheels. Allow additional disk space for the compiler output, environment and download cache. Download duration depends on connectivity to GitHub, Hugging Face and PyPI.

```sh
/opt/homebrew/bin/python3.13 "$QIANSHOU_APP/Contents/Resources/app/voice/install.py" --asr --tts
```

Use `--asr` alone if you prefer the system voice; use `--tts` alone to add Serena/Vivian when recognition is already configured. The installer verifies complete sizes and SHA-256 values before exposing downloaded resources. Downloads are resumable at file granularity: completed verified files are reused, while an interrupted file is fetched again. A failed installation leaves the existing settings selected; retry the same command after fixing the reported prerequisite or network issue.

4. Finish active tasks, quit the app, and reopen it. In voice controls, select a voice, play a sample, and then enable microphone access. A sample pauses listening; use Resume when ready. Cold neural-model loading can take longer than subsequent speech. A successful resource installation does not prove microphone permission, speaker output or recognition quality on your device; check these in the app.

## Settings and troubleshooting

The installer writes `~/.local/share/qianshou-agent/voice/voice-settings.json` with version `1` and selected `asr: { binary, model }` / `tts: { python, worker, model }` absolute paths. Each install uses a fresh versioned build directory, preserves unselected settings and unknown fields, and creates a private backup when replacing an existing settings file. It does not edit `home/patch.yaml`, cloud credentials, speaker preferences or existing model directories. The desktop launcher reads this file at startup; existing explicit plugin settings and environment variables take priority. See the [Host voice configuration](../../../packages/host/voice-local/README.md) for deployment fields.

If the app still reports unavailable resources, check that it was reopened after installation, that the default settings path exists, and that an explicit Host configuration does not select missing older resources. A SHA mismatch stops installation: do not bypass it or substitute an unverified file. The printed resource path identifies a conflicting cached file; preserve it for inspection and use an empty `--root` directory for diagnosis. A custom `--root` does not automatically configure the packaged app. An interrupted install may leave an unused release directory; the installer does not delete prior versions or user files automatically.

System speech requires a voice supplied by macOS. If none is available, add one in macOS Accessibility → Spoken Content / Read & Speak, then reopen the app. Without installed ASR resources, text chat and system read-aloud remain usable; opening a microphone does not make recognition available. This installer does not install cloud services or use API keys.

## Resource provenance

[asr.lock.json](asr.lock.json) pins [whisper.cpp](https://github.com/ggml-org/whisper.cpp) source and its quantized model by revision, byte count and SHA-256. [tts-model.lock.json](tts-model.lock.json) pins the [MLX community conversion](https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-CustomVoice-4bit) of Qwen3-TTS CustomVoice, including the speech tokenizer. This is a community quantization of the upstream Qwen model. The model weights are downloaded on demand and are not in the app package.

[requirements.lock.txt](requirements.lock.txt) fixes Python versions and eligible wheel hashes; [python-wheels.lock.json](python-wheels.lock.json) records their PyPI download provenance. The installer accepts binary wheels only, disables dependency resolution and runs `pip check`. [worker.py](worker.py) is the credential-free local JSONL worker, recorded in [worker.lock.json](worker.lock.json), with fixed sampling, consistent loudness and 1.5× pitch-preserving tempo. It loads models offline, limits output to the Host's private directory, and accepts the bundled Serena/Vivian presets. Source licenses are included for [whisper.cpp](licenses/whisper.cpp.LICENSE), [MLX Audio](licenses/mlx-audio.LICENSE) and [Qwen3-TTS](licenses/Qwen3-TTS.LICENSE); downloaded wheels retain their respective package licenses.

## Maintainer checks

Run the offline installer tests from this directory. They use temporary files and synthetic downloads, not the user's models, microphone or application. A fresh-device installation and actual recording/playback remain separate acceptance checks.

```sh
/opt/homebrew/bin/python3.13 -m unittest -v test_install.py
```
