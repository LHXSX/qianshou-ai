/** Atomic owner switches use committed policy rather than a conservative identity-unknown view. */
import { afterEach, expect, it, vi } from 'vitest'
import { SupplyController } from '../../src/supply/controller.ts'
import type { BoundSupplyPolicyStore, SupplyOwnerBinding } from '../../src/supply/policy.ts'
import type { OwnerSupplyCommand, SupplyPolicy, SupplyProbeResult } from '../../src/supply/types.ts'

const owner = { ownerId: 7, nodeId: 'owner-node' }
const gitRate = { localServiceId: 'git', amountMinor: 10, unit: 'task', currency: 'CNY' }
const policy: SupplyPolicy = { mode: 'allowed', maxConcurrency: 3, minIdleSeconds: 60,
  minFreeMemoryBytes: 128, enabledServiceIds: ['git', 'node'], nodeRates: [
    gitRate,
    { localServiceId: 'node', amountMinor: 5, unit: 'minute', currency: 'CNY' }] }
const facts: SupplyProbeResult = { hardware: { platform: 'test', arch: 'test', cpuModel: 'fixture', logicalCores: 2,
  totalMemoryBytes: 1024, freeMemoryBytes: 512, gpus: [], probeErrors: [] },
localServices: [{ id: 'node', kind: 'tool', name: 'Node', version: '24', verification: 'verified', reason: null }],
activity: { idleSeconds: 120, foregroundTaskActive: false, voiceActive: false } }
const controllers: SupplyController[] = []
afterEach(async () => { await Promise.all(controllers.splice(0).map(controller => controller.close())) })

function fixture(options: { saved?: SupplyPolicy | null; binding?: SupplyOwnerBinding | null; standalone?: boolean } = {}) {
  let current: SupplyOwnerBinding | null = null
  const readCurrent = vi.fn(async () => current)
  const saved = options.saved === undefined ? policy : options.saved
  const savedBinding = options.binding === undefined ? owner : options.binding
  const forWrite = vi.fn(async (): Promise<SupplyOwnerBinding | null> => { current = owner; return current })
  const save = vi.fn(async (_next: SupplyPolicy) => {})
  const saveBound = vi.fn(async (_next: SupplyPolicy, _binding: SupplyOwnerBinding) => {})
  const store: BoundSupplyPolicyStore = { load: async () => saved, save,
    loadBound: async () => ({ policy: saved, binding: savedBinding }), saveBound }
  const withdraw = vi.fn(async (_signal: AbortSignal) => {})
  const controller = new SupplyController({ initialPolicy: policy, policyStore: store,
    ...(options.standalone ? {} : { ownerBinding: { current: readCurrent, forWrite } }),
    probe: async () => facts, activeTaskCount: () => 0, operationTimeoutMs: 5000,
    advertisement: { connected: () => true, publish: async () => ['fixture'], withdraw } })
  controllers.push(controller)
  return { controller, save, saveBound, forWrite, withdraw, readCurrent }
}

it('restores the same owner and merges only mode, preserving rates and limits', async () => {
  const f = fixture()
  expect(await f.controller.ownerPolicy()).toMatchObject({ mode: 'off', enabledServiceIds: [], nodeRates: [] })
  await f.controller.updateOwnerSupply({ kind: 'mode', mode: 'idle' })
  expect(f.saveBound).toHaveBeenCalledExactlyOnceWith({ ...policy, mode: 'idle' }, owner)
  expect(f.forWrite).toHaveBeenCalledTimes(2)
  expect(f.save).not.toHaveBeenCalled()
})

it('restores the same owner and revokes only the selected grant and its rate without changing mode', async () => {
  const f = fixture()
  await f.controller.ownerPolicy()
  await f.controller.updateOwnerSupply({ kind: 'local-service', serviceId: 'node', enabled: false })
  expect(f.saveBound).toHaveBeenCalledExactlyOnceWith({ ...policy, enabledServiceIds: ['git'], nodeRates: [gitRate] }, owner)
})

it('preserves other grants and all existing rates when enabling the same owner service', async () => {
  const initial = { ...policy, enabledServiceIds: ['git'], nodeRates: [gitRate] }
  const f = fixture({ saved: initial })
  await f.controller.updateOwnerSupply({ kind: 'local-service', serviceId: 'node', enabled: true })
  expect(f.saveBound).toHaveBeenCalledExactlyOnceWith({ ...initial, enabledServiceIds: ['git', 'node'] }, owner)
})

const scopes: { label: string; saved: SupplyPolicy | null; binding: SupplyOwnerBinding | null }[] = [
  { label: 'factory first use', saved: null, binding: null },
  { label: 'legacy unbound policy', saved: policy, binding: null },
  { label: 'another owner', saved: policy, binding: { ...owner, ownerId: 8 } },
  { label: 'the same account on another node', saved: policy, binding: { ...owner, nodeId: 'previous-node' } },
]
it.each(scopes)('starts $label with empty grants for an explicit master command', async (options) => {
  const f = fixture(options)
  await f.controller.updateOwnerSupply({ kind: 'mode', mode: 'idle' })
  expect(f.saveBound).toHaveBeenCalledExactlyOnceWith({ ...policy, mode: 'idle', enabledServiceIds: [], nodeRates: [] }, owner)
})

