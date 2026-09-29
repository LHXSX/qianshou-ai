/** Author supply commits retain the initiating account while queued Host ports may change. */
import { afterEach, expect, it, vi } from 'vitest'
import { SupplyController } from '../../src/supply/controller.ts'
import type { BoundSupplyPolicyStore, SupplyOwnerBinding } from '../../src/supply/policy.ts'
import type { SupplyPolicy, SupplyProbeResult } from '../../src/supply/types.ts'

const ownerA = 7
const ownerB = 8
const nodeId = 'author-node-1'
const policy: SupplyPolicy = { mode: 'off', maxConcurrency: 2, minFreeMemoryBytes: 0,
  minIdleSeconds: 60, enabledServiceIds: ['git'], nodeRates: [] }
const enabled: SupplyPolicy = { ...policy, mode: 'idle', enabledServiceIds: ['git', 'node'] }
const controllers: SupplyController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.close())) })

function barrier() {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { started, release, wait: async () => { entered(); await released } }
}

function fixture() {
  let ownerId = ownerA
  let workerCurrent = true
  const binding = (): SupplyOwnerBinding => Object.freeze({ ownerId, nodeId })
  const current = vi.fn(async () => binding())
  const forWrite = vi.fn(async () => binding())
  const save = vi.fn(async (_policy: SupplyPolicy) => {})
  const saveBound = vi.fn(async (_policy: SupplyPolicy, _binding: SupplyOwnerBinding) => {})
  const store: BoundSupplyPolicyStore = { load: async () => policy, save,
    loadBound: async () => ({ policy, binding: { ownerId: ownerA, nodeId } }), saveBound }
  const withdraw = vi.fn(async (_signal: AbortSignal) => {})
  const facts: SupplyProbeResult = { hardware: { platform: 'test', arch: 'test', cpuModel: 'fixture', logicalCores: 2,
    totalMemoryBytes: 1024, freeMemoryBytes: 512, gpus: [], probeErrors: [] },
  localServices: [{ id: 'node', kind: 'tool', name: 'Node', version: '24', verification: 'verified', reason: null }],
  activity: { idleSeconds: 120, foregroundTaskActive: false, voiceActive: false } }
  const controller = new SupplyController({ initialPolicy: policy, policyStore: store,
    ownerBinding: { current, forWrite }, probe: async () => facts, activeTaskCount: () => 0,
    operationTimeoutMs: 5000, advertisement: { connected: () => true, publish: async () => ['author-task'], withdraw } })
  controllers.push(controller)
  const assertCurrent = vi.fn(async () => {
    if (ownerId !== ownerA || !workerCurrent) throw new Error('author identity changed')
  })
  return { controller, current, forWrite, save, saveBound, withdraw, assertCurrent,
    guard: { expectedOwnerId: ownerA, assertCurrent },
    switchAccount: () => { ownerId = ownerB }, switchWorker: () => { workerCurrent = false } }
}

it('commits the author policy with the exact initiating owner and node', async () => {
  const f = fixture()
  await expect(f.controller.updateBoundSupplyPolicy(enabled, f.guard)).resolves.toMatchObject({
    ownerPolicy: enabled, eligibility: { state: 'ready' } })
  expect(f.saveBound).toHaveBeenCalledExactlyOnceWith(enabled, { ownerId: ownerA, nodeId })
  expect(f.save).not.toHaveBeenCalled()
  expect(f.assertCurrent).toHaveBeenCalled()
  expect(f.withdraw.mock.invocationCallOrder[0]).toBeLessThan(f.saveBound.mock.invocationCallOrder[0]!)
})

it('refuses an account switch while the author write waits in the real controller queue', async () => {
  const f = fixture(); const queued = barrier()
  f.current.mockImplementationOnce(async () => { await queued.wait(); return { ownerId: ownerA, nodeId } })
  const earlier = f.controller.ownerPolicy()
  await queued.started
  const pending = f.controller.updateBoundSupplyPolicy(enabled, f.guard)
  const rejected = expect(pending).rejects.toThrow()
  f.switchAccount(); queued.release()
  await earlier; await rejected
  expect(f.saveBound).not.toHaveBeenCalled()
  expect(f.save).not.toHaveBeenCalled()
})

it('refuses a changed owner returned by the queued forWrite port', async () => {
  const f = fixture(); const identity = barrier()
  f.forWrite.mockImplementationOnce(async () => { await identity.wait(); return { ownerId: ownerB, nodeId } })
  const pending = f.controller.updateBoundSupplyPolicy(enabled, f.guard)
  const rejected = expect(pending).rejects.toThrow()
  await identity.started; f.switchAccount(); identity.release(); await rejected
  expect(f.saveBound).not.toHaveBeenCalled()
  expect(f.save).not.toHaveBeenCalled()
})

it('rechecks the author owner after transport withdrawal before saving', async () => {
  const f = fixture(); const withdrawal = barrier()
  f.withdraw.mockImplementationOnce(async () => { await withdrawal.wait() })
  const pending = f.controller.updateBoundSupplyPolicy(enabled, f.guard)
  const rejected = expect(pending).rejects.toThrow()
  await withdrawal.started; f.switchAccount(); withdrawal.release(); await rejected
  expect(f.saveBound).not.toHaveBeenCalled()
  expect(f.save).not.toHaveBeenCalled()
})

it('refuses a changed owner returned by the second forWrite port after withdrawal', async () => {
  const f = fixture()
  f.forWrite.mockResolvedValueOnce({ ownerId: ownerA, nodeId }).mockResolvedValueOnce({ ownerId: ownerB, nodeId })
  await expect(f.controller.updateBoundSupplyPolicy(enabled, f.guard)).rejects.toThrow()
  expect(f.withdraw).toHaveBeenCalledOnce()
  expect(f.saveBound).not.toHaveBeenCalled()
})

it.each(['before-write', 'during-withdrawal'] as const)('does not persist when the worker changes %s', async stage => {
  const f = fixture()
  if (stage === 'before-write') f.switchWorker()
  else f.withdraw.mockImplementationOnce(async () => { f.switchWorker() })
  await expect(f.controller.updateBoundSupplyPolicy(enabled, f.guard)).rejects.toThrow()
  expect(f.assertCurrent).toHaveBeenCalled()
  expect(f.saveBound).not.toHaveBeenCalled()
  expect(f.save).not.toHaveBeenCalled()
})
