import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME, NATIVE_H3_RUNTIME_ABI,
  type NativeH3AuthorBinding, type NativeH3Declaration } from '../../compute-core/src/native-h3-binding.ts'
import { canonicalNativeH3DeviceProof, verifyNativeH3DeviceProof,
  type NativeH3DeviceProof, type NativeH3DeviceTuple } from '../../compute-core/src/native-h3-device-proof.ts'
import { canonicalNativeH3ReviewJson, verifyNativeH3ReviewChallenge,
  type NativeH3ReviewChallenge } from '../../compute-core/src/native-h3-review.ts'
import { verifyNativeH3PresenceChallenge,
  type NativeH3PresenceChallenge } from '../../compute-core/src/native-h3-presence.ts'
import type { ArtifactOrderAdapter } from '../src/artifact-order.ts'
import { createPublishedNativeH3Adapter, isPublishedNativeH3Adapter, nativeH3AdapterClaim,
  selectNativeH3Binding, type NativeH3PublishedBinding } from '../src/native-h3-publication.ts'
import { runNativeH3ReviewChallenge } from '../src/native-h3-review.ts'
import { validateNativeH3PresenceChallenge } from '../src/native-h3-presence.ts'
import { prepareH3OrderInput } from '../src/h3-video.ts'
import { bindInlineEdgeResident } from '../src/edge-binding.ts'
import { FixtureWebSocketServer } from '../../compute-core/tests/transport/fixture-ws-server.ts'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
const now = 1_790_000_000
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const keys = new Map([['purpose-key', publicKey]])
const binding: NativeH3AuthorBinding = { runtimeAbi: NATIVE_H3_RUNTIME_ABI, runtime: NATIVE_H3_RUNTIME,
  ownerConfigDigest: `sha256:${'a'.repeat(64)}`, executionRecipeSha256: 'b'.repeat(64), modelSha256: 'c'.repeat(64) }
const declaration: NativeH3Declaration = { ...binding, schema: 'qianshou.native-h3-binding.v1',
  taskType: 'author_h3_fixture_v1', capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref',
  contractVersion: 'v1', category: 'video', platformDispatchable: true }
const selection = { declaration, sourceDigest: `sha256:${'d'.repeat(64)}`, taskDefinitionSha256: `sha256:${'e'.repeat(64)}` }
const tuple: NativeH3DeviceTuple = { publication_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', owner_id: 167, device_id: 'physical-fixture',
  task_type: declaration.taskType, capability_id: 'video.render', contract_version: 'v1', contract_sha256: 'f'.repeat(64),
  artifact_digest: selection.sourceDigest, source_digest: selection.sourceDigest, config_digest: binding.ownerConfigDigest }
const proof: NativeH3DeviceProof = { ...tuple, schema: 'qianshou.native-h3-device-proof.v1',
  purpose: 'qianshou:native-h3-device-attestor', challenge_nonce: 'verified-sample', challenge_input_sha256: '1'.repeat(64),
  challenge_result_sha256: '2'.repeat(64), result: 'pass', publication_status: 'approved', installation_state: 'installed',
  issued_at: now - 1, expires_at: now + 299 }
function published(): NativeH3PublishedBinding {
  return { ...selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256,
    deviceProof: verifyNativeH3DeviceProof({ key_id: 'purpose-key', payload: proof,
      signature: sign(null, Buffer.from(canonicalNativeH3DeviceProof(proof)), privateKey).toString('base64url') }, tuple, keys, now) }
}

/** This provider simulates fixed-runner output; it is not a GPU or playable-media receipt. */
function provider() {
  const run = vi.fn(async ({ workspacePath }: { workspacePath: string }) => {
    const path = join(workspacePath, 'result.mp4')
    await writeFile(path, '0000ftyp-isolated-native-runner-fixture')
    return { path, filename: 'result.mp4', contentType: 'video/mp4' as const }
  })
  const adapter: ArtifactOrderAdapter = { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
    contractVersion: 'v1', artifactDigest: `sha256:${'9'.repeat(64)}`, packageDigest: binding.ownerConfigDigest,
    outputFormats: ['mp4'], prepareRequest: prepareH3OrderInput, run }
  return { nativeAuthorBinding: vi.fn(async () => binding), loadAndSelfTest: vi.fn(async () => adapter), run }
}

