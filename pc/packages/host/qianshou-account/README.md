---
description: "Private Qianshou PC account service: login, renewal, catalog access, and cancellation of managed model calls."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-account

English | [中文](README.zh.md)

## Summary

This private plugin owns the Qianshou account lifecycle in one Host. Shanghai is the identity authority; Guangzhou accepts its user access token for the model catalog and model requests. The Remote response contains only identity, status, safe failure codes, model ids, and route selection. Passwords, token pairs, and pending TOTP challenges never appear in that response or conversation history.


## Table of Contents

- [Configuration and use](#doc-section-1)
- [Credential and lifecycle ownership](#doc-section-2)
- [Model Experience](#doc-section-3)
- [Known Limitations and Deferred Work](#doc-section-4)
- [Dev Note](#dev-note)

<a id="doc-section-1"></a>
## Configuration and use

The Qianshou web composition enables this service only under the `qianshou` build profile. `accountOrigin` defaults to `https://qianshousuanli.com`, `gatewayBase` to `https://app.qianshousuanli.com/api/qianshou/ai`, and `timeoutMs` to 15000. HTTPS is required except for loopback integration fixtures. Requests reject redirects and omit cookies.

The [account UI](../../client/ui-qianshou-account/README.md) invokes the generated `qianshouAccount` Remote. Password login and TOTP login call the Shanghai `/api/v8/auth` endpoints. Phone sign-in calls the existing `/auth/sms/send` and `/auth/login/phone` routes. Signed-in commerce reads Guangzhou `POST /status` and the Shanghai wallet, quote, and purchase routes, and starts Alipay recharge with `POST /payment/recharge`. Reconnect refreshes as needed, verifies `/auth/me`, and fetches the Guangzhou catalog with `POST /models`. A missing refresh token is represented as a session-only login. No vendor credential can create an ordinary user session.

A completed password login, a completed TOTP login, and a restored session at startup each select the `qianshou-cloud` provider and set it as the default model. Other provider entries and permission settings stay intact. The default applies to new conversations and existing empty conversations without an explicit model; conversations that already selected a model or recorded a request keep that choice. `useCloud` repeats the same selection. The picker publishes one row named 千手v4; the request keeps the first catalog id, and that row accepts text and image input. Further catalog ids stay on the account status and are not extra picker rows. The local route records a 1000000-token window for the meter and compaction, so this PC does not compact at the free-tier size. Guangzhou still admits each request against the signed-in tier. The request output budget is 65536 tokens, and the gateway clamps it to the model's published cap. A signed-in turn sends the complete conversation and the selected preset's tool schemas straight to the text model. This package no longer classifies each sentence through a local preview or Guangzhou `/intent` before the model. It does not offer an image-generation tool; the retired direct image path must not be presented as available until a verified, authorized capability tool is installed and tested.

<a id="doc-section-2"></a>
## Credential and lifecycle ownership

The Host stores its version-one refresh grant under `qianshou-account/session` and its managed access reference under `QIANSHOU_ACCOUNT_ACCESS_TOKEN`. It never overwrites the legacy `QIANSHOU_ACCESS_TOKEN` reference or other provider keys. The current development credential provider persists a permission-restricted plaintext file; this is not an OS keychain. Access rotation reaches the provider through its normal per-request credential lookup.

Login replacement, cancellation, logout, and disposal abort the current account lifetime. The pi-ai transport admission hook attaches that lifetime to managed Qianshou model calls, including active HTTP responses. Other providers and manually configured legacy Qianshou keys are unaffected. No paid model request is replayed automatically by this account service.

A generation check rejects late login and refresh responses. Refresh is single-flight, and durable writes are serialized. Disposal awaits pending writes and compensation before another owner can mount. HTTP 429 and server/network failures preserve renewal credentials; rejected authentication clears them. Logout deletes the owned refresh grant even when a read-only environment reference prevents removal of the managed access reference, and exposes a safe storage failure in that case. Remote revocation can fail while local logout remains effective.

<a id="doc-section-3"></a>
## Model Experience

### Account presentation and route admission

#### What the model sees

The `qianshouAccount` Remote remains an owner UI interface. The account plugin provides no model-facing task tool. The model receives the full conversation, including short answers to earlier questions, and may use only tools mounted by the selected preset. Those tools and their Host admission decide whether a capability can run; a route preview cannot execute or charge. Missing authentication or a gateway address differing from the pinned account gateway still blocks the managed model request before transport. Account cancellation reaches the provider's abort signal and produces an aborted model outcome. When the selected preset supplies Bash or PowerShell, ordinary workspace tasks continue to those existing tools even if the market compute executor registry is empty. Their permission and dependency checks still apply. This does not register a remote provider, authorize a paid order, or declare a model ready.

#### Token effect

Account operations and rendering add no model requests or prompt tokens. Future conversations use their explicitly selected model route.

#### KV Cache effect

This package does not rewrite earlier messages or inject a hidden prompt prefix. The selected provider and ordinary conversation pipeline own cache behavior.

## Known Limitations and Deferred Work

<a id="doc-section-4"></a>

- Owner-local tests use controlled account responses, real Cordis services, in-memory credentials/settings, and real loopback HTTP model streams. They cover login/TOTP, expiry, refresh concurrency, late results, teardown/rebuild, storage ownership, explicit route selection, and active transport cancellation. These are local development checks, not positive acceptance of a real Shanghai user login or paid Guangzhou inference. Real account acceptance requires a real user identity; system keychain storage and shipping authentication UX remain separate release work.

No runtime invariant companion is published: the service owns one account state machine, and its credential writes and cancellation lifetimes are verified through that owner's lifecycle tests.

<a id="dev-note"></a>
### Dev Note

None.
