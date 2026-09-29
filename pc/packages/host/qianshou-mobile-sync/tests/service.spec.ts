/** The owner is rechecked before and after touching the Session, and one command is admitted at most once. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileSyncFailure } from '../src/failure.ts'
import { PcWindowService } from '../src/service.ts'
import type { PcWindowServiceOptions } from '../src/service.ts'
import type { MobileSessionPort, TranscriptWindow } from '../src/session-port.ts'
import { MobileSyncStore } from '../src/store.ts'
import type { WindowBinding } from '../src/types.ts'
import { syncCursor } from '../src/validation.ts'

const PC = 'pc-1'
const ACCOUNT = 'acct-1'
const BINDING: WindowBinding = { accountId: ACCOUNT, pcId: PC, sessionId: 'sess-1', sourceDeviceId: 'phone-1' }
const DAY = 24 * 60 * 60 * 1000
/** A realistic epoch clock, so a command created a day ago is still a non-negative instant. */
const NOW = 1_700_000_000_000

/** One recorded admission attempt against the fake Session authority. */
interface Submission { sessionId: string; rpcId: string; text: string }

/** A fake Session authority: it records admissions and lets one test fail or stall exactly one of them. */
function port(overrides: Partial<MobileSessionPort> = {}) {
  const submissions: Submission[] = []
  const admittedIds = new Set<string>()
  const base: MobileSessionPort = {
    listContinuable: () => Promise.resolve([
      { sessionId: 'sess-1', updatedAt: 200, running: false },
      { sessionId: 'sess-0', updatedAt: 100, running: false },
    ]),
    requireContinuable: () => Promise.resolve(),
    transcript: (): Promise<TranscriptWindow> => Promise.resolve({
      status: 'idle', turns: [], cursor: 'c-1', reset: false, hasMore: false, earlierOmitted: false,
    }),
    admitted: (_sessionId, rpcId) => Promise.resolve(admittedIds.has(rpcId)),
    submit: (sessionId, rpcId, text, _signal, check) => {
      check()
      submissions.push({ sessionId, rpcId, text })
      admittedIds.add(rpcId)
      return Promise.resolve()
    },
  }
  return { port: { ...base, ...overrides }, submissions, admittedIds }
}

const services: PcWindowService[] = []
const stores: MobileSyncStore[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  stores.splice(0)
})

async function booted(options: Partial<PcWindowServiceOptions> = {}, overrides: Partial<MobileSessionPort> = {}) {
  const store = await MobileSyncStore.open(':memory:', 8, 64)
  stores.push(store)
  const fake = port(overrides)
  const service = new PcWindowService(store, fake.port, {
    pcId: PC,
    currentAccount: () => ACCOUNT,
    maxRequests: 8,
    timeoutMs: 2000,
    now: () => NOW,
    ...options,
  })
  services.push(service)
  return { service, store, ...fake }
}

/** Assert a refusal names one stable wire code. */
async function refuses(operation: () => unknown, kind: string): Promise<void> {
  try { await operation(); expect.unreachable('expected a refusal') }
  catch (error) {
    expect(error).toBeInstanceOf(MobileSyncFailure)
    expect((error as MobileSyncFailure).kind).toBe(kind)
  }
}

const command = (overrides: Record<string, unknown> = {}) => ({
  requestId: 'req-1',
  origin: BINDING,
  createdAt: NOW - 1000,
  expiresAt: NOW + DAY,
  action: { type: 'dispatch', text: 'compress this clip' },
  ...overrides,
})

describe('owner checks', () => {
  it('refuses every operation while this PC is signed out', async () => {
    const { service } = await booted({ currentAccount: () => null })
    await refuses(() => service.bootstrap(ACCOUNT, { deviceId: 'phone-1' }), 'NOT_SIGNED_IN')
    await refuses(() => service.access(ACCOUNT, { binding: BINDING }), 'NOT_SIGNED_IN')
    await refuses(() => service.submit(ACCOUNT, { command: command() }), 'NOT_SIGNED_IN')
  })

  it('refuses a relay principal that differs from the signed-in account', async () => {
    const { service } = await booted()
    await refuses(() => service.bootstrap('acct-2', { deviceId: 'phone-1' }), 'OWNER_CHANGED')
  })

  it('refuses a binding that names another account even when the relay principal matches', async () => {
    const { service } = await booted()
    await refuses(() => service.access(ACCOUNT, { binding: { ...BINDING, accountId: 'acct-2' } }), 'OWNER_CHANGED')
  })

  it('treats a binding for another PC as unknown to this one', async () => {
    const { service } = await booted()
    await refuses(() => service.submit(ACCOUNT, { command: command({ origin: { ...BINDING, pcId: 'pc-2' } }) }), 'BINDING_UNKNOWN')
  })

  it('refuses a command when the owner changes while the Session is being touched', async () => {
    let current: string | null = ACCOUNT
    const { service, submissions } = await booted(
      { currentAccount: () => current },
      { submit: (_sessionId, _rpcId, _text, _signal, check) => { current = 'acct-2'; check(); return Promise.resolve() } },
    )
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    current = ACCOUNT
    await refuses(() => service.submit(ACCOUNT, { command: command() }), 'OWNER_CHANGED')
    expect(submissions).toEqual([])
  })
})

