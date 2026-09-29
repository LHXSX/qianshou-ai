/** Persistent phone-command delivery; the authenticated PC adapter owns execution and Session history. */
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type {
  PcWindowPort, PcWindowSnapshot, WindowAccess, WindowAction, WindowBinding,
  WindowCommandRecord, WindowJournal, WindowJournalStore,
} from './types.ts'
import { applyReceipt, parseBinding, parseCommand, parseJournal, parseReceipt, parseSyncPage, sameOrigin } from './validation.ts'

/** Required adapters keep account authorization, storage and clocks explicit and independently testable. */
export interface PcWindowOptions {
  readonly port: PcWindowPort
  readonly store: WindowJournalStore
  readonly requestId: () => SessionRequestId
  readonly now: () => number
}

/** Phone-owned outbox. A command receipt proves admission, never completion or settlement. */
export class PcWindowController {
  private journal: WindowJournal | null = null
  private access: WindowAccess = { state: 'unavailable', allowedActions: [] }
  private error: string | null = null
  private generation = 0
  private abort = new AbortController()
  private mutations: Promise<void> = Promise.resolve()
  private readonly sending = new Map<SessionRequestId, Promise<void>>()
  private refreshing: Promise<void> | null = null

  constructor(private readonly options: PcWindowOptions) {}

  /**
   * Return a detached projection; callers cannot alter durable commands through it.
   * @returns Current origin, delivery records and observable request failure.
   */
  snapshot(): PcWindowSnapshot {
    return structuredClone({ binding: this.journal?.binding ?? null, access: this.access.state,
      records: this.journal?.records ?? [], cursor: this.journal?.cursor ?? null, error: this.error })
  }

  /**
   * Bind one authorized origin, hiding the previous account immediately. In-flight admission becomes uncertain on recovery.
   * @param binding - Exact account, PC, original conversation and phone identity for the authenticated adapter to check.
   */
  async connect(binding: WindowBinding): Promise<void> {
    parseBinding(binding)
    this.disconnect()
    const generation = this.generation
    const signal = this.abort.signal
    try {
      const access = await this.options.port.access(binding, signal)
      if (generation !== this.generation) return
      this.access = access
      if (access.state === 'unauthorized' || access.state === 'unavailable') return
      // An old generation may still be committing its pre-admission record.
      await this.mutations
      const stored = await this.options.store.load(binding)
      if (generation !== this.generation) return
      this.journal = stored === null ? { version: 'qianshou.pc-window.v1', binding: structuredClone(binding), revision: 0, cursor: null, records: [] } : parseJournal(stored, binding)
      if (this.journal.records.some(item => item.state === 'delivering')) {
        await this.mutate(generation, journal => ({ ...journal, records: journal.records.map(item => item.state === 'delivering' ? { ...item, state: 'uncertain' } : item) }))
      }
    } catch (error) { this.fail(generation, error); throw error }
  }

  /** Hide account data and abort observation/admission transport; this never cancels a PC task. */
  disconnect(): void {
    this.generation += 1
    this.abort.abort()
    this.abort = new AbortController()
    this.journal = null
    this.access = { state: 'unavailable', allowedActions: [] }
    this.error = null
    this.sending.clear()
    this.refreshing = null
  }

  /** Remove this origin's local journal after hiding it. Remote work and original Session history remain untouched. */
  async forget(): Promise<void> {
    const binding = this.journal?.binding
    this.disconnect()
    await this.mutations
    if (binding) await this.options.store.remove(binding)
  }

  /**
   * Persist a user command before delivery. Resolves after local storage, without waiting for any other PC task.
   * @param action - User input or revision-bound control request; no execution authority is inferred.
   * @param expiresAt - Explicit expiration time in epoch milliseconds, later than creation.
   * @returns Stable request identity after the local journal commit; rejects invalid input or failed persistence.
   */
  async enqueue(action: WindowAction, expiresAt: number): Promise<SessionRequestId> {
    const generation = this.generation
    const journal = this.requireJournal()
    const command = parseCommand({ requestId: this.options.requestId(), origin: journal.binding,
      createdAt: this.options.now(), expiresAt, action })
    await this.mutate(generation, (current) => {
      if (current.records.length >= 500) throw new Error('PC_WINDOW_JOURNAL_FULL')
      if (current.records.some(item => item.command.requestId === command.requestId)) throw new Error('PC_WINDOW_DUPLICATE_COMMAND_ID')
      return { ...current, records: [...current.records, { command: structuredClone(command), state: 'queued', receipt: null }] }
    })
    if (generation === this.generation && this.access.state === 'online') {
      void this.send(command.requestId).catch((error: unknown) => { this.fail(generation, error) })
    }
    return command.requestId
  }

  /**
   * Withdraw only a command that has never been sent, not an uncertain or accepted task.
   * @param requestId - Existing local command identity; an unknown identity leaves records unchanged.
   */
  async withdraw(requestId: SessionRequestId): Promise<void> {
    await this.mutate(this.generation, journal => ({ ...journal, records: journal.records.map((item) => {
      if (item.command.requestId !== requestId) return item
      if (item.state !== 'queued') throw new Error('PC_WINDOW_COMMAND_MAY_HAVE_BEEN_RECEIVED')
      return { ...item, state: 'withdrawn' }
    }) }))
  }

