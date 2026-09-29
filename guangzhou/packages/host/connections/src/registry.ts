/** Durable non-secret registry with operation cancellation and live preset authorization. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-presets'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { githubIdentity, githubRepositories, inspectSsh } from './providers.ts'
import type { ProviderConfig } from './providers.ts'
import { connectionDraft, connectionId, storedConnections } from './validation.ts'
import type { ConnectionId, ConnectionProbe, ConnectionView, GithubRepositoryPage, SshInspection } from './types.ts'

/** Registry configuration after deployment defaults and paths are resolved. */
export interface RegistryConfig extends ProviderConfig { statePath: string; maxConcurrent: number }
interface Pending { id: ConnectionId; controller: AbortController; done: Promise<unknown> }
const CODES = new Set(['CONNECTION_NOT_FOUND', 'CONNECTION_REVOKED', 'CONNECTION_BUSY', 'CONNECTION_TIMEOUT',
  'REQUEST_ABORTED', 'CONNECTION_FORBIDDEN', 'CONNECTION_KIND_MISMATCH', 'INVALID_CONNECTION_PAGE',
  'SSH_UNAVAILABLE', 'GH_UNAVAILABLE', 'CONNECTION_AUTH_OR_NETWORK_FAILED', 'CONNECTION_OUTPUT_LIMIT',
  'INVALID_GITHUB_RESPONSE', 'CREDENTIAL_UNAVAILABLE', 'GITHUB_AUTH_REJECTED', 'GITHUB_REQUEST_FAILED', 'INVALID_SSH_RESPONSE'])

/** Map external failures to non-secret stable codes.
 * @param error - Provider or cancellation failure.
 * @returns Public diagnostic code without credentials or raw stderr.
 */
export function connectionError(error: unknown): string {
  return error instanceof Error && CODES.has(error.message) ? error.message : 'CONNECTION_FAILED'
}

/** One Host owns the metadata file and all active read requests. */
export class ConnectionsRegistry {
  private rows = new Map<ConnectionId, ConnectionView>()
  private pending = new Set<Pending>()
  private writes: Promise<void> = Promise.resolve()
  private closed = false
  private constructor(private readonly ctx: Context, private readonly config: RegistryConfig) {}

  /** Load validated metadata; previous process probes are not treated as current evidence.
   * @param ctx - Host services.
   * @param config - Resolved storage and provider configuration.
   * @returns Ready registry, empty only when no file exists.
   */
  static async open(ctx: Context, config: RegistryConfig): Promise<ConnectionsRegistry> {
    const service = new ConnectionsRegistry(ctx, config)
    let raw: string
    try { raw = await readFile(config.statePath, 'utf8') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return service; throw error }
    let document: unknown
    try { document = JSON.parse(raw) }
    catch { throw new Error('INVALID_CONNECTION_STORE') }
    for (const row of storedConnections(document)) service.rows.set(row.id, row)
    return service
  }

  /** List non-secret rows, limited to an actor's live preset when called by a tool.
   * @param actor - Model caller; omitted only by authenticated user routes.
   * @returns Detached rows; callers cannot mutate registry state.
   */
  list(actor?: Agent): ConnectionView[] {
    if (this.closed) throw new Error('CONNECTION_REVOKED')
    return [...this.rows.values()].filter(row => actor === undefined || this.canUse(row, actor)).map(row => structuredClone(row))
  }

  /** Save configuration, revoke in-flight reads and clear old probe evidence.
   * @param input - Untrusted browser draft.
   * @returns The committed non-secret view.
   */
  save(input: unknown): Promise<ConnectionView> {
    const draft = connectionDraft(input)
    return this.mutate(async () => {
      const previous = draft.id === undefined ? undefined : this.rows.get(draft.id)
      if (draft.id !== undefined && previous === undefined) throw new Error('CONNECTION_NOT_FOUND')
      if (previous === undefined && this.rows.size >= 200) throw new Error('CONNECTION_BUSY')
      const id = draft.id ?? connectionId(randomUUID())
      const row: ConnectionView = { ...draft, id, revision: (previous?.revision ?? 0) + 1, updatedAt: new Date().toISOString() }
      this.rows.set(id, row)
      await this.cancel(id)
      try { await this.persist() }
      catch (error) { if (previous) this.rows.set(id, previous); else this.rows.delete(id); throw error }
      return structuredClone(row)
    })
  }

  /** Revoke a connection and drain its owned operations before returning.
   * @param id - Connection address.
   * @returns Acknowledgment after durable removal.
   */
  delete(id: ConnectionId): Promise<{ deleted: true }> {
    return this.mutate(async () => {
      const previous = this.rows.get(id)
      if (!previous) throw new Error('CONNECTION_NOT_FOUND')
      this.rows.delete(id)
      await this.cancel(id)
      try { await this.persist() }
      catch (error) { this.rows.set(id, previous); throw error }
      return { deleted: true }
    })
  }

