/** Durable claims over real SQLite: a claim happens once, and only a Session barrier turns it into `received`. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { openMobileSyncDatabase } from '../src/database.ts'
import { MobileSyncFailure } from '../src/failure.ts'
import { bindingKey, digest, MobileSyncStore } from '../src/store.ts'
import type { WindowBinding } from '../src/types.ts'

const BINDING: WindowBinding = { accountId: 'acct-1', pcId: 'pc-1', sessionId: 'sess-1', sourceDeviceId: 'phone-1' }
const OTHER: WindowBinding = { ...BINDING, sourceDeviceId: 'phone-2' }

const stores: MobileSyncStore[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-mobile-sync-'))
  dirs.push(dir)
  return dir
}

async function opened(path = ':memory:', maxBindings = 8, maxReceipts = 8): Promise<MobileSyncStore> {
  const store = await MobileSyncStore.open(path, maxBindings, maxReceipts)
  stores.push(store)
  return store
}

/** Assert a refusal names one stable wire code. */
async function refuses(operation: () => unknown, kind: string): Promise<void> {
  try { await operation(); expect.unreachable('expected a refusal') }
  catch (error) {
    expect(error).toBeInstanceOf(MobileSyncFailure)
    expect((error as MobileSyncFailure).kind).toBe(kind)
  }
}

describe('binding keys', () => {
  it('separates every axis so accounts and PCs cannot collide', () => {
    expect(bindingKey(BINDING)).not.toBe(bindingKey(OTHER))
    expect(bindingKey(BINDING)).toBe(bindingKey({ ...BINDING }))
    expect(bindingKey({ ...BINDING, accountId: 'acct-2' })).not.toBe(bindingKey(BINDING))
  })
})

describe('bindings', () => {
  it('registers a binding and reads it back by its exact axes', async () => {
    const store = await opened()
    const record = store.register(BINDING, 1000)
    expect(record).toMatchObject({ binding: BINDING, createdAt: 1000, revoked: false, issuedSequence: 0 })
    expect(store.binding(BINDING)).toMatchObject({ key: record.key })
    expect(store.binding(OTHER)).toBeUndefined()
    expect(store.activeBindings()).toBe(1)
  })

  it('restores a revoked binding without rewinding its receipt sequence', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    store.claim(key, 'req-1', digest('body'))
    expect(store.revokeAll()).toBe(1)
    expect(store.binding(BINDING)?.revoked).toBe(true)
    const restored = store.register(BINDING, 2000)
    expect(restored).toMatchObject({ revoked: false, createdAt: 1000, issuedSequence: 1 })
    expect(store.claim(key, 'req-2', digest('other')).sequence).toBe(2)
  })

  it('reports how many bindings a revocation ended, counting only live ones', async () => {
    const store = await opened()
    store.register(BINDING, 1)
    store.register(OTHER, 1)
    expect(store.revokeAll()).toBe(2)
    expect(store.revokeAll()).toBe(0)
    expect(store.activeBindings()).toBe(0)
  })

  it('refuses a new binding once the ceiling holds only live ones', async () => {
    const store = await opened(':memory:', 2)
    store.register(BINDING, 1)
    store.register(OTHER, 1)
    await refuses(() => store.register({ ...BINDING, sourceDeviceId: 'phone-3' }, 1), 'CAPACITY')
  })

  it('reclaims one revoked binding to admit a new one', async () => {
    const store = await opened(':memory:', 2)
    store.register(BINDING, 1)
    store.register(OTHER, 1)
    store.revokeAll()
    expect(store.register({ ...BINDING, sourceDeviceId: 'phone-3' }, 2).revoked).toBe(false)
  })
})

describe('observation times', () => {
  it('records the latest observation on the binding it names and on no other', async () => {
    const store = await opened()
    const mine = store.register(BINDING, 1000).key
    store.register(OTHER, 1000)
    store.touch(mine, 7000)
    expect(store.binding(BINDING)?.lastAccessAt).toBe(7000)
    expect(store.binding(OTHER)?.lastAccessAt).toBe(1000)
  })
})

describe('claims', () => {
  it('numbers the receipt stream from one and derives a stable rpc identity', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    const first = store.claim(key, 'req-1', digest('body-1'))
    expect(first).toMatchObject({ requestId: 'req-1', sequence: 1, state: 'uncertain', reason: null, acceptedAt: null })
    expect(first.rpcId).toBe(`qianshou-mobile-sync:${digest(`${key}:req-1`)}`)
    expect(store.claim(key, 'req-2', digest('body-2')).sequence).toBe(2)
  })

  it('returns the same receipt for a repeated claim of the identical body', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    const hash = digest('body-1')
    const first = store.claim(key, 'req-1', hash)
    expect(store.claim(key, 'req-1', hash)).toEqual(first)
    expect(store.receiptsAfter(key, 0, 10)).toHaveLength(1)
  })

  it('refuses a changed body under an already claimed id', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    store.claim(key, 'req-1', digest('body-1'))
    await refuses(() => store.claim(key, 'req-1', digest('body-2')), 'REQUEST_CONFLICT')
  })

  it('refuses a claim for an unknown or revoked binding', async () => {
    const store = await opened()
    await refuses(() => store.claim(bindingKey(BINDING), 'req-1', digest('b')), 'BINDING_UNKNOWN')
    const key = store.register(BINDING, 1000).key
    store.revokeAll()
    await refuses(() => store.claim(key, 'req-1', digest('b')), 'BINDING_UNKNOWN')
  })

  it('refuses a claim past the receipt ceiling', async () => {
    const store = await opened(':memory:', 8, 1)
    const key = store.register(BINDING, 1000).key
    store.claim(key, 'req-1', digest('b'))
    await refuses(() => store.claim(key, 'req-2', digest('b')), 'CAPACITY')
  })
})

