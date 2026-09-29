import { expect, it, vi } from 'vitest'
import { createVideoWorkflowDraftTransport } from '../src/client/video-workflow-draft-transport.ts'

const saved = { id: 'video_draft_123', displayName: '商品短视频', state: 'private-draft',
  graphSha256: 'a'.repeat(64), installable: false, dispatchable: false }

it('saves only to the authenticated local Host route and reads bounded private receipts', async () => {
  const fetcher = vi.fn(async (_url: URL, options: RequestInit) => Response.json(options.method === 'GET' ? [saved] : saved))
  const transport = createVideoWorkflowDraftTransport('http://127.0.0.1:19387/', fetcher as typeof fetch)
  expect(await transport.list()).toEqual([saved])
  const request = { displayName: saved.displayName, template: 'text-to-video' as const,
    graph: { '1': { class_type: 'SaveVideo', inputs: { format: 'mp4' } } },
    mapping: { prompt: { nodeId: '1', field: 'prompt' }, outputNodeId: '1' } }
  expect(await transport.save(request)).toEqual(saved)
  expect(fetcher.mock.calls[1]?.[0].pathname).toBe('/api/qianshou/compute/video-workflow-drafts')
  expect(fetcher.mock.calls[1]?.[1].credentials).toBe('same-origin')
  const body = fetcher.mock.calls[1]?.[1].body
  expect(typeof body).toBe('string')
  expect(JSON.parse(body as string)).toEqual(request)
})

it('does not display a receipt that claims publication or order intake', async () => {
  const fetcher = vi.fn(async () => Response.json([{ ...saved, dispatchable: true }]))
  await expect(createVideoWorkflowDraftTransport('http://localhost/', fetcher as typeof fetch).list())
    .rejects.toThrow('video-workflow-draft-receipt-invalid')
})