async function workspace() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-h3-publication-fixture-')))
  roots.push(root)
  return root
}

it('keeps author selection independent of approval and pins all three real binding identities', async () => {
  const p = provider()
  expect(await selectNativeH3Binding(p, selection)).toEqual(selection)
  expect(p.run).not.toHaveBeenCalled()
  p.nativeAuthorBinding.mockResolvedValue({ ...binding, executionRecipeSha256: '8'.repeat(64) })
  await expect(selectNativeH3Binding(p, selection)).rejects.toMatchObject({ code: 'H3_NATIVE_SELECTION_INVALID' })
})

it('runs an exact published alias and withdraws when approval, device or recipe identity changes', async () => {
  const p = provider()
  let current: NativeH3PublishedBinding | null = published()
  const alias = await createPublishedNativeH3Adapter(p, current, { ownerId: 167, deviceId: 'physical-fixture' },
    async () => current, () => now)
  expect(alias.taskType).toBe(declaration.taskType)
  expect(alias.artifactDigest).toBe(selection.sourceDigest)
  expect(alias.packageDigest).toBe(binding.ownerConfigDigest)
  expect(isPublishedNativeH3Adapter(alias)).toBe(true)
  expect(isPublishedNativeH3Adapter({ ...alias })).toBe(false)
  expect(nativeH3AdapterClaim({ ...alias })).toBeNull()
  expect(nativeH3AdapterClaim(alias)).toMatchObject({ publication_id: tuple.publication_id,
    native_binding: binding, device_proof_sha256: createHash('sha256').update(canonicalNativeH3DeviceProof(proof)).digest('hex') })
  const input = { recipeJson: '{"prompt":"fixture","seconds":5}', outputFormat: 'mp4' as const,
    workspacePath: await workspace(), signal: new AbortController().signal }
  await alias.run(input)
  expect(p.run).toHaveBeenCalledOnce()
  current = null
  await expect(alias.run(input)).rejects.toMatchObject({ code: 'H3_NATIVE_SELECTION_INVALID' })
  expect(p.run).toHaveBeenCalledOnce()
})

it('never admits a published proof for another physical device or a JSON-copied credential', async () => {
  const p = provider()
  const initial = published()
  await expect(createPublishedNativeH3Adapter(p, initial, { ownerId: 167, deviceId: 'other-pc' },
    async () => initial, () => now)).rejects.toMatchObject({ code: 'H3_NATIVE_SELECTION_INVALID' })
  await expect(createPublishedNativeH3Adapter(p, JSON.parse(JSON.stringify(initial)) as NativeH3PublishedBinding,
    { ownerId: 167, deviceId: 'physical-fixture' }, async () => initial, () => now))
    .rejects.toMatchObject({ code: 'H3_NATIVE_SELECTION_INVALID' })
  expect(p.run).not.toHaveBeenCalled()
})

function challenge(nonce: string) {
  const input = { prompt: '明确虚构样例🙂', seconds: 5 as const, seed: 1 }
  const payload: NativeH3ReviewChallenge = { ...tuple, schema: 'qianshou.native-h3-review-challenge.v1',
    purpose: 'qianshou:native-h3-review-challenge', challenge_nonce: nonce, challenge_input: input,
    challenge_input_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(input)).digest('hex'),
    issued_at: now - 1, expires_at: now + 600 }
  return verifyNativeH3ReviewChallenge({ key_id: 'purpose-key', payload,
    signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), privateKey).toString('base64url') }, tuple, keys, now)
}

function presence() {
  const payload: NativeH3PresenceChallenge = { ...tuple, schema: 'qianshou.native-h3-presence-challenge.v1',
    purpose: 'qianshou:native-h3-presence-challenge', challenge_nonce: Buffer.alloc(32, 1).toString('base64url'),
    native_binding: binding, sample_receipt_sha256: '1'.repeat(64), review_fingerprint: '2'.repeat(64),
    connection_id: 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193', device_key_id: 'enrolled-device-key',
    issued_at: now - 1, expires_at: now + 119 }
  return verifyNativeH3PresenceChallenge({ key_id: 'purpose-key', payload,
    signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), privateKey).toString('base64url') }, tuple, keys, now)
}

