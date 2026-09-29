---
description: "Standalone Qianshou AI operations console service: RBAC, audit trail, IP allowlist and upstream administration over one versioned HTTP API."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-admin-console

English | [中文](README.zh.md)

## Summary

The standalone admin service behind the Qianshou AI operations console. It serves one versioned HTTP API under `/api/qianshou/ai/admin` for account, subscription, payment and upstream-key administration, and it guards every route with a session cookie, role-based permissions and an optional IP allowlist. Module readiness is reported per area, so an area whose dependency is missing shows as read-only or unavailable instead of an empty list. The service runs as its own process and is the only writer of its audit trail.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Start the service with `createAdminService` (or `node src/main.ts serve`) and set `QIANSHOU_ADMIN_PORT`, which defaults to `7090`. Operators sign in through `/session/login` and `/session/login-totp`; the console front end then reads `/modules`, `/account/list`, `/subscription/list`, `/rbac/*`, `/audit/list` and the payment and upstream-key routes. Host plugins can import `createAdminService`, `API_PREFIX`, `SERVICE_VERSION`, `SESSION_COOKIE` and `peekJson` from the package entry instead of re-implementing the transport.

<a id="understand-the-implementation"></a>
## Understand the implementation

`server.ts` owns the route table, session cookie handling and JSON peeking; `rbac.ts` evaluates role permissions and preflights a role or administrator change; `audit.ts` records who changed what; `cidr.ts`, `client-ip.ts` and `whitelist.ts` resolve and enforce the caller's address; `data-sources.ts`, `pool.ts` and the upstream modules read and write the account service through explicit adapters. `modules.ts` reports each console area as ready, read-only or dependency-unavailable, so a missing upstream interface is visible rather than inferred from empty data.

## Model Experience

### Operations console service

#### What the model sees

Nothing: `createAdminService` authenticates operators, reads account and payment records, and writes audit entries, and it registers no model tool, prompt section or session event. The administrative records it returns are rendered in the console and never reach a conversation through this package.

#### Token effect

No token effect. No request-assembly path in this package produces model input.

#### KV Cache effect

No KV cache effect. The service neither assembles nor sends a provider model request, so no cached prefix depends on it.

The API management module uses `apiConnections.read` and high-risk `apiConnections.manage` under the existing session, IP and RBAC checks. POST `/api-connections/list|detail|preflight|apply|check` delegates only safe metadata to the durable Guangzhou node store. Preflight binds device/action/original UUID/state to the existing confirmation token; apply writes the operator, reason and before/after in both audits. A lost response is queried by the original ref, never automatically reapplied. `self` scope filters by the authenticated operator account owner. Pause blocks new dispatch; resume requires a fresh epoch; revoke permanently rejects that device credential. Existing unknown leases retain their real state and do not gain a synthetic terminal or settlement. Unique task counts and actual Shanghai settlement receipts are the only statistics; no monetary income is invented.

Set `QIANSHOU_ADMIN_API_CONNECTIONS_BASE_URL`, `KEY_ID`, `KEY_REF` and `AUDIENCE` (each with the same full prefix) to a dedicated localhost gateway service identity. The gateway uses `mediaNodes.adminControl` with only `nodes.read`/`nodes.manage`; the owner-only credentials ref is read afresh, without env fallback, redirects, user token or dispatcher credential reuse. An unavailable service returns 503 rather than an empty result. The public GET `/v1/nodes/probe?nonce=<UUID>` returns only the exact schema/service/nonce/current Unix time with no-store; reachability grants no qualification or task authority.

Every successful API-management list adds `qianshou.api-platform-integration.v1`: a fresh anonymous nonce probe of the public bootstrap `https://app.qianshousuanli.com`, its ISO UTC observation time, and allowlisted runtime configuration states. The public address can be explicitly set with `QIANSHOU_ADMIN_API_CONNECTIONS_PUBLIC_BASE_URL`; only a root HTTPS DNS origin without credentials, query, private IP or port is accepted. `QIANSHOU_ADMIN_API_CONNECTIONS_PROBE_TIMEOUT_MS` is 100–5000 ms (default 1500). Missing runtime projections remain `unknown`; a 200 probe never marks metadata, exchange, dispatch or commercial readiness as ready. No private origin, credential ref, token or local API address reaches this projection.

POST `/api-connections/guide` with an empty JSON object requires the existing `apiConnections.read` permission and returns credential-free version `2026-09-29.1` JSON/Markdown. It documents the actual POST node channel, registration, recovery, heartbeat and original-attempt media routes. Ordinary PC users explicitly confirm a mode and the Host registers automatically; an external machine's AI can implement this contract but cannot obtain identity, reviewed recipes or execution qualification by copying it. Empty-capability zero-slot registrations remain visible and unqualified. Unknown GPU submission recovers the original job read-only, and settled output resumes delivery only. The guide remains readable when private management is unconfigured; node counts do not become zero because a dependency failed. Run `node --test packages/host/admin-console/tests/api-connections.node-test.mjs` for real HTTP/SQLite, scope, fresh/stale challenge, timeout and credential-projection coverage.

## Known Limitations and Deferred Work

The node capability digest tuple does not include an image/video mode. Until a reviewed signed official profile-to-capability mapping is available, the safe admin projection returns `modes: []` (not yet verified for either mode), and self-reported names never establish a paid execution qualification. A registered online presence remains in the directory despite empty modes; research-service health never creates a device registration.

<a id="known-limitations-and-deferred-work"></a>

- This console is independent of the compute operations surface: it shares no route, role table or project with that console, so a role granted here grants nothing there.
- An IP allowlist is optional configuration. With no allowlist configured the service accepts any address that can reach the listener, so deployment must bind a private interface and supply the allowlist explicitly.
- An area whose upstream interface is missing stays read-only or unavailable rather than degraded to fabricated data, which means several console areas remain blocked until the account service exposes those interfaces.
- The audit trail is only as complete as the routes that write it; an operation performed directly against the upstream service is not recorded here.

<a id="dev-note"></a>
### Dev Note

Keep this service standalone: do not import the compute operations console, its role table or its project. Add a console area only with its route, permission check, audit entry and module-readiness row together, and never widen a role to unblock a screen.

`/models/overview` reads the active gateway model directory using a dedicated `models.read` service identity, and `/discovery/overview` reads official activities, visible pinned topics and open reports from the existing Guangzhou community store. `/order/overview` forwards the current verified operator account bearer to Shanghai’s global payment-order query and requires `order.read` with `all` data scope. These three overviews are read-only; binding changes, refunds and tickets remain separate unavailable write operations. Run `pnpm --filter @deepseek-ai/dsh-host-admin-console test:modules` for the real HTTP, persisted-content and credential-separation regression.

Author publication management uses exact authenticated records and server revisions for withdraw, delist, archive and restore. Lifecycle permissions come from Shanghai; cloud history without a matching local source is visible only in the explicit management read and never grants a local executor. Archive preserves contracts, entitlements and ledger history; restore only returns the record to the list.
