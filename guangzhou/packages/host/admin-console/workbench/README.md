# Workbench SP and subscription management

English | [中文](README.zh.md)

The account and subscription pages now use the existing `account.charge.adjust` and `subscription.manage` permissions, with `all` scope, to request a live owner preview and then execute one confirmed operation. The console never writes ledger or subscription files. Shanghai CNY payments remain a separate interface and balance.

## Runtime configuration

Set these nonsecret values on the admin console (7090):

- `QIANSHOU_ADMIN_WORKBENCH_BASE_URL`: the fixed workbench origin, HTTPS or same-machine loopback HTTP, without a path, query or user information.
- `QIANSHOU_ADMIN_WORKBENCH_KEY_ID`: the configured service key ID.
- `QIANSHOU_ADMIN_WORKBENCH_KEY_REF`: an uppercase reference in `$DSH_HOME/.credentials.yaml`.
- `QIANSHOU_ADMIN_WORKBENCH_AUDIENCE`: the exact same-environment audience configured on the workbench (7080).

Configure the workbench's `internalAdmin` with that audience and a key entry `{id, credentialRef, scopes: ['ledger.adjust', 'subscription.grant']}`. Store a dedicated random 256-bit service key in each process's owner-only refs file; do not put the value in command arguments, URLs, browser state, environment variables, logs or this document. A 32-byte base64url value has 43 characters. References are read on every request, reject symlinks or group/other access, and reject an ambiguous environment variable with the same name. There is no cached or ambient credential fallback.

Rotate by provisioning a new key ID/reference on both sides, retaining the old accepted key during the transition, changing the console's nonsecret reference configuration, and verifying a read-only preview before retiring the old workbench key. Missing configuration disables writes. Configured readiness is not a successful service probe: the actual preview must pass authentication and schema checks.

## Operations and confirmation

`POST /api/qianshou/ai/admin/account/adjustment/{preflight,apply,check}` and `/api/qianshou/ai/admin/subscription/manage/{preflight,apply,check}` share the existing console session, RBAC and one-use confirmation store. A preview generates an operation UUID. The reason is required before preview. The server stores the gateway's normalized `after` and live `before` in the confirmation payload; apply must match both. The operator ID and role come from the verified console session, while service identity uses its own Bearer credential and `X-Qianshou-Service-Key-Id`.

Only `/internal/ledger/adjust` and `/internal/subscriptions/grant` are called. The former uses `accountId`, a nonzero `deltaSp`, a recharge/earning bucket and the normalized current tier. The latter requires an explicit tier, start timestamp and end timestamp; permanent entitlement requires an explicit `to: null`. The UI never defaults to a permanent or 30-day subscription. Both bind `reason`, `ref` and trusted `_admin` delegation. There are no forged browser headers, redirects or automatic retries.

Preflight sends `dryRun: true`. Apply removes `dryRun` and uses the same UUID. The console persists an intent audit before sending the write and a result audit after a verified receipt. A consumed token cannot be reused, including after a timeout. The UI prevents duplicate clicks, keeps the original operation receipt, and clears private previews and read results when identity changes. An in-memory recovery store retains the normalized payload and ref across route remounts, without retaining a reusable token. It is cleared on logout or identity change. A full browser reload does not restore this memory; server audits and the original operation ref remain the manual recovery evidence.

A check uses the same payload and UUID with `dryRun: true`; it cannot create a new business record. If the owner reports `created: false`, its existing-record check must successfully flush persistence before returning success. This may retry persistence of the same record, never add a second adjustment. A new UUID is not a recovery method for an uncertain money operation. An operation conflict is reported separately.

## Failures and delivery boundary

Service credential rejection is `401 workbench_service_unauthorized`; it does not clear the operator's console login. Valid service credentials with insufficient scope/delegation yield `403 workbench_service_forbidden`. A gateway write timeout, malformed receipt or persistence failure is an unknown outcome with the original ref, not a successful write or a retry invitation. Console intent-audit failure prevents any write; failure to save the result audit retains the original operation for verification.

Tests use actual console HTTP, native credential resolution and actual gateway authorization/ledger handlers, plus the actual Vue account/subscription views. Deployment requires the paired gateway changes, key references, owner data paths and the new console/web build. Local tests do not establish production account, payment or subscription acceptance. No CNY/SP conversion, fee policy, refund, ledger deletion or automatic reconciliation is introduced.
