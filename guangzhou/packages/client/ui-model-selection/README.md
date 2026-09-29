---
description: "Model selection for the Web GUI: the /model popup and the composer model seat over one per-session provider-grouped directory; for users and maintainers of model routing."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-selection

English | [中文](README.zh.md)

## Summary

The Web GUI lets users select a model and reasoning effort manually or enable task-based automatic selection through `/model` or the composer. Both surfaces share the same provider-grouped directory and routing policy. Automatic selection stays within the current provider's loaded candidates, while effort can remain automatic even with a manually locked model. The composer reports the last model actually used and the latest routing explanation. A running task keeps its resolved selection. If no adapter serves the route, the composer remains disabled until routing becomes available.

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

Mount this plugin alongside `ui-conversation` and the commands package; the composer then shows the model seat, and `/model` opens the same directory as a popup. Both surfaces show the Host-reported current policy. A manual selection uses its catalog name when available and its provider/model ids otherwise; missing catalog membership does not invalidate a routable selection.

### Model and effort

Models stay grouped by provider. The composer model list shows model names; `/model` also shows provider names and catalog descriptions, localizing matching built-in descriptions while preserving external descriptions verbatim. A manual model choice locks that provider/model pair. When effort is already automatic, either entry preserves that separate policy; otherwise the selected model's advertised default applies, with the popup preserving an explicit effort when reselecting the same route. The composer offers the advertised effort levels and an independent automatic-effort choice; choosing an explicit effort does not switch an automatic model policy to manual. There is no arbitrary effort input.

### Automatic selection

Choose the single **Auto** entry to enable automatic model and effort selection together. It is available only when the current provider has a loaded catalog of 1–64 models that includes the current model. The entry captures those candidate ids; it neither selects across providers nor imports another employee's configured interface. The same entry in `/model` submits the same policy. A later manual model choice takes precedence while retaining automatic effort if it was enabled.

The menu explains the provider boundary and the extra brief routing request per new task. Its **Last used** line reports the concrete model and effort from recorded requests, while the following explanation comes from the Host's latest routing decision. These records are distinct from the persistent Auto preference; they are not predicted choices or a simulated task status.

### Unroutable sessions

When the Host reports that no adapter serves the session's route, this plugin raises a composer block and the input goes inert with its own copy; recovering clears it without a reload. A `null` before the first load or after one failed never blocks, and catalog membership never blocks either — a route serving a model it does not advertise is missing from the groups yet usable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Two entries over ONE per-session directory owned by `ModelDirectoryResolver` (`ctx.modelDirectories`): the `/model` popupSelect contribution (registered through `ctx.commandUi`) and the composer's named `conversation.input.model` seat both load the session's advisory directory through `session.models` and submit through `session.selectModel` via the same `ModelDirectory` instance, so a switch made in either entry is what the other shows next. Directory loads and selections share a generation counter so an older response never overwrites a newer one; a connection reset drops every resident projection and repulls the Host-restored selection before display. Directories are per-session, resolved lazily, and disposed with the session scope; addressed subagent sessions expose neither entry. Every resident directory refetches directly on forwarded `llm/adapters-updated` and `settings/document-updated` owner events.

`routing-selection.ts` builds both entries' selections with separate `routing.model` and `routing.effort` switches. The directory exposes persistent intent, the recorded `lastUsed` selection and the latest `autoDecision` explanation separately. The Host owns candidate validation, task classification and execution; this UI does not send classification requests itself or silently widen a candidate list.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the model surface is not enough. They move from the browser surfaces to the command popup shell and the selection contract.

- [ui-commands](../ui-commands/README.md) — the popupSelect shell the `/model` contribution registers into.
- [ui-conversation](../ui-conversation/README.md) — declares the composer's `conversation.input.model` seat and the composer block.
- [dsh-agent-default-model](../../core/agent-default-model/README.md) — the default-model service for sessions that never choose.
- [Task automatic routing](../../../.agents/notes/implemented/architecture/2026-09-14-qianshou-task-auto-routing.md) — the Host's task boundary, provider isolation and failure behavior.
- [Client package map](../README.md) — adjacent browser UI packages.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `session.selectModel`, the Host resolves automatic selections per claimed human task, keeps each running task's selection stable, records routing failures without silently switching providers or retrying execution, and isolates employee-specific bindings.

#### KV Cache effect

Switching the route can reduce or invalidate provider-side cache reuse for subsequent requests; the prompt prefix itself is untouched.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define the current model surface. They are current package constraints, not a general model-router comparison or a task backlog.

- **No create-time or addressed-subagent selection** — both entries require an existing ordinary session's Agent; there is no draft-phase model choice to fold into session creation, and subagent continuation deliberately exposes no independent model-selection contract.
- **Bounded automatic candidates** — enabling Auto requires 1–64 loaded models from the current provider, including the current model. It is not an account-wide provider search or a claim that a catalog description ranks model quality.
- **Directory names are presentation-only** — selection and persistence use provider/model/effort ids; a provider whose catalog or exact-model metadata lookup fails lists as an unselectable failure row until reload.
- **No arbitrary effort input** — explicit levels come from the exact model's adapter metadata. The Effort row is absent when there is neither reasoning metadata nor an active automatic policy; automatic effort does not invent support for unadvertised levels.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The plugin registers a single command contribution, and the HMR-safety spec proves that the registration is disposed correctly. The plugin emits no Cordis events and owns no cross-plugin mutable state.
