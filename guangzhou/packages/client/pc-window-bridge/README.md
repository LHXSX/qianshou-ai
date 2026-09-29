---
description: "Keep phone commands bound to the original PC conversation and distinguish local storage from verified PC receipts."
kind: "package-library"
---

# Qianshou phone-to-PC command window

English | [中文](README.zh.md)

## Summary

This library preserves a phone's commands for one account, PC and original conversation. It separates unsent local input, uncertain admission and verified PC receipts. It does not make the phone a compute node, copy the PC conversation into a separate history, or connect an account or gateway by itself.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Verification](#verification)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

An embedding PC-window application supplies an authenticated adapter, a clock, stable request identities and durable storage to `PcWindowController`. `IndexedDbWindowJournalStore` implements browser persistence; storage failure is reported instead of silently falling back to memory. This package is a library dependency, not an installable profile, background phone worker or mobile application.

Bind the current account, target PC, original session and source device before accepting input. An unavailable or unauthorized adapter exposes no local conversation projection. Offline authorized input is saved as `queued`, meaning **not delivered**, and can be withdrawn before sending. `enqueue` resolves after local persistence; it does not wait for any PC task to finish. A snapshot reports errors and delivery states for the embedding UI to localize.

`flush` attempts queued admissions independently. `refresh` rechecks account access, reads verified receipts from the saved cursor and retries only commands explicitly confirmed as not received. After a transport failure, an uncertain command is not silently resent or reported cancelled. `disconnect` hides current data and aborts local requests without cancelling PC tasks. `forget` removes the bound origin's local journal; original PC history and work remain owned by the PC.

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The journal stores user-command echoes, receipt observations and a receipt cursor. It does not store model credentials, balances or a replacement conversation log. The IndexedDB key includes account, target PC, original session and source device. Compare-and-save revisions reject competing browser-window writes. A reconnect waits for existing local commits before reading the journal, and a recovered `delivering` record becomes `uncertain` because the PC might already have admitted it.

Commands retain an explicit expiry and request identity. Independent input corresponds to the existing PC `SessionParallelRequest`; append and cancel carry an explicit target and expected revision. The authenticated adapter must verify ownership, supported actions, expiry, current target revision and admission deduplication before using any PC method. The library does not map a cancel command directly to `ISession.cancel`, whose current signature has no revision precondition. Companion file/terminal protocols do not establish a phone-session gateway.

Receipt parsing checks complete origin, command identity and revision before mutation. Dispatch admission requires a returned child session. Older observations do not replace newer ones; a newer receipt cannot change the admitted child or reverse a terminal delivery decision. A received cancel command is not confirmed cancellation. `received` never means a completed task, accepted output or financial settlement. PC results remain accessible through the original Session's existing history and follow streams once an adapter connects them.

</details>

<a id="verification"></a>

## Verification

Run `node node_modules/vitest/vitest.mjs run --config packages/client/pc-window-bridge/tests/vitest.config.ts` for fixture-based delivery and boundary tests. They exercise independent commands, ambiguous admission, expiry, origin/cursor mismatch, revision ordering, unsupported cancellation and persistence failure. The fixture adapter neither logs into an account nor executes a real PC task.

Run `node packages/client/pc-window-bridge/tests/browser/verify.mjs` for actual Chrome IndexedDB reload, namespace isolation, competing-write rejection and explicit deletion. The script writes `.artifacts/mobile-pc-window-browser/evidence.json`, marks gateway responses as fixtures and deletes its test database. It does not represent a real phone, real account or installed application.

<a id="further-exploration"></a>

## Further Exploration

- [Controller contract](src/controller.ts): lifecycle and observable delivery state.
- [PC Session types](../../api/session-controller/src/types.ts): existing independent admission identities.
- [PC Session consumer](../../api/session-controller/src/client/contract/session.ts): existing conversation operations.
- [Implementation decision](../../../.agents/notes/implemented/feature/2026-09-15-qianshou-pc-window-outbox.md): reasons for receipt and persistence boundaries.

<a id="model-experience"></a>

## Model Experience

### Local command delivery

#### What the model sees

`PcWindowController` makes no model request and appends no Session event. A verified PC adapter owns the existing logged admission of accepted user content.

#### Token effect

Local journal writes and receipt reconciliation make no model calls or conversation copies.

#### KV Cache effect

No additional prompt prefix or model-cache change.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- No production same-account PC gateway or receipt adapter is installed. Internal port types name no online endpoint. The embedding application must provide an authenticated adapter; type declarations are not proof of authorization.
- The package does not implement login, device enrollment, background delivery, push, voice, mobile rendering, task-result assets, subscriptions, payment or an installable phone App. It registers no phone contribution, capability heartbeat or unattended task acceptance.
- The journal retains at most 500 commands and requires a caller-selected expiry. No retry count, quota, price, revenue share or retention policy is implied. Storage holds user text locally; account switching hides that projection, while explicit forgetting deletes that origin's stored journal.
- A receipt cursor restores command observations only. Same-account access to the full original PC conversation and real cross-device controls remain separate integration acceptance. The existing PC voice, avatar, team, memory and device features remain outside this package's edit scope.

<a id="dev-note"></a>

### Dev Note

The source belongs to the independent taskcards input for the preserved 0.2.1 integration. Root graph and real adapter assembly belong to the main integrator. The matching Host project reference is `session-controller/tsconfig.host.json`; the aggregate config is not composite and cannot serve as a direct reference. Module checks do not establish production gateway or mobile acceptance.
