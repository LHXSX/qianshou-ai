/** Prove ConnectHttp forwards x-qianshou-device into authorize/read over a real loopback socket. */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConnectHttp } from '../src/http.ts'
import type { ConnectService } from '../src/service.ts'
import type { ConnectionPage } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const page: ConnectionPage = {
  sessionId: 'fixture-session', label: 'Synthetic', mode: 'read', expiresAt: Date.now() + 60_000,
  cursor: '0', reset: false, hasMore: false, earlierOmitted: false, running: false, turns: [],
}

/** Records the device argument ConnectHttp passes; does not skip the device header gate. */
function recordingService() {
  const reads: Array<string | undefined> = []
  const authorizes: Array<string | undefined> = []
  const service = {
    authorize(_token: string, deviceId?: string): void { authorizes.push(deviceId) },
    read(_token: string, _cursor: string | null, _signal: AbortSignal, deviceId?: string): Promise<ConnectionPage> {
      reads.push(deviceId)
      return Promise.resolve(page)
    },
    send(): Promise<never> { throw new Error('send must not be called') },
    receipt(): Promise<never> { throw new Error('receipt must not be called') },
  } as unknown as ConnectService
  return { service, reads, authorizes }
}

async function fixture() {
  const recorded = recordingService()
  const server = createServer((req, res) => { void handler.handle(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const handler = new ConnectHttp(recorded.service, {
    origin, viewer: '/* synthetic static browser asset */', maxRequests: 5, timeoutMs: 500,
  })
  cleanups.push(async () => {
    await handler.dispose(); server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const post = (headers: Record<string, string> = {}) => fetch(`${origin}/qianshou-connect/api/read`, {
    method: 'POST',
    headers: {
      Origin: origin,
      Authorization: 'Bearer fixture-token-abcdefghijklmnopqrstuvwxyz',
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify({ cursor: null }),
  })
  return { origin, post, reads: recorded.reads, authorizes: recorded.authorizes }
}

describe('ConnectHttp x-qianshou-device forwarding', () => {
  it('passes a present device header into read', async () => {
    const f = await fixture()
    const res = await f.post({ 'x-qianshou-device': 'device-phone-a' })
    expect(res.status).toBe(200)
    expect(f.reads).toEqual(['device-phone-a'])
    expect(f.authorizes.every((device) => device === 'device-phone-a')).toBe(true)
  })

  it('passes undefined when the device header is absent', async () => {
    const f = await fixture()
    const res = await f.post()
    expect(res.status).toBe(200)
    expect(f.reads).toEqual([undefined])
    expect(f.reads[0]).not.toBe('')
    expect(f.authorizes.every((device) => device === undefined)).toBe(true)
  })

  it('rejects empty or over-long device headers before read', async () => {
    const empty = await fixture()
    const emptyRes = await empty.post({ 'x-qianshou-device': '' })
    expect(emptyRes.status).toBe(400)
    expect(await emptyRes.json()).toEqual({ error: 'invalid-request' })
    expect(empty.reads).toEqual([])
    expect(empty.authorizes).toEqual([])

    const long = await fixture()
    const longRes = await long.post({ 'x-qianshou-device': 'd'.repeat(257) })
    expect(longRes.status).toBe(400)
    expect(await longRes.json()).toEqual({ error: 'invalid-request' })
    expect(long.reads).toEqual([])
    expect(long.authorizes).toEqual([])
  })
})