describe('bootstrap', () => {
  it('binds the newest continuable Session and reports the permitted text actions', async () => {
    const { service } = await booted()
    const result = await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    expect(result).toMatchObject({
      binding: BINDING,
      access: { state: 'online', allowedActions: ['dispatch', 'append'] },
    })
    expect(result.sessions.map(session => session.sessionId)).toEqual(['sess-1', 'sess-0'])
  })

  it('binds a named Session after the authority confirms it is continuable', async () => {
    const asked: string[] = []
    const { service } = await booted({}, { requireContinuable: (sessionId) => { asked.push(sessionId); return Promise.resolve() } })
    expect(await service.bootstrap(ACCOUNT, { deviceId: 'phone-1', sessionId: 'sess-0' }))
      .toMatchObject({ binding: { ...BINDING, sessionId: 'sess-0' } })
    expect(asked).toEqual(['sess-0'])
  })

  it('refuses when the account has no continuable Session', async () => {
    const { service } = await booted({}, { listContinuable: () => Promise.resolve([]) })
    await refuses(() => service.bootstrap(ACCOUNT, { deviceId: 'phone-1' }), 'NO_SESSION')
  })

  it('refuses a payload without a usable device id', async () => {
    const { service } = await booted()
    await refuses(() => service.bootstrap(ACCOUNT, {}), 'BAD_REQUEST')
    await refuses(() => service.bootstrap(ACCOUNT, { deviceId: 'phone-1', sessionId: '' }), 'BAD_REQUEST')
  })

  it('re-pairing the same phone keeps the receipt stream position', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await service.submit(ACCOUNT, { command: command() })
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    const page = await service.sync(ACCOUNT, { binding: BINDING, cursor: null })
    expect(page.nextCursor).toBe(syncCursor(1))
    expect(page.receipts).toHaveLength(1)
  })
})

describe('access', () => {
  it('answers unauthorized for an unknown binding so the phone can re-bootstrap', async () => {
    const { service } = await booted()
    expect(await service.access(ACCOUNT, { binding: BINDING })).toEqual({ state: 'unauthorized', allowedActions: [] })
  })

  it('answers unauthorized after the binding is revoked', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    expect(await service.access(ACCOUNT, { binding: BINDING })).toMatchObject({ state: 'online' })
    expect(service.revokeAll()).toBe(1)
    expect(await service.access(ACCOUNT, { binding: BINDING })).toEqual({ state: 'unauthorized', allowedActions: [] })
  })
})

