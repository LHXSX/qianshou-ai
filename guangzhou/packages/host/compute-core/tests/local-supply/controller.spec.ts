import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SupplyController } from '../../src/supply/controller.ts'
import { FileSupplyPolicyStore, parseSupplyPolicy, type SupplyPolicyStore } from '../../src/supply/policy.ts'
import type { LocalSupplyService, SupplyPolicy, SupplyProbeResult } from '../../src/supply/types.ts'

const policy: SupplyPolicy = { mode: 'allowed', maxConcurrency: 1, minFreeMemoryBytes: 100, minIdleSeconds: 60,
  enabledServiceIds: ['python'], nodeRates: [] }
function facts(): SupplyProbeResult {
  return { hardware: { platform: 'test', arch: 'test', cpuModel: 'fixture', logicalCores: 2, totalMemoryBytes: 1024,
    freeMemoryBytes: 512, gpus: [], probeErrors: [] }, localServices: [
    { id: 'python', kind: 'tool', name: 'Python', version: '3.12', verification: 'verified', reason: null },
    { id: 'ollama:fixture', kind: 'local-model', name: 'Installed model', version: null, verification: 'pending', reason: 'MODEL_INFERENCE_NOT_VERIFIED' },
  ], activity: { idleSeconds: 100, foregroundTaskActive: false, voiceActive: false } }
}
function setup(initialPolicy: SupplyPolicy = policy, initialFacts = facts(), store?: SupplyPolicyStore) {
  const publish = vi.fn(async (_services: readonly LocalSupplyService[], _signal: AbortSignal) => ['word_count']); const withdraw = vi.fn(async () => {})
  const options = { initialPolicy, policyStore: store ?? { load: async () => null, save: async () => {} },
    probe: vi.fn(async () => initialFacts), activeTaskCount: () => 0, operationTimeoutMs: 1000,
    advertisement: { connected: () => true, publish, withdraw } }
  return { controller: new SupplyController(options), options, publish, withdraw }
}
describe('owner admission and transport authority', () => {
  it('requires a real transport acknowledgement separately from readiness', async () => {
    const { options } = setup()
    const { advertisement: _unused, ...withoutTransport } = options
    const controller = new SupplyController(withoutTransport)
    expect(await controller.querySupplySnapshot()).toMatchObject({ eligibility: { state: 'ready' }, advertisingState: 'not-connected', advertisedCapabilityIds: [] })
    await controller.close()
  })
  it('publishes verified enabled tools only and returns acknowledged IDs', async () => {
    const { controller, publish } = setup()
    expect(await controller.querySupplySnapshot()).toMatchObject({ advertisingState: 'advertising', advertisedCapabilityIds: ['word_count'] })
    expect(publish.mock.calls[0]?.[0].map(service => service.id)).toEqual(['python'])
    await controller.close()
  })
  it.each([
    [{ ...facts(), activity: { idleSeconds: 100, foregroundTaskActive: null, voiceActive: false } }, 'HOST_ACTIVITY_UNKNOWN'],
    [{ ...facts(), activity: { idleSeconds: 100, foregroundTaskActive: true, voiceActive: false } }, 'FOREGROUND_PRIORITY'],
    [{ ...facts(), activity: { idleSeconds: 100, foregroundTaskActive: false, voiceActive: true } }, 'FOREGROUND_PRIORITY'],
    [{ ...facts(), hardware: { ...facts().hardware, freeMemoryBytes: 1 } }, 'MEMORY_LIMIT'],
  ] as const)('withdraws when admission evidence blocks new work', async (snapshot, reason) => {
    const { controller, publish, withdraw } = setup(policy, snapshot)
    const actual = await controller.querySupplySnapshot()
    expect(actual.eligibility.reasons).toContain(reason); expect(actual.advertisingState).toBe('withdrawn')
    expect(publish).not.toHaveBeenCalled(); expect(withdraw).toHaveBeenCalledOnce()
    await controller.close()
  })
  it.each([null, 10])('does not call unknown/recent activity idle', async idleSeconds => {
    const state = facts(); const { controller } = setup({ ...policy, mode: 'idle' }, { ...state, activity: { ...state.activity, idleSeconds } })
    expect((await controller.querySupplySnapshot()).eligibility.reasons).toContain(idleSeconds === null ? 'IDLE_STATE_UNKNOWN' : 'USER_ACTIVE')
    await controller.close()
  })
  it('never publishes a merely installed local model', async () => {
    const { controller, publish } = setup({ ...policy, enabledServiceIds: ['ollama:fixture'] })
    expect((await controller.querySupplySnapshot()).eligibility.reasons).toContain('NO_VERIFIED_ENABLED_SERVICE')
    expect(publish).not.toHaveBeenCalled(); await controller.close()
  })
  it('withdraws before saving off and prevents stale in-flight publication', async () => {
    const events: string[] = []; let began!: () => void
    const started = new Promise<void>(resolve => { began = resolve })
    const { options } = setup()
    const controller = new SupplyController({ ...options, policyStore: { load: async () => null, save: async () => { events.push('save') } },
      advertisement: { connected: () => true, withdraw: async () => { events.push('withdraw') },
        publish: (_services, signal) => new Promise((_resolve, reject) => { began(); signal.addEventListener('abort', () => { events.push('abort'); reject(new Error('private response')) }, { once: true }) }) } })
    const first = controller.querySupplySnapshot(); const failure = expect(first).rejects.toThrow('SUPPLY_ABORTED')
    await started
    expect(await controller.updateSupplyPolicy({ ...policy, mode: 'off' })).toMatchObject({ eligibility: { state: 'disabled' }, advertisedCapabilityIds: [] })
    await failure; expect(events.slice(0, 3)).toEqual(['abort', 'withdraw', 'save']); await controller.close()
  })
  it('retains previous policy when persistence fails and suppresses storage details', async () => {
    const { controller } = setup(policy, facts(), { load: async () => null, save: async () => { throw new Error('/secret/path token') } })
    await expect(controller.updateSupplyPolicy({ ...policy, mode: 'off' })).rejects.toThrow('SUPPLY_OPERATION_FAILED')
    expect((await controller.querySupplySnapshot()).ownerPolicy.mode).toBe('allowed'); await controller.close()
  })
  it('close aborts active probing and forbids new observations', async () => {
    let began!: () => void; const started = new Promise<void>(resolve => { began = resolve })
    const { options } = setup()
    const controller = new SupplyController({ ...options, probe: signal => new Promise((_resolve, reject) => {
      began(); signal.addEventListener('abort', () => reject(new Error('probe cancelled')), { once: true })
    }) })
    const pending = controller.querySupplySnapshot(); const failure = expect(pending).rejects.toThrow('SUPPLY_ABORTED')
    await started; await controller.close(); await failure
    await expect(controller.querySupplySnapshot()).rejects.toThrow('SUPPLY_CLOSED')
  })
})

