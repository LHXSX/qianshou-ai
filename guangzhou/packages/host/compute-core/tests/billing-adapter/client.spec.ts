import { describe, expect, it, vi } from 'vitest'
import { EdgeBillingApi } from '../../src/billing-adapter/client.ts'

const options = { timeoutMs: 1000, maxResponseBytes: 65536, maxRequestBytes: 4096 }
const balance = { ok: true, account_id: 7, balance: '9007199254740993.0001', currency: 'CNY', total_earned: '20.10', total_spent: '3.0000', transaction_count: 3 }
const estimate = { ok: true, task_type: 'word_count', input_kind: 'inline', units: 1, shards: 1, estimated_total: '0.50', recommended_budget: '0.50',
  requested_budget: '', worker_reward_pool: '0.3250', platform_fee: '0.15', risk_pool: '0.00', script_author_fee: '0.0250', currency: 'CNY',
  balance: '2.00', balance_enough: true, billing_mode: 'server_price', note: 'upstream text must not be rendered as trusted product policy' }
const entry = { id: 'ledger-1', type: 'ESCROW_HOLD', amount: '-12.3400', currency: 'CNY', workload_id: 'workload-1', shard_id: null, created_at: '2026-09-15T00:00:00Z', note: 'private business note' }
function setup(body: unknown, provider: () => string | undefined = () => 'fixture-private-token') {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body)))
  const api = new EdgeBillingApi({ ...options, baseUrl: 'https://core.example', tokenProvider: provider, fetch: fetcher })
  return { api, fetcher }
}

describe('native account and budget estimates', () => {
  it('preserves decimal precision and does not present aggregate income as node earnings or credits', async () => {
    const { api, fetcher } = setup({ ...balance, bonus_credits: 'unrelated', credential: 'private' })
    const result = await api.queryBalance()
    expect(result.balance).toBe('9007199254740993.0001')
    expect(result.totalEarned).toBe('20.10')
    expect(result).not.toHaveProperty('nodeEarnings'); expect(result).not.toHaveProperty('bonusCredits')
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://core.example/api/v8/economy/balance')
    expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET'); api.close()
  })
  it('preserves negative holds and zero releases and does not invent page totals', async () => {
    const { api, fetcher } = setup({ ok: true, items: [entry, { ...entry, id: 'ledger-2', type: 'ESCROW_RELEASE', amount: '0.0000' }], limit: 2, offset: 10 })
    const result = await api.queryLedger({ limit: 2, offset: 10 })
    expect(result.items.map(item => item.amount)).toEqual(['-12.3400', '0.0000'])
    expect(result.items[0]).not.toHaveProperty('note'); expect(result).not.toHaveProperty('total')
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://core.example/api/v8/economy/ledger?limit=2&offset=10'); api.close()
  })
  it('sends only native estimate fields and keeps affordability separate from execution permission', async () => {
    const { api, fetcher } = setup(estimate)
    const result = await api.queryEstimate({ name: 'task', spec: { task_type: 'word_count', input_kind: 'inline', inline_input: 'one two' } })
    expect(result).toMatchObject({ authority: 'estimate-only', requestedBudget: null, balanceEnough: true, recommendedBudget: '0.50' })
    expect(result).not.toHaveProperty('authorizationId'); expect(result).not.toHaveProperty('note')
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://core.example/api/v8/economy/estimate')
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ name: 'task', spec: { task_type: 'word_count', input_kind: 'inline', inline_input: 'one two' } })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' }); api.close()
  })
  it('preserves a server-confirmed zero comparison budget separately from absent budget', async () => {
    const { api } = setup({ ...estimate, requested_budget: '0.00', balance_enough: false })
    expect(await api.queryEstimate({ spec: { task_type: 'word_count' }, budget: 0 })).toMatchObject({ requestedBudget: '0.00', balanceEnough: false, authority: 'estimate-only' }); api.close()
  })
  it.each([3.14, 'NaN', '1e9'])('rejects money that is not a native decimal string', async value => {
    const { api } = setup({ ...balance, balance: value }); await expect(api.queryBalance()).rejects.toThrow('BILLING_RESPONSE_INVALID'); api.close()
  })
  it('does not accept an invented envelope or changed task identity in an estimate', async () => {
    const { api } = setup({ ...estimate, task_type: 'shell' }); await expect(api.queryEstimate({ spec: { task_type: 'word_count' } })).rejects.toThrow('BILLING_RESPONSE_INVALID'); api.close()
    const page = setup([entry]); await expect(page.api.queryLedger({ limit: 10, offset: 0 })).rejects.toThrow('BILLING_RESPONSE_INVALID'); page.api.close()
  })
  it('rejects invalid pagination before sending any request', async () => {
    const { api, fetcher } = setup({})
    await expect(api.queryLedger({ limit: 201, offset: 0 })).rejects.toThrow('BILLING_QUERY_INVALID')
    await expect(api.queryLedger({ limit: 1, offset: -1 })).rejects.toThrow('BILLING_QUERY_INVALID')
    expect(fetcher).not.toHaveBeenCalled(); api.close()
  })
  it('requires configured authentication and bounds estimate request bytes before network use', async () => {
    const absent = setup({}, () => undefined); await expect(absent.api.queryBalance()).rejects.toThrow('SUPPLY_AUTH_REQUIRED')
    expect(absent.fetcher).not.toHaveBeenCalled(); absent.api.close()
    const large = setup({}); await expect(large.api.queryEstimate({ spec: { task_type: 'word_count', inline_input: 'x'.repeat(5000) } })).rejects.toThrow('BILLING_REQUEST_TOO_LARGE')
    expect(large.fetcher).not.toHaveBeenCalled(); large.api.close()
  })
  it('close aborts an in-flight account read and rejects later operations', async () => {
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve })
    const api = new EdgeBillingApi({ ...options, baseUrl: 'https://core.example', tokenProvider: () => 'fixture', fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('private upstream detail')), { once: true }); began()
    }) })
    const failure = expect(api.queryBalance()).rejects.toThrow('SUPPLY_ABORTED')
    await started; api.close(); await failure
    await expect(api.queryBalance()).rejects.toThrow('SUPPLY_CLOSED')
  })
})
