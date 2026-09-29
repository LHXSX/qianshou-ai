/** Actual loopback wire, same-home filesystem transactions and synthetic media; no GPU or approval. */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { afterEach, expect, it } from 'vitest'
import { H3CanonicalOwnerSetup, H3_CANONICAL_DEFAULT_ADAPTER_BASE, type H3CanonicalSetupScope } from '../src/h3-canonical-owner-setup.ts'
import type { H3CanonicalSetupSaveResult, H3CanonicalTrialStatus } from '../src/h3-canonical-owner-setup-types.ts'
import { H3ExecutionCoordinator, type H3TrialTransaction } from '../src/h3-execution-coordinator.ts'
import { H3_CANONICAL_SOURCE_MANIFEST_SHA256, createH3CanonicalProvider } from '../src/h3-canonical-provider.ts'
import { parseH3CanonicalIdentity } from '../src/h3-canonical-protocol.ts'
import { parseH3OwnerRuntimeIdentity } from '../src/h3-owner-witness.ts'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const media = Buffer.from('0000ftyp canonical CPU trial bytes, not GPU rendered output')
const frame = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2])

async function fixture(options: { hangPost?: boolean; repeatJob?: boolean; badManifest?: boolean } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qs-canonical-managed-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const source = options.badManifest ? '9'.repeat(64) : H3_CANONICAL_SOURCE_MANIFEST_SHA256
  const recipe = { schemaVersion: 'qs.h3.recipe-identity.canonical-vnext', workflow: 'qs_new4', seconds: 5,
    graphSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), sourceManifestSha256: source,
    classOriginSha256: 'c'.repeat(64), runtimeAbi: 'qs.h3.canonical.qs_new4.vnext' }
  const { seconds: _seconds, ...publicFields } = recipe
  const identity = parseH3CanonicalIdentity({ ...publicFields, recipeVersion: '1.0.0-rc.1', graphTemplateSha256: recipe.graphSha256,
    executionRecipeSha256: sha(canonicalNativeH3ReviewJson(recipe)), modelSetSha256: recipe.modelSha256,
    weightSha256ByRole: { audioVae: '1'.repeat(64), clip: '2'.repeat(64), lora: '3'.repeat(64), unet: '4'.repeat(64), videoVae: '5'.repeat(64) } })
  const fields = { schemaVersion: 'qs.h3.owner-runtime-identity.v1', ownerConfigDigest: '1'.repeat(64),
    apiProcessWitnessSha256: '2'.repeat(64), comfyProcessWitnessSha256: '3'.repeat(64), queueAdmissionGuardVersion: 1,
    sourceManifestSha256: source, classOriginSha256: identity.classOriginSha256,
    comfyFfmpegSha256: 'd'.repeat(64), deliveryFfmpegSha256: 'e'.repeat(64) }
  let owner = parseH3OwnerRuntimeIdentity({ ...fields, ownerRuntimeWitnessSha256: sha(canonicalNativeH3ReviewJson(fields)) }, identity)
  const requests: { method: string; path: string; body: unknown }[] = []
  let posts = 0
  let hangPost = options.hangPost ?? false
  let posted: () => void = () => {}
  const receivedPost = new Promise<void>((resolve) => { posted = resolve })
  const closed: Promise<void>[] = []
  const jobs = new Map<string, unknown>()
  const job = (id: string, done: boolean) => ({ job_id: id, id, status: done ? 'done' : 'queued', phase: done ? 'done' : 'queued',
    done, failed: false, cancelled: false, error: null,
    video_url: done ? `/v1/jobs/${id}/video` : null, file_url: done ? `/v1/jobs/${id}/video` : null,
    recipe_identity: { schemaVersion: 'qs.h3.job-identity.canonical-vnext', attested: done,
      expected: { executionRecipeSha256: identity.executionRecipeSha256, modelSha256: identity.modelSha256 },
      ownerRuntimeWitnessSha256: owner.ownerRuntimeWitnessSha256,
      actual: done ? { executionRecipeSha256: identity.executionRecipeSha256, modelSha256: identity.modelSha256,
        modelSetSha256: identity.modelSetSha256, sourceManifestSha256: source, classOriginSha256: identity.classOriginSha256,
        comfyFfmpegSha256: owner.comfyFfmpegSha256, deliveryFfmpegSha256: owner.deliveryFfmpegSha256,
        ownerRuntimeWitnessSha256: owner.ownerRuntimeWitnessSha256, deliverySha256: sha(media), deliverySize: media.length } : null },
    ...(done ? { comfy_model_load_generation_sha256: 'f'.repeat(64) } : {}) })
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    closed.push(once(request.socket, 'close').then(() => {}))
    const chunks: Buffer[] = []
    for await (const value of request) { const raw: unknown = value
      if (!(raw instanceof Uint8Array) && typeof raw !== 'string') throw new Error('Expected bytes')
      chunks.push(Buffer.from(raw)) }
    const path = request.url ?? ''
    const body: unknown = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null
    requests.push({ method: request.method ?? '', path, body })
    if (request.method === 'POST') {
      posts++; posted()
      if (hangPost) return
      const id = options.repeatJob ? 'same-job' : `sample-${posts}`
      jobs.set(id, job(id, true))
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(job(id, false))); return
    }
    if (path.endsWith('/video')) { response.writeHead(200, { 'content-type': 'video/mp4' }); response.end(media); return }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(path === '/v1/recipes/qs_new4/identity' ? identity
      : path === '/v1/owner-runtime/identity' ? owner : jobs.get(path.slice('/v1/jobs/'.length))))
  }
  const server = createServer((request, response) => { void handle(request, response).catch(() => { response.destroy() }) })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address(); if (address === null || typeof address === 'string') throw new Error('Expected TCP')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => {
    server.close((error) => { if (error) reject(error); else resolve() }) }) })
  const firstFramePath = join(root, 'selected.png'); await writeFile(firstFramePath, frame)
  let scope: H3CanonicalSetupScope | null = { ownerId: 1, profileDir: root }
  let readScope = async (): Promise<H3CanonicalSetupScope | null> => scope
  let external = false
  let rejectActivity = false
  let savedCallback = async (_transaction: H3TrialTransaction): Promise<void> => {}
  const coordinator = new H3ExecutionCoordinator(root, async () => {})
  const admission = async (): Promise<{ readonly state: 'clear' | 'pending' | 'unknown' }> => {
    if (await coordinator.hasUnsettledExecution()) return { state: 'unknown' }
    try { await lstat(join(root, 'qianshou-h3-owner', '.trial-lock')); return { state: 'pending' } }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    return { state: 'clear' }
  }
  // A new Host composition gets a fresh coordinator; admission is reconstructed from the same private filesystem.
  const create = () => new H3CanonicalOwnerSetup({ homePath: root, coordinator: new H3ExecutionCoordinator(root, async () => {}),
    readScope: () => readScope(), readAdmission: admission, assertClearWithinTransaction: async () => {},
    assertIdle: async () => {}, externalConfigActive: () => external, onSaved: (_state, transaction) => savedCallback(transaction),
    onTrialActivity: (active) => { if (active && rejectActivity) throw new Error('Host pause port failed') },
    runOptions: { timeoutMs: 2_000, pollIntervalMs: 1 } })
  const setup = create(); cleanups.push(() => setup.dispose())
  const selection = { firstFramePath, adapterBase: `http://127.0.0.1:${address.port}`, negative: '不要闪烁' }
  const save = async (): Promise<H3CanonicalSetupSaveResult> => {
    const inspection = await setup.inspect(selection)
    if (inspection.kind !== 'inspection') throw new Error('Expected inspection')
    return setup.save({ inspectionId: inspection.inspectionId, expectedRevision: inspection.revision })
  }
  const settle = async (status: H3CanonicalTrialStatus): Promise<H3CanonicalTrialStatus> => {
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const current = await setup.selfTestStatus(status.operationId)
      if (current.state !== 'pending') return current
      await delay(5)
    }
    throw new Error('Local trial did not reach a confirmed terminal state')
  }
  const trial = async (saved: H3CanonicalSetupSaveResult, sample: 1 | 2) => {
    const started = await setup.startSelfTest({ contextId: saved.contextId, revision: saved.revision, sample,
      prompt: `独立中文试片 ${sample}` })
    return settle(started)
  }
  return { root, setup, coordinator, admission, create, selection, save, trial, settle, requests, receivedPost, closed,
    posts: () => posts, setScope: (value: H3CanonicalSetupScope | null) => { scope = value },
    setReadScope: (value: () => Promise<H3CanonicalSetupScope | null>) => { readScope = value },
    setExternal: (value: boolean) => { external = value }, setRejectActivity: () => { rejectActivity = true },
    setSavedCallback: (value: (transaction: H3TrialTransaction) => Promise<void>) => { savedCallback = value }, changeWitness: () => {
      const changed = { ...fields, apiProcessWitnessSha256: '9'.repeat(64) }
      owner = parseH3OwnerRuntimeIdentity({ ...changed, ownerRuntimeWitnessSha256: sha(canonicalNativeH3ReviewJson(changed)) }, identity)
    }, setHangPost: (value: boolean) => { hangPost = value } }
}

