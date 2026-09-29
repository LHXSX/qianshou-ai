import { describe, expect, it, vi } from 'vitest'
import { managePlatformOrderPublication, parsePublicationLifecycle } from '../src/order-publication-http.ts'
const publicationId = 'dc091b4a-426f-471c-be50-e859aed2e14c'
const input = { origin: 'https://qianshousuanli.com', token: 'fictional-token', publicationId,
  ownerId: 167, action: 'archive' as const, expectedRevision: 0, note: '归档虚构测试' }
const lifecycle = { state: 'withdrawn', archived: true, revision: 1, allowed_actions: ['restore'], blocking_reasons: [] }
const receipt = { publication_id: publicationId, owner_id: 167, name: '虚构测试', status: 'review', lifecycle }
describe('author publication lifecycle transport', () => {
  it('sends exact action/revision without an owner parameter', async () => {
    const send = vi.fn(async (url: RequestInfo | URL, options?: RequestInit) => {
      expect(url).toBeDefined()
      expect(options?.method).toBe('POST')
      return Response.json(receipt)
    })
    const result = await managePlatformOrderPublication({ ...input, fetch: send })
    expect(result.lifecycle.archived).toBe(true)
    const call = send.mock.calls[0]
    if (!call) throw new Error('missing request')
    const [url, options] = call
    if (!(url instanceof URL) || typeof options?.body !== 'string') throw new Error('invalid request')
    expect(url.href).toBe(`https://qianshousuanli.com/api/v8/task-adapter-publications/${publicationId}/lifecycle`)
    expect(JSON.parse(options.body)).toEqual({ action: 'archive', expected_revision: 0, note: input.note })
  })
  it.each([
    { ...receipt, owner_id: 168 }, { ...receipt, publication_id: '00000000-0000-0000-0000-000000000000' },
    { ...receipt, lifecycle: { ...lifecycle, revision: 0 } },
    { ...receipt, lifecycle: { ...lifecycle, archived: false } },
  ])('rejects a changed actor, id, revision or outcome', async (value) => {
    await expect(managePlatformOrderPublication({ ...input, fetch: async () => Response.json(value) })).rejects.toThrow()
  })
  it.each([null, [], { ...lifecycle, allowed_actions: ['approve'] },
    { ...lifecycle, blocking_reasons: ['raw-private-error'] }, { ...lifecycle, revision: 0.5 }])('rejects invented permissions', (value) => {
    expect(() => parsePublicationLifecycle(value)).toThrow()
  })
  it('keeps a conflict response out of the success path', async () => {
    await expect(managePlatformOrderPublication({ ...input, fetch: async () => new Response('private-backend-error', { status: 409 }) }))
      .rejects.toThrow('order-publication-conflict')
  })
})
