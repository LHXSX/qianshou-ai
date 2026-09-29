---
description: "Explicit per-Session device-owner connection controls for Qianshou."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-qianshou-session-connect

English | [中文](README.zh.md)

## Summary

Qianshou builds add Session connection to an ordinary Session's header. Other profiles activate without the feature Remote and register no UI; delegated child Sessions show no action. The [Host](../../host/qianshou-session-connect/README.md) owns authorization, storage, reachability and command delivery.


## Table of Contents

- [Use](#doc-section-1)
- [Model Experience](#doc-section-2)
- [Known Limitations and Deferred Work](#doc-section-3)
- [Dev Note](#dev-note)

<a id="doc-section-1"></a>
## Use

Open the action to see the Host-reported address scope. The default loopback address works only on this computer; a configured HTTPS origin still needs a real connectivity check from the recipient device. The default primary action creates a view-only grant with an automatic note and a 60-minute lifetime. Note, text permission, lifetime and optional device labels are in Connection settings. Selecting text sending explains that the recipient may start work with the Session's current permissions. No action changes the current provider, model or permission mode.

The complete secret link and copy action take priority after creation. Previous connections start collapsed but remain available for revocation. Closing or changing Session clears the displayed link. Old grant metadata never reconstructs its secret. Closing during creation drops the late UI response but does not undo an authorized Host commit; reopening lets the owner inspect and revoke any newly created grant. Revoke targets the exact selected Session and grant, clears the displayed link and reloads status. Errors display fixed localized messages rather than arbitrary remote diagnostics.

The independent recipient page belongs to the Host package. It never loads this owner UI or its global Remote dependencies. Recipient text and delivery receipts must be accepted through that page's narrow API, not these owner actions.

<a id="doc-section-2"></a>
## Model Experience

### Owner connection controls

#### What the model sees

The `qianshouSessionConnect` owner UI registers no model tool or prompt. Its only model-related choice is whether a separately authorized recipient may submit ordinary text through the Host. Opening the panel, creating or revoking a grant does not send a user message.

#### Token effect

Owner controls consume no model tokens. Accepted recipient messages use the selected Session's normal model route, as described by the Host.

#### KV Cache effect

The panel does not modify conversation history or model prompt prefixes.

## Known Limitations and Deferred Work

<a id="doc-section-3"></a>

- The UI has no cloud-account grant binding, device discovery, phone relay, QR enrollment or cloud replica controls. Default loopback links cannot reach another device. Clipboard availability depends on the browser or desktop shell; failed copying leaves a manually selectable link. Complete browser/Host composition requires running-app acceptance in addition to component tests. No runtime invariant companion is published because this component holds only disposable views of Host state.

<a id="dev-note"></a>
### Dev Note

None.
