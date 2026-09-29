import { describe, expect, it, vi } from 'vitest'
import type { SessionListState, SessionSummary } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { WorkspaceSessionPreviewRegistry } from '../src/client/session-preview-registry.ts'
import type { WorkspaceSessionPreview, WorkspaceSessionPreviewProvider } from '../src/client/session-preview.ts'

const sid = SessionId
function list(...ids: string[]): SessionListState {
  return {
    ids: ids.map(sid), phase: 'ready', subagentsByParent: {}, jobsBySession: {},
    byId: Object.fromEntries(ids.map(id => [id, {
      id: sid(id), displayTitle: id, blank: true, running: false, updatedAt: 0, retainedBy: {},
    } satisfies SessionSummary])),
  }
}
function provider(initial: WorkspaceSessionPreview | null = null) {
  let value = initial
  let notify: (sessionId: ReturnType<typeof sid>) => void = () => {}
  const stop = vi.fn()
  const read = vi.fn<WorkspaceSessionPreviewProvider['read']>(() => value)
  const source: WorkspaceSessionPreviewProvider = {
    read,
    subscribe(listener) { notify = listener; return stop },
  }
  return { source, read, stop, set(next: WorkspaceSessionPreview | null) { value = next }, notify(id: string) { notify(sid(id)) } }
}