it('inspects, saves and reads a redacted independent configuration without POST or V2 receipt reuse', async () => {
  expect(H3_CANONICAL_DEFAULT_ADAPTER_BASE).toBe('http://127.0.0.1:8791')
  const f = await fixture()
  expect(await f.setup.inspect()).toMatchObject({ runtime: null, revision: 0, configured: false })
  const saved = await f.save()
  expect(saved).toMatchObject({ state: 'saved', revision: 1 })
  expect(await f.setup.inspect()).toMatchObject({ runtime: 'canonical', state: 'saved', revision: 1, samples: [] })
  const state = await f.setup.readCurrentConfigIdentity(); if (state === null) throw new Error('Expected config')
  expect(JSON.parse(await readFile(state.configPath, 'utf8'))).toEqual({ schema: 'qianshou.h3-owner.canonical.v1',
    adapterBase: f.selection.adapterBase, firstFramePath: join(state.configPath, '..', 'first.png'),
    negative: '不要闪烁', selfTestPath: join(state.configPath, '..', 'self-test.json') })
  expect(state.configPath).toContain('/canonical/1/')
  expect(JSON.stringify(saved)).not.toContain(f.root)
  expect(f.posts()).toBe(0)
  await expect(f.setup.freshVerifiedCanonicalBinding(saved)).rejects.toMatchObject({ code: 'H3_CANONICAL_TWO_TRIALS_REQUIRED' })
})

