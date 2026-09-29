/** Fixed-loopback ComfyUI /prompt -> /history/{id} -> /view adapter for one private sample. */
import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { ComputeError } from './errors.ts'
import { inspectPrivateComfyPng } from './comfy-png.ts'
import type { ComputeOutputReference } from './executor.ts'

const MAX_JSON_BYTES = 512 * 1024
const MAX_IMAGE_BYTES = 16 * 1024 * 1024
const REQUEST_TIMEOUT_MS = 30_000
const ID = /^[0-9a-f-]{36}$/u
const FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}\.png$/u
const SUBFOLDER = /^(?:[A-Za-z0-9_-][A-Za-z0-9._-]{0,63})(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}){0,3}$/u

export type ImageReference = { filename: string; subfolder: string; type: 'output' }
export type ComfyImageHistory = { status: 'pending' } | { status: 'failed' }
  | { status: 'completed'; image: ImageReference }

function unavailable(): ComputeError { return new ComputeError('COMPUTE_COMFY_BACKEND_UNAVAILABLE', 503) }
function unsafe(): ComputeError { return new ComputeError('COMPUTE_COMFY_BACKEND_INVALID', 422) }
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

/** Keep all requests on one validated literal IPv4 loopback address. */
export class ComfyImageBackend {
  readonly origin: string

  constructor(port: number, private readonly fetcher: typeof fetch = fetch,
    private readonly pollMs = 500, private readonly maxWaitMs = 600_000,
    private readonly supportsIdScopedCancel = false) {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw unsafe()
    if (!Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 5000
      || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 600_000) throw unsafe()
    this.origin = `http://127.0.0.1:${port}`
  }

  private async request(path: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    signal.throwIfAborted()
    try {
      return await this.fetcher(`${this.origin}${path}`, { ...init, redirect: 'manual', cache: 'no-store',
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) })
    } catch { throw unavailable() }
  }

  private async json(response: Response): Promise<unknown> {
    if (!response.headers.get('content-type')?.toLowerCase().includes('json')
      || Number(response.headers.get('content-length')) > MAX_JSON_BYTES || !response.body) throw unsafe()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        total += part.value.byteLength
        if (total > MAX_JSON_BYTES) throw unsafe()
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    try { return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks))) as unknown }
    catch { throw unsafe() }
  }

  /** No automatic retry: even a lost response may represent an accepted GPU job. */
  async submit(graph: unknown, promptId: string, clientId: string, signal: AbortSignal): Promise<void> {
    if (!ID.test(promptId) || !ID.test(clientId)) throw unsafe()
    const body = JSON.stringify({ prompt: graph, prompt_id: promptId, client_id: clientId })
    if (Buffer.byteLength(body) > 256 * 1024) throw unsafe()
    const response = await this.request('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body }, signal)
    if (response.status === 400) throw new ComputeError('COMPUTE_COMFY_PROMPT_REJECTED', 422)
    if (response.status !== 200) throw unavailable()
    const data = object(await this.json(response))
    const errors = object(data?.node_errors)
    if (data?.prompt_id !== promptId || data.error || (errors !== null && Object.keys(errors).length > 0)) throw unavailable()
  }

  /** Inspect exactly one prompt without submitting or waiting; suitable for crash reconciliation. */
  async inspectHistory(promptId: string, outputNodeId: string, signal: AbortSignal): Promise<ComfyImageHistory> {
    if (!ID.test(promptId) || !/^[0-9]{1,12}$/u.test(outputNodeId)) throw unsafe()
    const response = await this.request(`/history/${promptId}`, { method: 'GET' }, signal)
    if (response.status === 404) return { status: 'pending' }
    if (response.status !== 200) throw unavailable()
    const data = object(await this.json(response))
    const history = object(data?.[promptId])
    if (history === null) return { status: 'pending' }
    const status = object(history.status)
    if (status?.status_str === 'error') return { status: 'failed' }
    if (status?.status_str !== 'success') return { status: 'pending' }
    const output = object(object(history.outputs)?.[outputNodeId])
    const images = output?.images
    if (!Array.isArray(images) || images.length !== 1) throw unsafe()
    const image = object(images[0])
    if (image === null || typeof image.filename !== 'string' || !FILE.test(image.filename)
      || typeof image.subfolder !== 'string'
      || (image.subfolder !== '' && !SUBFOLDER.test(image.subfolder))
      || image.type !== 'output') throw unsafe()
    return { status: 'completed', image: { filename: image.filename, subfolder: image.subfolder, type: 'output' } }
  }

  /** Poll only this prompt ID, never global history; fail closed on non-success. */
  async waitForImage(promptId: string, outputNodeId: string, signal: AbortSignal): Promise<ImageReference> {
    const started = Date.now()
    while (Date.now() - started < this.maxWaitMs) {
      signal.throwIfAborted()
      const history = await this.inspectHistory(promptId, outputNodeId, signal)
      if (history.status === 'failed') throw new ComputeError('COMPUTE_COMFY_EXECUTION_FAILED', 422)
      if (history.status === 'completed') return history.image
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new ComputeError('COMPUTE_COMFY_CANCELLED', 499)) }
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, this.pollMs)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    }
    throw new ComputeError('COMPUTE_COMFY_WAIT_TIMEOUT', 504)
  }

  /** Stream bounded bytes from a history-derived reference, then verify complete PNG integrity. */
  async download(image: ImageReference, workspacePath: string, signal: AbortSignal): Promise<{
    output: ComputeOutputReference
    width: number
    height: number
  }> {
    if (!FILE.test(image.filename) || (image.subfolder !== '' && !SUBFOLDER.test(image.subfolder))) throw unsafe()
    const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder, type: image.type })
    const response = await this.request(`/view?${query}`, { method: 'GET' }, signal)
    if (response.status !== 200 || !response.headers.get('content-type')?.toLowerCase().startsWith('image/png')
      || Number(response.headers.get('content-length')) > MAX_IMAGE_BYTES || !response.body) throw unsafe()
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      for (;;) {
        signal.throwIfAborted()
        const part = await reader.read()
        if (part.done) break
        total += part.value.byteLength
        if (total > MAX_IMAGE_BYTES) throw new ComputeError('COMPUTE_OUTPUT_LIMIT_EXCEEDED', 413)
        chunks.push(part.value)
      }
    } finally { reader.releaseLock() }
    const bytes = Buffer.concat(chunks)
    const dimensions = inspectPrivateComfyPng(bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    const path = join(workspacePath, 'sample.png')
    const file = await open(path, 'wx', 0o600)
    try { await file.writeFile(bytes) } finally { await file.close() }
    // The shared verifier canonicalizes its workspace root before resolving output paths.
    // A relative path also survives macOS's /var -> /private/var realpath alias.
    return { output: { name: 'sample.png', path: 'sample.png', bytes: bytes.length, sha256 }, ...dimensions }
  }

  /** Never call global /interrupt; only a version-proven, ID-scoped cancellation. */
  async cancelById(promptId: string): Promise<'requested' | 'unsupported' | 'unknown'> {
    if (!ID.test(promptId)) throw unsafe()
    if (!this.supportsIdScopedCancel) return 'unsupported'
    try {
      const response = await this.request(`/api/jobs/${promptId}/cancel`, { method: 'POST' }, AbortSignal.timeout(3000))
      if (response.status === 404) return 'unsupported'
      if (response.status !== 200) return 'unknown'
      const data = object(await this.json(response))
      return data?.cancelled === true ? 'requested' : 'unknown'
    } catch { return 'unknown' }
  }
}
