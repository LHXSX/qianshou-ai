# Connections

English | [中文](connections.zh.md)

The connections subsystem exposes `ctx.connections` for saving a public GitHub account or an SSH destination in non-secret form, testing it with a real bounded read, and granting selected employee presets access. It keeps validated metadata, in-flight operation cancellation, live preset authorization, and external provider reads behind one Host service. Saving a record establishes no connectivity, and a probe is process-local evidence rather than a stored fact.

Provider work runs through the existing Subprocess and Credentials services rather than a private carrier: `ssh` and `gh` execute under the shared process ownership rules, and credential values never enter a connection record. The service performs no write operation against a remote system — it does not clone, publish, create issues or deploy — and it exposes no arbitrary command endpoint.

## Public records

`ConnectionId` is the stable branded identity of one saved record. `ConnectionView` is the detached, non-secret row every authenticated reader receives: identity, kind, provider targets, credential references, revision and update time. `ConnectionDraft` is the untrusted browser input a save accepts, and `ConnectionRecord` is the stored shape behind the view. `ConnectionProbe` carries the latest test result — outcome, time, the authentication method actually used, and either identity/detail or a stable error code — and never raw stderr or a secret value. `GithubRepositoryPage` carries one page of public repository metadata with an optional `nextPage`. `SshInspection` carries the fixed `uname -s && pwd && id -un` result. Field contracts live in [types.ts](../../packages/host/connections/src/types.ts), input validation in [validation.ts](../../packages/host/connections/src/validation.ts).

## Ownership and boundaries

[registry.ts](../../packages/host/connections/src/registry.ts) owns validated metadata and active operations: saving or deleting a connection cancels and drains its in-flight reads and invalidates probe evidence, a credential-reference change invalidates matching probes, and every model read verifies the exact live Agent and its actual composed preset before and after asynchronous work. [providers.ts](../../packages/host/connections/src/providers.ts) performs the GitHub HTTP/CLI and OpenSSH reads, [process.ts](../../packages/host/connections/src/process.ts) uses the Subprocess provider for a scrubbed environment, bounded collection, cancellation and process-tree quiescence, [routes.ts](../../packages/host/connections/src/routes.ts) exposes the authenticated user operations under `/api/qianshou/connections`, and [tools.ts](../../packages/host/connections/src/tools.ts) registers the read tools through the normal `tools/pre-execute` policy.

What this subsystem does not own is as important as what it does. Access grants are attached to employee presets, so the preset roster and its composition are owned by the [agent presets](../../packages/preset/agent-presets/README.md) package; a revoked connection or a changed preset cannot return a late success, because every read revalidates both. Secret storage and per-operation resolution belong to the [credentials](credentials.md) seam, and process ownership belongs to the [subprocess](subprocess.md) seam. Model API connections are a different surface entirely and use the Models settings page.

A connection is read-only by construction. SSH supports existing agent or key authentication with an already trusted host key; unknown host keys, unavailable credentials and unreachable servers fail visibly, and the connector never accepts a fingerprint or prompts for a password automatically. GitHub reads the authenticated `user` and paginated public `user/repos` on public github.com. GitHub Enterprise, interactive OAuth/device login, arbitrary SSH execution and every remote write operation remain outside this subsystem and require a separately approved execution path.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnections--connectionsregistry"></a>

### `ctx.connections` — `ConnectionsRegistry`

One Host owns the metadata file and all active read requests.

```ts cordis-catalog
/** List non-secret rows, limited to an actor's live preset when called by a tool.
 * @param actor - Model caller; omitted only by authenticated user routes.
 * @returns Detached rows; callers cannot mutate registry state.
 */
list(actor?: Agent): ConnectionView[]

/** Save configuration, revoke in-flight reads and clear old probe evidence.
 * @param input - Untrusted browser draft.
 * @returns The committed non-secret view.
 */
save(input: unknown): Promise<ConnectionView>

/** Revoke a connection and drain its owned operations before returning.
 * @param id - Connection address.
 * @returns Acknowledgment after durable removal.
 */
delete(id: ConnectionId): Promise<{ deleted: true }>

/** Perform a real bounded authentication/read probe and store only public evidence.
 * @param id - Saved connection address.
 * @param signal - Browser or tool cancellation.
 * @param actor - Model caller; omitted by the authenticated user probe.
 * @returns Success or stable failure evidence for this exact connection revision.
 */
async probe(id: ConnectionId, signal: AbortSignal, actor?: Agent): Promise<ConnectionProbe>

/** Read public repository metadata through the saved account.
 * @param id - GitHub connection address.
 * @param page - One-based page, capped at 1000.
 * @param signal - Request cancellation.
 * @param actor - Model caller; omitted by authenticated user routes.
 * @returns One bounded repository page.
 */
async repositories(id: ConnectionId, page: number, signal: AbortSignal, actor?: Agent): Promise<GithubRepositoryPage>

/** Run the fixed read-only SSH inspection; arbitrary commands are not exposed.
 * @param id - SSH connection address.
 * @param signal - Request cancellation.
 * @param actor - Required live model caller.
 * @returns Verified OS, directory and login user.
 */
async inspect(id: ConnectionId, signal: AbortSignal, actor: Agent): Promise<SshInspection>

/** Cancel reads using a changed credential reference; old probes are invalidated.
 * @param ref - Updated Host credential reference.
 * @returns Completion after matching readers drain.
 */
async credentialChanged(ref: string): Promise<void>

/** Stop admitting operations, cancel all readers and await quiescence. */
async close(): Promise<void>
```

Types: [Agent](core.md)

Source: [`packages/host/connections/src/registry.ts`](../../packages/host/connections/src/registry.ts)
<!-- END GENERATED cordis-surface -->

## Further Exploration

- [Connections package](../../packages/host/connections/README.md) — configuration, provider commands, route table, and model-facing tools.
- [Credentials](credentials.md) — secret references and storage providers.
- [Subprocess](subprocess.md) — process ownership and bounded output.
- [Agent presets](../../packages/preset/agent-presets/README.md) — the live composition that carries access grants.
- [Tools](tools.md) — policy and durable tool-call records.
