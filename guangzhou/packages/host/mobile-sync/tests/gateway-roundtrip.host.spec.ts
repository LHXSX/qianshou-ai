/**
 * The PC session gateway over the real network stack.
 *
 * Every request here travels through a real `node:http` socket, the real webserver
 * plugin, the real Connection carrier with its Host fence and browser
 * authentication, the real gateway routes, the real durable command log and the
 * real gateway service. The one configured double is the PC's Session authority,
 * and it exists so the gateway's delivery claims can be falsified: a failing
 * authority is how the tests prove that "not delivered" is never reported as
 * delivered.
 */
import { mkdir } from 'node:fs/promises'
import { afterEach, describe, expect, it } from 'vitest'
import {
  releaseSession, removeHome, seedCommandRecord, startGatewayHarness, type GatewayHarness,
} from './gateway-harness.ts'
import type { WindowAction, WindowBinding, WindowCommand } from '../src/gateway/types.ts'

const PHONE: WindowBinding = {
  accountId: 'account-owner',
  pcId: 'pc-desk-01',
  sessionId: 'session-primary',
  sourceDeviceId: 'phone-01',
}
/** Base instant for command lifetimes, taken from the real clock so no case expires over time. */
const EPOCH = Date.now()

const harnesses: GatewayHarness[] = []
const homes: string[] = []
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map(harness => harness.dispose()))
  await Promise.all(homes.splice(0).map(home => removeHome(home)))
})

async function boot(config: Parameters<typeof startGatewayHarness>[0] = {}): Promise<GatewayHarness> {
  const harness = await startGatewayHarness(config)
  harnesses.push(harness)
  if (config.home === undefined) homes.push(harness.home)
  return harness
}

/** A well-formed phone command; every field is explicit so a change is always deliberate. */
function command(overrides: {
  requestId: string
  action?: WindowAction
  origin?: Partial<WindowBinding>
  createdAt?: number
  expiresAt?: number
}): WindowCommand {
  return {
    requestId: overrides.requestId,
    origin: { ...PHONE, ...overrides.origin },
    createdAt: overrides.createdAt ?? EPOCH,
    expiresAt: overrides.expiresAt ?? EPOCH + 600_000,
    action: overrides.action ?? { type: 'dispatch', text: 'continue on the PC' },
  }
}

/** A deliberately malformed command body, for the rejection cases only. */
function malformed(body: Record<string, unknown>): Record<string, unknown> {
  return { requestId: body.requestId, origin: PHONE, createdAt: EPOCH, expiresAt: EPOCH + 600_000, ...body }
}

/** Register the standard binding through the host-side pairing API. */
async function bind(harness: GatewayHarness, binding: WindowBinding = PHONE): Promise<void> {
  await harness.gateway.registerBinding(binding)
}

