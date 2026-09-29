/**
 * The plugin over a real loopback relay: one registration per signed-in account, forwarded phone requests answered
 * through the PC window service, and diagnostics that never carry the account bearer.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { AccountSnapshot } from '@deepseek-ai/dsh-host-qianshou-account'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { ACCOUNT_ACCESS_REF } from '../../qianshou-account/src/store.ts'
import QianshouMobileSync, { type Config } from '../src/index.ts'
import type { RelayRequest } from '../src/types.ts'

const TOKEN = 'fixture-access-token'

/** One request the relay observed, without its bearer. */
interface Observed {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly bearer: string | null
}

/** A loopback relay: it registers one PC, hands it queued phone requests and records every reply. */
interface Relay {
  readonly url: string
  readonly observed: Observed[]
  readonly replies: Record<string, unknown>[]
  /** Hand one forwarded phone request to the PC on its next poll. */
  forward: (request: RelayRequest) => void
  close: () => Promise<void>
}

const relays: Relay[] = []
const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const relay of relays.splice(0)) await relay.close()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

async function relay(): Promise<Relay> {
  const observed: Observed[] = []
  const replies: Record<string, unknown>[] = []
  const queued: RelayRequest[] = []
  let waiting: (() => void) | undefined
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      const path = (request.url ?? '').split('/').at(-1) ?? ''
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      observed.push({ path, body, bearer: request.headers.authorization ?? null })
      const answer = (value: unknown): void => {
        // A poll the PC abandoned leaves a closed socket behind; the relay has nothing to report then.
        if (response.writableEnded || response.destroyed) return
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify(value))
      }
      if (path === 'register') { answer({ leaseId: `lease-for-${String(body.accountId)}` }); return }
      if (path === 'reply') { replies.push(body); answer({}); return }
      if (path === 'unregister') { answer({}); return }
      if (queued.length > 0) { answer({ requests: queued.splice(0) }); return }
      const timer = setTimeout(() => { waiting = undefined; answer({ requests: [] }) }, 25)
      waiting = () => { clearTimeout(timer); waiting = undefined; answer({ requests: queued.splice(0) }) }
    })
  }
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  const created: Relay = {
    url: `http://127.0.0.1:${String(port)}/mobile-pc/v1`,
    observed,
    replies,
    forward: (request) => { queued.push(request); waiting?.() },
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => { resolve() }) }),
  }
  relays.push(created)
  return created
}

/** A non-secret account snapshot; only `phase` and `account` decide registration. */
function snapshot(phase: AccountSnapshot['phase'], id: string | null): AccountSnapshot {
  return { phase, account: id === null ? null : { id, username: 'Owner' }, failure: null, verifiedAt: null, restorable: false, models: [], cloudSelected: false }
}

async function directory(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), 'qianshou-mobile-sync-host-'))
  directories.push(created)
  return created
}

/** Mount the plugin over the loopback relay, in-memory credentials and fake Session services. */
async function boot(config: Partial<Config> & Pick<Config, 'relayUrl'>, seed: Record<string, string> = { [ACCOUNT_ACCESS_REF]: TOKEN }) {
  const account = { current: snapshot('authenticated', 'acct-1') }
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials, seed)
  ctx.provide('sessions', { get: () => undefined, flush: async () => true } as never)
  ctx.provide('agents', { get: () => undefined } as never)
  ctx.provide('sessionController', {
    list: () => Promise.resolve({ items: [{ sessionId: 'sess-1', updatedAt: 1000, running: false, blank: false, origin: 'user' }] }),
  } as never)
  ctx.provide('qianshouAccount', { state: () => account.current } as never)
  ctx.provide('connection', {
    fetch: { register: () => () => Promise.resolve() },
    issueBrowserSessionCookie: () => undefined,
  } as never)
  const fiber = await ctx.plugin(QianshouMobileSync, {
    pcId: '', pcIdPath: '', path: '', accountPollMs: 250, pollWaitMs: 1000, requestTimeoutMs: 2000,
    reconnectMinMs: 100, reconnectMaxMs: 1000, replyCacheSize: 16, maxBindings: 10, maxReceipts: 100,
    maxRequests: 8, sessionTimeoutMs: 2000, serveInbound: false,
    accountOrigin: 'https://qianshousuanli.com', windowOrigin: '', ...config,
  })
  return { ctx, fiber, account, sync: ctx.qianshouMobileSync }
}

/** A booted plugin whose private files live in one temporary directory. */
async function booted(overrides: Partial<Config> = {}, seed: Record<string, string> = { [ACCOUNT_ACCESS_REF]: TOKEN }) {
  const link = await relay()
  const root = await directory()
  return { link, root, ...await boot({ relayUrl: link.url, pcIdPath: join(root, 'pc-id.json'), path: join(root, 'v1.sqlite'), ...overrides }, seed) }
}

