---
description: "Sidebar-foot account card and personal-center page: plan, credit and identity read from the Host account session and the subscription gateway."
kind: "package-reference"
---

# Qianshou account chrome

English | [中文](README.zh.md)

## Summary

Two surfaces over the same read model:

- the **account card** at the foot of the left sidebar — identity, plan pill, remaining credit and a low-credit indicator, visible from every panel;
- the **personal center** main-panel page (`qianshou-account`) — the full breakdown: account fields, plan, credit dial, rolling-window usage and concurrency ceiling.

Clicking the card opens the page. Both read **one** `AccountViewService` instance, so the two surfaces can never disagree about the balance.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Design rules the UI must not drop](#design-rules-the-ui-must-not-drop)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

The package registers itself when the profile mounts it; there is no API for product code to call.

| Surface | Slot | Id |
| --- | --- | --- |
| Account card | `sidebar.footer.action` | `qianshou-account` |
| Personal center | `main` | `qianshou-account` |
| Sidebar nav row | `sidebar.panellist` | `qianshou-account` |

Both routes it reads are **POST-only** on the Host:

```
POST /api/qianshou/account/state   -> { ok, state, account }
POST /api/qianshou/ai/status       -> { ok, version, tier, credit, limits }
```

A `GET` to either path answers `404 not found` in plain text, because the Host registers no `GET` for them. That is why `endpoints.ts` hard-codes the method and a contract test asserts it.

## Understand the implementation

| File | Responsibility |
| --- | --- |
| `endpoints.ts` | The two paths and the one request shape (POST, JSON, `credentials: 'include'`). |
| `status.ts` | Payload → facts. Every field is narrowed; an unreadable field becomes `null`, never a guess. |
| `store.ts` | `AccountViewService`: two reads, short TTL, single-flight, forced refresh, failure classification. |
| `use-account-view.ts` | `useSyncExternalStore` bridge so a snapshot read and a subscription happen in the same render. |
| `AccountCard.tsx` / `.module.css` | The sidebar-foot card. |
| `AccountPage.tsx` / `.module.css` | The personal-center page. |
| `foot.css` | One separator rule between the card and the Settings row. |
| `AccountPanelIcon.tsx` | The sidebar nav glyph. |
| `locales.ts` | The `qianshou.account` dictionary. |

`store.ts` keeps the two reads independent on purpose. A gateway outage must not hide "you are signed in" — that is exactly the moment the user needs that fact most.

## Design rules the UI must not drop

1. **Account above Settings, Settings at the very bottom.** This is the upstream default and the VS Code arrangement (`ACCOUNTS_ACTION_INDEX` pushed before Manage). Reordering to put the card below Settings was designed and then **withdrawn**: it needs stronger assumptions about another package's internal footer structure and buys only a preference.
2. **Only `[data-slot="…"]` selectors cross the package boundary.** `foot.css` uses the anchor seam the renderer documents as a promise; it names no CSS-Module hash class, so an upstream rebuild cannot silently break it.
3. **Unreadable never renders as zero.** A missing `monthlySp` draws a hatched "unknown" bar, not a 0% one; a `200` whose body cannot be parsed is `unavailable`, not "no credit".
4. **Unavailable and anonymous are different states.** They lead to opposite user actions: retry versus sign in.
5. **`force` refresh reads.** A user who clicks refresh must not be served the TTL cache.
6. **SP is not yuan.** Credit is `SP` (1 SP = 0.01 CNY) charged at upstream list prices; the subscription price also covers service and routing. `plan.hint` says so in words, because "390 SP" next to a ¥39 plan otherwise looks like an arithmetic error.

## Model Experience

The card is the model-independent surface: it never appears in model context, prompts or tool output, and it renders no upstream model identifier. It shows the **published** plan label the gateway reports (`tier.label`), falling back to the local dictionary only when the gateway gives none.

## Known Limitations and Deferred Work

- **No sign-in or sign-out here.** The full credential flow, including the mandatory 2FA step and registration, already lives in **Settings → Account** (`ui-settings-general`). There is no API to open that dialog at a given section, so the card links nowhere yet; the personal-center page deliberately does not duplicate a second login implementation whose 2FA branch could drift.
- **Account identity is read by this package too.** Sharing the settings store would remove one POST round trip per read, at the cost of coupling the sidebar to the settings shell. Both read the same endpoint, so they cannot disagree; the duplication is one request, not two truths.
- **`account.balance` is deliberately unused.** It is an upstream figure in an unverified unit; plan credit is the number users are charged against.
- **Tier source differs between routes.** `/api/qianshou/ai/status` resolves the tier as subscription-then-role while `/api/qianshou/ai/chat/completions` resolves it as subscription-then-`basic`. An operator who holds a role-granted plan therefore sees it on this page but is not granted it on the OpenAI-compatible path. That is a Host-side inconsistency and is **not fixed here**.
- **No per-turn refresh.** The available client events do not include a turn-completed signal, so the card refreshes on mount, on TTL expiry and on explicit request rather than after every reply.

## Dev Note

Verification that exists today:

- `tests/store.client.spec.ts` — 22 tests over the real captured payloads, the POST-only shape, the TTL/single-flight/force rules, all failure classes and the dispose path.
- `tests/apply.client.spec.ts` — 5 assembly tests over a real cordis context and the real slot registry: the three registrations, the dictionary, teardown, and **injected-face identity stability**.
- Reverse verification performed: switching the method to `GET` and removing the ratio clamp each turn the suite red; restoring returns it green.
- Live, in the running workbench (Chrome, forge profile): card at `x=12, y=772, 256×56`, above the Settings row at `y=848`, separator `0.5px`, phase `ready`, text `111111 / 普通版 / 普通版 · 剩余 390.00 SP`, zero console errors.

### Two traps this package already paid for

1. **Unstable injected-face identity silently disables mount effects.** The `inject` factory runs on every render; returning a fresh object literal each time gives `refresh` a new identity every render, so `useEffect(() => refresh(), [refresh])` re-fires forever and never settles into doing the read once. The symptom is a card stuck at `idle`, nothing on screen and **no console error** — which is why the face is now built once and the identity is asserted in a test.
2. **Style injection needs a `typeof document` guard.** The assembly path must complete in a DOM-less environment (the test runner), otherwise registration assertions fail as "the plugin did not register" when the real cause is a hard-wired environment assumption.

Both routes were also confirmed **POST-only** in the live host: a `GET` answers plain `404 not found` while a `POST` answers `200` with JSON. A `404` would have been read as "this feature does not exist" instead of "cannot read".