describe('submit', () => {
  it('admits one command once and replays the durable outcome afterwards', async () => {
    const { service, submissions } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    const first = await service.submit(ACCOUNT, { command: command() })
    expect(first).toMatchObject({ outcome: 'executed', mayResend: false, receipt: { state: 'received', revision: 1 } })
    expect(submissions).toMatchObject([{ sessionId: 'sess-1', text: 'compress this clip' }])
    const second = await service.submit(ACCOUNT, { command: command() })
    expect(second).toMatchObject({ outcome: 'replayed', receipt: { state: 'received', revision: 1 } })
    expect(submissions).toHaveLength(1)
  })

  it('collapses two concurrent retries of one command into a single admission', async () => {
    const { service, submissions } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    const [left, right] = await Promise.all([
      service.submit(ACCOUNT, { command: command() }),
      service.submit(ACCOUNT, { command: command() }),
    ])
    expect(left).toEqual(right)
    expect(submissions).toHaveLength(1)
  })

  it('refuses a changed body under an already used request id', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await service.submit(ACCOUNT, { command: command() })
    await refuses(
      () => service.submit(ACCOUNT, { command: command({ action: { type: 'dispatch', text: 'something else' } }) }),
      'REQUEST_CONFLICT',
    )
  })

  it('refuses cancel until this PC has a cancel port', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await refuses(
      () => service.submit(ACCOUNT, { command: command({ action: { type: 'cancel', targetSessionId: 'sess-1', expectedRevision: 1 } }) }),
      'ACTION_UNSUPPORTED',
    )
  })

  it('refuses an append aimed at a Session other than the bound one', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await refuses(
      () => service.submit(ACCOUNT, { command: command({ action: { type: 'append', targetSessionId: 'sess-9', expectedRevision: 1, text: 'x' } }) }),
      'TARGET_MISMATCH',
    )
  })

  it('refuses a command whose lifetime already ended', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await refuses(() => service.submit(ACCOUNT, { command: command({ createdAt: NOW - DAY, expiresAt: NOW - 1 }) }), 'COMMAND_EXPIRED')
  })

  it('treats admission that happened before a failure as received rather than resendable', async () => {
    const reached = new Set<string>()
    const { service } = await booted({}, {
      submit: (_sessionId, rpcId, _text, _signal, check) => {
        check()
        // The Session log is the only proof; the failure arrives after admission already happened.
        reached.add(rpcId)
        return Promise.reject(new MobileSyncFailure('TIMEOUT'))
      },
      admitted: (_sessionId, rpcId) => Promise.resolve(reached.has(rpcId)),
    })
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    expect(await service.submit(ACCOUNT, { command: command() }))
      .toMatchObject({ outcome: 'executed', mayResend: false, receipt: { state: 'received' } })
  })

  it('leaves an unproven attempt uncertain and never marks it resendable', async () => {
    const { service } = await booted({}, {
      submit: () => Promise.reject(new MobileSyncFailure('TIMEOUT')),
      admitted: () => Promise.resolve(false),
    })
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await refuses(() => service.submit(ACCOUNT, { command: command() }), 'TIMEOUT')
    const page = await service.sync(ACCOUNT, { binding: BINDING, cursor: null })
    expect(page.receipts).toMatchObject([{ state: 'uncertain', reason: 'PC_WINDOW_TIMEOUT' }])
    expect(page.notReceivedIds).toEqual([])
  })
})

describe('transcript', () => {
  it('echoes the binding, records the observation time and refuses a foreign cursor holder', async () => {
    const asked: (string | null)[] = []
    const { service, store } = await booted({}, {
      transcript: (_binding, cursor) => {
        asked.push(cursor)
        return Promise.resolve({ status: 'running', turns: [{ id: 'u:1', role: 'user', text: 'hi', at: 5, truncated: false }],
          cursor: 'c-2', reset: false, hasMore: true, earlierOmitted: false })
      },
    })
    const bootstrapped = await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    const page = await service.transcript(ACCOUNT, { binding: BINDING, cursor: 'c-1' })
    expect(page).toMatchObject({ binding: BINDING, status: 'running', cursor: 'c-2', hasMore: true })
    expect(asked).toEqual(['c-1'])
    expect(store.binding(bootstrapped.binding)?.lastAccessAt).toBe(NOW)
    await refuses(() => service.transcript('acct-2', { binding: BINDING, cursor: null }), 'OWNER_CHANGED')
  })

  it('refuses a transcript for a binding this PC never issued', async () => {
    const { service } = await booted()
    await refuses(() => service.transcript(ACCOUNT, { binding: BINDING, cursor: null }), 'BINDING_UNKNOWN')
  })
})

