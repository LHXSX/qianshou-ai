/** Real loopback HTTP and private output copies; no installed Windows process or GPU is exercised. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseH3CanonicalIdentity } from '../src/h3-canonical-protocol.ts'
import { parseH3OwnerRuntimeIdentity } from '../src/h3-owner-witness.ts'
import { createH3CanonicalProvider, H3_CANONICAL_SOURCE_MANIFEST_SHA256,
  readH3CanonicalOwnerConfig } from '../src/h3-canonical-provider.ts'
import { nativeH3LogicalBindingSha256, parseNativeH3CanonicalDeclaration } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { verifyNativeH3DeviceProofV2 } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { parseNativeH3TaskLeaseV2 } from '@deepseek-ai/dsh-compute-core/native-h3-task-lease'
import { H3OwnerSetup } from '../src/h3-owner-setup.ts'
import { createDynamicH3VideoProvider } from '../src/h3-dynamic-provider.ts'
import { createPublishedNativeH3Adapter, readOwnedH3ExecutionPermit,
  type NativeH3PublishedBinding } from '../src/native-h3-publication.ts'
import { readH3CanonicalIdentity } from '../src/h3-canonical-transport.ts'
import { runH3CanonicalExecution } from '../src/h3-canonical-runner.ts'

const roots: string[] = []
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(close => close()))
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const canonical = (value: Record<string, unknown>): string => JSON.stringify(value, Object.keys(value).sort())
const media = Buffer.from('0000ftyp CPU canonical media fixture, not a rendered video')
const frame = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2])

async function fixture(options: { badManifest?: boolean; badWitness?: boolean; hangPost?: boolean; hangIdentity?: boolean } = {}) {
  const source = options.badManifest ? '9'.repeat(64) : H3_CANONICAL_SOURCE_MANIFEST_SHA256
  const recipe = { schemaVersion: 'qs.h3.recipe-identity.canonical-vnext', workflow: 'qs_new4', seconds: 5,
    graphSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), sourceManifestSha256: source,
    classOriginSha256: 'c'.repeat(64), runtimeAbi: 'qs.h3.canonical.qs_new4.vnext' }
  const { seconds: _seconds, ...publicFields } = recipe
  const identity = parseH3CanonicalIdentity({ ...publicFields, recipeVersion: '1.0.0-rc.1', graphTemplateSha256: recipe.graphSha256,
    executionRecipeSha256: sha(canonical(recipe)), modelSetSha256: recipe.modelSha256,
    weightSha256ByRole: { audioVae: '1'.repeat(64), clip: '2'.repeat(64), lora: '3'.repeat(64),
      unet: '4'.repeat(64), videoVae: '5'.repeat(64) } })
  const fields = { schemaVersion: 'qs.h3.owner-runtime-identity.v1', ownerConfigDigest: '1'.repeat(64),
    apiProcessWitnessSha256: '2'.repeat(64), comfyProcessWitnessSha256: '3'.repeat(64), queueAdmissionGuardVersion: 1,
    sourceManifestSha256: source, classOriginSha256: identity.classOriginSha256,
    comfyFfmpegSha256: 'd'.repeat(64), deliveryFfmpegSha256: 'e'.repeat(64) }
  const owner = parseH3OwnerRuntimeIdentity({ ...fields, ownerRuntimeWitnessSha256: sha(canonical(fields)) }, identity)
  const job = (done: boolean) => ({ job_id: 'canonical-cpu-job', id: 'canonical-cpu-job', status: done ? 'done' : 'queued',
    phase: done ? 'done' : 'queued', done, failed: false, cancelled: false, error: null,
    video_url: done ? '/v1/jobs/canonical-cpu-job/video' : null, file_url: done ? '/v1/jobs/canonical-cpu-job/video' : null,
    recipe_identity: { schemaVersion: 'qs.h3.job-identity.canonical-vnext', attested: done,
      expected: { executionRecipeSha256: identity.executionRecipeSha256, modelSha256: identity.modelSha256 },
      ownerRuntimeWitnessSha256: options.badWitness ? '9'.repeat(64) : owner.ownerRuntimeWitnessSha256,
      actual: done ? { executionRecipeSha256: identity.executionRecipeSha256, modelSha256: identity.modelSha256,
        modelSetSha256: identity.modelSetSha256, sourceManifestSha256: source, classOriginSha256: identity.classOriginSha256,
        comfyFfmpegSha256: owner.comfyFfmpegSha256, deliveryFfmpegSha256: owner.deliveryFfmpegSha256,
        ownerRuntimeWitnessSha256: owner.ownerRuntimeWitnessSha256, deliverySha256: sha(media), deliverySize: media.length } : null },
    ...(done ? { comfy_model_load_generation_sha256: 'f'.repeat(64) } : {}) })
  const requests: { method: string; path: string; headers: IncomingHttpHeaders; body: unknown }[] = []
  const closed: Promise<void>[] = []
  let postObserved: () => void = () => {}
  const receivedPost = new Promise<void>((resolve) => { postObserved = resolve })
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    closed.push(once(request.socket, 'close').then(() => {}))
    const chunks: Buffer[] = []
    for await (const part of request) {
      const value: unknown = part
      if (typeof value !== 'string' && !(value instanceof Uint8Array)) throw new Error('Expected request bytes')
      chunks.push(Buffer.from(value))
    }
    requests.push({ method: request.method ?? '', path: request.url ?? '', headers: request.headers,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown : null })
    if (request.method === 'POST') postObserved()
    if (request.method === 'POST' && options.hangPost
      || request.url === '/v1/recipes/qs_new4/identity' && options.hangIdentity) return
    if (request.url === '/v1/jobs/canonical-cpu-job/video') {
      response.writeHead(200, { 'content-type': 'video/mp4' }); response.end(media); return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url === '/v1/recipes/qs_new4/identity' ? identity
      : request.url === '/v1/owner-runtime/identity' ? owner : job(request.method !== 'POST')))
  }
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => { response.destroy() })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Expected ephemeral TCP server')
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error)
      else resolve()
    })
  }) })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qs-canonical-execution-'))); roots.push(root)
  const configPath = join(root, 'owner.json')
  const config = { schema: 'qianshou.h3-owner.canonical.v1', adapterBase: `http://127.0.0.1:${address.port}`,
    firstFramePath: join(root, 'first.png'), negative: '不要闪烁', selfTestPath: join(root, 'trial.json') }
  const bytes = Buffer.from(JSON.stringify(config))
  await writeFile(configPath, bytes); await writeFile(config.firstFramePath, frame)
  await writeFile(config.selfTestPath, JSON.stringify({ schema: 'qianshou.h3-self-test.canonical.v1',
    configSha256: sha(bytes), ownerRuntimeWitnessSha256: owner.ownerRuntimeWitnessSha256, jobId: 'canonical-cpu-job' }))
  return { root, configPath, config, identity, owner, requests, closed, receivedPost,
    measured: { adapterBase: config.adapterBase, identity, owner, firstFrame: frame, negative: config.negative,
      assertCurrent: async () => {} } }
}

it('uses the actual fixed POST body exactly once, then same-witness poll/media and an exclusive independent private copy', async () => {
  const f = await fixture()
  const result = await runH3CanonicalExecution(f.measured, { prompt: '中文测试🙂', seed: 0,
    workspacePath: f.root, signal: new AbortController().signal }, { pollIntervalMs: 1, timeoutMs: 2_000 })
  expect(await readFile(result.path)).toEqual(media)
  expect(result.sha256).toBe(sha(media))
  expect(f.requests.map(row => [row.method, row.path])).toEqual([
    ['POST', '/v1/jobs'], ['GET', '/v1/jobs/canonical-cpu-job'], ['GET', '/v1/jobs/canonical-cpu-job/video'],
  ])
  expect(f.requests[0]?.body).toEqual({ workflow: 'qs_new4', steps: 4, tier: null, preset: 'landscape_C', seconds: 5,
    prompt: '中文测试🙂', negative: '不要闪烁', seed: 0,
    ref_images: [{ role: 'first', url: 'data:image/png;base64,' + frame.toString('base64') }],
    expected: { executionRecipeSha256: f.identity.executionRecipeSha256, modelSha256: f.identity.modelSha256 },
    ownerRuntimeWitnessSha256: f.owner.ownerRuntimeWitnessSha256 })
  expect(f.requests.every(row => row.headers.authorization === undefined && row.headers.origin === undefined)).toBe(true)
})

it.each(['mixed-witness', 'timeout', 'occupied-output'] as const)('does not retry POST after %s', async (failure) => {
  const f = await fixture({ badWitness: failure === 'mixed-witness', hangPost: failure === 'timeout' })
  if (failure === 'occupied-output') await writeFile(join(f.root, 'result.mp4'), 'foreign existing bytes')
  await expect(runH3CanonicalExecution(f.measured, { prompt: '试验', seed: 1, workspacePath: f.root,
    signal: new AbortController().signal }, { timeoutMs: failure === 'timeout' ? 40 : 2_000, pollIntervalMs: 1 })).rejects.toThrow()
  expect(f.requests.filter(row => row.method === 'POST')).toHaveLength(1)
  if (failure === 'occupied-output') expect(await readFile(join(f.root, 'result.mp4'), 'utf8')).toBe('foreign existing bytes')
  if (failure === 'timeout') { await Promise.all(f.closed); expect(f.closed).toHaveLength(1) }
  if (failure !== 'occupied-output') expect(f.requests.some(row => row.path.endsWith('/video'))).toBe(false)
})

it('prepares the explicit canonical source and same-witness prior trial without POST or upgrading a V2 receipt', async () => {
  const f = await fixture()
  const provider = createH3CanonicalProvider(f.configPath)
  const preparation = await provider.nativeAuthorBindingCanonical()
  expect(preparation.binding.runtimeAbi).toBe('qianshou.order-runtime.native-h3.canonical.v1')
  expect(preparation.binding.firstFrameSha256).toBe(sha(frame))
  expect(provider.status()).toMatchObject({ ready: true, code: 'H3_CANONICAL_REAL_SELF_TEST_VERIFIED' })
  expect(f.requests.every(row => row.method === 'GET')).toBe(true)
  await writeFile(f.config.selfTestPath, '{"schema":"qianshou.h3-self-test.v2"}')
  expect(await provider.loadAndSelfTestCanonical()).toBeNull()
  expect(provider.status().ready).toBe(false)
  expect(f.requests.every(row => row.method === 'GET')).toBe(true)
})

it('refuses a self-consistent unapproved software manifest and arbitrary execution/config variants', async () => {
  const f = await fixture({ badManifest: true })
  await expect(createH3CanonicalProvider(f.configPath).nativeAuthorBindingCanonical())
    .rejects.toMatchObject({ code: 'H3_CANONICAL_SOFTWARE_UNSUPPORTED' })
  expect(f.requests.map(row => row.path)).toEqual(['/v1/recipes/qs_new4/identity'])
  await writeFile(f.configPath, JSON.stringify({ ...f.config, engine: '/arbitrary/program' }))
  await expect(readH3CanonicalOwnerConfig(f.configPath)).rejects.toMatchObject({ code: 'H3_CANONICAL_OWNER_CONFIG_INVALID' })
  await writeFile(f.configPath, JSON.stringify({ ...f.config, schema: 'qianshou.h3-owner.v2' }))
  await expect(readH3CanonicalOwnerConfig(f.configPath)).rejects.toMatchObject({ code: 'H3_CANONICAL_OWNER_CONFIG_INVALID' })
})


it('executes an original canonical publication lease through the shared reservation and never takes a V2 fallback', async () => {
  const f = await fixture()
  const prepared = await createH3CanonicalProvider(f.configPath).nativeAuthorBindingCanonical()
  const declaration = parseNativeH3CanonicalDeclaration({ ...prepared.binding, schema: 'qianshou.native-h3-binding.v2',
    taskType: 'qianshou_canonical_cpu_fixture_v2', capabilityId: 'video.render', inputKinds: ['inline'],
    outputKind: 'artifact_ref', contractVersion: 'v2', category: 'video', platformDispatchable: true })
  const worker = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const connection = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
  const now = 1_790_000_000
  const tuple = { publication_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', owner_id: 7, device_id: worker,
    task_type: declaration.taskType, capability_id: 'video.render' as const, contract_version: 'v2' as const,
    contract_sha256: 'd'.repeat(64), artifact_digest: 'sha256:' + 'e'.repeat(64), source_digest: 'sha256:' + 'e'.repeat(64),
    logical_binding_sha256: nativeH3LogicalBindingSha256(prepared.binding),
    local_owner_config_digest: prepared.localOwnerConfigDigest, device_binding_revision: 1 }
  const payload = { ...tuple, schema: 'qianshou.native-h3-device-proof.v2' as const,
    purpose: 'qianshou:native-h3-device-attestor.v2' as const, challenge_nonce: Buffer.alloc(32, 1).toString('base64url'),
    challenge_input_sha256: '1'.repeat(64), challenge_result_sha256: '2'.repeat(64), result: 'pass' as const,
    publication_status: 'approved' as const, installation_state: 'installed' as const, issued_at: now - 1, expires_at: now + 299 }
  const pair = generateKeyPairSync('ed25519')
  const published: NativeH3PublishedBinding = { declaration, sourceDigest: tuple.source_digest,
    taskDefinitionSha256: 'sha256:' + '3'.repeat(64), publicationId: tuple.publication_id,
    contractSha256: tuple.contract_sha256, deviceKeyId: 'native-device-fixture', connectionId: connection,
    deviceProof: verifyNativeH3DeviceProofV2({ key_id: 'fixture', payload,
      signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), pair.privateKey).toString('base64url') },
    tuple, new Map([['fixture', pair.publicKey]]), now) }
  const lease = parseNativeH3TaskLeaseV2({ ...tuple, schema: 'qianshou.native-h3-task-lease.v2', connection_id: connection,
    device_key_id: 'native-device-fixture', workload_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    shard_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', attempt: 1 }, { ownerId: 7, deviceId: worker,
    connectionId: connection, taskType: declaration.taskType, workloadId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    shardId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', attempt: 1 })
  const setup = new H3OwnerSetup({ homePath: f.root, runtimeDirectory: f.root,
    readScope: async () => ({ ownerId: 7, profileDir: f.root }), onSaved: async () => {},
    assertIdle: async () => { throw new Error('An admitted lease is not a new trial') },
    assertAdmittedExecution: async (permit) => { expect(readOwnedH3ExecutionPermit(permit).lease).toBe(lease) } })
  let fallback = 0
  const canonicalProvider = createDynamicH3VideoProvider({ resolveConfiguration: async () => ({ path: f.configPath, identity: 'scope:1' }),
    onChanged: () => {}, assertNewExecution: () => setup.assertTrialAdmission(),
    createV2: () => ({ nativeAuthorBindingV2: async () => { fallback++; throw new Error('No V2 identity fallback') },
      loadAndSelfTestV2: async () => { fallback++; throw new Error('No V2 execution fallback') },
      status: () => ({ configured: true, ready: false, code: 'H3_NOT_CHECKED' }) }) })
  const alias = await createPublishedNativeH3Adapter(canonicalProvider, published,
    { ownerId: 7, deviceId: worker, connectionId: connection }, async () => published, () => now,
    permit => setup.runAdmittedReservedExecution(permit, () => canonicalProvider.runAdmittedExecution(permit),
      async output => sha(await readFile(output.path))))
  const result = await alias.run({ recipeJson: '{"prompt":"真实中文","seconds":5,"seed":0}', outputFormat: 'mp4',
    workspacePath: f.root, signal: new AbortController().signal, nativeDeviceLease: lease })
  expect(await readFile(result.path)).toEqual(media)
  expect(f.requests.filter(row => row.method === 'POST')).toHaveLength(1)
  expect(await setup.readTrialAdmission()).toEqual({ state: 'clear' })
  expect(fallback).toBe(0)
})


it('includes the pure pre-submit identity GET in the execution deadline and closes its socket before teardown', async () => {
  const f = await fixture({ hangIdentity: true })
  const measured = { ...f.measured, assertCurrent: async (signal: AbortSignal) => {
    await readH3CanonicalIdentity(f.config.adapterBase, { signal, timeoutMs: 2_000 })
  } }
  await expect(runH3CanonicalExecution(measured, { prompt: '检查', seed: 1, workspacePath: f.root,
    signal: new AbortController().signal }, { timeoutMs: 40 })).rejects.toThrow()
  await Promise.all(f.closed)
  expect(f.requests.map(row => [row.method, row.path])).toEqual([['GET', '/v1/recipes/qs_new4/identity']])
  expect(f.closed).toHaveLength(1)
})

it('aborts a submitted request without retry and observes socket close before cleanup', async () => {
  const f = await fixture({ hangPost: true })
  const abort = new AbortController()
  const action = runH3CanonicalExecution(f.measured, { prompt: '检查', seed: 1, workspacePath: f.root,
    signal: abort.signal }, { timeoutMs: 2_000 })
  await Promise.all([expect(action).rejects.toThrow(), f.receivedPost.then(() => { abort.abort() })])
  await Promise.all(f.closed)
  expect(f.requests.filter(row => row.method === 'POST')).toHaveLength(1)
  expect(f.closed).toHaveLength(1)
})
