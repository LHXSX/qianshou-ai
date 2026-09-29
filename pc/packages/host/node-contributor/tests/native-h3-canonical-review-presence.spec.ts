/** Actual signed canonical tuples exercise the Node consumers; synthetic output is never GPU evidence. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_CANONICAL, NATIVE_H3_RUNTIME_CANONICAL, nativeH3LogicalBindingSha256,
  parseNativeH3CanonicalDeclaration, parseNativeH3CanonicalExecutionBinding } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalNativeH3ReviewJson, verifyNativeH3ReviewChallengeV2 } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { verifyNativeH3PresenceChallengeV2 } from '@deepseek-ai/dsh-compute-core/native-h3-presence'
import { runNativeH3ReviewChallenge, readOwnedNativeH3ReviewExecutionPermit } from '../src/native-h3-review.ts'
import { validateNativeH3PresenceChallenge } from '../src/native-h3-presence.ts'
import { createDynamicH3VideoProvider } from '../src/h3-dynamic-provider.ts'
import { H3OwnerSetup } from '../src/h3-owner-setup.ts'
import type { ArtifactOrderAdapter } from '../src/artifact-order.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
const now = 1_790_000_000
const connectionId = '22222222-2222-4222-8222-222222222222'
const binding = parseNativeH3CanonicalExecutionBinding({ schema: 'qianshou.native-h3-execution-binding.v2',
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_CANONICAL, runtime: NATIVE_H3_RUNTIME_CANONICAL,
  executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: 'c'.repeat(64) })
const declaration = parseNativeH3CanonicalDeclaration({ ...binding, schema: 'qianshou.native-h3-binding.v2',
  taskType: 'canonical_review_cpu_fixture_v2', capabilityId: 'video.render', inputKinds: ['inline'],
  outputKind: 'artifact_ref', contractVersion: 'v2', category: 'video', platformDispatchable: true })
const selection = { declaration, sourceDigest: 'sha256:' + 'd'.repeat(64), taskDefinitionSha256: 'sha256:' + 'e'.repeat(64),
  localOwnerConfigDigest: 'sha256:' + 'f'.repeat(64) }
const tuple = { publication_id: '11111111-1111-4111-8111-111111111111', owner_id: 7, device_id: 'physical-a',
  task_type: declaration.taskType, capability_id: 'video.render' as const, contract_version: 'v2' as const,
  contract_sha256: '1'.repeat(64), artifact_digest: selection.sourceDigest, source_digest: selection.sourceDigest,
  logical_binding_sha256: nativeH3LogicalBindingSha256(binding), local_owner_config_digest: selection.localOwnerConfigDigest,
  device_binding_revision: 1 }
const pair = generateKeyPairSync('ed25519')
const keys = new Map([['fixture', pair.publicKey]])
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
function envelope(payload: unknown) {
  return { key_id: 'fixture', payload,
    signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), pair.privateKey).toString('base64url') }
}
function provider() {
  const state = { privateDigest: tuple.local_owner_config_digest }
  const run = vi.fn<ArtifactOrderAdapter['run']>(async (input) => {
    const path = join(input.workspacePath, 'result.mp4')
    await writeFile(path, '0000ftyp CPU fixture bytes, not a video render')
    return { path, filename: 'result.mp4', contentType: 'video/mp4' }
  })
  const adapter: ArtifactOrderAdapter = { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
    contractVersion: 'v1', artifactDigest: selection.sourceDigest, packageDigest: selection.localOwnerConfigDigest,
    outputFormats: ['mp4'], run }
  return { state, run, status: () => ({ configured: true, ready: true, code: 'H3_CANONICAL_REAL_SELF_TEST_VERIFIED' }),
    nativeAuthorBinding: vi.fn(async () => { throw new Error('No V1 fallback') }),
    nativeAuthorBindingV2: vi.fn(async () => { throw new Error('No V2 fallback') }),
    nativeAuthorBindingCanonical: vi.fn(async () => ({ binding, localOwnerConfigDigest: state.privateDigest })),
    loadAndSelfTest: vi.fn(async () => { throw new Error('No V1 runtime fallback') }),
    loadAndSelfTestV2: vi.fn(async () => { throw new Error('No V2 runtime fallback') }),
    loadAndSelfTestCanonical: vi.fn(async () => adapter) }
}
function presence() {
  return verifyNativeH3PresenceChallengeV2(envelope({ ...tuple, schema: 'qianshou.native-h3-presence-challenge.v2',
    purpose: 'qianshou:native-h3-presence-challenge.v2', challenge_nonce: Buffer.alloc(32, 1).toString('base64url'),
    native_binding: binding, sample_receipt_sha256: '2'.repeat(64), review_fingerprint: '3'.repeat(64),
    connection_id: connectionId, device_key_id: 'enrolled-device', issued_at: now - 1, expires_at: now + 119 }), tuple, keys, now)
}
it('validates actual signed canonical presence through the exact ABI identity port with zero preparation or execution', async () => {
  const p = provider()
  const request = { selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256, challenge: presence() }
  await validateNativeH3PresenceChallenge(p, request,
    async () => ({ ownerId: tuple.owner_id, deviceId: tuple.device_id, connectionId }), () => now)
  expect(p.nativeAuthorBindingCanonical).toHaveBeenCalledOnce()
  expect(p.nativeAuthorBinding).not.toHaveBeenCalled(); expect(p.nativeAuthorBindingV2).not.toHaveBeenCalled()
  expect(p.loadAndSelfTest).not.toHaveBeenCalled(); expect(p.loadAndSelfTestV2).not.toHaveBeenCalled()
  expect(p.loadAndSelfTestCanonical).not.toHaveBeenCalled(); expect(p.run).not.toHaveBeenCalled()
})
it.each(['owner', 'connection', 'private', 'source', 'serialized', 'expiry'] as const)
('refuses canonical presence %s without falling back or executing', async (failure) => {
  const p = provider()
  const challenge = presence()
  if (failure === 'private') p.state.privateDigest = 'sha256:' + '9'.repeat(64)
  const request = { selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256,
    challenge: failure === 'serialized' ? { ...challenge } : challenge }
  if (failure === 'source') request.selection = { ...selection, sourceDigest: 'sha256:' + '9'.repeat(64) }
  await expect(validateNativeH3PresenceChallenge(p, request,
    async () => ({ ownerId: failure === 'owner' ? 8 : tuple.owner_id, deviceId: tuple.device_id,
      connectionId: failure === 'connection' ? '33333333-3333-4333-8333-333333333333' : connectionId }),
    () => failure === 'expiry' ? now + 120 : now)).rejects.toThrow()
  expect(p.run).not.toHaveBeenCalled(); expect(p.loadAndSelfTestCanonical).not.toHaveBeenCalled()
  expect(p.nativeAuthorBindingV2).not.toHaveBeenCalled(); expect(p.nativeAuthorBinding).not.toHaveBeenCalled()
})
it('executes two distinct canonical signed review nonces through the canonical port and preserves upload metadata', async () => {
  const p = provider()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qs-canonical-review-'))); roots.push(root)
  const home = join(root, 'home')
  const configPath = join(root, 'config.json')
  await writeFile(configPath, JSON.stringify({ schema: 'qianshou.h3-owner.canonical.v1' }))
  const setup = new H3OwnerSetup({ homePath: home, runtimeDirectory: root,
    readScope: async () => ({ ownerId: tuple.owner_id, profileDir: root }),
    assertIdle: async () => { throw new Error('Review must not use ordinary trial idle') },
    assertReviewedExecution: async (permit) => {
      const facts = readOwnedNativeH3ReviewExecutionPermit(permit)
      expect(facts.ownerId).toBe(tuple.owner_id); expect(facts.deviceId).toBe(tuple.device_id)
    }, onSaved: async () => {} })
  const dynamic = createDynamicH3VideoProvider({ resolveConfiguration: async () => ({ path: configPath, identity: 'same' }),
    assertNewExecution: () => setup.assertTrialAdmission(), onChanged: () => {}, createCanonical: () => p })
  const uploads: Uint8Array[] = []
  for (const seed of [1, 2]) {
    const input = { prompt: '真实中文独立审样', seconds: 5, seed }
    const challenge = verifyNativeH3ReviewChallengeV2(envelope({ ...tuple,
      schema: 'qianshou.native-h3-review-challenge.v2', purpose: 'qianshou:native-h3-review-challenge.v2',
      challenge_nonce: Buffer.alloc(32, seed).toString('base64url'), challenge_input: input,
      challenge_input_sha256: sha(canonicalNativeH3ReviewJson(input)), issued_at: now - 1, expires_at: now + 899 }), tuple, keys, now)
    const output = await runNativeH3ReviewChallenge(dynamic, { selection, publicationId: tuple.publication_id,
      contractSha256: tuple.contract_sha256, challenge, signal: new AbortController().signal,
      assertBindingCurrent: async () => {}, upload: async (media) => {
        expect(await setup.readTrialAdmission()).toEqual({ state: 'unknown' })
        expect(JSON.parse(await readFile(join(home, 'qianshou-h3-owner', 'execution-reservation.json'), 'utf8')))
          .toMatchObject({ state: 'pending', runtime: 'canonical' })
        uploads.push(media.bytes)
        return { schema: 'artifact.v1', object_key: 'review/result.mp4', object_version_id: `immutable-v${seed}`,
          filename: media.filename, size_bytes: media.bytes.byteLength, content_type: media.contentType,
          sha256: media.sha256, result_id: `review-${seed}` }
      } }, async () => ({ ownerId: tuple.owner_id, deviceId: tuple.device_id }), root, () => now,
    (permit, execute) => setup.runReviewedReservedExecution(permit, execute,
      async result => result.challenge_result_sha256), permit => dynamic.runReviewedExecution(permit))
    expect(output).toMatchObject({ schema: 'qianshou.native-h3-review-execution.v2',
      local_owner_config_digest: tuple.local_owner_config_digest, device_binding_revision: 1,
      challenge_nonce: challenge.payload.challenge_nonce })
  }
  expect(await setup.readTrialAdmission()).toEqual({ state: 'clear' })
  expect(p.run).toHaveBeenCalledTimes(2); expect(uploads).toHaveLength(2)
  expect(p.loadAndSelfTestV2).not.toHaveBeenCalled(); expect(p.loadAndSelfTest).not.toHaveBeenCalled()
  expect(await readFile(join(root, 'native-h3-review-claims', sha(`${tuple.owner_id}\0${tuple.device_id}\0${tuple.publication_id}\0${Buffer.alloc(32, 1).toString('base64url')}`) + '.json'), 'utf8'))
    .toContain('"state":"completed"')
})

async function reviewFixture() {
  const p = provider()
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qs-canonical-review-owned-'))); roots.push(root)
  const home = join(root, 'home')
  const configPath = join(root, 'owner.json')
  await writeFile(configPath, '{"schema":"qianshou.h3-owner.canonical.v1"}')
  const state = { ownerId: tuple.owner_id, headCurrent: true }
  const setup = new H3OwnerSetup({ homePath: home, runtimeDirectory: root,
    readScope: async () => ({ ownerId: state.ownerId, profileDir: root }),
    assertIdle: async () => { throw new Error('Review cannot reuse ordinary trial idle') },
    assertReviewedExecution: async (permit) => {
      const facts = readOwnedNativeH3ReviewExecutionPermit(permit)
      if (state.ownerId !== facts.ownerId) throw new Error('Original review owner changed')
    }, onSaved: async () => {} })
  const dynamic = createDynamicH3VideoProvider({ resolveConfiguration: async () => ({ path: configPath, identity: 'same' }),
    assertNewExecution: () => setup.assertTrialAdmission(), onChanged: () => {}, createCanonical: () => p })
  const upload = vi.fn(async (media: { bytes: Uint8Array; sha256: string }) => ({ schema: 'artifact.v1',
    object_key: 'review/result.mp4', object_version_id: 'immutable-v', filename: 'result.mp4',
    size_bytes: media.bytes.byteLength, content_type: 'video/mp4', sha256: media.sha256, result_id: 'review-cpu' }))
  function request(seed: number) {
    const input = { prompt: '独立签名中文审样', seconds: 5, seed }
    const challenge = verifyNativeH3ReviewChallengeV2(envelope({ ...tuple,
      schema: 'qianshou.native-h3-review-challenge.v2', purpose: 'qianshou:native-h3-review-challenge.v2',
      challenge_nonce: Buffer.alloc(32, seed).toString('base64url'), challenge_input: input,
      challenge_input_sha256: sha(canonicalNativeH3ReviewJson(input)), issued_at: now - 1, expires_at: now + 899 }), tuple, keys, now)
    return { selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256,
      challenge, signal: new AbortController().signal, upload,
      assertBindingCurrent: async () => { if (!state.headCurrent) throw new Error('Original review head changed') } }
  }
  const run = (seed: number) => runNativeH3ReviewChallenge(dynamic, request(seed),
    async () => ({ ownerId: state.ownerId, deviceId: tuple.device_id }), root, () => now,
    (permit, execute) => setup.runReviewedReservedExecution(permit, execute, async result => result.challenge_result_sha256),
    permit => dynamic.runReviewedExecution(permit))
  return { p, root, home, configPath, state, setup, dynamic, upload, request, run }
}

it('refuses a canonical direct call without the owning shared reservation, with zero execution or upload', async () => {
  const f = await reviewFixture()
  await expect(runNativeH3ReviewChallenge(f.dynamic, f.request(11),
    async () => ({ ownerId: tuple.owner_id, deviceId: tuple.device_id }), f.root, () => now)).rejects.toThrow()
  expect(f.p.run).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled()
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'clear' })
})

it('refuses a structural permit and cannot reuse the original after a completed reservation', async () => {
  const f = await reviewFixture()
  let original: Parameters<typeof readOwnedNativeH3ReviewExecutionPermit>[0] | undefined
  await runNativeH3ReviewChallenge(f.dynamic, f.request(12),
    async () => ({ ownerId: tuple.owner_id, deviceId: tuple.device_id }), f.root, () => now,
    async (permit, execute) => {
      original = permit
      await expect(f.setup.runReviewedReservedExecution({ ...permit }, execute,
        async result => result.challenge_result_sha256)).rejects.toThrow()
      return f.setup.runReviewedReservedExecution(permit, execute, async result => result.challenge_result_sha256)
    }, permit => f.dynamic.runReviewedExecution(permit))
  if (original === undefined) throw new Error('Original review must mint its private permit')
  await expect(f.dynamic.runReviewedExecution(original)).rejects.toThrow()
  await expect(f.run(12)).rejects.toThrow()
  expect(f.p.run).toHaveBeenCalledOnce(); expect(f.upload).toHaveBeenCalledOnce()
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'clear' })
})

it.each(['raw', 'upload', 'private', 'head', 'config', 'owner'] as const)(
  'retains the original nonce and same-HOME uncertainty after review %s failure without automatic execution', async (failure) => {
    const f = await reviewFixture()
    if (failure === 'raw') f.p.run.mockRejectedValueOnce(new Error('External execution outcome unknown'))
    if (failure === 'upload') f.upload.mockRejectedValueOnce(new Error('Upload outcome unknown'))
    if (failure === 'private' || failure === 'head' || failure === 'config' || failure === 'owner') {
      f.p.run.mockImplementationOnce(async (input) => {
        if (failure === 'private') f.p.state.privateDigest = 'sha256:' + '9'.repeat(64)
        if (failure === 'head') f.state.headCurrent = false
        if (failure === 'owner') f.state.ownerId = 8
        if (failure === 'config') await writeFile(f.configPath, '{"schema":"qianshou.h3-owner.canonical.v1","foreign":true}')
        const path = join(input.workspacePath, 'result.mp4'); await writeFile(path, '0000ftyp CPU unknown output')
        return { path, filename: 'result.mp4', contentType: 'video/mp4' }
      })
    }
    const nonceSeed = 40 + ['raw', 'upload', 'private', 'head', 'config', 'owner'].indexOf(failure) * 2
    await expect(f.run(nonceSeed)).rejects.toThrow()
    expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
    await expect(f.run(nonceSeed + 1)).rejects.toThrow()
    expect(f.p.run).toHaveBeenCalledOnce()
    expect(f.upload).toHaveBeenCalledTimes(failure === 'upload' ? 1 : 0)
    const journal = await readFile(join(f.home, 'qianshou-h3-owner', 'execution-reservation.json'), 'utf8')
    expect(JSON.parse(journal)).toMatchObject({ state: 'unknown', runtime: 'canonical' })
  })

it('pure signed presence remains readable during unresolved review occupancy and does not clear its journal', async () => {
  const f = await reviewFixture()
  f.upload.mockRejectedValueOnce(new Error('Unknown upload'))
  await expect(f.run(30)).rejects.toThrow()
  const journalPath = join(f.home, 'qianshou-h3-owner', 'execution-reservation.json')
  const before = await readFile(journalPath)
  await validateNativeH3PresenceChallenge(f.dynamic, { selection, publicationId: tuple.publication_id,
    contractSha256: tuple.contract_sha256, challenge: presence() },
  async () => ({ ownerId: tuple.owner_id, deviceId: tuple.device_id, connectionId }), () => now)
  expect((await readFile(journalPath)).equals(before)).toBe(true)
  expect(f.p.run).toHaveBeenCalledOnce(); expect(f.upload).toHaveBeenCalledOnce()
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
})


it('refuses a serialized challenge brand before preparation or any shared reservation', async () => {
  const f = await reviewFixture()
  const request = f.request(71)
  await expect(runNativeH3ReviewChallenge(f.dynamic, { ...request, challenge: { ...request.challenge } },
    async () => ({ ownerId: tuple.owner_id, deviceId: tuple.device_id }), f.root, () => now,
    (permit, execute) => f.setup.runReviewedReservedExecution(permit, execute, async result => result.challenge_result_sha256),
    permit => f.dynamic.runReviewedExecution(permit))).rejects.toThrow()
  expect(f.p.run).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled()
  expect(f.p.loadAndSelfTestCanonical).not.toHaveBeenCalled()
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'clear' })
})

it('refuses an original review permit at a different provider instance instead of using its arbitrary runner', async () => {
  const f = await reviewFixture()
  const foreign = createDynamicH3VideoProvider({ resolveConfiguration: async () => ({ path: f.configPath, identity: 'same' }),
    onChanged: () => {}, createCanonical: () => f.p })
  await foreign.loadAndSelfTestCanonical()
  await expect(runNativeH3ReviewChallenge(f.dynamic, f.request(72),
    async () => ({ ownerId: tuple.owner_id, deviceId: tuple.device_id }), f.root, () => now,
    (permit, execute) => f.setup.runReviewedReservedExecution(permit, execute, async result => result.challenge_result_sha256),
    permit => foreign.runReviewedExecution(permit))).rejects.toThrow()
  expect(f.p.run).not.toHaveBeenCalled(); expect(f.upload).not.toHaveBeenCalled()
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
})
