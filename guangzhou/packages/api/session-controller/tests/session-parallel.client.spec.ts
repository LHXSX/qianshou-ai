import { describe, expect, it, vi } from 'vitest'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '../src/types.ts'
import { Session } from '../src/client/sessions/session.ts'
import { FakeApiClient, fakeRemote } from './fake-api.client.ts'

const parent = 'parent' as SessionId
const child = 'child' as SessionId
const requestId = 'same-request' as SessionRequestId
const accepted = { parentSessionId: parent, childSessionId: child, mode: 'continuable' as const, messageId: 'message' as MessageId }

describe('Session parallel dispatch', () => {
  it('forwards the stable request identity and exposes a blank parent only after real acceptance', async () => {
    const api = new FakeApiClient()
    const onEngaged = vi.fn()
    const session = new Session(parent, fakeRemote(api), { onEngaged })
    api.onDispatchParallel = () => Promise.resolve({ ok: true, value: accepted })
    const result = await session.dispatchParallel([{ type: 'text', text: 'Separate task' }], 'Separate task', undefined, requestId)
    expect(result).toEqual({ ok: true, value: accepted })
    expect(api.calls[0]).toMatchObject({ method: 'session.dispatchParallel', payload: {
      sessionId: parent, requestId, label: 'Separate task', content: [{ type: 'text', text: 'Separate task' }],
    } })
    expect(session.getSnapshot()).toMatchObject({ blank: false, queue: [], pendingSubmissions: [], running: false })
    session.handleBlank(true)
    expect(session.getSnapshot().blank).toBe(false)
    await session.dispatchParallel([{ type: 'text', text: 'Separate task' }], 'Separate task', undefined, requestId)
    expect(onEngaged).toHaveBeenCalledOnce()
    expect(api.calls.filter(call => call.method === 'session.prompt')).toEqual([])
  })

  it('keeps a rejected dispatch visible as a failure and clears it after accepted retry', async () => {
    const api = new FakeApiClient()
    const session = new Session(parent, fakeRemote(api))
    const error = new RemoteError('gateway/internal', 'dispatch failed', {})
    api.onDispatchParallel = () => Promise.resolve({ ok: false, error })
    expect(await session.dispatchParallel([{ type: 'text', text: 'Task' }])).toEqual({ ok: false, error })
    expect(session.getSnapshot()).toMatchObject({ blank: true, promptError: { op: 'send', error } })
    api.onDispatchParallel = () => Promise.resolve({ ok: true, value: accepted })
    await session.dispatchParallel([{ type: 'text', text: 'Task' }])
    expect(session.getSnapshot().promptError).toBeNull()
  })
})
