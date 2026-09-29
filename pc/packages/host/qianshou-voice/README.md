---
description: "Private local speech recognition and optional neural speech for Qianshou, bound to a live Session and authenticated Connection."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-voice

English | [中文](README.zh.md)

## Summary

The `qianshouVoice` Remote reports local recognizer availability. Authenticated Connection Fetch accepts a bounded WAV upload at `POST /api/qianshou/voice/transcribe?sessionId=…&workspaceRoot=…` and returns `{ text }`. The expected workspace must equal the current Session's immutable `header.cwd`; it never selects a server file. The same Session instance must remain alive through upload and recognition. The service creates no user message and does not invoke the conversation model.

The same plugin registers optional neural speech on `GET /api/qianshou/voice/tts/status` and `POST /api/qianshou/voice/tts/synthesize`. Synthesis returns `audio/wav` for authenticated, Session-bound requests. The product window still uses system speech for narration; these Host routes do not replace client-side playback.

## Table of Contents

- [Configuration](#configuration)
- [Audio and lifecycle](#audio-and-lifecycle)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="configuration"></a>
## Configuration

`binaryPath` and `modelPath` default to empty strings, which report `not-configured`. Both must otherwise be absolute paths to administrator-selected local whisper.cpp assets. No legacy directory scan, environment credential lookup, download, or installation runs during service startup. [Resource preparation](../../../qianshou/voice/README.md) verifies pinned ASR resources in an explicitly selected private directory.

`uploadTimeoutMs` defaults to 30000, `recognitionTimeoutMs` to 90000, `threads` to 4, `maxResultBytes` to 65536, and `maxProcessOutputBytes` to 2097152. Availability means the configured executable/model can be accessed; it does not mean model loading or recognition has succeeded. Status includes busy state, safe reason codes, and audio limits, never asset paths.

Neural speech uses `ttsPythonPath`, `ttsWorkerPath`, and `ttsModelPath`. All three must be absolute paths together, or all three must be empty. Empty paths leave assets undefined and keep synthesis disabled (`not-configured`). Partial or relative paths fail at plugin load. Bundled speakers are Vivian and Serena only; voice cloning is never offered. `ttsDefaultSpeaker` defaults to Vivian, `ttsMaxTextChars` to 500, `ttsRequestTimeoutMs` to 180000, `ttsMaxOutputBytes` to 8388608, and `ttsIdleTimeoutMs` to 300000.

<a id="audio-and-lifecycle"></a>
## Audio and lifecycle

The upload protocol is RIFF/WAVE with one PCM16 mono 16 kHz data chunk lasting 0.1–120 seconds. The complete request is capped at 3,844,096 bytes, including metadata. Chunk bounds, padding, frame alignment and RIFF length are validated independently of Content-Length. All-zero PCM produces empty text without inference. Other silence or noise can still be misrecognized; the UI owns review and sending policy.

One request owns the Host recognition slot through upload, native process closure and temporary-directory cleanup. Concurrent requests receive `VOICE_BUSY`; there is no hidden queue. Request cancellation, Session release, and plugin disposal terminate active inference and await quiescence. Session identity is checked again after asynchronous operations, so replacing a Session with the same id does not adopt an old result. The process receives a minimal environment, no shell, and fixed arguments. Input audio lives only in a random mode-0700 directory with mode-0600 input; it is removed on success and failure. The text file and complete UTF-8 JSON response obey the result cap, including JSON escaping. Responses suppress process stderr and filesystem details.

Neural synthesis admits a bounded JSON body `{ text, speaker? }`, owns one worker slot without a hidden queue (`TTS_BUSY` when busy), and returns 24 kHz PCM WAV when assets are configured and reachable. Concurrent synthesis, cancellation, Session release, and plugin disposal follow the same Session admission and teardown rules as recognition. Empty asset configuration never starts a worker.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Cold-start deadlines include operating-system process startup. Timeout fixtures isolate temporary directories, observe rejection at request creation, and read a PID only after an actual start event; they do not establish real-model speech acceptance.

</details>

<a id="model-experience"></a>
## Model Experience

### Local recognition

#### What the model sees

Nothing from `qianshouVoice.status` or the transcription route: this plugin exposes no model tool and appends no Session event. Audio and recognition text are not automatically persisted or sent to a model. Only a later explicit composer action can create ordinary conversation input.

#### Token effect

Recognition and status add no model tokens. A later user message consumes ordinary conversation tokens.

#### KV Cache effect

Local recognition does not alter the model context or its KV cache.

### Local neural speech

#### What the model sees

Nothing from the neural speech status or synthesize routes: they expose no model tool and append no Session event. Synthesized audio is not automatically persisted or sent to a model.

#### Token effect

Neural speech status and synthesis add no model tokens.

#### KV Cache effect

Neural speech does not alter the model context or its KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This batch uses Chinese recognition with pinned small-q5_1 weights. It is not voice-activity detection, speaker identification, or real-time streaming. Optional Host neural speech is limited to the Vivian and Serena presets with no voice cloning; system narration still belongs to the client. The preparation recipe currently targets macOS arm64; Windows/Linux packaging and real microphone permission/device quality require their own acceptance. Test subprocess fixtures and offline synthesized audio are not a human microphone test. The local executable is an owner-selected trusted native program, not an untrusted wrapper or a general subprocess service.

Owner-local tests boot actual Cordis Loader, SessionStore and Connection registrations with controlled recognizer and neural-speech worker processes; they verify cancellation, teardown, byte admission and absence of Session writes. The product profile and authenticated physical transport are verified separately during integration. No invariant companion is published because one operation owner controls each slot, subprocess and temporary files, with lifecycle tests observing cleanup.
