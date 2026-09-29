/**
 * Isolated local-model turn over loopback Ollama HTTP.
 *
 * This is not the CEO default route and does not register a picker provider.
 * A missing origin, a missing installed model, or a failed chat maps to
 * `COMPUTE_ISOLATED_SESSION_UNAVAILABLE` and does not open a cloud request.
 */
import { ComputeError, type IsolatedAgentSession } from '@deepseek-ai/dsh-compute-core'
import { NodeContributorError } from './errors.ts'

/** Loopback Ollama origin and optional pinned model id. */
export interface IsolatedOllamaRoute {
  /** Literal loopback HTTP origin, for example `http://127.0.0.1:11434`. */
  readonly origin: string
  /** Optional model id; omitted values use the first installed tag or an inline request field. */
  readonly model?: string
  /** Complete chat timeout in milliseconds. */
  readonly timeoutMs?: number
  /** Maximum bytes admitted from one Ollama JSON response. */
  readonly maxResponseBytes?: number
  /** Injectable fetch for tests. */
  readonly fetch?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 300_000
const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576

/**
 * Drive one isolated turn through Ollama `/api/chat` on loopback HTTP.
 * @param route - Loopback origin and optional pinned model.
 * @returns An isolated agent session for admitted `local_llm_chat` assignments.
 */
export function createIsolatedOllamaSession(route: IsolatedOllamaRoute): IsolatedAgentSession {
  const origin = loopbackOrigin(route.origin)
  const timeoutMs = route.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxResponseBytes = route.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
  const fetchImpl = route.fetch ?? fetch
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
  }
  return {
    async run({ taskType, inlineInput, signal }) {
      if (signal.aborted) throw new ComputeError('COMPUTE_INLINE_SESSION_ABORTED', 499)
      const model = route.model ?? requestedModel(inlineInput) ?? await firstInstalledModel(origin, fetchImpl, signal, timeoutMs, maxResponseBytes)
      if (model === undefined) throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
      const payload = await requestJson(new URL('/api/chat', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          messages: [{ role: 'user', content: `task_type=${taskType}\n\n${inlineInput}` }],
        }),
      }, fetchImpl, signal, timeoutMs, maxResponseBytes)
      const text = assistantText(payload)
      if (text === undefined) throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
      return { text }
    },
  }
}

/**
 * Read a loopback HTTP origin used only for local Ollama.
 * @param value - Configured origin.
 * @returns The origin including a trailing path of `/`.
 */
export function resolveIsolatedOllamaOrigin(value: string | undefined): string | null {
  if (value === undefined) return 'http://127.0.0.1:11434/'
  if (value === '') return null
  return loopbackOrigin(value)
}

function loopbackOrigin(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID') }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash
    || (url.pathname !== '/' && url.pathname !== '')
    || url.protocol !== 'http:' || !local) {
    throw new NodeContributorError('COMPUTE_NODE_CONTRIBUTOR_ISOLATED_ROUTE_INVALID')
  }
  url.pathname = '/'
  return url.origin + '/'
}

function requestedModel(inlineInput: string): string | undefined {
  try {
    const value: unknown = JSON.parse(inlineInput)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    for (const key of ['ollama_model', 'model'] as const) {
      const item = (value as Record<string, unknown>)[key]
      if (typeof item === 'string' && /^[A-Za-z0-9._:/-]{1,256}$/u.test(item)) return item
    }
  } catch {
    // Inline UTF-8 is not required to be JSON; the whole body is the user turn.
  }
  return undefined
}

async function firstInstalledModel(
  origin: string,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<string | undefined> {
  let payload: unknown
  try {
    payload = await requestJson(new URL('/api/tags', origin), { method: 'GET' }, fetchImpl, signal, timeoutMs, maxResponseBytes)
  } catch (error) {
    if (error instanceof ComputeError && error.code === 'COMPUTE_INLINE_SESSION_ABORTED') throw error
    throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
  }
  if (payload === null || typeof payload !== 'object' || !('models' in payload) || !Array.isArray(payload.models)) {
    return undefined
  }
  for (const model of payload.models) {
    if (model === null || typeof model !== 'object' || !('name' in model) || typeof model.name !== 'string') continue
    if (/^[A-Za-z0-9._:/-]{1,256}$/u.test(model.name)) return model.name
  }
  return undefined
}

function assistantText(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object' || !('message' in payload)) return undefined
  const message = payload.message
  if (message === null || typeof message !== 'object' || !('content' in message) || typeof message.content !== 'string') {
    return undefined
  }
  return message.content
}

async function requestJson(
  url: URL,
  init: RequestInit,
  fetchImpl: typeof fetch,
  signal: AbortSignal,
  timeoutMs: number,
  maxResponseBytes: number,
): Promise<unknown> {
  const deadline = AbortSignal.timeout(timeoutMs)
  const combined = AbortSignal.any([signal, deadline])
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    combined.throwIfAborted()
    const response = await fetchImpl(url, { ...init, signal: combined, redirect: 'error', credentials: 'omit' })
    if (!response.ok || !response.body) throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
    reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    for (;;) {
      combined.throwIfAborted()
      const next = await reader.read()
      if (next.done) break
      size += next.value.byteLength
      if (size > maxResponseBytes) throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
      chunks.push(next.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503) }
  } catch (error) {
    if (signal.aborted) throw new ComputeError('COMPUTE_INLINE_SESSION_ABORTED', 499)
    if (error instanceof ComputeError) throw error
    throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
  } finally {
    if (reader) {
      try { await reader.cancel() } catch {
        // Fetch may already have cancelled the reader on abort.
      }
      reader.releaseLock()
    }
  }
}
