/**
 * Controller behaviour against real `Response` objects on the two real routes:
 * atomic publication, fail-closed staleness, and the exact policy body.
 */
import { describe, expect, it, vi } from 'vitest'
import { SupplyController } from '../src/client/controller.ts'
import { blockedJson, deferred, readyJson } from './fixtures.client.ts'

function requestPath(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

function createTransport() {
  return vi.fn<typeof fetch>(async (input, init) => {
    if (requestPath(input).endsWith('/supply/policy')) return Response.json(readyJson)
    return Response.json(init?.method === 'POST' ? readyJson : blockedJson)
  })
}

describe('supply projection', () => {
  it('publishes one complete observation from the real route', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    await controller.refresh()
    const state = controller.store.getSnapshot()
    expect(state.snapshot?.eligibility.state).toBe('blocked')
    expect(state.snapshot?.activity.voiceActive).toBeNull()
    expect(state).toMatchObject({ stale: false, loading: false, saving: false, error: null })
    expect(transport).toHaveBeenCalledTimes(1)
    expect(transport.mock.calls[0]?.[0]).toBe('/api/qianshou/compute/supply')
    expect(transport.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', credentials: 'same-origin', cache: 'no-store' })
    controller.dispose()
  })

  it('never claims an unobserved machine: a failed first read publishes no snapshot', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { code: 'AUTH_REQUIRED', message: '请重新验证连接' } }, { status: 401 }))
    const controller = new SupplyController(transport)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({
      snapshot: null, loading: false, stale: true, error: { code: 'AUTH_REQUIRED', message: '请重新验证连接' },
    })
    controller.dispose()
  })

  it('marks the previous observation stale instead of passing it off as current', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    await controller.refresh()
    transport.mockResolvedValue(new Response('<html>Unavailable</html>', { status: 503 }))
    await controller.refresh()
    const state = controller.store.getSnapshot()
    expect(state.snapshot?.observedAt).toBe(blockedJson.observedAt)
    expect(state).toMatchObject({ stale: true, loading: false, error: { code: 'REQUEST_FAILED', message: 'HTTP_503' } })
    controller.dispose()
  })

  it('rejects an incomplete observation instead of publishing part of it', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    await controller.refresh()
    transport.mockResolvedValue(Response.json({ ...blockedJson, eligibility: { state: 'ready', reasons: ['OWNER_DISABLED'] } }))
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({
      stale: true, loading: false, error: { code: 'INVALID_SUPPLY_RESPONSE', message: 'INVALID_SUPPLY_RESPONSE' },
    })
    controller.dispose()
  })

  it('rejects a non-JSON body on both routes', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => new Response('not json', { status: 200 }))
    const controller = new SupplyController(transport)
    await controller.refresh()
    expect(controller.store.getSnapshot().error?.code).toBe('INVALID_SUPPLY_RESPONSE')
    controller.dispose()
  })

  it('commits the complete policy to the policy route and publishes the fresh observation', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    await controller.refresh()
    const policy = { ...controller.store.getSnapshot().snapshot!.ownerPolicy, mode: 'allowed' as const }
    expect(await controller.savePolicy(policy)).toBe(true)
    const post = transport.mock.calls.find(([, init]) => init?.method === 'POST')
    expect(post?.[0]).toBe('/api/qianshou/compute/supply/policy')
    expect(post?.[1]).toMatchObject({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(policy) })
    expect(controller.store.getSnapshot()).toMatchObject({ saving: false, stale: false, error: null })
    expect(controller.store.getSnapshot().snapshot?.eligibility.state).toBe('ready')
    controller.dispose()
  })

  it('reports a rejected policy without dropping the observation', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    await controller.refresh()
    transport.mockResolvedValue(Response.json({ error: { code: 'SUPPLY_POLICY_INVALID', message: 'SUPPLY_POLICY_INVALID' } }, { status: 400 }))
    expect(await controller.savePolicy(controller.store.getSnapshot().snapshot!.ownerPolicy)).toBe(false)
    const state = controller.store.getSnapshot()
    expect(state.error?.code).toBe('SUPPLY_POLICY_INVALID')
    expect(state.snapshot?.eligibility.state).toBe('blocked')
    expect(state.saving).toBe(false)
    controller.dispose()
  })

  it('refuses to save without an observation base, while loading, or while another save runs', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    expect(await controller.savePolicy({ mode: 'off', maxConcurrency: 1, minFreeMemoryBytes: 0, minIdleSeconds: 0, enabledServiceIds: [], nodeRates: [] })).toBe(false)
    await controller.refresh()
    const pending = deferred<Response>()
    transport.mockImplementation(() => pending.promise)
    const first = controller.savePolicy(controller.store.getSnapshot().snapshot!.ownerPolicy)
    expect(await controller.savePolicy(controller.store.getSnapshot().snapshot!.ownerPolicy)).toBe(false)
    pending.resolve(Response.json(readyJson))
    expect(await first).toBe(true)
    expect(transport.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    controller.dispose()
  })

  it('does not refresh over a committing policy and coalesces concurrent refreshes', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    await controller.refresh()
    const pending = deferred<Response>()
    transport.mockImplementation(() => pending.promise)
    const saving = controller.savePolicy(controller.store.getSnapshot().snapshot!.ownerPolicy)
    await controller.refresh()
    expect(transport.mock.calls).toHaveLength(2)
    pending.resolve(Response.json(readyJson))
    await saving
    const held = deferred<Response>()
    transport.mockImplementation(() => held.promise)
    const first = controller.refresh()
    await controller.refresh()
    expect(transport.mock.calls).toHaveLength(3)
    held.resolve(Response.json(blockedJson))
    await first
    expect(controller.store.getSnapshot().snapshot?.eligibility.state).toBe('blocked')
    controller.dispose()
  })

  it('aborts on disposal and ignores a transport that settles late', async () => {
    const pending = deferred<Response>()
    const transport = vi.fn<typeof globalThis.fetch>(() => pending.promise)
    const controller = new SupplyController(transport)
    const refresh = controller.refresh()
    controller.dispose()
    expect(transport.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    pending.resolve(Response.json(blockedJson))
    await refresh
    expect(controller.store.getSnapshot().snapshot).toBeNull()
    expect(controller.store.getSnapshot().error).toBeNull()
    await controller.refresh()
    expect(transport).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('reports a non-Error rejection as a stable request failure', async () => {
    const transport = vi.fn<typeof globalThis.fetch>(async () => { throw 'offline' })
    const controller = new SupplyController(transport)
    await controller.refresh()
    expect(controller.store.getSnapshot().error).toEqual({ code: 'REQUEST_FAILED', message: 'REQUEST_FAILED' })
    controller.dispose()
  })

  it('uses the ambient fetch when no transport is injected', async () => {
    const ambient = vi.fn(async () => Response.json(blockedJson))
    vi.stubGlobal('fetch', ambient)
    try {
      const controller = new SupplyController()
      await controller.refresh()
      expect(ambient).toHaveBeenCalledTimes(1)
      expect(controller.store.getSnapshot().snapshot?.eligibility.state).toBe('blocked')
      controller.dispose()
    } finally { vi.unstubAllGlobals() }
  })

  it('publishes nothing when the page is disposed while an observation is in flight', async () => {
    const pending = deferred<Response>()
    const controller = new SupplyController(vi.fn<typeof fetch>(() => pending.promise))
    const refresh = controller.refresh()
    controller.dispose()
    pending.resolve(Response.json(blockedJson))
    await refresh
    expect(controller.store.getSnapshot()).toMatchObject({ snapshot: null, stale: false, error: null, loading: true })
  })

  it('reports no failure when an observation is abandoned by disposal', async () => {
    const pending = deferred<Response>()
    const controller = new SupplyController(vi.fn<typeof fetch>(() => pending.promise))
    const refresh = controller.refresh()
    controller.dispose()
    pending.resolve(Response.json({ error: { code: 'SUPPLY_OPERATION_FAILED', message: 'SUPPLY_OPERATION_FAILED' } }, { status: 503 }))
    await refresh
    expect(controller.store.getSnapshot()).toMatchObject({ snapshot: null, error: null, stale: false })
  })

  it('publishes no failure when a policy commit is abandoned by disposal', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    await controller.refresh()
    const policy = controller.store.getSnapshot().snapshot!.ownerPolicy
    const pending = deferred<Response>()
    transport.mockImplementation(() => pending.promise)
    const saving = controller.savePolicy(policy)
    controller.dispose()
    pending.resolve(new Response('<html>Unavailable</html>', { status: 503 }))
    expect(await saving).toBe(false)
    expect(controller.store.getSnapshot()).toMatchObject({ error: null, stale: false })
  })

  it('publishes nothing when the page is disposed while a policy commit resolves', async () => {
    const transport = createTransport(), controller = new SupplyController(transport)
    await controller.refresh()
    const policy = controller.store.getSnapshot().snapshot!.ownerPolicy
    const pending = deferred<Response>()
    transport.mockImplementation(() => pending.promise)
    const saving = controller.savePolicy(policy)
    controller.dispose()
    pending.resolve(Response.json(readyJson))
    expect(await saving).toBe(false)
    // The commit never published: the pre-save observation is still the one on screen.
    expect(controller.store.getSnapshot()).toMatchObject({ saving: true, stale: false, error: null })
    expect(controller.store.getSnapshot().snapshot?.eligibility.state).toBe('blocked')
    expect(await controller.savePolicy(policy)).toBe(false)
  })
})