describe('Workspace Session preview registrations', () => {
  it('closes a subscription when synchronous initial notification disposes the owner before subscribe returns', () => {
    const registry = new WorkspaceSessionPreviewRegistry(createSnapshotStore(list('one')))
    registry.snapshots.subscribe(() => { registry.dispose() })
    const stop = vi.fn()
    const remove = registry.register({
      read: () => ({ kind: 'content', title: 'submitted' }),
      subscribe(listener) { listener(sid('one')); return stop },
    })
    expect(stop).toHaveBeenCalledOnce()
    expect(registry.snapshots.getSnapshot().size).toBe(0)
    remove()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('uses fresh catalog identities for reuse before a deferred catalog notification', () => {
    let catalog = list('old')
    const registry = new WorkspaceSessionPreviewRegistry({ getSnapshot: () => catalog, subscribe: () => () => {} })
    const feature = provider({ kind: 'content', title: 'submitted' })
    registry.register(feature.source)
    catalog = list('new')
    expect(registry.read(sid('new'))).toMatchObject({ title: 'submitted' })
    expect(registry.read(sid('old'))).toBeNull()
    feature.notify('old')
    feature.notify('new')
    expect(registry.snapshots.getSnapshot().size).toBe(0)
    registry.dispose()
  })

  it('publishes one bounded snapshot, invalidates only the exact known Session, and keeps unchanged identity', () => {
    const catalog = createSnapshotStore(list('one', 'two'))
    const registry = new WorkspaceSessionPreviewRegistry(catalog)
    const feature = provider({ kind: 'content', title: ` \0${'🙂'.repeat(50)}\n `, searchText: ` \0  ${'词'.repeat(600)} `, updatedAt: 10 })
    const changed = vi.fn()
    registry.snapshots.subscribe(changed)
    registry.register(feature.source)
    const snapshot = registry.snapshots.getSnapshot()
    const preview = snapshot.get(sid('one'))!
    expect(preview.kind).toBe('content')
    if (preview.kind !== 'content') throw new Error('expected content')
    expect(Array.from(preview.title)).toHaveLength(48)
    expect(preview.title).toBe(`${'🙂'.repeat(47)}…`)
    expect(Array.from(preview.searchText!)).toHaveLength(512)
    expect(preview.searchText).not.toContain('\0')
    expect(changed).toHaveBeenCalledOnce()
    feature.read.mockClear()
    feature.notify('unknown')
    expect(feature.read).not.toHaveBeenCalled()
    feature.notify('one')
    expect(feature.read).toHaveBeenCalledExactlyOnceWith(sid('one'))
    expect(registry.snapshots.getSnapshot()).toBe(snapshot)
    feature.set({ kind: 'content', title: '  new\n  title\0 ', updatedAt: 20 })
    feature.notify('one')
    expect(registry.snapshots.getSnapshot().get(sid('one'))).toMatchObject({ title: 'new title', updatedAt: 20 })
    expect(registry.snapshots.getSnapshot().get(sid('two'))).toBe(snapshot.get(sid('two')))
    registry.dispose()
  })

  it('treats unreadable and oversized metadata as occupied without manufacturing valid content', () => {
    const registry = new WorkspaceSessionPreviewRegistry(createSnapshotStore(list('one')))
    const feature = provider({ kind: 'unavailable' })
    const remove = registry.register(feature.source)
    expect(registry.read(sid('one'))).toEqual({ kind: 'unavailable' })
    feature.read.mockImplementationOnce(() => { throw new Error('unreadable') })
    expect(registry.read(sid('one'))).toEqual({ kind: 'unavailable' })
    feature.set({ kind: 'content', title: 'a'.repeat(4097) })
    expect(registry.read(sid('one'))).toEqual({ kind: 'unavailable' })
    feature.set({ kind: 'content', title: 'valid', searchText: 'a'.repeat(4097) })
    expect(registry.read(sid('one'))).toEqual({ kind: 'unavailable' })
    const valid = provider({ kind: 'content', title: 'known', updatedAt: Number.NaN })
    registry.register(valid.source)
    expect(registry.read(sid('one'))).toEqual({ kind: 'content', title: 'known', searchText: 'known' })
    remove()
    expect(registry.read(sid('unknown'))).toBeNull()
    registry.dispose()
  })

  it('reads fresh for reuse, reconciles catalog identity changes, and does not reread status-only updates', () => {
    const catalog = createSnapshotStore(list('one'))
    const registry = new WorkspaceSessionPreviewRegistry(catalog)
    const feature = provider()
    registry.register(feature.source)
    feature.set({ kind: 'content', title: 'submitted' })
    expect(registry.snapshots.getSnapshot().size).toBe(0)
    expect(registry.read(sid('one'))).toMatchObject({ title: 'submitted' })
    feature.read.mockClear()
    catalog.set(list('one'))
    expect(feature.read).not.toHaveBeenCalled()
    catalog.set(list('one', 'two'))
    expect(feature.read).toHaveBeenCalledExactlyOnceWith(sid('two'))
    expect([...registry.snapshots.getSnapshot().keys()]).toEqual([sid('two')])
    feature.notify('one')
    catalog.set(list('two'))
    expect([...registry.snapshots.getSnapshot().keys()]).toEqual([sid('two')])
    registry.dispose()
  })

  it('removes registrations atomically and makes old, reloaded, and disposed callbacks inert', () => {
    const catalog = createSnapshotStore(list('one', 'two'))
    const registry = new WorkspaceSessionPreviewRegistry(catalog)
    const feature = provider({ kind: 'content', title: 'old' })
    const remove = registry.register(feature.source)
    const notifyOld = (id: string) => { feature.notify(id) }
    const changed = vi.fn()
    registry.snapshots.subscribe(changed)
    remove()
    remove()
    expect(feature.stop).toHaveBeenCalledOnce()
    expect(changed).toHaveBeenCalledOnce()
    notifyOld('one')
    expect(changed).toHaveBeenCalledOnce()
    const reloaded = provider({ kind: 'content', title: 'new' })
    registry.register(reloaded.source)
    remove()
    expect(registry.read(sid('one'))).toMatchObject({ title: 'new' })
    registry.dispose()
    registry.dispose()
    const disposed = registry.snapshots.getSnapshot()
    reloaded.notify('one')
    catalog.set(list('three'))
    expect(registry.snapshots.getSnapshot()).toBe(disposed)
    expect(reloaded.stop).toHaveBeenCalledOnce()
    expect(registry.read(sid('one'))).toBeNull()
    expect(() => registry.register(reloaded.source)).toThrow('disposed')
  })

  it('rolls back a failed subscription and lets remaining providers leave after a cleanup throws', () => {
    const registry = new WorkspaceSessionPreviewRegistry(createSnapshotStore(list('one')))
    const broken = provider({ kind: 'content', title: 'unregistered' })
    expect(() => { registry.register({ ...broken.source, subscribe() { throw new Error('subscribe failed') } }) }).toThrow('subscribe failed')
    expect(registry.read(sid('one'))).toBeNull()
    registry.register({ ...broken.source, subscribe() { return () => { throw new Error('cleanup failed') } } })
    const healthy = provider({ kind: 'content', title: 'healthy' })
    registry.register(healthy.source)
    expect(() => { registry.dispose() }).not.toThrow()
    expect(healthy.stop).toHaveBeenCalledOnce()
    expect(registry.snapshots.getSnapshot().size).toBe(0)
  })
})
