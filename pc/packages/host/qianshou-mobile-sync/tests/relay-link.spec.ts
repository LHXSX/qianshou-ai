/**
 * The outbound relay link over a scripted `fetch`: one registration per account, one execution per delivery id,
 * and every refusal named by a stable code that carries no credential.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PC_LINK_PROTOCOL, RelayLink, type RelayLinkOptions } from '../src/relay-link.ts'
import type { RelayReply, RelayRequest } from '../src/types.ts'

const RELAY = 'https://relay.example.com/mobile-pc'

/** One scripted relay call: the path taken, the body sent and the authorization header. */
interface Call {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly authorization: string | null
}

/** A queued answer for one path, a hold that keeps the long poll open until released, or a transport failure. */
type Answer =
  | { readonly status: number; readonly body: unknown }
  | { readonly holds: true }
  | { readonly throws: true }
  | { readonly holdsUntilAbort: true }

const links: RelayLink[] = []
afterEach(async () => {
  for (const link of links.splice(0)) await link.stop()
})

function relay(script: Partial<Record<string, readonly Answer[]>>) {
  const calls: Call[] = []
  const remaining = new Map<string, Answer[]>(Object.entries(script).map(([path, answers]) => [path, [...answers ?? []]]))
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = String(url).slice(`${RELAY}/pc/`.length)
    const headers = new Headers(init?.headers)
    calls.push({ path, body: JSON.parse(String(init?.body)) as Record<string, unknown>, authorization: headers.get('authorization') })
    // An exhausted path holds open, which is what the relay does between forwarded requests.
    const answer = remaining.get(path)?.shift() ?? { holds: true }
    if ('throws' in answer) throw new TypeError('fetch failed')
    if ('holdsUntilAbort' in answer) {
      // What a real fetch does when its deadline aborts the request: it rejects instead of answering.
      await new Promise<void>((resolve) => { init?.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    if ('holds' in answer) {
      await new Promise<void>((resolve) => { init?.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
      return new Response(JSON.stringify({ requests: [] }), { status: 200 })
    }
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), { status: answer.status })
  }) as typeof fetch
  return { calls, fetchImpl }
}

function link({ handle: executor, ...overrides }: Partial<RelayLinkOptions> & Pick<RelayLinkOptions, 'fetch'>) {
  const handle = vi.fn(executor ?? (async (request: RelayRequest): Promise<RelayReply> =>
    ({ id: request.id, status: 200, body: { ok: request.action }, ownerBound: { version: 'v1', accountId: request.accountId } })))
  const created = new RelayLink({
    relayUrl: RELAY, pcId: 'pc-1', credential: async () => 'token-1', handle,
    pollWaitMs: 5, requestTimeoutMs: 50, reconnectMinMs: 1, reconnectMaxMs: 2, replyCacheSize: 2,
    now: () => 1_700_000_000_000, ...overrides,
  })
  links.push(created)
  return { created, handle }
}

const registered = (leaseId = 'lease-1'): Answer[] => [{ status: 200, body: { leaseId } }]
const forwarded = (request: Partial<RelayRequest> & { id: string }): Answer => ({
  status: 200,
  body: { requests: [{ action: 'access', accountId: 'acct-1', payload: {}, ...request }] },
})

/** Wait for the link's own bookkeeping instead of a fixed delay. */
async function until(condition: () => boolean): Promise<void> {
  await vi.waitFor(() => { expect(condition()).toBe(true) }, { timeout: 2000, interval: 1 })
}

describe('relay link registration', () => {
  it('refuses a poll hold that cannot complete inside the request deadline', () => {
    expect(() => new RelayLink({
      relayUrl: RELAY, pcId: 'pc-1', credential: async () => 'token-1',
      handle: async () => ({ id: 'x', status: 200, body: null, ownerBound: null }),
      pollWaitMs: 50, requestTimeoutMs: 50, reconnectMinMs: 1, reconnectMaxMs: 2, replyCacheSize: 2,
    })).toThrow('pollWaitMs must be below requestTimeoutMs')
  })

  it('registers one account with the protocol name, the PC id and a per-request bearer', async () => {
    const { calls, fetchImpl } = relay({ register: registered() })
    const { created } = link({ fetch: fetchImpl })
    expect(created.status()).toMatchObject({ accountId: null, registration: 'signed-out' })
    await created.start('acct-1')
    await until(() => created.status().registration === 'registered')
    expect(calls[0]).toEqual({
      path: 'register',
      body: { pcId: 'pc-1', accountId: 'acct-1', protocol: PC_LINK_PROTOCOL },
      authorization: 'Bearer token-1',
    })
    expect(created.status()).toEqual({
      accountId: 'acct-1', registration: 'registered', registeredAt: 1_700_000_000_000,
      lastHeartbeatAt: 1_700_000_000_000, lastFailure: null,
    })
    await until(() => calls.some(call => call.path === 'poll'))
    expect(calls.find(call => call.path === 'poll')?.body).toEqual({ pcId: 'pc-1', accountId: 'acct-1', leaseId: 'lease-1', waitMs: 5 })
  })

  it('reports a signed-out credential without sending a request', async () => {
    const { calls, fetchImpl } = relay({ register: registered() })
    const { created } = link({ fetch: fetchImpl, credential: async () => undefined })
    await created.start('acct-1')
    await until(() => created.status().lastFailure === 'PC_WINDOW_CREDENTIAL_UNAVAILABLE')
    expect(calls).toEqual([])
    expect(created.status().registration).toBe('disconnected')
  })

  it('retries after a registration answer with no usable lease', async () => {
    const { calls, fetchImpl } = relay({ register: [{ status: 200, body: { leaseId: '  ' } }, ...registered('lease-2')] })
    const { created } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => created.status().lastFailure === 'PC_WINDOW_RELAY_INVALID_REPLY')
    await until(() => created.status().registration === 'registered')
    expect(created.status().lastFailure).toBeNull()
    expect(calls.filter(call => call.path === 'register')).toHaveLength(2)
  })

  it('unregisters the previous account before registering the next one', async () => {
    const { calls, fetchImpl } = relay({
      register: [...registered('lease-1'), ...registered('lease-2')],
      unregister: [{ status: 200, body: {} }],
    })
    const { created } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => created.status().registration === 'registered')
    await created.start('acct-2')
    await until(() => created.status().accountId === 'acct-2')
    expect(calls.find(call => call.path === 'unregister')?.body).toEqual({ pcId: 'pc-1', accountId: 'acct-1', leaseId: 'lease-1' })
    expect(calls.filter(call => call.path === 'register').at(-1)?.body).toMatchObject({ accountId: 'acct-2' })
  })

  it('reports an unregister whose own deadline expired without naming a relay code', async () => {
    const { fetchImpl } = relay({ register: registered(), unregister: [{ holdsUntilAbort: true }] })
    const { created } = link({ fetch: fetchImpl, requestTimeoutMs: 30, pollWaitMs: 5 })
    await created.start('acct-1')
    await until(() => created.status().registration === 'registered')
    await created.stop()
    expect(created.status().lastFailure).toBe('unregister:PC_WINDOW_RELAY_UNAVAILABLE')
  })

  it('takes the platform fetch and the wall clock when the deployment names neither', () => {
    const created = new RelayLink({
      relayUrl: RELAY, pcId: 'pc-1', credential: async () => 'token-1',
      handle: async () => ({ id: 'x', status: 200, body: null, ownerBound: null }),
      pollWaitMs: 1000, requestTimeoutMs: 2000, reconnectMinMs: 100, reconnectMaxMs: 1000, replyCacheSize: 16,
    })
    links.push(created)
    expect(created.status()).toEqual({ accountId: null, registration: 'signed-out', registeredAt: null, lastHeartbeatAt: null, lastFailure: null })
  })

  it('leaves the relay on stop and records a failed unregister as such', async () => {
    const { calls, fetchImpl } = relay({ register: registered(), unregister: [{ status: 503, body: {} }] })
    const { created } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => created.status().registration === 'registered')
    await created.stop()
    expect(created.status()).toMatchObject({
      registration: 'stopped', registeredAt: null, lastFailure: 'unregister:PC_WINDOW_RELAY_REJECTED:503',
    })
    expect(calls.filter(call => call.path === 'unregister')).toHaveLength(1)
    const after = calls.length
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(calls).toHaveLength(after)
  })
})

