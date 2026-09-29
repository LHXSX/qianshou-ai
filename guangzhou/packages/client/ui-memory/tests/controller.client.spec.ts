import { describe, expect, it, vi } from 'vitest'
import { MemoryController } from '../src/client/controller.ts'
import type { MemoryDirectory, MemoryEntry } from '../src/client/contracts.ts'

const entry: MemoryEntry = {
  id: 'one', title: '实际资料', content: '保留原文', kind: 'knowledge', scope: 'personal', workspace: null,
  status: 'active', source: 'notes.md', evidence: '', revision: 3, createdAt: 100, updatedAt: 200,
  expiresAt: null, contentBytes: 12, snippet: '保留原文',
}
const directory: MemoryDirectory = {
  items: [entry], total: 1, stats: { temporary: 0, permanent: 0, knowledge: 1, experience: 0, candidates: 0 },
  storage: 'sqlite', search: 'keyword',
}

describe('local memory controller', () => {
  it('uses authenticated real directory results and explicit paging filters', async () => {
    const transport = vi.fn(async () => Response.json(directory))
    const c = new MemoryController(transport)
    c.filter({ query: '原文', workspace: '/work/project', kind: 'knowledge', offset: 50 })
    await vi.waitFor(() => { expect(c.store.getSnapshot().loading).toBe(false) })
    expect(c.store.getSnapshot().items).toEqual([entry])
    const call = transport.mock.calls[0] as unknown as [string, RequestInit]
    const url = new URL(call[0], 'http://localhost')
    expect(url.searchParams.get('query')).toBe('原文')
    expect(url.searchParams.get('offset')).toBe('50')
    expect(url.searchParams.get('status')).toBe('active')
    expect(call[1].credentials).toBe('same-origin')
    c.dispose()
  })

  it('ignores an older search response after filters changed', async () => {
    const pending: Array<(response: Response) => void> = []
    const c = new MemoryController(vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve) })))
    const first = c.refresh()
    c.filter({ status: 'candidate' })
    pending[1]?.(Response.json({ ...directory, items: [], total: 0 }))
    await vi.waitFor(() => { expect(c.store.getSnapshot().loading).toBe(false) })
    pending[0]?.(Response.json(directory))
    await first
    expect(c.store.getSnapshot().items).toEqual([])
    expect(c.store.getSnapshot().filters.status).toBe('candidate')
    c.dispose()
  })

  it('reads exact source and historical revisions and ignores an old selected record', async () => {
    let resolve!: (response: Response) => void
    const c = new MemoryController(vi.fn(() => new Promise<Response>((accept) => { resolve = accept })))
    const pending = c.select('one')
    await c.select(null)
    resolve(Response.json({ entry, revisions: [entry] }))
    await pending
    expect(c.store.getSnapshot().selected).toBeNull()
    c.dispose()
  })

  it('sends explicit revision-fenced actions and refreshes actual records afterward', async () => {
    const calls: Array<[string, RequestInit | undefined]> = []
    const c = new MemoryController(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push([url, init])
      return Response.json(url.includes('?') ? directory : { deleted: true })
    })
    expect(await c.mutate('review', { id: 'one', expectedRevision: 3, action: 'reject' })).toBe(true)
    expect(calls[0]?.[0]).toBe('/api/qianshou/memory/review')
    const body = calls[0]?.[1]?.body
    expect(JSON.parse(typeof body === 'string' ? body : '{}')).toEqual({ id: 'one', expectedRevision: 3, action: 'reject' })
    expect(c.store.getSnapshot()).toMatchObject({ busy: false, error: null, selected: null })
    c.dispose()
  })

  it('preserves conflict errors and refuses overlapping writes', async () => {
    let resolve!: (response: Response) => void
    const transport = vi.fn(() => new Promise<Response>((accept) => { resolve = accept }))
    const c = new MemoryController(transport)
    const pending = c.mutate('delete', { id: 'one', expectedRevision: 1 })
    expect(await c.mutate('delete', { id: 'one', expectedRevision: 1 })).toBe(false)
    resolve(Response.json({ error: 'MEMORY_REVISION_CONFLICT' }, { status: 409 }))
    expect(await pending).toBe(false)
    expect(transport).toHaveBeenCalledOnce()
    expect(c.store.getSnapshot()).toMatchObject({ busy: false, error: 'MEMORY_REVISION_CONFLICT' })
    c.dispose()
  })

  it('exports Host data without inventing learning receipts and aborts after disposal', async () => {
    const transport = vi.fn(async () => Response.json({ entries: [entry], events: [] }))
    const c = new MemoryController(transport)
    expect(JSON.parse(await c.exportData() ?? '{}')).toEqual({ entries: [entry], events: [] })
    c.dispose()
    await c.refresh()
    expect(transport).toHaveBeenCalledOnce()
  })

  it('binds browser fetch to its global receiver', async () => {
    const original = globalThis.fetch
    globalThis.fetch = async function (this: unknown) {
      expect(this).toBe(globalThis)
      return Response.json(directory)
    }
    const c = new MemoryController()
    try { await c.refresh(); expect(c.store.getSnapshot().error).toBeNull() }
    finally { c.dispose(); globalThis.fetch = original }
  })
})
