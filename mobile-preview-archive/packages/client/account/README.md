---
description: "Shared Qianshou account client for register, login, 2FA, token refresh, sessions, subscriptions and WeChat sign-in."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-account

English | [中文](README.zh.md)

## Summary

The shared browser and mobile client for the Qianshou account service. It drives registration, login, TOTP/2FA verification, token refresh, session and subscription reads, promotion snapshots and the WeChat OAuth hand-off, and it normalizes every answer into typed records. Credentials stay behind a caller-supplied `TokenStore`: the access token is memory-only by default, and the refresh token's storage location is the embedder's decision. The package holds no UI, no server and no model surface.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Build an `AccountClient` with `createAccountClient`, passing the service base URL, a `fetch` implementation and a `TokenStore`. Call that client for register, login, 2FA verification, refresh, session and subscription operations, and read credentials only through the store's `readAccess()` and `readRefresh()` reads rather than from a response object. `sendRequest` and the `redactForLog` helpers are exported for callers that need the same transport timeout and log-redaction rules.

`sendSms` uses an explicit `register` or `login` purpose and returns a provider-confirmed masked phone and resend interval. `loginPhone` returns the same token-or-TOTP result as password login; `registerPhone` stores a successful server token response. The host must verify `/auth/me` before presenting an authenticated identity.

<a id="understand-the-implementation"></a>
## Understand the implementation

`http.ts` owns the timeout, header and redaction rules; `endpoints.ts` owns the route table; `normalize.ts` turns responses into the typed records in `types.ts`; `failures.ts` classifies transport and service failures. `tokens.ts` and `session.ts` keep the access token in memory by default and put the refresh token behind an injected port, because where a long-lived credential lands is a security decision rather than an implementation detail. `wechat-login.ts` prepares and validates only the browser leg of the OAuth hand-off.

<a id="model-experience"></a>
## Model Experience

### Account credential client

#### What the model sees

Nothing: this package is the credential and account-data client behind the browser and mobile surfaces, and `createAccountClient` registers no model tool, prompt section or session event. The account records it returns are rendered by its consumer and never enter a conversation through this package.

#### Token effect

No token effect. No request-assembly path in this package produces model input.

#### KV Cache effect

No KV cache effect. The package neither assembles nor sends a provider model request, so no cached prefix depends on it.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Credential persistence is the embedder's decision, not this package's: the access token is memory-only by default and the refresh token sits behind a caller-supplied port, so where a long-lived credential lands must be documented by the host that supplies it.
- Authorization stays with the Qianshou account service. This client mirrors nothing, and a client-side check cannot grant a plan, a role or an entitlement.
- The WeChat adapter covers the browser leg only. App secrets, code-to-token exchange and account binding remain server work, and a missing public configuration is reported as an explicit unavailable state rather than a fabricated login.
- No UI, routing or storage implementation ships here; each embedding surface owns its own presentation and error wording.

<a id="dev-note"></a>
### Dev Note

Keep the transport, redaction and normalization rules here rather than in each surface. Never log an access or refresh token value, embed one in an error object, or render one in a diagnostic. When the account service adds a response shape, add a typed record to `types.ts` and its normalizer beside it instead of widening an existing record silently.