describe('forwarded requests', () => {
  it('answers one forwarded request by id and returns the lease with it', async () => {
    const { calls, fetchImpl } = relay({ register: registered(), poll: [forwarded({ id: 'delivery-1', action: 'submit' })] })
    const { created, handle } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => calls.some(call => call.path === 'reply'))
    expect(handle).toHaveBeenCalledTimes(1)
    expect(handle.mock.calls[0]?.[0]).toEqual({ id: 'delivery-1', action: 'submit', accountId: 'acct-1', payload: {} })
    expect(calls.find(call => call.path === 'reply')?.body).toEqual({
      pcId: 'pc-1', accountId: 'acct-1', leaseId: 'lease-1', id: 'delivery-1', status: 200,
      body: { ok: 'submit' }, ownerBound: { version: 'v1', accountId: 'acct-1' },
    })
  })

  it('replays the cached reply for a redelivered id instead of executing it again', async () => {
    const { calls, fetchImpl } = relay({
      register: registered(),
      poll: [forwarded({ id: 'delivery-1', action: 'submit' }), forwarded({ id: 'delivery-1', action: 'submit' })],
    })
    const { created, handle } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => calls.filter(call => call.path === 'reply').length === 2)
    expect(handle).toHaveBeenCalledTimes(1)
    const replies = calls.filter(call => call.path === 'reply')
    expect(replies[1]?.body).toEqual(replies[0]?.body)
  })

  it('executes again once the reply cache has dropped the id', async () => {
    const { calls, fetchImpl } = relay({
      register: registered(),
      poll: [
        forwarded({ id: 'delivery-1' }), forwarded({ id: 'delivery-2' }),
        forwarded({ id: 'delivery-3' }), forwarded({ id: 'delivery-1' }),
      ],
    })
    const { created, handle } = link({ fetch: fetchImpl, replyCacheSize: 2 })
    await created.start('acct-1')
    await until(() => calls.filter(call => call.path === 'reply').length === 4)
    expect(handle).toHaveBeenCalledTimes(4)
  })

  it('keeps polling after an answer that carries no requests at all', async () => {
    const { calls, fetchImpl } = relay({ register: registered(), poll: [{ status: 200, body: {} }, forwarded({ id: 'delivery-1' })] })
    const { created, handle } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => calls.some(call => call.path === 'reply'))
    expect(handle).toHaveBeenCalledTimes(1)
    expect(created.status().lastFailure).toBeNull()
  })

  it('does not answer the relay for a request whose execution outlived the registration', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => { release = resolve })
    const { calls, fetchImpl } = relay({ register: registered(), poll: [forwarded({ id: 'delivery-1' })], unregister: [{ status: 200, body: {} }] })
    const { created, handle } = link({
      fetch: fetchImpl,
      handle: async (request) => { await held; return { id: request.id, status: 200, body: null, ownerBound: null } },
    })
    await created.start('acct-1')
    await until(() => handle.mock.calls.length === 1)
    const stopped = created.stop()
    release()
    await stopped
    expect(calls.some(call => call.path === 'reply')).toBe(false)
  })

  it('reports an executor failure that names no relay code as an unavailable relay', async () => {
    const { fetchImpl } = relay({ register: registered(), poll: [forwarded({ id: 'delivery-1' })] })
    const { created } = link({ fetch: fetchImpl, handle: async () => { throw new TypeError('executor broke') } })
    await created.start('acct-1')
    await until(() => created.status().lastFailure === 'PC_WINDOW_RELAY_UNAVAILABLE')
  })

  it('refuses a request forwarded for another account without executing it', async () => {
    const { fetchImpl } = relay({ register: registered(), poll: [forwarded({ id: 'delivery-1', accountId: 'acct-2' })] })
    const { created, handle } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => created.status().lastFailure === 'PC_WINDOW_RELAY_INVALID_REPLY')
    expect(handle).not.toHaveBeenCalled()
  })

  it.each([
    ['a row that is not a request envelope', { requests: [{ action: 'access', accountId: 'acct-1' }] }],
    ['an unknown action', { requests: [{ id: 'delivery-1', action: 'reboot', accountId: 'acct-1' }] }],
    ['requests that are not a list', { requests: { id: 'delivery-1' } }],
    ['more requests than one batch may carry', {
      requests: Array.from({ length: 65 }, (_, index) => ({ id: `d-${String(index)}`, action: 'access', accountId: 'acct-1' })),
    }],
  ])('refuses %s', async (_case, body) => {
    const { fetchImpl } = relay({ register: registered(), poll: [{ status: 200, body }] })
    const { created, handle } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => created.status().lastFailure === 'PC_WINDOW_RELAY_INVALID_REPLY')
    expect(handle).not.toHaveBeenCalled()
  })
})

