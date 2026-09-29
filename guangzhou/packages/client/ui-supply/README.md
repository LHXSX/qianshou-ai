---
description: "Inspect this machine's supply admission, capability advertisement and resource facts, and edit the owner contribution policy."
kind: "package-reference"
---

# Qianshou supply workspace

English | [中文](README.zh.md)

## Summary

Open **Supply management** to see whether this machine may take work, which capabilities the host acknowledged as advertised, and the resources behind both answers. Every fact comes from one authenticated observation whose time is shown on the page. Blocking reasons are listed one by one, and a fact the host did not report stays "unknown" instead of becoming zero, false or idle. The policy editor writes the complete owner policy, including the local rate settings it does not edit. No amount, earning, node count or quote appears here, because no settlement source exists yet.

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

The Qianshou web composition mounts this package through its ordinary client bundle and seats it in the same navigation list as the other workspaces. Open **Supply management** to read the current observation, then choose the participation mode, the concurrent task ceiling, the idle threshold and the free-memory floor.

### What the page answers

Four questions, each from measured data only. **Admission** shows the host state (disabled, blocked, ready) with every blocking reason spelled out, including a reason code this page does not document yet, which is shown verbatim rather than hidden. **Advertisement** shows whether the host acknowledged any capability, and lists exactly the acknowledged identifiers. **Facts** shows the platform, processor, memory, GPUs, probe errors and the activity facts (idle duration, foreground task, voice) with an explicit "unknown" for anything unmeasured. **Policy** edits the owner settings and reports what the save stored.

Selecting capabilities is opt-in and reversible: only a capability that passed its self-check can be enabled, an enabled capability the observation no longer discovers stays visible with its removal available, and an identifier the host policy parser would reject blocks the save with the identifier named instead of being silently dropped.

### Minimal configuration

The package declares no configuration fields. Mount it in a composition as an ordinary `dsh.client` row beside the compute core that owns the authenticated routes:

| Field | Default | Meaning |
|---|---|---|
| none | required | The row has no configuration; the workspace reads the compute core routes directly. |

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The controller](src/client/controller.ts) owns the projection over the two authenticated routes: one observation per refresh, one policy commit at a time, and an abort on plugin disposal. A failed observation keeps the previous snapshot only as `stale`, so its timestamped facts stay readable while the page states that the latest read did not complete. [The wire layer](src/client/wire.ts) re-validates every field, rejects a snapshot that contradicts its own state definitions, and keeps `null` as unknown instead of substituting a value. [The draft](src/client/form.ts) mirrors the host parser's rules and always submits a complete policy, so the rate settings this page does not edit survive a save. [The page](src/client/SupplyPage.tsx) renders the facts and the two finite actions; [the reason tables](src/client/reasons.ts) own the localized explanations of the host codes. Tests cover the wire contract, the draft rules, the controller races, the rendered page, the plugin seat and the narrow-screen declarations; a real Chrome pass measures the rendered page at phone, tablet and desktop widths.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Compute core](../../host/compute-core/README.md): the supply controller, local probe and authenticated routes this page reads.
- [Product direction](../../../docs/handoff/current/product-direction.md): what contribution means for the owner and the node.
- [Development plan](../../../docs/handoff/02-开发技术文档/新架构与插件化开发计划.md): the plugin layering this workspace belongs to.

-----

<a id="model-experience"></a>
## Model Experience

### Browser workspace over owner-authenticated supply routes

#### What the model sees

Nothing: this package contributes a browser surface only, and registers no prompt section, tool, schema or session event. It reads the authenticated route `GET /api/qianshou/compute/supply` and writes `POST /api/qianshou/compute/supply/policy`, both for the owner's own machine, and what the page renders never enters a model request.

#### Token effect

None. No request assembly path in this package produces model input; the model-facing tools over the same bridge belong to the compute core's tools entry.

#### KV Cache effect

None. The package neither assembles nor sends a model request, so no cached prefix depends on it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The page renders what the host reports; it verifies nothing itself, and it cannot run the local probe.
- Earnings, node counts, platform quotes and speed-up factors are absent by design: no settlement or dispatch source exists yet, so showing any number would be fabrication.
- No acceptance or dispatch action is offered, because the real task path is still being built and is not accepted.
- The rate settings inside the policy are displayed as a count only and are passed through unchanged; this page edits no amount.

<a id="dev-note"></a>
### Dev Note

None.
