import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_V2, NATIVE_H3_RUNTIME_ABI_V2, nativeH3LogicalBindingSha256,
  parseNativeH3DeclarationV2, type NativeH3ExecutionBindingV2 } from '../../compute-core/src/native-h3-binding.ts'
import { verifyNativeH3DeviceProofV2, type NativeH3DeviceTupleV2 } from '../../compute-core/src/native-h3-device-proof.ts'
import { canonicalNativeH3ReviewJson, verifyNativeH3ReviewChallengeV2 } from '../../compute-core/src/native-h3-review.ts'
import { verifyNativeH3PresenceChallengeV2 } from '../../compute-core/src/native-h3-presence.ts'
import { createPublishedNativeH3Adapter, nativeH3AdapterClaim, type NativeH3PublishedBinding } from '../src/native-h3-publication.ts'
import { createInlineEdgeBinding } from '../../compute-core/src/transport/inline-edge-bridge.ts'
import type { ComputeResidentAttemptExecution } from '../../compute-core/src/resident/index.ts'
import { createArtifactOrderConsumer, validateArtifactOrderAdapter } from '../src/artifact-order.ts'
import { parseNativeH3TaskLeaseV2 } from '../../compute-core/src/native-h3-task-lease.ts'
import { prepareH3OrderInput } from '../src/h3-video.ts'
import { bindInlineEdgeResident } from '../src/edge-binding.ts'
import { runNativeH3ReviewChallenge } from '../src/native-h3-review.ts'
import { validateNativeH3PresenceChallenge } from '../src/native-h3-presence.ts'

const NOW = 1790000000
const pair = generateKeyPairSync('ed25519')
const keys = new Map([['fixture', pair.publicKey]])
const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))))
const binding: NativeH3ExecutionBindingV2 = { schema: 'qianshou.native-h3-execution-binding.v2',
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
  executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: 'c'.repeat(64) }
const declaration = parseNativeH3DeclarationV2({ ...binding, schema: 'qianshou.native-h3-binding.v2',
  taskType: 'fixture_h3_v2', capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref',
  contractVersion: 'v2', category: 'video', platformDispatchable: true })
const selection = { declaration, sourceDigest: `sha256:${'d'.repeat(64)}`,
  taskDefinitionSha256: `sha256:${'e'.repeat(64)}` }
const tuple: NativeH3DeviceTupleV2 = { publication_id: '11111111-1111-4111-8111-111111111111', owner_id: 167,
  device_id: 'physical-a', task_type: declaration.taskType, capability_id: 'video.render', contract_version: 'v2',
  contract_sha256: 'f'.repeat(64), artifact_digest: selection.sourceDigest, source_digest: selection.sourceDigest,
  logical_binding_sha256: nativeH3LogicalBindingSha256(binding), local_owner_config_digest: `sha256:${'1'.repeat(64)}`,
  device_binding_revision: 1 }
