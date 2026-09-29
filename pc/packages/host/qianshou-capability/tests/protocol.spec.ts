/** The transport admits one kind of origin, retries only idempotent reads, and bounds every body. */
import { afterEach, describe, expect, it } from 'vitest'
import { CapabilityProtocol, coreOrigin, failureForStatus } from '../src/protocol.ts'
import { origin, type Reply, type TestOrigin } from './support.ts'

const servers: TestOrigin[] = []
afterEach(async () => { for (const server of servers.splice(0)) await server.close() })

const open = new AbortController().signal
const limits = { timeoutMs: 1000, maxRetries: 1, retryDelayMs: 0, maxResponseBytes: 1024 }

async function started(replies: Reply[]): Promise<TestOrigin> {
  const server = await origin(replies)
  servers.push(server)
  return server
}

describe('accepted origins', () => {
  it.each(['https://qianshousuanli.com', 'https://qianshousuanli.com:8443', 'http://127.0.0.1:3000', 'http://localhost:3000'])('accepts %s', (value) => {
    expect(coreOrigin(value)).toBe(new URL(value).origin)
  })

  it.each([
    ['plain HTTP off loopback', 'http://qianshousuanli.com'],
    ['an embedded credential', 'https://user:pass@qianshousuanli.com'],
    ['a path', 'https://qianshousuanli.com/api/v8'],
    ['a query', 'https://qianshousuanli.com/?token=x'],
    ['a fragment', 'https://qianshousuanli.com/#x'],
    ['a value that is not a URL', 'qianshousuanli.com'],
  ])('refuses %s', (_case, value) => {
    expect(() => coreOrigin(value)).toThrow('qianshou-capability')
  })
})

describe('failure vocabulary', () => {
  it.each([
    [401, 'auth-required'],
    [403, 'auth-required'],
    [404, 'not-in-catalog'],
    [429, 'rate-limited'],
    [500, 'server-error'],
    [503, 'server-error'],
    [400, 'invalid-response'],
  ] as const)('maps HTTP %i to %s', (status, failure) => {
    expect(failureForStatus(status)).toBe(failure)
  })
})

describe('request behaviour against a real loopback server', () => {
  it('sends the bearer once and returns the answer', async () => {
    const server = await started([{ status: 200, json: { ok: true } }])
    const protocol = new CapabilityProtocol({ coreOrigin: server.origin, ...limits })
    expect(await protocol.request('/api/v8/capabilities', 'GET', 'secret-token', undefined, open))
      .toEqual({ kind: 'answer', status: 200, payload: { ok: true } })
    expect(server.requests).toMatchObject([{ method: 'GET', url: '/api/v8/capabilities', authorization: 'Bearer secret-token' }])
  })

  it('retries a server error for a read and never for a write', async () => {
    const reads = await started([{ status: 500, json: { ok: false } }, { status: 200, json: { ok: true } }])
    const readProtocol = new CapabilityProtocol({ coreOrigin: reads.origin, ...limits })
    expect(await readProtocol.request('/api/v8/capabilities', 'GET', 't', undefined, open)).toMatchObject({ status: 200 })
    expect(reads.requests).toHaveLength(2)
    const writes = await started([{ status: 500, json: { ok: false } }, { status: 200, json: { ok: true } }])
    const writeProtocol = new CapabilityProtocol({ coreOrigin: writes.origin, ...limits })
    expect(await writeProtocol.request('/api/v8/economy/estimate', 'POST', 't', { spec: {} }, open)).toMatchObject({ status: 500 })
    expect(writes.requests).toMatchObject([{ method: 'POST', body: '{"spec":{}}' }])
  })

  it('reports no payload for a body over the bound or a body that is not JSON', async () => {
    const large = await started([{ status: 200, text: JSON.stringify({ pad: 'x'.repeat(2048) }) }])
    const largeProtocol = new CapabilityProtocol({ coreOrigin: large.origin, ...limits })
    expect(await largeProtocol.request('/api/v8/capabilities', 'GET', 't', undefined, open))
      .toEqual({ kind: 'answer', status: 200, payload: undefined })
    const html = await started([{ status: 200, text: '<html>gateway</html>' }])
    const htmlProtocol = new CapabilityProtocol({ coreOrigin: html.origin, ...limits })
    expect(await htmlProtocol.request('/api/v8/capabilities', 'GET', 't', undefined, open))
      .toEqual({ kind: 'answer', status: 200, payload: undefined })
  })

  it('reports a closed lifetime without sending anything', async () => {
    const server = await started([{ status: 200, json: { ok: true } }])
    const protocol = new CapabilityProtocol({ coreOrigin: server.origin, ...limits })
    expect(await protocol.request('/api/v8/capabilities', 'GET', 't', undefined, AbortSignal.abort()))
      .toEqual({ kind: 'failed', failure: 'closed' })
    expect(server.requests).toEqual([])
  })

  it('reports a network failure when nothing listens on the origin', async () => {
    const closed = await origin([{ status: 200, json: { ok: true } }])
    const dead = closed.origin
    await closed.close()
    const protocol = new CapabilityProtocol({ coreOrigin: dead, ...limits, maxRetries: 0 })
    expect(await protocol.request('/api/v8/capabilities', 'GET', 't', undefined, open))
      .toEqual({ kind: 'failed', failure: 'network' })
  })
})
