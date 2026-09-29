// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { SharingController } from '../src/client/help/sharing-controller.ts'
import { SHARING_CONSENT_VERSION, type SharingSnapshot } from '../src/client/help/sharing-types.ts'
import type { SharingTransport } from '../src/client/help/sharing-transport.ts'

const scopeId = '10000000-0000-4000-8000-000000000001'
const otherScope = '10000000-0000-4000-8000-000000000002'
function receipt(phase: 'idle' | 'sharing' = 'idle'): SharingSnapshot {
  return { schema: 'qianshou.compute-sharing.v1', authenticated: true, scopeId, operation: null, hardware: null,
    modes: (['image', 'video'] as const).map(mode => ({ mode, phase, operationId: null, modelName: null,
      authorization: { connection: 'required', execution: 'disabled', deviceBound: false },
      downloadedBytes: null, totalDownloadBytes: null, completedSteps: [], reason: null,
      completedCalls: null, settledYuan: null })) }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
function confirmation(controller: SharingController) {
  const intent = controller.store.getSnapshot().confirmation
  if (intent === null) throw new Error('Expected an explicit confirmation')
  return intent
}
it('finishes a timed-out local status read even when IPC ignores abort, and discards its late response', async () => {
  vi.useFakeTimers()
  const stalled = deferred<SharingSnapshot>()
  const read = vi.fn<SharingTransport['read']>().mockReturnValueOnce(stalled.promise).mockResolvedValueOnce(receipt())
  const command = vi.fn<SharingTransport['command']>()
  const controller = new SharingController({ read, command })
  try {
    const pending = controller.refresh()
    await vi.advanceTimersByTimeAsync(10000)
    await pending
    expect(controller.store.getSnapshot().phase).toBe('unavailable')
    await controller.refresh()
    expect(controller.store.getSnapshot().phase).toBe('ready')
    stalled.resolve(receipt('sharing'))
    await Promise.resolve(); await Promise.resolve()
    expect(controller.store.getSnapshot().snapshot?.modes[0]?.phase).toBe('idle')
    expect(command).not.toHaveBeenCalled()
  } finally { controller.dispose(); vi.useRealTimers() }
})
it('withdraws API confirmation and friendly labels when the current status read fails', async () => {
  const initial = receipt(), snapshot: SharingSnapshot = { ...initial,
    modes: initial.modes.map(row => ({ ...row, api: { status: 'ready', adapter: 'qianshou_image',
      modelName: 'Qwen Image 2.1 (INT8 ConvRot)', workflowName: 'Qwen Image 2.1 text-to-image',
      registration: 'registered', probeStatus: 'passed', lastProbedAt: new Date().toISOString() } })) }
  const read = vi.fn<SharingTransport['read']>().mockResolvedValueOnce(snapshot).mockRejectedValueOnce(new Error('Disconnected'))
  const command = vi.fn<SharingTransport['command']>(async () => snapshot)
  const controller = new SharingController({ read, command })
  try {
    await controller.refresh()
    expect(controller.store.getSnapshot().snapshot?.modes[0]?.api?.probeStatus).toBe('passed')
    await controller.refresh()
    expect(controller.store.getSnapshot().snapshot?.modes[0]?.api).toEqual({ status: 'unknown', adapter: null,
      modelName: null, workflowName: null, registration: 'unknown', probeStatus: 'unknown', lastProbedAt: null })
    expect(command).not.toHaveBeenCalled()
  } finally { controller.dispose() }
})
it('consumes only the confirmed mode and scope once before an asynchronous POST', async () => {
  const pending = deferred<SharingSnapshot>()
  const command = vi.fn<SharingTransport['command']>(() => pending.promise)
  const controller = new SharingController({ read: async () => receipt(), command })
  await controller.refresh()
  await controller.command('image', 'enable')
  const cancelled = confirmation(controller)
  expect(command).not.toHaveBeenCalled()
  controller.cancelConfirmation(cancelled.requestId)
  await controller.confirm(cancelled.requestId, cancelled.scopeId)
  expect(command).not.toHaveBeenCalled()
  await controller.command('video', 'enable')
  const intent = confirmation(controller)
  const operation = controller.confirm(intent.requestId, intent.scopeId)
  await controller.confirm(intent.requestId, intent.scopeId)
  await controller.command('image', 'enable')
  expect(command).toHaveBeenCalledOnce()
  expect(command.mock.calls[0]?.[0]).toEqual({ ...intent, action: 'enable', consent: {
    version: SHARING_CONSENT_VERSION, connection: true, execution: 'idle_only' } })
  expect(command.mock.calls[0]?.[0].requestId).toMatch(/^[0-9a-f-]{36}$/u)
  pending.resolve({ ...receipt(), operation: { requestId: intent.requestId, mode: 'video', action: 'enable', status: 'applied' } })
  await operation
  expect(controller.store.getSnapshot().pendingOperation).toBeNull()
  controller.dispose()
})
it('queries the original UUID after a lost acknowledgement and never replays authorization', async () => {
  const read = vi.fn<SharingTransport['read']>(async (_signal, requestId) => requestId === undefined ? receipt()
    : { ...receipt(), operation: { requestId, mode: 'image', action: 'enable', status: 'applied' } })
  const command = vi.fn<SharingTransport['command']>(async () => { throw new Error('Lost acknowledgement') })
  const controller = new SharingController({ read, command })
  await controller.refresh(); await controller.command('image', 'enable')
  const intent = confirmation(controller)
  await controller.confirm(intent.requestId, intent.scopeId)
  expect(command).toHaveBeenCalledOnce()
  expect(read.mock.calls[1]?.[1]).toBe(intent.requestId)
  expect(controller.store.getSnapshot()).toMatchObject({ phase: 'ready', pendingOperation: null, actionFailed: false })
  await controller.refresh()
  expect(command).toHaveBeenCalledOnce()
  controller.dispose()
})
it('retains a mismatched operation as unknown, then requires a new confirmation after exact not_found', async () => {
  let found = false
  const read = vi.fn<SharingTransport['read']>(async (_signal, requestId) => requestId === undefined ? receipt() : {
    ...receipt(), operation: found ? { requestId, status: 'not_found', mode: null, action: null }
      : { requestId, status: 'applied', mode: 'video', action: 'enable' } })
  const command = vi.fn<SharingTransport['command']>(async () => { throw new Error('Lost acknowledgement') })
  const controller = new SharingController({ read, command })
  await controller.refresh(); await controller.command('image', 'enable')
  const intent = confirmation(controller)
  await controller.confirm(intent.requestId, intent.scopeId)
  await controller.command('image', 'enable')
  expect(controller.store.getSnapshot()).toMatchObject({ actionFailed: true, confirmation: null,
    pendingOperation: { requestId: intent.requestId } })
  found = true; await controller.refresh()
  expect(read.mock.calls.at(-1)?.[1]).toBe(intent.requestId)
  expect(controller.store.getSnapshot()).toMatchObject({ pendingOperation: null, actionFailed: true })
  await controller.command('image', 'enable')
  expect(confirmation(controller).requestId).not.toBe(intent.requestId)
  expect(command).toHaveBeenCalledOnce()
  controller.dispose()
})
it('invalidates old dialogs and late POST receipts without authorizing the next account', async () => {
  const pending = deferred<SharingSnapshot>()
  let currentScope = scopeId
  const command = vi.fn<SharingTransport['command']>(() => pending.promise)
  const controller = new SharingController({ read: async () => ({ ...receipt(), scopeId: currentScope }), command })
  await controller.refresh(); await controller.command('image', 'enable')
  const oldDialog = confirmation(controller)
  currentScope = otherScope; controller.invalidate()
  await vi.waitFor(() => expect(controller.store.getSnapshot().snapshot?.scopeId).toBe(otherScope))
  await controller.command('video', 'enable')
  const nextDialog = confirmation(controller)
  await controller.confirm(oldDialog.requestId, oldDialog.scopeId)
  expect(command).not.toHaveBeenCalled()
  expect(confirmation(controller)).toEqual(nextDialog)
  const operation = controller.confirm(nextDialog.requestId, nextDialog.scopeId)
  currentScope = scopeId; controller.invalidate()
  await vi.waitFor(() => expect(controller.store.getSnapshot().snapshot?.scopeId).toBe(scopeId))
  expect(command.mock.calls[0]?.[1].aborted).toBe(true)
  pending.resolve({ ...receipt('sharing'), scopeId: otherScope,
    operation: { requestId: nextDialog.requestId, mode: 'video', action: 'enable', status: 'applied' } })
  await operation
  expect(controller.store.getSnapshot()).toMatchObject({ confirmation: null, pendingOperation: null,
    snapshot: { scopeId, modes: [{ phase: 'idle' }, { phase: 'idle' }] } })
  expect(command).toHaveBeenCalledOnce()
  controller.dispose()
})
it('cannot upgrade old desired state or a legacy Host into a new authorization', async () => {
  const command = vi.fn<SharingTransport['command']>()
  const controller = new SharingController({ read: async () => ({ ...receipt('sharing'), scopeId: null }), command })
  await controller.refresh(); await controller.command('image', 'enable'); await controller.command('video', 'resume')
  expect(controller.store.getSnapshot().confirmation).toBeNull()
  expect(command).not.toHaveBeenCalled()
  controller.dispose()
})
it.each(['image', 'video'] as const)('continues %s setup once using only its current device-bound idle authorization', async (mode) => {
  const initial = receipt()
  const snapshot: SharingSnapshot = { ...initial, modes: initial.modes.map(row => row.mode === mode
    ? { ...row, authorization: { connection: 'granted', execution: 'idle_only', deviceBound: true } } : row) }
  const pending = deferred<SharingSnapshot>()
  const command = vi.fn<SharingTransport['command']>(() => pending.promise)
  const controller = new SharingController({ read: async () => snapshot, command })
  try {
    await controller.refresh()
    const first = controller.command(mode, 'enable')
    await controller.command(mode, 'enable')
    expect(controller.store.getSnapshot().confirmation).toBeNull()
    expect(command).toHaveBeenCalledOnce()
    const intent = command.mock.calls[0]?.[0]
    if (intent === undefined) throw new Error('Expected a preparation operation')
    expect(intent).toMatchObject({ mode, action: 'enable', scopeId,
      consent: { version: SHARING_CONSENT_VERSION, connection: true, execution: 'idle_only' } })
    pending.resolve({ ...snapshot, operation: { requestId: intent.requestId, mode, action: 'enable', status: 'applied' } })
    await first
    expect(controller.store.getSnapshot().pendingOperation).toBeNull()
  } finally { controller.dispose() }
})
it.each([
  { connection: 'granted', execution: 'disabled', deviceBound: true },
  { connection: 'granted', execution: 'idle_only', deviceBound: false },
  { connection: 'revoked', execution: 'idle_only', deviceBound: true },
] as const)('does not reuse partial or revoked authorization: %j', async (authorization) => {
  const initial = receipt()
  const snapshot: SharingSnapshot = { ...initial, modes: initial.modes.map(row => ({ ...row, authorization })) }
  const command = vi.fn<SharingTransport['command']>()
  const controller = new SharingController({ read: async () => snapshot, command })
  try {
    await controller.refresh(); await controller.command('image', 'enable')
    expect(command).not.toHaveBeenCalled()
    expect(confirmation(controller)).toMatchObject({ mode: 'image', action: 'enable', scopeId })
  } finally { controller.dispose() }
})
it('retains display data on a failed refresh but clears it on account change or disposal', async () => {
  const read = vi.fn<SharingTransport['read']>()
    .mockResolvedValueOnce(receipt('sharing')).mockRejectedValueOnce(new Error('offline'))
    .mockRejectedValueOnce(new Error('signed out'))
  const controller = new SharingController({ read, command: vi.fn() })
  await controller.refresh()
  await controller.refresh()
  expect(controller.store.getSnapshot()).toMatchObject({ phase: 'unavailable', readFailure: 'unknown', snapshot: { authenticated: true } })
  controller.invalidate()
  expect(controller.store.getSnapshot().snapshot).toBeNull()
  controller.dispose()
  await controller.refresh()
  expect(read).toHaveBeenCalledTimes(3)
})

it('starts probing immediately, polls continuously and withdraws old connected observations after a failed refresh', async () => {
  vi.useFakeTimers()
  const now = Math.floor(Date.now() / 1000)
  const initial = receipt()
  const observed: SharingSnapshot = { ...initial, modes: initial.modes.map(mode => ({ ...mode, local: { inventory: 'detected',
    modelCount: 3, runtime: 'ready', adapter: 'qianshou_image', adoption: 'verification_required', checkedAt: now } })) }
  const read = vi.fn<SharingTransport['read']>().mockResolvedValueOnce({ ...observed, connection: {
    gateway: 'reachable', deviceAuthorization: 'authorized', channel: 'connected', heartbeat: 'accepted',
    checkedAt: now, heartbeatAt: now,
  } }).mockRejectedValueOnce(new Error('local Host unavailable')).mockResolvedValue({ ...receipt(), authenticated: false,
    connection: { gateway: 'reachable', deviceAuthorization: 'unknown', channel: 'idle', heartbeat: 'unknown',
      checkedAt: now, heartbeatAt: null } })
  const command = vi.fn<SharingTransport['command']>(); const controller = new SharingController({ read, command })
  try {
    controller.start()
    await vi.waitFor(() => expect(controller.store.getSnapshot().snapshot?.connection?.channel).toBe('connected'))
    expect(read).toHaveBeenCalledOnce(); expect(controller.store.getSnapshot().snapshot?.connection?.channel).toBe('connected')
    await vi.advanceTimersByTimeAsync(5000)
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'unavailable', snapshot: { connection: {
      gateway: 'unknown', deviceAuthorization: 'unknown', channel: 'offline', heartbeat: 'unknown', heartbeatAt: null } } })
    expect(controller.store.getSnapshot().snapshot?.modes.every(mode => mode.local?.runtime === 'unknown'
      && mode.local.modelCount === null)).toBe(true)
    controller.invalidate()
    await vi.waitFor(() => expect(controller.store.getSnapshot().phase).toBe('ready'))
    expect(controller.store.getSnapshot().snapshot).toMatchObject({ authenticated: false,
      connection: { gateway: 'reachable', deviceAuthorization: 'unknown', channel: 'idle' } })
    expect(command).not.toHaveBeenCalled()
  } finally { controller.dispose(); vi.useRealTimers() }
})

it('bounds a hung status read and can recover through the next read without registration or command replay', async () => {
  vi.useFakeTimers()
  const read = vi.fn<SharingTransport['read']>().mockImplementationOnce(signal => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => { reject(new Error('status deadline')) }, { once: true })
  })).mockResolvedValue(receipt())
  const command = vi.fn<SharingTransport['command']>(); const controller = new SharingController({ read, command })
  try {
    const pending = controller.refresh(); await vi.advanceTimersByTimeAsync(10000); await pending
    expect(read.mock.calls[0]?.[0].aborted).toBe(true)
    expect(controller.store.getSnapshot()).toMatchObject({ phase: 'unavailable', readFailure: 'timeout' })
    await controller.refresh(); expect(controller.store.getSnapshot().phase).toBe('ready')
    expect(read).toHaveBeenCalledTimes(2); expect(command).not.toHaveBeenCalled()
  } finally { controller.dispose(); vi.useRealTimers() }
})
