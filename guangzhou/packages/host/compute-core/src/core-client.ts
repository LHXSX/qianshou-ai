/** Authenticated core reads and the observed developer-task create POST. */
import type { BrandedNumber } from '@deepseek-ai/dsh-brand'
import { ComputeError } from './errors.ts'
import {
  DEVELOPER_TASK_CREATE_PATH,
  type DeveloperTaskCreateBody,
  type DeveloperTaskType,
} from './developer-task.ts'
import { ComputeCapabilityId, ComputeWorkloadId, type ComputeCapability, type ComputeWorkloadSummary } from './protocol.ts'

/** Core account identity admitted from the authenticated me response. */
export type CoreAccountId = BrandedNumber<'qianshou-core-account-id'>

/** Host-side account display fields, without tokens, email, or financial records. */
export interface CoreAccountIdentity {
  accountId: CoreAccountId
  username: string
  role: string
  status: string
}

/** Deployment-selected origin and complete-response bounds. */
export interface CoreClientConfig {
  baseUrl: string
  timeoutMs: number
  maxResponseBytes: number
}

/**
 * Host credential lookup; return a raw access token or authorized API key, never refresh.
 * A Promise is allowed so a logged-in account session can hydrate or refresh before the request.
 */
export type CoreTokenProvider = () => string | undefined | Promise<string | undefined>

function isTokenPromise(value: string | undefined | Promise<string | undefined>): value is Promise<string | undefined> {
  return typeof value === 'object' && value !== null && typeof value.then === 'function'
}

/** Reject when the caller aborts while a credential Promise is still pending. */
async function tokenOrAbort(provided: Promise<string | undefined>, signal?: AbortSignal): Promise<string | undefined> {
  if (signal === undefined) return await provided
  if (signal.aborted) throw new ComputeError('CORE_REQUEST_ABORTED', 499)
  return await new Promise<string | undefined>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new ComputeError('CORE_REQUEST_ABORTED', 499))
    }
    signal.addEventListener('abort', onAbort)
    provided.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function invalidResponse(): never {
  throw new ComputeError('CORE_INVALID_RESPONSE', 502)
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidResponse()
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    return invalidResponse()
  }
  return value
}

function originFor(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new ComputeError('CORE_INVALID_ORIGIN') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/'
  ) throw new ComputeError('CORE_INVALID_ORIGIN')
  return url
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) throw new ComputeError('CORE_RESPONSE_TOO_LARGE', 502)
  if (!response.body) return invalidResponse()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new ComputeError('CORE_RESPONSE_TOO_LARGE', 502)
      chunks.push(decoder.decode(chunk.value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } finally {
    reader.releaseLock()
  }
  try { return JSON.parse(chunks.join('')) as unknown } catch { return invalidResponse() }
}

/** Core identity, advertised capabilities, sanitized task progress, and developer-task create. */
export class QianshouCoreClient {
  private readonly origin: URL
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly active = new Map<AbortController, Promise<unknown>>()
  private closed = false

