---
description: "Browser Chat target that renders Session conversation nodes, historical images, actions, localization, and scroll state."
kind: "package-reference"
---
# @deepseek-ai/dsh-client-ui-chat

English | [中文](README.zh.md)

## Summary

Use this package to render a browser chat from recorded Session conversations, including historical images, localized actions, and restored scroll position. Compact display folds completed-turn process rows while keeping the final answer and independently useful context visible; packed historical Assistant runs remain collapsed. Local transcript and steering submissions appear immediately, remain in their original surface, and disappear atomically when authoritative Session records arrive, while queued submissions stay outside Chat. The package does not assemble or modify model requests.

File-mention providers receive the viewed Session ID with the closing-turn owner, so links into inherited history can address the fork itself.

## Table of Contents

- [Reference previews](#reference-previews)
- [Independent task receipts](#independent-task-receipts)
- [System prompt row](#system-prompt-row)
- [Turn token usage](#turn-token-usage)
- [Completed-turn footer](#completed-turn-footer)
- [Turn Process Folding](#turn-process-folding)
- [Scroll ownership](#scroll-ownership)
- [Voice collaboration](#voice-collaboration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="reference-previews"></a>
## Reference previews

Sent file references and skills confirmed by the message’s logged invocation open in the right Sidebar. File paths use the viewed Session; skill names resolve through its current input-trigger source. Both use the prose file-link dotted underline on hover or focus. Sessions, directories, and command labels remain non-navigating references.

<a id="independent-task-receipts"></a>
## Independent task receipts

An accepted parallel submission displays its recorded original message, images and files in the parent conversation, followed by an independent-task receipt. The receipt survives reload and appears even when the parent has no model turns. Selecting its record opens the accepted child; receipt arrival does not navigate. These rows remain outside parent-turn process folding and do not create model messages or token usage. Historical receipts without a recorded message show their saved label as a task summary, never as the original submission.

<a id="system-prompt-row"></a>
## System prompt row

Each nonempty appended `system/message` owns a collapsed prompt row, including a complete prompt at the start of a headerless window; the same-step header does not duplicate it. Chat also shows a collapsed `System prompt` row for a non-empty initial request, explicit message-series start, or `system/message` surface node replacement whose text differs, reading the last nonempty surviving system node in surface order at the `request/header`; a non-initial request whose preceding header is outside the loaded history window also shows one. A resume repeats the row even when its system text is unchanged, including after pagination supplies the preceding header and system node; same-series config-only or tool-only changes, tool steps, and retries create no repetition, and a `system/message` event is never rendered as a transcript message. The row appears before that request's user messages, matching the provider envelope, and expands to the exact model-visible text with its original line breaks. A request whose system node is empty or outside the loaded window creates no row until the page holding the node arrives.

<a id="turn-token-usage"></a>
## Turn token usage

A completed Turn shows an expandable usage row only when the loaded window includes `turn/start` and every started model attempt reports safe, exact usage. The row omits unavailable optional buckets. Incomplete or contradictory accounting hides the complete disclosure instead of presenting a partial total.

<a id="completed-turn-footer"></a>
## Completed-turn footer

The completed-turn action footer starts 20px below the preceding prose or extension content.

While the Session runs, a small robot animates inside the existing status row beside localized working text. The clock remains anchored to `turn/start`, appears after 15 seconds and stays outside live announcements. The robot disappears when running ends and remains static under reduced-motion preference; its movement indicates activity, not percentage progress. See the [activity-glyph decision](../../../.agents/notes/implemented/feature/2026-09-14-working-robot-status.md).

-----

<a id="turn-process-folding"></a>
## Turn Process Folding

Settings → General exposes a persisted, localized `Focus` / `Normal` / `Compact` conversation-display preference in the `ui-chat` namespace; `Compact` is the default. Normal leaves process rows visible and renders no Turn-process control. In Compact mode, the System prompt remains independently visible before the opening User throughout the Turn. Context injection, reasoning, Assistant material, Tool rows, and Retry rows remain expanded while a Turn is open. At `turn/end`, its latest Step becomes the final-answer boundary only when it contains non-blank text, an image, or an unknown visible block—and no Tool-call block; preceding Context injection, reasoning, earlier Assistant material, Tool rows, and Retry rows then collapse by default. The control reports Turn-wide durable counts for non-subagent Tool calls, reply-bearing Assistant messages before the final answer, and subagent delegation calls; zero-valued segments are omitted, the Tool and subagent figures are mutually exclusive, and neither System prompt nor Context injection contributes a count. When all three counts are zero, the process still folds and the control reads `Thought for a while`. A compact bordered summary separates the process from the answer. User and steering messages, System prompt, error, max-token, and turn-tail rows stay outside, and a closed Turn with no final answer keeps all process evidence visible. A newly available process control is inserted without changing the relative order of existing rows: opening human input precedes the control and process rows from their first projection, while System prompt remains above that input. While older history remains available through Load earlier, process controls stay absent and no members are hidden; once history is complete, every eligible closed Turn uses the collapsed default immediately. Stable Chat Node Seats keep every renderer mounted, hidden members add no flow spacing, and a closed control sits 8px above its answer only when no independent input intervenes. Completion collapse does not depend on tail-follow position, so a reader above the tail may see the transcript reflow. An automatic collapse that would hide keyboard focus keeps the group open and leaves focus in place; a manual close focuses the process control before hiding its members. The session-scoped store records only manually expanded Turn-and-answer-Step generations; a different answer generation starts collapsed.

Focus also groups live work: the newest visible Assistant reply, human input, dispatch receipts and failed Tool calls remain visible while earlier progress and ordinary Tool calls fold into the process summary. An explicitly expanded live process stays open across Steps; completion uses the normal final-answer boundary. The latest reply is projected across current Nodes so retained location objects cannot hide a new reply. Reasoning rows use a stable localized heading and reveal the original content on expansion; Tool rows show observed running, completed, failed or interrupted states. These presentation choices do not change model requests, task execution or transcript persistence.

-----

<a id="scroll-ownership"></a>
## Scroll ownership

Chat restores semantic anchors across history prepend and renderer remounts. Pinned scroll deliveries without reader movement update follow ownership immediately, before subsequent layout changes can invalidate their floor. Reader movement remains pending until the sampling interval or `scrollend`, even inside the follow threshold, so layout growth cannot erase small scroll gestures. While the reader is pinned to the floor, `ResizeObserver` follows the new floor and selects the latest loaded Turn without reading row geometry. Once the reader moves away, flow-height changes preserve the top position and the reading-line geometry selects the active Turn. Turn-rail previews paint above sticky Markdown code-block banners, while the rail frame remains inside the transcript band above the composer.

-----

<a id="voice-collaboration"></a>
## Voice collaboration

The composer dock opens the microphone only after an explicit user gesture. Local pause-based segmentation sends each utterance as 16 kHz mono PCM16 WAV to authenticated same-origin `/api/forge/voice/transcribe`. The default Voice concierge delivers the unchanged recognized text through the current Session's input machine: queue when idle, steer while running. The selected main Agent uses its logged conversation and existing tools to chat, clarify, delegate, and follow up; the browser does not classify intent or inject hidden instructions. The microphone resumes after submission so the user can continue talking while work runs. Text-composer delivery remains independent.

Explicit Parallel task delivery creates independent work through the existing dispatch route. Current-task delivery waits for its closed Turn before playback. A selected continuable child offers current-task delivery rather than silently redirecting speech to another Session. Playback uses only observed closed-Turn final answers, retains answers while the user speaks, and never reads intermediate reasoning. It subscribes directly to the selected Turn's keyed tail data, so a tail publication does not depend on a new top-level Chat snapshot. The user can interrupt playback to continue speaking; tools and approvals stay in the conversation.

Dictation only appends to the draft and never submits. Draft revisions, references, attachments, approvals and composer blocks are checked before automatic submission. End voice and Session teardown release capture and cancel transcription and speech; already submitted work keeps its ordinary Session lifecycle and separate Stop action. Transcription and speech failures pause voice mode with localized errors. Without browser speech synthesis, dictation remains available. Completed assistant replies also offer separate read-aloud and stop actions. See the [contextual voice decision](../../../.agents/notes/implemented/feature/2026-09-13-contextual-voice-concierge.md).

Playback queries the authenticated local [neural speech endpoint](../../host/voice-local/README.md). Available neural assets select its configured Vivian or Serena preset; a useful short opening sentence is synthesized first, and later short sentences are combined into bounded passages. Actual playback starts prefetching at most one successor WAV, so synthesis can overlap the current audio without starting a second player. Browser speech is available only before any neural identity is selected and only after explicit unavailable status or a missing status route; Chinese Tingting is preferred when present. A selected or already audible neural identity stays fixed across replies and read-aloud entries in the same window. Its later unavailability produces a visible failure instead of switching engines. System playback waits at most 600 ms for an initially empty voice inventory and pins one voice for the reply; without an enumerated voice, it submits one utterance instead of repeatedly selecting a changing browser default. Authentication, neural synthesis and audio playback failures remain visible instead of silently changing voices. Cancellation aborts pending requests, stops media and revokes object URLs; late responses cannot restart playback. While synthesis or playback startup is pending, the controller displays Preparing voice. Only actual media playing or system utterance start events switch it to Reading the reply. This complete-WAV path does not promise streaming first-audio latency.

During playback, automatic interruption monitors sustained microphone activity only if the acquired track confirms echo cancellation through getSettings. A confirmed onset stops the owned reply and preserves its opening audio for transcription. If echo cancellation is false or unreported, playback capture stays muted and the UI explains the manual interruption route. Typing or adding an attachment pauses voice and keeps the draft for the user to send; interruption never stops the task. Cancelled and queued old replies do not replay after resume. These local heuristics have deterministic PCM and lifecycle tests; physical microphone, speaker and room behavior still needs on-device acceptance and is not a full-duplex acoustic guarantee. See the [playback interruption decision](../../../.agents/notes/implemented/feature/2026-09-13-voice-playback-interruption.md).

Avatar consumers observe the read-only speech-playback subscription. Actual sentence starts carry a unique playback identity; end, cancellation and failure settle that identity. Subscribing mid-playback synchronously replays the latest active start. Neural events expose the existing media element and a verified WAV copy for local analysis without taking over audio output or capturing the microphone. System speech exposes playback state without fabricated PCM; the character keeps its mouth closed when waveform analysis is unavailable, while its idle pose remains independent.

The active voice controller appears beside a full-body VRM character on a transparent, non-modal stage. The canvas passes clicks through to the workbench; its small control strip keeps status, interruption during processing or playback, and End voice available. Voice settings remain mounted behind More voice controls. Paused errors and resume controls expand automatically without moving keyboard focus. Pause disables the microphone tracks and cancels pending transcription or playback without stopping accepted tasks; Resume is explicit.

Automatic replies, manual read-aloud and previews share exclusive audio ownership. Starting a new output cancels the previous player and queued passages, and returns its read-aloud button to idle. This cancellation does not report completion: another output pauses live capture and cancels any pending microphone-resume timer. Accepted tasks continue. The speaker picker preserves an unavailable selection and allows an explicit replacement. A delayed catalog response reads the current preference, and a temporary status failure cannot clear the controller selection. Previews do not replace the last audible reply identity. See the [voice identity decision](../../../.agents/notes/implemented/bug-fix/2026-09-14-preserved-voice-identity.md).

Previewing a speaker pauses microphone capture and cancels the current reply before synthesis begins. Preparing preview remains distinct from actual media playback; only the playing event publishes the shared read-only WAV observation. Stop preview, changing the speaker, resuming capture or ending voice cancels that owned player and closes its playback identity. Preview completion keeps capture paused until the user selects Resume, so the sample cannot become an automatically submitted utterance. Reply playback and previews share the same bounded WAV reader.

The handle supports pointer dragging and arrow-key movement within the viewport; Shift moves farther. The action menu offers a wave, walking along the bottom, climbing along either edge, leaning and sitting. Movement starts only after selection and respects reduced-motion preferences. Escape stops movement, closes expanded controls and returns focus to their toggle; it does not end voice. Character movement does not start microphone capture, submit a model request or control the operating system. The local model loads lazily; loading and failure stay visible, and Retry reloads the model without interrupting voice.

<a id="model-experience"></a>
## Model Experience

None, as this package renders logged conversation state in the browser and registers nothing model-facing.

#### KV Cache effect

None; Chat presentation does not assemble or mutate provider requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The transcript reflects the loaded Session window** — older transcript nodes become available only after Session Controller loads the preceding event page. Turn navigation is wider than the window: the rail merges the loaded Turns with the host `turnOutline` projection, so every started Turn gets a fixed-pitch mark (10px apart; a ladder taller than the frame scrolls inside it with gradient fades), and activating an unloaded mark pages history through the Turn's `turn/start` seq before landing on its row. Without the projection (assemblies not mounting `dsh-session-turn-outline`) the rail falls back to loaded Turns only.
- **Rail previews are card-sized** — one prompt line (50 characters) and up to three response lines (120), on loaded and unloaded Turns alike; an unloaded Turn's response arrives from the outline only once the Turn settled, so an open Turn previews its prompt (or just the Turn number) until then.


<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. Conversation and Slot registration enforce Chat target consistency.
