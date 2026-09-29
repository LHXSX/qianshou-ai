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
  it('reads only a prior completed observation without probing, publishing or writing state', async () => {
    const { options, publish, withdraw } = setup()
    const savePolicy = vi.fn(async () => {})
    const saveWatch = vi.fn(async () => {})
    const controller = new SupplyController({ ...options,
      policyStore: { load: async () => null, save: savePolicy },
      watchStore: { load: async () => null, save: saveWatch } })
    expect(controller.lastObservedSupply()).toBeNull()
    expect(options.probe).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled()
    expect(withdraw).not.toHaveBeenCalled()
    expect(savePolicy).not.toHaveBeenCalled()
    expect(saveWatch).not.toHaveBeenCalled()

    await controller.querySupplySnapshot()
    const observed = controller.lastObservedSupply()
    expect(observed).toMatchObject({ localServices: [{ id: 'python' }, { id: 'ollama:fixture', verification: 'pending' }] })
    expect(typeof observed?.observedAt).toBe('string')
    expect(options.probe).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(saveWatch).toHaveBeenCalledTimes(1)
    controller.lastObservedSupply()
    expect(options.probe).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalledTimes(1)
    expect(withdraw).not.toHaveBeenCalled()
    expect(savePolicy).not.toHaveBeenCalled()
    expect(saveWatch).toHaveBeenCalledTimes(1)
    await controller.close()
  })
  it('requires a real transport acknowledgement separately from readiness', async () => {
    const { options } = setup()
    const { advertisement: _unused, ...withoutTransport } = options
    const controller = new SupplyController(withoutTransport)
    const snapshot = await controller.querySupplySnapshot()
    expect(snapshot).toMatchObject({ eligibility: { state: 'ready' }, advertisingState: 'not-connected', advertisedCapabilityIds: [] })
    expect(snapshot.declaration.contract).toBe('qianshou/capability/v1')
    await controller.close()
  })
  it('publishes verified enabled tools only and returns acknowledged IDs', async () => {
    const { controller, publish } = setup()
    expect(await controller.querySupplySnapshot()).toMatchObject({ advertisingState: 'advertising', advertisedCapabilityIds: ['word_count'] })
    expect(publish.mock.calls[0]?.[0].map(service => service.id)).toEqual(['python'])
    await controller.close()
  })
  it('withdraws on voice start and republishes after voice drains without a supply query', async () => {
    const { options, publish, withdraw } = setup()
    let voiceActive = false
    const controller = new SupplyController({ ...options, probe: async () => ({ ...facts(),
      activity: { ...facts().activity, voiceActive } }) })
    expect((await controller.querySupplySnapshot()).advertisingState).toBe('advertising')
    voiceActive = true
    expect(await controller.refreshActivity(true)).toMatchObject({
      activity: { voiceActive: true }, eligibility: { state: 'blocked', reasons: ['FOREGROUND_PRIORITY'] },
      advertisingState: 'withdrawn', advertisedCapabilityIds: [],
    })
    expect(withdraw).toHaveBeenCalledTimes(1)
    voiceActive = false
    expect(await controller.refreshActivity(false)).toMatchObject({
      activity: { voiceActive: false }, eligibility: { state: 'ready' }, advertisedCapabilityIds: ['word_count'],
    })
    expect(publish).toHaveBeenCalledTimes(2)
    await controller.close()
  })
  it('does not cancel the withdrawal when voice starts and finishes in the same turn', async () => {
    const { options, publish, withdraw } = setup()
    let voiceActive = false
    const controller = new SupplyController({ ...options, probe: async () => ({ ...facts(),
      activity: { ...facts().activity, voiceActive } }) })
    await controller.querySupplySnapshot()
    voiceActive = true
    const busy = controller.refreshActivity(true)
    voiceActive = false
    const idle = controller.refreshActivity(false)
    await busy
    await idle
    expect(withdraw).toHaveBeenCalledTimes(1)
    expect(publish).toHaveBeenCalled()
    await controller.close()
  })
  it('cancels a stale probe before it can publish after voice starts', async () => {
    const { options, publish } = setup()
    let stalled = false
    let started!: () => void
    const began = new Promise<void>(resolve => { started = resolve })
    const controller = new SupplyController({ ...options, probe: signal => stalled
      ? new Promise((_resolve, reject) => {
        started()
        signal.addEventListener('abort', () => reject(new Error('cancelled probe')), { once: true })
      }) : Promise.resolve({ ...facts(), activity: { ...facts().activity, voiceActive: true } }) })
    stalled = true
    const pending = controller.querySupplySnapshot()
    const failed = expect(pending).rejects.toThrow('SUPPLY_ABORTED')
    await began
    stalled = false
    expect((await controller.refreshActivity(true)).advertisingState).toBe('withdrawn')
    await failed
    expect(publish).not.toHaveBeenCalled()
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
  it.each([null, 10])('does not call unknown/recent activity idle', async (idleSeconds) => {
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
    const started = new Promise<void>((resolve) => { began = resolve })
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
    let began!: () => void; const started = new Promise<void>((resolve) => { began = resolve })
    const { options } = setup()
    const controller = new SupplyController({ ...options, probe: signal => new Promise((_resolve, reject) => {
      began(); signal.addEventListener('abort', () => reject(new Error('probe cancelled')), { once: true })
    }) })
    const pending = controller.querySupplySnapshot(); const failure = expect(pending).rejects.toThrow('SUPPLY_ABORTED')
    await started; await controller.close(); await failure
    await expect(controller.querySupplySnapshot()).rejects.toThrow('SUPPLY_CLOSED')
  })
  /**
   * 供给开关要被接单循环每一拍读一次，所以它必须**便宜**（不跑本机探测、不动广告），
   * 而且必须读得到刚提交的策略。AT-09 的缺陷就是这条通路根本不存在。
   */
  it('reads the committed owner switch without probing or touching advertisement', async () => {
    const { controller, options, publish, withdraw } = setup()
    const probe = options.probe as unknown as ReturnType<typeof vi.fn>
    expect(await controller.ownerPolicy()).toMatchObject({ mode: 'allowed' })
    expect(probe).not.toHaveBeenCalled()
    expect(publish).not.toHaveBeenCalled(); expect(withdraw).not.toHaveBeenCalled()
    // 提交后立即可见（同一份串行队列，不会读到写一半的策略）。
    await controller.updateSupplyPolicy({ ...policy, mode: 'off' })
    expect(await controller.ownerPolicy()).toMatchObject({ mode: 'off' })
    // 探测次数只来自 updateSupplyPolicy 那一次：ownerPolicy 自己不探测。
    expect(probe).toHaveBeenCalledTimes(1)
    await controller.close()
    await expect(controller.ownerPolicy()).rejects.toThrow()
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
  ])('rejects an invalid complete policy', (value) => { expect(() => parseSupplyPolicy(value)).toThrow('SUPPLY_POLICY_INVALID') })
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
  it('keeps legacy ON unbound, restores only the same owner and node after restart, and withdraws on a switch', async () => {
    const filename = join(await folder(), 'private', 'supply.json')
    const store = new FileSupplyPolicyStore(filename)
    await store.save(policy)
    const legacyBytes = await readFile(filename, 'utf8')
    let identity = { ownerId: 7, nodeId: 'node-mac-1' }
    const ownerBinding = { current: async () => identity, forWrite: async () => identity }
    const create = () => {
      const { options, publish, withdraw } = setup(policy)
      return { controller: new SupplyController({ ...options, policyStore: store, ownerBinding }), publish, withdraw }
    }
    const first = create()
    expect(await first.controller.ownerPolicy()).toMatchObject({ mode: 'off', enabledServiceIds: [], nodeRates: [] })
    expect(await first.controller.querySupplySnapshot()).toMatchObject({ eligibility: { state: 'disabled' }, advertisingState: 'withdrawn' })
    expect(first.publish).not.toHaveBeenCalled()
    expect(await readFile(filename, 'utf8')).toBe(legacyBytes)
    // This is a separate explicit Host policy update, not a silent legacy migration.
    await first.controller.updateSupplyPolicy(policy)
    expect(await first.controller.ownerPolicy()).toMatchObject({ mode: 'allowed', enabledServiceIds: ['python'] })
    expect((await store.loadBound()).binding).toEqual(identity)
    await first.controller.close()

    const restarted = create()
    expect(await restarted.controller.ownerPolicy()).toMatchObject({ mode: 'allowed', enabledServiceIds: ['python'] })
    expect((await restarted.controller.querySupplySnapshot()).advertisingState).toBe('advertising')
    identity = { ownerId: 8, nodeId: 'node-mac-1' }
    expect(await restarted.controller.ownerPolicy()).toMatchObject({ mode: 'off', enabledServiceIds: [] })
    expect((await restarted.controller.querySupplySnapshot()).advertisingState).toBe('withdrawn')
    identity = { ownerId: 7, nodeId: 'node-mac-2' }
    expect(await restarted.controller.ownerPolicy()).toMatchObject({ mode: 'off', enabledServiceIds: [] })
    expect((await restarted.controller.querySupplySnapshot()).advertisingState).toBe('withdrawn')
    identity = { ownerId: 7, nodeId: 'node-mac-1' }
    expect(await restarted.controller.ownerPolicy()).toMatchObject({ mode: 'allowed', enabledServiceIds: ['python'] })
    await restarted.controller.updateSupplyPolicy({ ...policy, mode: 'off' })
    expect(await restarted.controller.ownerPolicy()).toMatchObject({ mode: 'off', enabledServiceIds: ['python'] })
    expect((await restarted.controller.querySupplySnapshot()).advertisingState).toBe('withdrawn')
    await restarted.controller.close()
  })

  it('refuses an owner policy write without a current identity and leaves prior bytes intact', async () => {
    const filename = join(await folder(), 'private', 'supply.json')
    const store = new FileSupplyPolicyStore(filename)
    await store.save(policy)
    const before = await readFile(filename, 'utf8')
    const { options } = setup(policy)
    const controller = new SupplyController({ ...options, policyStore: store,
      ownerBinding: { current: async () => null, forWrite: async () => null } })
    await expect(controller.updateSupplyPolicy(policy)).rejects.toThrow('SUPPLY_OWNER_IDENTITY_UNAVAILABLE')
    expect(await readFile(filename, 'utf8')).toBe(before)
    expect((await controller.ownerPolicy()).mode).toBe('off')
    await controller.close()
  })
})