  /** Create a client without making requests or reading credential files.
   * @param config - HTTPS origin, timeout, and response byte ceiling; loopback HTTP supports fixtures.
   * @param tokenProvider - Host-owned raw access-token/API-key lookup.
   * @param fetchImpl - Fetch implementation; defaults to the host implementation.
   */
  constructor(
    config: CoreClientConfig,
    private readonly tokenProvider: CoreTokenProvider,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.origin = originFor(config.baseUrl)
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647) {
      throw new ComputeError('CORE_INVALID_TIMEOUT')
    }
    if (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1) {
      throw new ComputeError('CORE_INVALID_RESPONSE_LIMIT')
    }
    this.timeoutMs = config.timeoutMs
    this.maxResponseBytes = config.maxResponseBytes
  }

  private async request(path: string, callerSignal?: AbortSignal, body?: unknown): Promise<unknown> {
    if (this.closed) throw new ComputeError('CORE_CLIENT_CLOSED', 503)
    if (callerSignal?.aborted) throw new ComputeError('CORE_REQUEST_ABORTED', 499)
    let token: string | undefined
    try {
      const provided = this.tokenProvider()
      token = isTokenPromise(provided) ? await tokenOrAbort(provided, callerSignal) : provided
    } catch (error) {
      if (error instanceof ComputeError) throw error
      throw new ComputeError('CORE_CREDENTIALS_UNAVAILABLE', 503)
    }
    if (this.closed) throw new ComputeError('CORE_CLIENT_CLOSED', 503)
    if (callerSignal?.aborted) throw new ComputeError('CORE_REQUEST_ABORTED', 499)
    if (!token) throw new ComputeError('CORE_CREDENTIALS_MISSING', 503)
    if (/\s/u.test(token)) throw new ComputeError('CORE_CREDENTIALS_INVALID', 503)

    const controller = new AbortController()
    const abort = () =>{  controller.abort(new ComputeError('CORE_REQUEST_ABORTED', 499)) }
    callerSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () =>{  controller.abort(new ComputeError('CORE_REQUEST_TIMEOUT', 504)) },
      this.timeoutMs,
    )
    const post = body !== undefined
    const headers: Record<string, string> = { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    if (post) headers['Content-Type'] = 'application/json'
    const operation = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted()
        const response = await this.fetchImpl(new URL(path, this.origin), {
          method: post ? 'POST' : 'GET',
          headers,
          ...(post ? { body: JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) {
          const localStatus = [401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502
          throw new ComputeError(`CORE_HTTP_${response.status}`, localStatus)
        }
        return await readJson(response, this.maxResponseBytes)
      } catch (error) {
        if (error instanceof ComputeError) throw error
        if (controller.signal.aborted && controller.signal.reason instanceof ComputeError) {
          throw controller.signal.reason
        }
        throw new ComputeError('CORE_UNAVAILABLE', 502)
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', abort)
        controller.abort()
        this.active.delete(controller)
      }
    })
    this.active.set(controller, operation)
    return operation
  }

  /** Read only account display fields from the authenticated account.
   * @param signal - Optional caller cancellation.
   * @returns Account identity without credentials or unrelated profile fields.
   */
  async getIdentity(signal?: AbortSignal): Promise<CoreAccountIdentity> {
    const body = object(await this.request('/api/v8/auth/me', signal))
    if (body.ok !== true) return invalidResponse()
    const account = object(body.account)
    if (typeof account.id !== 'number' || !Number.isSafeInteger(account.id) || account.id < 1) return invalidResponse()
    return {
      accountId: account.id as CoreAccountId,
      username: text(account.username, 255),
      role: text(account.role, 64),
      status: text(account.status, 64),
    }
  }

  /** Read advertised developer tasks. Available means requestable in the catalogue, not online nodes.
   * @param signal - Optional caller cancellation.
   * @returns Capability display fields with no fabricated node count, version, or price.
   */
  async getCapabilities(signal?: AbortSignal): Promise<ComputeCapability[]> {
    const body = object(await this.request('/api/v8/developer/task-types', signal))
    if (body.ok !== true || !Array.isArray(body.items)) return invalidResponse()
    return body.items.map((value) => {
      const item = object(value)
      const id = text(item.task_type, 128)
      if (typeof item.description !== 'string' || item.description.length > 8_000) return invalidResponse()
      return {
        id: ComputeCapabilityId(id),
        name: id,
        description: item.description,
        delivery: 'remote',
        available: true,
      }
    })
  }

  /** Read a task's progress while discarding task inputs and result contents.
   * @param id - Core-issued workload identity; never interpreted as a path.
   * @param signal - Optional caller cancellation.
   * @returns Progress and result visibility for exactly the requested workload.
   */
  async getWorkload(id: string, signal?: AbortSignal): Promise<ComputeWorkloadSummary> {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(id) || id === '.' || id === '..') {
      throw new ComputeError('CORE_INVALID_WORKLOAD_ID')
    }
    const item = object(await this.request('/api/v8/workloads/' + encodeURIComponent(id), signal))
    if (item.id !== id) return invalidResponse()
    const status = text(item.status, 64)
    const progress = item.progress
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) return invalidResponse()
    if (item.result !== null) object(item.result)
    return {
      id: ComputeWorkloadId(id),
      status,
      progress,
      resultAvailable: status === 'DONE' && item.result !== null,
    }
  }

  /** Read developer-task input kinds used to build a legal create body.
   * @param signal - Optional caller cancellation.
   * @returns Catalogue rows with accepted input kinds; available display fields stay on {@link getCapabilities}.
   */
  async getDeveloperTaskTypes(signal?: AbortSignal): Promise<DeveloperTaskType[]> {
    const body = object(await this.request('/api/v8/developer/task-types', signal))
    if (body.ok !== true || !Array.isArray(body.items)) return invalidResponse()
    return body.items.map((value) => {
      const item = object(value)
      const taskType = text(item.task_type, 128)
      if (!Array.isArray(item.accepted_input_kinds) || typeof item.default_input_kind !== 'string') return invalidResponse()
      const acceptedInputKinds = item.accepted_input_kinds.map((kind) => text(kind, 30))
      const defaultInputKind = text(item.default_input_kind, 30)
      if (acceptedInputKinds.length < 1) return invalidResponse()
      return { taskType, acceptedInputKinds, defaultInputKind }
    })
  }

  /** Create a developer task through the idempotent observed route. Never POSTs `/api/v8/workloads`.
   * @param body - Canonical `DeveloperTaskCreateIn` JSON, including `idempotency_key`.
   * @param signal - Optional caller cancellation.
   * @returns The core-issued workload identity and native status from `_task_status_payload`.
   */
  async createDeveloperTask(body: DeveloperTaskCreateBody, signal?: AbortSignal): Promise<ComputeWorkloadSummary> {
    const item = object(await this.request(DEVELOPER_TASK_CREATE_PATH, signal, body))
    if (item.ok !== true) return invalidResponse()
    const id = text(item.id, 128)
    if (item.task_id !== id || item.workload_id !== id || !/^[A-Za-z0-9._-]{1,128}$/u.test(id) || id === '.' || id === '..') {
      return invalidResponse()
    }
    const status = text(item.status, 64)
    const progress = item.progress
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) return invalidResponse()
    return {
      id: ComputeWorkloadId(id),
      status,
      progress,
      resultAvailable: status === 'DONE',
    }
  }

  /** Abort owned requests and wait for transport cleanup; a closed client cannot be reused.
   * @returns Once every request active at close has settled.
   */
  async close(): Promise<void> {
    this.closed = true
    const operations = [...this.active.values()]
    for (const controller of this.active.keys()) controller.abort(new ComputeError('CORE_CLIENT_CLOSED', 503))
    await Promise.allSettled(operations)
  }
}