  /** Recheck account/PC access and resume receipt cursors before retrying only explicitly non-admitted commands. */
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    const generation = this.generation
    const pending = this.refreshOnce(generation).finally(() => { if (this.refreshing === pending) this.refreshing = null })
    this.refreshing = pending
    return pending
  }

  /** Try queued admissions independently. Uncertain commands require a definitive reconciliation first. */
  async flush(): Promise<void> {
    const pending = this.requireJournal().records.filter(item => item.state === 'queued')
    await Promise.all(pending.map(item => this.send(item.command.requestId)))
  }

  private async refreshOnce(generation: number): Promise<void> {
    try {
      const binding = this.requireJournal().binding
      const signal = this.abort.signal
      const access = await this.options.port.access(binding, signal)
      if (generation !== this.generation) return
      this.access = access
      if (access.state === 'unauthorized') { this.disconnect(); this.access = access; return }
      if (access.state !== 'online') return
      const before = this.requireJournal()
      const ids = before.records.filter(item => item.state === 'uncertain' || item.state === 'delivering').map(item => item.command.requestId)
      const page = parseSyncPage(await this.options.port.sync(binding, before.cursor, ids, signal))
      if (generation !== this.generation) return
      if (!sameOrigin(page.binding, binding) || page.fromCursor !== before.cursor) throw new Error('PC_WINDOW_SYNC_ORIGIN_MISMATCH')
      await this.mutate(generation, (current) => {
        if (current.cursor !== page.fromCursor) throw new Error('PC_WINDOW_STALE_CURSOR')
        const records = new Map(current.records.map(item => [item.command.requestId, item]))
        for (const receipt of page.receipts) {
          const item = records.get(receipt.requestId)
          if (!item) throw new Error('PC_WINDOW_UNKNOWN_RECEIPT')
          records.set(receipt.requestId, applyReceipt(item, receipt))
        }
        for (const id of page.notReceivedIds) {
          const item = records.get(id)
          if (!item || !ids.includes(id)) throw new Error('PC_WINDOW_UNKNOWN_COMMAND_PROOF')
          if (item.state === 'uncertain' && !this.sending.has(id)) {
            records.set(id, { ...item, state: item.command.expiresAt <= this.options.now() ? 'expired' : 'queued' })
          }
        }
        return { ...current, cursor: page.nextCursor, records: [...records.values()] }
      })
      await this.flush()
    } catch (error) { this.fail(generation, error); throw error }
  }

  private send(requestId: SessionRequestId): Promise<void> {
    const existing = this.sending.get(requestId)
    if (existing) return existing
    const pending = this.sendOnce(requestId, this.generation).finally(() => {
      if (this.sending.get(requestId) === pending) this.sending.delete(requestId)
    })
    this.sending.set(requestId, pending)
    return pending
  }

  private async sendOnce(requestId: SessionRequestId, generation: number): Promise<void> {
    const signal = this.abort.signal
    let started = false
    try {
      const access = await this.options.port.access(this.requireJournal().binding, signal)
      if (generation !== this.generation) return
      this.access = access
      if (access.state === 'unauthorized') { this.disconnect(); this.access = access; return }
      if (access.state !== 'online') return
      let selected: WindowCommandRecord | undefined
      await this.mutate(generation, journal => ({ ...journal, records: journal.records.map((item) => {
        if (item.command.requestId !== requestId || item.state !== 'queued') return item
        if (item.command.expiresAt <= this.options.now()) return { ...item, state: 'expired' }
        if (!access.allowedActions.includes(item.command.action.type)) throw new Error('PC_WINDOW_ACTION_UNAVAILABLE')
        selected = item
        return { ...item, state: 'delivering' }
      }) }))
      if (!selected || generation !== this.generation) return
      started = true
      const receipt = parseReceipt(await this.options.port.submit(selected.command, signal))
      if (generation !== this.generation) return
      await this.mutate(generation, journal => ({ ...journal,
        records: journal.records.map(item => item.command.requestId === requestId ? applyReceipt(item, receipt) : item),
      }))
    } catch (error) {
      if (started && generation === this.generation) {
        try {
          await this.mutate(generation, journal => ({ ...journal, records: journal.records.map(item => item.command.requestId === requestId && item.state === 'delivering' ? { ...item, state: 'uncertain' } : item) }))
        } catch (storageError) {
          this.fail(generation, storageError)
          throw storageError
        }
      }
      this.fail(generation, error)
      throw error
    }
  }

  private requireJournal(): WindowJournal {
    if (!this.journal) throw new Error('PC_WINDOW_NOT_CONNECTED')
    return this.journal
  }

  private mutate(generation: number, update: (journal: WindowJournal) => WindowJournal): Promise<void> {
    const pending = this.mutations.then(async () => {
      if (generation !== this.generation) throw new Error('PC_WINDOW_CONNECTION_CHANGED')
      const current = this.requireJournal()
      const updated = { ...update(current), revision: current.revision + 1 }
      await this.options.store.save(updated, current.revision)
      if (generation === this.generation) { this.journal = updated; this.error = null }
    })
    // Callers observe failures on pending; this tail is only the local commit barrier.
    this.mutations = pending.catch((error: unknown) => { this.fail(generation, error) })
    return pending
  }

  private fail(generation: number, error: unknown): void {
    if (generation === this.generation) this.error = error instanceof Error ? error.message : 'PC_WINDOW_REQUEST_FAILED'
  }
}
