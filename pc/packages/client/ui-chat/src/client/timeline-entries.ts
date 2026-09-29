/** Apply-world registry and synchronous Session event-time projection for external rows. */
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { notifySubscribers } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ChatTimelineEntries, ChatTimelineEntriesSnapshot, ChatTimelineEntryProvider,
  ChatTimelineEntryView, ChatTimelineEventTime,
} from './contract/timeline-entries.ts'

const LIMIT = 256
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u
const EMPTY_ENTRIES: readonly ChatTimelineEntryView[] = Object.freeze([])
const EMPTY_TIMES: readonly ChatTimelineEventTime[] = Object.freeze([])

interface Registration {
  readonly id: string
  readonly provider: ChatTimelineEntryProvider
  active: boolean
  stop?: () => void
}

/** Own only active consumers; Session history and feature storage stay with their owners. */
export class ChatTimelineEntryRegistry implements ChatTimelineEntries {
  private readonly providers = new Map<string, Registration>()
  private readonly readers = new Set<{ sessionId: SessionId; refresh: () => void; stop: () => void }>()
  private disposed = false

  constructor(private readonly known: (sessionId: SessionId) => boolean) {}

  /** Install one provider and remove its subscription and visible rows together. */
  register(provider: ChatTimelineEntryProvider): () => void {
    if (this.disposed) return () => {}
    const id = provider.id
    if (typeof id !== 'string' || !ID.test(id) || this.providers.has(id) || this.providers.size >= 16) {
      throw new Error('ui-chat: invalid or duplicate timeline source')
    }
    const registration: Registration = { id, provider, active: true }
    this.providers.set(id, registration)
    const remove = (): void => {
      if (!registration.active) return
      registration.active = false
      this.providers.delete(id)
      this.stop(registration)
      this.refresh()
    }
    try {
      const stop = provider.subscribe((sessionId) => {
        if (registration.active && !this.disposed && this.known(sessionId)) this.refresh(sessionId)
      })
      if (this.live(registration)) registration.stop = stop
      else { try { stop() } catch { /* Withdrawal still invalidates the registration. */ } }
    } catch {
      remove()
      throw new Error('ui-chat: timeline source subscription failed')
    }
    this.refresh()
    return remove
  }

  /** Create the stable observable injected for one exact Session binding. */
  source(sessionId: SessionId, events: SessionEventSource): ObservableSnapshot<ChatTimelineEntriesSnapshot> {
    let snapshot: ChatTimelineEntriesSnapshot = { entries: EMPTY_ENTRIES, eventTimes: EMPTY_TIMES }
    let window: SessionEventWindow | undefined
    const times = new Map<number, number>()
    const listeners = new Set<() => void>()
    let stopEvents: (() => void) | undefined
    const capture = (): void => {
      const next = events.getSnapshot()
      if (next === window) return
      const replace = window === undefined || next.revision !== window.revision + 1 || next.change.kind === 'replace'
      const previous = times.size
      if (replace) times.clear()
      let changed = replace && previous > 0
      const entries = replace ? next.entries : next.change.kind === 'settle-assistant'
        ? next.change.entry === undefined ? [] : [next.change.entry]
        : next.change.entries
      for (const entry of entries) {
        if (entry.type !== 'event') continue
        const { seq, time } = entry.event
        if (times.get(seq) !== time) { times.set(seq, time); changed = true }
      }
      window = next
      if (changed) {
        snapshot = { ...snapshot, eventTimes: Object.freeze([...times].map(([seq, time]) => Object.freeze({ seq, time }))) }
      }
    }
    const read = (): ChatTimelineEntriesSnapshot => {
      if (this.live()) capture()
      const entries = this.read(sessionId, snapshot.entries)
      if (entries !== snapshot.entries) snapshot = { ...snapshot, entries }
      return snapshot
    }
    const refresh = (): void => {
      const before = snapshot
      read()
      if (before !== snapshot) notifySubscribers(listeners, 'Chat timeline')
    }
    const reader = { sessionId, refresh, stop: () => { stopEvents?.(); stopEvents = undefined } }
    const subscribed = (listener: () => void): boolean => listeners.has(listener) && this.live()
    return {
      getSnapshot: read,
      subscribe: (listener) => {
        if (this.disposed) return () => {}
        listeners.add(listener)
        if (listeners.size === 1) {
          this.readers.add(reader)
          const stop = events.subscribe(refresh)
          if (!subscribed(listener)) stop()
          else stopEvents = stop
          refresh()
        }
        let attached = true
        return () => {
          if (!attached) return
          attached = false
          listeners.delete(listener)
          if (listeners.size === 0) {
            this.readers.delete(reader)
            stopEvents?.()
            stopEvents = undefined
          }
        }
      },
    }
  }

  /** Withdraw all providers; retained callbacks become inert. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const registration of this.providers.values()) {
      registration.active = false
      this.stop(registration)
    }
    this.providers.clear()
    this.refresh()
    for (const reader of this.readers) reader.stop()
    this.readers.clear()
  }

  private refresh(sessionId?: SessionId): void {
    for (const reader of [...this.readers]) {
      if (sessionId === undefined || reader.sessionId === sessionId) reader.refresh()
    }
  }

  private stop(registration: Registration): void {
    const stop = registration.stop
    delete registration.stop
    try { stop?.() } catch { /* A provider cannot prevent other withdrawals. */ }
  }

  private live(registration?: Registration): boolean {
    return !this.disposed && (registration === undefined || registration.active)
  }

  private read(sessionId: SessionId, previous: readonly ChatTimelineEntryView[]): readonly ChatTimelineEntryView[] {
    if (this.disposed || !this.known(sessionId)) return previous.length === 0 ? previous : EMPTY_ENTRIES
    const candidates: { registration: Registration; entries: ChatTimelineEntryView[] }[] = []
    const old = new Map(previous.map(entry => [`${entry.sourceId}/${entry.id}`, entry]))
    for (const registration of [...this.providers.values()]) {
      let rows: unknown
      try { rows = registration.provider.read(sessionId) } catch { continue }
      if (!registration.active || !Array.isArray(rows) || rows.length > LIMIT) continue
      const values: readonly unknown[] = rows
      const entries: ChatTimelineEntryView[] = []
      const ids = new Set<string>()
      for (const row of values) {
        try {
          if (row === null || typeof row !== 'object') continue
          const { id: entryId, createdAt } = row as Record<string, unknown>
          if (typeof entryId !== 'string' || !ID.test(entryId)
            || typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt) || createdAt <= 0 || createdAt > 8_640_000_000_000_000
            || ids.has(entryId)) continue
          if (!this.live(registration)) break
          ids.add(entryId)
          const sourceId = registration.id
          const before = old.get(`${sourceId}/${entryId}`)
          entries.push(before ?? Object.freeze({ sourceId, id: entryId, createdAt }))
        } catch { continue }
      }
      candidates.push({ registration, entries })
    }
    if (!this.live() || !this.known(sessionId)) return previous.length === 0 ? previous : EMPTY_ENTRIES
    const entries = candidates.flatMap(candidate =>
      candidate.registration.active && this.providers.get(candidate.registration.id) === candidate.registration
        ? candidate.entries : [])
    entries.sort((a, b) => a.createdAt - b.createdAt || compare(a.sourceId, b.sourceId) || compare(a.id, b.id))
    return entries.length === previous.length && entries.every((entry, i) => entry === previous[i])
      ? previous : Object.freeze(entries)
  }
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