describe('PC session gateway over a real HTTP socket', () => {
  it('completes a real dispatch round trip and binds the receipt to the origin', async () => {
    const harness = await boot()
    await bind(harness)

    const access = await harness.post('/api/qianshou/mobile/pc-window/access', { binding: PHONE })
    expect(access.status).toBe(200)
    expect(access.body).toEqual({ state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] })

    const sent = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-dispatch-1' }) })
    expect(sent.status).toBe(200)
    expect(sent.body).toEqual({
      outcome: 'executed',
      mayResend: false,
      receipt: {
        requestId: 'req-dispatch-1', origin: PHONE, revision: 1, state: 'received',
        childSessionId: 'session-primary', reason: 'session-admitted',
      },
    })
    // The authority was asked exactly once, for the bound conversation.
    expect(harness.session.calls).toEqual([
      { kind: 'dispatch', requestId: 'req-dispatch-1', sessionId: 'session-primary' },
    ])

    const page = await harness.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: [] })
    expect(page.status).toBe(200)
    expect(page.body).toEqual({
      binding: PHONE,
      fromCursor: null,
      nextCursor: 'qianshou.pc-window.cursor.v1:1',
      receipts: [{
        requestId: 'req-dispatch-1', origin: PHONE, revision: 1, state: 'received',
        childSessionId: 'session-primary', reason: 'session-admitted',
      }],
      notReceivedIds: [],
    })
  })

  it('refuses an append whose expected revision is not the one the gateway holds', async () => {
    const harness = await boot()
    await bind(harness)

    // The conversation starts at revision 1, so a control claiming revision 1 is
    // accepted and advances it; a control still claiming revision 1 is then stale.
    const first = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({
      requestId: 'req-append-1',
      action: { type: 'append', targetSessionId: 'session-primary', expectedRevision: 1, text: 'first follow-up' },
    }) })
    expect(first.status).toBe(200)
    expect(first.body).toMatchObject({ outcome: 'executed', receipt: { state: 'received', revision: 1 } })

    const stale = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({
      requestId: 'req-append-2',
      action: { type: 'append', targetSessionId: 'session-primary', expectedRevision: 1, text: 'blind write' },
    }) })
    expect(stale.status).toBe(409)
    expect(stale.body).toEqual({ error: {
      code: 'PC_WINDOW_REVISION_MISMATCH', message: 'PC_WINDOW_REVISION_MISMATCH',
      details: { expected: 1, actual: 2 },
    } })

    // The refused append never reached the Session authority, so the conversation
    // holds exactly one admitted follow-up.
    expect(harness.session.calls.map(call => call.requestId)).toEqual(['req-append-1'])

    // And the current revision is the one a caller must present to write again.
    const fresh = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({
      requestId: 'req-append-3',
      action: { type: 'append', targetSessionId: 'session-primary', expectedRevision: 2, text: 'second follow-up' },
    }) })
    expect(fresh.status).toBe(200)
    expect(fresh.body).toMatchObject({ receipt: { state: 'received', revision: 2 } })
  })

  it('refuses a cross-account and a cross-device origin without admitting anything', async () => {
    const harness = await boot()
    await bind(harness)

    // Same phone and conversation, but a different account: the binding exists
    // elsewhere, so this is a foreign origin rather than an unknown device.
    const foreignAccount = await harness.post('/api/qianshou/mobile/pc-window/submit', {
      command: command({ requestId: 'req-foreign-account', origin: { accountId: 'account-attacker' } }),
    })
    expect(foreignAccount.status).toBe(403)
    expect(foreignAccount.body).toMatchObject({ error: { code: 'PC_WINDOW_FOREIGN_ORIGIN' } })

    // Same account and conversation, but a different PC: also foreign.
    const foreignPc = await harness.post('/api/qianshou/mobile/pc-window/submit', {
      command: command({ requestId: 'req-foreign-pc', origin: { pcId: 'pc-laptop-99' } }),
    })
    expect(foreignPc.status).toBe(403)
    expect(foreignPc.body).toMatchObject({ error: { code: 'PC_WINDOW_FOREIGN_ORIGIN' } })

    // A phone that was never paired at all is reported as unknown, and the phone
    // learns it has no access instead of being told to retry.
    const otherPhone: WindowBinding = { ...PHONE, sourceDeviceId: 'phone-99' }
    const unknownDevice = await harness.post('/api/qianshou/mobile/pc-window/submit', {
      command: command({ requestId: 'req-unknown-device', origin: { sourceDeviceId: 'phone-99' } }),
    })
    expect(unknownDevice.status).toBe(403)
    expect(unknownDevice.body).toMatchObject({ error: { code: 'PC_WINDOW_BINDING_UNKNOWN' } })
    const denied = await harness.post('/api/qianshou/mobile/pc-window/access', { binding: otherPhone })
    expect(denied.body).toEqual({ state: 'unauthorized', allowedActions: [] })

    // None of the three attempts reached the Session authority.
    expect(harness.session.calls).toEqual([])
    // And they left no command behind for the paired phone to reconcile.
    const page = await harness.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: [] })
    expect(page.body).toMatchObject({ receipts: [], nextCursor: 'qianshou.pc-window.cursor.v1:0' })
  })

  it('refuses a control that targets a conversation other than its bound session', async () => {
    const harness = await boot()
    await bind(harness)

    const wrongTarget = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({
      requestId: 'req-wrong-target',
      action: { type: 'cancel', targetSessionId: 'session-somebody-else', expectedRevision: 1 },
    }) })
    expect(wrongTarget.status).toBe(409)
    expect(wrongTarget.body).toMatchObject({ error: { code: 'PC_WINDOW_TARGET_MISMATCH' } })
    expect(harness.session.calls).toEqual([])
  })

  it('executes a repeated submission exactly once and replays the durable receipt', async () => {
    const harness = await boot()
    await bind(harness)
    const body = { command: command({ requestId: 'req-idempotent-1' }) }

    const first = await harness.post('/api/qianshou/mobile/pc-window/submit', body)
    expect(first.body).toMatchObject({ outcome: 'executed', mayResend: false })

    // Three retries of the identical command: the durable record answers, and the
    // Session authority is never asked a second time.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const retry = await harness.post('/api/qianshou/mobile/pc-window/submit', body)
      expect(retry.status).toBe(200)
      expect(retry.body).toEqual({ ...first.body as object, outcome: 'replayed' })
    }
    expect(harness.session.calls).toHaveLength(1)
    expect(harness.session.admitted()).toEqual(['req-idempotent-1'])

    // One command also means exactly one receipt in the phone's stream.
    const page = await harness.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: [] })
    expect((page.body as { receipts: unknown[] }).receipts).toHaveLength(1)
    expect(page.body).toMatchObject({ nextCursor: 'qianshou.pc-window.cursor.v1:1' })
  })

  it('refuses to reuse one request id for a different command body', async () => {
    const harness = await boot()
    await bind(harness)
    await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-conflict-1' }) })

    const changed = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({
      requestId: 'req-conflict-1', action: { type: 'dispatch', text: 'a different instruction' },
    }) })
    expect(changed.status).toBe(409)
    expect(changed.body).toMatchObject({ error: { code: 'PC_WINDOW_REQUEST_CONFLICT' } })
    expect(harness.session.calls).toHaveLength(1)
  })

  it('reports an unavailable Session authority instead of pretending to deliver', async () => {
    const harness = await boot()
    await bind(harness)
    harness.session.setAvailable(false)

    const access = await harness.post('/api/qianshou/mobile/pc-window/access', { binding: PHONE })
    expect(access.body).toEqual({ state: 'unavailable', allowedActions: [] })

    const sent = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-no-authority' }) })
    expect(sent.status).toBe(503)
    // An unavailable authority is detected before any attempt exists, so the plain
    // refusal is itself the non-admission proof; no `admitted` claim is attached and
    // no phantom receipt is left behind for the phone to reconcile.
    expect(sent.body).toEqual({ error: { code: 'PC_WINDOW_SESSION_UNAVAILABLE', message: 'PC_WINDOW_SESSION_UNAVAILABLE' } })
    const page = await harness.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: ['req-no-authority'] })
    expect(page.body).toMatchObject({ receipts: [], notReceivedIds: [] })
  })

  it('never shows a command as delivered when its outcome cannot be proven', async () => {
    const harness = await boot()
    await bind(harness)
    // The authority refuses mid-flight and cannot say whether it admitted the
    // prompt, which is exactly the case that must stay undelivered.
    harness.session.failNext()

    const sent = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-uncertain-1' }) })
    expect(sent.status).toBe(503)
    expect(sent.body).toEqual({ error: {
      code: 'PC_WINDOW_SESSION_UNAVAILABLE', message: 'PC_WINDOW_SESSION_UNAVAILABLE',
      details: { admitted: false, reason: 'PC_WINDOW_SESSION_UNAVAILABLE', requestId: 'req-uncertain-1' },
    } })

    // The phone reviews the command; the gateway still cannot prove delivery, so it
    // emits no receipt at all and refuses to certify the command as not received.
    const page = await harness.post('/api/qianshou/mobile/pc-window/sync', {
      binding: PHONE, cursor: null, requestIds: ['req-uncertain-1'],
    })
    expect(page.body).toMatchObject({ receipts: [], notReceivedIds: [] })

    // A retry before reconciliation must not execute the command a second time.
    const retry = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-uncertain-1' }) })
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ outcome: 'replayed', mayResend: true, receipt: { state: 'uncertain', reason: 'PC_WINDOW_SESSION_UNAVAILABLE' } })
    expect(harness.session.calls).toHaveLength(1)

    // The uncertain state is durable, not an in-memory artifact of the answer.
    const durable = JSON.parse(await harness.durable()) as { commands: Record<string, { outcome: string; receipt: unknown }> }
    expect(durable.commands['req-uncertain-1']).toMatchObject({ outcome: 'uncertain', receipt: null })
  })

  it('upgrades an unproven command to delivered only when the Session log proves admission', async () => {
    const harness = await boot()
    await bind(harness)
    harness.session.failNext()
    await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-lost-answer' }) })

    // The authority did admit the prompt; only its answer was lost. The gateway
    // finds the request id in the Session's own durable log and reports delivery
    // from that evidence rather than from optimism.
    harness.session.reportAdmittedInLog(true)
    const recovered = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-lost-answer' }) })
    expect(recovered.status).toBe(200)
    expect(recovered.body).toMatchObject({ outcome: 'replayed', receipt: { state: 'received', revision: 1 } })

    const page = await harness.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: [] })
    expect(page.body).toMatchObject({ receipts: [{ requestId: 'req-lost-answer', state: 'received' }] })
  })

  it('reports a pending command as explicitly not received, which is what permits a resend', async () => {
    const harness = await boot()
    await bind(harness)
    // Catch the gateway mid-flight: the attempt is durable while the Session has
    // not answered yet.
    const slow = await startGatewayHarness({ home: harness.home, gateSession: true })
    harnesses.push(slow)
    await slow.gateway.registerBinding(PHONE)
    const inFlight = slow.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-in-flight' }) })
    await waitFor(async () => {
      const durable = JSON.parse(await slow.durable()) as { commands: Record<string, { outcome?: string }> }
      return durable.commands['req-in-flight']?.outcome === 'attempting'
    })

    // While the Session is still silent the command is neither delivered nor
    // refuted: no receipt, and no non-receipt proof either.
    const during = await slow.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: ['req-in-flight'] })
    expect(during.body).toMatchObject({ receipts: [], notReceivedIds: [] })

    await releaseSession(slow.home)
    const finished = await inFlight
    expect(finished.status).toBe(200)
    expect(finished.body).toMatchObject({ outcome: 'executed', receipt: { state: 'received' } })
    // Only now does the receipt exist, and the explicit non-receipt proof is gone.
    const after = await slow.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: ['req-in-flight'] })
    expect(after.body).toMatchObject({ receipts: [{ requestId: 'req-in-flight', state: 'received' }], notReceivedIds: [] })
  })

  it('survives a real restart and never executes a command twice', async () => {
    const first = await boot()
    await bind(first)
    const body = { command: command({ requestId: 'req-across-restart' }) }
    const sent = await first.post('/api/qianshou/mobile/pc-window/submit', body)
    expect(sent.body).toMatchObject({ outcome: 'executed' })
    expect(first.session.calls).toHaveLength(1)
    const home = first.home
    await first.dispose()
    harnesses.splice(harnesses.indexOf(first), 1)

    // A brand-new process with a brand-new in-memory Session authority and no
    // memory of the first attempt, loading the same durable directory.
    const second = await boot({ home })
    expect(second.session.calls).toEqual([])
    const retry = await second.post('/api/qianshou/mobile/pc-window/submit', body)
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ outcome: 'replayed', mayResend: false, receipt: { state: 'received', revision: 1 } })
    // The restarted gateway did not touch the Session at all.
    expect(second.session.calls).toEqual([])

    // The restarted gateway still holds the conversation revision the phone must
    // present, so a stale control is refused on the new instance too.
    const stale = await second.post('/api/qianshou/mobile/pc-window/submit', { command: command({
      requestId: 'req-after-restart-stale',
      action: { type: 'cancel', targetSessionId: 'session-primary', expectedRevision: 1 },
    }) })
    expect(stale.status).toBe(409)
    expect(stale.body).toMatchObject({ error: { code: 'PC_WINDOW_REVISION_MISMATCH', details: { expected: 1, actual: 2 } } })
  })

  it('reloads a crash-interrupted attempt as unproven and still refuses to re-execute it', async () => {
    const first = await boot()
    await bind(first)
    const home = first.home
    // The exact command body a retry resends, so the replay path is exercised
    // rather than the request-conflict path.
    const seeded = command({ requestId: 'req-crash-interrupted' })
    const body = { command: seeded }
    // A crash between the durable attempt write and the Session call leaves the
    // record exactly in this state.
    await seedCommandRecord(home, PHONE, seeded, 'attempting')
    await first.dispose()
    harnesses.splice(harnesses.indexOf(first), 1)

    const second = await boot({ home })
    // The reloaded record is not read as "never sent": the phone gets an
    // unproven outcome, and the Session is not asked to run it.
    const retry = await second.post('/api/qianshou/mobile/pc-window/submit', body)
    expect(retry.status).toBe(200)
    expect(retry.body).toMatchObject({ outcome: 'replayed', mayResend: true, receipt: { state: 'uncertain', reason: 'outcome-unproven' } })
    expect(second.session.calls).toEqual([])
    const page = await second.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: ['req-crash-interrupted'] })
    expect(page.body).toMatchObject({ receipts: [] })
  })

  it('refuses an expired command instead of executing it late', async () => {
    const harness = await boot()
    await bind(harness)
    const expired = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: command({
      requestId: 'req-expired-1', createdAt: EPOCH - 10_000_000, expiresAt: EPOCH - 1,
    }) })
    expect(expired.status).toBe(409)
    expect(expired.body).toMatchObject({ error: { code: 'PC_WINDOW_COMMAND_EXPIRED' } })
    expect(harness.session.calls).toEqual([])
  })

  it('refuses a cursor the gateway never issued instead of skipping unseen receipts', async () => {
    const harness = await boot()
    await bind(harness)
    const future = await harness.post('/api/qianshou/mobile/pc-window/sync', {
      binding: PHONE, cursor: 'qianshou.pc-window.cursor.v1:99', requestIds: [],
    })
    expect(future.status).toBe(409)
    expect(future.body).toMatchObject({ error: { code: 'PC_WINDOW_CURSOR_FUTURE' } })
    const opaque = await harness.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: 'some-cursor', requestIds: [] })
    expect(opaque.status).toBe(400)
    expect(opaque.body).toMatchObject({ error: { code: 'PC_WINDOW_COMMAND_INVALID' } })
  })

  it('refuses unauthenticated and foreign-Host requests before the handler runs', async () => {
    const harness = await boot()
    await bind(harness)
    const body = { command: command({ requestId: 'req-anonymous' }) }

    const anonymous = await harness.post('/api/qianshou/mobile/pc-window/submit', body, { cookie: undefined })
    expect([anonymous.status, anonymous.body]).toEqual([401, 'unauthorized'])
    const rebound = await harness.post('/api/qianshou/mobile/pc-window/submit', body, { host: 'attacker.example' })
    expect([rebound.status, rebound.body]).toEqual([403, 'forbidden'])

    expect(harness.session.calls).toEqual([])
    // The refusal wrote no command record; the only durable content is the binding
    // the test itself registered.
    const durable = JSON.parse(await harness.durable()) as { commands: Record<string, unknown> }
    expect(durable.commands).toEqual({})
  })

  it('returns a durable rejection for a malformed command without writing any state', async () => {
    const harness = await boot()
    await bind(harness)
    for (const bad of [
      malformed({ requestId: '', action: { type: 'dispatch', text: 'x' } }),
      malformed({ requestId: 'req-bad-2', expiresAt: EPOCH, action: { type: 'dispatch', text: 'x' } }),
      malformed({ requestId: 'req-bad-3', action: { type: 'append', targetSessionId: '', expectedRevision: 1, text: 'x' } }),
      malformed({ requestId: 'req-bad-4', action: { type: 'unknown' } }),
      malformed({ requestId: 'req-bad-5', expiresAt: EPOCH + 30 * 24 * 60 * 60 * 1000, action: { type: 'dispatch', text: 'x' } }),
      malformed({ requestId: 'req-bad-6', action: { type: 'append', targetSessionId: 'session-primary', expectedRevision: 0, text: 'x' } }),
    ]) {
      const refused = await harness.post('/api/qianshou/mobile/pc-window/submit', { command: bad })
      expect(refused.status).toBe(400)
      expect(refused.body).toMatchObject({ error: { code: 'PC_WINDOW_COMMAND_INVALID' } })
    }
    expect(harness.session.calls).toEqual([])
    const durable = JSON.parse(await harness.durable()) as { commands: Record<string, unknown> }
    expect(durable.commands).toEqual({})
  })
})

