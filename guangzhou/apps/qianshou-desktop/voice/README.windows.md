---
description: "Voice availability and manual verification for the Windows x64 Qianshou controller preview; no Windows recognition or MLX installer is bundled."
kind: "package-reference"
---

# Voice on Windows

English | [中文](README.windows.zh.md)

The Windows 0.2.1 controller preview supports text conversations without local voice models. System read-aloud is available only when Windows supplies a usable voice to the browser speech API. Windows speaker and microphone behavior has not been verified on a physical device for this release. The animated character is an interaction display, not a speech-recognition engine.

## Availability

| Capability | Requirement in this preview |
|---|---|
| Text chat and task dispatch | A configured model provider and the required workspace permissions; no speech model needed. |
| System read-aloud | An installed Windows voice exposed by the speech API and working audio output. Voice choices can differ between computers. |
| Dictation and continuous microphone conversation | Separately installed compatible local recognition resources and microphone permission. The ZIP does not include these resources or a Windows installer. |
| Serena/Vivian neural speech | A compatible, configured local worker and model. No Windows worker installation is supplied; the Apple Silicon MLX installer is not applicable. |

Recognition uses the controller's authenticated local transcription service. There is no automatic browser SpeechRecognition or cloud-recognition fallback. API credentials for the conversation model do not activate speech recognition. The application does not download voice weights when you open the voice controls.

## Check system read-aloud

1. Open the controller, configure the conversation provider and obtain a text reply.
2. Open the voice controls and select an available system voice. Play a sample or use the reply's read-aloud action. Check that the selected voice is audible and that stopping playback stops it.
3. If no system voice is listed or playback fails, check Windows language and speech settings, the selected audio output and volume. Reopen the app after changing installed voices. A listed voice does not prove that it can play on this computer.
4. Keep text chat available while checking voice. If local recognition is reported unavailable, do not repeatedly grant microphone permission: permission alone cannot supply the missing recognizer.

## Recognition and permissions

A deployment maintainer can configure a trusted Windows-compatible whisper.cpp executable and model through the Host's absolute-path settings or the launcher defaults `FORGE_WHISPER_BINARY` and `FORGE_WHISPER_MODEL`. Both files must be present. The default POSIX paths are not a Windows installation, and renaming a Mac executable does not make it compatible. Compiling and installing a Windows recognizer is outside this package's supplied installation procedure.

After a maintainer configures and verifies recognition, finish active tasks and reopen the controller so it reads the resource paths. Enable microphone access and desktop-app microphone access in Windows Privacy / Privacy & security settings, then allow the app's audio request. Speak a short phrase and confirm its transcript before dispatching work. Verify listening, interruption, cancellation and output on that device; a resource-availability check proves neither recognition accuracy nor microphone access.

The Electron shell permits audio capture only for its trusted main page. It does not grant Windows permissions itself. A separate cloud provider or remote companion does not remove this local permission requirement. Avoid sharing recorded audio or application credentials when reporting a voice problem.

## Installation boundary

This Windows package contains these instructions, not the macOS `install.py`, Homebrew commands, Python wheel bundle or MLX model installer. Do not follow the Mac voice guide on Windows. Existing user home, voice preferences and explicit Host settings remain authoritative; the preview does not replace them with a Windows preset. Use text chat and an available system voice until compatible local resources are configured and checked. Return to the [Windows quick start](../QUICK_START.windows.md) for startup, data and companion instructions.
