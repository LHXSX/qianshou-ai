---
description: "Hold to transcribe into an existing Session, explicitly send on release, and stop local system narration."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qianshou-voice

English | [中文](README.zh.md)

## Summary

Hold the microphone control to capture one utterance and release it to add recognized text to the original draft. An explicit menu option sends from an empty draft through the ordinary queued input. Completed assistant replies offer cancellable narration using an enumerated local system voice. Recognition requires the separately configured local Host engine; UI animation does not establish device or task success.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Qianshou profile disables this browser plugin, so its microphone and narration controls are absent. When enabled, it mounts beside Conversation, Chat, Session UI and the generated `qianshouVoice` Remote. It contributes to existing slots and has no independent model or permission setting. The upstream profile contributes no voice controls. Host resource configuration belongs to [qianshou-voice](../../host/qianshou-voice/README.md).

The default release action inserts text. Sending on release requires an empty draft without attachments and always queues while the agent is busy. A changed draft revision, attachment set, Session instance, pending interaction or input block prevents automatic insertion or sending. The recognition result can then be explicitly added to the same Session draft. Slash-prefixed text remains in the draft for manual review.

Pointer release and Space/Enter release finish one recording; moving upward, Escape, loss of pointer capture or window blur cancels it. Screen-reader activation toggles start and finish. Recognition feedback appears above the input card. A refused permission, unavailable engine, busy engine, timeout or empty result remains visible without replacing the draft.

Read aloud starts only with an available local voice matching the UI language. Stop, a new narration, capture start, reply-view removal or window departure cancels owned output. Starting and playing are distinct states; voice enumeration and playback callbacks do not prove audible speaker output.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [controller](src/client/controller.ts) owns one capture generation and retains the concrete Session binding before permission or recognition. [Capture](src/client/capture.ts) loads a fixed package-owned AudioWorklet from a temporary Blob module, flushes its final frame and stops media tracks and the audio graph. Module URLs are revoked, including cancellation during loading; late permission results are discarded. The authenticated [binary upload](src/client/api.ts) carries the original Session and expected cwd without putting audio in Remote argument logs.

Conversation owns the revision-checked editor append and submission receipt. The voice plugin neither flattens reference chips nor creates another prompt path. [System speech](src/client/speech.ts) owns voice discovery, utterance callbacks, bounded playback and cancellation. No runtime invariant companion is published: this UI owns no independent durable Session or model projection; device and ASR outcomes remain explicit integration acceptance. The lasting design rationale is in the [voice ownership note](../../../.agents/notes/implemented/feature/2026-09-21-session-bound-voice-input.md).

</details>

<a id="model-experience"></a>
## Model Experience

### Ordinary user text

#### What the model sees

The package appends plain text with `SessionInput.commitExternalText`. Only text accepted through the ordinary Session input reaches the existing model and CEO flow. Dictation alone changes the local draft. Recorded audio, system voice objects and UI progress are not model messages; the package adds no model tool or system prompt.

#### Token effect

Accepted text contributes ordinary user-message tokens. Recording, recognition progress, draft insertion and local narration add no model tokens by themselves.

#### KV Cache effect

The package does not rewrite prior messages or add a prompt prefix. An accepted message extends the existing conversation through its normal input path.

## Known Limitations and Deferred Work

Source and controlled tests have narrower evidence than device acceptance.

- Recognition depends on separately installed local assets and the Host status; the client never downloads a model.
- Browser, development Electron, signed installed applications and each operating system need their own real microphone and speaker checks.
- There is one input/output owner per page; coordination between separate desktop windows is not claimed.
- The first version has no continuous listening, neural TTS or automatic narration. System output excludes code fences and image destinations and refuses responses over 20,000 characters.
- Speech interpretation can be wrong. Review dictated text; changing a draft cancels automatic application instead of overwriting user work.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Controlled fixtures do not establish real recording, audible output or model-task completion. Record those results separately for the exact runtime and device.

</details>
