---
description: "Pair companion computers, submit locally approved remote tasks, and inspect durable receipts through the authenticated coordinator."
kind: "package-reference"
---

# Remote device coordinator

English | [中文](README.zh.md)

## Summary

Pair companion computers, select an approved workspace, and submit command, file or desktop tasks from the Qianshou controller. Each task waits for approval on the companion, and its recorded receipt distinguishes acceptance, execution and completion. You can request cancellation or revoke a device without exposing its credentials to browser listings or model tools. This package coordinates finite tasks; it does not distribute Harness Sessions to remote machines.

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

The [web-app composition](../../bundle/web-app/cordis.patch.yml) mounts the coordinator with Connection and WebServer. It retains Connection authentication for browser requests and uses separate first-message authentication for native devices. It does not change the controller's default bind address or create an unauthenticated network entry.

This function plugin has no package-specific configuration fields. A custom composition that already provides `connection`, `agents` and `jobs` mounts it with this row. `webServer` is optional: the native upgrade registers when that service exists, so Electron desktop can still provide `remoteDevices`.

```yaml
- name: '@deepseek-ai/dsh-host-remote-devices'
```

### Browser operations

`GET /api/qianshou/devices` returns `{ devices, jobs }` containing public device metadata, approved-workspace metadata, and task state only. `POST /api/qianshou/pairings` returns `{ code, expiresAt, wsPath }`; `POST /api/qianshou/jobs` accepts `{ deviceId, workspaceId, kind, payload }`; `POST /api/qianshou/job-cancel` accepts `{ jobId }`; and `POST /api/qianshou/device-revoke` accepts `{ deviceId }`. The latter two return `{ accepted: true }`; cancellation still requires a peer's terminal receipt.

### Update preparation

Authenticated `GET /api/qianshou/update-readiness` returns `{ ready, busy: { agents, jobs, remoteJobs, admissions }, maintenance: { active, expiresAt, availableAt } }`. Counts include all owners, unpublished setup, maintenance, both pending inbox lists and remote approvals. `ready` describes quiescence and absence of a lease; `availableAt` independently identifies the preparation cooldown. Timestamps are epoch milliseconds and absent times are null.

`POST /api/qianshou/update-prepare` with `{}` returns status 201 and `{ leaseId, expiresAt, ttlMs: 30000 }` only after atomic idle admission. Busy returns 409 `UPDATE_BUSY` with readiness; an existing lease returns 409 `UPDATE_PREPARING`; a five-second preparation cooldown returns 429 `UPDATE_RETRY_LATER`. `POST /api/qianshou/update-commit` with `{ leaseId }` rechecks the same still-active identity after package validation and returns `{ committed: true, expiresAt }`; only the first commit can extend exit time by up to 15 seconds, and repeated commits do not renew it. Wrong or expired identities return 409 `UPDATE_LEASE_EXPIRED`.

`POST /api/qianshou/update-cancel` with `{ leaseId }` returns `{ released }`; stale identities cannot release another attempt. Expiry or plugin disposal also releases every admission veto. New agent, inbox, local-job and remote-task admissions fail explicitly during a lease; current work and draft contents are retained. These APIs neither install packages nor stop a process. See the [bounded lease decision](src/update-readiness.ts).

### Companion archive delivery

`GET /api/qianshou/companion-downloads` lists verified releases staged in `$DSH_HOME/qianshou/companion-downloads`; fixed `GET` routes ending in `/darwin-arm64`, `/win32-x64` and `/linux-x64` stream their archives as attachments. These routes require the same Connection browser authentication as other controller operations. They are owner download links, not public URLs for recipients. Download an archive and transfer the file separately without sharing browser credentials.

Run the companion's `scripts/prepare-downloads.py --output <DSH_HOME>/qianshou/companion-downloads` after preparing its platform packages. The script verifies existing portable checksums, verifies the Mac app signature, creates a ZIP, and atomically publishes a small manifest. The Host accepts only fixed platform ids, bounded archives and matching filenames, checks SHA-256 on first access or file changes, rejects symlink files, and returns only public release metadata. It streams archives without buffering them in memory, cancels streams on disconnect or disposal, and exposes no arbitrary filesystem path. Missing or mismatched files have no active download link. Staging files are trusted Host-user release inputs, not an OS isolation boundary.