it('reads the real binding preparation port for presence without rendering or using a ready boolean', async () => {
  const p = provider()
  const request = { selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256, challenge: presence() }
  const identity = async () => ({ ownerId: 167, deviceId: 'physical-fixture', connectionId: request.challenge.payload.connection_id })
  await validateNativeH3PresenceChallenge(p, request, identity, () => now)
  expect(p.nativeAuthorBinding).toHaveBeenCalledOnce()
  expect(p.loadAndSelfTest).not.toHaveBeenCalled()
  expect(p.run).not.toHaveBeenCalled()
  p.nativeAuthorBinding.mockResolvedValue({ ...binding, modelSha256: '8'.repeat(64) })
  await expect(validateNativeH3PresenceChallenge(p, request, identity, () => now)).rejects.toMatchObject({ code: 'H3_NATIVE_SELECTION_INVALID' })
  expect(p.run).not.toHaveBeenCalled()
})

it('rejects copied presence credentials or a socket/owner change before and after the fresh read', async () => {
  const p = provider()
  const request = { selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256, challenge: presence() }
  let connectionId = request.challenge.payload.connection_id
  const identity = async () => ({ ownerId: 167, deviceId: 'physical-fixture', connectionId })
  const copied = JSON.parse(JSON.stringify(request.challenge)) as typeof request.challenge
  await expect(validateNativeH3PresenceChallenge(p, { ...request, challenge: copied }, identity, () => now))
    .rejects.toMatchObject({ code: 'H3_PRESENCE_VALIDATION_REFUSED' })
  await expect(validateNativeH3PresenceChallenge(p, request,
    async () => ({ ownerId: 222, deviceId: 'physical-fixture', connectionId }), () => now))
    .rejects.toMatchObject({ code: 'H3_PRESENCE_VALIDATION_REFUSED' })
  expect(p.nativeAuthorBinding).not.toHaveBeenCalled()
  p.nativeAuthorBinding.mockImplementation(async () => {
    connectionId = '8576b991-e899-471e-9b12-048f9daf4953'
    return binding
  })
  await expect(validateNativeH3PresenceChallenge(p, request, identity, () => now))
    .rejects.toMatchObject({ code: 'H3_PRESENCE_VALIDATION_REFUSED' })
  expect(p.nativeAuthorBinding).toHaveBeenCalledOnce()
  expect(p.run).not.toHaveBeenCalled()
})

it('runs a distinct pre-approval challenge and uploads only under its dedicated review port', async () => {
  const p = provider()
  const root = await workspace()
  const upload = vi.fn(async (input: { bytes: Uint8Array; sha256: string }) => ({ schema: 'artifact.v1' as const,
    object_key: 'review/fixture/result.mp4', object_version_id: 'locked-fixture-version', filename: 'result.mp4' as const,
    size_bytes: input.bytes.length, content_type: 'video/mp4' as const, sha256: input.sha256, result_id: 'review-only-result' }))
  const request = { selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256,
    challenge: challenge('sample-once'), signal: new AbortController().signal, upload }
  const result = await runNativeH3ReviewChallenge(p, request,
    async () => ({ ownerId: 167, deviceId: 'physical-fixture' }), root, () => now)
  expect(Object.keys(result)).toHaveLength(18)
  expect(result.purpose).toBe('qianshou:native-h3-review-execution')
  expect(result).not.toHaveProperty('publication_status')
  expect(result.challenge_result_sha256).toBe(createHash('sha256').update(canonicalNativeH3ReviewJson(result.artifact)).digest('hex'))
  expect(upload).toHaveBeenCalledOnce()
  expect(await readdir(root)).toEqual(['native-h3-review-claims'])
  const files = await readdir(join(root, 'native-h3-review-claims'))
  expect(files).toHaveLength(1)
  const claim = JSON.parse(await readFile(join(root, 'native-h3-review-claims', files[0] ?? ''), 'utf8')) as {
    schema: string
    state: string
    challenge: NativeH3ReviewChallenge
    challenge_sha256: string
  }
  expect(claim.schema).toBe('qianshou.native-h3-review-claim.v1')
  expect(claim.state).toBe('completed')
  expect(claim.challenge.challenge_nonce).toBe('sample-once')
  expect(claim.challenge_sha256).toBe(createHash('sha256').update(canonicalNativeH3ReviewJson(request.challenge.payload)).digest('hex'))
  if (process.platform !== 'win32') expect((await lstat(join(root, 'native-h3-review-claims', files[0] ?? ''))).mode & 0o777).toBe(0o600)
  await expect(runNativeH3ReviewChallenge(p, request,
    async () => ({ ownerId: 167, deviceId: 'physical-fixture' }), root, () => now))
    .rejects.toMatchObject({ code: 'H3_REVIEW_EXECUTION_REFUSED' })
  expect(p.run).toHaveBeenCalledOnce()
})

