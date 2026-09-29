/**
 * Child-turn captures leased to their verified root Session. Completed
 * evidence is also written under the configured durable directory, read back
 * on demand for roots that still exist, and removed for roots that no longer do.
 */
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import { compareText } from './compare.ts'
import {
  CHILD_EVIDENCE_SCHEMA_VERSION, ChildEvidenceStore, InvalidChildEvidenceError,
  type DurableEntry, type DurableFileSources, type DurableIndex, type DurableRecord, type DurableSide,
} from './durable.ts'
import { TurnRecorder, type ContentSource, type RecorderEnvironment } from './recorder.ts'
import type { ChildWorkspaceChanges, WorkspaceChangesSummary, WorkspaceChildChange, WorkspaceFileDiff } from './types.ts'

interface ChildTurn {
  sessionId: SessionId
  ancestors: readonly SessionId[]
  turn: number
  cwd: string
  recorder: TurnRecorder
  state: WorkspaceChildChange['state']
  reason?: WorkspaceChildChange['reason']
  shared: boolean
  closed: boolean
  bytes: number
  paths: Set<string>
  copies: Set<string>
  /** The sealed turn's index entries and the scratch copy of each referenced object, set once the turn is exported for the durable index. */
  exported?: { recordedAt: number; entries: DurableEntry[]; objects: Map<string, string> }
}
interface RootRecords { root: Session; turns: ChildTurn[]; lifetime: AbortController }

/** One root's durable evidence as this process knows it. */
interface DurableRoot {
  id: SessionId
  /** Records read from disk or folded from disposed live turns, oldest first. */
  records: DurableRecord[]
  /**
   * `loading` until the index is read; `ready` for a readable index of an existing root; `missing` once the
   * root was found absent from Session storage and its directory removed; `unreadable` for an index that
   * failed validation or reading, which the next index write of a live root replaces.
   */
  status: 'loading' | 'ready' | 'missing' | 'unreadable'
  /** Serialized disk work for the root: the load, then each index write; it always settles. */
  chain: Promise<void>
  /** Set when the live root was disposed; the next reader replaces this view with a fresh read of the index. */
  retiring: boolean
}

/** The durable Session store, when the composition mounts one; only whether a root still exists is asked of it. */
interface SessionExistence { stat(id: SessionId, options?: { signal?: AbortSignal }): Promise<unknown> }

/** Configuration of capture size and per-root retained evidence. */
export interface ChildCaptureConfig {
  maxFiles: number
  maxFileBytes: number
  diffTimeoutMs: number
  childMaxRecords: number
  childMaxBytes: number
  /** Absolute directory receiving completed child evidence; absent keeps evidence process-local. */
  childDurableDir?: string
}

/** Owns child observations, immutable completed evidence, its durable copy, and root-scoped cleanup. */
export class ChildChanges {
  private readonly roots = new Map<Session, RootRecords>()
  private readonly active = new Map<Session, ChildTurn>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly lifetime = new AbortController()
  private readonly store: ChildEvidenceStore | undefined
  /** Durable views by root id. */
  private readonly durable = new Map<SessionId, DurableRoot>()
  /** Root of every Session id looked up so far; null records that no evidence names the id. */
  private readonly pointers = new Map<SessionId, SessionId | null>()
  private readonly resolving = new Map<SessionId, Promise<void>>()

  constructor(private readonly ctx: Context, private readonly config: ChildCaptureConfig) {
    this.store = config.childDurableDir === undefined ? undefined : new ChildEvidenceStore(config.childDurableDir)
  }

