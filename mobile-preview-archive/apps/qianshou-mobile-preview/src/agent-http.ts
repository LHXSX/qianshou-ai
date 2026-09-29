/** Authenticated same-origin adapter for account-owned DSH Sessions; no completion endpoint or automatic prompt retry. */
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { MOBILE_AGENT_PREFIX } from '@deepseek-ai/dsh-host-mobile-agent-gateway/protocol'
import type { AgentSessionBinding, AgentSessionTranscript, AgentTurnEndReason, AgentTurnFailure, MobileAgentSessionPort } from './window/mobile-workspace-types.ts'
import { validateVisionImages } from './vision-input.ts'
const row = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
  return value as Record<string, unknown>
}

/** A missing URL, proxy error, or denied request is not proof that a Session disappeared. */
async function missingSession(response: Response): Promise<boolean> {
  if (response.status !== 404 || response.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return false
  try {
    const data = row(await response.json())
    return data['ok'] === false && data['code'] === 'MOBILE_AGENT_SESSION_NOT_FOUND'
  } catch {
    return false
  }
}
const binding = (value: unknown, accountId: string, sessionId?: string): AgentSessionBinding => {
  const data = row(value)
  if (data['accountId'] !== accountId || typeof data['sessionId'] !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(data['sessionId'])
        || (sessionId !== undefined && data['sessionId'] !== sessionId))
    throw new Error('MOBILE_AGENT_RESPONSE_IDENTITY_MISMATCH')
  return { accountId, sessionId: data['sessionId'] as AgentSessionBinding['sessionId'] }
}

function readTranscript(value: unknown, target: AgentSessionBinding): AgentSessionTranscript {
  const data = row(value)
  const owner = binding(data['binding'], target.accountId, target.sessionId)
  if (typeof data['status'] !== 'string' || !['idle', 'running', 'unavailable'].includes(data['status']) || !Array.isArray(data['turns']) || !Array.isArray(data['activity']))
    throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
  const turns = data['turns'].map((value): AgentSessionTranscript['turns'][number] => {
    const turn = row(value)
    if (typeof turn['id'] !== 'string' || typeof turn['text'] !== 'string' || typeof turn['at'] !== 'number' || !Number.isFinite(turn['at'])
      || typeof turn['role'] !== 'string' || !['user', 'assistant'].includes(turn['role']))
      throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
    if (turn['pending'] !== undefined && typeof turn['pending'] !== 'boolean') throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
    return { id: turn['id'], at: turn['at'], text: turn['text'], role: turn['role'] as 'user' | 'assistant', ...(turn['pending'] === true ? { pending: true } : {}) }
  })
  const activity = data['activity'].map((value) => {
    const item = row(value)
    if (typeof item['kind'] !== 'string' || !['tool', 'turn'].includes(item['kind'])
      || typeof item['at'] !== 'number' || !Number.isFinite(item['at'])
      || typeof item['id'] !== 'string' || typeof item['name'] !== 'string' || typeof item['state'] !== 'string' || !['running', 'completed', 'failed', 'cancelled'].includes(item['state']))
      throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
    const endReason = item['endReason']
    const failure = item['failure']
    if (failure !== undefined && (item['kind'] !== 'turn' || item['state'] !== 'failed' || typeof failure !== 'string'
      || !['quota', 'rate-limit', 'authentication'].includes(failure))) throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
    if (endReason !== undefined && (item['kind'] !== 'turn' || typeof endReason !== 'string'
      || !['completed', 'aborted', 'max-tokens', 'error', 'blocked', 'interrupted', 'unknown'].includes(endReason)))
      throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
    return { id: item['id'], kind: item['kind'] as 'tool' | 'turn', name: item['name'], state: item['state'] as 'running' | 'completed' | 'failed' | 'cancelled', ...(endReason === undefined ? {} : { endReason: endReason as AgentTurnEndReason }), ...(failure === undefined ? {} : { failure: failure as AgentTurnFailure }) }
  })
  return { binding: owner, status: data['status'] as AgentSessionTranscript['status'], turns, activity }
}
/**
 * @param options - Memory token supplier and current identity from the shared AccountClient; URL is fixed by this adapter.
 * @returns A transport consumed by the existing window workspace, including restore and cancel.
 */
export function createMobileAgentHttpPort(options: {
  readonly accountId: () => string | null
  readonly access: (signal: AbortSignal) => Promise<string | null>
  readonly fetch: typeof fetch
  readonly timeoutMs: number
}): MobileAgentSessionPort {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new Error('MOBILE_AGENT_HTTP_TIMEOUT_INVALID')
  const post = async (action: string, body: object, accountId: string, signal: AbortSignal): Promise<Record<string, unknown>> => {
    if (options.accountId() !== accountId)
      throw new Error('MOBILE_AGENT_ACCOUNT_CHANGED')
    const token = await options.access(signal)
    signal.throwIfAborted()
    if (!token || options.accountId() !== accountId)
      throw new Error('MOBILE_AGENT_AUTH_REQUIRED')
    const response = await options.fetch(`${MOBILE_AGENT_PREFIX}/${action}`, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]),
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
    })
    if (options.accountId() !== accountId)
      throw new Error('MOBILE_AGENT_ACCOUNT_CHANGED')
    if (await missingSession(response)) throw new Error('MOBILE_AGENT_SESSION_NOT_FOUND')
    if (!response.ok) {
      // Image admission errors are safe enums, never upstream diagnostic text. Authentication wins.
      if (action === 'submit-images' && response.status !== 401 && response.status !== 403) {
        if (response.status === 413) throw new Error('MOBILE_AGENT_REQUEST_LIMIT')
        if (response.headers.get('content-type')?.split(';')[0]?.trim() === 'application/json') {
          let code: unknown
          try { code = row(await response.json())['code'] } catch { /* Keep malformed errors opaque. */ }
          if (options.accountId() !== accountId) throw new Error('MOBILE_AGENT_ACCOUNT_CHANGED')
          signal.throwIfAborted()
          if ((response.status === 400 && (code === 'MOBILE_AGENT_IMAGE_LIMIT' || code === 'MOBILE_AGENT_INVALID_IMAGE'))
            || (response.status === 503 && code === 'MOBILE_AGENT_IMAGE_UNAVAILABLE'))
            throw new Error(code)
        }
      }
      throw new Error(response.status === 401 ? 'MOBILE_AGENT_AUTH_REQUIRED' : response.status === 403 ? 'MOBILE_AGENT_FORBIDDEN' : 'MOBILE_AGENT_UNAVAILABLE')
    }
    const data = row(await response.json())
    if (options.accountId() !== accountId) throw new Error('MOBILE_AGENT_ACCOUNT_CHANGED')
    signal.throwIfAborted()
    if (data['ok'] !== true)
      throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
    return data
  }
  return {
    supportsImageInput: true,
    async *follow(target, signal) {
      if (options.accountId() !== target.accountId) throw new Error('MOBILE_AGENT_ACCOUNT_CHANGED')
      const abort = new AbortController()
      const combined = AbortSignal.any([signal, abort.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
      const cancelBody = (): void => {
        void reader?.cancel().catch(() => {
          // An already-aborted fetch body can reject cancellation; its read observes the abort.
        })
      }
      const resetDeadline = (): void => {
        clearTimeout(timer)
        timer = setTimeout(() => { abort.abort(new Error('MOBILE_AGENT_STREAM_TIMEOUT')) }, options.timeoutMs)
      }
      const assertCurrent = (): void => {
        combined.throwIfAborted()
        if (options.accountId() !== target.accountId) throw new Error('MOBILE_AGENT_ACCOUNT_CHANGED')
      }
      try {
        resetDeadline()
        const token = await options.access(combined)
        assertCurrent()
        if (!token) throw new Error('MOBILE_AGENT_AUTH_REQUIRED')
        const response = await options.fetch(`${MOBILE_AGENT_PREFIX}/follow`, {
          method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: combined,
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${token}` },
          body: JSON.stringify({ binding: target }),
        })
        assertCurrent()
        if (await missingSession(response)) throw new Error('MOBILE_AGENT_SESSION_NOT_FOUND')
        if (!response.ok) throw new Error(response.status === 401 ? 'MOBILE_AGENT_AUTH_REQUIRED'
          : [404, 405].includes(response.status) ? 'MOBILE_AGENT_STREAM_UNSUPPORTED' : 'MOBILE_AGENT_UNAVAILABLE')
        if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'text/event-stream' || !response.body)
          throw new Error('MOBILE_AGENT_STREAM_INVALID')
        reader = response.body.getReader()
        combined.addEventListener('abort', cancelBody, { once: true })
        assertCurrent()
        const decoder = new TextDecoder()
        let buffer = ''
        let current: AgentSessionTranscript | undefined
        while (true) {
          resetDeadline()
          const next = await reader.read()
          assertCurrent()
          if (next.done) throw new Error('MOBILE_AGENT_STREAM_CLOSED')
          buffer += decoder.decode(next.value, { stream: true })
          if (buffer.length > 4 * 1024 * 1024) throw new Error('MOBILE_AGENT_STREAM_LIMIT')
          let boundary: RegExpExecArray | null
          while ((boundary = /\r?\n\r?\n/u.exec(buffer)) !== null) {
            const event = buffer.slice(0, boundary.index)
            buffer = buffer.slice(boundary.index + boundary[0].length)
            const data = event.split(/\r?\n/u).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
            if (!data) continue
            const frame = row(JSON.parse(data))
            assertCurrent()
            if (frame['type'] === 'done') return
            if (frame['type'] === 'error') throw new Error('MOBILE_AGENT_UNAVAILABLE')
            if (frame['type'] === 'snapshot') current = readTranscript(frame['transcript'], target)
            else if (frame['type'] === 'text-delta') {
              binding(frame['binding'], target.accountId, target.sessionId)
              if (!current || typeof frame['id'] !== 'string' || typeof frame['text'] !== 'string'
                || typeof frame['at'] !== 'number' || !Number.isFinite(frame['at'])) throw new Error('MOBILE_AGENT_STREAM_INVALID')
              const previous = current.turns.find(turn => turn.id === frame['id'])
              if (previous && (previous.role !== 'assistant' || !previous.pending)) throw new Error('MOBILE_AGENT_STREAM_INVALID')
              const turn = { id: frame['id'], text: (previous?.text ?? '') + frame['text'], at: frame['at'], role: 'assistant' as const, pending: true }
              if (turn.text.length > 64 * 1024) throw new Error('MOBILE_AGENT_STREAM_LIMIT')
              current = { ...current, status: 'running', turns: [...current.turns.filter(item => item.id !== turn.id), turn] }
            } else throw new Error('MOBILE_AGENT_STREAM_INVALID')
            yield current
          }
        }
      } finally {
        clearTimeout(timer)
        combined.removeEventListener('abort', cancelBody)
        abort.abort()
        try { await reader?.cancel() } catch {
          // Fetch cancellation can already have errored the body with this adapter's abort.
        } finally { reader?.releaseLock() }
      }
    },
    async open(accountId, sourceDeviceId, signal) { return binding((await post('open', { accountId, sourceDeviceId }, accountId, signal))['binding'], accountId) },
    async list(accountId, signal) {
      const values = (await post('list', { accountId }, accountId, signal))['bindings']
      if (!Array.isArray(values))
        throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
      return values.map(value => binding(value, accountId))
    },
    async inspect(target, signal) {
      return readTranscript((await post('inspect', { binding: target }, target.accountId, signal))['transcript'], target)
    },
    async submit(target, command, signal) {
      const images = command.images?.map(image => ({ ...image }))
      if (images !== undefined) validateVisionImages(images)
      const body = { binding: { ...target }, requestId: command.requestId, text: command.text, ...(images === undefined ? {} : { images }) }
      const data = row((await post(images === undefined ? 'submit' : 'submit-images', body, body.binding.accountId, signal))['receipt'])
      const owner = binding(data['binding'], body.binding.accountId, body.binding.sessionId)
      if (data['requestId'] !== body.requestId || typeof data['state'] !== 'string' || !['received', 'uncertain', 'rejected'].includes(data['state']))
        throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
      return { binding: owner, requestId: data['requestId'] as SessionRequestId, state: data['state'] as 'received' | 'uncertain' | 'rejected' }
    },
    async cancel(target, signal) {
      const data = await post('cancel', { binding: target }, target.accountId, signal)
      binding(data['binding'], target.accountId, target.sessionId)
      if (data['state'] !== 'cancellation-requested')
        throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
    },
    async archive(target, signal) {
      const data = await post('archive', { binding: target }, target.accountId, signal)
      binding(data['binding'], target.accountId, target.sessionId)
      if (data['state'] !== 'archived') throw new Error('MOBILE_AGENT_RESPONSE_INVALID')
    },
  }
}