async function freshProcessReview(root: string, nonce: string, failRun = false): Promise<{ ran: number; code: string }> {
  const payload = challenge(nonce).payload
  const input = { root, selection, tuple, binding, now, failRun,
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    envelope: { key_id: 'purpose-key', payload,
      signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), privateKey).toString('base64url') } }
  const moduleUrl = new URL('../src/native-h3-review.ts', import.meta.url).href
  const program = `
    import { createPublicKey } from 'node:crypto';
    import { writeFile } from 'node:fs/promises';
    import { join } from 'node:path';
    import { verifyNativeH3ReviewChallenge } from '@deepseek-ai/dsh-compute-core/native-h3-review';
    import { runNativeH3ReviewChallenge } from ${JSON.stringify(moduleUrl)};
    const input = JSON.parse(process.env.QS_NATIVE_REVIEW_FIXTURE);
    const key = createPublicKey({key:Buffer.from(input.publicKey,'base64'),format:'der',type:'spki'});
    const challenge = verifyNativeH3ReviewChallenge(input.envelope,input.tuple,new Map([['purpose-key',key]]),input.now);
    let ran = 0;
    const provider = {nativeAuthorBinding:async()=>input.binding,loadAndSelfTest:async()=>({run:async({workspacePath})=>{
      ran++;
      if(input.failRun) throw new Error('fixture-unknown-after-gpu-start');
      const path=join(workspacePath,'result.mp4');await writeFile(path,'isolated-process-fixture');
      return {path,filename:'result.mp4',contentType:'video/mp4'};
    }})};
    try {
      await runNativeH3ReviewChallenge(provider,{selection:input.selection,publicationId:input.tuple.publication_id,
        contractSha256:input.tuple.contract_sha256,challenge,signal:new AbortController().signal,
        upload:async({bytes,sha256})=>({schema:'artifact.v1',object_key:'review/fixture/result.mp4',
          object_version_id:'immutable-fixture-version',filename:'result.mp4',content_type:'video/mp4',
          size_bytes:bytes.length,sha256,result_id:'review-fixture-result'})},
        async()=>({ownerId:input.tuple.owner_id,deviceId:input.tuple.device_id}),input.root,()=>input.now);
      process.stdout.write(JSON.stringify({ran,code:'success'}));
    } catch(error) {process.stdout.write(JSON.stringify({ran,code:error.code??error.message}));}
  `
  const result = await promisify(execFile)(process.execPath,
    ['--import', 'tsx', '--input-type=module', '--eval', program], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env: { ...process.env, QS_NATIVE_REVIEW_FIXTURE: JSON.stringify(input) }, timeout: 15_000, maxBuffer: 64 * 1024,
    })
  return JSON.parse(result.stdout) as { ran: number; code: string }
}