it('requires two explicit independent jobs/seeds and revalidates both before a fresh draft binding', async () => {
  const f = await fixture(); const saved = await f.save()
  await expect(f.setup.startSelfTest({ ...saved, sample: 2, prompt: '第二份' })).rejects.toMatchObject({ code: 'H3_CANONICAL_FIRST_TRIAL_REQUIRED' })
  expect(await f.trial(saved, 1)).toMatchObject({ state: 'ready', sample: 1 })
  await expect(f.setup.freshVerifiedCanonicalBinding(saved)).rejects.toMatchObject({ code: 'H3_CANONICAL_TWO_TRIALS_REQUIRED' })
  expect(f.posts()).toBe(1)
  expect(await f.trial(saved, 2)).toMatchObject({ state: 'ready', sample: 2 })
  const identity = await f.setup.freshVerifiedCanonicalBinding(saved)
  expect(identity.binding.runtimeAbi).toBe('qianshou.order-runtime.native-h3.canonical.v1')
  const state = await f.setup.readCurrentConfigIdentity(); if (state === null) throw new Error('Expected config')
  expect(await createH3CanonicalProvider(state.configPath).nativeAuthorBindingCanonical()).toEqual(identity)
  expect(await f.setup.inspect()).toMatchObject({ state: 'ready', samples: [{ sample: 1 }, { sample: 2 }] })
  const bodies = f.requests.filter(row => row.method === 'POST').map(row => row.body)
  expect(bodies).toHaveLength(2)
  expect(bodies[0]).toMatchObject({ seconds: 5, steps: 4, seed: 1, workflow: 'qs_new4' })
  expect(bodies[1]).toMatchObject({ seconds: 5, steps: 4, seed: 2, workflow: 'qs_new4' })
  const retained = await f.trial(saved, 1); expect(retained.state).toBe('ready')
  expect(f.posts()).toBe(2)
})

