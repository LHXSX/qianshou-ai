/**
 * Client-side mobile sync: durable cursor restore and storage-boundary parsing.
 *
 * The HTTP transport and the store are injected ports here, so this file covers the
 * client's own decisions — what it restores, what it refuses from untrusted storage,
 * and which acknowledgements it refuses to publish. The live network round trip and
 * the real IndexedDB cursor reload are covered by the Host lane and the Chrome script.
 */
import { describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { MOBILE_SYNC_VERSION, type MobileCapabilityHeartbeat } from '@deepseek-ai/dsh-host-platform-observability-contract'
import type { PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'
import { MobileAgentShell, createMobileHttpSyncPort, type MobileAuthPort, type MobileAgentSyncPort } from '../src/index.ts'
import { MOBILE_SYNC_INITIAL_STATE, parseMobileSyncState, type MobileSyncState, type MobileSyncStatePort } from '../src/sync-state.ts'

const at = '2026-09-15T02:03:04.000Z'
const identity: PlatformIdentity = { kind: 'agent', id: 'agent-mobile' as never }

function auth(state: MobileAuthPort['state'] extends () => infer S ? S : never = 'authenticated'): MobileAuthPort {
  return { methods: [], state: () => state, begin: vi.fn(), logout: vi.fn() }
}

function heartbeat(overrides: Partial<MobileCapabilityHeartbeat> = {}): MobileCapabilityHeartbeat {
  return {
    version: MOBILE_SYNC_VERSION, identity, platform: 'web', agentVersion: '1.0.0', sequence: 1,
    sentAt: at, surface: 'foreground', acceptance: 'autonomous', capabilities: [],
    maxConcurrency: 2, runningTasks: 0, cursor: 'start', ...overrides,
  }
}

/** Recording durable store; it never fabricates a cursor it was not given. */
class Store implements MobileSyncStatePort {
  readonly writes: MobileSyncState[] = []
  private current: MobileSyncState | null
  constructor(initial: MobileSyncState | null = null) { this.current = initial }
  snapshot(): MobileSyncState | null { return this.current }
  async save(state: MobileSyncState): Promise<void> { this.writes.push(state); this.current = state }
}

function shell(options: {
  state?: MobileSyncStatePort
  sync?: MobileAgentSyncPort['sync']
  authState?: 'authenticated' | 'signed-out'
} = {}): MobileAgentShell {
  return new MobileAgentShell({
    identity, platform: 'web', agentVersion: '1.0.0', maxConcurrency: 2,
    auth: auth(options.authState ?? 'authenticated'), capabilities: () => [],
    sync: { sync: options.sync ?? (async () => ({ version: MOBILE_SYNC_VERSION, identity, cursor: 'agent-agent-mobile-r1', revision: 1, heartbeat: heartbeat({ cursor: 'agent-agent-mobile-r1' }) })) },
    policy: { enabled: true, requireForeground: true, maxConcurrentTasks: 1, acceptWithoutQuote: true },
    ...(options.state === undefined ? {} : { state: options.state }),
    now: () => at,
  })
}

describe('mobile sync state boundary', () => {
  it('starts at the initial cursor when the application has no durable record', () => {
    expect(MOBILE_SYNC_INITIAL_STATE).toEqual({ cursor: 'start', lastSyncRevision: null, sequence: 0 })
    const instance = shell({ state: new Store() })
    expect(instance.snapshot()).toMatchObject({ cursor: 'start', lastSyncRevision: null, sequence: 0 })
  })

  it('restores a stored cursor, revision and sequence', () => {
    const instance = shell({ state: new Store({ cursor: 'agent-agent-mobile-r7', lastSyncRevision: 7, sequence: 9 }) })
    expect(instance.snapshot()).toMatchObject({ cursor: 'agent-agent-mobile-r7', lastSyncRevision: 7, sequence: 9 })
    expect(instance.createHeartbeat()).toMatchObject({ sequence: 10, cursor: 'agent-agent-mobile-r7' })
  })

  it('refuses untrusted stored shapes instead of trusting them', () => {
    expect(parseMobileSyncState(null)).toBeNull()
    expect(parseMobileSyncState(undefined)).toBeNull()
    expect(parseMobileSyncState('start')).toBeNull()
    expect(parseMobileSyncState([])).toBeNull()
    expect(parseMobileSyncState({ cursor: 'bad cursor!', lastSyncRevision: 1, sequence: 1 })).toBeNull()
    expect(parseMobileSyncState({ cursor: 'start', lastSyncRevision: -1, sequence: 1 })).toBeNull()
    expect(parseMobileSyncState({ cursor: 'start', lastSyncRevision: 1.5, sequence: 1 })).toBeNull()
    expect(parseMobileSyncState({ cursor: 'start', lastSyncRevision: 1, sequence: -1 })).toBeNull()
    expect(parseMobileSyncState({ cursor: 'start', lastSyncRevision: 1 })).toBeNull()
    expect(parseMobileSyncState({ cursor: 'start', lastSyncRevision: 1, sequence: 2 }))
      .toEqual({ cursor: 'start', lastSyncRevision: 1, sequence: 2 })
    expect(parseMobileSyncState({ cursor: 'start', lastSyncRevision: null, sequence: 0 }))
      .toEqual({ cursor: 'start', lastSyncRevision: null, sequence: 0 })
  })
})

describe('mobile shell durable commit', () => {
  it('persists the accepted acknowledgement so a reload resumes from it', async () => {
    const store = new Store()
    const first = shell({ state: store })
    await first.sync(20)
    expect(store.writes).toEqual([{ cursor: 'agent-agent-mobile-r1', lastSyncRevision: 1, sequence: 1 }])

    // A fresh shell over the same store resumes instead of restarting.
    const reloaded = shell({ state: store })
    expect(reloaded.snapshot()).toMatchObject({ cursor: 'agent-agent-mobile-r1', lastSyncRevision: 1, sequence: 1 })
  })

  it('never persists a refused or stale acknowledgement', async () => {
    const store = new Store({ cursor: 'agent-agent-mobile-r2', lastSyncRevision: 2, sequence: 2 })
    const regressed = shell({
      state: store,
      sync: async () => ({ version: MOBILE_SYNC_VERSION, identity, cursor: 'agent-agent-mobile-r1', revision: 1, heartbeat: heartbeat({ cursor: 'agent-agent-mobile-r1' }) }),
    })
    await expect(regressed.sync(20)).rejects.toThrow('MOBILE_SYNC_ACK_STALE')
    expect(store.writes).toEqual([])
    expect(regressed.snapshot()).toMatchObject({ cursor: 'agent-agent-mobile-r2', lastSyncRevision: 2 })

    const unauthenticated = shell({ state: new Store(), authState: 'signed-out' })
    await expect(unauthenticated.sync(20)).rejects.toThrow('MOBILE_AUTH_REQUIRED')
  })

  it('surfaces a durable write failure instead of dropping it', async () => {
    const failing: MobileSyncStatePort = {
      snapshot: () => null,
      save: () => Promise.reject(new Error('MOBILE_SYNC_STORAGE_WRITE_FAILED')),
    }
    await expect(shell({ state: failing }).sync(20)).rejects.toThrow('MOBILE_SYNC_STORAGE_WRITE_FAILED')
  })
})

describe('mobile HTTP sync transport over a real socket', () => {
  /** Start a loopback server that answers the shift route with `answer` and records the request. */
  async function serve(answer: (request: { cookie?: string | undefined; body: unknown }) => { status: number; body: unknown }): Promise<{
    origin: string
    seen: Array<{ cookie?: string | undefined; body: unknown }>
    close: () => Promise<void>
  }> {
    const seen: Array<{ cookie?: string | undefined; body: unknown }> = []
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', (chunk: Buffer) => chunks.push(chunk))
      request.on('end', () => {
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const cookie = request.headers.cookie
        seen.push({ cookie, body })
        const result = answer({ cookie, body })
        response.writeHead(result.status, { 'content-type': 'application/json' })
        response.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body))
      })
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address() as AddressInfo
    return {
      origin: `http://127.0.0.1:${String(address.port)}`,
      seen,
      close: () => new Promise<void>((resolve, reject) => { server.close(error => { if (error) reject(error); else resolve() }) }),
    }
  }

  it('posts the cursor and heartbeat to the host route and returns the parsed acknowledgement', async () => {
    const ack = { version: MOBILE_SYNC_VERSION, identity, cursor: 'agent-agent-mobile-r1', revision: 1, heartbeat: heartbeat({ cursor: 'agent-agent-mobile-r1' }) }
    const server = await serve(() => ({ status: 200, body: ack }))
    try {
      const port = createMobileHttpSyncPort({ origin: server.origin, cookie: 'dsh-auth-fixture=value' })
      const result = await port.sync({ version: MOBILE_SYNC_VERSION, identity, cursor: 'start', limit: 20 }, heartbeat())
      expect(result).toEqual(ack)
      expect(server.seen).toHaveLength(1)
      expect(server.seen[0]?.cookie).toBe('dsh-auth-fixture=value')
      expect(server.seen[0]?.body).toEqual({
        request: { version: MOBILE_SYNC_VERSION, identity, cursor: 'start', limit: 20 }, heartbeat: heartbeat(),
      })
    } finally { await server.close() }
  })

  it('omits the cookie header for a browser client that relies on its own jar', async () => {
    const server = await serve(() => ({ status: 200, body: { version: MOBILE_SYNC_VERSION, identity, cursor: 'agent-agent-mobile-r1', revision: 1, heartbeat: heartbeat({ cursor: 'agent-agent-mobile-r1' }) } }))
    try {
      await createMobileHttpSyncPort({ origin: server.origin }).sync({ version: MOBILE_SYNC_VERSION, identity, cursor: 'start', limit: 20 }, heartbeat())
      expect(server.seen[0]?.cookie).toBeUndefined()
    } finally { await server.close() }
  })

  it('surfaces the host refusal code instead of fabricating an acknowledgement', async () => {
    const coded = await serve(() => ({ status: 409, body: { error: { code: 'MOBILE_SYNC_CURSOR_INVALID', message: 'MOBILE_SYNC_CURSOR_INVALID' } } }))
    const bare = await serve(() => ({ status: 401, body: 'unauthorized' }))
    try {
      await expect(createMobileHttpSyncPort({ origin: coded.origin }).sync({ version: MOBILE_SYNC_VERSION, identity, cursor: 'start', limit: 20 }, heartbeat()))
        .rejects.toThrow('MOBILE_SYNC_HTTP_409_MOBILE_SYNC_CURSOR_INVALID')
      await expect(createMobileHttpSyncPort({ origin: bare.origin }).sync({ version: MOBILE_SYNC_VERSION, identity, cursor: 'start', limit: 20 }, heartbeat()))
        .rejects.toThrow('MOBILE_SYNC_HTTP_401')
    } finally {
      await coded.close()
      await bare.close()
    }
  })

  it('drives a full shell sync through the real socket and persists the result', async () => {
    const server = await serve(() => ({ status: 200, body: { version: MOBILE_SYNC_VERSION, identity, cursor: 'agent-agent-mobile-r1', revision: 1, heartbeat: heartbeat({ cursor: 'agent-agent-mobile-r1', sequence: 1 }) } }))
    try {
      const store = new Store()
      const instance = shell({ state: store, sync: createMobileHttpSyncPort({ origin: server.origin, cookie: 'dsh-auth-fixture=value' }).sync })
      const ack = await instance.sync(20)
      expect(ack.revision).toBe(1)
      expect(store.writes).toEqual([{ cursor: 'agent-agent-mobile-r1', lastSyncRevision: 1, sequence: 1 }])
      // The heartbeat the transport sent carried the pre-sync cursor.
      expect(server.seen[0]?.body).toMatchObject({ request: { cursor: 'start', limit: 20 } })
    } finally { await server.close() }
  })
})