it.each([false, true])('refuses the same nonce across real fresh processes after GPU started (unknown=%s)', async (unknown) => {
  const root = await workspace()
  const nonce = `durable-real-process-${unknown}`
  expect(await freshProcessReview(root, nonce, unknown)).toEqual({ ran: 1,
    code: unknown ? 'fixture-unknown-after-gpu-start' : 'success' })
  expect(await freshProcessReview(root, nonce)).toEqual({ ran: 0, code: 'H3_REVIEW_EXECUTION_REFUSED' })
  expect(await readdir(root)).toEqual(['native-h3-review-claims'])
  const files = await readdir(join(root, 'native-h3-review-claims'))
  const stored = JSON.parse(await readFile(join(root, 'native-h3-review-claims', files[0] ?? ''), 'utf8')) as { state: string }
  expect(stored.state).toBe(unknown ? 'claimed' : 'completed')
}, 30_000)

it.each(['file', 'link', 'permissions', 'partial-claim'])('never starts GPU when the durable claim is unsafe or unavailable (%s)', async (reason) => {
  const root = await workspace()
  const directory = join(root, 'native-h3-review-claims')
  if (reason === 'file') await writeFile(directory, 'not a directory')
  if (reason === 'link') await symlink(await workspace(), directory, process.platform === 'win32' ? 'junction' : 'dir')
  if (reason === 'permissions') {
    await mkdir(directory, { mode: 0o700 })
    if (process.platform === 'win32') await writeFile(join(directory, 'denied.json'), '')
    else await chmod(directory, 0o777)
  }
  const nonce = `durable-write-failure-${reason}`
  const key = `${tuple.owner_id}\0${tuple.device_id}\0${tuple.publication_id}\0${nonce}`
  const path = join(directory, `${createHash('sha256').update(key).digest('hex')}.json`)
  if (reason === 'partial-claim' || reason === 'permissions' && process.platform === 'win32') {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(path, '')
  }
  const p = provider()
  const upload = vi.fn(async () => { throw new Error('must not upload') })
  await expect(runNativeH3ReviewChallenge(p, { selection, publicationId: tuple.publication_id,
    contractSha256: tuple.contract_sha256, challenge: challenge(nonce), signal: new AbortController().signal, upload },
  async () => ({ ownerId: tuple.owner_id, deviceId: tuple.device_id }), root, () => now)).rejects.toThrow()
  expect(p.run).not.toHaveBeenCalled()
  expect(upload).not.toHaveBeenCalled()
})

async function seedClaims(root: string, count: number, state: string, expired: boolean) {
  const directory = join(root, 'native-h3-review-claims')
  await mkdir(directory, { mode: 0o700 })
  const original = challenge('gc-seed').payload
  for (let offset = 0; offset < count; offset += 50) {
    await Promise.all(Array.from({ length: Math.min(50, count - offset) }, async (_, index) => {
      const nonce = `gc-seed-${offset + index}`
      const payload = { ...original, challenge_nonce: nonce,
        issued_at: expired ? now - 1800 : now - 1, expires_at: expired ? now - 1200 : now + 600 }
      const key = `${tuple.owner_id}\0${tuple.device_id}\0${tuple.publication_id}\0${nonce}`
      await writeFile(join(directory, `${createHash('sha256').update(key).digest('hex')}.json`),
        canonicalNativeH3ReviewJson({ schema: 'qianshou.native-h3-review-claim.v1', state, challenge: payload,
          challenge_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(payload)).digest('hex') }), { mode: 0o600 })
    }))
  }
}

it('cleans 1000 validated expired completed claims and accepts only a fresh issued nonce', async () => {
  const root = await workspace()
  await seedClaims(root, 1000, 'completed', true)
  expect(await freshProcessReview(root, 'gc-new-issued-nonce')).toEqual({ ran: 1, code: 'success' })
  expect(await readdir(join(root, 'native-h3-review-claims'))).toHaveLength(1)
}, 30_000)

it.each(['live-completed', 'expired-unknown'])('keeps a full %s journal and refuses a new GPU run', async (scenario) => {
  const root = await workspace()
  await seedClaims(root, 1024, scenario === 'expired-unknown' ? 'claimed' : 'completed', scenario === 'expired-unknown')
  expect(await freshProcessReview(root, `full-${scenario}`)).toEqual({ ran: 0, code: 'H3_REVIEW_EXECUTION_REFUSED' })
  expect(await readdir(join(root, 'native-h3-review-claims'))).toHaveLength(1024)
}, 30_000)

