---
description: "Read-only Qianshou capability catalog, scheduler health and server price estimate, kept as separate layers."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-capability

English | [中文](README.zh.md)

## Summary

The `qianshouCapability` Remote answers three read-only questions for the conversation card: what the Shanghai registry lists, how many workers the scheduler reports for one capability, and what the server estimates one capability would cost. No method here submits work, produces a quote id, locks a price, or reserves funds.

## Table of Contents

- [The layers never collapse into one another](#the-layers-never-collapse-into-one-another)
- [Live names and local contract copy](#live-names-and-local-contract-copy)
- [Failures are named, never empty](#failures-are-named-never-empty)
- [Configuration](#configuration)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="the-layers-never-collapse-into-one-another"></a>
## The layers never collapse into one another

A listed capability is not a runnable one: `catalog()` and `availability()` return `catalog-only`, and `availability()` reports `declared` and `availableNow` as independent counts, so a capability with four declared workers and none online reads as zero available rather than as absent. `availableNow` is what the scheduler reported at read time, never a reservation.

An estimate is not a quote: `estimate()` returns `estimate-only` and copies every amount verbatim as the server's decimal string. It publishes `fields`, mapping each projected name to the server field it came from, so the card can cite the origin of every number. Quotes, submission and the ledger are layers three and four; this package has no method for them.

<a id="live-names-and-local-contract-copy"></a>
## Live names and local contract copy

`catalog()` reads Shanghai's `registry_version` and `capabilities[]` response. It validates each capability name and the implementation and legacy task-type arrays before returning a view; an obsolete or malformed response is `invalid-response`, never an empty catalog. `loadContracts` reads `capabilities.registry.json` and `intent.schema.json` from one directory at startup, and a copy that is missing, unparseable or structurally wrong fails loud there rather than at the first request. Registry names must be lowercase and dot-separated with at least two segments; only the domain must start with a letter, because `render.3d` ships in the registry.

The catalog shows a newly listed Shanghai capability even if the local copy does not know it, with no invented title or estimate landing. A local landing appears on the card only while Shanghai lists that same `legacy_task_types` value. `estimate()` posts the first landing the local copy records for a capability; a capability the copy has no landing for, such as `accelerator.gpu`, is refused as `not-in-catalog` without a request. The card's intent subset is `goal` plus a nullable `budget`, validated against the contract's own schema nodes; the local budget cap is echoed back for display and never posted.

<a id="failures-are-named-never-empty"></a>
## Failures are named, never empty

Every unsuccessful read returns a named `CapabilityFailureCode` with the route it read and the HTTP status when there was one. No server body, no `detail` text and no credential value reaches a caller. `signed-out` means no account token was stored and no request was made at all, which is distinct both from `unavailable` and from an empty catalog. A 404 body carrying `detail.found === false` is `not-in-catalog`; an answer this package cannot project field by field is `invalid-response`.

The access-token reference comes from the built `qianshou-account` package export. The shipped Host must not import that package's TypeScript source path: ordinary Electron Node mode cannot execute TypeScript parameter properties.

<a id="configuration"></a>
## Configuration

`coreOrigin` defaults to `https://qianshousuanli.com` and must be an HTTPS origin with no path, credentials, query or fragment; plain HTTP is admitted only for loopback test servers. `contractsDir` defaults to the empty string, which selects the repository's `contracts/v1` copy, and must otherwise be a directory holding both contract files.

`timeoutMs` defaults to 10000 and bounds one attempt. `maxRetries` defaults to 1 and applies to reads only, because a `POST` estimate runs exactly once. `retryDelayMs` defaults to 500, `maxResponseBytes` to 524288, and a body over that bound or one that is not JSON yields no payload rather than a partial parse. `maxPending` defaults to 3; a request past it reports `busy` instead of queueing. Plugin disposal aborts in-flight requests, after which every method reports `closed`.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Registry metadata and local aliases do not grant platform approval or authorize execution.

</details>

<a id="model-experience"></a>
## Model Experience

### Read-only capability queries

#### What the model sees

Nothing. This plugin registers no model tool and appends no Session event; `catalog()`, `availability()` and `estimate()` answer client RPCs only. Whatever the card chooses to show a user is ordinary conversation input written later.

#### Token effect

None. These reads add no model tokens.

#### KV Cache effect

None. These reads do not alter the model context or its KV cache.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Quoting, submission, cancellation and billing are not here. `estimate-only` deliberately carries no `quote_id`, so nothing in this package can be mistaken for a locked price or a reserved balance.
- Every call is a fresh read with no cache, so two reads taken moments apart can disagree; `checkedAt` records when each view was taken.
- Titles are enriched from the local registry copy alone. An id the server lists but the copy does not know is still listed, with no title and no landing, rather than dropped or renamed.
- The scheduler's `by_impl` counts name implementations, not nodes, and this package does not verify that any of them can actually run the work.
- The default `contractsDir` resolves the repository `contracts/v1` copy, which exists in a source checkout only. A packaged Desktop application carries the same copy under its resources and points `QIANSHOU_CONTRACTS_DIR` at it; any other installed application must set that variable itself.