it('rejects the same actual job reused for sample two and retains uncertainty without a third POST', async () => {
  const f = await fixture({ repeatJob: true }); const saved = await f.save()
  expect((await f.trial(saved, 1)).state).toBe('ready')
  expect((await f.trial(saved, 2)).state).toBe('unknown')
  await expect(f.setup.freshVerifiedCanonicalBinding(saved)).rejects.toThrow()
  expect((await f.trial(saved, 2)).state).toBe('unknown'); expect(f.posts()).toBe(2)
})

it('rejects saved inspection and command contexts after A to B with the same numeric revision', async () => {
  const f = await fixture(); const savedA = await f.save()
  const inspectionA = await f.setup.inspect(f.selection); if (inspectionA.kind !== 'inspection') throw new Error('Expected inspection')
  f.setScope({ ownerId: 2, profileDir: f.root }); const savedB = await f.save()
  expect(savedB.revision).toBe(savedA.revision)
  await expect(f.setup.save({ inspectionId: inspectionA.inspectionId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'H3_SETUP_IDENTITY_CHANGED' })
  await expect(f.setup.startSelfTest({ ...savedA, sample: 1, prompt: '不得改派' })).rejects.toMatchObject({ code: 'H3_SETUP_IDENTITY_CHANGED' })
  await expect(f.setup.freshVerifiedCanonicalBinding(savedA)).rejects.toMatchObject({ code: 'H3_SETUP_IDENTITY_CHANGED' })
  expect(f.posts()).toBe(0)
})

it('captures the original context before a delayed first account read can return B', async () => {
  const f = await fixture(); const savedA = await f.save()
  f.setScope({ ownerId: 2, profileDir: f.root }); await f.save()
  let resolve: (value: H3CanonicalSetupScope) => void = () => {}
  f.setReadScope(() => new Promise((accept) => { resolve = accept }))
  const action = f.setup.startSelfTest({ ...savedA, sample: 1, prompt: '不可迟到授权' })
  const rejected = expect(action).rejects.toMatchObject({ code: 'H3_SETUP_IDENTITY_CHANGED' })
  resolve({ ownerId: 2, profileDir: f.root }); await rejected
  expect(f.posts()).toBe(0)
})

it('increments revision on same-byte ABA and rejects the old ready context without inheriting trials', async () => {
  const f = await fixture(); const a = await f.save(); await f.trial(a, 1)
  const b = await f.save(); const c = await f.save()
  expect([a.revision, b.revision, c.revision]).toEqual([1, 2, 3])
  await expect(f.setup.startSelfTest({ ...a, sample: 2, prompt: '旧保存' })).rejects.toMatchObject({ code: 'H3_SETUP_REVISION_CONFLICT' })
  expect(await f.setup.inspect()).toMatchObject({ state: 'saved', samples: [], revision: 3 })
  expect(f.posts()).toBe(1)
})

it('blocks external override saves and new explicit trials rather than silently saving an unused managed path', async () => {
  const f = await fixture(); const saved = await f.save()
  const inspected = await f.setup.inspect(f.selection); if (inspected.kind !== 'inspection') throw new Error('Expected inspection')
  f.setExternal(true)
  await expect(f.setup.save({ inspectionId: inspected.inspectionId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'H3_SETUP_EXTERNAL_CONFIG_ACTIVE' })
  await expect(f.setup.startSelfTest({ ...saved, sample: 1, prompt: '不要产生未使用配置' })).rejects.toMatchObject({ code: 'H3_SETUP_EXTERNAL_CONFIG_ACTIVE' })
  expect(f.posts()).toBe(0)
})

it('holds the actual shared reservation against save and a second owner while POST is unresolved, then retains unknown after dispose', async () => {
  const f = await fixture({ hangPost: true }); const saved = await f.save()
  const inspection = await f.setup.inspect(f.selection); if (inspection.kind !== 'inspection') throw new Error('Expected inspection')
  const pending = await f.setup.startSelfTest({ ...saved, sample: 1, prompt: '唯一提交' }); await f.receivedPost
  expect(pending.state).toBe('pending')
  expect((await f.setup.startSelfTest({ ...saved, sample: 1, prompt: '不是重试' })).operationId).toBe(pending.operationId)
  await expect(f.setup.save({ inspectionId: inspection.inspectionId, expectedRevision: 1 })).rejects.toThrow()
  f.setScope({ ownerId: 2, profileDir: f.root }); const other = f.create(); cleanups.push(() => other.dispose())
  await expect(other.resolveCurrentConfigState()).rejects.toThrow()
  await f.setup.dispose(); await Promise.all(f.closed)
  expect(await f.admission()).toEqual({ state: 'unknown' }); expect(f.posts()).toBe(1)
  f.setScope({ ownerId: 1, profileDir: f.root }); const restarted = f.create(); cleanups.push(() => restarted.dispose())
  expect(await restarted.inspect()).toMatchObject({ state: 'unknown' })
  await expect(restarted.resolveCurrentConfigState()).rejects.toThrow()
  const current = await restarted.inspect(); if (current.kind !== 'current') throw new Error('Expected current')
  expect((await restarted.startSelfTest({ contextId: current.contextId, revision: 1, sample: 1, prompt: '不重跑' })).state).toBe('unknown')
  expect(f.posts()).toBe(1)
})

it('blocks local trials while a real ordinary coordinator reservation is running', async () => {
  const f = await fixture(); const saved = await f.save()
  let entered: () => void = () => {}, release: () => void = () => {}
  const running = new Promise<void>((resolve) => { entered = resolve })
  const wait = new Promise<void>((resolve) => { release = resolve })
  const order = f.coordinator.runReserved({ runtime: 'canonical', bindingSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64) },
    async () => { entered(); await wait; return media }, async bytes => sha(bytes))
  await running
  await expect(f.setup.startSelfTest({ ...saved, sample: 1, prompt: '不得抢GPU' })).rejects.toThrow()
  expect(await f.setup.readCurrentConfigIdentity()).not.toBeNull()
  expect(f.posts()).toBe(0); release(); await order
  expect((await f.trial(saved, 1)).state).toBe('ready')
})

it('does not present historical raw ready evidence as ready while a newer shared execution is unknown', async () => {
  const f = await fixture(); const saved = await f.save(); const sample = await f.trial(saved, 1)
  const state = await f.setup.readCurrentConfigIdentity(); if (state === null) throw new Error('Expected config')
  const path = join(state.configPath, '..', 'trial-1.json'); const original = await readFile(path)
  await expect(f.coordinator.runReserved({ runtime: 'canonical', bindingSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64) },
    async () => { throw new Error('Actual entered synthetic execution uncertain') }, async () => sha(media))).rejects.toThrow()
  expect((await f.setup.selfTestStatus(sample.operationId)).state).toBe('unknown')
  expect(await f.setup.inspect()).toMatchObject({ state: 'unknown' })
  expect(await readFile(path)).toEqual(original); expect(f.posts()).toBe(1)
})