it.each(['partial', 'hash-mismatch', 'name-mismatch', 'hardlink'])('retains an expired completed marker that cannot safely be collected (%s)', async (reason) => {
  const root = await workspace()
  await seedClaims(root, 1, 'completed', true)
  const directory = join(root, 'native-h3-review-claims')
  const name = (await readdir(directory))[0] ?? ''
  const path = join(directory, name)
  if (reason === 'partial') await writeFile(path, '')
  if (reason === 'hash-mismatch') {
    const metadata = JSON.parse(await readFile(path, 'utf8')) as { challenge_sha256: string }
    await writeFile(path, JSON.stringify({ ...metadata, challenge_sha256: '0'.repeat(64) }))
  }
  if (reason === 'name-mismatch') await rename(path, join(directory, `${'0'.repeat(64)}.json`))
  if (reason === 'hardlink') await link(path, join(root, 'outside-claim-link'))
  expect(await freshProcessReview(root, `safe-new-${reason}`)).toEqual({ ran: 1, code: 'success' })
  expect(await readdir(directory)).toHaveLength(2)
}, 30_000)

it('rejects copied challenges and a changed owner before any native run or upload', async () => {
  const p = provider()
  const upload = vi.fn(async () => { throw new Error('must not upload') })
  const request = { selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256,
    challenge: challenge('owner-check'), signal: new AbortController().signal, upload }
  const root = await workspace()
  await expect(runNativeH3ReviewChallenge(p, request,
    async () => ({ ownerId: 222, deviceId: 'physical-fixture' }), root, () => now))
    .rejects.toMatchObject({ code: 'H3_REVIEW_EXECUTION_REFUSED' })
  const copiedChallenge = JSON.parse(JSON.stringify(request.challenge)) as typeof request.challenge
  await expect(runNativeH3ReviewChallenge(p, { ...request, challenge: copiedChallenge },
    async () => ({ ownerId: 167, deviceId: 'physical-fixture' }), root, () => now))
    .rejects.toMatchObject({ code: 'H3_REVIEW_EXECUTION_REFUSED' })
  expect(p.run).not.toHaveBeenCalled()
  expect(upload).not.toHaveBeenCalled()
})

