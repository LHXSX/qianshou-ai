---
description: "Pair companion computers, dispatch locally approved tasks, and inspect actual remote results."
kind: "package-reference"
---

# Qianshou device workspace

English | [中文](README.zh.md)

## Summary

Open **Devices** to pair a companion, choose its approved workspace, submit a command or file task, and read its actual result. Every task waits for approval on the companion. A desktop task requests RustDesk; a native main window can open the returned device ID. This page never invents devices or task progress.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The Qianshou web composition mounts this package through its ordinary client bundle. Open **Devices**, create a pairing code, and enter it in the companion. Select an online device and its approved workspace before submitting a task. Cancellation remains pending until the companion acknowledges it; revocation disconnects that device.

The optional relay section is available in the relay-capable desktop controller. It imports a dedicated registration through the native file dialog, shows actual FRPC connection state, and copies only the public coordinator endpoint. The invitation draft adopts that endpoint only after an explicit choice; generating a pairing code remains a separate action. Browsers and older shells display upgrade guidance. See the [desktop relay guide](../../../apps/qianshou-desktop/relay/README.md) for activation, shutdown, privacy and verification scope.

### Downloads and recipient instructions

The setup section always links to the official Companion download page. It also lists real archives verified by this coordinator, with version, size, SHA-256 and validation status. These local links retain browser authentication: the owner downloads and transfers the file separately. The official website is a public link and carries its own platform availability, signing and verification disclosures.

Enter a non-loopback HTTPS coordinator origin and generate a fresh pairing code to enable **Copy full setup instructions**. With a local archive, the invitation retains its filename, checksum and private-transfer instructions; otherwise it uses the public official download page. Both variants include platform startup steps, address, pairing code/expiry, workspace selection and local approval requirements, excluding browser login credentials. Address validation checks syntax only and leaves cross-machine reachability unverified. Clipboard failure is visible, and code validity is rechecked when copying. File, command and desktop operations keep their existing approval semantics.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[The controller](src/client/controller.ts) polls the authenticated coordinator while a view is attached. It serializes mutations, aborts on disposal, and rejects stale responses. [The page](src/client/DevicesPage.tsx) owns selection and drafts; the coordinator owns device and task state. [Controller tests](tests/controller.client.spec.ts) cover authentication, errors, duplicate mutation prevention, and disposal races.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Remote coordinator](../../host/remote-devices/README.md): task ownership and authentication.
- [Remote collaboration](../../../docs/qianshou-remote-devices.md): pairing and deployment boundaries.
- [Companion](../../../apps/qianshou-companion/README.md): local approval and execution.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package presents human device controls without adding prompts or tools, while model-facing remote task tools belong to the coordinator's separate tools entry.

#### KV Cache effect

No direct token or KV-cache effect; this package neither assembles nor sends a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Shell working directories are not OS sandboxes. File containment is enforced by the companion.
- Desktop control requires RustDesk and OS permissions on actual target machines. A successful launcher result alone does not prove a remote connection.
- Device metadata and task history come from one coordinator. This package exposes no independent runtime invariant entry; lifecycle and concurrency checks live in its controller tests.

<a id="dev-note"></a>
### Dev Note

None.