it.each(scopes)('starts $label with only the explicitly authorized service and keeps the master off', async (options) => {
  const f = fixture(options)
  await f.controller.updateOwnerSupply({ kind: 'local-service', serviceId: 'node', enabled: true })
  expect(f.saveBound).toHaveBeenCalledExactlyOnceWith({ ...policy, mode: 'off', enabledServiceIds: ['node'], nodeRates: [] }, owner)
})

it('keeps standalone clients on their existing local policy contract', async () => {
  const f = fixture({ standalone: true })
  await f.controller.updateOwnerSupply({ kind: 'mode', mode: 'off' })
  expect(f.save).toHaveBeenCalledExactlyOnceWith({ ...policy, mode: 'off' })
  expect(f.saveBound).not.toHaveBeenCalled(); expect(f.forWrite).not.toHaveBeenCalled()
})

it('does not write when identity cannot be restored', async () => {
  const f = fixture(); f.forWrite.mockResolvedValue(null)
  await expect(f.controller.updateOwnerSupply({ kind: 'mode', mode: 'idle' })).rejects.toThrow('SUPPLY_OWNER_IDENTITY_UNAVAILABLE')
  expect(f.saveBound).not.toHaveBeenCalled(); expect(f.save).not.toHaveBeenCalled()
})

it.each([{ ...owner, ownerId: 8 }, { ...owner, nodeId: 'replacement-node' }, null])('rejects identity changing during withdrawal', async (latest) => {
  const f = fixture(); f.forWrite.mockResolvedValueOnce(owner).mockResolvedValueOnce(latest)
  await expect(f.controller.updateOwnerSupply({ kind: 'mode', mode: 'idle' })).rejects.toThrow('SUPPLY_OWNER_IDENTITY_UNAVAILABLE')
  expect(f.withdraw).toHaveBeenCalled(); expect(f.saveBound).not.toHaveBeenCalled()
})

it.each(['before', 'after'] as const)('preserves author worker authority %s withdrawal', async (phase) => {
  const f = fixture(); const assertCurrent = vi.fn(async () => {})
  if (phase === 'before') assertCurrent.mockRejectedValueOnce(new Error('worker changed'))
  else assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('worker changed'))
  await expect(f.controller.updateOwnerSupply({ kind: 'local-service', serviceId: 'node', enabled: true },
    { expectedOwnerId: owner.ownerId, assertCurrent })).rejects.toThrow()
  expect(f.saveBound).not.toHaveBeenCalled()
})

it('refuses an old-author command when the restored account differs', async () => {
  const f = fixture()
  await f.controller.updateOwnerSupply({ kind: 'mode', mode: 'idle' })
  const other = { ...owner, ownerId: 8 }
  f.forWrite.mockResolvedValue(other)
  const assertCurrent = vi.fn(async () => { throw new Error('original author changed') })
  await expect(f.controller.updateOwnerSupply({ kind: 'local-service', serviceId: 'node', enabled: true },
    { expectedOwnerId: owner.ownerId, assertCurrent })).rejects.toThrow('SUPPLY_OWNER_IDENTITY_UNAVAILABLE')
  expect(f.saveBound).toHaveBeenCalledTimes(1)
})

it('cancels a queued old-author command before a new owner saves its empty-grant baseline', async () => {
  const f = fixture()
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const resumed = new Promise<void>((resolve) => { release = resolve })
  f.readCurrent.mockImplementationOnce(async () => { entered(); await resumed; return owner })
  const priorRead = f.controller.ownerPolicy()
  await started
  const assertCurrent = vi.fn(async () => {})
  const old = f.controller.updateOwnerSupply({ kind: 'local-service', serviceId: 'node', enabled: true },
    { expectedOwnerId: owner.ownerId, assertCurrent })
  const rejected = expect(old).rejects.toThrow('SUPPLY_ABORTED')
  const other = { ...owner, ownerId: 8 }
  f.forWrite.mockResolvedValue(other)
  const current = f.controller.updateOwnerSupply({ kind: 'mode', mode: 'idle' })
  release(); await priorRead; await rejected; await current
  expect(f.saveBound).toHaveBeenCalledExactlyOnceWith({ ...policy, mode: 'idle', enabledServiceIds: [], nodeRates: [] }, other)
  expect(assertCurrent).not.toHaveBeenCalled()
})

it('serializes switch changes against a previous complete-policy commit', async () => {
  const f = fixture()
  const latest = { ...policy, maxConcurrency: 4, minIdleSeconds: 99, enabledServiceIds: ['git'], nodeRates: [gitRate] }
  await f.controller.updateSupplyPolicy(latest)
  const command: OwnerSupplyCommand = { kind: 'local-service', serviceId: 'node', enabled: true }
  await f.controller.updateOwnerSupply(command)
  expect(f.saveBound).toHaveBeenLastCalledWith({ ...latest, enabledServiceIds: ['git', 'node'] }, owner)
})

it('keeps complete-policy validation separate from the partial-command port', () => {
  const f = fixture()
  expect(() => f.controller.updateSupplyPolicy({ kind: 'mode', mode: 'idle' } as unknown as SupplyPolicy))
    .toThrow('SUPPLY_POLICY_INVALID')
  expect(f.saveBound).not.toHaveBeenCalled()
})