const connectionId = '22222222-2222-4222-8222-222222222222'
const deviceKeyId = 'enrolled-device'
function lease(identity = tuple) {
  const context = { ownerId: 167, deviceId: 'physical-a', connectionId, taskType: declaration.taskType,
    workloadId: '33333333-3333-4333-8333-333333333333', shardId: '44444444-4444-4444-8444-444444444444', attempt: 1 }
  return parseNativeH3TaskLeaseV2({ ...identity, schema: 'qianshou.native-h3-task-lease.v2',
    device_key_id: deviceKeyId, connection_id: connectionId, workload_id: context.workloadId,
    shard_id: context.shardId, attempt: 1 }, context)
}
const nonce = Buffer.alloc(32, 42).toString('base64url')
function envelope(payload: unknown) {
  return { key_id: 'fixture', payload,
    signature: sign(null, Buffer.from(canonicalNativeH3ReviewJson(payload)), pair.privateKey).toString('base64url') }
}
function published(identity = tuple, epoch = NOW): NativeH3PublishedBinding {
  const payload = { ...identity, schema: 'qianshou.native-h3-device-proof.v2', purpose: 'qianshou:native-h3-device-attestor.v2',
    challenge_nonce: nonce, challenge_input_sha256: '2'.repeat(64), challenge_result_sha256: '3'.repeat(64),
    result: 'pass', publication_status: 'approved', installation_state: 'installed', issued_at: epoch - 1, expires_at: epoch + 299 }
  return { ...selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256,
    connectionId, deviceKeyId, deviceProof: verifyNativeH3DeviceProofV2(envelope(payload), identity, keys, epoch) }
}
function provider() {
  const state = { privateDigest: tuple.local_owner_config_digest }
  const run = vi.fn(async (input: { workspacePath: string }) => {
    const path = join(input.workspacePath, 'result.mp4')
    await writeFile(path, '0000ftyp-isolated fixture, not real GPU media')
    return { path, filename: 'result.mp4', contentType: 'video/mp4' as const }
  })
  const adapter = { taskType: 'video_generate', inputKind: 'inline' as const, outputKind: 'artifact_ref' as const,
    contractVersion: 'v1' as const, artifactDigest: selection.sourceDigest, packageDigest: tuple.local_owner_config_digest,
    outputFormats: ['mp4'] as const, prepareRequest: prepareH3OrderInput, run }
  return { state, run, nativeAuthorBinding: vi.fn(async () => { throw new Error('v1 identity cannot prepare v2') }),
    nativeAuthorBindingV2: vi.fn(async () => ({ binding, localOwnerConfigDigest: state.privateDigest })),
    loadAndSelfTest: vi.fn(async () => { throw new Error('v1 runtime cannot run v2') }),
    loadAndSelfTestV2: vi.fn(async () => adapter) }
}
async function workspace() {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'native-h3-v2-runtime-')))
  roots.push(path)
  return path
}
it('admits only independently proven v2 aliases, including the actual consumer validation boundary', async () => {
  const p = provider()
  let current: NativeH3PublishedBinding | null = published()
  const alias = await createPublishedNativeH3Adapter(p, current, { ownerId: 167, deviceId: 'physical-a', connectionId },
    async () => current, () => NOW)
  validateArtifactOrderAdapter(alias)
  expect(alias.contractVersion).toBe('v2')
  expect(() =>{  validateArtifactOrderAdapter({ ...alias }) }).toThrow('COMPUTE_ARTIFACT_ADAPTER_INVALID')
  const claim = nativeH3AdapterClaim(alias)
  expect(claim && Object.keys(claim)).toHaveLength(16)
  expect(claim).toMatchObject({ package_digest: `sha256:${tuple.logical_binding_sha256}`,
    local_owner_config_digest: tuple.local_owner_config_digest, device_binding_revision: 1, native_binding: binding })
  const input = { recipeJson: '{"prompt":"普通中文需求","seconds":5}', outputFormat: 'mp4' as const,
    workspacePath: await workspace(), signal: new AbortController().signal, nativeDeviceLease: lease() }
  await expect(alias.run({ ...input, nativeDeviceLease: { ...input.nativeDeviceLease } })).rejects.toThrow()
  await alias.run(input)
  expect(p.run).toHaveBeenCalledOnce()
  // Back to the same private bytes is revision 3, not revival of revision 1.
  current = published({ ...tuple, device_binding_revision: 3 })
  await expect(alias.run(input)).rejects.toMatchObject({ code: 'H3_NATIVE_SELECTION_INVALID' })
  expect(p.run).toHaveBeenCalledOnce()
  await expect(createPublishedNativeH3Adapter(p, published(), { ownerId: 167, deviceId: 'physical-b', connectionId },
    async () => published(), () => NOW)).rejects.toThrow()
  p.state.privateDigest = `sha256:${'9'.repeat(64)}`
  await expect(createPublishedNativeH3Adapter(p, published(), { ownerId: 167, deviceId: 'physical-a', connectionId },
    async () => published(), () => NOW)).rejects.toThrow()
  expect(p.nativeAuthorBinding).not.toHaveBeenCalled()
})
it('requires the current revision before GPU and preserves durable unknown nonces across repeated attempts', async () => {
  const p = provider()
  const challengeInput = { prompt: '独立中文样例', seconds: 5 }
  const payload = { ...tuple, schema: 'qianshou.native-h3-review-challenge.v2', purpose: 'qianshou:native-h3-review-challenge.v2',
    challenge_nonce: nonce, challenge_input: challengeInput,
    challenge_input_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(challengeInput)).digest('hex'),
    issued_at: NOW - 1, expires_at: NOW + 899 }
  const challenge = verifyNativeH3ReviewChallengeV2(envelope(payload), tuple, keys, NOW)
  const root = await workspace()
  let revision = 3
  const assertBindingCurrent = async () => { if (revision !== 1) throw new Error('stale authoritative revision') }
  const upload = vi.fn(async () => { throw new Error('unknown storage outcome') })
  const request = { selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256,
    challenge, signal: new AbortController().signal, assertBindingCurrent, upload }
  await expect(runNativeH3ReviewChallenge(p, request, async () => ({ ownerId: 167, deviceId: 'physical-a' }), root, () => NOW))
    .rejects.toThrow('stale authoritative revision')
  expect(p.run).not.toHaveBeenCalled()
  revision = 1
  await expect(runNativeH3ReviewChallenge(p, request, async () => ({ ownerId: 167, deviceId: 'physical-a' }), root, () => NOW))
    .rejects.toThrow('unknown storage outcome')
  expect(p.run).toHaveBeenCalledOnce()
  await expect(runNativeH3ReviewChallenge(p, request, async () => ({ ownerId: 167, deviceId: 'physical-a' }), root, () => NOW))
    .rejects.toMatchObject({ code: 'H3_REVIEW_EXECUTION_REFUSED' })
  expect(p.run).toHaveBeenCalledOnce()
  expect(upload).toHaveBeenCalledOnce()
})
it('presence reads current private preparation without rerendering and refuses a different private configuration', async () => {
  const p = provider()
  const payload = { ...tuple, schema: 'qianshou.native-h3-presence-challenge.v2', purpose: 'qianshou:native-h3-presence-challenge.v2',
    challenge_nonce: nonce, native_binding: binding, sample_receipt_sha256: '4'.repeat(64), review_fingerprint: '5'.repeat(64),
    connection_id: connectionId, device_key_id: 'enrolled-device', issued_at: NOW - 1, expires_at: NOW + 119 }
  const challenge = verifyNativeH3PresenceChallengeV2(envelope(payload), tuple, keys, NOW)
  const request = { selection: { ...selection, localOwnerConfigDigest: tuple.local_owner_config_digest },
    publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256, challenge }
  const identity = async () => ({ ownerId: 167, deviceId: 'physical-a', connectionId })
  await validateNativeH3PresenceChallenge(p, request, identity, () => NOW)
  p.state.privateDigest = `sha256:${'8'.repeat(64)}`
  await expect(validateNativeH3PresenceChallenge(p, request, identity, () => NOW)).rejects.toThrow()
  expect(p.run).not.toHaveBeenCalled()
  expect(p.loadAndSelfTest).not.toHaveBeenCalled()
})