it('rejects changed current process witness before a second POST and before a draft binding', async () => {
  const f = await fixture(); const saved = await f.save(); await f.trial(saved, 1); f.changeWitness()
  await expect(f.setup.startSelfTest({ ...saved, sample: 2, prompt: '重新启动不是旧试片' })).rejects.toMatchObject({ code: 'H3_EXECUTION_IDENTITY_CHANGED' })
  await expect(f.setup.freshVerifiedCanonicalBinding(saved)).rejects.toMatchObject({ code: 'H3_EXECUTION_IDENTITY_CHANGED' })
  expect(f.posts()).toBe(1)
})

it('rejects unsupported software, invalid PNG, nonloopback addresses and selected symlinks with zero POST', async () => {
  const unsupported = await fixture({ badManifest: true })
  await expect(unsupported.setup.inspect(unsupported.selection)).rejects.toMatchObject({ code: 'H3_CANONICAL_SOFTWARE_UNSUPPORTED' })
  const f = await fixture()
  await expect(f.setup.inspect({ ...f.selection, adapterBase: 'https://platform.invalid' })).rejects.toThrow()
  const linked = join(f.root, 'linked.png'); await symlink(f.selection.firstFramePath, linked)
  await expect(f.setup.inspect({ ...f.selection, firstFramePath: linked })).rejects.toThrow()
  await writeFile(f.selection.firstFramePath, 'not PNG')
  await expect(f.setup.inspect(f.selection)).rejects.toMatchObject({ code: 'H3_CANONICAL_FIRST_FRAME_INVALID' })
  expect(f.posts()).toBe(0); expect(unsupported.posts()).toBe(0)
})