describe('gateway durable file integrity', () => {
  it('refuses a cursor page for an origin that is not bound', async () => {
    const harness = await boot()
    const unbound = await harness.post('/api/qianshou/mobile/pc-window/sync', { binding: PHONE, cursor: null, requestIds: [] })
    expect(unbound.status).toBe(403)
    expect(unbound.body).toMatchObject({ error: { code: 'PC_WINDOW_BINDING_UNKNOWN' } })
  })

  it('reports an unusable durable file instead of accepting commands anyway', async () => {
    const harness = await boot()
    // A directory where the command file belongs makes every read and write fail.
    const hostile = await startGatewayHarness({ home: harness.home })
    harnesses.push(hostile)
    await removeHome(hostile.windowPath)
    await mkdir(hostile.windowPath, { recursive: true })

    const refused = await hostile.post('/api/qianshou/mobile/pc-window/access', { binding: PHONE })
    expect(refused.status).toBe(503)
    expect(refused.body).toMatchObject({ error: { code: 'PC_WINDOW_STORE_UNAVAILABLE' } })
    // Command submission is refused for the same reason, and nothing is admitted.
    const sent = await hostile.post('/api/qianshou/mobile/pc-window/submit', { command: command({ requestId: 'req-broken-store' }) })
    expect(sent.status).toBe(503)
    expect(hostile.session.calls).toEqual([])
  })
})

/** Poll a condition until it holds, so a mid-flight state is observed rather than raced. */
async function waitFor(condition: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (await condition()) return
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('condition was never observed')
}