  /** Open a real child turn only when the complete live parent chain is verifiable.
   * @param session - executing child Session instance.
   * @param turn - child turn number.
   */
  start(session: Session, turn: number): void {
    const chain: Session[] = []
    let current = session
    const seen = new Set<SessionId>([session.id])
    while (current.header.parentSession !== undefined) {
      const parent = this.ctx.get('sessions')?.get(current.header.parentSession)
      if (parent === undefined || seen.has(parent.id)) return
      chain.push(parent)
      seen.add(parent.id)
      current = parent
    }
    const root = chain.at(-1)
    const cwd = session.header.cwd
    if (root === undefined || cwd === undefined || root.header.origin === 'subagent' || (root.header.delegationDepth ?? 0) > 0) return
    let owner = this.roots.get(root)
    if (owner === undefined) {
      owner = { root, turns: [], lifetime: new AbortController() }
      this.roots.set(root, owner)
      if (this.store !== undefined) {
        for (const ancestor of chain) this.pointers.set(ancestor.id, root.id)
        this.durableFor(root.id, 'live')
      }
    }
    const env: RecorderEnvironment = {
      git: Promise.resolve(null), tempRoot: tmpdir(), ...this.config, toolCapturesOnly: true,
      warn: () => { entry.reason ??= 'capture-failed'; this.ctx.logger.warn('workspace-changes: child file capture failed') },
    }
    const entry: ChildTurn = {
      sessionId: session.id, ancestors: chain.map(item => item.id), turn, cwd,
      recorder: new TurnRecorder(session, cwd, env), state: 'pending', shared: false,
      closed: false, bytes: 0, paths: new Set(), copies: new Set(),
    }
    owner.turns.push(entry)
    this.active.set(session, entry)
    entry.recorder.start(turn)
  }

  /** Remember only this child's own durable tool result sequence.
   * @param session - event owner.
   * @param event - committed child tool result.
   */
  observe(session: Session, event: SessionEvent<'tool/result'>): void { this.active.get(session)?.recorder.observe(event) }