it('rejects a queued revision1 job after revision2 selection through the real HMAC bridge and consumer, before invoking a GPU runner', async () => {
  const p = provider()
  const current = published({ ...tuple, device_binding_revision: 2 })
  const alias = await createPublishedNativeH3Adapter(p, current, { ownerId: 167, deviceId: 'physical-a', connectionId },
    async () => current, () => NOW)
  const original = lease()
  const bridge = createInlineEdgeBinding({ nodeId: 'local-node', allowedTaskTypes: [declaration.taskType],
    artifactTaskTypes: [declaration.taskType], artifactMaxOutputBytes: 16 * 1024 * 1024, maxOutputBytes: 4096,
    sessionKey: Buffer.alloc(32, 4) })
  const mapped = bridge.bridge.toNodeOffer({ workerId: tuple.device_id, workloadId: original.workload_id, shardId: original.shard_id,
    attempt: 1, taskType: declaration.taskType, runtime: 'python3', inputKind: 'inline', inlineInput: '中文描述', inputRef: '', inputRefs: [],
    codeUrl: '', codeSha256: '', timeoutSeconds: 1500, verificationPolicy: 'artifact', executionModel: '',
    capability: '', capabilityVersion: '',
    params: { seconds: 5 }, nativeDeviceLease: original }, { receivedAt: '2026-09-27T03:00:00.000Z', workerId: tuple.device_id })
  if ('refuse' in mapped) throw new Error(mapped.refuse)
  const local = bridge.leaseOf(mapped.envelope.taskId, mapped.attempt, mapped.leaseExpiresAt)
  const execution: ComputeResidentAttemptExecution = { task: mapped.envelope,
    attempt: { taskId: mapped.envelope.taskId, attempt: mapped.attempt, leaseId: local.leaseId, leaseExpiresAt: local.expiresAt,
      idempotencyKey: local.idempotencyKey, envelopeFingerprint: 'a'.repeat(64), capabilityId: mapped.envelope.capabilityId,
      capabilityVersion: mapped.envelope.capabilityVersion, capabilityPluginDigest: local.capabilityPluginDigest },
    signal: new AbortController().signal, reportProgress: vi.fn(async () => undefined),
    source: { open: async () => new ReadableStream() }, dataSource: {} }
  const upload = vi.fn(async () => { throw new Error('must not upload') })
  const consumer = createArtifactOrderConsumer(alias, { nativeDeviceLease: () => local.nativeDeviceLease, upload, remember: vi.fn() })
  await expect(consumer.consume({ execution, workspace: { path: await workspace(), outputs: [], close: async () => undefined },
    signal: execution.signal })).rejects.toMatchObject({ code: 'H3_NATIVE_TASK_LEASE_INVALID' })
  expect(p.run).not.toHaveBeenCalled()
  expect(execution.reportProgress).not.toHaveBeenCalled()
  expect(upload).not.toHaveBeenCalled()
})
it('finishes a 400-second same-connection job using renewed same-revision proof without executing another sample', async () => {
  const p = provider()
  let clock = NOW
  let current = published()
  const alias = await createPublishedNativeH3Adapter(p, current, { ownerId: 167, deviceId: 'physical-a', connectionId },
    async () => current, () => clock)
  const run = p.run.getMockImplementation()!
  p.run.mockImplementationOnce(async (input) => {
    clock += 400
    current = published(tuple, clock)
    return run(input)
  })
  await alias.run({ recipeJson: '{"prompt":"长任务","seconds":5}', outputFormat: 'mp4', workspacePath: await workspace(),
    signal: new AbortController().signal, nativeDeviceLease: lease() })
  expect(p.run).toHaveBeenCalledOnce()
  expect(nativeH3AdapterClaim(alias)).toMatchObject({ device_binding_revision: 1 })
  expect(p.loadAndSelfTest).not.toHaveBeenCalled()
  expect(p.loadAndSelfTestV2).toHaveBeenCalledOnce()
})

