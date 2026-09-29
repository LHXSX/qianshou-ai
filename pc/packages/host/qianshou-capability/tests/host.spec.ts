/** The layers stay separate over a real loopback origin: listed is not runnable, and an estimate is not a quote. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { fixture, origin, type Reply, type TestOrigin } from './support.ts'
import { CATALOG_RESPONSE } from './catalog-response.ts'

const contexts: Context[] = []
const servers: TestOrigin[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const server of servers.splice(0)) await server.close()
})

const POOL = {
  found: true,
  capability: 'media.transcode',
  registry_version: '1.0',
  declared: { count: 4, by_impl: { ffmpeg: 4 } },
  available_now: { count: 2, by_impl: { ffmpeg: 2 }, online_ttl_seconds: 90 },
}

const ESTIMATE = {
  ok: true,
  task_type: 'video_compress',
  currency: 'CNY',
  estimated_total: '1.20',
  recommended_budget: '2.00',
  balance_enough: true,
  billing_mode: 'prepaid',
}

const INTENT = { goal: '把这段视频压小一点', budget: { amount_minor: 500, currency: 'CNY' } }

/** `null` boots the composition signed out; a default parameter cannot express that. */
async function boot(replies: Reply[], token: string | null = 'account-token') {
  const server = await origin(replies)
  servers.push(server)
  const booted = await fixture({ coreOrigin: server.origin, timeoutMs: 1000, maxRetries: 0, retryDelayMs: 0 }, token ?? undefined, contexts)
  return { ...booted, server }
}

describe('signed out', () => {
  it('reports every layer as signed-out without sending a request', async () => {
    const { capability, server } = await boot([{ status: 200, json: CATALOG_RESPONSE }], null)
    expect(await capability.catalog()).toMatchObject({ state: 'signed-out' })
    expect(await capability.availability('media.transcode')).toMatchObject({ state: 'signed-out', capabilityId: 'media.transcode' })
    expect(await capability.estimate('media.transcode', INTENT)).toMatchObject({ state: 'signed-out', capabilityId: 'media.transcode' })
    expect(server.requests).toEqual([])
  })
})

describe('layer one: catalog and scheduler health', () => {
  it('lists the catalog as catalog-only and names the route it read', async () => {
    const { capability, server } = await boot([{ status: 200, json: CATALOG_RESPONSE }])
    expect(await capability.catalog()).toMatchObject({
      state: 'catalog-only',
      registryVersion: '1.0',
      source: `${server.origin}/api/v8/capabilities`,
      entries: [
        { id: 'media.transcode', taskType: 'video_compress' },
        { id: 'accelerator.gpu', taskType: null },
        { id: 'future.capability.added', taskType: null },
      ],
    })
    expect(server.requests).toMatchObject([{ method: 'GET', url: '/api/v8/capabilities', authorization: 'Bearer account-token' }])
  })

  it('reads declared and available-now counts for one capability', async () => {
    const { capability, server } = await boot([{ status: 200, json: POOL }])
    expect(await capability.availability('media.transcode')).toMatchObject({
      state: 'catalog-only',
      capabilityId: 'media.transcode',
      declared: { count: 4, byImpl: { ffmpeg: 4 } },
      availableNow: { count: 2, byImpl: { ffmpeg: 2 }, onlineTtlSeconds: 90 },
    })
    expect(server.requests).toMatchObject([{ url: '/api/v8/capabilities/media.transcode/workers' }])
  })

  it('reports an unknown name as not-in-catalog rather than as an empty pool', async () => {
    const { capability } = await boot([{ status: 404, json: { detail: { found: false } } }])
    expect(await capability.availability('future.capability.added'))
      .toMatchObject({ state: 'unavailable', failure: 'not-in-catalog', httpStatus: 404 })
  })

  it('refuses an id outside the grammar before any request', async () => {
    const { capability, server } = await boot([{ status: 200, json: POOL }])
    expect(await capability.availability('Media.Transcode'))
      .toMatchObject({ state: 'unavailable', failure: 'invalid-input', httpStatus: null })
    expect(server.requests).toEqual([])
  })

  it.each([
    [401, 'auth-required'],
    [429, 'rate-limited'],
    [500, 'server-error'],
  ] as const)('reports HTTP %i as %s with its status', async (status, failure) => {
    const { capability } = await boot([{ status, json: { detail: 'server text the caller never sees' } }])
    expect(await capability.catalog()).toMatchObject({ state: 'unavailable', failure, httpStatus: status })
  })

  it('reports an answer it cannot project as invalid-response, not as an empty catalog', async () => {
    const { capability } = await boot([{ status: 200, json: { ...CATALOG_RESPONSE,
      capabilities: [{ capability: 'NOT-A-CAPABILITY', implementations: [], legacy_task_types: [] }] } }])
    expect(await capability.catalog()).toMatchObject({ state: 'unavailable', failure: 'invalid-response', httpStatus: 200 })
  })

  it('lists a new semantic ability without offering an estimate the Host cannot map', async () => {
    const { capability, server } = await boot([{ status: 200, json: CATALOG_RESPONSE }])
    const view = await capability.catalog()
    expect(view).toMatchObject({ state: 'catalog-only', entries: [
      { id: 'media.transcode', taskType: 'video_compress' },
      { id: 'accelerator.gpu', taskType: null },
      { id: 'future.capability.added', taskType: null },
    ] })
    expect(await capability.estimate('future.capability.added', INTENT))
      .toMatchObject({ state: 'unavailable', failure: 'not-in-catalog', httpStatus: null })
    expect(server.requests).toHaveLength(1)
  })
})