describe('relay transport refusals', () => {
  it('names the relay code a rejection reported, and the status when the code is unusable', async () => {
    const { fetchImpl } = relay({ register: [{ status: 429, body: { error: { code: 'PC_WINDOW_CAPACITY' } } }] })
    const { created } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => created.status().lastFailure === 'PC_WINDOW_RELAY_REJECTED:PC_WINDOW_CAPACITY')
    await created.stop()

    const unusable = relay({ register: [{ status: 500, body: { error: { code: 'not a code' } } }] })
    const second = link({ fetch: unusable.fetchImpl })
    await second.created.start('acct-1')
    await until(() => second.created.status().lastFailure === 'PC_WINDOW_RELAY_REJECTED:500')
  })

  it('refuses a body that is not JSON and one that exceeds the reply ceiling', async () => {
    const first = link({ fetch: (async () => new Response('{', { status: 200 })) as typeof fetch })
    await first.created.start('acct-1')
    await until(() => first.created.status().lastFailure === 'PC_WINDOW_RELAY_INVALID_REPLY')

    const oversized = 'x'.repeat(1024 * 1024 + 1)
    const second = link({ fetch: (async () => new Response(JSON.stringify({ leaseId: oversized }), { status: 200 })) as typeof fetch })
    await second.created.start('acct-1')
    await until(() => second.created.status().lastFailure === 'PC_WINDOW_RELAY_INVALID_REPLY')
  })

  it('reports an unreachable relay, and an empty answer as an unusable one', async () => {
    const { fetchImpl } = relay({ register: [{ throws: true }] })
    const { created } = link({ fetch: fetchImpl })
    await created.start('acct-1')
    await until(() => created.status().lastFailure === 'PC_WINDOW_RELAY_UNAVAILABLE')

    const empty = link({ fetch: (async () => new Response('', { status: 200 })) as typeof fetch })
    await empty.created.start('acct-1')
    await until(() => empty.created.status().lastFailure === 'PC_WINDOW_RELAY_INVALID_REPLY')
  })
})