The device page provides platform-specific installation instructions and a copyable invitation. A recipient address must be a non-loopback HTTPS origin without credentials, path, query or fragment. Syntax acceptance is always labeled connectivity-unverified. This package creates neither a public website nor a TLS/VPN entry and never converts a browser login URL into a shareable link.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The coordinator owns device identity, active peer ownership and durable task receipts. The browser and optional model tools submit through this owner; the companion owns approval and execution.

### Native transport

Native companions connect outbound to `/qianshou-device` on the same port. Upgrade requests carrying a browser `Origin` are rejected. A first `pair` or `auth` frame must arrive within five seconds with a one-time code or a device ID and credential, plus name, platform, architecture, and workspace metadata. After authentication, `job`, `cancel`, `job-event`, `ack`, and `heartbeat` messages carry work and complete output snapshots. [protocol.ts](src/protocol.ts) defines wire types and input bounds.

### State and boundaries

Task states are `awaiting-approval`, `running`, `completed`, `failed`, `rejected`, `cancelled`, and `interrupted`. Stable job IDs, connection-local increasing sequences, and immutable terminal receipts prevent duplicate results from replacing completed outcomes. Reconnection resends unfinished tasks, but the companion only restores the approval queue or synchronizes existing receipts, never auto-executing them. Revoked or replaced connections cannot report further work. State lives at `$DSH_HOME/qianshou/devices.json` with directory mode 0700 and file mode 0600, retaining credential digests only, up to 200 ended and 100 active jobs.

The companion provides `command`, `read`, `write`, `list`, and `desktop` tasks, each requiring local approval before execution. Workspace restrictions are enforced by the companion; reported remote paths are never interpreted as controller filesystem locations. Shell tasks have an initial working directory rather than an operating-system sandbox. Desktop tasks hand off to installed RustDesk instead of mixing screen and input protocols into task RPC.

The [package tests](tests) cover local pairing, no execution before approval, cancellation, revocation and file boundaries. This source closure does not include the companion app; cross-device acceptance still requires an actual companion and target device.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../../client/connection/README.md) — browser authentication and Fetch routing
- [Browser operations](#use-this-package) — human pairing and task entry points
- [Task protocol](src/protocol.ts) — companion approval and execution messages
- [Known limitations](#known-limitations-and-deferred-work) — deployment and target-machine acceptance

-----

<a id="model-experience"></a>
## Model Experience

### Remote task tools

#### What the model sees

An explicitly selected preset mounts `@deepseek-ai/dsh-host-remote-devices/tools` to expose `remote_device_list`, `remote_task_submit`, `remote_task_status`, and `remote_task_cancel` through the standard Tools registry. The host service alone exposes none. Definitions explain that submission waits for local approval and cancellation needs a terminal receipt. The model sees actual devices, workspace IDs, and paginated results; it cannot create pairing codes, receive credentials, or revoke devices. Task status returns 12,000 receipt characters by default and accepts pages up to 50,000 characters.

#### Token effect

Four fixed tool schemas add per-request context only for enabled presets. Device metadata and requested receipt pages add tool-result context. Large result pages cost more tokens; page only what the task needs.

#### KV Cache effect

Tool definitions are stable across device status changes. Device names and results enter tool responses, not schema prefixes. Enabling or disabling the tool plugin changes the visible schema prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The coordinator preserves these execution boundaries:

- **Local-user execution** — remote commands run after local approval without an operating-system sandbox; the companion enforces file-workspace containment.
- **Finite task protocol** — remote Harness Session dispatch and automatic subagent distribution are not implemented by these tools.
- **Target-machine acceptance** — cross-device TLS and RustDesk screen/input operation require actual target machines; local protocol tests do not establish them.
- **Single state owner** — one service coordinates devices and receipts and validates authentication, input, peer ownership and terminal transitions, so this package publishes no empty `./invariant` companion.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