describe('sync', () => {
  it('names only the ids this PC never claimed as not received', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await service.submit(ACCOUNT, { command: command() })
    const page = await service.sync(ACCOUNT, { binding: BINDING, cursor: null, requestIds: ['req-1', 'req-unsent'] })
    expect(page.notReceivedIds).toEqual(['req-unsent'])
    expect(page.fromCursor).toBeNull()
    expect(page.nextCursor).toBe(syncCursor(1))
  })

  it('refuses a cursor ahead of anything this PC issued', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await refuses(() => service.sync(ACCOUNT, { binding: BINDING, cursor: syncCursor(9) }), 'CURSOR_FUTURE')
  })

  it('echoes the position the phone asked from and pages only later receipts', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await service.submit(ACCOUNT, { command: command() })
    await service.submit(ACCOUNT, { command: command({ requestId: 'req-2' }) })
    const page = await service.sync(ACCOUNT, { binding: BINDING, cursor: syncCursor(1) })
    expect(page.fromCursor).toBe(syncCursor(1))
    expect(page.receipts.map(receipt => receipt.requestId)).toEqual(['req-2'])
  })

  it('reports a claim with no outcome yet as unproven rather than as nothing', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { service, store } = await booted({}, {
      submit: async (_sessionId, _rpcId, _text, _signal, check) => { check(); await gate; throw new MobileSyncFailure('TIMEOUT') },
      admitted: () => Promise.resolve(false),
    })
    const bootstrapped = await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    const key = store.binding(bootstrapped.binding)!.key
    const pending = service.submit(ACCOUNT, { command: command() })
    await vi.waitFor(() => { expect(store.receipt(key, 'req-1')).toMatchObject({ state: 'uncertain', reason: null }) })
    const page = await service.sync(ACCOUNT, { binding: BINDING, cursor: null })
    expect(page.receipts).toMatchObject([{ state: 'uncertain', reason: 'outcome-unproven' }])
    release()
    await refuses(() => pending, 'TIMEOUT')
  })
})

describe('resuming an unproven command', () => {
  /** A first attempt that leaves the outcome unproven, plus the admission flag the Session log would answer with. */
  async function unproven() {
    const admittedLater = { value: false }
    const fixture = await booted({}, {
      submit: () => Promise.reject(new MobileSyncFailure('TIMEOUT')),
      admitted: () => Promise.resolve(admittedLater.value),
    })
    await fixture.service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await refuses(() => fixture.service.submit(ACCOUNT, { command: command() }), 'TIMEOUT')
    return { ...fixture, admittedLater }
  }

  it('publishes admission once the Session log proves it, without submitting again', async () => {
    const { service, admittedLater } = await unproven()
    admittedLater.value = true
    expect(await service.submit(ACCOUNT, { command: command() }))
      .toMatchObject({ outcome: 'replayed', receipt: { state: 'received' } })
  })

  it('keeps the outcome uncertain while the Session log still proves nothing', async () => {
    const { service } = await unproven()
    expect(await service.submit(ACCOUNT, { command: command() }))
      .toMatchObject({ outcome: 'replayed', mayResend: false, receipt: { state: 'uncertain', reason: 'PC_WINDOW_TIMEOUT' } })
  })

  it('treats an unreadable Session log after a failed admission as no proof', async () => {
    const { service, store } = await booted({}, {
      submit: () => Promise.reject(new MobileSyncFailure('TIMEOUT')),
      admitted: () => Promise.reject(new Error('session log unreadable')),
    })
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await refuses(() => service.submit(ACCOUNT, { command: command() }), 'TIMEOUT')
    expect(store.receipt(store.binding(BINDING)!.key, 'req-1')).toMatchObject({ state: 'uncertain', reason: 'PC_WINDOW_TIMEOUT' })
  })

  it('refuses a second body sent under an id whose first attempt is still in flight', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { service } = await booted({}, { submit: async (_sessionId, _rpcId, _text, _signal, check) => { check(); await gate } })
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    const first = service.submit(ACCOUNT, { command: command() })
    await refuses(() => service.submit(ACCOUNT, { command: command({ action: { type: 'dispatch', text: 'other' } }) }), 'REQUEST_CONFLICT')
    release()
    await expect(first).resolves.toMatchObject({ outcome: 'executed' })
  })
})