it('rejects modified private config without starting a generation', async () => {
  const f = await fixture(); const saved = await f.save()
  const state = await f.setup.readCurrentConfigIdentity(); if (state === null) throw new Error('Expected config')
  await writeFile(state.configPath, '{}')
  await expect(f.setup.startSelfTest({ ...saved, sample: 1, prompt: '损坏拒绝' })).rejects.toMatchObject({ code: 'H3_CANONICAL_MANAGED_INVALID' })
  expect(f.posts()).toBe(0)
})

it('rejects linked managed pointers and leaves their target untouched', async () => {
  const f = await fixture(); const saved = await f.save()
  const state = await f.setup.readCurrentConfigIdentity(); if (state === null) throw new Error('Expected config')
  const pointer = join(state.configPath, '..', '..', 'current.json')
  const original = await readFile(pointer); const target = join(f.root, 'outside.json')
  await writeFile(target, original, { mode: 0o600 }); await unlink(pointer); await symlink(target, pointer)
  await expect(f.setup.startSelfTest({ ...saved, sample: 1, prompt: '链接拒绝' })).rejects.toMatchObject({ code: 'H3_SETUP_UNSAFE_PATH' })
  expect(await readFile(target)).toEqual(original); expect(f.posts()).toBe(0)
})

it('rejects a changed selected PNG after inspection and never writes an authoritative pointer', async () => {
  const f = await fixture(); const inspected = await f.setup.inspect(f.selection)
  if (inspected.kind !== 'inspection') throw new Error('Expected inspection')
  await writeFile(f.selection.firstFramePath, Buffer.concat([frame, Buffer.from('changed')]))
  await expect(f.setup.save({ inspectionId: inspected.inspectionId, expectedRevision: 0 })).rejects.toMatchObject({ code: 'H3_EXECUTION_IDENTITY_CHANGED' })
  expect(await f.setup.inspect()).toMatchObject({ configured: false, revision: 0 }); expect(f.posts()).toBe(0)
})

it('serializes two real save transactions and never overwrites the winning revision', async () => {
  const f = await fixture(); const a = await f.setup.inspect(f.selection), b = await f.setup.inspect(f.selection)
  if (a.kind !== 'inspection' || b.kind !== 'inspection') throw new Error('Expected inspections')
  const results = await Promise.allSettled([
    f.setup.save({ inspectionId: a.inspectionId, expectedRevision: 0 }),
    f.setup.save({ inspectionId: b.inspectionId, expectedRevision: 0 }),
  ])
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter(row => row.status === 'rejected')).toHaveLength(1)
  expect(await f.setup.inspect()).toMatchObject({ revision: 1, state: 'saved' }); expect(f.posts()).toBe(0)
})

it('uses an independent namespace and does not parse, rename or upgrade a V2 pointer', async () => {
  const f = await fixture(); const path = join(f.root, 'qianshou-h3-owner', 'v2', 'old-pointer.json')
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const bytes = Buffer.from('{"schema":"V2 record must remain untouched"}')
  await writeFile(path, bytes, { mode: 0o600 })
  expect(await f.setup.inspect()).toMatchObject({ revision: 0, configured: false })
  await f.save(); expect(await readFile(path)).toEqual(bytes); expect(f.posts()).toBe(0)
})

