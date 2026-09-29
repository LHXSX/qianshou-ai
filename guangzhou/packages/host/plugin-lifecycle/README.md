---
description: "Stage, activate, disable and remove verified Qianshou capability plugins through a reversible lifecycle boundary."
kind: "package-reference"
---

# Qianshou plugin lifecycle

English | [中文](README.zh.md)

## Summary

Coordinate the local lifecycle of a capability plugin after `compute-core` has produced a verified install plan. The package validates staged metadata and opaque files, serializes each plugin identity, and records active, disabled or rolled-back state. Deployment code owns transport, filesystem atomicity, process isolation and loader registration; this package never evaluates plugin bytes.

## Table of Contents

- [Use this package](#use-this-package)
- [Lifecycle boundary](#lifecycle-boundary)
- [Persist verified packages](#persist-verified-packages)
- [Install a real package without a network](#install-real-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

## Use this package

Pass a `ComputePluginInstallPlan` from `planCapabilityPluginInstall` to `PluginLifecycle.install`. Supply a deployment adapter with `readStagedPackage`, atomic `activate`, `deactivate`, and `remove` methods. `CordisLoaderDeployment` is the concrete seam for a real Cordis Loader: its staging callback supplies a previously scanned `entrySpecifier`, then it calls Loader `create`, `update({ disabled: true })`, `remove`, and `await()` as the fiber drain barrier. The adapter may fetch or unpack bytes outside this package, but must present only the staged package it is prepared to activate.

## Lifecycle boundary

`PluginLifecycle` verifies the staged manifest fingerprint, package digest, allowed relative paths and deterministic file digest before activation. It rejects traversal, duplicate files and extra files. Repeated installation of the same active identity and content is idempotent; operations for one identity are serialized. Activation failures attempt deactivation and cleanup, then retain a `rolled_back` receipt. Disable retains staged data for reactivation; uninstall deactivates and removes it.

The lifecycle never downloads, imports, evaluates or executes code. A deployment adapter must perform atomic directory replacement, crash recovery, artifact scanning, OS process isolation and runtime loader registration. `CordisLoaderDeployment` accepts only a trusted specifier selected by that adapter; it does not derive an import path from package bytes. Shanghai remains a metadata-only control plane.

<a id="persist-verified-packages"></a>
## Persist verified packages

Use `LocalPluginStore` as the filesystem staging provider for a Host-owned deployment adapter. Give it a private `root`, positive `maxBundleBytes` and `maxFileCount`. Call `stage` with a signature-verified `ComputePluginInstallPlan` and all payload bytes, then use `readStagedPackage` as the deployment's staging callback. The store checks canonical relative paths, exact file sets, resource limits, manifest fingerprints and byte digests. It rejects symlinks and commits complete content directories by rename; it neither resolves an executable entry nor runs code.

After the Host completes a real activation or deactivation, it can save the owner's preference with `setInstallation`. `getInstallation` reads that preference after restart; `desiredState: enabled` is not evidence of a live loader or a verified advertised capability. The Host must recheck publisher trust and owner grants, obtain a fresh install plan, revalidate stored bytes, activate through its real loader and self-test the capability before advertising. `forgetInstallation` removes only the restart preference after the loader has stopped. Immutable payloads remain available for an explicitly authorized version rollback.

`verifyStagedPluginPackage` revalidates a previously authorized plan against complete staged bytes; use it before persisting or handing bytes to a trusted loader adapter.

Each installation identity includes the plugin and version. This store does not decide which version may run concurrently. The caller owns that policy and the loader drain before replacement; an atomic receipt does not make filesystem persistence and process activation one transaction. Interrupted staging directories are never selected as committed packages.

<a id="install-real-package"></a>
## Install a real package without a network

`PluginPackageSource` is the transport seam: it yields an untrusted file list for a verified plan and never writes to plugin storage. Three sources ship here.

- `DirectoryPluginPackageSource` reads an unpacked directory tree.
- `ArchivePluginPackageSource` reads a local `.zip` through `readPluginZipArchive`, a dependency-free reader that accepts only stored and deflated entries and rejects encryption, Zip64, multi-disk archives, symlink or special-file entries, traversal and absolute paths, duplicate names, CRC or size mismatches and budget violations.
- `StaticPluginPackageSource` serves entries the caller already holds.

No HTTPS downloader ships here: a real market endpoint needs a live server, and this package must not pretend that a URL was fetched.

`loadVerifiedPluginPackage` turns those bytes into a `StagedPluginPackage`. It enforces one shared byte budget (`PluginPackageLimits`: file count, per-file bytes, total bytes), validates canonical relative paths, recomputes the whole-package digest against the signed plan, and verifies every `contract.assets` entry (existence, byte size, sha256). A package carries payload files only: a manifest document that declared its own package digest would have to cover the file stating it, which is a hash fixed point, so the signed plan remains the identity source.

`LocalPluginInstaller` commits that package atomically under a Host-private root:

```
<root>/generations/<identityKey>/<packageDigest>-<manifestFingerprint>/
<root>/receipts/<identityKey>.json
<root>/journal/<identityKey>.json
<root>/.staging/<name>/
```

It stages and fsyncs the payload, `rename`s it into a content-addressed generation, re-reads and re-hashes what is on disk, asks the `PluginLoaderRegistry` seam for a validated loader specifier, writes the receipt atomically, then drops the journal. The receipt is the visibility commit point. `recover()` is a Host-startup step: it removes unreferenced staging directories, rolls back a promotion that never reached a receipt (keeping an earlier committed generation), drops journals of transactions that already committed, removes orphan generations and retracts any installation whose bytes no longer verify. A leftover journal makes `install` fail with `PLUGIN_INSTALLER_RECOVERY_REQUIRED` instead of overwriting an unfinished transaction.

`uninstall` revokes advertisement through the registry first, then awaits an optional Host `awaitInFlight` hook, and only then deletes the receipt and payload, so an in-flight task cannot lose its files. Removing the receipt before the payload keeps a crash from advertising dead bytes.

`PluginLoaderRegistry` is a seam, not a loader. `InMemoryPluginLoaderRegistry` records registrations and validates specifiers; wiring the real Cordis Loader stays a Host-side step and no code here claims that a plugin was loaded or executed.

## Model Experience

This package exposes no model tools and no payment or approval callback. A host may present lifecycle records through an owner-authenticated UI or a separate market consumer.

## Known Limitations and Deferred Work

- `PluginLifecycle` retains live execution state in process. `LocalPluginStore` persists verified bytes and desired state, but the Host must reconcile real loader state after restart; persisted preferences cannot grant permission or prove capability readiness.
- A real market endpoint, HTTPS download, publisher key rotation, sandbox policy and mobile installation adapters are not implemented here. Package intake is local-only on purpose.
- `recover()` retracts a receipt whose bytes no longer verify, but it does not revoke a loader advertisement; run it at startup before any advertisement exists.
- The Cordis adapter still relies on the host-provided Loader instance. `InMemoryPluginLoaderRegistry` records registrations without loading anything.
- A successful lifecycle receipt does not prove that a native H3, image or video executor can run on the device.

### Dev Note

The source and tests intentionally keep package bytes opaque. Do not add a convenience import or shell execution path to this package; those concerns belong to separately reviewed deployment adapters.
