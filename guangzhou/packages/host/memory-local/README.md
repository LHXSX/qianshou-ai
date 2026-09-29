---
description: "Store and retrieve scoped local memory with provenance, reviewable experience candidates, and preset-bound model tools."
kind: "package-reference"
---

# Qianshou local memory

English | [中文](README.zh.md)

## Summary

Store user and workspace records in a private SQLite vault, search confirmed entries, inspect provenance and revisions, and review proposed experience before retrieval can use it. The Host keeps workspace records isolated, expires temporary notes, and exposes bounded memory tools only to explicitly selected presets.

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

Mount `@deepseek-ai/dsh-host-memory-local` with the authenticated Connection service. Mount `@deepseek-ai/dsh-host-memory-local/tools` only in presets that may search or propose memory. Set `path` to an absolute SQLite file when the default `$DSH_HOME/qianshou/memory.sqlite` is unsuitable.

The Host routes list, read, save, review, delete and export operations under `/api/qianshou/memory`. Records can be personal or workspace-scoped; workspace reads require the active session workspace. Temporary records retain data for 1–90 days, and experience records remain candidates until the owner accepts them.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Storage, access and tool responsibilities</summary>

`MemoryStore` owns SQLite records, revisions, workspace filtering, expiry and optimistic revision checks. The Host routes keep source text as text and return stable memory errors. The tools consumer registers `memory_search`, `memory_read` and `memory_note`; each read requires the active Agent workspace, and proposed experience never enters confirmed search without owner review.

The package does not parse source text as instructions, expose credentials, or provide arbitrary file and database commands. Browser controls belong to [ui-memory](../../client/ui-memory/README.md), while this package owns the storage and model-tool provider.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Memory workspace](../../client/ui-memory/README.md) — browser search, editing and review controls.
- [Tools subsystem](../../../docs/subsystems/tools.md) — policy and durable tool-call records.
- [Local memory source](src/index.ts) — Host routes and configuration.

-----

<a id="model-experience"></a>
## Model Experience

### Memory tools

#### What the model sees

The selected preset receives `memory_search`, `memory_read` and `memory_note`. Results contain bounded text, provenance and revisions from the active workspace. Source documents are untrusted reference data, not instructions or credentials; experience proposals require owner review.

#### Token effect

Three fixed tool schemas join the enabled preset. Search and read results add only the requested bounded passages; memory is not copied into context automatically.

#### KV Cache effect

Tool definitions stay fixed while records change. The selected query and bounded result text affect later request content, while enabling or disabling the tools changes the schema prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Search is keyword-based and does not provide semantic embeddings or automatic factual learning.
- The vault accepts bounded text fields; PDF, image, office-document and binary parsing belong to another provider.
- Local SQLite access is protected by application checks, not an OS sandbox; privileged local operators can inspect or alter the file.
- A passing local test or visible record does not prove retrieval during a live employee task; that requires assembled Host integration evidence.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>
