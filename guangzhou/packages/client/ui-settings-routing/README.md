---
description: "Admin console for published-name routing: directory, append-only binding history, and future-dated bindings."
kind: "package-reference"
---

# Qianshou model-routing console

English | [中文](README.zh.md)

## Summary

The **Model routing** settings section is the administrator's console over the Host model gateway. It shows the published-name directory (the names users see), each name's full binding history including expired bindings, and the selectable backend keys. Its one write action appends a **future-dated binding**; existing bindings are never edited.

The console never renders an upstream model identifier (`deepseek-flash`, `deepseek-v4-pro`, …) as user-visible copy. Administrators see backend **keys** (`flash`, `pro`) and their concurrency ceilings as operations data, under an explicit note that users do not see this layer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Design rules the UI must not drop](#design-rules-the-ui-must-not-drop)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the browser contribution beside the model-gateway Host row in a supported profile; it registers the `routing` entry in the `settings.section` slot (order 20, after Models). It reuses the agent's React application, shared controls, theme tokens, and locale service.

The same contribution registers a separate `plugin-review` settings section (order 21) for Shanghai's pending marketplace submissions. The panel shows author, item type, price, device requirements, and exact publication blockers. An administrator enters a reason before approving or returning a submission. It calls the Host's authenticated `/api/qianshou/ai/admin/marketplace` bridge; the Shanghai service makes the final publication decision. Price and revenue share are read only in this phase.

Refresh posts to `POST /api/qianshou/ai/admin/names` and renders only what the response contains: `names` (record plus `history`), `backends` (`key`, `id`, `concurrency`), and — in the alternative shape the parser also accepts — a top-level `bindings` array. A malformed response is rejected atomically: the console shows "incomplete data" and never presents a partial directory as valid. A name the interface gives no history for keeps an empty history; the console says so instead of inventing one.

Appending posts to `POST /api/qianshou/ai/admin/bind` with `publishedName`, `backendKeys`, `effectiveFrom`, `reason`, and `rolloutPercent`. `operator` is deliberately absent: the Host fills it from the authenticated session, and a client-side self-report would break the audit trail.

Failure is presented by cause, not collapsed into one message. `401` means "not signed in, or the session expired"; `403` means "this account is not an administrator"; a `400` shows the Host's Chinese reason verbatim, because that text is what the administrator can act on.

## Understand the implementation

- `src/client/route-catalog.ts` — the React-free core: response validation, binding-history projection, the append form's validation, ordered-key editing, rollout bounds, and local-time conversion. Every rule that must hold before a request leaves the browser lives here.
- `src/client/controller.ts` — one directory read and one binding append over an injected `fetch`, plus the status-to-copy classification (`not-signed-in` / `forbidden` / `invalid` / `request-failed`).
- `src/client/RoutingConsoleSection.tsx` — the panel: directory cards with per-name history, the backend-key table, and the append form with its effective-time preview.
- `src/client/locales.ts` — Chinese copy (authoritative) with the English counterpart.
- `tests/` — pure-logic, controller, panel, and plugin-registration specs.

## Design rules the UI must not drop

1. **Append-only.** There is no "edit existing binding" control. Rewriting a binding would make past statements unexplainable, so the console offers exactly one write: a new future-dated binding.
2. **Never mid-billing-cycle.** There is no "take effect now". `effectiveFrom` is an explicit choice (24 hours / 3 days / 7 days / custom) with a preview that names the instant, and a past instant is rejected *before* the request — the panel explains "must be in the future" or "must be later than the previous binding (…)".
3. **Ordered backends.** `backendKeys` is a list, not a single key: the primary is answered first and the fallbacks follow. The form edits that order directly (move up/down, remove, append).
4. **Rollout is deterministic and bounded.** `rolloutPercent` is an integer from 0 to 100; `0` means the binding takes no traffic yet and `100` means all of it. The split is computed by the Host over name and request key, so neighbouring requests from one user never drift — the panel says this rather than implying randomness.
5. **Honest state.** An unauthenticated or non-administrator session shows the one actionable sentence and no directory content; the console never keeps a stale directory as valid fact.

## Model Experience

No model-visible content. This browser plugin contributes an administrator-facing settings section; it registers no tool, prompt section, or session event.

### Token effect

No token effect.

### KV cache effect

No KV cache effect. The package neither assembles nor sends provider requests.

## Known Limitations and Deferred Work

- The console **reads and appends**; it does not publish new published names, edit a record's tiers or output ceiling, or retire a name. The Host exposes no route for those, so no control exists here.
- Rollout is authored per binding, not per request cohort; there is no canary dashboard and no per-backend error-rate view.
- The effective-time preview uses the browser clock and the client's own time zone. It is a display convenience; the Host clock decides acceptance.
- Panel behaviour is verified in jsdom with fixture responses shaped exactly like the Host's. No browser end-to-end run against a live gateway is included, and mounting the section in a running bundle still requires the bundle row and a rebuild.

### Dev Note

The package publishes no runtime invariant companion. Its Host counterpart owns authorization (`fail-closed`), the append-only rule, and the effective-time floor; the client mirrors those rules to fail early and display reasons, and never treats its own validation as authorization.
