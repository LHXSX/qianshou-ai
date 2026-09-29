/** Original signed publication and authenticated lease brands exercise real local reservation transactions. */
import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NATIVE_H3_RUNTIME_ABI_V2, NATIVE_H3_RUNTIME_V2, nativeH3LogicalBindingSha256,
  parseNativeH3DeclarationV2, parseNativeH3ExecutionBindingV2 } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { verifyNativeH3DeviceProofV2 } from '@deepseek-ai/dsh-compute-core/native-h3-device-proof'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import { parseNativeH3TaskLeaseV2 } from '@deepseek-ai/dsh-compute-core/native-h3-task-lease'
import { createDynamicH3VideoProvider } from '../src/h3-dynamic-provider.ts'
import { H3OwnerSetup } from '../src/h3-owner-setup.ts'
import { createPublishedNativeH3Adapter, readOwnedH3ExecutionPermit,
  type NativeH3PublishedBinding, type OwnedH3ExecutionPermit } from '../src/native-h3-publication.ts'
import type { ArtifactOrderAdapter } from '../src/artifact-order.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex')
const now = 1_790_000_000
const worker = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const connection = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const binding = parseNativeH3ExecutionBindingV2({ schema: 'qianshou.native-h3-execution-binding.v2',
  runtimeAbi: NATIVE_H3_RUNTIME_ABI_V2, runtime: NATIVE_H3_RUNTIME_V2,
  executionRecipeSha256: 'a'.repeat(64), modelSha256: 'b'.repeat(64), firstFrameSha256: 'c'.repeat(64) })
const declaration = parseNativeH3DeclarationV2({ ...binding, schema: 'qianshou.native-h3-binding.v2',
  taskType: 'qianshou_admitted_fixture_v2', capabilityId: 'video.render', inputKinds: ['inline'],
  outputKind: 'artifact_ref', contractVersion: 'v2', category: 'video', platformDispatchable: true })

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qs-admitted-h3-'))); roots.push(root)
  const path = join(root, 'owner.json'); await writeFile(path, '{"schema":"qianshou.h3-owner.v2"}')
  const tuple = { publication_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', owner_id: 7, device_id: worker,
    task_type: declaration.taskType, capability_id: 'video.render' as const, contract_version: 'v2' as const,
    contract_sha256: 'd'.repeat(64), artifact_digest: 'sha256:' + 'e'.repeat(64), source_digest: 'sha256:' + 'e'.repeat(64),
    logical_binding_sha256: nativeH3LogicalBindingSha256(binding), local_owner_config_digest: 'sha256:' + 'f'.repeat(64),
    device_binding_revision: 1 }
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
  const run = vi.fn<ArtifactOrderAdapter['run']>(async (input) => {
    const output = join(input.workspacePath, 'result.mp4'); await writeFile(output, '0000ftyp CPU owned output')
    return { path: output, filename: 'result.mp4', contentType: 'video/mp4' }
  })
  const raw: ArtifactOrderAdapter = { taskType: 'video_generate', inputKind: 'inline', outputKind: 'artifact_ref',
    contractVersion: 'v1', artifactDigest: tuple.source_digest, packageDigest: tuple.local_owner_config_digest,
    outputFormats: ['mp4'], run }
  const local = { binding, localOwnerConfigDigest: tuple.local_owner_config_digest }
  const idle = vi.fn(async () => { throw new Error('An admitted attempt must not use trial idle') })
  const asserted = vi.fn(async (permit: OwnedH3ExecutionPermit) => {
    expect(readOwnedH3ExecutionPermit(permit).lease).toBe(lease)
  })
  const setup = new H3OwnerSetup({ homePath: root, runtimeDirectory: root, readScope: async () => ({ ownerId: 7, profileDir: root }),
    assertIdle: idle, assertAdmittedExecution: asserted, onSaved: async () => {} })
  const provider = createDynamicH3VideoProvider({ resolveConfiguration: async () => ({ path, identity: 'actual-scope:1' }),
    onChanged: () => {}, assertNewExecution: () => setup.assertTrialAdmission(),
    createV2: () => ({ nativeAuthorBindingV2: async () => local, loadAndSelfTestV2: async () => raw,
      status: () => ({ configured: true, ready: true, code: 'H3_V2_REAL_SELF_TEST_VERIFIED' }) }) })
  let permit: OwnedH3ExecutionPermit | undefined
  const alias = await createPublishedNativeH3Adapter(provider, published,
    { ownerId: 7, deviceId: worker, connectionId: connection }, async () => published, () => now, (captured) => {
      permit = captured
      return setup.runAdmittedReservedExecution(captured, () => provider.runAdmittedExecution(captured),
        async output => sha(await readFile(output.path)))
    })
  return { root, path, setup, provider, alias, lease, run, idle, asserted, permit: () => permit }
}

it('runs only an original lease through one reservation, does not read its own lock as idle, and cannot replay the permit', async () => {
  const f = await fixture()
  await f.alias.run({ recipeJson: '{"prompt":"真实中文","seconds":5}', outputFormat: 'mp4', workspacePath: f.root,
    signal: new AbortController().signal, nativeDeviceLease: f.lease })
  expect(f.run).toHaveBeenCalledOnce(); expect(f.idle).not.toHaveBeenCalled(); expect(f.asserted).toHaveBeenCalled()
  const permit = f.permit(); if (permit === undefined) throw new Error('Original factory must mint a permit')
  await expect(f.setup.runAdmittedReservedExecution(permit, async () => 'replay', async () => sha('replay')))
    .rejects.toMatchObject({ code: 'H3_NATIVE_SELECTION_INVALID' })
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'clear' })
  expect(f.run).toHaveBeenCalledOnce()
})

it('refuses structural lease copies before raw execution and retains unknown after a possibly executed failure', async () => {
  const f = await fixture()
  await expect(f.alias.run({ recipeJson: '{}', outputFormat: 'mp4', workspacePath: f.root,
    signal: new AbortController().signal, nativeDeviceLease: { ...f.lease } })).rejects.toMatchObject({ code: 'H3_NATIVE_SELECTION_INVALID' })
  expect(f.run).not.toHaveBeenCalled()
  f.run.mockRejectedValueOnce(new Error('CPU execution may have started'))
  await expect(f.alias.run({ recipeJson: '{}', outputFormat: 'mp4', workspacePath: f.root,
    signal: new AbortController().signal, nativeDeviceLease: f.lease })).rejects.toThrow()
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
  await expect(f.alias.run({ recipeJson: '{}', outputFormat: 'mp4', workspacePath: f.root,
    signal: new AbortController().signal, nativeDeviceLease: f.lease })).rejects.toThrow()
  expect(f.run).toHaveBeenCalledOnce()
})

it('keeps post-run source/revision checks under the reservation and never accepts foreign configuration changes', async () => {
  const f = await fixture()
  f.run.mockImplementationOnce(async (input) => {
    await writeFile(f.path, '{"schema":"qianshou.h3-owner.v2","foreignChange":true}')
    const path = join(input.workspacePath, 'result.mp4'); await writeFile(path, '0000ftyp CPU output')
    return { path, filename: 'result.mp4', contentType: 'video/mp4' }
  })
  await expect(f.alias.run({ recipeJson: '{}', outputFormat: 'mp4', workspacePath: f.root,
    signal: new AbortController().signal, nativeDeviceLease: f.lease })).rejects.toMatchObject({ code: 'H3_OWNER_CONFIGURATION_CHANGED' })
  expect(await f.setup.readTrialAdmission()).toEqual({ state: 'unknown' })
  expect(f.run).toHaveBeenCalledOnce()
})
