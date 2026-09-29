/** Actual source files and signed proof brands exercise author orchestration; no GPU or payment runs. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3DeviceProof, verifyNativeH3DeviceProof, type NativeH3DeviceProof }
  from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { afterEach, expect, it, vi } from 'vitest'
import Catalog from '../src/index.ts'
import { nativeH3AuthoringTemplate, readNativeH3OrderSource } from '../src/native-h3-order-source.ts'
import type { NativeH3CatalogBinding } from '../src/native-h3-bindings-http.ts'
import type { NativeH3ReviewControl } from '../src/native-h3-review-http.ts'
import type { NativeH3PurposeKeys } from '../src/native-h3-trust-http.ts'
import type { OwnerSupplyCommand, SupplyPolicyWriteAuthority } from '../../compute-core/src/supply/types.ts'
import type { CatalogFailureCode, MyOrderSkillPublication, SubmittedOrderSkill } from '../src/types.ts'

const owner = 7
const worker = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const connection = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const publicationId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const request = { source: 'user-agents' as const, name: 'native-h3-fixture' }
const actual = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
  ownerConfigDigest: `sha256:${'a'.repeat(64)}`, executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) }
const pair = generateKeyPairSync('ed25519')
const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllGlobals()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function deferred() {
  let resolve: () => void = () => undefined
  const done = new Promise<void>((finish) => { resolve = finish })
  return { done, resolve }
}

interface PrivateFixturePort {
  nativeH3PurposeKeys(control: NativeH3ReviewControl): Promise<NativeH3PurposeKeys>
  readNativeH3BindingsForInventory(ownerId: number, workerId: string, connectionId: string): Promise<NativeH3CatalogBinding[]>
  queueNativeH3Review(path: string, publicationId: string, ownerId: number, restart?: boolean):
  Promise<Pick<SubmittedOrderSkill, 'reviewSampleStatus' | 'reviewSampleError'>>
  pending: Set<{ abort: AbortController; done: Promise<unknown> }>
  nativeReviewTasks: Map<string, {
    digest: string
    status: 'pending' | 'running' | 'evidence_deposited' | 'blocked'
    error?: CatalogFailureCode
  }>
}

async function fixture(options: { installed?: boolean; failure?: number; detail?: unknown } = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'native-author-activation-'))); roots.push(home)
  const skillRoot = join(home, 'skills', request.name)
  for (const [path, bytes] of Object.entries(nativeH3AuthoringTemplate(actual, request.name, 'qianshou_h3_unit_v1').files)) {
    await mkdir(dirname(join(skillRoot, path)), { recursive: true })
    await writeFile(join(skillRoot, path), bytes)
  }
  const path = join(skillRoot, 'SKILL.md')
  const source = await readNativeH3OrderSource(path)
  const definition = source.files.find(file => file.path === 'task-definition.json')
  if (definition === undefined) throw new Error('Missing fixture definition')
  const sourceDigest = `sha256:${source.digest}`
  const now = Math.floor(Date.now() / 1000)
  const tuple = { publication_id: publicationId, owner_id: owner, device_id: worker,
    task_type: source.declaration.taskType, capability_id: 'video.render' as const, contract_version: 'v1' as const,
    contract_sha256: 'd'.repeat(64), artifact_digest: sourceDigest, source_digest: sourceDigest,
    config_digest: actual.ownerConfigDigest }
  const payload: NativeH3DeviceProof = { ...tuple, schema: 'qianshou.native-h3-device-proof.v1',
    purpose: 'qianshou:native-h3-device-attestor', challenge_nonce: 'unit-native-approved-nonce',
    challenge_input_sha256: 'e'.repeat(64), challenge_result_sha256: 'f'.repeat(64), result: 'pass',
    publication_status: 'approved', installation_state: 'installed', issued_at: now, expires_at: now + 300 }
  const proof = verifyNativeH3DeviceProof({ key_id: 'fixture', payload,
    signature: sign(null, Buffer.from(canonicalNativeH3DeviceProof(payload)), pair.privateKey).toString('base64url') },
  tuple, new Map([['fixture', pair.publicKey]]), now)
  const binding: NativeH3CatalogBinding = { declaration: source.declaration, publicationId, sourceDigest,
    taskDefinitionSha256: `sha256:${createHash('sha256').update(definition.bytes).digest('hex')}`,
    contractSha256: tuple.contract_sha256, deviceProof: proof }
  const current = { owner, worker, connection, token: 'fixture-private-token', profile: home,
    proof: options.installed ?? true, published: true, recipe: actual.executionRecipeSha256 }
  const policy = { mode: 'off', maxConcurrency: 2, enabledServiceIds: ['git'] }
  const events: string[] = []
  const ctx = new Context(); contexts.push(ctx)
  ctx.provide('profileContext', { get dir() { return current.profile } })
  ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account: { id: String(current.owner) } }) })
  ctx.provide('accountSession', { ensureAccessToken: async () => current.token })
  ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [{ ...request, path,
    displayName: '本机 H3', description: '固定原生协议' }] }) })
  ctx.provide('pluginManager', { listBundles: async () => [], listPlugins: async () => [] })
  const writes = vi.fn(async (command: OwnerSupplyCommand, authority?: SupplyPolicyWriteAuthority) => {
    expect(current.proof).toBe(true); expect(authority?.expectedOwnerId).toBe(owner)
    await authority?.assertCurrent(); events.push(`grant:${command.kind}`)
    if (command.kind === 'mode') policy.mode = command.mode
    if (command.kind === 'local-service') policy.enabledServiceIds = [...new Set([...policy.enabledServiceIds, command.serviceId])]
  })
  ctx.provide('computeCore', { ownerSupplyPolicy: async () => policy, updateOwnerSupply: writes,
    querySupplySnapshot: async () => ({ localServices: [{ id: 'node', kind: 'tool', verification: 'verified' }] }) })
  const select = vi.fn(async (selection: { declaration: typeof source.declaration; sourceDigest: string }) => {
    events.push('actual-identity')
    if (current.recipe !== actual.executionRecipeSha256) throw new Error('Actual identity changed')
    return { taskType: selection.declaration.taskType, artifactDigest: selection.sourceDigest,
      packageDigest: actual.ownerConfigDigest, inventoryAlgorithm: 'qianshou.native-binding-package.v1', localVerified: true }
  })
  const refresh = vi.fn(async () => { events.push('hello-refresh') })
  ctx.provide('nodeContributor', { acknowledgedWorkerId: () => current.worker,
    acknowledgedConnectionId: () => current.connection, selectNativeH3AuthorBinding: select,
    observeNativeH3DeviceKeyProof: async () => {}, validateNativeH3PresenceChallenge: async () => {},
    observeNativeH3DevicePresence: async () => {}, refreshNativeH3OrderAdapters: refresh,
    nativeH3OrderAdapterReady: async () => current.published,
    nativeH3AuthorBinding: async () => ({ ...actual, executionRecipeSha256: current.recipe }),
    canEnableLocalService: async () => current.proof, setPanelAccepting: () => {},
    orderExecutor: () => ({ kind: 'unavailable' }), orderExecutorVerified: () => false })
  await ctx.plugin(Catalog, { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000, connection: 'shipped',
    apiBaseUrl: '', coreOrigin: 'https://control.invalid', installHome: '', publisherKeys: {}, orderArchiveHostname: 'storage.invalid' })
  const catalog = ctx.qianshouPluginCatalog
  const publication: MyOrderSkillPublication = { ...request, runtimeKind: 'native-h3', publicationId,
    status: 'approved', taskType: source.declaration.taskType, artifactDigest: sourceDigest,
    archiveStatus: 'confirmed', reviewReasons: [] }
  const publications = vi.spyOn(catalog, 'myOrderSkillPublications').mockResolvedValue({ items: [publication] })
  const bindings = vi.spyOn(catalog, 'verifiedNativeH3OrderBindings').mockImplementation(async () => current.proof ? [binding] : [])
  const port = catalog as unknown as PrivateFixturePort
  const inventoryBindings = vi.spyOn(port, 'readNativeH3BindingsForInventory').mockImplementation(async () =>
    current.proof ? [binding] : [])
  vi.spyOn(port, 'nativeH3PurposeKeys').mockResolvedValue({ challenge: new Map([['fixture', pair.publicKey]]),
    attestor: new Map([['fixture', pair.publicKey]]), issuance: new Map([['fixture', pair.publicKey]]) })
  const gate = deferred()
  const queued = vi.spyOn(port, 'queueNativeH3Review').mockImplementation(async (_path, pub, id, restart) => {
    expect(pub).toBe(publicationId); expect(id).toBe(owner); expect(restart).toBeUndefined()
    events.push('initial-two-samples')
    const state = { digest: sourceDigest, status: 'running' as 'running' | 'evidence_deposited' }
    port.nativeReviewTasks.set(`${owner}\0${publicationId}`, state)
    const task = { abort: new AbortController(), done: gate.done.then(() => {
      current.proof = true; state.status = 'evidence_deposited'; events.push('independent-two-samples-verified')
    }) }
    port.pending.add(task)
    void task.done.finally(() => port.pending.delete(task)).catch(() => undefined)
    return { reviewSampleStatus: 'pending' }
  })
  const fetcher = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(init?.redirect).toBe('error')
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    const row = body as Record<string, unknown>
    if (url.pathname.endsWith('/native-device-keys/challenge')) return Response.json({
      schema: 'qianshou.native-h3-device-enrollment.v1', purpose: 'qianshou:native-h3-device-key-enrollment',
      owner_id: owner, device_id: worker, key_id: row.key_id, public_key: row.public_key,
      challenge_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', nonce: 'n'.repeat(43),
      issued_at: now, expires_at: now + 300 })
    if (url.pathname.endsWith('/native-device-keys/register')) {
      const key = await import('../src/native-h3-device-identity.ts').then(module => module.nativeH3DeviceIdentity(home, owner, worker))
      return Response.json({ schema: 'qianshou.native-h3-device-key.v1', owner_id: owner, device_id: worker,
        key_id: key.keyId, public_key: key.publicKey, status: 'active' })
    }
    if (url.pathname.endsWith('/native-device-presence/challenge')) return Response.json({ detail: options.detail
      ?? { code: 'NATIVE_H3_DEVICE_SAMPLE_MISSING', message: '当前设备尚未启动独立双样例，请明确启用后运行' } },
    { status: options.failure ?? 409 })
    throw new Error(`Unexpected fixture route: ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetcher)
  return { catalog, current, policy, events, writes, select, refresh, publications, bindings, binding,
    publication, queued, gate, port, path, fetcher, inventoryBindings }
}

it('activates an approved native source without any product, install, purchase or GPU rerun', async () => {
  const f = await fixture()
  const result = await f.catalog.activateAuthorOrderSkill(request)
  expect(result).toMatchObject({ ...request, runtimeKind: 'native-h3', publicationId, deviceId: worker,
    runtimeDigest: actual.ownerConfigDigest, deviceVerified: true, dispatchEligible: true,
    order: { mode: 'idle', enabledServiceIds: ['git', 'node'] } })
  expect(result).not.toHaveProperty('productId'); expect(result).not.toHaveProperty('deviceInstalled')
  expect(f.queued).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled()
  expect(f.select).toHaveBeenCalledTimes(3); expect(f.refresh).toHaveBeenCalledOnce()
  expect(f.events.indexOf('actual-identity')).toBeLessThan(f.events.indexOf('grant:mode'))
})

it('awaits first device two-sample verification only after the exact authenticated missing-device response', async () => {
  const f = await fixture({ installed: false })
  const pending = f.catalog.activateAuthorOrderSkill(request)
  await vi.waitFor(() =>{  expect(f.queued).toHaveBeenCalledOnce() })
  expect(f.writes).not.toHaveBeenCalled()
  f.gate.resolve()
  await expect(pending).resolves.toMatchObject({ runtimeKind: 'native-h3', deviceVerified: true })
  expect(f.events.indexOf('independent-two-samples-verified')).toBeLessThan(f.events.indexOf('grant:mode'))
})

it.each([
  [409, { message: 'unknown prior GPU attempt' }],
  [503, { code: 'NATIVE_H3_DEVICE_SAMPLE_MISSING', message: '当前设备尚未启动独立双样例，请明确启用后运行' }],
  [409, { code: 'NATIVE_H3_DEVICE_SAMPLE_MISSING', message: 'wrong scope', extra: true }],
  [409, { code: 'OTHER_CONFLICT', message: '当前设备尚未启动独立双样例，请明确启用后运行' }],
])('keeps nonauthorizing HTTP %s failures closed without GPU or grant', async (failure, detail) => {
  const f = await fixture({ installed: false, failure, detail })
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow()
  expect(f.queued).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})

it('retains an unknown local run and never turns enable into an automatic restart', async () => {
  const f = await fixture({ installed: false })
  f.port.nativeReviewTasks.set(`${owner}\0${publicationId}`, { digest: f.binding.sourceDigest,
    status: 'blocked', error: 'order-review-samples-unavailable' })
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow('order-review-samples-not-ready')
  expect(f.queued).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})

it('does not interpret a network failure as permission to run initial device samples', async () => {
  const f = await fixture({ installed: false })
  f.fetcher.mockRejectedValue(new Error('fixture transport unavailable'))
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow('order-review-samples-unavailable')
  expect(f.queued).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})

it('allows a completed other-device local state to yield only to authoritative absence on this physical device', async () => {
  const f = await fixture({ installed: false })
  f.port.nativeReviewTasks.set(`${owner}\0${publicationId}`, { digest: f.binding.sourceDigest, status: 'evidence_deposited' })
  const pending = f.catalog.activateAuthorOrderSkill(request)
  await vi.waitFor(() => { expect(f.queued).toHaveBeenCalledOnce() })
  expect(f.writes).not.toHaveBeenCalled(); f.gate.resolve()
  await expect(pending).resolves.toMatchObject({ runtimeKind: 'native-h3', deviceId: worker, deviceVerified: true })
})

it.each(['owner', 'worker', 'connection', 'token', 'profile'] as const)('does not grant after %s changes during device sampling', async (field) => {
  const f = await fixture({ installed: false })
  const pending = f.catalog.activateAuthorOrderSkill(request)
  const rejection = expect(pending).rejects.toThrow('order-auth-required')
  await vi.waitFor(() =>{  expect(f.queued).toHaveBeenCalledOnce() })
  if (field === 'owner') f.current.owner = 8
  else f.current[field] = 'changed'
  f.gate.resolve(); await rejection
  expect(f.writes).not.toHaveBeenCalled()
})

it('refuses a revoked proof after Hello refresh instead of returning a successful native receipt', async () => {
  const f = await fixture()
  f.refresh.mockImplementation(async () => { f.current.proof = false })
  // Avoid a second HTTP presence probe: this is the final proof check after grant.
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow('order-author-device-unverified')
})

it('revalidates actual provider identity and never grants for a changed recipe', async () => {
  const f = await fixture(); f.current.recipe = 'f'.repeat(64)
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toThrow('order-local-verification-failed')
  expect(f.writes).not.toHaveBeenCalled()
})

it('restores native readiness by reading actual identity and proof without selecting, GPU or a product', async () => {
  const f = await fixture()
  f.policy.mode = 'idle'; f.policy.enabledServiceIds.push('node')
  const result = await f.catalog.orderSources()
  expect(result.sources.find(source => source.kind === 'skill')).toMatchObject({ runtimeKind: 'native-h3',
    eligible: true, enabled: true, reason: 'ready', capabilityId: 'video.render' })
  expect(result.sources.find(source => source.kind === 'skill')).not.toHaveProperty('authorProductId')
  expect(f.select).not.toHaveBeenCalled(); expect(f.queued).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
  f.current.recipe = 'f'.repeat(64)
  expect((await f.catalog.orderSources()).sources.find(source => source.kind === 'skill')).toMatchObject({
    eligible: false, enabled: false, reason: 'publication-approved' })
})

it('projects native UI eligibility only from the actual four-file declaration and matching cloud configuration', async () => {
  const f = await fixture()
  f.publications.mockRestore()
  let packageDigest = actual.ownerConfigDigest
  f.fetcher.mockImplementation(async () => Response.json({ items: [{ id: publicationId, owner_id: owner,
    task_type: f.publication.taskType, artifact_digest: f.publication.artifactDigest, package_digest: packageDigest,
    name: '真实本机 H3', status: 'approved', currency: 'CNY', price_yuan: '0.50', review_reasons: [],
    package_upload_status: 'confirmed', author_manifest_status: 'recorded' }] }))
  expect((await f.catalog.localOrderSkillEligibility()).items[0]).toMatchObject({ runtimeKind: 'native-h3' })
  expect((await f.catalog.myOrderSkillPublications()).items[0]).toMatchObject({ runtimeKind: 'native-h3' })
  packageDigest = `sha256:${'f'.repeat(64)}`
  expect((await f.catalog.myOrderSkillPublications()).items[0]).not.toHaveProperty('runtimeKind')
  expect(f.select).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})

it('does not retain native readiness across a changed physical connection', async () => {
  const f = await fixture(); f.policy.mode = 'idle'; f.policy.enabledServiceIds.push('node')
  f.inventoryBindings.mockImplementation(async () => { f.current.connection = 'changed'; return [f.binding] })
  expect((await f.catalog.orderSources()).sources.find(source => source.kind === 'skill')).toMatchObject({
    eligible: false, enabled: false })
  expect(f.select).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})

it('reads current native inventory with GET only and never issues a review, enrollment or presence nonce', async () => {
  const f = await fixture(); f.inventoryBindings.mockRestore()
  f.policy.mode = 'idle'; f.policy.enabledServiceIds.push('node')
  vi.spyOn(f.catalog, 'verifiedPurchasedOrderRuntimes').mockResolvedValue([])
  vi.spyOn(f.catalog, 'verifiedPurchasedFileOrderRuntimes').mockResolvedValue([])
  f.fetcher.mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    expect(init?.method ?? 'GET').toBe('GET')
    if (!url.pathname.endsWith('/native-bindings')) throw new Error('Inventory must not create a nonce')
    const payload = f.binding.deviceProof.payload
    if (payload.schema !== 'qianshou.native-h3-device-proof.v1') throw new Error('Expected the V1 inventory fixture')
    return Response.json({ schema: 'qianshou.native-h3-order-bindings.v1', owner_id: owner, worker_id: worker,
      bindings: [{ publication_id: publicationId, owner_id: owner, device_id: worker,
        task_type: f.publication.taskType, capability_id: 'video.render', input_kinds: ['inline'], output_kind: 'artifact_ref',
        contract_version: 'v1', input_contract: 'h3-prompt-fixed-frame.v1', result_strategy: 'external-media.v1',
        artifact_digest: f.binding.sourceDigest, package_digest: actual.ownerConfigDigest,
        source_digest: f.binding.sourceDigest, config_digest: actual.ownerConfigDigest,
        contract_sha256: f.binding.contractSha256, task_definition_sha256: f.binding.taskDefinitionSha256.slice(7),
        native_binding: actual, device_proof: { key_id: 'fixture', payload,
          signature: sign(null, Buffer.from(canonicalNativeH3DeviceProof(payload)), pair.privateKey).toString('base64url') } }] })
  })
  expect((await f.catalog.orderSources()).sources.find(source => source.kind === 'skill')).toMatchObject({ eligible: true, enabled: true })
  expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.bindings).not.toHaveBeenCalled()
  expect(f.select).not.toHaveBeenCalled(); expect(f.queued).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})

it('keeps the native connection guard through synchronization and rejects a late changed socket', async () => {
  const f = await fixture()
  f.refresh.mockImplementation(async () => { f.current.connection = '11111111-1111-4111-8111-111111111111' })
  await expect(f.catalog.activateAuthorOrderSkill(request)).rejects.toMatchObject({ code: 'order-auth-required' })
})

it('does not restore ready from a valid device proof and saved grant without current native synchronization ACK', async () => {
  const f = await fixture(); f.policy.mode = 'idle'; f.policy.enabledServiceIds.push('node')
  f.current.published = false
  expect((await f.catalog.orderSources()).sources.find(source => source.kind === 'skill')).toMatchObject({
    eligible: false, enabled: false, reason: 'publication-approved' })
  expect(f.select).not.toHaveBeenCalled(); expect(f.queued).not.toHaveBeenCalled(); expect(f.writes).not.toHaveBeenCalled()
})
