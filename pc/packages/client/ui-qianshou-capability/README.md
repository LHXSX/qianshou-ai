---
description: "Read-only Qianshou capability catalog, scheduler counts and server estimates as one settings section."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qianshou-capability

English | [中文](README.zh.md)

## Summary

Qianshou builds add a section under Settings → Advanced that shows what the scheduler lists, how many workers answer for a selected capability, and what the server estimates a run would cost. Other profiles return from `apply` before registering a locale, a slot or a listener, so no other build carries the section or its Remote dependency. The [Host](../../host/qianshou-capability/README.md) owns every request, every number and every failure name; this component only displays what it reads.


## Table of Contents

- [Use](#doc-section-1)
- [Model Experience](#doc-section-2)
- [Known Limitations and Deferred Work](#doc-section-3)
- [Dev Note](#dev-note)

<a id="doc-section-1"></a>
## Use

The section reads the catalog when it mounts and again after a reconnect, because the Host may have signed in while the window was disconnected. Selecting a capability reads the scheduler's counts for that capability alone. An estimate is an explicit form submission: it needs a goal, and the local budget cap is optional. No action here creates a quote, reserves funds or submits a workload.

The section is labeled Compute diagnostics. An unsupported local estimate is not a refusal of the separate market invocation contract; the copy directs users to @ or the conversation ability board for a current quote without claiming that any particular market ability is callable.

The three reads stay in three fields and three blocks on screen. Changing the selection clears the previous availability and estimate rather than carrying either onto the next capability, and an answer that a newer selection superseded is discarded instead of rendered. A capability the local registry has no task type for is listed but cannot be estimated; the estimate button stays disabled and says why.

Four outcomes are distinct and separately worded: no session, an empty catalog, a named server failure with its HTTP status, and a failure of the RPC itself. An initial RPC failure replaces the loading state with an error; a failed refresh keeps the last catalog that was actually read and shows a warning beside it. The read-limit failure has its own copy so it never reads as the "reading" indicator.

<a id="doc-section-2"></a>
## Model Experience

### Capability reads

#### What the model sees

The `qianshouCapability` section registers no tool and contributes no prompt text. Opening it, refreshing the catalog, selecting a capability or requesting an estimate sends no user message and adds nothing to the conversation.

#### Token effect

These reads consume no model tokens. Estimated amounts describe a prospective workload run priced by the server, not model usage.

#### KV Cache effect

The section does not modify conversation history or any model prompt prefix.

## Known Limitations and Deferred Work

<a id="doc-section-3"></a>

- Amounts are rendered exactly as the server sent them, with no local arithmetic, currency conversion or rounding, and the currency field accepts free text rather than a validated code list. The panel cannot submit a workload, so the path from an estimate to a real run is not exercised here. Component tests drive the Remote through a double; catalog entries, worker counts and prices from the deployed scheduler require running-app acceptance. No runtime invariant companion is published because this component holds only disposable views of Host state.

<a id="dev-note"></a>
### Dev Note

None.
