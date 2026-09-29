---
description: "Status of the opt-in Qianshou vision adapter, reported as driver assembly, OS grants and model route separately."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-vision

English | [中文](README.zh.md)

## Summary

The `qianshouVision` Remote answers whether this Host can actually see a screen, and it answers in three parts: is a computer-use provider assembled, does the operating system grant desktop access, and does the default model route accept images. No method mounts a driver, changes a model route, installs a provider, or grants anything.


## Table of Contents

- [Three facts that never collapse into one readiness flag](#doc-section-1)
- [The permission probe belongs to the provider](#doc-section-2)
- [The route fact asks the adapter, not the configuration](#doc-section-3)
- [Configuration](#doc-section-4)
- [Model Experience](#doc-section-5)
- [Known Limitations and Deferred Work](#doc-section-6)
- [Dev Note](#dev-note)

<a id="doc-section-1"></a>
## Three facts that never collapse into one readiness flag

Each fact is read from the component that owns it, so a partial setup stays diagnosable instead of reading as a single failure. A registered driver with granted desktop access and a text-only model is a different problem from an image-capable model with no driver, and both differ from a driver whose permissions were never granted. One merged boolean would erase that difference and send the user to the wrong setting.

`driver` distinguishes three assemblies: `absent` when the shared computer-use service is not even mounted, `service-only` when it is mounted with no provider registered, and `registered` with the provider's name. The provider slot is exclusive and optional by design: its absence is a reported fact, never an activation failure, so this plugin loads on a machine that has no vision adapter at all.

<a id="doc-section-2"></a>
## The permission probe belongs to the provider

This package owns no permission check. It looks for a tool whose name ends in `check_permissions`, either bare or after a provider prefix, which matches how the Cua Driver providers publish theirs (`cua_driver_native__` natively, `mcp__cua-driver-mcp__` over MCP), and calls that. When the registered provider publishes no such tool the state is `unknown` with reason `no-probe-tool` and no tool runs; nothing is inferred from configuration.

The probe's answer is read as data, never as text: both `accessibility` and `screen_recording` must arrive as booleans in the result's `structuredContent`, and anything else is `unknown` with reason `unrecognized-result` rather than an optimistic guess. `state()` always probes with `prompt: false`, which reads current grant status without raising a dialog. `requestPermissions()` is the explicit user action that probes with `prompt: true`, and it pins `probe_direct_capture: false` so a grant request stays limited to Accessibility and Screen Recording and never adds the driver's direct-capture consent.

<a id="doc-section-3"></a>
## The route fact asks the adapter, not the configuration

Image acceptance comes from the same lookup screenshot admission performs before storing an image: the default model route recorded in settings, resolved through the adapter that owns that provider. A route the adapter cannot resolve is `unresolvable` and still names the provider and model it tried, so the user sees which route failed. A route whose adapter discloses no modalities is `modalities-undisclosed` with `acceptsImage: null`, which is distinct from an adapter disclosing an empty modality list: that answer is a disclosure, so it reads as `acceptsImage: false` with no reason.

<a id="doc-section-4"></a>
## Configuration

`probeTimeoutMs` defaults to 15000 and is the whole-integer millisecond budget, between 1000 and 120000, shared by one read's permission probe and its route lookup; a cold driver launch on a slow desktop needs more than a warm one. Disposing the plugin aborts a read already in flight, and a probe cut short that way reports `probe-failed` like any other unanswered probe.

<a id="doc-section-5"></a>
## Model Experience

### Screen status reads

#### What the model sees

Nothing. The `qianshouVision` plugin registers no model tool and appends no Session event; both methods answer client RPCs only. The permission probe it calls is the provider's own tool, which the provider already published to the model independently of this package.

#### Token effect

None. No status field reaches a model request through this package.

#### KV Cache effect

None, for the same reason: nothing here participates in prompt assembly.

## Known Limitations and Deferred Work

<a id="doc-section-6"></a>

- There is no client card yet, so the three facts are available over RPC but no window shows them. Build one when a vision provider ships in a profile users install; until then the facts exist for whoever asks.

- `requestPermissions()` reports the status the probe returned when it returned, which on macOS is the status before the user answers the system dialog. A caller that wants the post-answer state calls `state()` again after the user acts.

<a id="dev-note"></a>
### Dev Note

None.
