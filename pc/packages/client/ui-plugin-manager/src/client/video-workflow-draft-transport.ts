/** Owner-local video design drafts. This carrier never calls Shanghai or starts a GPU job. */
import type { VideoWorkflowDraftReceipt, VideoWorkflowDraftSave, VideoWorkflowDraftTransport } from './video-workflow-authoring.ts'

const HASH = /^[a-f0-9]{64}$/u

function receipt(value: unknown): VideoWorkflowDraftReceipt {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('video-workflow-draft-receipt-invalid')
  const row = value as Record<string, unknown>
  if (typeof row.id !== 'string' || row.id.length < 1 || row.id.length > 128
    || typeof row.displayName !== 'string' || row.displayName.length < 1 || row.displayName.length > 80
    || typeof row.graphSha256 !== 'string' || !HASH.test(row.graphSha256)
    || row.state !== 'private-draft' || row.installable !== false || row.dispatchable !== false) {
    throw new Error('video-workflow-draft-receipt-invalid')
  }
  return { id: row.id, displayName: row.displayName, graphSha256: row.graphSha256,
    state: 'private-draft', installable: false, dispatchable: false }
}

/** Bind private draft operations to the existing authenticated local carrier.
 * @param baseUri - Local Connection origin.
 * @param fetcher - Fetch implementation owned by the client runtime.
 * @returns Carrier that validates private draft receipts.
 */
export function createVideoWorkflowDraftTransport(baseUri: string, fetcher: typeof fetch = fetch): VideoWorkflowDraftTransport {
  const url = new URL('/api/qianshou/compute/video-workflow-drafts', baseUri)
  async function request(method: 'GET' | 'POST', body?: VideoWorkflowDraftSave): Promise<unknown> {
    const response = await fetcher(url, {
      method, credentials: 'same-origin', cache: 'no-store', redirect: 'manual',
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok || response.redirected || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json')) {
      throw new Error('video-workflow-draft-unavailable')
    }
    return response.json() as Promise<unknown>
  }
  return {
    async save(value) { return receipt(await request('POST', value)) },
    async list() {
      const value = await request('GET')
      if (!Array.isArray(value)) throw new Error('video-workflow-draft-list-invalid')
      return value.map(receipt)
    },
  }
}
