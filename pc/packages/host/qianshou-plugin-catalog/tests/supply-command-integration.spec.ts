/** Actual Catalog → ComputeService → SupplyController switches never write the filtered owner view. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QianshouPluginCatalog from '../src/index.ts'
import { SupplyController } from '../../compute-core/src/supply/controller.ts'
import type { BoundSupplyPolicyStore, SupplyOwnerBinding } from '../../compute-core/src/supply/policy.ts'
import { ComputeService } from '../../compute-core/src/service.ts'
import { ComputeDraftStore } from '../../compute-core/src/store.ts'
import type { SupplyClient, SupplyPolicy, SupplyProbeResult } from '../../compute-core/src/supply/types.ts'

const PRIVATE_HOME = ''
const originalBinding: SupplyOwnerBinding = { ownerId: 167, nodeId: 'fixture-node-mac' }
const originalPolicy: SupplyPolicy = {
  mode: 'idle', maxConcurrency: 1, minIdleSeconds: 120, minFreeMemoryBytes: 0,
  enabledServiceIds: ['node', 'git'],
  nodeRates: [{ localServiceId: 'node', amountMinor: 5, currency: 'CNY', unit: 'minute' }],
}
const facts: SupplyProbeResult = {
  hardware: { platform: 'fixture', arch: 'arm64', cpuModel: 'fixture', logicalCores: 2,
    totalMemoryBytes: 1024, freeMemoryBytes: 512, gpus: [], probeErrors: [] },
  localServices: [{ id: 'node', kind: 'tool', name: 'Node', version: '24', verification: 'verified', reason: null }],
  activity: { idleSeconds: 240, foregroundTaskActive: false, voiceActive: false },
}
const close: (() => Promise<unknown>)[] = []
afterEach(async () => {
  await Promise.all(close.splice(0).map(fn => fn()))
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

async function fixture(options: { currentKnown?: boolean; restoreOnWrite?: boolean } = {}) {
  let known = options.currentKnown ?? false
  let persisted = structuredClone(originalPolicy)
  const current = vi.fn(async () => known ? { ...originalBinding } : null)
  const forWrite = vi.fn(async () => {
    if (options.restoreOnWrite === false) return null
    known = true
    return { ...originalBinding }
  })
  const save = vi.fn(async (_policy: SupplyPolicy) => { throw new Error('unbound write forbidden') })
  const saveBound = vi.fn(async (policy: SupplyPolicy, binding: SupplyOwnerBinding) => {
    expect(binding).toEqual(originalBinding)
    persisted = structuredClone(policy)
  })
  const store: BoundSupplyPolicyStore = {
    load: async () => structuredClone(persisted), save,
    loadBound: async () => ({ policy: structuredClone(persisted), binding: { ...originalBinding } }), saveBound,
  }
  const controller = new SupplyController({ initialPolicy: originalPolicy, policyStore: store,
    ownerBinding: { current, forWrite }, probe: async () => facts, activeTaskCount: () => 0,
    operationTimeoutMs: 5000, now: () => '2026-09-26T15:00:00.000Z' })
  close.push(() => controller.close())
  const fetch = vi.fn(async () => { throw new Error('HTTP forbidden in policy audit') })
  vi.stubGlobal('fetch', fetch)
  const ctx = new Context()
  close.push(() => ctx.fiber.dispose())
  const service = new ComputeService(null, new ComputeDraftStore({ path: '/unused-fixture-draft.json', maxDrafts: 1, maxBytes: 1024 }),
    () => false, undefined, controller)
  const fullWrite = vi.spyOn(service, 'updateSupplyPolicy')
  const command = vi.spyOn(service, 'updateOwnerSupply')
  ctx.provide('computeCore', service)
  const panel = vi.fn((_enabled: boolean) => {})
  ctx.provide('nodeContributor', { setPanelAccepting: panel, canEnableLocalService: async () => true })
  await ctx.plugin(QianshouPluginCatalog, { registryUrl: 'https://registry.npmjs.org/',
    timeoutMs: 1000, connection: 'shipped', apiBaseUrl: '', installHome: PRIVATE_HOME, publisherKeys: {} })
  return { controller, catalog: ctx.qianshouPluginCatalog, fullWrite, command,
    current, forWrite, save, saveBound, panel, fetch, persisted: () => structuredClone(persisted) }
}

describe('actual Catalog switches with actual ComputeService and bound SupplyController', () => {
  it('ComputeService refuses an older supply port without falling back to its complete-policy writer', async () => {
    const complete = vi.fn(async () => { throw new Error('full write forbidden') })
    const supply: SupplyClient = { lastObservedSupply: () => null, ownerPolicy: async () => originalPolicy,
      updateSupplyPolicy: complete, querySupplySnapshot: async () => { throw new Error('probe forbidden') }, close: async () => {} }
    const service = new ComputeService(null, new ComputeDraftStore({ path: '/unused-fixture-draft.json', maxDrafts: 1, maxBytes: 1024 }),
      () => false, undefined, supply)
    await expect(service.updateOwnerSupply({ kind: 'mode', mode: 'idle' })).rejects.toThrow('SUPPLY_NOT_CONFIGURED')
    expect(complete).not.toHaveBeenCalled()
  })
  it('identity-unknown policy, query, and activity refresh do not persist the synthesized empty view', async () => {
    const f = await fixture()
    expect(await f.controller.ownerPolicy()).toEqual({ ...originalPolicy, mode: 'off', enabledServiceIds: [], nodeRates: [] })
    await f.controller.querySupplySnapshot()
    await f.controller.refreshActivity(false)
    await f.controller.refreshActivity(true)
    expect(f.persisted()).toEqual(originalPolicy)
    expect(f.saveBound).not.toHaveBeenCalled()
    expect(f.save).not.toHaveBeenCalled()
    expect(f.forWrite).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('restores the same account and retains complete saved grants, rates, and limits through the master switch', async () => {
    const f = await fixture()
    expect(await f.controller.ownerPolicy()).toMatchObject({ mode: 'off', enabledServiceIds: [] })
    const order = await f.catalog.setOwnerSupplyEnabled({ enabled: true })
    expect(f.command).toHaveBeenCalledExactlyOnceWith({ kind: 'mode', mode: 'idle' }, undefined)
    expect(f.fullWrite).not.toHaveBeenCalled()
    expect(f.saveBound).toHaveBeenCalledExactlyOnceWith(originalPolicy, originalBinding)
    expect(f.forWrite).toHaveBeenCalledTimes(2)
    expect(f.persisted()).toEqual(originalPolicy)
    expect(order).toEqual({ mode: 'idle', maxConcurrency: 1, enabledServiceIds: ['node', 'git'], enabledServiceCount: 2 })
    expect(f.panel).toHaveBeenCalledExactlyOnceWith(true)
    expect(f.save).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })

  it('restores identity for node enable after its real probe and keeps other grants and rates', async () => {
    const f = await fixture()
    const order = await f.catalog.setLocalServiceEnabled({ serviceId: 'node', enabled: true })
    expect(order).toMatchObject({ mode: 'idle', enabledServiceIds: ['node', 'git'] })
    expect(f.command).toHaveBeenCalledExactlyOnceWith({ kind: 'local-service', serviceId: 'node', enabled: true }, undefined)
    expect(f.persisted()).toEqual(originalPolicy)
    expect(f.fullWrite).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })

  it('revokes only node and its rate after identity restoration', async () => {
    const f = await fixture()
    const order = await f.catalog.setLocalServiceEnabled({ serviceId: 'node', enabled: false })
    expect(order).toMatchObject({ mode: 'idle', enabledServiceIds: ['git'] })
    expect(f.persisted()).toEqual({ ...originalPolicy, enabledServiceIds: ['git'], nodeRates: [] })
    expect(f.fullWrite).not.toHaveBeenCalled(); expect(f.fetch).not.toHaveBeenCalled()
  })

  it('does not overwrite the saved policy if write-side identity restoration remains unavailable', async () => {
    const f = await fixture({ restoreOnWrite: false })
    await expect(f.catalog.setOwnerSupplyEnabled({ enabled: true })).rejects.toThrow('supply-unavailable')
    expect(f.persisted()).toEqual(originalPolicy)
    expect(f.saveBound).not.toHaveBeenCalled()
    expect(f.panel).not.toHaveBeenCalled()
    expect(f.fetch).not.toHaveBeenCalled()
  })

  it('preserves enabled services, rates, concurrency, and limits when the read-side owner remains known', async () => {
    const f = await fixture({ currentKnown: true })
    const order = await f.catalog.setOwnerSupplyEnabled({ enabled: true })
    expect(order).toEqual({ mode: 'idle', maxConcurrency: 1, enabledServiceIds: ['node', 'git'], enabledServiceCount: 2 })
    expect(f.persisted()).toEqual(originalPolicy)
    expect(f.saveBound).toHaveBeenCalledExactlyOnceWith(originalPolicy, originalBinding)
    expect(f.fetch).not.toHaveBeenCalled()
  })
})
