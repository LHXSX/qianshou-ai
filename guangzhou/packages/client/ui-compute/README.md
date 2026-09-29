---
description: "Inspect connected compute capabilities and save unpriced local task drafts."
kind: "package-reference"
---

# Qianshou shared compute workspace

English | [中文](README.zh.md)

## Summary

The optional **Shared compute** panel displays connection facts from the local compute bridge, lists its registered capabilities, and saves local task requirements. Saved cards stay unquoted drafts until the owner confirms and publishes. Confirm is local. Publish asks the Host to create a developer task. This package has no quote-acceptance, payment UI, or node-allocation action.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Task card projection](#task-card-projection)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser contribution beside the compute Host bridge in a supported profile. It registers `qianshou-compute` in the main and sidebar slots, and `compute_plan_draft` on `tool.call.toolview`. It reuses the agent's React application, shared controls, theme tokens, and locale service. It depends on no legacy Qianshou desktop client.

Refresh reads `GET /api/qianshou/compute/status`, `/capabilities`, and `/plans`. Configuration is displayed separately from the availability of workload lookup, quoting, and submission. A failed or malformed refresh clears the capability catalog instead of preserving stale readiness. An empty catalog offers no default capability and disables draft creation.

Select an available capability, enter a goal and a budget ceiling in yuan, and optionally set a concurrent node ceiling. The budget accepts at most two decimal places and is converted to safe integer CNY minor units. Zero means no paid execution. Manual node ceilings range from 1 to 64; this is a protocol limit, not a count of online nodes. Automatic selection is represented by `null` and does not choose or reserve nodes.

Saving posts the requirements to `/api/qianshou/compute/plans`. Confirming a conversation card posts `{ id, decision }` to `/api/qianshou/compute/plans/confirm`. Publishing posts `{ id }` to `/api/qianshou/compute/plans/publish`. The Host persists the draft, the local authorization, and the returned workload identity; the browser does not store credentials or plans in local storage. The card shows the user's budget separately from **No formal quote**. Failed saves retain the form for correction. Rapid submissions share the controller's mutation exclusion, with a synchronous form guard before its state publishes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The controller requests all three read resources before publishing one complete observation. Wire parsers reject malformed readiness, duplicate capabilities, invalid task requirements, non-draft statuses, and non-null quotes. There is no fallback price, fabricated speed estimate, seeded capability, or fabricated node count. Network access uses same-origin authenticated Fetch through the agent carrier.

<a id="task-card-projection"></a>
## Task card projection

`src/client/status-card.ts` exports the versioned, provider-neutral `qianshou.task-card.v1` projection. `projectComputeTaskCard()` folds capability availability, a scheduler's parallel recommendation, quote freshness, explicit authorization, submission state, task progress, result availability, and a stable error into one immutable object. A card can render planning, authorization, execution, completion, or failure without importing a provider SDK or sending a request. `parseComputeTaskCard()` guards a cached or event-delivered card before rendering it. The projection carries control-plane metadata only: it never contains credentials, media bytes, payment calls, or network submission behavior. The conversation row for `compute_plan_draft` projects persisted `tool/result.meta` into that card and overlays the Host-stored `authorization` and `workloadId`. Confirm and Decline rewrite only the local authorization field. Publish asks the Host to POST the developer-task route.

`RETURNED` projects to `returned` with `waiting` progress and an available result; it does not assert acceptance or settlement. Only the core's `SETTLED` state projects to `completed`. `PAUSED` and `OFFLINE` retain their respective phases, blocked progress, and accumulated fraction until a later task observation changes them. Every existing task projects to `submitted`, even when a caller retains an older `ready` submission value; it cannot become a fresh acceptance candidate through this projection.

The parser validates nested enums, nullable fields, canonical timestamps, nonnegative safe integer prices and node counts, bounded progress, quote freshness at the observation time, and lifecycle consistency. It rejects invalid payloads with `INVALID_COMPUTE_TASK_CARD` and returns the same object for valid data. Validation does not authenticate a producer, authorize execution, or verify result quality. A free task can remain `ready` without a quote, subject to the consuming agent's policy.

`apply()` owns the controller and dictionaries. Slot contributions wait for their owning slots, disappear when the owner or plugin leaves, and can return when the slot is redeclared. Plugin disposal aborts pending requests and ignores late responses. Components receive framework-bound snapshots and plain callbacks; no component imports another feature plugin's runtime or a Host service.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Compute core protocol](../../host/compute-core/README.md): shared requirement and connection types.
- [Controller tests](tests/controller.client.spec.ts): authentication failures, malformed responses, duplicate submissions, and disposal.
- [Page tests](tests/page.client.spec.tsx): empty catalogs, user budgets, and unpriced draft cards.
- [Web styling](../../../docs/web-styling.md): shared token and component ownership.

-----

<a id="model-experience"></a>
## Model Experience

### Browser compute panel

#### What the model sees

No model-visible content. This browser plugin renders `qianshou-compute` connection and capability controls for people; it registers no model tools, prompt sections, or session events.

#### Token effect

No token effect. Reading capabilities and saving a local draft do not add content to a model request.

#### KV Cache effect

No KV-cache effect. This package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Formal quotes, billing, refunds, and result retrieval are not implemented by this package. Local confirmation of a draft is not a Shanghai workload identity.
- File-shaped catalogue kinds cannot be published from a conversation goal. An unknown Host publish is never retried from this page.
- The page does not install plugins, configure core credentials, or enable idle resource contribution.
- A configured connection or successful local test does not prove production account access, node availability, paid execution, or settlement.

<a id="dev-note"></a>
### Dev Note

No independent runtime invariant is published. The page presents a single Host-owned projection; wire parsing and lifecycle tests cover its local assumptions, while persistence, pricing, and access invariants belong to the Host and compute core.
