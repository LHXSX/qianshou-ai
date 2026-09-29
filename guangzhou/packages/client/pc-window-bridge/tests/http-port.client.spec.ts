/**
 * Connector replies: refusal codes, invalid envelopes and local transport outcomes.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowGatewayError, PcWindowHttpPort } from '../src/http-port.ts'
import type { WindowBinding, WindowCommand } from '../src/types.ts'

const BINDING: WindowBinding = {
  accountId: 'local-owner',
  pcId: 'this-pc',
  sessionId: 'session-primary' as SessionId,
  sourceDeviceId: 'phone-01',
}

const COMMAND: WindowCommand = {
  requestId: 'req-1' as SessionRequestId,
  origin: BINDING,
  createdAt: 1,
  expiresAt: 60_000,
  action: { type: 'dispatch', text: 'continue' },
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function port(fetchImpl: typeof fetch, extra: { timeoutMs?: number } = {}): PcWindowHttpPort {
  return new PcWindowHttpPort({
    baseUrl: 'http://pc.test',
    fetch: fetchImpl,
    ...(extra.timeoutMs === undefined ? {} : { timeoutMs: extra.timeoutMs }),
  })
}

describe('PcWindowHttpPort reply handling', () => {
  it('raises the gateway code when access or sync is refused', async () => {
    const connector = port(async (input) => {
      const url = String(input)
      if (url.includes('/access')) return jsonResponse({ error: { code: 'PC_WINDOW_FOREIGN_ORIGIN' } }, 403)
      return jsonResponse({ error: { code: 'PC_WINDOW_CURSOR_UNKNOWN' } }, 409)
    })
    const signal = new AbortController().signal
    await expect(connector.access(BINDING, signal)).rejects.toMatchObject({ code: 'PC_WINDOW_FOREIGN_ORIGIN' })
    await expect(connector.sync(BINDING, null, [], signal)).rejects.toMatchObject({ code: 'PC_WINDOW_CURSOR_UNKNOWN' })
  })

  it('permits a resend only when the gateway proved non-admission', async () => {
    const connector = port(async () => jsonResponse({
      error: { code: 'PC_WINDOW_SESSION_UNAVAILABLE', details: { admitted: false } },
    }, 503))
    const error = await connector.submit(COMMAND, new AbortController().signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(PcWindowGatewayError)
    expect(error).toMatchObject({ code: 'PC_WINDOW_SESSION_UNAVAILABLE', mayResend: true })
  })

  it('raises AbortError when the caller cancels an in-flight request', async () => {
    const caller = new AbortController()
    const hanging = port(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    }))
    const pending = hanging.access(BINDING, caller.signal)
    caller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not treat a missing refusal envelope as permission to resend', async () => {
    const connector = port(async () => new Response('not-json', { status: 502 }))
    await expect(connector.submit(COMMAND, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PC_WINDOW_INVALID_REPLY' })
    const refused = port(async () => jsonResponse({ error: 'bare' }, 502))
    const error = await refused.submit(COMMAND, new AbortController().signal).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'PC_WINDOW_GATEWAY_REFUSED', mayResend: false })
  })

  it('rejects an oversized reply, an aborted call and a deadline', async () => {
    const oversized = port(async () => new Response('x'.repeat(1_048_577), { status: 200 }))
    await expect(oversized.access(BINDING, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PC_WINDOW_REPLY_TOO_LARGE' })

    const aborted = new AbortController()
    aborted.abort()
    await expect(port(async () => jsonResponse({})).access(BINDING, aborted.signal))
      .rejects.toMatchObject({ name: 'AbortError' })

    const hanging = port(async (_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('aborted', 'AbortError')) })
    }), { timeoutMs: 20 })
    await expect(hanging.access(BINDING, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PC_WINDOW_TRANSPORT_FAILED' })
  })

  it('rejects an access verdict whose actions are not the PC command set', async () => {
    const connector = port(async () => jsonResponse({
      binding: BINDING,
      access: { state: 'online', allowedActions: ['dispatch', 'hack'] },
    }))
    await expect(connector.bootstrap('phone-01', new AbortController().signal))
      .rejects.toMatchObject({ code: 'PC_WINDOW_INVALID_ACCESS' })
  })

  it('reads a bounded admitted flag from a refusal details object', async () => {
    const connector = port(async () => jsonResponse({
      error: { code: 'PC_WINDOW_SESSION_UNAVAILABLE', details: { admitted: true } },
    }, 503))
    const error = await connector.submit(COMMAND, new AbortController().signal).catch((caught: unknown) => caught)
    expect(error).toMatchObject({ code: 'PC_WINDOW_SESSION_UNAVAILABLE', mayResend: false })

    const empty = port(async () => jsonResponse({ error: { code: 'PC_WINDOW_SESSION_UNAVAILABLE', details: { admitted: 'yes' } } }, 503))
    await expect(empty.submit(COMMAND, new AbortController().signal))
      .rejects.toMatchObject({ mayResend: false })

    const nameless = port(async () => jsonResponse({ error: { code: 'x'.repeat(129) } }, 502))
    await expect(nameless.submit(COMMAND, new AbortController().signal))
      .rejects.toMatchObject({ code: 'PC_WINDOW_GATEWAY_REFUSED' })
  })

  it('rejects a scalar or array gateway envelope', async () => {
    const connector = port(async () => jsonResponse([]))
    await expect(connector.bootstrap('phone-01', new AbortController().signal))
      .rejects.toMatchObject({ code: 'PC_WINDOW_INVALID_REPLY' })
  })
})