describe('layer two: server estimate', () => {
  it('posts the registry landing and returns estimate-only numbers with their provenance', async () => {
    const { capability, server } = await boot([{ status: 200, json: ESTIMATE }])
    const view = await capability.estimate('media.transcode', INTENT)
    expect(view).toMatchObject({
      state: 'estimate-only',
      capabilityId: 'media.transcode',
      taskType: 'video_compress',
      currency: 'CNY',
      estimatedTotal: '1.20',
      recommendedBudget: '2.00',
      balanceEnough: true,
      billingMode: 'prepaid',
      fields: { estimatedTotal: 'estimated_total' },
      intent: INTENT,
    })
    expect(Object.keys(view)).not.toContain('quoteId')
    expect(server.requests).toMatchObject([{ method: 'POST', url: '/api/v8/economy/estimate', body: '{"spec":{"task_type":"video_compress"}}' }])
  })

  it('refuses a capability the platform has no task type for', async () => {
    const { capability, server } = await boot([{ status: 200, json: ESTIMATE }])
    expect(await capability.estimate('accelerator.gpu', INTENT))
      .toMatchObject({ state: 'unavailable', failure: 'not-in-catalog', httpStatus: null })
    expect(server.requests).toEqual([])
  })

  it('refuses an intent outside the card subset before any request', async () => {
    const { capability, server } = await boot([{ status: 200, json: ESTIMATE }])
    expect(await capability.estimate('media.transcode', { goal: 'x'.repeat(2001), budget: null }))
      .toMatchObject({ state: 'unavailable', failure: 'invalid-input' })
    expect(await capability.estimate('media.transcode', { goal: 'g', account_id: 'someone' } as never))
      .toMatchObject({ state: 'unavailable', failure: 'invalid-input' })
    expect(server.requests).toEqual([])
  })

  it('reports an estimate for another task type as invalid-response', async () => {
    const { capability } = await boot([{ status: 200, json: { ...ESTIMATE, task_type: 'video_info' } }])
    expect(await capability.estimate('media.transcode', INTENT))
      .toMatchObject({ state: 'unavailable', failure: 'invalid-response', httpStatus: 200 })
  })
})

describe('bounds and lifetime', () => {
  it('reports busy instead of queueing past the pending bound', async () => {
    const server = await origin([{ status: 200, json: CATALOG_RESPONSE }])
    servers.push(server)
    const { capability } = await fixture({ coreOrigin: server.origin, maxPending: 1, timeoutMs: 1000 }, 'account-token', contexts)
    const views = await Promise.all([capability.catalog(), capability.catalog()])
    expect(views.filter(view => view.state === 'catalog-only')).toHaveLength(1)
    expect(views.filter(view => view.state === 'unavailable' && view.failure === 'busy')).toHaveLength(1)
  })

  it('reports closed once the plugin is disposed', async () => {
    const { ctx, capability } = await boot([{ status: 200, json: CATALOG_RESPONSE }])
    await ctx.fiber.dispose()
    contexts.length = 0
    expect(await capability.catalog()).toMatchObject({ state: 'unavailable', failure: 'closed' })
  })
})
