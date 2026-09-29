---
description: "Qianshou local-profile memory page with explicit owner review and bounded export."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qianshou-memory

English | [中文](README.zh.md)

## Summary

The Qianshou build adds Memory & knowledge to the sidebar and opens an independent main-column page. Other build profiles register no UI. The page explains that its library belongs to the current local data profile, not the signed-in cloud account. Cloud account changes neither migrate nor erase records. The [Host](../../host/qianshou-memory/README.md) owns storage, scope enforcement and retention.

## Table of Contents

- [Use](#use)
- [Request and export lifetime](#request-and-export-lifetime)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use"></a>
## Use

Select a record scope, search by keywords, or create a record. Save commits a draft; selecting a UTF-8 text file only imports an unsaved draft. File import accepts supported text extensions up to 512 KiB, rejects invalid UTF-8 and NUL bytes, and never scans directories or opens legacy databases. A late file read cannot replace a newer edit or selection.

Agent candidates are read-only pending explicit acceptance. Reject and delete actions require a confirmation that names the actual deletion scope. Original text and previous versions render as plain text. Current detail includes at most two historical originals; Load earlier versions requests another bounded page. Revision conflicts preserve the owner's draft and offer an explicit reload that discards it.

<a id="request-and-export-lifetime"></a>
## Request and export lifetime

The controller gives list, detail, mutation and page lifetimes separate response ownership. Scope and selection changes reject stale reads. Closing the page invalidates its pending reads and export; reconnect preserves drafts but rejects prior transport results. An already committed Host mutation is not described as rolled back when the view closes.

Export collects revision-checked pages before creating one `qianshou-device-memory.json` download. The complete export is limited to 16 MiB of serialized page bytes. Failure, concurrent mutation, closing the page or exceeding that limit produces no partial file. The limit notice asks the owner to keep the original vault; large-vault export is unsupported. Exported originals, history and receipts use the Host's format and contain no cloud credentials by design.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The Host controller owns knowledge mutations and export results; UI cache cannot establish the current owner or a completed operation.

</details>

<a id="model-experience"></a>
## Model Experience

### Owner knowledge controls

#### What the model sees

The `qianshouMemory` Remote serves owner controls. This page exposes no model tool and adds no conversation messages. Saved confirmed data becomes available only through the Host's scoped tools; candidate acceptance is a human decision, not a claim of training or automatic factual verification. The interface explains that retrieved passages may enter the selected model's tool context.

#### Token effect

Owner management and exports do not invoke a model or consume model tokens.

#### KV Cache effect

UI interaction does not change prior model messages or prompt prefixes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The page does not implement full backup restore, cloud synchronization, document OCR or cloud-account-private namespaces. System file-download handling and actual Host assembly require runtime verification in addition to component tests. No invariant companion is published: this feature presents Host snapshots and owns no independent durable state to reconcile.
