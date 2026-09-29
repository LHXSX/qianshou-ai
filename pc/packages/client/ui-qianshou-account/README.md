---
description: "Private Qianshou PC account settings and sidebar entry over the Host-owned account Remote."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qianshou-account

English | [中文](README.zh.md)

## Summary

Sign in with a password or SMS in Qianshou Settings, complete any required two-factor verification, and manage the current account from personal center or the sidebar. Read actual plan, wallet and five-hour usage values; subscriptions and recharge require explicit confirmation. Account switching and sign-out also require confirmation. QR sign-in and permanent deletion remain unavailable without their real integrations. The ordinary upstream build registers none of these entries.

## Table of Contents

- [Interaction](#interaction)
- [Dev Note](#dev-note)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="interaction"></a>
## Interaction

The sidebar avatar shows the username and Host authentication status, with Desktop version and update on a quiet second line. Its menu groups account, usage and plan, Settings, Desktop update when supported, Qianshou Cloud, help, About, and sign-out. About links to the terms and privacy policy. The signed-out Settings view centers one login card using the Host-owned `qianshouAccount` Remote for password, SMS and required two-factor steps.

Password and one-time-code values live only in the mounted form and are cleared on submission or cancellation. The shared UI store contains safe Host status and request progress; authentication, billing, and payment failures are shown separately. Later user actions supersede earlier responses, so cancelling login cannot be undone by a late UI result. The two-factor card offers an explicit cancel action.

A restorable Host account is reconnected once per Client lifetime. Sidebar polling reads status without triggering a repeated network refresh. Reconnect explicitly verifies identity and reloads the real model catalog. Temporary failures remain visible, and the interface never derives authentication from a configured key alone. Missing plan, quota, or balance values display as unavailable rather than as sample numbers. Subscription requires a Host quote and a separate confirmation; recharge submits only the Host-issued Alipay form after an explicit user action.

Login does not select a provider. The separate Use Qianshou models action changes the default for new conversations and empty conversations without a previous model choice. The interface explains both that effect and the development credential file's plaintext storage. The [Host package](../../host/qianshou-account/README.md) owns authentication, credential persistence, gateway validation, and cancellation.

Personal center uses four cards for the plan and available SP, CNY balance, five-hour usage, and the order-record entry. Cards retain the actual Host readings; income follows platform settlement records. Plan and recharge entries open their respective flows without initiating payment. Forms, quote confirmation, and original-order reconciliation remain visible within the Settings shell’s scroll area.

Account management now places Switch account and Sign out directly in personal center. Both require confirmation before the existing Host logout operation. The sidebar uses the same confirmation. A confirmation is bound to its opening account, so an intervening owner change cannot sign out the new account. Successful sign-out returns to the actual login form; connection failures remain visible. Logout clears local credentials and attempts the existing server logout. Supply admission closes after the existing owner identity check; this interface does not promise immediate withdrawal of every running task or remove saved authorizations. Published skills, orders, and balances remain on the platform. Permanent account deletion has no self-service Remote here and is not presented as a successful action.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Host responses own account identity and commerce state. Controlled component fixtures do not establish real sign-in, payment, or withdrawal.

</details>

<a id="model-experience"></a>
## Model Experience

### Account presentation and route admission

#### What the model sees

The `qianshouAccount` Remote remains an owner UI interface. The account panel is product UI and does not expose a model tool or add conversation messages. Host-origin identity and failure states determine what it displays; a model cannot declare itself logged in.

#### Token effect

Account operations and rendering add no model requests or prompt tokens. Future conversations use their explicitly selected model route.

#### KV Cache effect

This package does not rewrite earlier messages or inject a hidden prompt prefix. The selected provider and ordinary conversation pipeline own cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Component tests drive password and SMS submission, TOTP, cancellation races, restoration, explicit route choice, account/billing error separation, and account-menu navigation. Real user login, payment completion, and Guangzhou inference remain separate integration acceptance. No runtime invariant companion is published because this package owns no independent account truth; it projects the Host response.
