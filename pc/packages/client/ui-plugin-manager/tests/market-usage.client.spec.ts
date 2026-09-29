import { expect, it, vi } from 'vitest'
import { MarketUsageController, type MarketUsageStorage } from '../src/client/market-usage.ts'

function storage() {
  const values = new Map<string, string>()
  return { values, getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }) }
}
function workload(n: number): string { return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` }

it('ranks actual dispatch frequency separately from recency and restores it without task content', async () => {
  const store = storage()
  let time = 1000
  const input = { storage: store, readOwner: async () => 6, clock: () => time++ }
  const usage = new MarketUsageController(input)
  expect(await usage.rankedTaskTypes()).toEqual({ frequent: [], recent: [] })
  await usage.recordDispatch('legal_scan_v1', workload(1), 6)
  await usage.recordDispatch('legal_scan_v1', workload(2), 6)
  await usage.recordDispatch('image_generate_v1', workload(3), 6)
  expect(await new MarketUsageController(input).rankedTaskTypes()).toEqual({
    frequent: ['legal_scan_v1'], recent: ['image_generate_v1', 'legal_scan_v1'],
  })
  const saved = JSON.parse([...store.values.values()][0]!) as Record<string, unknown>
  expect(Object.keys(saved).sort()).toEqual(['dispatches', 'entries', 'ownerId', 'version'])
  expect(JSON.stringify(saved)).not.toMatch(/prompt|goal|token|price|name|credential/u)
})

it('deduplicates repeated and concurrent workload callbacks across controller reloads', async () => {
  const store = storage()
  const input = { storage: store, readOwner: async () => 6, clock: () => 1000 }
  const usage = new MarketUsageController(input)
  await Promise.all([usage.recordDispatch('text_count_v1', workload(1), 6),
    usage.recordDispatch('text_count_v1', workload(1), 6),
    usage.recordDispatch('other_task', workload(1), 6)])
  await new MarketUsageController(input).recordDispatch('text_count_v1', workload(1), 6)
  expect(await usage.rankedTaskTypes()).toEqual({ frequent: [], recent: ['text_count_v1'] })
  expect(store.setItem).toHaveBeenCalledOnce()
  await usage.recordDispatch('text_count_v1', workload(2), 6)
  expect((await usage.rankedTaskTypes()).frequent).toEqual(['text_count_v1'])
})

it('keeps account histories separate and ignores old-account receipts after logout or switching', async () => {
  const store = storage()
  let owner: number | null = 6
  const usage = new MarketUsageController({ storage: store, readOwner: async () => owner, clock: () => 1000 })
  await usage.recordDispatch('author_task', workload(1), 6)
  owner = null
  expect(await usage.rankedTaskTypes()).toEqual({ frequent: [], recent: [] })
  await usage.recordDispatch('author_task', workload(2), 6)
  owner = 7
  expect(await usage.rankedTaskTypes()).toEqual({ frequent: [], recent: [] })
  await usage.recordDispatch('author_task', workload(2), 6)
  await usage.recordDispatch('buyer_task', workload(3), 7)
  expect((await usage.rankedTaskTypes()).recent).toEqual(['buyer_task'])
  owner = 6
  expect(await usage.rankedTaskTypes()).toEqual({ frequent: [], recent: ['author_task'] })
  expect(store.values.size).toBe(2)
})

it('contains account and storage failures and never falls back to the last successful account', async () => {
  const store = storage()
  const readOwner = vi.fn<() => Promise<number | null>>().mockResolvedValue(6)
  const usage = new MarketUsageController({ storage: store, readOwner, clock: () => 1000 })
  await usage.recordDispatch('text_count_v1', workload(1), 6)
  readOwner.mockRejectedValue(new Error('RPC unavailable'))
  expect(await usage.rankedTaskTypes()).toEqual({ frequent: [], recent: [] })
  await expect(usage.recordDispatch('text_count_v1', workload(2), 6)).resolves.toBeUndefined()
  readOwner.mockResolvedValue(6)
  store.getItem.mockImplementation(() => { throw new Error('storage blocked') })
  expect(await usage.rankedTaskTypes()).toEqual({ frequent: [], recent: [] })
  await expect(usage.recordDispatch('text_count_v1', workload(2), 6)).resolves.toBeUndefined()
  store.getItem.mockImplementation(key => store.values.get(key) ?? null)
  store.setItem.mockImplementation(() => { throw new Error('quota exceeded') })
  await expect(usage.recordDispatch('text_count_v1', workload(2), 6)).resolves.toBeUndefined()
  expect((await usage.rankedTaskTypes()).frequent).toEqual([])
  expect((await new MarketUsageController({ readOwner }).rankedTaskTypes()).recent).toEqual([])
})

it('ignores malformed, foreign-account or expanded preference records', async () => {
  const store = storage()
  const usage = new MarketUsageController({ storage: store, readOwner: async () => 6, clock: () => 1000 })
  await usage.recordDispatch('text_count_v1', workload(1), 6)
  const [key, raw] = [...store.values][0]!
  for (const replacement of ['{', JSON.stringify({ ...JSON.parse(raw), ownerId: 7 }),
    JSON.stringify({ ...JSON.parse(raw), prompt: 'must not become history' }), ' '.repeat(65537)]) {
    store.values.set(key, replacement)
    expect(await usage.rankedTaskTypes()).toEqual({ frequent: [], recent: [] })
  }
  store.values.set(key, raw)
  await usage.recordDispatch('not a task', workload(2), 6)
  await usage.recordDispatch('text_count_v1', 'unknown', 6)
  expect(store.setItem).toHaveBeenCalledOnce()
})

it('bounds saved identifiers and task history while retaining recent dispatch deduplication', async () => {
  const store = storage()
  let time = 1000
  const usage = new MarketUsageController({ storage: store, readOwner: async () => 6, clock: () => time++ })
  for (let i = 1; i <= 300; i++) await usage.recordDispatch(`task_${i}`, workload(i), 6)
  const ranking = await usage.rankedTaskTypes()
  expect(ranking.recent).toHaveLength(64)
  expect(ranking.recent[0]).toBe('task_300')
  expect(ranking.recent).not.toContain('task_1')
  const raw = [...store.values.values()][0]!
  expect(new TextEncoder().encode(raw).length).toBeLessThan(65536)
  const saved = JSON.parse(raw) as { dispatches: unknown[] }
  expect(saved.dispatches).toHaveLength(256)
  await usage.recordDispatch('task_300', workload(300), 6)
  expect((await usage.rankedTaskTypes()).frequent).toEqual([])
})

it('does not turn a failed preference write into a lost later dispatch', async () => {
  const store = storage()
  const broken: MarketUsageStorage = { getItem: store.getItem, setItem: vi.fn()
    .mockImplementationOnce(() => { throw new Error('blocked') }).mockImplementation(store.setItem) }
  const usage = new MarketUsageController({ storage: broken, readOwner: async () => 6 })
  await usage.recordDispatch('text_count_v1', workload(1), 6)
  await usage.recordDispatch('image_generate_v1', workload(2), 6)
  expect((await usage.rankedTaskTypes()).recent).toEqual(['image_generate_v1'])
})
