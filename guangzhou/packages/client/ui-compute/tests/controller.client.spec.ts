import { describe, expect, it, vi } from 'vitest'
import { ComputeController } from '../src/client/controller.ts'
import { capability, deferred, draft, status } from './fixtures.ts'

function transport() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const path = requestPath(input)
    if (path.endsWith('/status')) return Response.json(status)
    if (path.endsWith('/capabilities')) return Response.json([capability])
    if (path.endsWith('/plans/confirm')) {
      return Response.json({ ...draft, authorization: 'approved', reason: '方案已在本机确认，尚未报价、下单或扣费。' })
    }
    if (path.endsWith('/plans')) return Response.json(init?.method === 'POST' ? draft : [])
    return new Response(null, { status: 404 })
  })
}
function requestPath(input: string | URL | Request): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}
describe('compute bridge projection', () => {
  it('uses authenticated local routes, shows only real readiness and saves a draft without execution', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({ connection: status, capabilities: [capability], loading: false })
    expect(await controller.saveDraft(draft.request)).toBe(true)
    expect(controller.store.getSnapshot().drafts).toEqual([draft])
    expect(await controller.confirmDraft(draft.id, 'approved')).toBe(true)
    const mutations = fetch.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(mutations).toHaveLength(2)
    expect(mutations[0]).toMatchObject(['/api/qianshou/compute/plans', { credentials: 'same-origin', body: JSON.stringify(draft.request) }])
    expect(mutations[1]).toMatchObject(['/api/qianshou/compute/plans/confirm', {
      credentials: 'same-origin', body: JSON.stringify({ id: draft.id, decision: 'approved' }),
    }])
    expect(fetch.mock.calls.every(([url]) => !requestPath(url).match(/submit|execute|pay|quote/))).toBe(true)
    fetch.mockImplementation(async (input) => {
      if (requestPath(input).endsWith('/plans/publish')) {
        return Response.json({ ...draft, authorization: 'approved', workloadId: 'workload-1', reason: '方案已发布到调度中心，任务身份由核心签发；报价仍未接入。' })
      }
      return new Response(null, { status: 404 })
    })
    expect(await controller.publishDraft(draft.id)).toBe(true)
    expect(controller.store.getSnapshot().drafts[0]?.workloadId).toBe('workload-1')
    expect(fetch.mock.calls.at(-1)).toMatchObject(['/api/qianshou/compute/plans/publish', {
      credentials: 'same-origin', body: JSON.stringify({ id: draft.id }),
    }])
    controller.dispose()
  })
  it('invalidates stale readiness and catalog after authorization failure', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    fetch.mockImplementation(async () => Response.json({ error: { code: 'AUTH_REQUIRED', message: '请重新验证连接' } }, { status: 401 }))
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({ connection: null, capabilities: [], loading: false, error: { code: 'AUTH_REQUIRED', message: '请重新验证连接' } })
    expect(await controller.saveDraft(draft.request)).toBe(false)
    controller.dispose()
  })
  it.each([
    ['status', { configured: true, capabilities: { workloadRead: true }, message: 'bad' }],
    ['capabilities', [{ ...capability, available: 'yes' }]],
    ['capabilities', [capability, capability]],
    ['plans', [{ ...draft, quote: { totalMinor: 10 } }]],
    ['plans', [{ ...draft, createdAt: 'not-a-date' }]],
    ['plans', [{ ...draft, authorization: 'yes' }]],
  ])('rejects malformed %s without publishing partial facts', async (endpoint, value) => {
    const fetch = transport(), base = fetch.getMockImplementation()!
    fetch.mockImplementation(async (input, init) => requestPath(input).endsWith('/' + endpoint) ? Response.json(value) : base(input, init))
    const controller = new ComputeController(fetch)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({ connection: null, capabilities: [], loading: false, error: { code: 'INVALID_COMPUTE_RESPONSE' } })
    controller.dispose()
  })
  it('keeps an empty catalog empty and never offers or submits a default capability', async () => {
    const fetch = transport(), base = fetch.getMockImplementation()!
    fetch.mockImplementation(async (input, init) => requestPath(input).endsWith('/capabilities') ? Response.json([]) : base(input, init))
    const controller = new ComputeController(fetch)
    await controller.refresh()
    expect(controller.store.getSnapshot().capabilities).toEqual([])
    expect(await controller.saveDraft(draft.request)).toBe(false)
    expect(fetch.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    controller.dispose()
  })
  it('serializes rapid draft submissions and does not refresh over a saving draft', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    const pending = deferred<Response>()
    fetch.mockImplementation(() => pending.promise)
    const save = controller.saveDraft(draft.request)
    expect(await controller.saveDraft(draft.request)).toBe(false)
    await controller.refresh()
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    pending.resolve(Response.json(draft))
    expect(await save).toBe(true)
    expect(controller.store.getSnapshot().saving).toBe(false)
    controller.dispose()
  })
  it('loads stored drafts once for conversation cards and does not confirm over a saving draft', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.ensureLoaded()
    await controller.ensureLoaded()
    expect(fetch.mock.calls.filter(([url]) => requestPath(url).endsWith('/plans')).length).toBe(1)
    const pending = deferred<Response>()
    fetch.mockImplementation(() => pending.promise)
    const save = controller.saveDraft(draft.request)
    expect(await controller.confirmDraft(draft.id, 'approved')).toBe(false)
    pending.resolve(Response.json(draft))
    expect(await save).toBe(true)
    controller.dispose()
  })
  it('publishes a declined draft without inventing a quote or submit', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    fetch.mockImplementation(async (input) => {
      if (requestPath(input).endsWith('/plans/confirm')) {
        return Response.json({ ...draft, authorization: 'declined', reason: '方案已在本机拒绝，尚未报价、下单或扣费。' })
      }
      return new Response(null, { status: 404 })
    })
    expect(await controller.confirmDraft(draft.id, 'declined')).toBe(true)
    expect(controller.store.getSnapshot().drafts[0]?.authorization).toBe('declined')
    controller.dispose()
  })
  it('ignores a confirmation that settles after disposal', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    const pending = deferred<Response>()
    fetch.mockImplementation(() => pending.promise)
    const confirm = controller.confirmDraft(draft.id, 'approved')
    controller.dispose()
    pending.resolve(Response.json({ ...draft, authorization: 'approved', reason: '方案已在本机确认，尚未报价、下单或扣费。' }))
    expect(await confirm).toBe(false)
  })
  it('ignores a publish that settles after disposal', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    const pending = deferred<Response>()
    fetch.mockImplementation(() => pending.promise)
    const publish = controller.publishDraft(draft.id)
    controller.dispose()
    pending.resolve(Response.json({ ...draft, authorization: 'approved', workloadId: 'workload-1', reason: '已发布' }))
    expect(await publish).toBe(false)
  })
  it('shows a failed publish without inventing a workload identity', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    fetch.mockResolvedValue(Response.json({ error: { code: 'COMPUTE_PLAN_NOT_APPROVED', message: 'COMPUTE_PLAN_NOT_APPROVED' } }, { status: 409 }))
    expect(await controller.publishDraft(draft.id)).toBe(false)
    expect(controller.store.getSnapshot().drafts).toEqual([])
    expect(controller.store.getSnapshot().error).toMatchObject({ code: 'COMPUTE_PLAN_NOT_APPROVED' })
    controller.dispose()
  })
  it('does not publish over a saving draft', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    const pending = deferred<Response>()
    fetch.mockImplementation(() => pending.promise)
    const save = controller.saveDraft(draft.request)
    expect(await controller.publishDraft(draft.id)).toBe(false)
    pending.resolve(Response.json(draft))
    expect(await save).toBe(true)
    controller.dispose()
  })
  it('rejects duplicate persisted drafts without publishing a workload identity', async () => {
    const fetch = transport(), base = fetch.getMockImplementation()!
    fetch.mockImplementation(async (input, init) => requestPath(input).endsWith('/plans')
      ? Response.json([draft, draft])
      : base(input, init))
    const controller = new ComputeController(fetch)
    await controller.refresh()
    expect(controller.store.getSnapshot()).toMatchObject({ connection: null, capabilities: [], error: { code: 'INVALID_COMPUTE_RESPONSE' } })
    controller.dispose()
  })
  it('shows a failed confirmation without inventing an approved record', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    fetch.mockResolvedValue(Response.json({ error: { code: 'COMPUTE_PLAN_NOT_FOUND', message: 'COMPUTE_PLAN_NOT_FOUND' } }, { status: 404 }))
    expect(await controller.confirmDraft(draft.id, 'approved')).toBe(false)
    expect(controller.store.getSnapshot().drafts).toEqual([])
    expect(controller.store.getSnapshot().error).toMatchObject({ code: 'COMPUTE_PLAN_NOT_FOUND' })
    controller.dispose()
  })
  it('shows a failed draft response without inventing a saved record', async () => {
    const fetch = transport(), controller = new ComputeController(fetch)
    await controller.refresh()
    fetch.mockResolvedValue(new Response('<html>Unavailable</html>', { status: 503 }))
    expect(await controller.saveDraft(draft.request)).toBe(false)
    expect(controller.store.getSnapshot()).toMatchObject({ drafts: [], saving: false, error: { code: 'REQUEST_FAILED', message: 'HTTP_503' } })
    controller.dispose()
  })
  it('aborts disposal and ignores a transport that settles late', async () => {
    const pending = deferred<Response>()
    const fetch = vi.fn<typeof globalThis.fetch>(() => pending.promise)
    const controller = new ComputeController(fetch)
    const refresh = controller.refresh()
    await controller.refresh()
    expect(fetch).toHaveBeenCalledTimes(3)
    controller.dispose()
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    pending.resolve(Response.json({}))
    await refresh
    expect(controller.store.getSnapshot().connection).toBeNull()
    expect(controller.store.getSnapshot().error).toBeNull()
    expect(await controller.saveDraft(draft.request)).toBe(false)
    await controller.refresh()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})
