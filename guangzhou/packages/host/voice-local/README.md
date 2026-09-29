---
description: "Configure local Chinese transcription and optional neural speech for authenticated clients, with bounded requests, private files and cancellation."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-voice-local

English | [中文](README.zh.md)

## Summary

Browser clients can transcribe short Chinese recordings with whisper.cpp and synthesize replies with an optional local Qwen3-TTS worker. Voice data stays on the receiving Host. Requests have explicit limits and cancellation; local models are installed separately. Sending transcribed text to an Agent remains a separate client action.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Use this package when an authenticated client needs local transcription or neural speech. It does not open the microphone or dispatch a Session message.

### Configuration and prerequisites

The [web-app composition](../../bundle/web-app/cordis.patch.yml) mounts this function plugin with the existing [Connection](../../client/connection/README.md) service. A custom composition uses the same plugin row after providing Connection:

```yaml
- name: '@deepseek-ai/dsh-host-voice-local'
  config:
    uploadTimeoutMs: 30000
    recognitionTimeoutMs: 90000
```

| Field | Default | Meaning |
|---|---|---|
| `uploadTimeoutMs` | `30000` | Maximum time to read the audio request body, in milliseconds |
| `recognitionTimeoutMs` | `90000` | Maximum recognizer process time, in milliseconds |

Both fields accept positive integers up to `2147483647`. The executable defaults to `~/.local/share/forge-voice/whisper.cpp/build/bin/whisper-cli`; the model defaults to `~/.local/share/forge-voice/models/ggml-small-q5_1.bin`. The Host environment can override them with `FORGE_WHISPER_BINARY` and `FORGE_WHISPER_MODEL`. This package does not download or install either asset.

### Requests and failures

Connection authenticates both routes. `GET /api/forge/voice/status` returns `{ available, engine: 'whisper.cpp', language: 'zh' }`; availability checks executable and model access, not recognition accuracy. `POST /api/forge/voice/transcribe` accepts a WAV body and returns `{ text }`. An empty string means the recognizer produced no text or only a bracketed non-speech marker.

The request must use `audio/wav`, `audio/wave`, or `audio/x-wav` and contain mono PCM16 audio at 16 kHz, with 0.1–120 seconds of samples. The complete upload is bounded to 3,844,096 bytes. Actual streamed bytes are checked even when `Content-Length` is absent or false; the caller cannot submit a server file path.

Failures return `{ error }`: unsupported media is `INVALID_AUDIO` (415), excessive bytes are `INVALID_AUDIO` (413), malformed PCM is `INVALID_AUDIO` (400), missing assets are `VOICE_UNAVAILABLE` (503), and a concurrent request is `VOICE_BUSY` (429). Upload or recognizer deadlines return `VOICE_TIMEOUT` (504); caller cancellation or plugin disposal returns `REQUEST_ABORTED` (499). Other recognition failures return `TRANSCRIPTION_FAILED` (500). Responses disable caching.

### Optional neural speech

Configure `ttsPythonPath`, `ttsWorkerPath` and `ttsModelPath` together as absolute paths to a trusted Python executable, JSONL worker script and complete local Qwen3-TTS CustomVoice model directory. When all three paths are empty, the Host reads the launcher environment variables `FORGE_TTS_PYTHON`, `FORGE_TTS_WORKER` and `FORGE_TTS_MODEL` together. Explicit paths take priority as a complete group; an incomplete group never borrows an environment path. Absent assets disable synthesis; partial or relative paths fail plugin configuration. No model installation, network synthesis, voice cloning or executable path is accepted from a client.

| Field | Default | Meaning |
|---|---|---|
| `ttsDefaultSpeaker` | `Vivian` | Preset used when omitted; only `Vivian` and `Serena` are allowed |
| `ttsMaxTextChars` | `500` | Unicode code-point limit per request, configurable from 1 to 2000 |
| `ttsRequestTimeoutMs` | `180000` | Queue, cold load and synthesis deadline, at most 600000 ms |
| `ttsMaxOutputBytes` | `8388608` | Complete WAV limit, from 46 bytes to 32 MiB |
| `ttsMaxQueuedRequests` | `2` | Waiting requests beside one active operation, from 0 to 8 |
| `ttsIdleTimeoutMs` | `300000` | Loaded-worker idle lifetime, at most 3600000 ms |

`GET /api/forge/voice/tts/status` returns `{ available, ready, engine: 'qwen3-tts', speakers: ['Vivian', 'Serena'], defaultSpeaker }`. `available` checks configured paths and readable model assets; it does not prove weights are complete or synthesis works. `ready` means the running worker acknowledged model load. `POST /api/forge/voice/synthesize` accepts JSON `{ text, speaker? }` and returns mono PCM16 WAV at 24 kHz. It rejects unknown fields. The complete JSON body is limited to 16 KiB and uses `uploadTimeoutMs`. Both endpoints use Connection authentication and disable caching; no independent server is opened.

