import { describe, expect, it, vi } from 'vitest'
import { readPlatformOrderReviewSamples, startPlatformOrderReviewSamples } from '../src/order-review-samples-http.ts'

const id = '34b423a1-f56a-470d-9e83-9c7cac11683a'
const receipt = { publication_id: id, status: 'pending', media_evidence_status: 'missing',
  samples: { gif: { status: 'pending' }, mp4: { status: 'pending' } } }

describe('review sample control transport', () => {
  it('starts the exact author publication without carrying any media bytes', async () => {
    const call = vi.fn(async (_url: URL, _init: RequestInit) => Response.json(receipt))
    await expect(startPlatformOrderReviewSamples({ origin: 'https://qianshousuanli.com',
      token: 'author-jwt', publicationId: id, fetch: call as typeof fetch }))
      .resolves.toMatchObject({ publicationId: id, status: 'pending', mediaEvidenceStatus: 'missing' })
    expect(call).toHaveBeenCalledTimes(1)
    const [url, init] = call.mock.calls[0]!
    expect(url.href).toBe(`https://qianshousuanli.com/api/v8/task-adapter-publications/${id}/review-samples/start`)
    expect(init).toMatchObject({ method: 'POST', body: '{}', redirect: 'error', credentials: 'omit',
      headers: { authorization: 'Bearer author-jwt' } })
  })

  it('reads state without creating work, and rejects another publication receipt', async () => {
    const call = vi.fn(async () => Response.json({ ...receipt, publication_id: 'ee000000-0000-4000-8000-000000000000' }))
    await expect(readPlatformOrderReviewSamples({ origin: 'https://qianshousuanli.com',
      token: 'author-jwt', publicationId: id, fetch: call as typeof fetch }))
      .rejects.toMatchObject({ code: 'order-review-samples-unavailable' })
    expect(call.mock.calls).toHaveLength(1)
  })

  it('keeps missing source and offline review service separate from success', async () => {
    const conflict = vi.fn(async () => new Response(null, { status: 409 }))
    await expect(startPlatformOrderReviewSamples({ origin: 'https://qianshousuanli.com',
      token: 'author-jwt', publicationId: id, fetch: conflict as typeof fetch }))
      .rejects.toMatchObject({ code: 'order-review-samples-not-ready' })
    const unavailable = vi.fn(async () => new Response(null, { status: 503 }))
    await expect(startPlatformOrderReviewSamples({ origin: 'https://qianshousuanli.com',
      token: 'author-jwt', publicationId: id, fetch: unavailable as typeof fetch }))
      .rejects.toMatchObject({ code: 'order-review-samples-unavailable' })
  })
})
