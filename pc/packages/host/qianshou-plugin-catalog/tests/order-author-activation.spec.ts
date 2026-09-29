/** Owner action orchestration; protocol, archive bytes and live-worker execution have separate real fixtures. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import Catalog from '../src/index.ts'
import type { GenericOrderSource } from '../src/generic-order-source.ts'
import type { MyOrderSkillPublication } from '../src/types.ts'
import type { OwnerSupplyCommand, SupplyPolicyWriteAuthority } from '../../compute-core/src/supply/types.ts'
import type { VerifiedPurchasedOrderRuntime } from '../src/order-purchased-runtime.ts'

const productId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
const publicationId = '3a491d7e-31b5-4d0b-aa43-76d27f3c9a7b'
const entitlementId = '56bf7555-0a4c-42e7-9ec3-fcf4f6ad2d07'
const workerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const request = { source: 'user-agents' as const, name: 'char-counter' }
const artifactDigest = `sha256:${'a'.repeat(64)}`
const publication: MyOrderSkillPublication = { ...request, publicationId,
  status: 'approved', taskType: 'char_counter_v1', artifactDigest, reviewReasons: [],
  archiveStatus: 'confirmed', marketProductId: productId, marketProductStatus: 'published' }
const runtime: VerifiedPurchasedOrderRuntime = { productId, entitlementId,
  taskType: publication.taskType, capabilityId: 'text.char_counter', outputKind: 'inline_json', artifactDigest,
  packageDigest: `sha256:${'b'.repeat(64)}`, runtimeDigest: `sha256:${'c'.repeat(64)}`, contractVersion: 'v1' }
const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

async function fixture(options: { status?: string; installed?: boolean; unknown?: boolean } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  let proof = options.installed === true
  const policy = { mode: 'off', maxConcurrency: 2, enabledServiceIds: ['git'], nodeRates: [], minIdleSeconds: 120 }
  const writes = vi.fn(async (next: typeof policy) => {
    expect(proof).toBe(true)
    Object.assign(policy, next)
  })
  const refresh = vi.fn(async () => {})
  ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: '7' } }) })
  ctx.provide('computeCore', { ownerSupplyPolicy: async () => policy, updateSupplyPolicy: writes,
    updateOwnerSupply: async (command: OwnerSupplyCommand, authority?: SupplyPolicyWriteAuthority) => {
      expect(authority?.expectedOwnerId).toBe(7); await authority?.assertCurrent()
      return writes(command.kind === 'mode' ? { ...policy, mode: command.mode }
        : { ...policy, enabledServiceIds: [...new Set([...policy.enabledServiceIds, command.serviceId])] })
    },
    querySupplySnapshot: async () => ({ localServices: [{ id: 'node', kind: 'tool', verification: 'verified' }] }) })
  ctx.provide('nodeContributor', { acknowledgedWorkerId: () => workerId,
    observePurchasedOrderChallenge: async () => {}, refreshPurchasedOrderAdapters: refresh,
    canEnableLocalService: async () => proof, setPanelAccepting: () => {} })
  ctx.provide('accountSession', { ensureAccessToken: async () => 'fixture-token' })
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', coreOrigin: 'https://central.example', installHome: '', publisherKeys: {} })
  const catalog = ctx.qianshouPluginCatalog
  const publications = vi.spyOn(catalog, 'myOrderSkillPublications').mockResolvedValue({ items: [publication] })
  const device = vi.spyOn(catalog as unknown as { purchasedRuntimeEntries(id: string, productId?: string): Promise<{
    runtime: VerifiedPurchasedOrderRuntime; source: GenericOrderSource }[]> }, 'purchasedRuntimeEntries')
    .mockImplementation(async () => proof ? [{ runtime, source: {} as GenericOrderSource }] : [])
  const activation = vi.spyOn(catalog, 'activatePurchasedOrderAdapter').mockImplementation(async () => {
    if (options.unknown) throw new Error('order-activation-unavailable')
    proof = true
    return { productId, deviceId: workerId, runtimeDigest: runtime.runtimeDigest, deviceInstalled: true, dispatchEligible: true }
  })
  const http = vi.fn(async (url: URL) => {
    if (url.pathname.endsWith('/author-entitlement')) return new Response(JSON.stringify({ entitlement_id: entitlementId,
      product_id: productId, status: options.status ?? (options.installed ? 'installed' : 'pending_install'),
      price_yuan: '0.00', currency: 'CNY', already_owned: options.status !== undefined || options.installed === true,
      install_expires_at: null }))
    return new Response(JSON.stringify({ id: productId, publication_id: publicationId, owner_id: 7,
      task_type: publication.taskType, name: '字符统计', description: '统计文字', category: 'text', version: '0.1.0',
      artifact_digest: artifactDigest, reviewed_seller_runtime_digest: runtime.packageDigest,
      sale_price_yuan: '10.00', currency: 'CNY', status: 'published', available_to_purchase: true,
      archive_digest: `sha256:${'d'.repeat(64)}`, archive_size_bytes: 4096, review_reasons: [] }))
  })
  vi.stubGlobal('fetch', http)
  return { catalog, policy, writes, activation, device, publications, refresh, http }
}

it('one author action validates the device before saving the master switch and grant, without purchase', async () => {
  const f = await fixture()
  const [first, second] = await Promise.all([f.catalog.activateAuthorOrderSkill(request), f.catalog.activateAuthorOrderSkill(request)])
  expect(first).toEqual(second)
  expect(first).toMatchObject({ ...request, productId, publicationId, deviceId: workerId,
    runtimeDigest: runtime.runtimeDigest, deviceInstalled: true, dispatchEligible: true,
    order: { mode: 'idle', enabledServiceIds: ['git', 'node'] } })
  expect(f.activation).toHaveBeenCalledExactlyOnceWith({ productId })
  expect(f.device.mock.calls.every(([id, selected]) => id === workerId && selected === productId)).toBe(true)
  expect(f.writes).toHaveBeenCalledTimes(2)
  expect(f.policy.minIdleSeconds).toBe(120)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  expect(f.http.mock.calls.map(([url]) => url.pathname)).toEqual([
    `/api/v8/order-adapter-products/${productId}`, `/api/v8/order-adapter-products/${productId}/author-entitlement`])
})

it('recovers an exact installed runtime without reinstalling or challenging it again', async () => {
  const f = await fixture({ installed: true })
  await expect(f.catalog.activateAuthorOrderSkill(request)).resolves.toMatchObject({ deviceInstalled: true })
  expect(f.activation).not.toHaveBeenCalled()
})

it.each(['unknown', 'refunded'])('keeps a retained %s entitlement closed without install or grant', async status => {
  const f = await fixture({ status })
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow(`order-author-entitlement-${status}`)
  expect(f.activation).not.toHaveBeenCalled()
  expect(f.writes).not.toHaveBeenCalled()
})

it('does not retry an unknown activation outcome or save a grant', async () => {
  const f = await fixture({ unknown: true })
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow('order-activation-unavailable')
  expect(f.activation).toHaveBeenCalledTimes(1)
  expect(f.writes).not.toHaveBeenCalled()
})

it('does not grant after installation if the local source changed while verification ran', async () => {
  const f = await fixture()
  f.publications.mockResolvedValueOnce({ items: [publication] }).mockResolvedValueOnce({ items: [] })
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow('order-author-source-changed')
  expect(f.writes).not.toHaveBeenCalled()
})

it('a nonapproved source never requests author ownership, and the legacy author Hello stays empty', async () => {
  const f = await fixture()
  f.publications.mockResolvedValue({ items: [{ ...publication, status: 'review' }] })
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow('order-author-not-published')
  expect(f.http).not.toHaveBeenCalled()
  expect(await f.catalog.verifiedAuthorOrderRuntimes(workerId)).toEqual([])
  await expect(f.catalog.runAuthorOrderRuntime({ workerId, taskType: runtime.taskType, artifactDigest,
    packageDigest: runtime.packageDigest, inlineInput: '{}', signal: new AbortController().signal }))
    .rejects.toThrow('order-runtime-unavailable')
})
