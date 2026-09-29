/** An author action cannot carry account or worker authority across queued supply writes. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import Catalog from '../src/index.ts'
import type { OwnerSupplyCommand } from '../../compute-core/src/supply/types.ts'
import type { GenericOrderSource } from '../src/generic-order-source.ts'
import type { VerifiedPurchasedOrderRuntime } from '../src/order-purchased-runtime.ts'
import type { MyOrderSkillPublication } from '../src/types.ts'

const ownerA = 7
const ownerB = 8
const nodeId = 'author-account-node'
const workerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const productId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
const publicationId = '3a491d7e-31b5-4d0b-aa43-76d27f3c9a7b'
const entitlementId = '56bf7555-0a4c-42e7-9ec3-fcf4f6ad2d07'
const request = { source: 'user-agents' as const, name: 'char-counter' }
const artifactDigest = `sha256:${'a'.repeat(64)}`
const publication: MyOrderSkillPublication = { ...request, publicationId, status: 'approved',
  taskType: 'char_counter_v1', artifactDigest, reviewReasons: [], archiveStatus: 'confirmed',
  marketProductId: productId, marketProductStatus: 'published' }
const runtime: VerifiedPurchasedOrderRuntime = { productId, entitlementId, taskType: publication.taskType,
  capabilityId: 'text.char_counter', outputKind: 'inline_json', artifactDigest,
  packageDigest: `sha256:${'b'.repeat(64)}`, runtimeDigest: `sha256:${'c'.repeat(64)}`, contractVersion: 'v1' }
interface Policy { mode: 'off' | 'idle'; maxConcurrency: number; minIdleSeconds: number;
  minFreeMemoryBytes: number; enabledServiceIds: string[]; nodeRates: [] }
interface Authority { expectedOwnerId: number; assertCurrent(): Promise<void> }
interface CatalogInternals {
  purchasedRuntimeEntries(id: string): Promise<{ runtime: VerifiedPurchasedOrderRuntime; source: GenericOrderSource }[]>
  serialize<T>(operation: () => Promise<T>): Promise<T>
}
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

function barrier() {
  let entered!: () => void
  let release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const released = new Promise<void>(resolve => { release = resolve })
  return { started, release, wait: async () => { entered(); await released } }
}

async function fixture(options: { beforeBoundCommit?: () => Promise<void>; boundAvailable?: boolean } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  let ownerId = ownerA
  let acknowledgedWorker = workerId
  const initial = (): Policy => ({ mode: 'off', maxConcurrency: 2, minIdleSeconds: 120,
    minFreeMemoryBytes: 0, enabledServiceIds: ['git'], nodeRates: [] })
  const policies = new Map([[ownerA, initial()], [ownerB, initial()]])
  const current = (): Policy => policies.get(ownerId)!
  const persisted: { ownerId: number; nodeId: string; policy: Policy }[] = []
  const ownerPolicy = vi.fn(async () => current())
  const ordinaryWrite = vi.fn(async (next: Policy) => {
    persisted.push({ ownerId, nodeId, policy: next }); policies.set(ownerId, next)
  })
  const boundWrite = vi.fn(async (next: Policy, authority: Authority) => {
    await options.beforeBoundCommit?.()
    await authority.assertCurrent()
    if (authority.expectedOwnerId !== ownerId) throw new Error('unexpected author owner')
    persisted.push({ ownerId: authority.expectedOwnerId, nodeId, policy: next })
    policies.set(authority.expectedOwnerId, next)
    return { ownerPolicy: next }
  })
  const canEnable = vi.fn(async () => true)
  const refresh = vi.fn(async () => {})
  const panel = vi.fn((_accepting: boolean) => {})
  ctx.provide('computeCore', { ownerSupplyPolicy: ownerPolicy, updateSupplyPolicy: ordinaryWrite,
    updateOwnerSupply: async (command: OwnerSupplyCommand, authority?: Authority) => {
      if (authority !== undefined && options.boundAvailable === false) throw new Error('bound writer unavailable')
      const next: Policy = command.kind === 'mode' ? { ...current(), mode: command.mode }
        : { ...current(), enabledServiceIds: [...new Set([...current().enabledServiceIds, command.serviceId])] }
      return authority === undefined ? ordinaryWrite(next) : boundWrite(next, authority)
    },
    querySupplySnapshot: async () => ({ localServices: [{ id: 'node', kind: 'tool', verification: 'verified' }] }) })
  ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: String(ownerId) } }) })
  ctx.provide('accountSession', { ensureAccessToken: async () => 'fixture-token' })
  ctx.provide('nodeContributor', { nodeIdentity: () => nodeId, acknowledgedWorkerId: () => acknowledgedWorker,
    observePurchasedOrderChallenge: async () => {}, refreshPurchasedOrderAdapters: refresh,
    canEnableLocalService: canEnable, setPanelAccepting: panel })
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', coreOrigin: 'https://central.example', installHome: '', publisherKeys: {} })
  const catalog = ctx.qianshouPluginCatalog
  const internals = catalog as unknown as CatalogInternals
  const publications = vi.spyOn(catalog, 'myOrderSkillPublications').mockResolvedValue({ items: [publication] })
  const device = vi.spyOn(internals, 'purchasedRuntimeEntries').mockImplementation(async () => ownerId === ownerA
    ? [{ runtime, source: {} as GenericOrderSource }] : [])
  const activation = vi.spyOn(catalog, 'activatePurchasedOrderAdapter').mockRejectedValue(new Error('unexpected reinstall'))
  const http = vi.fn(async (url: URL) => url.pathname.endsWith('/author-entitlement')
    ? new Response(JSON.stringify({ entitlement_id: entitlementId, product_id: productId, status: 'installed',
      price_yuan: '0.00', currency: 'CNY', already_owned: true, install_expires_at: null }))
    : new Response(JSON.stringify({ id: productId, publication_id: publicationId, owner_id: ownerA,
      task_type: publication.taskType, name: '字符统计', description: '统计文字', category: 'text', version: '0.1.0',
      artifact_digest: artifactDigest, reviewed_seller_runtime_digest: runtime.packageDigest,
      sale_price_yuan: '10.00', currency: 'CNY', status: 'published', available_to_purchase: true,
      archive_digest: `sha256:${'d'.repeat(64)}`, archive_size_bytes: 4096, review_reasons: [] })))
  vi.stubGlobal('fetch', http)
  return { catalog, internals, policies, persisted, ownerPolicy, boundWrite, ordinaryWrite, publications, device,
    canEnable, refresh, panel, activation, http, switchAccount: () => { ownerId = ownerB },
    switchWorker: () => { acknowledgedWorker = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } }
}

it('saves both author grants through the bound Host method with the original owner', async () => {
  const f = await fixture()
  await expect(f.catalog.activateAuthorOrderSkill(request)).resolves.toMatchObject({
    productId, deviceId: workerId, dispatchEligible: true, order: { mode: 'idle', enabledServiceIds: ['git', 'node'] } })
  expect(f.boundWrite).toHaveBeenCalledTimes(2)
  expect(f.boundWrite.mock.calls.every(([, authority]) => authority.expectedOwnerId === ownerA)).toBe(true)
  expect(f.ordinaryWrite).not.toHaveBeenCalled()
  expect(f.persisted.map(write => write.ownerId)).toEqual([ownerA, ownerA])
  expect(f.policies.get(ownerB)).toMatchObject({ mode: 'off', enabledServiceIds: ['git'] })
  expect(f.activation).not.toHaveBeenCalled()
})

it.each([1, 2])('does not grant after A switches to B during publication read %s', async read => {
  const f = await fixture(); const publicationRead = barrier()
  if (read === 2) f.publications.mockResolvedValueOnce({ items: [publication] })
  f.publications.mockImplementationOnce(async () => { await publicationRead.wait(); return { items: [publication] } })
  const pending = f.catalog.activateAuthorOrderSkill(request)
  const rejected = expect(pending).rejects.toThrow('order-auth-required')
  await publicationRead.started; f.switchAccount(); publicationRead.release(); await rejected
  expect(f.persisted).toEqual([])
  expect(f.ordinaryWrite).not.toHaveBeenCalled()
})

it('does not grant after A switches to B while orderFacts awaits owner policy', async () => {
  const f = await fixture(); const factsRead = barrier()
  f.ownerPolicy.mockImplementationOnce(async () => { await factsRead.wait(); return f.policies.get(ownerA)! })
  const pending = f.catalog.activateAuthorOrderSkill(request)
  const rejected = expect(pending).rejects.toThrow('order-auth-required')
  await factsRead.started; f.switchAccount(); factsRead.release(); await rejected
  expect(f.persisted).toEqual([])
  expect(f.ordinaryWrite).not.toHaveBeenCalled()
})

it('rechecks A after the author master switch waits in the catalog serialize queue', async () => {
  const f = await fixture(); const queued = barrier()
  const earlier = f.internals.serialize(() => queued.wait())
  await queued.started
  const serialized = vi.spyOn(f.internals, 'serialize')
  const pending = f.catalog.activateAuthorOrderSkill(request)
  const rejected = expect(pending).rejects.toThrow('order-auth-required')
  await expect.poll(() => serialized.mock.calls.length).toBe(1)
  f.switchAccount(); queued.release(); await earlier; await rejected
  expect(f.persisted).toEqual([])
  expect(f.boundWrite).not.toHaveBeenCalled()
})

it('retains A as expected owner when the Host bound-write queue resumes under B', async () => {
  const commit = barrier(); const f = await fixture({ beforeBoundCommit: commit.wait })
  const pending = f.catalog.activateAuthorOrderSkill(request)
  const rejected = expect(pending).rejects.toThrow('supply-unavailable')
  await commit.started; f.switchAccount(); commit.release(); await rejected
  expect(f.boundWrite.mock.calls[0]?.[1].expectedOwnerId).toBe(ownerA)
  expect(f.persisted).toEqual([])
  expect(f.ordinaryWrite).not.toHaveBeenCalled()
})

it.each(['account', 'worker'] as const)('does not grant node after %s changes during canEnable', async identity => {
  const f = await fixture(); const runnable = barrier()
  f.canEnable.mockImplementationOnce(async () => { await runnable.wait(); return true })
  const pending = f.catalog.activateAuthorOrderSkill(request)
  const rejected = expect(pending).rejects.toThrow('order-auth-required')
  await runnable.started
  if (identity === 'account') f.switchAccount(); else f.switchWorker()
  runnable.release(); await rejected
  expect(f.persisted).toHaveLength(1)
  expect(f.persisted[0]).toMatchObject({ ownerId: ownerA, policy: { mode: 'idle', enabledServiceIds: ['git'] } })
  expect(f.policies.get(ownerB)).toMatchObject({ mode: 'off', enabledServiceIds: ['git'] })
  expect(f.ordinaryWrite).not.toHaveBeenCalled()
  expect(f.refresh).not.toHaveBeenCalled()
})

it('requires the bound Host writer for author activation without ordinary-write fallback', async () => {
  const f = await fixture({ boundAvailable: false })
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow('supply-unavailable')
  expect(f.persisted).toEqual([])
  expect(f.ordinaryWrite).not.toHaveBeenCalled()
})

it('does not return A dispatch eligibility when the final runtime read resumes under B', async () => {
  const f = await fixture(); const finalRuntime = barrier()
  const installed = [{ runtime, source: {} as GenericOrderSource }]
  f.device.mockResolvedValueOnce(installed).mockImplementationOnce(async () => {
    await finalRuntime.wait(); return installed
  })
  const pending = f.catalog.activateAuthorOrderSkill(request)
  const rejected = expect(pending).rejects.toThrow('order-auth-required')
  await finalRuntime.started; f.switchAccount(); finalRuntime.release(); await rejected
  expect(f.persisted.map(write => write.ownerId)).toEqual([ownerA, ownerA])
  expect(f.policies.get(ownerB)).toMatchObject({ mode: 'off', enabledServiceIds: ['git'] })
})

it('keeps explicit Remote supply toggles on their ordinary writer', async () => {
  const f = await fixture({ boundAvailable: false })
  await expect(f.catalog.setOwnerSupplyEnabled({ enabled: true })).resolves.toMatchObject({ mode: 'idle' })
  await expect(f.catalog.setLocalServiceEnabled({ serviceId: 'node', enabled: true })).resolves.toMatchObject({
    enabledServiceIds: ['git', 'node'] })
  expect(f.ordinaryWrite).toHaveBeenCalledTimes(2)
  expect(f.boundWrite).not.toHaveBeenCalled()
})
