import { describe, expect, it, vi } from 'vitest'
import { createTokenStore } from '@deepseek-ai/dsh-client-account'
import { createCommerceReader } from '../src/components/account-commerce.ts'

function client() {
  return {
    tokens: createTokenStore({ cookiesAvailable: false }),
    refresh: vi.fn(async () => false),
  } as unknown as import('@deepseek-ai/dsh-client-account').AccountClient
}

describe('mobile commerce projection', () => {
  it('shows only server supplied quota and plans', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      ok: true,
      tier: { id: 'plus', label: '高级版' },
      credit: { remainingSp: 1200, purchasableSp: 3400 },
      plans: [{ id: 'basic', label: '基础版', monthlyYuan: 39, monthlySp: 3900 }, { id: 'bad' }],
    }))
    const account = client()
    await account.tokens.write({ access_token: 'account-token', refresh_token: null, token_type: 'bearer', expires_in: 3600 })
    const reader = createCommerceReader({ client: account, accountId: () => '7', fetch: fetcher, origin: 'https://app.example.test', timeoutMs: 2000 })
    await expect(reader.status(new AbortController().signal)).resolves.toEqual({
      tierId: 'plus', tierLabel: '高级版', remainingSp: 1200, purchasableSp: 3400, spPerYuanCost: null,
      plans: [{ id: 'basic', label: '基础版', monthlyYuan: 39, monthlySp: 3900 }],
    })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' })
    expect(new Headers(fetcher.mock.calls[0]?.[1]?.headers).get('authorization')).toBe('Bearer account-token')
  })

  it('keeps an unavailable mobile route explicit and never invents a plan', async () => {
    const account = client()
    await account.tokens.write({ access_token: 'account-token', refresh_token: null, token_type: 'bearer', expires_in: 3600 })
    const reader = createCommerceReader({
      client: account, accountId: () => '7', fetch: vi.fn(async () => new Response('', { status: 404 })), origin: 'https://app.example.test', timeoutMs: 2000,
    })
    await expect(reader.status(new AbortController().signal)).rejects.toThrow('COMMERCE_ROUTE_UNAVAILABLE')
  })
})

const quote = { tier: 'basic', monthlyYuan: 39, costSp: 3900 }
const catalog = { ok: true, tier: { id: 'free', label: '免费版' }, credit: { remainingSp: 10, purchasableSp: 5000 },
  prices: { spPerYuanCost: 100 }, plans: [{ id: 'basic', label: '基础版', monthlyYuan: 39, monthlySp: 390 }] }