describe('relay dispatch', () => {
  it('proves the owner recheck on a successful reply and withholds the proof on a refusal', async () => {
    const { service } = await booted()
    const ok = await service.handle({ id: 'd-1', action: 'bootstrap', accountId: ACCOUNT, payload: { deviceId: 'phone-1' } })
    expect(ok).toMatchObject({ id: 'd-1', status: 200, ownerBound: { version: 'v1', accountId: ACCOUNT } })
    const refused = await service.handle({ id: 'd-2', action: 'access', accountId: 'acct-2', payload: { binding: BINDING } })
    expect(refused).toMatchObject({ id: 'd-2', status: 403, ownerBound: null, body: { error: { code: 'PC_WINDOW_OWNER_CHANGED' } } })
  })

  it('reports a refusal as a stable code without any server text', async () => {
    const { service } = await booted()
    const reply = await service.handle({ id: 'd-3', action: 'submit', accountId: ACCOUNT, payload: {} })
    expect(reply.status).toBe(400)
    expect(JSON.stringify(reply.body)).not.toContain('Error')
  })

  it('forwards each of the five actions to its own operation', async () => {
    const { service, submissions } = await booted()
    const bound = { binding: BINDING }
    await service.handle({ id: 'd-1', action: 'bootstrap', accountId: ACCOUNT, payload: { deviceId: 'phone-1' } })
    expect(await service.handle({ id: 'd-2', action: 'access', accountId: ACCOUNT, payload: bound })).toMatchObject({ status: 200 })
    expect(await service.handle({ id: 'd-3', action: 'transcript', accountId: ACCOUNT, payload: bound })).toMatchObject({ status: 200 })
    expect(await service.handle({ id: 'd-4', action: 'sync', accountId: ACCOUNT, payload: { ...bound, cursor: null } })).toMatchObject({ status: 200 })
    expect(await service.handle({ id: 'd-5', action: 'submit', accountId: ACCOUNT, payload: { command: command() } })).toMatchObject({ status: 200 })
    expect(submissions).toHaveLength(1)
  })

  it('refuses an action the relay must never forward as a bad request', async () => {
    const { service } = await booted()
    const reply = await service.handle({ id: 'd-6', action: 'revoke' as never, accountId: ACCOUNT, payload: {} })
    expect(reply).toMatchObject({ status: 400, ownerBound: null, body: { error: { code: 'PC_WINDOW_BAD_REQUEST' } } })
  })
})

describe('diagnostics', () => {
  it('counts live bindings and stops counting revoked ones', async () => {
    const { service } = await booted()
    expect(service.activeBindings()).toBe(0)
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-2' })
    expect(service.activeBindings()).toBe(2)
    service.revokeAll()
    expect(service.activeBindings()).toBe(0)
  })

  it('reads the wall clock when the deployment names no other one', async () => {
    const store = await MobileSyncStore.open(':memory:', 8, 64)
    stores.push(store)
    const service = new PcWindowService(store, port().port, { pcId: PC, currentAccount: () => ACCOUNT, maxRequests: 8, timeoutMs: 2000 })
    services.push(service)
    const before = Date.now()
    const bootstrapped = await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    expect(store.binding(bootstrapped.binding)?.createdAt).toBeGreaterThanOrEqual(before)
  })
})

describe('lifetime', () => {
  it('refuses new work once disposed', async () => {
    const { service } = await booted()
    await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await service.dispose()
    services.length = 0
    await refuses(() => service.access(ACCOUNT, { binding: BINDING }), 'CLOSED')
    await refuses(() => service.submit(ACCOUNT, { command: command() }), 'CLOSED')
  })

  it('refuses an operation that outlives its deadline with the deadline own code', async () => {
    const { service } = await booted({ timeoutMs: 5 }, {
      listContinuable: (signal) => new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason as Error) }) }),
    })
    await refuses(() => service.bootstrap(ACCOUNT, { deviceId: 'phone-1' }), 'TIMEOUT')
  })

  it('waits for a command still in flight before closing the store under it', async () => {
    const { service, store } = await booted({}, {
      submit: (_sessionId, _rpcId, _text, signal, check) => {
        check()
        return new Promise((_resolve, reject) => { signal.addEventListener('abort', () => { reject(signal.reason as Error) }) })
      },
      admitted: () => Promise.resolve(false),
    })
    const bootstrapped = await service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    const key = store.binding(bootstrapped.binding)!.key
    const pending = service.submit(ACCOUNT, { command: command() })
    await vi.waitFor(() => { expect(store.receipt(key, 'req-1')).toBeDefined() })
    const disposed = service.dispose()
    services.length = 0
    await refuses(() => pending, 'CLOSED')
    await disposed
    await refuses(() => service.activeBindings(), 'CLOSED')
  })

  it('refuses work past the concurrent request ceiling', async () => {
    let release = (): void => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const { service } = await booted({ maxRequests: 1 }, { listContinuable: async () => {
      await gate
      return [{ sessionId: 'sess-1', updatedAt: 200, running: false }]
    } })
    const first = service.bootstrap(ACCOUNT, { deviceId: 'phone-1' })
    await refuses(() => service.bootstrap(ACCOUNT, { deviceId: 'phone-2' }), 'CAPACITY')
    release()
    await first
  })
})