Missing assets return `TTS_UNAVAILABLE` (503), excess active/waiting requests `TTS_BUSY` (429), invalid JSON/text/speaker `INVALID_TEXT` (400), unsupported media 415, and an oversized declared body 413. The request deadline returns `TTS_TIMEOUT` (504); cancellation returns `REQUEST_ABORTED` (499). Worker errors, malformed or excessive WAVs and mismatched output paths return `SYNTHESIS_FAILED` (500), without worker diagnostics. Only explicit unavailability permits a client to choose a system voice; a failed neural request must remain visible.

The trusted worker receives `--model <directory> --output-dir <private-root>` and writes one JSON object per stdout line. It emits `{ "type": "ready" }` only after local loading, accepts `{ id, text, speaker, outputPath }`, then replies `{ id, ok: true, path }` or `{ id, ok: false, error }`. Success must identify the exact requested path. Ordinary model logs belong on stderr. The worker must constrain output to its root, use the fixed natural conversational style and reject truncated speech; the Host independently checks output files and WAV format. Python receives an explicit environment with Hugging Face offline mode and no inherited Host credentials.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The route owns one request from bounded upload through recognizer settlement. Cancellation releases a stalled body reader without waiting for an unresponsive carrier cancellation callback. A fixed-size buffer prevents many tiny chunks from multiplying retained upload metadata. Plugin disposal aborts active work and waits for its request to settle.

The engine writes into an exclusively owned temporary directory with private POSIX modes and launches the configured binary without a shell. Cancellation force-stops the recognizer; cleanup waits for the process's actual close event before deleting audio and transcript files. The process receives a small explicit environment instead of inherited Host secrets. It runs under the Host user's privileges; these controls do not constitute an operating-system sandbox.

| Source | Responsibility |
|---|---|
| [index.ts](src/index.ts) | Configuration, authenticated routes, upload bounds and request lifetime |
| [wav.ts](src/wav.ts) | PCM format and sample bounds |
| [engine.ts](src/engine.ts) | Asset probe, local process and private file cleanup |
| [tts-config.ts](src/tts-config.ts) | Explicit neural asset and limit resolution |
| [tts-routes.ts](src/tts-routes.ts) | Neural status, bounded JSON requests and WAV responses |
| [tts-engine.ts](src/tts-engine.ts) | Serial queue, deadlines and PCM validation |
| [tts-process.ts](src/tts-process.ts) | Persistent JSONL process and private output root |

The [lifecycle decision](../../../.agents/notes/implemented/feature/2026-09-13-bounded-local-voice-transcription.md) records alternatives and verification. The package publishes no `./invariant` companion: it has no independently published observations to reconcile, and validates its owned request at admission and settlement.

Neural synthesis uses an independent slot and a persistent process. Cancelling queued work leaves active synthesis running; cancelling active work force-stops its process group before cleanup. The next admitted job loads a new worker. Idle shutdown and plugin disposal also await process close; request subdirectories and the worker's private root are removed only under their owner's lifetime. The [neural speech decision](../../../.agents/notes/implemented/feature/2026-09-13-bounded-neural-speech.md) records this process policy.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../../client/connection/README.md) — authenticated Fetch transport
- [Conversation UI](../../client/ui-conversation/README.md) — Session input ownership
- [Chat UI](../../client/ui-chat/README.md) — browser voice controls
- [Lifecycle decision](../../../.agents/notes/implemented/feature/2026-09-13-bounded-local-voice-transcription.md) — rationale and test boundaries

-----

<a id="model-experience"></a>
## Model Experience

None, as this package returns transcription text or synthesized audio to an authenticated client without registering an Agent prompt, tool, or Session message.

#### KV Cache effect

No direct effect. This package does not create or modify an LLM request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

This local transcription endpoint has a bounded scope:

- **Chinese WAV only** — language is fixed to `zh`; arbitrary codecs, streaming partial transcripts and language selection are unavailable.
- **Single Host-wide request** — a busy recognizer rejects another upload instead of queueing it. Assets must be installed separately; a successful status probe does not prove usable recognition.
- **Platform validation** — real-process cleanup tests use POSIX executables. Windows binary selection, environment, permissions and process cancellation require native acceptance; this package does not claim it.
- **Neural deployment and latency** — model installation, compatible MLX runtime and real-machine audio acceptance are separate requirements. Cold loading and complete-WAV generation delay playback; there is no streamed audio response or guaranteed first-audio latency. Microphone echo cancellation and full-duplex interruption are client concerns and are not established by these routes.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
