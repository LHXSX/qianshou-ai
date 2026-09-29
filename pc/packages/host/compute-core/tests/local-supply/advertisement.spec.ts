/** The advertisement port must never report a channel or an acknowledgement it did not actually receive. */
import { once } from 'node:events'
import { createServer, type RequestListener } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ADVERTISEMENT_RESPONSE_INVALID, ADVERTISEMENT_TRANSPORT_UNAVAILABLE, HttpSupplyAdvertisementPort,
  SUPPLY_ADVERTISEMENT_VERSION,
} from '../../src/supply/advertisement.ts'
import type { LocalSupplyService } from '../../src/supply/types.ts'

const options = { timeoutMs: 1000, maxResponseBytes: 65536 }
const services: LocalSupplyService[] = [
  { id: 'node', kind: 'tool', name: 'Node.js', version: '22.19.0', verification: 'verified', reason: null },
  { id: 'ollama:fixture', kind: 'local-model', name: 'Fixture model', version: null, verification: 'verified', reason: null },
]
function port(endpoint: string | null, tokenProvider: () => string | undefined = () => 'fixture-token', fetchImpl?: typeof fetch) {
  return new HttpSupplyAdvertisementPort({ ...options, endpoint, tokenProvider, ...(fetchImpl ? { fetch: fetchImpl } : {}) })
}
function acknowledgement(body: unknown): typeof fetch {
  return async () => new Response(JSON.stringify(body))
}

/** One request the loopback endpoint actually received. */
interface SeenRequest {
  method: string | undefined
  url: string | undefined
  authorization: string | undefined
  contentType: string | undefined
  body: unknown
}

describe('undeclared and unauthenticated channels', () => {
  it.each([null, ''])('reports a missing endpoint as unconfigured instead of a failing channel', async (endpoint) => {
    const channel = port(endpoint)
    expect(channel.connected()).toBe(false); expect(channel.linkState()).toBe('not-configured')
    expect(channel.lastFailureCode()).toBeNull()
    const signal = new AbortController().signal
    await expect(channel.publish(services, signal)).rejects.toMatchObject({ code: ADVERTISEMENT_TRANSPORT_UNAVAILABLE, state: 'not-configured' })
    await expect(channel.withdraw(signal)).rejects.toMatchObject({ code: ADVERTISEMENT_TRANSPORT_UNAVAILABLE, state: 'not-configured' })
  })
  it.each([() => undefined, () => '   ', () => { throw new Error('credential storage private') }])(
    'fails closed before any request when no credential is available', async (provider) => {
      const fetcher = vi.fn<typeof fetch>(acknowledgement({ ok: true, accepted: [] }))
      const channel = port('https://core.example/api/v8/compute/supply/advertisement', provider, fetcher)
      expect(channel.connected()).toBe(false); expect(channel.linkState()).toBe('unauthenticated')
      await expect(channel.publish(services, new AbortController().signal))
        .rejects.toMatchObject({ code: ADVERTISEMENT_TRANSPORT_UNAVAILABLE, state: 'unauthenticated' })
      expect(fetcher).not.toHaveBeenCalled()
    })
})