describe('outcomes', () => {
  it('publishes admission only through received, and keeps the first admission time', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    store.claim(key, 'req-1', digest('b'))
    expect(store.received(key, 'req-1', 5000)).toMatchObject({ state: 'received', acceptedAt: 5000, reason: 'session-admitted' })
    expect(store.received(key, 'req-1', 9000)).toMatchObject({ state: 'received', acceptedAt: 5000 })
  })

  it('records an unproven reason without leaving the uncertain state', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    store.claim(key, 'req-1', digest('b'))
    store.unproven(key, 'req-1', 'PC_WINDOW_TIMEOUT')
    expect(store.receipt(key, 'req-1')).toMatchObject({ state: 'uncertain', reason: 'PC_WINDOW_TIMEOUT' })
  })

  it('never overwrites a received outcome with a later unproven reason', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    store.claim(key, 'req-1', digest('b'))
    store.received(key, 'req-1', 5000)
    store.unproven(key, 'req-1', 'PC_WINDOW_TIMEOUT')
    expect(store.receipt(key, 'req-1')).toMatchObject({ state: 'received', reason: 'session-admitted' })
  })

  it('refuses to publish an admission for a request that was never claimed', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    await refuses(() => store.received(key, 'never-claimed', 5000), 'STORAGE_FAILED')
  })
})

describe('receipt pages', () => {
  it('reads receipts after a position, oldest first, up to the page ceiling', async () => {
    const store = await opened()
    const key = store.register(BINDING, 1000).key
    for (const index of [1, 2, 3]) store.claim(key, `req-${String(index)}`, digest(`b-${String(index)}`))
    expect(store.receiptsAfter(key, 0, 10).map(receipt => receipt.sequence)).toEqual([1, 2, 3])
    expect(store.receiptsAfter(key, 1, 10).map(receipt => receipt.requestId)).toEqual(['req-2', 'req-3'])
    expect(store.receiptsAfter(key, 0, 2).map(receipt => receipt.sequence)).toEqual([1, 2])
    expect(store.receiptsAfter(key, 3, 10)).toEqual([])
  })

  it('keeps the receipt stream of one binding out of another', async () => {
    const store = await opened()
    const mine = store.register(BINDING, 1000).key
    const theirs = store.register(OTHER, 1000).key
    store.claim(mine, 'req-1', digest('b'))
    expect(store.receiptsAfter(theirs, 0, 10)).toEqual([])
  })
})

describe('durability across a later Host process', () => {
  it('serves the same claims and sequence after reopening the file', async () => {
    const path = join(await directory(), 'mobile-sync.sqlite')
    const first = await opened(path)
    const key = first.register(BINDING, 1000).key
    first.claim(key, 'req-1', digest('b'))
    first.received(key, 'req-1', 5000)
    first.close()
    const later = await opened(path)
    expect(later.binding(BINDING)).toMatchObject({ key, issuedSequence: 1 })
    expect(later.receipt(key, 'req-1')).toMatchObject({ state: 'received', acceptedAt: 5000 })
    expect(later.claim(key, 'req-2', digest('b2')).sequence).toBe(2)
  })

  it('reports a database file this Host cannot create as a storage failure', async () => {
    // A name past the filesystem's component limit: the file can never be created, and no message reaches the phone.
    const path = join(await directory(), `${'n'.repeat(300)}.sqlite`)
    await refuses(() => openMobileSyncDatabase(path), 'STORAGE_FAILED')
  })

  it('refuses a SQLite file that is not this database', async () => {
    const path = join(await directory(), 'foreign.sqlite')
    const foreign = new DatabaseSync(path)
    foreign.exec('CREATE TABLE grants(id TEXT) STRICT; PRAGMA application_id=1; PRAGMA user_version=9;')
    foreign.close()
    await refuses(() => openMobileSyncDatabase(path), 'STORAGE_FAILED')
  })
})

describe('closed store', () => {
  it('refuses reads and writes once released', async () => {
    const store = await opened()
    store.register(BINDING, 1000)
    store.close()
    await refuses(() => store.binding(BINDING), 'CLOSED')
    await refuses(() => store.activeBindings(), 'CLOSED')
    await refuses(() => store.register(BINDING, 2000), 'CLOSED')
    await refuses(() => store.revokeAll(), 'CLOSED')
  })

  it('tolerates a repeated close', async () => {
    const store = await opened()
    store.close()
    expect(() => { store.close() }).not.toThrow()
  })
})