it('rejects a same-owner different-profile command context and an unauthenticated save', async () => {
  const f = await fixture(); const saved = await f.save(); const profile = join(f.root, 'other-profile')
  await mkdir(profile, { mode: 0o700 }); f.setScope({ ownerId: 1, profileDir: profile }); await f.save()
  await expect(f.setup.startSelfTest({ ...saved, sample: 1, prompt: '不可换profile' })).rejects.toMatchObject({ code: 'H3_SETUP_IDENTITY_CHANGED' })
  const inspected = await f.setup.inspect(f.selection); if (inspected.kind !== 'inspection') throw new Error('Expected inspection')
  f.setScope(null)
  await expect(f.setup.save({ inspectionId: inspected.inspectionId, expectedRevision: 1 })).rejects.toMatchObject({ code: 'H3_SETUP_AUTH_REQUIRED' })
  expect(f.posts()).toBe(0)
})

it('fresh owner B with two historical ready samples is blocked by owner A unresolved execution after Host disposal', async () => {
  const f = await fixture(); f.setScope({ ownerId: 2, profileDir: f.root }); const savedB = await f.save()
  await f.trial(savedB, 1); await f.trial(savedB, 2)
  const b = await f.setup.readCurrentConfigIdentity(); if (b === null) throw new Error('Expected B config')
  const evidencePath = join(b.configPath, '..', 'trial-1.json'); const original = await readFile(evidencePath)
  f.setScope({ ownerId: 1, profileDir: f.root }); const savedA = await f.save(); f.setHangPost(true)
  await f.setup.startSelfTest({ ...savedA, sample: 1, prompt: 'A唯一执行' })
  await expect.poll(() => f.posts(), { timeout: 5_000 }).toBe(3)
  await f.setup.dispose(); f.setScope({ ownerId: 2, profileDir: f.root })
  const freshB = f.create(); cleanups.push(() => freshB.dispose())
  expect(await freshB.inspect()).toMatchObject({ state: 'unknown', configured: true, revision: 1 })
  expect(await freshB.readCurrentConfigIdentity()).toEqual(b)
  await expect(freshB.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_UNKNOWN' })
  const current = await freshB.inspect(); if (current.kind !== 'current') throw new Error('Expected current')
  await expect(freshB.freshVerifiedCanonicalBinding({ contextId: current.contextId, revision: 1 })).rejects.toThrow()
  expect(await readFile(evidencePath)).toEqual(original); expect(f.posts()).toBe(3)
})

it('rejects a failed Host pause callback without hanging the explicit command or submitting a POST', async () => {
  const f = await fixture(); const saved = await f.save(); f.setRejectActivity()
  await expect(f.setup.startSelfTest({ ...saved, sample: 1, prompt: '暂停失败不得生成' })).rejects.toThrow('Host pause port failed')
  await f.setup.dispose()
  expect(f.posts()).toBe(0); expect(await f.admission()).toEqual({ state: 'unknown' })
  const fresh = f.create(); cleanups.push(() => fresh.dispose())
  expect(await fresh.inspect()).toMatchObject({ state: 'unknown', configured: true })
})

it('keeps the shared mutex when the durable active-variant callback fails after the canonical pointer CAS', async () => {
  const f = await fixture(); const destination = join(f.root, 'not-a-selector-directory')
  await writeFile(destination, 'foreign file must remain intact')
  f.setSavedCallback(async (transaction) => {
    await transaction.assertOwned()
    expect((await lstat(join(f.root, 'qianshou-h3-owner', '.trial-lock'))).isFile()).toBe(true)
    const handle = await open(join(destination, 'active.json'), 'wx', 0o600)
    await handle.close()
  })
  await expect(f.save()).rejects.toMatchObject({ code: 'ENOTDIR' })
  expect(await readFile(destination, 'utf8')).toBe('foreign file must remain intact')
  expect(await f.setup.inspect()).toMatchObject({ configured: true, revision: 1, state: 'unknown' })
  const fresh = f.create(); cleanups.push(() => fresh.dispose())
  expect(await f.admission()).toEqual({ state: 'pending' })
  await expect(fresh.resolveCurrentConfigState()).rejects.toMatchObject({ code: 'H3_SETUP_SELF_TEST_PENDING' })
  expect(f.posts()).toBe(0)
})
