/** Account-scoped control requests. Guangzhou owns sample execution and media bytes. */
import { CatalogFailure } from './registry.ts'
import type { OrderReviewSampleStatus } from './types.ts'

const ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const MAX_RESPONSE_BYTES = 32 * 1024
const SAMPLE_STATES = ['pending', 'running', 'verified', 'evidence_deposited', 'blocked'] as const
const EVIDENCE_STATES = ['missing', 'valid', 'invalid'] as const

function endpoint(origin: string, publicationId: string, start: boolean): URL {
  if (!ID.test(publicationId)) throw new CatalogFailure('order-review-samples-invalid')
  let base: URL
  try { base = new URL(origin) } catch { throw new CatalogFailure('order-review-samples-unavailable') }
  const local = base.hostname === '127.0.0.1' || base.hostname === '[::1]'
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || (base.protocol !== 'https:' && !(base.protocol === 'http:' && local))) {
    throw new CatalogFailure('order-review-samples-unavailable')
  }
  return new URL(`/api/v8/task-adapter-publications/${publicationId}/review-samples${start ? '/start' : ''}`, base)
}

async function boundedJson(response: Response): Promise<unknown> {
  if (response.body === null) throw new CatalogFailure('order-review-samples-unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new CatalogFailure('order-review-samples-unavailable')
      chunks.push(next.value)
    }
  } finally {
    try { await reader.cancel() } catch { /* Already closed. */ }
    reader.releaseLock()
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new CatalogFailure('order-review-samples-unavailable') }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

async function request(input: { origin: string; token: string; publicationId: string;
  start: boolean; fetch?: typeof fetch }): Promise<OrderReviewSampleStatus> {
  const url = endpoint(input.origin, input.publicationId, input.start)
  if (!input.token || /[\r\n]/u.test(input.token)) throw new CatalogFailure('order-auth-required')
  let response: Response
  try {
    response = await (input.fetch ?? fetch)(url, {
      method: input.start ? 'POST' : 'GET', redirect: 'error', credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', authorization: `Bearer ${input.token}`,
        ...(input.start ? { 'content-type': 'application/json' } : {}) },
      ...(input.start ? { body: '{}' } : {}),
    })
  } catch { throw new CatalogFailure('order-review-samples-unavailable') }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Error body is not trusted. */ }
    if (response.status === 401 || response.status === 403) throw new CatalogFailure('order-auth-required')
    if (response.status === 404) throw new CatalogFailure('order-platform-route-unavailable')
    if (response.status === 409) throw new CatalogFailure('order-review-samples-not-ready')
    throw new CatalogFailure('order-review-samples-unavailable')
  }
  const row = asRecord(await boundedJson(response))
  const samples = asRecord(row?.samples)
  const gif = asRecord(samples?.gif)
  const mp4 = asRecord(samples?.mp4)
  if (row?.publication_id !== input.publicationId
    || !SAMPLE_STATES.includes(row.status as typeof SAMPLE_STATES[number])
    || !EVIDENCE_STATES.includes(row.media_evidence_status as typeof EVIDENCE_STATES[number])
    || gif === null || mp4 === null
    || typeof gif.status !== 'string' || gif.status.length < 1 || gif.status.length > 64
    || typeof mp4.status !== 'string' || mp4.status.length < 1 || mp4.status.length > 64) {
    throw new CatalogFailure('order-review-samples-unavailable')
  }
  return { publicationId: input.publicationId, status: row.status as OrderReviewSampleStatus['status'],
    mediaEvidenceStatus: row.media_evidence_status as OrderReviewSampleStatus['mediaEvidenceStatus'],
    samples: { gif: { status: gif.status }, mp4: { status: mp4.status } } }
}

/** Idempotently ask Shanghai to issue two zero-budget review leases to Guangzhou. */
export async function startPlatformOrderReviewSamples(input: {
  origin: string; token: string; publicationId: string; fetch?: typeof fetch
}): Promise<OrderReviewSampleStatus> {
  return request({ ...input, start: true })
}

/** Read one exact publication without creating or rerunning a sample. */
export async function readPlatformOrderReviewSamples(input: {
  origin: string; token: string; publicationId: string; fetch?: typeof fetch
}): Promise<OrderReviewSampleStatus> {
  return request({ ...input, start: false })
}
