/* oxlint-disable typescript/require-await -- Remote methods reject synchronous validation and storage failures as promises. */
/** Owner Remote and local vault service. Cloud accounts do not affect local-profile ownership. */
import { Context, Service } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-workspace'
import type { Session } from '@deepseek-ai/dsh-session'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from './store.ts'
import { sessionAccess } from './access.ts'
import { MemoryFailure, parseExport, parseId, parseInput, parseQuery, parseRevision, parseReview, safeMemory } from './validation.ts'
import type { MemoryDetail, MemoryEntry, MemoryExportPage, MemoryExportQuery, MemoryHistoryPage, MemoryInput, MemoryOrigin, MemoryPage, MemoryQuery, MemoryReview, MemoryRevision, MemoryState } from './types.ts'
export type * from './types.ts'

/** Deployment storage limits; protocol document/Agent limits remain fixed. */
export interface Config {
  /** Dedicated new-format SQLite path; empty selects the device-memory path under DSH_HOME. */
  path: string
  /** Maximum retained UTF-8 title/content/source/evidence bytes plus serialized revision snapshots. */
  capacityBytes: number
  /** Milliseconds between local expiry cleanup passes; reads also remove expired records. */
  expiryIntervalMs: number
}
declare module '@deepseek-ai/cordis' { interface Context { qianshouMemory: QianshouMemory } }
/** Authoritative device vault, consumed by authenticated owner RPCs and scoped tools. */
export class QianshouMemory extends TypertRemoteService {
  static inject = ['workspaceRegistry']
  static Config: Schema<Config> = Schema.object({
    path: Schema.string().default(''), capacityBytes: Schema.number().min(1024).max(1024 * 1024 * 1024).default(128 * 1024 * 1024),
    expiryIntervalMs: Schema.number().min(1000).max(3600000).default(60000),
  })
  private store: MemoryStore | undefined
  constructor(ctx: Context, private readonly config: Config) { super(ctx, 'qianshouMemory') }
  protected async [Service.init](): Promise<void> {
    const lifetime: { disposed: boolean; opening?: Promise<MemoryStore>; timer?: ReturnType<typeof setInterval> } = { disposed: false }
    this.ctx.effect(() => async () => {
      lifetime.disposed = true
      if (lifetime.timer !== undefined) clearInterval(lifetime.timer)
      this.store = undefined
      // Initialization reports an open failure; disposal only releases an acquired handle.
      const owned = await lifetime.opening?.catch(() => undefined)
      owned?.close()
    }, 'qianshou-memory: vault lifetime')
    const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
    lifetime.opening = MemoryStore.open(this.config.path || join(home, 'qianshou', 'device-memory', 'v1.sqlite'), this.config.capacityBytes)
    const store = await lifetime.opening
    if (lifetime.disposed) return
    this.store = store
    lifetime.timer = setInterval(() => {
      try { store.expire() } catch (error) {
        this.ctx.logger.warn('Device memory expiry failed; owner reads will report storage status.',
          error instanceof MemoryFailure ? error.code : 'storage-failed')
      }
    }, this.config.expiryIntervalMs)
    lifetime.timer.unref()
  }
  private vault(): MemoryStore { if (!this.store) throw new MemoryFailure('closed'); return this.store }
  /**
   * Read vault identity and registered destinations without requiring a cloud login.
   * @returns Local metadata.
   */
  @Remote
  async state(): Promise<MemoryState> { return safeMemory(() => ({ ...this.vault().identity(),
    workspaces: this.ctx.workspaceRegistry.list().map(({ id,
      path,
      title }) => ({ id,
      path,
      title })) })) }
  /**
   * Browse owner-visible records.
   * @param query - Bounded owner filters.
   * @returns Summaries and counts.
   */
  @Remote
  async list(query: MemoryQuery): Promise<MemoryPage> { return safeMemory(() => this.vault().list(parseQuery(query))) }
  /**
   * Read an owner record with historical revisions.
   * @param id - Entry id.
   * @returns Original and versions.
   */
  @Remote
  async read(id: string): Promise<MemoryDetail> { return safeMemory(() => this.vault().read(parseId(id))) }
  /**
   * Read at most two previous versions without transferring the whole retained history.
   * @param value - Current record fence.
   * @param offset - History offset.
   * @returns Bounded owner history.
   */
  @Remote
  async history(value: MemoryRevision, offset: number): Promise<MemoryHistoryPage> {
    return safeMemory(() => {
      const input = parseRevision(value)
      if (!Number.isSafeInteger(offset) || offset < 0) throw new MemoryFailure('invalid-request')
      return this.vault().historyPage(input.id, input.expectedRevision, offset)
    })
  }
  /**
   * Commit a draft, preserving existing text on stale revisions.
   * @param value - Explicit owner draft.
   * @returns Committed entry.
   */
  @Remote
  async save(value: MemoryInput): Promise<MemoryEntry> {
    return safeMemory(() => {
      const draft = parseInput(value)
      const workspace = draft.workspaceId ? this.ctx.workspaceRegistry.get(draft.workspaceId) : undefined
      if (draft.scope === 'workspace' && !workspace) throw new MemoryFailure('workspace-required')
      return this.vault().save(draft, workspace?.path ?? null)
    })
  }
  /**
   * Accept or reject a candidate as the authenticated local owner.
   * @param value - Decision with revision.
   * @returns Saved entry or deletion.
   */
  @Remote
  async review(value: MemoryReview): Promise<MemoryEntry | { deleted: true }> { return safeMemory(() => { const input = parseReview(value)
    return this.vault().review(input.id, input.expectedRevision, input.action) }) }
  /**
   * Erase one unchanged record and every retained version/index row.
   * @param value - Identifier and expected revision.
   * @returns Deletion receipt.
   */
  @Remote
  async delete(value: MemoryRevision): Promise<{ deleted: true }> { return safeMemory(() => { const input = parseRevision(value)
    return this.vault().delete(input.id, input.expectedRevision) }) }
  /**
   * Read one bounded export page; later pages must retain its revision.
   * @param value - Export cursor.
   * @returns Consistent export page.
   */
  @Remote
  async exportPage(value: MemoryExportQuery): Promise<MemoryExportPage> {
    return safeMemory(() => this.vault().exportPage(parseExport(value))) }
  /**
   * Retrieve confirmed content under the actual Session workspace.
   * @param session - Tool caller.
   * @param query - Model filters, bounded by the tool.
   * @param signal - Tool cancellation.
   * @returns Accessible summaries only.
   */
  async searchForSession(session: Session, query: MemoryQuery, signal: AbortSignal): Promise<MemoryPage> {
    const access = await sessionAccess(this.ctx.workspaceRegistry, session, signal)
    return safeMemory(() => this.vault().list(parseQuery(query), access))
  }
  /**
   * Read an accessible original without revision history.
   * @param session - Tool caller.
   * @param id - Model record id.
   * @param signal - Tool cancellation.
   * @returns Confirmed scoped original.
   */
  async readForSession(session: Session, id: string, signal: AbortSignal): Promise<MemoryDetail> {
    const access = await sessionAccess(this.ctx.workspaceRegistry, session, signal)
    return safeMemory(() => this.vault().read(parseId(id), access))
  }
  /**
   * Propose an experience for human review in the actual current workspace.
   * @param session - Tool caller.
   * @param callId - Runtime tool call identity.
   * @param value - Model proposal fields.
   * @param signal - Tool cancellation.
   * @returns Durable candidate.
   */
  async proposeForSession(session: Session, callId: MemoryOrigin['callId'], value: Pick<MemoryInput, 'title' | 'content' | 'evidence'>, signal: AbortSignal): Promise<MemoryEntry> {
    const access = await sessionAccess(this.ctx.workspaceRegistry, session, signal)
    return safeMemory(() => {
      if (!access.workspaceId) throw new MemoryFailure('workspace-required')
      const draft = parseInput({ ...value, kind: 'experience', scope: 'workspace', workspaceId: access.workspaceId })
      if (Buffer.byteLength(draft.content) > 16000) throw new MemoryFailure('invalid-request')
      return this.vault().propose(draft, access, { sessionId: session.id, callId })
    })
  }
}
export default QianshouMemory