it('collects only expired completed v2 claims while retaining an uncertain old nonce without reexecution', async () => {
  const p = provider()
  const root = await workspace()
  let clock = NOW
  const createChallenge = (nonceByte: number) => {
    const input = { prompt: '有界独立样例', seconds: 5 }
    const payload = { ...tuple, schema: 'qianshou.native-h3-review-challenge.v2',
      purpose: 'qianshou:native-h3-review-challenge.v2', challenge_nonce: Buffer.alloc(32, nonceByte).toString('base64url'),
      challenge_input: input, challenge_input_sha256: createHash('sha256').update(canonicalNativeH3ReviewJson(input)).digest('hex'),
      issued_at: clock - 1, expires_at: clock + 899 }
    return verifyNativeH3ReviewChallengeV2(envelope(payload), tuple, keys, clock)
  }
  const run = (challenge: ReturnType<typeof createChallenge>, fail = false) => runNativeH3ReviewChallenge(p, {
    selection, publicationId: tuple.publication_id, contractSha256: tuple.contract_sha256, challenge,
    signal: new AbortController().signal, assertBindingCurrent: async () => undefined,
    upload: async ({ bytes, sha256 }) => {
      if (fail) throw new Error('uncertain upload remains claimed')
      return { schema: 'artifact.v1', object_key: 'review/result.mp4', object_version_id: 'immutable-1',
        filename: 'result.mp4', content_type: 'video/mp4', size_bytes: bytes.length, sha256, result_id: 'result-1' }
    },
  }, async () => ({ ownerId: 167, deviceId: 'physical-a' }), root, () => clock)
  const completed = createChallenge(61)
  const unknown = createChallenge(62)
  await run(completed)
  await expect(run(unknown, true)).rejects.toThrow('uncertain upload remains claimed')
  const claimName = (challenge: ReturnType<typeof createChallenge>) => createHash('sha256')
    .update(`${tuple.owner_id}\0${tuple.device_id}\0${tuple.publication_id}\0${challenge.payload.challenge_nonce}`).digest('hex') + '.json'
  clock += 1500
  await run(createChallenge(63))
  const files = await readdir(join(root, 'native-h3-review-claims'))
  expect(files).not.toContain(claimName(completed))
  expect(files).toContain(claimName(unknown))
  await expect(run(unknown)).rejects.toMatchObject({ code: 'H3_REVIEW_EXECUTION_REFUSED' })
  expect(p.run).toHaveBeenCalledTimes(3)
})

