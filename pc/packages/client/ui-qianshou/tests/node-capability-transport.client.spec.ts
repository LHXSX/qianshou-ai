import { describe, expect, it, vi } from 'vitest'
import { createNodeCapabilityTransport, parseNodeSupply } from '../src/client/node-status/node-capability-transport.ts'

const policy = {
  mode: 'off', maxConcurrency: 2, minFreeMemoryBytes: 1_000_000, minIdleSeconds: 90,
  enabledServiceIds: ['git'], nodeRates: [{ localServiceId: 'git', amountMinor: 12, unit: 'job', currency: 'CNY' }],
}

function snapshot(ownerPolicy: typeof policy = policy, verified = true) {
  return { version: 'qianshou.local-supply.v1', ownerPolicy,
    localServices: [{ id: 'node', kind: 'tool', verification: verified ? 'verified' : 'pending' }] }
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

describe('node service owner grant through authenticated Host supply', () => {
  it('starts with the node grant off and leaves master intake off while enabling only node', async () => {
    let saved = policy
    const requests: Array<{ url: string, method: string, body?: unknown }> = []
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, method: init?.method ?? 'GET', ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}) })
      if (init?.method === 'POST') saved = JSON.parse(String(init.body)) as typeof policy
      return response(snapshot(saved))
    }) as typeof fetch
    const transport = createNodeCapabilityTransport({ baseUri: 'https://local.example/', fetchImpl })
    expect(await transport.read()).toEqual({ enabled: false, verified: true, hasLocalRate: false })
    expect(await transport.setNodeEnabled(true)).toEqual({ enabled: true, verified: true, hasLocalRate: false })
    expect(saved).toEqual({ ...policy, mode: 'off', enabledServiceIds: ['git', 'node'] })
    expect(requests.filter(item => item.method === 'POST')).toEqual([{
      url: 'https://local.example/api/qianshou/compute/supply/policy', method: 'POST', body: saved,
    }])
    expect(fetchImpl).toHaveBeenCalledWith(expect.stringContaining('/api/qianshou/compute/supply/policy'),
      expect.objectContaining({ method: 'POST', credentials: 'same-origin', cache: 'no-store' }))
  })

  it('does not grant an unverified local node service', async () => {
    const fetchImpl = vi.fn(async () => response(snapshot(policy, false))) as typeof fetch
    const transport = createNodeCapabilityTransport({ baseUri: 'https://local.example/', fetchImpl })
    await expect(transport.setNodeEnabled(true)).rejects.toThrow('NODE_SERVICE_NOT_VERIFIED')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('removes only the node grant and its dependent local rate when explicitly disabled', async () => {
    let saved = { ...policy, enabledServiceIds: ['git', 'node'], nodeRates: [...policy.nodeRates,
      { localServiceId: 'node', amountMinor: 80, unit: 'job', currency: 'CNY' }] }
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') saved = JSON.parse(String(init.body)) as typeof saved
      return response(snapshot(saved))
    }) as typeof fetch
    const transport = createNodeCapabilityTransport({ baseUri: 'https://local.example/', fetchImpl })
    expect(await transport.setNodeEnabled(false)).toEqual({ enabled: false, verified: true, hasLocalRate: false })
    expect(saved).toEqual(policy)
  })

  it('rejects unknown future policy shapes and a write not confirmed by fresh Host state', async () => {
    expect(() => parseNodeSupply(snapshot({ ...policy, unexpected: 'future' } as typeof policy))).toThrow('NODE_SUPPLY_INVALID')
    const fetchImpl = vi.fn(async () => response(snapshot(policy))) as typeof fetch
    const transport = createNodeCapabilityTransport({ baseUri: 'https://local.example/', fetchImpl })
    await expect(transport.setNodeEnabled(true)).rejects.toThrow('NODE_SUPPLY_WRITE_UNCONFIRMED')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })
})
