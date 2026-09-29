/** Wire parsing and single-attempt delivery on the real mobile HTTP adapter. */
import { expect, it, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { AgentSessionBinding } from '../src/window/mobile-workspace-types.ts'
import { createMobileAgentHttpPort } from '../src/agent-http.ts'
const binding = { accountId: '42', sessionId: 's' } as AgentSessionBinding
const signal = new AbortController().signal
function port(value: unknown) {
  return createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000,
    fetch: async () => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } }),
  })
}
const transcript = { binding, status: 'running', turns: [{ id: 'a', role: 'assistant', text: 'original', at: 1 }], activity: [{ id: 't', kind: 'tool', at: 1, name: 'echo', state: 'running' }] }
it.each([
  { ...transcript, status: ['running'] },
  { ...transcript, turns: [{ ...transcript.turns[0], role: ['assistant'] }] },
  { ...transcript, activity: [{ ...transcript.activity[0], state: ['running'] }] },
  { ...transcript, turns: [{ ...transcript.turns[0], at: Number.POSITIVE_INFINITY }] },
  { ...transcript, activity: [{ ...transcript.activity[0], kind: ['turn'] }] },
  { ...transcript, activity: [{ ...transcript.activity[0], at: Number.POSITIVE_INFINITY }] },
])('rejects malformed response enums and timestamps', async (value) => {
  await expect(port({ ok: true, transcript: value }).inspect(binding, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_INVALID')
})
it('rejects array-shaped receipt state and mismatched Session identity', async () => {
  const command = { requestId: 'r1' as SessionRequestId, text: 'original' }
  await expect(port({ ok: true, receipt: { binding, ...command, state: ['received'] } }).submit(binding, command, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_INVALID')
  await expect(port({ ok: true, transcript: { ...transcript, binding: { ...binding, sessionId: 'foreign' } } }).inspect(binding, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_IDENTITY_MISMATCH')
})
it('sends a bearer only in headers and never retries an uncertain submit', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('lost response') })
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000, fetch: fetcher })
  const command = { requestId: 'r1' as SessionRequestId, text: 'original' }
  await expect(adapter.submit(binding, command, signal)).rejects.toThrow('lost response')
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, request] = fetcher.mock.calls[0]!
  expect(url).toBe('/api/qianshou/mobile-agent/v1/submit')
  expect(request).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { authorization: 'Bearer memory-secret' } })
  expect(request?.body).not.toContain('memory-secret')
})

it('archives only through the authenticated same-origin endpoint and validates the durable acknowledgement', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, binding, state: 'archived' }))
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000, fetch: fetcher })
  await adapter.archive!(binding, signal)
  expect(fetcher).toHaveBeenCalledTimes(1)
  const [url, request] = fetcher.mock.calls[0]!
  expect(url).toBe('/api/qianshou/mobile-agent/v1/archive')
  expect(request).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error', headers: { authorization: 'Bearer memory-secret' } })
  expect(request?.body).toBe(JSON.stringify({ binding }))
  await expect(port({ ok: true, binding, state: 'received' }).archive!(binding, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_INVALID')
  await expect(port({ ok: true, binding: { ...binding, accountId: 'foreign' }, state: 'archived' }).archive!(binding, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_IDENTITY_MISMATCH')
})
it('does not send if account changes while the access token is resolving', async () => {
  let account = '42'
  const fetcher = vi.fn<typeof fetch>()
  const adapter = createMobileAgentHttpPort({ accountId: () => account, access: async () => { account = '99'; return 'memory-secret' }, timeoutMs: 1000, fetch: fetcher })
  await expect(adapter.inspect(binding, signal)).rejects.toThrow('MOBILE_AGENT_AUTH_REQUIRED')
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects old-account JSON when the response body arrives after account replacement', async () => {
  let account = '42'
  let release!: () => void
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    release = () => { controller.enqueue(new TextEncoder().encode(JSON.stringify({ ok: true, transcript }))); controller.close() }
  } })
  const fetcher = vi.fn<typeof fetch>(async () => new Response(body))
  const adapter = createMobileAgentHttpPort({ accountId: () => account, access: async () => 'memory-secret', timeoutMs: 1000, fetch: fetcher })
  const reading = adapter.inspect(binding, signal)
  await vi.waitFor(() =>{  expect(fetcher).toHaveBeenCalledTimes(1) })
  account = '99'; release()
  await expect(reading).rejects.toThrow('MOBILE_AGENT_ACCOUNT_CHANGED')
})
it('rejects a finite-number overflow encoded as valid JSON', async () => {
  const fetcher = async () => new Response(JSON.stringify({ ok: true, transcript }).replace('"at":1', '"at":1e400'))
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000, fetch: fetcher })
  await expect(adapter.inspect(binding, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_INVALID')
})