it('refuses a queued native lease after withdrawal before any ordinary or model runner can consume it', async () => {
  const ordinary = vi.fn(async () => { throw new Error('ordinary runner must not see native tasks') })
  const edge = bindInlineEdgeResident({ nodeId: 'fixture-native-withdraw', agentVersion: 'fixture',
    allowedTaskTypes: [declaration.taskType], handshakeTimeoutMs: 2000, maxFrameBytes: 65536, maxOutputBytes: 4096,
    supply: () => 'paused', originOf: () => null, tokenOf: async () => 'fixture', ownerIdOf: async () => 167,
    verification: false, run: ordinary })
  const original = lease()
  const mapped = edge.binding.bridge.toNodeOffer({ workerId: tuple.device_id, workloadId: original.workload_id,
    shardId: original.shard_id, attempt: 1, taskType: declaration.taskType, runtime: 'python3', inputKind: 'inline',
    inlineInput: '中文任务', inputRef: '', inputRefs: [], codeUrl: '', codeSha256: '', timeoutSeconds: 1500,
    verificationPolicy: 'artifact', executionModel: '', capability: '', capabilityVersion: '', params: { seconds: 5 },
    nativeDeviceLease: original }, { receivedAt: '2026-09-27T03:00:00.000Z', workerId: tuple.device_id })
  if ('refuse' in mapped) throw new Error(mapped.refuse)
  const local = edge.binding.leaseOf(mapped.envelope.taskId, mapped.attempt, mapped.leaseExpiresAt)
  edge.withdrawArtifact(declaration.taskType)
  const execution: ComputeResidentAttemptExecution = { task: mapped.envelope,
    attempt: { taskId: mapped.envelope.taskId, attempt: mapped.attempt, leaseId: local.leaseId,
      leaseExpiresAt: local.expiresAt, idempotencyKey: local.idempotencyKey, envelopeFingerprint: 'a'.repeat(64),
      capabilityId: mapped.envelope.capabilityId, capabilityVersion: mapped.envelope.capabilityVersion,
      capabilityPluginDigest: local.capabilityPluginDigest },
    signal: new AbortController().signal, reportProgress: vi.fn(async () => undefined),
    source: { open: async () => new ReadableStream() }, dataSource: {} }
  await expect(edge.resultConsumer.consume({ execution,
    workspace: { path: await workspace(), outputs: [], close: async () => undefined }, signal: execution.signal }))
    .rejects.toMatchObject({ code: 'COMPUTE_ARTIFACT_ADAPTER_UNAVAILABLE' })
  expect(ordinary).not.toHaveBeenCalled()
  expect(execution.reportProgress).not.toHaveBeenCalled()
})
