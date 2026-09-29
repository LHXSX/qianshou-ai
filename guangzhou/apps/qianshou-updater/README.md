---
description: "Verify signed Qianshou releases and download exact platform archives for desktop-controlled staging."
kind: "package-library"
---

# Qianshou signed updates

English | [中文](README.zh.md)

## Summary

Both desktop applications can check the official release feed and download an authenticated archive for their exact role, operating system and architecture. Checking a release does not download or install it. The download operation verifies the complete archive before publishing its cache path. Installation and process restart belong to the desktop staging and bootstrap modules.

## Table of Contents

- [Use the core](#use-the-core)
- [Understand verification](#understand-verification)
- [Stage and activate](#stage-and-activate)
- [Known limitations](#known-limitations)
- [Model experience](#model-experience)
- [Dev Note](#dev-note)

<a id="use-the-core"></a>
## Use the core

Import [manifest.mjs](manifest.mjs) to call `checkForUpdate(target, options)`, with the installed `role`, `platform`, `arch` and `currentVersion`. The result is `available`, `current` or `unsupported`. An available result includes the signed release, selected artifact and the original envelope encoded as base64. Application code supplies cancellation through `options.signal`; production callers use the installed public key and fixed official URL.

After the application authorizes a download, pass the original available object to `downloadUpdate(available, options)` in [download.mjs](download.mjs). Supply an absolute, private `cacheDirectory` separate from conversations, settings and workspaces. Progress contains received bytes, total signed bytes and their fraction; 100% means transfer completion, while the promise resolves only after verification. The result includes the verified path, SHA-256, byte size and signed envelope for staging.

For persisted receipts, decode the envelope with `Buffer.from(receipt.envelope, 'base64')`, call `verifyReleaseEnvelope(bytes, target)` and then `verifyArchive(verified, archivePath)`. Same-version verification is permitted for an active installation; an optional `currentVersion` rejects a lower version. Only `checkForUpdate` can produce a downloadable result, and it requires a strictly newer version. Reconstructed or modified selection objects cannot bypass signature verification.

<a id="understand-verification"></a>
## Understand verification

The feed is fixed at `https://qianshousuanli.com/downloads/qianshou-agent/updates/latest.json`. [public-key.pem](public-key.pem) pins the Ed25519 verification key; its private counterpart is not an application resource. The schema-1 envelope contains base64 payload bytes and a signature over those exact bytes. Unsigned feeds, incompatible bootstraps, duplicate targets, invalid versions and unsupported schemas fail closed. Artifact URLs must exactly match the same HTTPS origin and the signed version directory; redirects, credentials, queries, fragments and encoded path substitutions are refused.

The feed limit is 1 MiB and each archive is at most 1 GiB. The feed operation has a 30-second deadline; an archive transfer has a 15-minute deadline. A release timestamp more than five minutes ahead of the local clock is rejected. Downloaded bytes stream to an exclusive 0600 file in a fresh 0700 directory, pass exact size and SHA-256 checks, and are published by same-directory rename. Cancellation and failure remove only that transfer's private directory. Existing symlink or junction paths are rejected; POSIX cache ownership and write permissions are checked.

The core uses Node's maintained [Ed25519 verification](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback), [file APIs](https://nodejs.org/api/fs.html#fspromisesopenpath-flags-mode) and [fetch](https://nodejs.org/api/globals.html#fetch). Tests inject an ephemeral public key, a fixed clock and a fetch transport without changing production URL rules. Core failures expose stable `UpdateError.code` values without remote response bodies or private filesystem paths. Cancellation retains the caller's abort reason.

<a id="stage-and-activate"></a>
## Stage and activate

[stage.mjs](stage.mjs) installs a verified download into the application's private `updatesDirectory/versions` directory. Call `stageUpdate(download, { updatesDirectory, target, signal })`; the returned receipt contains the original signed envelope and derived installation location. macOS uses the complete `.app`, Windows uses the complete portable directory, and Linux supports the companion's complete `tar.gz` directory. Product names and executable locations come from a fixed role/platform map, never from an editable feed or local receipt. The existing installation and user data are not overwritten.

Archive inspection finishes before extraction. Absolute paths, traversal, drive paths, duplicate names, case collisions, special files, escaping symbolic links and files beneath links are rejected. Tar hard links are unsupported. The limits are 120,000 entries and 6 GiB unpacked. Internal macOS framework links are preserved and the extracted `.app` passes `codesign --verify --deep --strict`. Installed files are compared with SHA-256 values read from the authenticated archive; verification does not trust a mutable local hash list. `verifyStagedUpdate(receipt, options)` repeats this full check before launch, including extra-file detection. Large updates therefore have a visible verification period.

Inside Electron, staging reads, writes and verifies physical files through its built-in `original-fs`; ordinary Node helpers use `node:fs`. ASAR resources remain exact archive bytes rather than virtual directories, and no process-wide ASAR setting changes. ZIP and tar parsers provide entry streams after full inspection; the staging module writes those streams with the same physical filesystem and rejects members below any file. Cancellation closes the owned archive input and parser, waits for started writes to settle, and removes only the unfinished private stage.

[bootstrap.mjs](bootstrap.mjs) owns `pending`, `committed`, `active` and `failed` receipts. For an authorized restart, main first calls `prepareActivation(receipt, { updatesDirectory, target, currentVersion, currentExecutable, currentPid })` to complete slow verification and record a pending attempt while existing work can continue. It then obtains its task-maintenance lease, rechecks that lease before and after `launchActivation(activation, { helperExecutable, helperScript, electronRunAsNode })`, and performs its normal shutdown. A failed final check cancels the pending attempt. The separate [runner.mjs](runner.mjs) helper waits for that exact parent PID to exit before starting the new full application. Electron can execute this helper with `ELECTRON_RUN_AS_NODE=1`; the real application receives a cleaned OS environment without that switch, `NODE_OPTIONS` or inherited API credentials.

On startup, `bootstrapUpdate({ updatesDirectory, target, currentVersion, currentExecutable })` returns `continue`, `wait` or `forward`. Main does not admit work for `wait`; for `forward`, it launches the returned `activation` through the helper and quits normally. A pending new application receives an attempt identity from bootstrap. Immediately before starting its backend or opening local stores, it awaits `acknowledgeDataAccess({ updatesDirectory, target, currentVersion, currentExecutable, attemptId, token })`. This durably marks the version `committed`, because even startup can write a newer data format. It does not claim UI readiness. After backend and UI readiness, but before accepting work, `acknowledgeReady` with the same options changes the version to `active`; the companion requires its window to be ready. Receipts use flushed temporary files and atomic replacement, with directory flushes on POSIX.

Main invokes these acknowledgment methods only when bootstrap returns `pending: true`, using bootstrap's returned attempt identity for committed-version retries. A normal first installation or an already-active restart has no pending attempt and opens its data without update acknowledgment; its update center starts after normal application readiness.

`cancelActivation(activation)` cancels only the matching pending attempt before launch starts, for example when the final maintenance-lease check fails. A waiting helper observes cancellation and starts no process. A failed new process or readiness timeout can return to the prior application only before data access or readiness is committed. The helper first asks its own new child to terminate and waits for confirmed exit; an unresponsive child prevents rollback. Neither `committed` nor `active` versions are automatically downgraded. If a committed application exits or never renders its UI, opening the original installation retries the same verified new version; bootstrap returns its attempt identity so readiness can be retried. The helper reports `committed-not-ready` without claiming completion or launching the old app. Failed pre-data attempts do not restart themselves in a loop, and the helper never kills the original application.

<a id="known-limitations"></a>
## Known limitations

- Archive authentication does not establish Developer ID signing, notarization or successful execution on another computer. The macOS check verifies the existing ad-hoc bundle's integrity. Windows and Linux lifecycle tests use injected process implementations; target-machine launch acceptance is separate.
- Private directories and symlink checks protect the update cache; they do not isolate code already running with the same user's unrestricted filesystem privileges. Windows confidentiality follows the user's profile ACL, not POSIX permission bits.
- Key rotation requires a trusted application update containing the replacement public key. The core rejects downgrades but does not promise delivery of the newest release while the official service or network is unavailable.

<a id="model-experience"></a>
## Model experience

This library does not send prompts, invoke models or change active agent tasks.

<a id="dev-note"></a>
## Dev Note

Run `node --test apps/qianshou-updater/tests/manifest.test.mjs apps/qianshou-updater/tests/download.test.mjs apps/qianshou-updater/tests/stage.test.mjs apps/qianshou-updater/tests/bootstrap.test.mjs apps/qianshou-updater/tests/tar-cancellation.test.mjs` from the source root. These tests use temporary directories, ephemeral signing keys, real ZIP/tar files, a loopback HTTP transport and injected process launches; they do not contact the official update service or modify an installed application. The release build bundles the exact `yauzl` 3.4.0 dependency declared by [the desktop build](../desktop/package.json) and `tar` into the shared updater and standalone helper; packaged applications do not resolve developer workspace dependencies. The pinned ZIP reader uses standard Node stream cleanup, including large deflated entries under the packaged Node runtime. ZIP extraction reads raw filename bytes as strict UTF-8, including Apple `ditto` archives whose UTF-8 flag is unset, after validating the complete entry index.