it('preserves safe Agent-turn failure and cancellation kinds through the real HTTP adapter', async () => {
  const activity = [
    { id: 'turn-0', kind: 'turn', name: 'agent-turn', state: 'failed', at: 1 },
    { id: 'turn-1', kind: 'turn', name: 'agent-turn', state: 'cancelled', at: 2 },
  ]
  const result = await port({ ok: true, transcript: { ...transcript, activity } }).inspect(binding, signal)
  expect(result.activity).toEqual(activity.map(({ at: _at, ...item }) => item))
})

it('preserves a safe max-tokens end reason for the mobile projector', async () => {
  const activity = [{ id: 'turn-0', kind: 'turn', name: 'agent-turn', state: 'failed', endReason: 'max-tokens', at: 1 }]
  const result = await port({ ok: true, transcript: { ...transcript, activity } }).inspect(binding, signal)
  expect(result.activity).toEqual(activity.map(({ at: _at, ...item }) => item))
})

it('rejects unsafe activity end reasons', async () => {
  const activity = [{ id: 'turn-0', kind: 'turn', name: 'agent-turn', state: 'failed', endReason: 'provider-secret', at: 1 }]
  await expect(port({ ok: true, transcript: { ...transcript, activity } }).inspect(binding, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_INVALID')
})

it('preserves canonical quota failures without accepting arbitrary provider text', async () => {
  const activity = [{ id: 'turn-0', kind: 'turn', name: 'agent-turn', state: 'failed', endReason: 'error', failure: 'quota', at: 1 }]
  const result = await port({ ok: true, transcript: { ...transcript, activity } }).inspect(binding, signal)
  expect(result.activity?.[0]).toMatchObject({ failure: 'quota' })
  await expect(port({ ok: true, transcript: { ...transcript, activity: [{ ...activity[0], failure: 'provider-secret' }] } }).inspect(binding, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_INVALID')
})

it('decodes split UTF-8 live frames and replaces transient text with the committed snapshot', async () => {
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller } })
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000,
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  })
  const iterator = adapter.follow!(binding, signal)[Symbol.asyncIterator]()
  const nextTranscript = async () => {
    const next = await iterator.next()
    if (next.done) throw new Error('UNEXPECTED_STREAM_END')
    return next.value
  }
  const encoder = new TextEncoder()
  const write = (frame: unknown): void => { writer.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\r\n\r\n`)) }
  write({ type: 'snapshot', transcript: { ...transcript, turns: [] } })
  expect((await nextTranscript()).turns).toEqual([])
  const bytes = encoder.encode(`data: ${JSON.stringify({ type: 'text-delta', binding, id: 'live:1', text: '你好', at: 2 })}\r\n\r\n`)
  for (const byte of bytes) writer.enqueue(Uint8Array.of(byte))
  expect((await nextTranscript()).turns).toEqual([{ id: 'live:1', text: '你好', role: 'assistant', at: 2, pending: true }])
  write({ type: 'text-delta', binding, id: 'live:1', text: '世界', at: 2 })
  expect((await nextTranscript()).turns.at(-1)?.text).toBe('你好世界')
  write({ type: 'snapshot', transcript: { ...transcript, status: 'idle', turns: [{ id: 'a:1', text: '你好世界', role: 'assistant', at: 2 }] } })
  expect((await nextTranscript()).turns).toEqual([{ id: 'a:1', text: '你好世界', role: 'assistant', at: 2 }])
  write({ type: 'done' })
  expect((await iterator.next()).done).toBe(true)
})

it('cancels a waiting stream body and never yields late data after account replacement', async () => {
  let account = '42'
  let writer!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ start(controller) { writer = controller }, cancel })
  const adapter = createMobileAgentHttpPort({ accountId: () => account, access: async () => 'memory-secret', timeoutMs: 1000,
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  })
  const iterator = adapter.follow!(binding, signal)[Symbol.asyncIterator]()
  writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'snapshot', transcript })}\n\n`))
  await iterator.next()
  const next = iterator.next()
  account = '99'
  writer.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'snapshot', transcript })}\n\n`))
  await expect(next).rejects.toThrow(/MOBILE_AGENT_(?:ACCOUNT_CHANGED|AUTH_REQUIRED)/u)
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('aborts and releases an idle body that ignores the fetch signal', async () => {
  const cancel = vi.fn()
  const body = new ReadableStream<Uint8Array>({ cancel })
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 25,
    fetch: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
  })
  await expect(adapter.follow!(binding, signal)[Symbol.asyncIterator]().next()).rejects.toThrow('MOBILE_AGENT_STREAM_TIMEOUT')
  expect(cancel).toHaveBeenCalledTimes(1)
})

it('rejects a foreign stream identity and an EOF without a terminal marker', async () => {
  const make = (text: string) => createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000,
    fetch: async () => new Response(text, { headers: { 'content-type': 'text/event-stream' } }),
  })
  const first = make(`data: ${JSON.stringify({ type: 'snapshot', transcript: { ...transcript, binding: { ...binding, accountId: '99' } } })}\n\n`)
  await expect(first.follow!(binding, signal)[Symbol.asyncIterator]().next()).rejects.toThrow('MOBILE_AGENT_RESPONSE_IDENTITY_MISMATCH')
  const second = make(`data: ${JSON.stringify({ type: 'snapshot', transcript })}\n\n`).follow!(binding, signal)[Symbol.asyncIterator]()
  expect((await second.next()).done).toBe(false)
  await expect(second.next()).rejects.toThrow('MOBILE_AGENT_STREAM_CLOSED')
})

it.each([
  [404, { ok: false, code: 'MOBILE_AGENT_SESSION_NOT_FOUND' }, 'MOBILE_AGENT_SESSION_NOT_FOUND'],
  [404, { ok: false, code: 'MOBILE_AGENT_NOT_FOUND' }, 'MOBILE_AGENT_UNAVAILABLE'],
  [403, { ok: false, code: 'MOBILE_AGENT_SESSION_NOT_FOUND' }, 'MOBILE_AGENT_FORBIDDEN'],
  [401, { ok: false, code: 'MOBILE_AGENT_SESSION_NOT_FOUND' }, 'MOBILE_AGENT_AUTH_REQUIRED'],
  [404, { ok: true, code: 'MOBILE_AGENT_SESSION_NOT_FOUND' }, 'MOBILE_AGENT_UNAVAILABLE'],
] as const)('distinguishes definitive session loss from HTTP %s errors', async (status, body, expected) => {
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000,
    fetch: async () => Response.json(body, { status }),
  })
  await expect(adapter.inspect(binding, signal)).rejects.toThrow(expected)
})

it('reports session loss on a follow handshake but does not confuse it with an unsupported streaming route', async () => {
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000,
    fetch: async () => Response.json({ ok: false, code: 'MOBILE_AGENT_SESSION_NOT_FOUND' }, { status: 404 }),
  })
  await expect(adapter.follow!(binding, signal)[Symbol.asyncIterator]().next()).rejects.toThrow('MOBILE_AGENT_SESSION_NOT_FOUND')
})

it('submits images on the authenticated image endpoint with the original request id and no text fallback', async () => {
  const command = { requestId: 'image1' as SessionRequestId, text: '这是什么', images: [{ mediaType: 'image/png' as const, data: 'AQID', name: 'original.png' }] }
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true, receipt: { binding, requestId: command.requestId, state: 'received' } }))
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000, fetch: fetcher })
  expect(adapter.supportsImageInput).toBe(true)
  expect(await adapter.submit(binding, command, signal)).toMatchObject({ binding, requestId: 'image1', state: 'received' })
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]![0]).toBe('/api/qianshou/mobile-agent/v1/submit-images')
  expect(JSON.parse(fetcher.mock.calls[0]![1]!.body as string)).toEqual({ binding, ...command })
  expect(fetcher.mock.calls[0]![1]).toMatchObject({ credentials: 'omit', redirect: 'error', headers: { authorization: 'Bearer memory-secret' } })
})

it('never retries image delivery or drops images after a connection loss', async () => {
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('connection lost') })
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000, fetch: fetcher })
  await expect(adapter.submit(binding, { requestId: 'im1' as SessionRequestId, text: '读图', images: [{ mediaType: 'image/png', data: 'AQID' }] }, signal)).rejects.toThrow('connection lost')
  expect(fetcher).toHaveBeenCalledTimes(1)
  expect(fetcher.mock.calls[0]![0]).toContain('/submit-images')
})

it('rejects invalid image input before authentication or transmission', async () => {
  const fetcher = vi.fn<typeof fetch>(); const access = vi.fn(async () => 'memory-secret')
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access, timeoutMs: 1000, fetch: fetcher })
  await expect(adapter.submit(binding, { requestId: 'im1' as SessionRequestId, text: '读图', images: [] }, signal)).rejects.toThrow('MOBILE_AGENT_IMAGE_LIMIT')
  expect(access).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
})

it.each([
  [400, 'MOBILE_AGENT_IMAGE_LIMIT', 'MOBILE_AGENT_IMAGE_LIMIT'],
  [400, 'MOBILE_AGENT_INVALID_IMAGE', 'MOBILE_AGENT_INVALID_IMAGE'],
  [413, 'other', 'MOBILE_AGENT_REQUEST_LIMIT'],
  [503, 'MOBILE_AGENT_IMAGE_UNAVAILABLE', 'MOBILE_AGENT_IMAGE_UNAVAILABLE'],
  [401, 'MOBILE_AGENT_INVALID_IMAGE', 'MOBILE_AGENT_AUTH_REQUIRED'],
  [403, 'MOBILE_AGENT_INVALID_IMAGE', 'MOBILE_AGENT_FORBIDDEN'],
  [502, 'MOBILE_AGENT_INVALID_IMAGE', 'MOBILE_AGENT_UNAVAILABLE'],
  [400, 'provider-secret', 'MOBILE_AGENT_UNAVAILABLE'],
])('reads only confirmed image error enums for HTTP %s', async (status, code, expected) => {
  const adapter = createMobileAgentHttpPort({ accountId: () => '42', access: async () => 'memory-secret', timeoutMs: 1000,
    fetch: async () => Response.json({ ok: false, code, message: 'provider-secret' }, { status }),
  })
  await expect(adapter.submit(binding, { requestId: 'im1' as SessionRequestId, text: '读图', images: [{ mediaType: 'image/png', data: 'AQID' }] }, signal)).rejects.toThrow(expected)
})

it('validates image receipts and blocks images when the account changes during token resolution', async () => {
  const command = { requestId: 'im1' as SessionRequestId, text: '读图', images: [{ mediaType: 'image/png' as const, data: 'AQID' }] }
  await expect(port({ ok: true, receipt: { binding: { ...binding, sessionId: 'foreign' }, requestId: command.requestId, state: 'received' } }).submit(binding, command, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_IDENTITY_MISMATCH')
  await expect(port({ ok: true, receipt: { binding, requestId: 'foreign', state: 'received' } }).submit(binding, command, signal)).rejects.toThrow('MOBILE_AGENT_RESPONSE_INVALID')
  let account = '42'; const fetcher = vi.fn<typeof fetch>()
  const adapter = createMobileAgentHttpPort({ accountId: () => account, access: async () => { account = '99'; return 'memory-secret' }, timeoutMs: 1000, fetch: fetcher })
  await expect(adapter.submit(binding, command, signal)).rejects.toThrow('MOBILE_AGENT_AUTH_REQUIRED')
  expect(fetcher).not.toHaveBeenCalled()
})
