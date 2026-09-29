---
description: "Private device-owner knowledge vault with workspace access, human review and scoped Session tools."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-memory

English | [中文](README.zh.md)

## Summary

This service owns local knowledge for the current OS user and `DSH_HOME` profile. It is not a cloud-account-private library: signing in, signing out and changing cloud accounts neither transfer nor clear it. Device-owner records are available to authorized local agents; workspace records belong to stable registry ids. The [memory page](../../client/ui-qianshou-memory/README.md) manages records through the authenticated `qianshouMemory` Remote. No account plugin, credential or model request is needed for owner operations.

## Table of Contents

- [Ownership and use](#ownership-and-use)
- [Review, scope and retention](#review-scope-and-retention)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="ownership-and-use"></a>
## Ownership and use

The default new-format path is `$DSH_HOME/qianshou/device-memory/v1.sqlite`, with `~/.deepseek-harness` as the fallback home. `path` overrides that location for isolated deployments. The service never discovers or imports the legacy `qianshou/memory.sqlite`. Schema version one uses its own application id and a random vault id. Unknown formats fail before schema changes. Newly created files and directories use owner-only POSIX modes; this is not encryption or an OS sandbox.

`capacityBytes` defaults to 134217728 and limits retained titles, original content, sources and evidence plus serialized revision snapshots; it is not the SQLite file size limit. `expiryIntervalMs` defaults to 60000. Single documents are limited to 512 KiB, and temporary records expire after 1–90 days, defaulting to seven. Reads clean expired records before returning results. Reopening the same new-format database restores its records and vault identity.

<a id="review-scope-and-retention"></a>
## Review, scope and retention

Owner saves become confirmed records. Edits, acceptance and deletion require the current revision; stale operations preserve the newer record. Agent proposals are workspace experience candidates with evidence and actual Session/tool-call attribution. Candidates are read-only until accepted and invisible to Agent searches, reads and counts. Repeated calls under the same Session/call identity return the existing proposal; deletion or rejection prevents resurrection by the same call.

Every Agent access canonicalizes its actual Session cwd and matches the current workspace registry. Tool arguments cannot select another workspace. Unregistered or unavailable cwd permits confirmed device records only; proposals require a registered workspace. Removing a registry entry leaves owner-visible records, and registering the same path under a new id does not inherit the removed id's data.

Mutation, history, FTS indexing and content-free receipts commit together. Deletion, rejection and expiry remove original text, revisions and indexed passages. Receipts retain ids, actor, action and revision, not document text. Session tool results, exported files and external backups remain unchanged; SQLite secure deletion and checkpointing do not promise forensic erasure from SSDs or backups.

Owner detail reads include the current document and at most two previous versions. Additional history pages contain at most two versions and require an unchanged current revision. Export pages contain at most two original/revision records or 100 receipts, tied to one vault revision; mutation or expiry during export rejects subsequent pages. The Client's complete-file export limit is documented by its owning [UI package](../../client/ui-qianshou-memory/README.md).

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Local persistence and controlled fixtures do not establish a deployed owner service; record production identity and retrieval acceptance separately.

</details>

<a id="model-experience"></a>
## Model Experience

### Confirmed retrieval and proposed experience

#### What the model sees

The optional `./tools` consumer registers `memory_search`, `memory_read` and `memory_propose` in selected Agent presets. Search uses local Unicode word segmentation and FTS5 keyword matching, returns at most eight original passages, and does not claim semantic recall or factual verification. Read returns at most 3000 Unicode code points with a next offset. Tool JSON is bounded to 32 KiB. Proposals are limited to 16000 UTF-8 bytes and require human review; they cannot write device-wide knowledge or approve, edit or delete records. Documents are untrusted reference data. Tools instruct the model not to store credentials, hidden reasoning or entire conversations; this is not an automated secret-detection guarantee. Actual tool results follow the existing Tool runtime and Session log, and retrieved passages may therefore be transmitted to the model provider selected by that Session. The library itself performs no cloud sync or embedding requests.

#### Token effect

Tool schemas and retrieved passages consume ordinary tool-context tokens. The vault is never injected wholesale into a hidden system prompt. Saving and reviewing through the owner UI consumes no model tokens.

#### KV Cache effect

Retrieval adds ordinary logged tool calls and results. The plugin does not rewrite prior messages or replace the Session's prompt prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Scope checks protect these APIs; a fully authorized shell can still access files readable by the OS user. Windows permissions, full backup restore, cloud-account libraries, vector embeddings, automatic legacy migration and automatic fact learning are outside this package. Owner exports are backups of this format, not an implemented restore protocol.

Tests use new temporary SQLite files and real Loader, registry, AgentLoop and Session composition. Only the external model is deterministic; these checks do not establish real cloud-model autonomous retrieval. The service owns its transaction/index relationship synchronously, so it exposes no separate runtime invariant companion. The ownership rationale is recorded in the [device-vault decision](../../../.agents/notes/implemented/architecture/2026-09-21-qianshou-device-memory.md).
