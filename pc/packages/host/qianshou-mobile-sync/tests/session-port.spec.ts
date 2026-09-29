/**
 * The phone seam over real Session events and the shared session-connect admission port: which Sessions a phone may
 * continue, what one bounded text window contains, and that every refusal arrives as this package's own code.
 */
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { ConnectFailure } from '@deepseek-ai/dsh-host-qianshou-session-connect/src/validation.ts'
import type { ConnectSessionPort } from '@deepseek-ai/dsh-host-qianshou-session-connect/src/session-port.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSyncFailure } from '../src/failure.ts'
import { mobileSessionPort } from '../src/session-port.ts'
import type { WindowBinding } from '../src/types.ts'

const SESSION = 'sess-1'
const BINDING: WindowBinding = { accountId: 'acct-1', pcId: 'pc-1', sessionId: SESSION, sourceDeviceId: 'phone-1' }
const signal = (): AbortSignal => new AbortController().signal

/** One Session summary as the controller lists it; only the fields this seam reads are named. */
interface Listed {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly origin: 'user' | 'subagent'
  readonly parentSessionId?: string
}

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

/** Real committed Session events: one user turn and one assistant reply. */
async function events(): Promise<readonly SessionEvent[]> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  contexts.push(ctx)
  const session = ctx.sessions.create(SessionId(SESSION))
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'compress this clip' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    stream: [], turn: 1, step: 1,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'on it' }], source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  return session.snapshotEvents()
}

/** The seam over a scripted shared port and a scripted Session controller. */
function seam(inner: Partial<ConnectSessionPort> = {}, listed: readonly Listed[] = [], listFails?: unknown) {
  const base: ConnectSessionPort = {
    inspect: () => Promise.resolve({ events: [], running: false }),
    admitted: () => Promise.resolve(false),
    submit: () => Promise.resolve(),
  }
  const list = vi.fn(async () => {
    if (listFails !== undefined) throw listFails
    return { items: listed }
  })
  const ctx = { sessionController: { list } } as unknown as Context
  return { port: mobileSessionPort(ctx, { ...base, ...inner }), list }
}

/** Assert a refusal names one stable wire code. */
async function refuses(operation: () => unknown, kind: string): Promise<void> {
  try { await operation(); expect.unreachable('expected a refusal') }
  catch (error) {
    expect(error).toBeInstanceOf(MobileSyncFailure)
    expect((error as MobileSyncFailure).kind).toBe(kind)
  }
}

describe('sessions a phone may continue', () => {
  it('lists newest activity first and leaves blank, subagent and child Sessions out', async () => {
    const { port } = seam({}, [
      { sessionId: 'older', updatedAt: 100, running: false, blank: false, origin: 'user' },
      { sessionId: 'newest', updatedAt: 300, running: true, blank: false, origin: 'user' },
      { sessionId: 'blank', updatedAt: 400, running: false, blank: true, origin: 'user' },
      { sessionId: 'subagent', updatedAt: 500, running: false, blank: false, origin: 'subagent' },
      { sessionId: 'child', updatedAt: 600, running: false, blank: false, origin: 'user', parentSessionId: 'newest' },
    ])
    expect(await port.listContinuable(signal())).toEqual([
      { sessionId: 'newest', updatedAt: 300, running: true },
      { sessionId: 'older', updatedAt: 100, running: false },
    ])
  })

  it('reports a controller that cannot list as an unavailable Session', async () => {
    const { port } = seam({}, [], new TypeError('controller gone'))
    await refuses(() => port.listContinuable(signal()), 'SESSION_UNAVAILABLE')
  })
})