describe('policy persistence boundary', () => {
  const folders: string[] = []
  afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
  async function folder() { const path = await mkdtemp(join(tmpdir(), 'qianshou-supply-test-')); folders.push(path); return path }
  it.each([
    { ...policy, maxConcurrency: 0 }, { ...policy, minIdleSeconds: -1 }, { ...policy, enabledServiceIds: ['python', 'python'] },
    { ...policy, nodeRates: [{ localServiceId: 'other', amountMinor: 0, currency: 'CNY', unit: 'minute' }] },
    { ...policy, nodeRates: [{ localServiceId: 'python', amountMinor: 0.1, currency: 'CNY', unit: 'minute' }] },
  ])('rejects an invalid complete policy', value => { expect(() => parseSupplyPolicy(value)).toThrow('SUPPLY_POLICY_INVALID') })
  it('round-trips a private owner file and ignores unknown persisted fields', async () => {
    const filename = join(await folder(), 'private', 'supply.json'); const store = new FileSupplyPolicyStore(filename)
    expect(await store.load()).toBeNull(); await store.save(policy); expect(await store.load()).toEqual(policy)
    expect((await stat(filename)).mode & 0o777).toBe(0o600)
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual(policy)
  })
  it('rejects symlinks and oversized policy files', async () => {
    const path = await folder(); await writeFile(join(path, 'actual'), JSON.stringify(policy)); await symlink(join(path, 'actual'), join(path, 'link'))
    await expect(new FileSupplyPolicyStore(join(path, 'link')).load()).rejects.toThrow('SUPPLY_STORAGE_UNAVAILABLE')
    await writeFile(join(path, 'large'), ' '.repeat(65537)); await expect(new FileSupplyPolicyStore(join(path, 'large')).load()).rejects.toThrow('SUPPLY_STORAGE_INVALID')
  })
})