async function commerceHarness(fetcher: typeof fetch, current: () => string | null = () => '7') {
  const account = client()
  await account.tokens.write({ access_token: 'caller-access', refresh_token: null, token_type: 'bearer', expires_in: 3600 })
  return createCommerceReader({ client: account, accountId: current, fetch: fetcher, origin: 'https://app.example.test', timeoutMs: 2000 })
}
describe('existing Shanghai payment and gateway subscription contracts', () => {
  it('reads configured channels and owner-bound orders without sending a payment write', async () => {
    const calls: { path: string; method: string; authorization: string | null }[] = []
    const reader = await commerceHarness(async (url, init) => {
      const path = requestPath(url)
      calls.push({ path, method: init?.method ?? 'GET', authorization: new Headers(init?.headers).get('authorization') })
      return Response.json(path.endsWith('/channels') ? { items: [{ gateway: 'alipay', mode: 'alipay_page', available: false, reason: '未配置' }] }
        : { ok: true, items: [{ account_id: 7, order_no: 'PAY_1', amount: '12.5000', currency: 'CNY', gateway: 'alipay', status: 'pending' }] })
    })
    const signal = new AbortController().signal
    expect((await reader.channels!(signal))[0]).toMatchObject({ available: false, reason: '未配置' })
    expect((await reader.orders!(signal))[0]).toMatchObject({ orderNo: 'PAY_1', status: 'pending' })
    expect(calls).toEqual([
      { path: '/account-api/api/v8/payment/channels', method: 'GET', authorization: 'Bearer caller-access' },
      { path: '/account-api/api/v8/payment/orders', method: 'GET', authorization: 'Bearer caller-access' },
    ])
  })
  it('rejects another account order instead of projecting it into the current account', async () => {
    const reader = await commerceHarness(async () => Response.json({ items: [{ account_id: 8, order_no: 'PAY_OTHER', amount: '1', currency: 'CNY', gateway: 'alipay', status: 'paid' }] }))
    await expect(reader.orders!(new AbortController().signal)).rejects.toThrow('COMMERCE_RESPONSE_INVALID')
  })
  it('rechecks the server quote and uses the existing purchase route with the caller bearer', async () => {
    const calls: { path: string; body: Record<string, unknown>; authorization: string | null }[] = []
    const reader = await commerceHarness(async (url, init) => {
      const path = requestPath(url)
      calls.push({ path, body: requestBody(init), authorization: new Headers(init?.headers).get('authorization') })
      return Response.json(path.endsWith('/status') ? catalog : { ok: true, order: { orderId: 'ORDER_1', sp: 3900 }, subscription: { to: 2000000000000 } })
    })
    await expect(reader.subscribe!(quote, new AbortController().signal)).resolves.toEqual({ orderId: 'ORDER_1', spentSp: 3900, to: 2000000000000 })
    expect(calls[1]).toMatchObject({ path: '/api/qianshou/ai/subscription/purchase', authorization: 'Bearer caller-access', body: { kind: 'subscribe', tier: 'basic', months: 1, idempotencyKey: expect.any(String) as unknown } })
  })
  it('makes no purchase after a price change or insufficient balance', async () => {
    for (const data of [{ ...catalog, prices: { spPerYuanCost: 200 } }, { ...catalog, credit: { purchasableSp: 10 } }]) {
      const fetcher = vi.fn<typeof fetch>(async () => Response.json(data))
      const reader = await commerceHarness(fetcher)
      await expect(reader.subscribe!(quote, new AbortController().signal)).rejects.toThrow()
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(requestPath(fetcher.mock.calls[0]?.[0])).toBe('/api/qianshou/ai/status')
    }
  })
  it('reuses the same purchase key after response loss, even if the first request consumed the balance', async () => {
    const keys: unknown[] = []; let calls = 0; let reads = 0
    const reader = await commerceHarness(async (url, init) => {
      if (requestPath(url).endsWith('/status')) { reads++; return Response.json(catalog) }
      keys.push(requestBody(init).idempotencyKey); calls++
      if (calls === 1) throw new Error('response lost after server commit')
      return Response.json({ ok: true, replayed: true, order: { orderId: 'ORDER_ONCE', sp: 3900 }, subscription: { to: null } })
    })
    const signal = new AbortController().signal
    await expect(reader.subscribe!(quote, signal)).rejects.toThrow('response lost')
    await expect(reader.subscribe!(quote, signal)).resolves.toMatchObject({ orderId: 'ORDER_ONCE' })
    expect(keys).toHaveLength(2); expect(keys[0]).toBe(keys[1]); expect(reads).toBe(1)
  })
  it('does not cross identities when a status read finishes after account switching', async () => {
    let identity: string | null = '7'; let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    const fetcher = vi.fn<typeof fetch>(async () => { await pending; return Response.json(catalog) })
    const reader = await commerceHarness(fetcher, () => identity)
    const promise = reader.subscribe!(quote, new AbortController().signal)
    identity = '8'; release()
    await expect(promise).rejects.toThrow('ACCOUNT_CHANGED'); expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

function requestPath(input: Parameters<typeof fetch>[0] | undefined): string {
  if (input === undefined) throw new Error('missing fixture request')
  return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).pathname
}
function requestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('missing fixture body')
  return JSON.parse(init.body) as Record<string, unknown>
}