  /** Observe a successful first-party provider result after its internal authorization and mutation.
   * @param exec - source execution identity.
   * @param next - remaining tool dispatch, including sandbox approval.
   * @returns the original tool result without rewriting it.
   */
  async execute(exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>): Promise<ToolExecutionResult> {
    const session = exec.agent?.session
    const entry = session === undefined ? undefined : this.active.get(session)
    const result = await next()
    if (entry === undefined || session === undefined || entry.closed || this.active.get(session) !== entry
      || (exec.name !== 'write' && exec.name !== 'edit')) return result
    const owner = [...this.roots.values()].find(root => root.turns.includes(entry))
    if (owner === undefined || owner.lifetime.signal.aborted || this.lifetime.signal.aborted) return result
    if (result.isError || exec.signal.aborted) { entry.reason = 'capture-failed'; return result }
    const value = result.value
    // This is the declared tool JSON result, never model text or presentation hunks.
    if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof value.path !== 'string'
      || typeof value.after !== 'string' || (typeof value.before !== 'string' && value.before !== null)
      || (exec.name === 'write' && value.operation !== 'create' && value.operation !== 'update')
      || (exec.name === 'edit' && typeof value.before !== 'string')) {
      entry.reason = 'capture-failed'
      return result
    }
    const signal = AbortSignal.any([owner.lifetime.signal, this.lifetime.signal])
    try {
      const fs = exec.agent?.ctx.get('fs')
      if (fs === undefined) entry.reason = 'execution-unavailable'
      else {
        const absolute = fs.processPath(await fs.resolve(value.path, { cwd: entry.cwd, signal }))
        const mapped = fs.processPathFromHostPath(absolute)
        if (mapped === undefined) entry.reason = 'execution-unavailable'
        else {
          if (fs.processPath(await fs.resolve(mapped, { signal })) !== absolute) { entry.reason = 'execution-unavailable'; return result }
          for (const root of this.roots.values()) for (const other of root.turns) {
            if (other !== entry && !other.closed && other.paths.has(absolute)) other.shared = entry.shared = true
          }
          if (!entry.paths.has(absolute) && entry.paths.size >= this.config.maxFiles) entry.reason = 'retention-limit'
          else {
            entry.paths.add(absolute)
            const bound = async (content: string | null): Promise<Uint8Array | null | 'oversized'> => {
              if (content === null) return null
              if (Buffer.byteLength(content) > this.config.maxFileBytes) return 'oversized'
              const bytes = Buffer.from(content)
              return await this.reserve(owner, entry, bytes) ? bytes : 'oversized'
            }
            // A provider may omit an overwritten binary/large file's old text. It is not a creation.
            const before = value.before === null && value.operation === 'update' ? 'oversized' : await bound(value.before)
            await entry.recorder.captureOutcome(absolute, before, await bound(value.after))
          }
        }
      }
    } catch {
      entry.reason = signal.aborted ? 'cancelled' : 'capture-failed'
    }
    return result
  }

  /** Publish before turn/end while the child Session remains writable.
   * @param session - stopping child.
   * @param turn - its turn number.
   */
  async stopping(session: Session, turn: number): Promise<void> {
    const entry = this.active.get(session)
    if (entry?.turn === turn) await entry.recorder.stopping(turn)
  }

  /** Seal completed evidence and enforce root retention without deleting workspace files.
   * @param session - event owner.
   * @param turn - completed child turn.
   */
  end(session: Session, turn: number): void {
    const entry = this.active.get(session)
    if (entry?.turn !== turn) return
    entry.recorder.end(turn)
    this.active.delete(session)
    this.track(this.finish(entry), 'child evidence cleanup failed')
  }

  private async reserve(owner: RootRecords, entry: ChildTurn, bytes: Uint8Array): Promise<boolean> {
    const hash = createHash('sha1').update(bytes).digest('hex')
    if (entry.copies.has(hash)) return true
    while (this.restoredBytes(owner) + owner.turns.reduce((total, item) => total + item.bytes, 0) + bytes.length > this.config.childMaxBytes) {
      if (!await this.evict(owner)) { entry.reason = 'retention-limit'; return false }
      if (owner.lifetime.signal.aborted) return false
    }
    // Reservation is synchronous after the last await, so concurrent captures cannot oversubscribe it.
    entry.copies.add(hash)
    entry.bytes += bytes.length
    return true
  }

  private async finish(entry: ChildTurn): Promise<void> {
    try {
      entry.bytes = await entry.recorder.seal()
    } catch {
      entry.state = 'unavailable'
      entry.reason = 'capture-failed'
      entry.closed = true
      await entry.recorder.dispose()
      entry.bytes = 0
      return
    }
    entry.copies.clear()
    entry.closed = true
    entry.state = entry.recorder.entries().length > 0 ? 'available' : 'unavailable'
    if (entry.state === 'unavailable') entry.reason ??= entry.paths.size > 0 ? 'no-change' : 'untracked'
    const owner = [...this.roots.values()].find(root => root.turns.includes(entry))
    if (owner === undefined || owner.lifetime.signal.aborted) { await entry.recorder.dispose(); return }
    if (this.store !== undefined) {
      try {
        await this.exportTurn(entry)
      } catch {
        // Copies the recorder just sealed could not be described; the turn keeps its reason instead of half its sides.
        entry.state = 'unavailable'
        entry.reason = 'capture-failed'
        await entry.recorder.dispose()
        entry.bytes = 0
        entry.exported = { recordedAt: Date.now(), entries: [], objects: new Map() }
      }
      await this.durable.get(owner.root.id)?.chain
    }
    let retained = this.retainedRecords(owner)
    let bytes = retained.reduce((total, item) => total + item.bytes, 0)
    while (retained.length > this.config.childMaxRecords || bytes > this.config.childMaxBytes) {
      const released = retained[0]?.bytes ?? 0
      if (!await this.evict(owner)) break
      bytes -= released
      retained = retained.slice(1)
    }
    // Bound metadata as well; the newest records retain explicit unavailable states.
    while (this.restoredRecords(owner).length + owner.turns.length > this.config.childMaxRecords) {
      const restored = this.restoredRecords(owner)
      if (restored.length > 0) { restored.shift(); continue }
      const oldest = owner.turns.find(item => item.closed && item !== entry)
      if (oldest === undefined) break
      await this.release(owner, oldest)
      const settledIndex = owner.turns.indexOf(oldest)
      if (settledIndex >= 0) owner.turns.splice(settledIndex, 1)
    }
    if (this.store !== undefined) await this.persist(owner)
  }

  /** Describe the sealed turn's records for the durable index without moving any bytes yet. */
  private async exportTurn(entry: ChildTurn): Promise<void> {
    const objects = new Map<string, string>()
    const side = async (source: ContentSource): Promise<DurableSide> => {
      if (source.kind === 'absent') return { kind: 'absent' }
      /* v8 ignore next -- child recorders take no snapshots, so every stored side is a copy. */
      if (source.kind === 'snapshot') throw new Error('workspace-changes: a child turn has no snapshot side')
      const sha1 = basename(source.file)
      objects.set(sha1, source.file)
      return { kind: 'object', sha1, size: (await stat(source.file)).size }
    }
    const entries: DurableEntry[] = []
    for (const [seq, summary] of entry.recorder.entries()) {
      const files: DurableFileSources[] = []
      for (const sources of entry.recorder.sources(seq) ?? []) {
        files.push(sources.refusal !== undefined ? { refusal: sources.refusal } : { before: await side(sources.before), after: await side(sources.after) })
      }
      entries.push({ seq, summary, files })
    }
    entry.exported = { recordedAt: Date.now(), entries, objects }
  }

  /** Restored records of the owner's root, oldest first; empty while the index is still loading. */
  private restoredRecords(owner: RootRecords): DurableRecord[] {
    const durable = this.durable.get(owner.root.id)
    return durable?.status === 'ready' ? durable.records : []
  }

  private restoredBytes(owner: RootRecords): number {
    return this.restoredRecords(owner).reduce((total, record) => total + record.bytes, 0)
  }

  /** Completed available records, restored then live, oldest first. */
  private retainedRecords(owner: RootRecords): Array<{ bytes: number }> {
    return [
      ...this.restoredRecords(owner).filter(record => record.state === 'available'),
      ...owner.turns.filter(item => item.closed && item.state === 'available'),
    ]
  }

  /** Release the oldest available record, restored before live.
   * @returns false when nothing releasable remains.
   */
  private async evict(owner: RootRecords): Promise<boolean> {
    const restored = this.restoredRecords(owner).find(record => record.state === 'available')
    if (restored !== undefined) {
      restored.state = 'unavailable'
      restored.reason = 'retention-limit'
      restored.bytes = 0
      restored.entries = []
      return true
    }
    const oldest = owner.turns.find(item => item.closed && item.state === 'available')
    if (oldest === undefined) return false
    await this.release(owner, oldest)
    return true
  }

  /** Mark a live turn released and remove its copies once queued index writes have read them. */
  private async release(owner: RootRecords, turn: ChildTurn): Promise<void> {
    turn.state = 'unavailable'
    turn.reason = 'retention-limit'
    await this.durable.get(owner.root.id)?.chain
    await turn.recorder.dispose()
    turn.bytes = 0
  }

  /** Queue one index write holding the restored records and every exported live turn of the root. */
  private persist(owner: RootRecords): Promise<void> {
    const store = this.store
    /* v8 ignore next -- callers check the store first. */
    if (store === undefined) return Promise.resolve()
    const durable = this.durableFor(owner.root.id, 'live')
    const run = durable.chain.then(async () => {
      const objects = new Map<string, string>()
      const live = owner.turns.filter(turn => turn.exported !== undefined)
      for (const turn of live) if (turn.state === 'available') for (const [sha1, file] of turn.exported!.objects) objects.set(sha1, file)
      // A view read from disk after this root was disposed and re-entered already holds earlier writes of these same turns.
      const written = new Set(live.map(turn => `${turn.sessionId}\n${turn.turn}`))
      const index: DurableIndex = {
        schemaVersion: CHILD_EVIDENCE_SCHEMA_VERSION, rootSessionId: owner.root.id, writtenAt: Date.now(),
        records: [...durable.records.filter(record => !written.has(`${record.childSessionId}\n${record.turn}`)), ...live.map(exportRecord)],
      }
      await store.writeIndex(index, objects)
      durable.status = 'ready'
    })
    durable.chain = run.catch(() => {})
    this.track(run, 'child evidence write failed')
    return durable.chain
  }

  /**
   * The durable view of one root, created on first use. A live root's view
   * trusts the root's existence; a stored root is checked against Session
   * storage and removed when absent. A retiring view is replaced by a fresh
   * read queued after its remaining writes.
   */
  private durableFor(id: SessionId, trust: 'live' | 'stored'): DurableRoot {
    const store = this.store as ChildEvidenceStore
    const existing = this.durable.get(id)
    if (existing !== undefined && !existing.retiring) {
      if (trust === 'live' && existing.status === 'missing') { existing.records = []; existing.status = 'ready' }
      return existing
    }
    const durable: DurableRoot = { id, records: [], status: 'loading', chain: Promise.resolve(), retiring: false }
    const load = async (): Promise<void> => {
      if (existing !== undefined) await existing.chain
      let index: DurableIndex | undefined
      let invalid: InvalidChildEvidenceError | undefined
      try {
        index = await store.readIndex(id)
      } catch (error: unknown) {
        if (!(error instanceof InvalidChildEvidenceError)) throw error
        invalid = error
      }
      if (trust === 'stored' && !await this.rootExists(id)) {
        await store.removeRoot(id, index)
        durable.status = 'missing'
        this.ctx.logger.info(`workspace-changes: removed child evidence of absent root Session ${id}`)
        return
      }
      if (invalid !== undefined) {
        durable.status = 'unreadable'
        this.ctx.logger.warn(invalid.message)
        return
      }
      durable.records = index?.records ?? []
      durable.status = 'ready'
    }
    durable.chain = load().catch((error: unknown) => {
      durable.status = 'unreadable'
      this.ctx.logger.warn(`workspace-changes: child evidence of root Session ${id} could not be read: ${String(error)}`)
    })
    this.track(durable.chain, 'child evidence read failed')
    this.durable.set(id, durable)
    return durable
  }

  /** Whether the root Session is live in this Host or present in durable Session storage. */
  private async rootExists(id: SessionId): Promise<boolean> {
    if (this.ctx.get('sessions')?.get(id) !== undefined) return true
    // Looked up by name: this plugin declares no dependency on the persistence package and asks only for existence.
    const persistence: SessionExistence | undefined = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return false
    return await persistence.stat(id, { signal: this.lifetime.signal }) !== undefined
  }

  /**
   * The root whose evidence names `id`, from this process or from disk. An
   * unknown id starts one lookup and reports undefined until it settles.
   */
  private rootOf(id: SessionId): SessionId | undefined {
    const store = this.store
    if (store === undefined) return undefined
    const cached = this.pointers.get(id)
    if (cached !== undefined) return cached ?? undefined
    if (!this.resolving.has(id)) {
      const task = store.resolveRoot(id).then((root) => {
        this.pointers.set(id, root ?? null)
        return root === undefined ? undefined : this.durableFor(root, 'stored').chain
      }, (error: unknown) => {
        this.pointers.set(id, null)
        this.ctx.logger.warn(`workspace-changes: child evidence lookup of Session ${id} failed: ${String(error)}`)
      }).finally(() => { this.resolving.delete(id) })
      this.resolving.set(id, task)
      this.track(task, 'child evidence lookup failed')
    }
    return undefined
  }

  /** The loaded durable view naming `id`, once its lookup and read have settled. */
  private async loadedRootOf(id: SessionId): Promise<DurableRoot | undefined> {
    if (this.rootOf(id) === undefined) await this.resolving.get(id)
    const root = this.pointers.get(id)
    if (root === undefined || root === null) return undefined
    const durable = this.durableFor(root, 'stored')
    await durable.chain
    return durable
  }

  /** Read only descendants belonging to a verified root: live turns of this process and restored completed records of a root that still exists.
   * @param parent - actual parent Session id selected by the user.
   * @returns bounded observed turns, including unavailable reasons; a root whose index is still being read lists no restored records yet.
   */
  children(parent: SessionId): ChildWorkspaceChanges {
    const owner = [...this.roots.values()].find(root => root.root.id === parent || root.turns.some(turn => turn.ancestors.includes(parent)))
    const rootId = owner?.root.id ?? this.rootOf(parent)
    const current = rootId === undefined ? undefined : this.durable.get(rootId)
    const durable = rootId !== undefined && (current === undefined || current.retiring) ? this.durableFor(rootId, 'stored') : current
    const restored = durable?.status === 'ready' ? durable.records.filter(record => record.ancestors.includes(parent)) : []
    return {
      available: owner !== undefined || durable?.status === 'ready',
      entries: [
        ...restored.flatMap((record): WorkspaceChildChange[] => {
          const base = { sessionId: record.childSessionId, turn: record.turn, cwd: record.cwd, state: record.state, shared: record.shared,
            ...record.reason === undefined ? {} : { reason: record.reason } }
          return record.entries.length === 0 ? [base] : record.entries.map(entry => ({ ...base, seq: entry.seq, total: entry.summary.total }))
        }),
        ...owner?.turns.filter(turn => turn.ancestors.includes(parent)).flatMap((entry): WorkspaceChildChange[] => {
          const base = { sessionId: entry.sessionId, turn: entry.turn, cwd: entry.cwd, state: entry.state, shared: entry.shared,
            ...entry.reason === undefined ? {} : { reason: entry.reason } }
          const records = entry.recorder.entries()
          return records.length === 0 ? [base] : records.map(([seq, summary]) => ({ ...base, seq, total: summary.total }))
        }) ?? [],
      ],
    }
  }

  /** Locate immutable evidence by the source Session, never the viewing parent.
   * @param id - source child Session.
   * @param seq - source workspace/changes sequence.
   * @returns its recorder when retained in this process.
   */
  recorder(id: SessionId, seq: number): TurnRecorder | undefined {
    for (const root of this.roots.values()) for (const entry of root.turns) {
      if (entry.sessionId === id && entry.recorder.summary(seq) !== undefined) return entry.recorder
    }
    return undefined
  }

  /** The summary one child `workspace/changes` event announced, from this process or from a loaded durable index.
   * @param id - source child Session.
   * @param seq - source workspace/changes sequence.
   * @returns the summary, or undefined while unknown, still loading, or released.
   */
  summary(id: SessionId, seq: number): WorkspaceChangesSummary | undefined {
    const live = this.recorder(id, seq)
    if (live !== undefined) return live.summary(seq)
    const root = this.rootOf(id)
    const durable = root === undefined ? undefined : this.durable.get(root)
    return durable?.status === 'ready' ? findEntry(durable, id, seq)?.summary : undefined
  }

  /** Compare one listed file of a child record, reading durable copies once the record's root has loaded.
   * @param id - source child Session.
   * @param seq - source workspace/changes sequence.
   * @param index - the file's index in the summary's `files`.
   * @param signal - cancels the reads.
   * @returns the comparison, or undefined for an unknown record, index, or absent root.
   * @throws {InvalidChildEvidenceError} when the root's index or a copy fails validation.
   */
  async diff(id: SessionId, seq: number, index: number, signal: AbortSignal): Promise<WorkspaceFileDiff | undefined> {
    const live = this.recorder(id, seq)
    if (live !== undefined) return live.diff(seq, index, signal)
    const store = this.store
    if (store === undefined) return undefined
    const durable = await this.loadedRootOf(id)
    if (durable === undefined || durable.status === 'missing') return undefined
    if (durable.status !== 'ready') throw new InvalidChildEvidenceError(store.rootDir(durable.id), 'the index could not be read')
    const entry = findEntry(durable, id, seq)
    const file = entry?.summary.files[index]
    const sources = entry?.files[index]
    if (file === undefined || sources === undefined) return undefined
    const { path, display } = file
    if (sources.refusal !== undefined) return { kind: sources.refusal, path, display }
    const [before, after] = await Promise.all([store.readSide(durable.id, sources.before, signal), store.readSide(durable.id, sources.after, signal)])
    const { hunks, coarse } = compareText(before, after, this.config.diffTimeoutMs)
    return { kind: 'text', path, display, before: before !== null, after: after !== null, hunks, coarse }
  }

  /** Child disposal seals observations; root disposal revokes its live evidence and keeps the durable copy for the stored root.
   * @param session - exact disposed Session instance.
   */
  disposed(session: Session): void {
    const active = this.active.get(session)
    if (active !== undefined) this.end(session, active.turn)
    const owner = this.roots.get(session)
    if (owner === undefined) return
    owner.lifetime.abort()
    this.roots.delete(session)
    for (const [child, entry] of this.active) if (owner.turns.includes(entry)) this.active.delete(child)
    const durable = this.durable.get(session.id)
    if (durable !== undefined) durable.retiring = true
    this.track((async () => {
      // Scratch copies outlive queued index writes that read them, including one queued on the replacing view.
      await durable?.chain
      await this.durable.get(session.id)?.chain
      await Promise.all(owner.turns.map(entry => entry.recorder.dispose()))
      if (durable !== undefined && this.durable.get(session.id) === durable) this.durable.delete(session.id)
    })(), 'child evidence cleanup failed')
  }

  /** Cancel all readers/captures, let queued index writes finish, and await temporary-directory cleanup. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    const owners = [...this.roots.values()]
    this.roots.clear()
    this.active.clear()
    for (const owner of owners) owner.lifetime.abort()
    await Promise.all([...this.durable.values()].map(durable => durable.chain))
    await Promise.all(owners.flatMap(owner => owner.turns.map(entry => entry.recorder.dispose())))
    await Promise.allSettled(this.pending)
  }

  /** Resolves once every queued finish, lookup, index read, write, and cleanup has settled. */
  async settled(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending])
  }

  private track(task: Promise<unknown>, failure: string): void {
    const contained = task.catch(() => { this.ctx.logger.warn(`workspace-changes: ${failure}`) })
    this.pending.add(contained)
    void contained.finally(() => { this.pending.delete(contained) })
  }
}

function exportRecord(turn: ChildTurn): DurableRecord {
  const exported = turn.exported as NonNullable<ChildTurn['exported']>
  const available = turn.state === 'available'
  return {
    childSessionId: turn.sessionId, ancestors: [...turn.ancestors], turn: turn.turn, cwd: turn.cwd,
    state: available ? 'available' : 'unavailable', ...turn.reason === undefined ? {} : { reason: turn.reason },
    shared: turn.shared, bytes: turn.bytes, recordedAt: exported.recordedAt, paths: [...turn.paths],
    entries: available ? exported.entries : [],
  }
}

function findEntry(durable: DurableRoot, id: SessionId, seq: number): DurableEntry | undefined {
  for (const record of durable.records) {
    if (record.childSessionId !== id) continue
    for (const entry of record.entries) if (entry.seq === seq) return entry
  }
  return undefined
}
