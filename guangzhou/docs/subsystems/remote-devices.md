# Remote devices

English | [中文](remote-devices.zh.md)

The remote-device subsystem coordinates paired companion computers and finite tasks through `ctx.remoteDevices`. The [Host coordinator](../../packages/host/remote-devices/README.md) owns device authentication and durable receipts; the [companion](../../apps/qianshou-companion/README.md) owns local approval and execution. Remote workspace paths remain peer metadata and do not identify directories on the controller.

## Public records

`DeviceInfo` contains the paired identity, display name, platform, architecture, advertised workspaces, connectivity and observation times. It exposes no credential or pairing code. `RemoteJob` contains the actual request identity, destination, operation, payload, state, times and output; optional result and error fields record the peer outcome. `cancelRequested` records intent independently of the terminal state. Exact declarations and input bounds belong to [protocol.ts](../../packages/host/remote-devices/src/protocol.ts).

## Task lifecycle

Submission validates the request and approved workspace, persists an `awaiting-approval` task and sends it to an online peer. The returned receipt confirms acceptance only. Status reads do not start or retry execution. Cancellation records and forwards a request; the peer's terminal receipt determines whether work completed, failed, was rejected, was cancelled or was interrupted. Pairing and revocation remain authenticated human operations outside the model-safe service.

Reconnection synchronizes retained work and receipts without granting automatic execution. These finite tasks do not dispatch Harness Sessions or subagents to another machine. See [remote collaboration](../qianshou-remote-devices.md) for deployment prerequisites and native-machine acceptance boundaries.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremotedevices--remotedevicesservice"></a>

### `ctx.remoteDevices` — `RemoteDevicesService`

Authenticated task coordination without access to pairing secrets or device revocation.

```ts cordis-catalog
/**
 * Read public device metadata without exposing credentials or pairing codes.
 * @returns Cloned devices including connectivity and advertised workspace IDs.
 */
devices(): DeviceInfo[]

/**
 * Persist a validated task before delivering it to the selected online peer.
 * @param value - Untrusted finite task request, validated by the coordinator.
 * @returns The actual task in awaiting-approval state; acceptance does not mean execution.
 * @throws If the device is offline, its workspace is absent, input is invalid or task capacity is exhausted.
 */
submit(value: unknown): Promise<RemoteJob>

/**
 * Read a retained task receipt without starting or retrying work.
 * @param id - Existing task identity.
 * @returns A cloned receipt, or undefined when the task is absent or no longer retained.
 */
task(id: string): RemoteJob | undefined

/**
 * Record a cancellation request and forward it to an available peer.
 * @param id - Existing task identity.
 * @returns Request acceptance; a terminal receipt still determines the execution outcome.
 * @throws If the task is unknown or persistence fails.
 */
cancel(id: string): Promise<{ accepted: true }>
```

Source: [`packages/host/remote-devices/src/service.ts`](../../packages/host/remote-devices/src/service.ts)
<!-- END GENERATED cordis-surface -->