it.each([false, true])('retains only measured registration facts and routes branded aliases on the current socket (probe=%s)', async (measured) => {
  const server = await FixtureWebSocketServer.start({ script(frame, peer) {
    if (frame.type === 'hello') peer.reply('welcome', { hb_interval_s: 60 })
    if (frame.type === 'auth') peer.reply('auth_ok', { worker_id: 'physical-fixture', owner_id: 167,
      connection_id: 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193' })
    if (frame.type === 'hb') peer.reply('hb_ack', {})
    if (frame.type === 'native_h3_device_presence') peer.reply('native_h3_device_presence_ack', { challenge_nonce: frame.payload.challenge_nonce })
    if (frame.type === 'native_h3_adapter_update') peer.reply('native_h3_adapter_update_ack', {
      request_id: frame.payload.request_id, connection_id: 'bd95f8c2-d3df-4e28-9f64-c6e7b471b193', status: 'accepted',
      task_types: (frame.payload.adapters as { task_type: string }[]).map(item => item.task_type),
    })
  } })
  try {
    const p = provider()
    const initial = published()
    const alias = await createPublishedNativeH3Adapter(p, initial, { ownerId: 167, deviceId: 'physical-fixture' },
      async () => initial, () => now)
    let available = true
    const edge = bindInlineEdgeResident({ nodeId: 'native-fixture', agentVersion: 'fixture', allowedTaskTypes: [],
      allowEmptyDynamicAdapterRegistration: () => true,
      handshakeTimeoutMs: 2000, maxFrameBytes: 65536, maxOutputBytes: 4096, supply: () => 'paused',
      originOf: () => server.origin, tokenOf: async () => 'fixture-token', ownerIdOf: async () => 167, verification: false,
      probe: async () => {
        if (!measured) throw new Error('fixture, not a hardware survey')
        return { hardware: { platform: 'win32', arch: 'x64', cpuModel: 'fixture CPU', logicalCores: 8,
          totalMemoryBytes: 32 * 1024 ** 3, freeMemoryBytes: 16 * 1024 ** 3, probeErrors: [],
          gpus: [{ name: 'fixture RTX 5080', vendor: 'NVIDIA', memoryBytes: 16 * 1024 ** 3 }] },
        localServices: [{ id: 'node', kind: 'tool', name: 'Node.js', version: '22.0.0', verification: 'verified', reason: null }],
        activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null } }
      },
      publishedNativeArtifactOrders: async (): Promise<ArtifactOrderAdapter[]> => available && edge.connectionId() !== null
        ? [alias, { ...alias, taskType: 'forged_alias' }] : [] })
    const session = await edge.connector.connect(new AbortController().signal)
    expect(edge.connectionId()).toBe('bd95f8c2-d3df-4e28-9f64-c6e7b471b193')
    await edge.observeNativeH3DevicePresence({ challengeNonce: Buffer.alloc(32, 1).toString('base64url'),
      signature: Buffer.alloc(64, 1).toString('base64url') })
    const hello = server.frames.find(frame => frame.type === 'hello')?.payload.capabilities as Record<string, unknown>
    expect(hello.verified_task_adapters).toEqual([])
    expect(hello.provided_capabilities).toEqual([])
    const update = server.frames.find(frame => frame.type === 'native_h3_adapter_update')?.payload
    expect(update?.adapters).toContainEqual(expect.objectContaining({ task_type: alias.taskType,
      capability_id: 'video.render', artifact_digest: selection.sourceDigest }))
    expect(update?.adapters).not.toContainEqual(expect.objectContaining({ task_type: 'forged_alias' }))
    expect((update?.adapters as { native_binding: unknown }[])[0]?.native_binding).toEqual(binding)
    if (measured) {
      expect(hello).toMatchObject({ gpu_count: 1, gpu_model: 'fixture RTX 5080 (NVIDIA)', vram_mb: 16384,
        runtimes: ['node'], software: ['node'] })
    } else {
      expect(hello.gpu_count).toBeUndefined()
      expect(hello.runtimes).toBeUndefined()
      expect(hello.software).toBeUndefined()
    }
    const offer = { workerId: 'physical-fixture', workloadId: 'fixture-only', shardId: 'shard', attempt: 0,
      taskType: alias.taskType, runtime: 'python3', inputKind: 'inline', inlineInput: '虚构镜头', inputRef: '',
      inputRefs: [], codeUrl: '', codeSha256: '', timeoutSeconds: 1500, verificationPolicy: 'semantic' as const,
      executionModel: '', capability: '', capabilityVersion: '', params: { seconds: 5 } }
    const context = { workerId: 'physical-fixture', receivedAt: '2026-09-27T00:00:00.000Z' }
    expect(edge.binding.bridge.toNodeOffer(offer, context)).toMatchObject({ envelope: {
      capabilityId: 'video.render', maxOutputBytes: 16 * 1024 * 1024 } })
    expect(edge.verifiedArtifactTaskTypes()).toEqual([alias.taskType])
    await session.close()
    expect(edge.connectionId()).toBeNull()
    available = false
    const next = await edge.connector.connect(new AbortController().signal)
    expect(edge.binding.bridge.toNodeOffer(offer, context)).toEqual({ refuse: 'TASK_TYPE_DENIED' })
    expect(edge.verifiedArtifactTaskTypes()).toEqual([])
    const withdrawn = server.frames.filter(frame => frame.type === 'hello').at(-1)?.payload.capabilities as Record<string, unknown>
    expect(withdrawn.software).toEqual(measured ? ['node'] : undefined)
    expect(withdrawn.verified_task_adapters).toEqual([])
    expect(withdrawn.provided_capabilities).toEqual([])
    await next.close()
  } finally { await server.close() }
})
