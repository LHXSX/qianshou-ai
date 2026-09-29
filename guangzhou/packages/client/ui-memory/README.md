---
description: "Review local memory, inspect knowledge sources, and explicitly confirm candidate experience."
kind: "package-reference"
---

# Qianshou memory workspace

English | [中文](README.zh.md)

## Summary

Open **Memory & knowledge** to search confirmed records, inspect original text and revisions, and manage temporary, long-term, knowledge, and experience entries. Imported sources remain text. Candidate experience has a separate review view and requires an explicit confirmation before normal search can use it. Deletion requires confirmation because the Host removes the source and all revisions.

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

The sidebar entry opens the authenticated Host directory. Search by keyword and optionally filter by layer, confirmed/candidate status, or an absolute workspace path. The directory uses pages of 50 records. Layer counts describe the account's unexpired records, while the result count follows the selected filters.

Create a record or import a supported UTF-8 text, Markdown, code, or JSON file up to 512 KiB. Importing fills a local draft with the exact decoded text and source filename; Save persists it. The title permits 160 characters, source 2,000, and evidence 4,000. Temporary records retain data for 1–90 days, defaulting to seven. Personal records belong to this local account; workspace records require an absolute path. Editing a temporary record applies the displayed retention interval again from its save time.

Selecting an entry shows its original text, evidence, source, timestamps, and complete retained versions. Candidate experience is read-only until the user confirms it; dismissing a candidate removes it and its history. Every edit, review, and deletion supplies the revision the user read. A conflict retains the editing draft and reports the Host error; reopening the record reads its latest version. JSON export downloads the Host's records, revisions, and receipts for backup.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The browser registers `qianshou-memory` in the main panel and sidebar slots. Its controller uses same-origin authenticated requests to the Host memory routes, serializes mutations, ignores superseded list/detail reads, and aborts outstanding requests on plugin teardown. The page keeps unsaved drafts locally and asks before discarding them. File import strictly decodes UTF-8, preserving its BOM and line endings, and never parses or executes the text. React text rendering and textareas display source contents without treating them as HTML.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Local memory Host](../../host/memory-local/README.md): storage, access boundaries, expiry, and model tools.
- [Controller tests](tests/controller.client.spec.ts): authentication, revisioned actions, and stale reads.
- [Import tests](tests/import-text.client.spec.ts): original text and unsupported file rejection.

-----

<a id="model-experience"></a>
## Model Experience

### Browser controls

#### What the model sees

This browser package registers human controls only; the `Host` owns model-facing `memory_search`, `memory_read` and candidate submission tools. The page sends no prompt, tool schema or memory content to a model.

#### Token effect

No direct token effect occurs because the page does not assemble model requests.

#### KV Cache effect

No direct KV-cache effect occurs because the page does not assemble or send model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Search uses the Host's keyword index. The UI does not claim semantic embedding search or automatic factual learning.
- Import accepts supported UTF-8 text files only. PDF, images, office documents, and binary encodings are not parsed.
- Export creates a JSON backup; this package does not restore an entire exported vault. Ordinary JSON file import stores that file as source text.
- A listed source or passing component test does not prove a memory was retrieved during a live employee task. That requires assembled Host integration evidence.

<a id="dev-note"></a>
### Dev Note

No independent runtime invariant entry is published. Request lifetime and stale-response ownership are verified in the controller tests; persistence and access invariants belong to the Host.
