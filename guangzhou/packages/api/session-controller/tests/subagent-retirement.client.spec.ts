/** Durable retirement receipts remain authoritative over older list, catalog and control work. */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SubagentAddress, SubagentRetirementReceipt } from '@deepseek-ai/dsh-subagent/client'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { SessionManager } from '../src/client/sessions/manager.ts'
import { FakeApiClient, deferred, err, fakeRemote, ok } from './fake-api.client.ts'

const parent = 'retire-parent' as SessionId
const child = 'retire-child' as SessionId
const grandchild = 'retire-grandchild' as SessionId
const sibling = 'retire-sibling' as SessionId
const address: SubagentAddress = { parentSessionId: parent, childSessionId: child, mode: 'continuable' }
const receipt: SubagentRetirementReceipt = { accepted: true, parentSessionId: parent, childSessionIds: [child, grandchild] }
const summary = (sessionId: SessionId, parentSessionId?: SessionId) => ({
  sessionId, updatedAt: 1, running: false, blank: false,
  ...parentSessionId === undefined ? {} : { parentSessionId, origin: 'subagent' as const },
})
const entry = (id: SessionId, hasChildren = false) => ({
  kind: 'child' as const, id, mode: 'continuable' as const, label: id,
  activity: 'inactive' as const, hasChildren,
})

async function bench() {
  const api = new FakeApiClient()
  api.onList = () => Promise.resolve(ok({ items: [summary(parent), summary(child, parent), summary(grandchild, child), summary(sibling, parent)] }))
  api.onSubagentList = id => Promise.resolve(ok({ parentAvailable: true,
    entries: id === parent ? [entry(child, true), entry(sibling)] : id === child ? [entry(grandchild)] : [],
  }))
  api.onSubagentRetire = () => Promise.resolve(ok(receipt))
  const manager = new SessionManager(fakeRemote(api))
  await manager.refreshList()
  await manager.refreshSubagents(parent)
  await manager.refreshSubagents(child)
  return { api, manager }
}

describe('durable team retirement consumer', () => {
  it('preserves the complete team and selection when the Host refuses a busy subtree', async () => {
    const { api, manager } = await bench()
    manager.selectSubagent(address)
    api.onSubagentRetire = () => Promise.resolve(err(new RemoteError('subagent/busy', 'Still queued', { childSessionIds: [grandchild] })))
    await expect(manager.retireSubagent(address)).rejects.toMatchObject({ code: 'subagent/busy' })
    expect(manager.getListSnapshot().items).toHaveLength(4)
    expect(manager.getListSnapshot().current).toBe(child)
    expect(manager.getListSnapshot().subagentsByParent[parent]!.entries).toHaveLength(2)
    await manager.dispose()
  })

  it('removes the entire accepted branch, returns selection to its parent, and is idempotent across event and acknowledgement', async () => {
    const { api, manager } = await bench()
    manager.selectSubagent({ parentSessionId: child, childSessionId: grandchild, mode: 'continuable' })
    const pending = deferred<Awaited<ReturnType<FakeApiClient['onSubagentRetire']>>>()
    api.onSubagentRetire = () => pending.promise
    const request = manager.retireSubagent(address)
    expect(manager.getListSnapshot().items).toHaveLength(4)
    manager.applyRetirement(receipt)
    pending.resolve(ok(receipt))
    await request
    const result = manager.getListSnapshot()
    expect(result.items.map(value => value.sessionId)).toEqual([parent, sibling])
    expect(result.current).toBe(parent)
    expect(result.currentAddress).toBeUndefined()
    expect(result.subagentsByParent[parent]!.entries.map(value => value.id)).toEqual([sibling])
    expect(result.subagentsByParent[child]).toBeUndefined()
    expect(manager.navigationAddress(grandchild)).toBeUndefined()
    expect(api.callsOf('subagents.retire')).toHaveLength(1)
    await manager.dispose()
  })

  it('rejects stale in-flight baselines, nested catalogs and late activity after the persisted receipt', async () => {
    const { api, manager } = await bench()
    const list = deferred<Awaited<ReturnType<FakeApiClient['onList']>>>()
    const catalog = deferred<Awaited<ReturnType<FakeApiClient['onSubagentList']>>>()
    api.onList = () => list.promise
    api.onSubagentList = () => catalog.promise
    const listRequest = manager.refreshList()
    const catalogRequest = manager.refreshSubagents(parent)
    const nestedRequest = manager.refreshSubagents(child)
    manager.applyRetirement(receipt)
    list.resolve(ok({ items: [summary(parent), summary(child, parent), summary(grandchild, child), summary(sibling, parent)] }))
    catalog.resolve(ok({ parentAvailable: true, entries: [entry(child, true), entry(grandchild), entry(sibling)] }))
    await Promise.all([listRequest, catalogRequest, nestedRequest])
    manager.handleSessionAdded(summary(grandchild, child))
    manager.handleSessionStatus(child, true)
    manager.handleSessionActivity(grandchild, 9)
    manager.handleControlFrame({ type: 'queue', sessionId: child, items: [{ id: 'old' as MessageId, placement: 'queued', message: { id: 'old' as MessageId, content: [] } }] })
    manager.handleControlFrame({ type: 'projection', sessionId: child, key: 'title', value: 'Late child', seq: 12 })
    const result = manager.getListSnapshot()
    expect(result.items.map(value => value.sessionId)).toEqual([parent, sibling])
    expect(result.subagentsByParent[parent]!.entries.map(value => value.id)).toEqual([sibling])
    expect(result.subagentsByParent[child]).toBeUndefined()
    expect(result.jobsBySession[child]).toBeUndefined()
    expect(() => manager.selectSubagent(address)).toThrow('not a healthy catalog child')
    await manager.dispose()
  })

  it('refreshes an unexpanded ancestor disclosure after another window retires its last grandchild', async () => {
    const api = new FakeApiClient()
    api.onList = () => Promise.resolve(ok({ items: [summary(parent), summary(child, parent)] }))
    api.onSubagentList = () => Promise.resolve(ok({ parentAvailable: true, entries: [entry(child, true)] }))
    const manager = new SessionManager(fakeRemote(api))
    await manager.refreshList()
    await manager.refreshSubagents(parent)
    expect(manager.getListSnapshot().subagentsByParent[child]).toBeUndefined()
    api.onSubagentList = id => Promise.resolve(ok({ parentAvailable: true, entries: id === parent ? [entry(child, false)] : [] }))
    manager.applyRetirement({ accepted: true, parentSessionId: child, childSessionIds: [grandchild] })
    await manager.refreshSubagents(parent)
    expect(manager.getListSnapshot().subagentsByParent[parent]!.entries[0]).toMatchObject({ id: child, hasChildren: false })
    await manager.dispose()
  })

  it('updates the parent disclosure when only its final nested branch is retired', async () => {
    const { api, manager } = await bench()
    api.onSubagentList = id => Promise.resolve(ok({ parentAvailable: true,
      entries: id === parent ? [entry(child, false), entry(sibling)] : [],
    }))
    manager.applyRetirement({ accepted: true, parentSessionId: child, childSessionIds: [grandchild] })
    expect(manager.getListSnapshot().subagentsByParent[parent]!.entries[0]).toMatchObject({ id: child, hasChildren: false })
    expect(manager.getListSnapshot().items.map(value => value.sessionId)).toEqual([parent, child, sibling])
    await manager.dispose()
  })
})