  /** Perform a real bounded authentication/read probe and store only public evidence.
   * @param id - Saved connection address.
   * @param signal - Browser or tool cancellation.
   * @param actor - Model caller; omitted by the authenticated user probe.
   * @returns Success or stable failure evidence for this exact connection revision.
   */
  async probe(id: ConnectionId, signal: AbortSignal, actor?: Agent): Promise<ConnectionProbe> {
    return await this.operation(id, signal, actor, async (row, owned) => {
      const { lastProbe: _previousProbe, ...unverified } = row
      this.rows.set(id, unverified)
      const probe: ConnectionProbe = { ok: false, at: new Date().toISOString(), method: row.kind === 'ssh' ? 'ssh' : row.github.auth === 'gh' ? 'gh' : 'credential' }
      try {
        if (row.kind === 'github') probe.identity = await githubIdentity(this.ctx, row, this.config, owned)
        else {
          const detail = await inspectSsh(this.ctx, row, this.config, owned)
          probe.identity = detail.user; probe.detail = `${detail.platform} · ${detail.directory}`
        }
        probe.ok = true
      } catch (error) {
        if (owned.aborted) throw owned.reason
        probe.error = connectionError(error)
      }
      owned.throwIfAborted()
      this.assertCurrent(row, actor)
      this.rows.set(id, { ...row, lastProbe: probe })
      return probe
    })
  }

  /** Read public repository metadata through the saved account.
   * @param id - GitHub connection address.
   * @param page - One-based page, capped at 1000.
   * @param signal - Request cancellation.
   * @param actor - Model caller; omitted by authenticated user routes.
   * @returns One bounded repository page.
   */
  async repositories(id: ConnectionId, page: number, signal: AbortSignal, actor?: Agent): Promise<GithubRepositoryPage> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new Error('INVALID_CONNECTION_PAGE')
    return await this.operation(id, signal, actor, (row, owned) => {
      if (row.kind !== 'github') throw new Error('CONNECTION_KIND_MISMATCH')
      return githubRepositories(this.ctx, row, page, this.config, owned)
    })
  }

  /** Run the fixed read-only SSH inspection; arbitrary commands are not exposed.
   * @param id - SSH connection address.
   * @param signal - Request cancellation.
   * @param actor - Required live model caller.
   * @returns Verified OS, directory and login user.
   */
  async inspect(id: ConnectionId, signal: AbortSignal, actor: Agent): Promise<SshInspection> {
    return await this.operation(id, signal, actor, (row, owned) => {
      if (row.kind !== 'ssh') throw new Error('CONNECTION_KIND_MISMATCH')
      return inspectSsh(this.ctx, row, this.config, owned)
    })
  }

  /** Cancel reads using a changed credential reference; old probes are invalidated.
   * @param ref - Updated Host credential reference.
   * @returns Completion after matching readers drain.
   */
  async credentialChanged(ref: string): Promise<void> {
    const changed: ConnectionId[] = []
    for (const row of [...this.rows.values()]) {
      if (row.kind !== 'github' || row.github.credentialRef !== ref) continue
      const { lastProbe: _probe, ...rest } = row
      this.rows.set(row.id, rest)
      changed.push(row.id)
    }
    await Promise.all(changed.map(id => this.cancel(id)))
  }

  /** Stop admitting operations, cancel all readers and await quiescence. */
  async close(): Promise<void> {
    this.closed = true
    for (const task of this.pending) task.controller.abort(new Error('CONNECTION_REVOKED'))
    await Promise.allSettled([...this.pending].map(task => task.done))
    await this.writes
  }

  private canUse(row: ConnectionView, actor: Agent): boolean {
    const preset = this.ctx.agentPresets.composedPreset(actor.ctx)
    return this.ctx.agents.get(actor.id) === actor && preset !== undefined && row.allowedPresets.includes(preset)
  }
  private assertCurrent(row: ConnectionView, actor: Agent | undefined): void {
    if (this.closed || this.rows.get(row.id)?.revision !== row.revision) throw new Error('CONNECTION_REVOKED')
    if (actor !== undefined && !this.canUse(row, actor)) throw new Error('CONNECTION_FORBIDDEN')
  }
  private async operation<T>(id: ConnectionId, signal: AbortSignal, actor: Agent | undefined,
    run: (row: ConnectionView, owned: AbortSignal) => Promise<T>): Promise<T> {
    const row = this.rows.get(id)
    if (!row) throw new Error('CONNECTION_NOT_FOUND')
    this.assertCurrent(row, actor)
    signal.throwIfAborted()
    if (this.pending.size >= this.config.maxConcurrent) throw new Error('CONNECTION_BUSY')
    const controller = new AbortController()
    const abort = () =>{  controller.abort(new Error('REQUEST_ABORTED')) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() =>{  controller.abort(new Error('CONNECTION_TIMEOUT')) }, this.config.timeoutMs)
    const task: Pending = { id, controller, done: Promise.resolve() }
    this.pending.add(task)
    const done = Promise.resolve().then(async () => {
      controller.signal.throwIfAborted()
      const result = await run(row, controller.signal)
      controller.signal.throwIfAborted()
      this.assertCurrent(row, actor)
      return result
    })
    task.done = done
    try { return await done }
    catch (error) { throw new Error(connectionError(controller.signal.aborted ? controller.signal.reason : error)) }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort); this.pending.delete(task) }
  }
  private async cancel(id: ConnectionId): Promise<void> {
    const pending = [...this.pending].filter(item => item.id === id)
    pending.forEach((task) =>{  task.controller.abort(new Error('CONNECTION_REVOKED')) })
    await Promise.allSettled(pending.map(task => task.done))
  }
  private async persist(): Promise<void> {
    const connections = [...this.rows.values()].map(({ lastProbe: _probe, ...row }) => row)
    await writeFileAtomic(this.config.statePath, JSON.stringify({ version: 1, connections }), { mode: 0o600 })
  }
  private mutate<T>(run: () => Promise<T>): Promise<T> {
    const task = this.writes.then(async () => { if (this.closed) throw new Error('CONNECTION_REVOKED'); return await run() })
    this.writes = task.then(() => {}, () => {})
    return task
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { /** User-authorized read-only external connections. */ connections: ConnectionsRegistry }
}
