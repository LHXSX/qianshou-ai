import { describe, expect, it, vi } from 'vitest'
import { MutableSessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { ChatTimelineEntryRegistry } from '../src/client/timeline-entries.ts'
import type { ChatTimelineEntry, ChatTimelineEntryProvider } from '../src/client/contract/timeline-entries.ts'

const SID = SessionId('main')
const OTHER = SessionId('other')
function provider(id = 'feature') {
  let rows: readonly ChatTimelineEntry[] = [{ id: 'one', createdAt: 100 }]
  let notify: (sessionId: SessionId) => void = () => {}
  const stop = vi.fn()
  const read = vi.fn((_sessionId: SessionId) => rows)
  return {
    face: { id, read, subscribe: (listener) => { notify = listener; return stop } } satisfies ChatTimelineEntryProvider,
    read, stop, set: (next: readonly ChatTimelineEntry[]) => { rows = next },
    notify: (sessionId = SID) => { notify(sessionId) },
  }
}

describe('registered Chat timeline entries', () => {
  it('publishes exact Session changes, stable snapshots, immutable submission time, and withdrawal', () => {
    const registry = new ChatTimelineEntryRegistry(id => id === SID || id === OTHER)
    const source = registry.source(SID, new MutableSessionEventSource())
    const listener = vi.fn()
    const off = source.subscribe(listener)
    const p = provider()
    const remove = registry.register(p.face)
    const first = source.getSnapshot()
    expect(first.entries).toEqual([{ sourceId: 'feature', id: 'one', createdAt: 100 }])
    expect(source.getSnapshot()).toBe(first)
    p.set([{ id: 'one', createdAt: 999 }, { id: 'two', createdAt: 200 }])
    const calls = listener.mock.calls.length
    p.notify(OTHER)
    expect(listener).toHaveBeenCalledTimes(calls)
    p.notify()
    expect(source.getSnapshot().entries.map(row => row.createdAt)).toEqual([100, 200])
    p.notify(SessionId('unknown'))
    expect(p.read.mock.calls.every(([id]) => id === SID)).toBe(true)
    remove(); remove()
    expect(p.stop).toHaveBeenCalledTimes(1)
    expect(source.getSnapshot().entries).toEqual([])
    const after = listener.mock.calls.length
    p.notify()
    expect(listener).toHaveBeenCalledTimes(after)
    off(); registry.dispose()
  })

  it('isolates malformed, over-bound, throwing and unknown readers', () => {
    const registry = new ChatTimelineEntryRegistry(id => id === SID)
    const p = provider()
    registry.register(p.face)
    registry.register({ id: 'broken', read: () => { throw new Error('private source failure') }, subscribe: () => () => {} })
    const source = registry.source(SID, new MutableSessionEventSource())
    p.set([{ id: 'valid', createdAt: 10 }, { id: 'valid', createdAt: 20 },
      { id: '\u0000bad', createdAt: 30 }, { id: 'bad', createdAt: NaN }, { id: 'zero', createdAt: 0 },
      {} as ChatTimelineEntry, { get id(): string { throw new Error('bad getter') }, createdAt: 40 }])
    expect(source.getSnapshot().entries.map(row => row.id)).toEqual(['valid'])
    p.set(Array.from({ length: 257 }, (_, i) => ({ id: `e${i}`, createdAt: 10 })))
    expect(source.getSnapshot().entries).toEqual([])
    p.read.mockClear()
    expect(registry.source(OTHER, new MutableSessionEventSource()).getSnapshot().entries).toEqual([])
    expect(p.read).not.toHaveBeenCalled()
    registry.dispose()
  })

  it('bounds registrations and rejects duplicate identities and failed subscriptions', () => {
    const registry = new ChatTimelineEntryRegistry(() => true)
    expect(() => registry.register({ ...provider().face, id: ' bad' })).toThrow()
    registry.register(provider().face)
    expect(() => registry.register(provider().face)).toThrow()
    expect(() => registry.register({ ...provider('broken').face, subscribe: () => { throw new Error('subscribe failed') } })).toThrow()
    registry.register(provider('broken').face)
    for (let i = 0; i < 14; i++) registry.register(provider(`p${i}`).face)
    expect(() => registry.register(provider('overflow').face)).toThrow()
    registry.dispose()
  })

  it('cleans a synchronously disposed subscription and isolates failing cleanup', () => {
    const registry = new ChatTimelineEntryRegistry(() => true)
    const stop = vi.fn()
    const source = registry.source(SID, new MutableSessionEventSource())
    source.subscribe(() => { registry.dispose() })
    const remove = registry.register({
      ...provider().face,
      subscribe: (listener) => { listener(SID); return stop },
    })
    expect(stop).toHaveBeenCalledTimes(1)
    remove(); registry.dispose()
    expect(stop).toHaveBeenCalledTimes(1)
    const r = new ChatTimelineEntryRegistry(() => true)
    r.register({ ...provider().face, subscribe: () => () => { throw new Error('cleanup failed') } })
    const p = provider('healthy')
    r.register(p.face)
    expect(() => { r.dispose() }).not.toThrow()
    expect(p.stop).toHaveBeenCalledTimes(1)
  })

  it('does not resurrect rows when a boundary getter withdraws its provider', () => {
    const registry = new ChatTimelineEntryRegistry(() => true)
    registry.register({ ...provider().face, read: () => [{ id: 'early', createdAt: 1 }, {
      get id(): string { registry.dispose(); return 'late' }, createdAt: 10,
    }] })
    const source = registry.source(SID, new MutableSessionEventSource())
    const snapshot = source.getSnapshot()
    expect(snapshot.entries).toEqual([])
    expect(source.getSnapshot()).toBe(snapshot)
  })

  it('withdraws already accumulated providers on disposal and only the exact token on unregister', () => {
    const registry = new ChatTimelineEntryRegistry(() => true)
    registry.register(provider('early').face)
    registry.register({ ...provider('late').face, read: () => [{
      get id(): string { registry.dispose(); return 'late' }, createdAt: 10,
    }] })
    expect(registry.source(SID, new MutableSessionEventSource()).getSnapshot().entries).toEqual([])
    const active = new ChatTimelineEntryRegistry(() => true)
    let remove = () => {}
    active.register(provider('kept').face)
    remove = active.register({ ...provider('removed').face, read: () => [{ id: 'early', createdAt: 1 }, {
      get id(): string { remove(); return 'late' }, createdAt: 10,
    }] })
    const source = active.source(SID, new MutableSessionEventSource())
    const snapshot = source.getSnapshot()
    expect(snapshot.entries.map(row => row.sourceId)).toEqual(['kept'])
    expect(source.getSnapshot()).toBe(snapshot)
    active.dispose()
  })

  it('projects only real durable times across append, paging, replacement and restart', () => {
    const events = new MutableSessionEventSource()
    const registry = new ChatTimelineEntryRegistry(() => true)
    const source = registry.source(SID, events)
    const off = source.subscribe(() => {})
    const event = (seq: number, time: number) => ({ type: 'event' as const,
      event: { seq: SessionSeq(seq), time, type: 'turn/start' as const, data: { turn: seq } } })
    events.append(event(3, 300))
    events.append(event(4, 400))
    events.prepend([event(1, 100), event(2, 200)], false)
    expect(source.getSnapshot().eventTimes.map(row => row.seq).sort()).toEqual([1, 2, 3, 4])
    events.replace([event(8, 800)], false)
    expect(source.getSnapshot().eventTimes).toEqual([{ seq: 8, time: 800 }])
    const p = provider()
    registry.register(p.face)
    const restored = new ChatTimelineEntryRegistry(() => true)
    restored.register(p.face)
    expect(restored.source(SID, events).getSnapshot()).toEqual(source.getSnapshot())
    off(); registry.dispose(); restored.dispose()
    const after = source.getSnapshot()
    events.append(event(9, 900))
    expect(source.getSnapshot().entries).toEqual([])
    expect(after.entries).toEqual([])
  })
})