describe('requiring a continuable Session', () => {
  it('accepts a Session that already carries a turn', async () => {
    const committed = await events()
    const { port } = seam({ inspect: () => Promise.resolve({ events: committed, running: false }) })
    await expect(port.requireContinuable(SESSION, signal())).resolves.toBeUndefined()
  })

  it('refuses an empty Session as no Session at all', async () => {
    const { port } = seam()
    await refuses(() => port.requireContinuable(SESSION, signal()), 'NO_SESSION')
  })

  it('refuses a missing or subagent Session as no Session, whatever the authority called it', async () => {
    const { port } = seam({ inspect: () => Promise.reject(new ConnectFailure('session-unavailable', 409)) })
    await refuses(() => port.requireContinuable(SESSION, signal()), 'NO_SESSION')
  })

  it('keeps a storage refusal as a storage refusal instead of calling it a missing Session', async () => {
    const { port } = seam({ inspect: () => Promise.reject(new ConnectFailure('storage-failed', 503)) })
    await refuses(() => port.requireContinuable(SESSION, signal()), 'STORAGE_FAILED')
  })

  it('passes through a refusal this package already named', async () => {
    const { port } = seam({ inspect: () => Promise.reject(new MobileSyncFailure('CLOSED')) })
    await refuses(() => port.requireContinuable(SESSION, signal()), 'CLOSED')
  })
})

describe('the bounded text window', () => {
  it('projects committed turns with their own ids, roles and times', async () => {
    const committed = await events()
    const { port } = seam({ inspect: () => Promise.resolve({ events: committed, running: true }) })
    const window = await port.transcript(BINDING, null, signal())
    expect(window.status).toBe('running')
    expect(window.turns.map(turn => [turn.role, turn.text, turn.truncated])).toEqual([['user', 'compress this clip', false], ['assistant', 'on it', false]])
    expect(window.turns.map(turn => turn.id)).toEqual(['u:0', 'a:1'])
    expect(window.turns.every(turn => turn.at > 0)).toBe(true)
    expect(window.cursor).not.toBe('')
  })

  it('reports an idle Session as idle rather than as unavailable', async () => {
    const committed = await events()
    const { port } = seam({ inspect: () => Promise.resolve({ events: committed, running: false }) })
    expect((await port.transcript(BINDING, null, signal())).status).toBe('idle')
  })

  it('refuses a cursor the projection does not recognize', async () => {
    const committed = await events()
    const { port } = seam({ inspect: () => Promise.resolve({ events: committed, running: false }) })
    await refuses(() => port.transcript(BINDING, 'not-this-projections-cursor', signal()), 'CURSOR_INVALID')
  })
})

describe('admission', () => {
  it('answers what the Session log knows about one request identity', async () => {
    const { port } = seam({ admitted: (_id, rpcId) => Promise.resolve(rpcId === 'rpc-1') })
    expect(await port.admitted(SESSION, 'rpc-1', signal())).toBe(true)
    expect(await port.admitted(SESSION, 'rpc-2', signal())).toBe(false)
  })

  it('reports an unreadable Session log as a storage refusal', async () => {
    const { port } = seam({ admitted: () => Promise.reject(new ConnectFailure('storage-failed', 503)) })
    await refuses(() => port.admitted(SESSION, 'rpc-1', signal()), 'STORAGE_FAILED')
  })

  it('queues one text message through the shared port with the caller own check', async () => {
    const checked: string[] = []
    const { port } = seam({ submit: (id, rpcId, text, _signal, check) => { check(); checked.push(`${String(id)}:${rpcId}:${text}`); return Promise.resolve() } })
    await port.submit(SESSION, 'rpc-1', 'compress this clip', signal(), () => { checked.push('checked') })
    expect(checked).toEqual(['checked', 'sess-1:rpc-1:compress this clip'])
  })

  it('reports a Session that cannot accept the message as unavailable', async () => {
    const { port } = seam({ submit: () => Promise.reject(new ConnectFailure('session-unavailable', 409)) })
    await refuses(() => port.submit(SESSION, 'rpc-1', 'text', signal(), () => {}), 'SESSION_UNAVAILABLE')
  })
})

describe('the default shared port', () => {
  it('builds over the Host Session services when the caller names no other port', () => {
    const ctx = { sessionController: { list: () => Promise.resolve({ items: [] }) } } as unknown as Context
    expect(Object.keys(mobileSessionPort(ctx)).sort()).toEqual(['admitted', 'listContinuable', 'requireContinuable', 'submit', 'transcript'])
  })
})