describe('real endpoint exchanges', () => {
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => { resolve() }))
    }
  })
  async function serve(handler: RequestListener): Promise<string> {
    const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v8/compute/supply/advertisement`
  }
  it('sends one authenticated replacement and returns only identifiers the server acknowledged', async () => {
    const seen: SeenRequest[] = []
    const endpoint = await serve((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization,
          contentType: request.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown })
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify({ ok: true, accepted: ['node'] }))
      })
    })
    const channel = port(endpoint)
    expect(channel.connected()).toBe(true); expect(channel.linkState()).toBe('ready')
    expect(await channel.publish(services, new AbortController().signal)).toEqual(['node'])
    expect(seen).toEqual([{ method: 'POST', url: '/api/v8/compute/supply/advertisement', authorization: 'Bearer fixture-token',
      contentType: 'application/json', body: { version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [
        { id: 'node', kind: 'tool', name: 'Node.js', version: '22.19.0' },
        { id: 'ollama:fixture', kind: 'local-model', name: 'Fixture model', version: null },
      ] } }])
    expect(channel.linkState()).toBe('ready'); expect(channel.lastFailureCode()).toBeNull()
  })
  it('withdraws by replacing the advertised set with an empty one', async () => {
    const bodies: unknown[] = []
    const endpoint = await serve((request, response) => {
      const chunks: Buffer[] = []
      request.on('data', chunk => chunks.push(chunk as Buffer))
      request.on('end', () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        response.end(JSON.stringify({ ok: true, accepted: [] }))
      })
    })
    const channel = port(endpoint)
    await expect(channel.withdraw(new AbortController().signal)).resolves.toBeUndefined()
    expect(bodies).toEqual([{ version: SUPPLY_ADVERTISEMENT_VERSION, capabilities: [] }])
  })
  it('keeps a failing but configured channel connected so the next observation retries', async () => {
    let status = 500
    const endpoint = await serve((_request, response) => {
      if (status !== 200) { response.writeHead(status); response.end('credential=do-not-return'); return }
      response.end(JSON.stringify({ ok: true, accepted: ['node'] }))
    })
    const channel = port(endpoint)
    await expect(channel.publish(services, new AbortController().signal))
      .rejects.toMatchObject({ code: ADVERTISEMENT_TRANSPORT_UNAVAILABLE, state: 'failed' })
    expect(channel.connected()).toBe(true); expect(channel.linkState()).toBe('failed')
    expect(channel.lastFailureCode()).toBe('SUPPLY_HTTP_FAILED')
    status = 200
    expect(await channel.publish(services, new AbortController().signal)).toEqual(['node'])
    expect(channel.linkState()).toBe('ready'); expect(channel.lastFailureCode()).toBeNull()
  })
  it('bounds the response and keeps the transport code as the diagnostic', async () => {
    const endpoint = await serve((_request, response) => { response.write('['); response.end('0'.repeat(4096)) })
    const channel = new HttpSupplyAdvertisementPort({ timeoutMs: 1000, maxResponseBytes: 64, endpoint, tokenProvider: () => 'fixture-token' })
    await expect(channel.publish(services, new AbortController().signal))
      .rejects.toMatchObject({ code: ADVERTISEMENT_TRANSPORT_UNAVAILABLE, state: 'failed' })
    expect(channel.lastFailureCode()).toBe('SUPPLY_RESPONSE_TOO_LARGE')
  })
})

describe('acknowledgement shape', () => {
  it.each([
    { accepted: ['node'] }, { ok: false, accepted: ['node'] }, { ok: true }, { ok: true, accepted: 'node' },
    { ok: true, accepted: ['node', 'node'] }, { ok: true, accepted: ['node', 'invented'] },
  ])('never adopts an acknowledgement the endpoint did not verifiably give', async (body) => {
    const fetcher = vi.fn<typeof fetch>(acknowledgement(body))
    const channel = port('https://core.example/api/v8/compute/supply/advertisement', () => 'fixture-token', fetcher)
    await expect(channel.publish(services, new AbortController().signal))
      .rejects.toMatchObject({ code: ADVERTISEMENT_RESPONSE_INVALID, state: 'failed' })
    expect(channel.lastFailureCode()).toBe(ADVERTISEMENT_RESPONSE_INVALID)
  })
  it.each(['http://example.com/api/v8/x', 'https://user:pass@example.com/api/v8/x', 'https://example.com/api/v8/x?token=1',
    'not-an-endpoint', `https://example.com/${'segment/'.repeat(80)}`])('rejects an unsafe deployment endpoint', (value) => {
    expect(() => new HttpSupplyAdvertisementPort({ ...options, endpoint: value, tokenProvider: () => undefined }))
      .toThrow('SUPPLY_CONFIG_INVALID')
  })
})