describe('registration at the relay', () => {
  it('registers the signed-in account with a bearer and reports only non-secret diagnostics', async () => {
    const { link, sync } = await booted()
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ registration: 'registered' }) })
    const status = await sync.status()
    expect(status).toMatchObject({ pcIdSource: 'generated', relayUrl: link.url, accountId: 'acct-1', lastFailure: null, activeBindings: 0 })
    expect(status.pcId).toMatch(/^[0-9a-f]{8}-/)
    expect(JSON.stringify(status)).not.toContain(TOKEN)
    expect(JSON.stringify(status)).not.toContain('lease-for-')
    const registration = link.observed.find(request => request.path === 'register')
    expect(registration?.bearer).toBe(`Bearer ${TOKEN}`)
    expect(registration?.body).toMatchObject({ accountId: 'acct-1', pcId: status.pcId })
  })

  it('refuses to load when the long-poll hold cannot complete inside the request deadline', async () => {
    const link = await relay()
    const root = await directory()
    await expect(boot({ relayUrl: link.url, pcIdPath: join(root, 'pc-id.json'), path: join(root, 'v1.sqlite'), pollWaitMs: 2000, requestTimeoutMs: 2000 }))
      .rejects.toThrow('pollWaitMs must be below requestTimeoutMs')
  })

  it('reports a signed-in account with no usable bearer without registering', async () => {
    const { link, sync } = await booted({}, {})
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ lastFailure: 'PC_WINDOW_CREDENTIAL_UNAVAILABLE' }) })
    expect(link.observed).toEqual([])
  })

  it('keeps a configured identity instead of persisting one', async () => {
    const { root, sync } = await booted({ pcId: 'owner-chosen-pc' })
    expect(await sync.status()).toMatchObject({ pcId: 'owner-chosen-pc', pcIdSource: 'configured' })
    await expect(readFile(join(root, 'pc-id.json'), 'utf8')).rejects.toThrow()
  })

  it('resolves its private files beneath DSH_HOME when the deployment names none', async () => {
    const home = await directory()
    vi.stubEnv('DSH_HOME', home)
    const link = await relay()
    const { sync } = await boot({ relayUrl: link.url })
    const status = await sync.status()
    expect(JSON.parse(await readFile(join(home, 'qianshou', 'mobile-sync', 'pc-id.json'), 'utf8'))).toMatchObject({ pcId: status.pcId })
    await expect(readFile(join(home, 'qianshou', 'mobile-sync', 'v1.sqlite'))).resolves.toBeDefined()
  })

  it('refuses a damaged identity instead of becoming a new PC at the relay', async () => {
    const link = await relay()
    const root = await directory()
    await expect(boot({ relayUrl: link.url, pcId: 'pc\u0001id', pcIdPath: join(root, 'pc-id.json'), path: join(root, 'v1.sqlite') }))
      .rejects.toThrow('PC_WINDOW_PC_ID_INVALID')
  })
})

describe('forwarded phone requests', () => {
  it('answers a forwarded bootstrap through the window service and counts the binding it created', async () => {
    const { link, sync } = await booted()
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ registration: 'registered' }) })
    link.forward({ id: 'd-1', action: 'bootstrap', accountId: 'acct-1', payload: { deviceId: 'phone-1' } })
    await vi.waitFor(() => { expect(link.replies).toHaveLength(1) })
    expect(link.replies[0]).toMatchObject({ id: 'd-1', status: 200, ownerBound: { version: 'v1', accountId: 'acct-1' } })
    expect(await sync.status()).toMatchObject({ activeBindings: 1 })
  })

  it('refuses a request the relay forwarded for another account', async () => {
    const { link, sync } = await booted()
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ registration: 'registered' }) })
    link.forward({ id: 'd-1', action: 'bootstrap', accountId: 'acct-2', payload: { deviceId: 'phone-1' } })
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ lastFailure: 'PC_WINDOW_RELAY_INVALID_REPLY' }) })
    expect(link.replies).toEqual([])
  })
})

describe('the account this PC is signed in as', () => {
  it('revokes every binding and leaves the relay on sign-out', async () => {
    const { link, sync, account } = await booted()
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ registration: 'registered' }) })
    link.forward({ id: 'd-1', action: 'bootstrap', accountId: 'acct-1', payload: { deviceId: 'phone-1' } })
    await vi.waitFor(() => { expect(link.replies).toHaveLength(1) })
    account.current = snapshot('signed-out', null)
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ registration: 'signed-out', activeBindings: 0 }) })
    expect(link.observed.filter(request => request.path === 'unregister')).toHaveLength(1)
  })

  it('registers the next account after unregistering the previous one', async () => {
    const { link, sync, account } = await booted()
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ registration: 'registered' }) })
    account.current = snapshot('authenticated', 'acct-2')
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ accountId: 'acct-2', registration: 'registered' }) })
    expect(link.observed.filter(request => request.path === 'register').map(request => request.body.accountId)).toEqual(['acct-1', 'acct-2'])
    expect(link.observed.filter(request => request.path === 'unregister')).toHaveLength(1)
  })
})

describe('the plugin lifetime', () => {
  it('leaves the relay and refuses diagnostics once unloaded', async () => {
    const { link, sync, fiber } = await booted()
    await vi.waitFor(async () => { expect(await sync.status()).toMatchObject({ registration: 'registered' }) })
    await fiber.dispose()
    contexts.length = 0
    await expect(sync.status()).rejects.toThrow('PC_WINDOW_CLOSED')
    expect(link.observed.filter(request => request.path === 'unregister')).toHaveLength(1)
  })
})
