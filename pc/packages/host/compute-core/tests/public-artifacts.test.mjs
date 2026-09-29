/** Built-package check: run only after Host tsc and tsdown; never substitutes for source tests. */
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { test } from 'node:test'
import { assignmentFingerprint, verifyTaskAssignment } from '@deepseek-ai/dsh-compute-core/envelope-security'
import { planCapabilityPluginInstall, pluginManifestFingerprint } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { createResidentHeartbeat } from '@deepseek-ai/dsh-compute-core/resident-loop'
import { isVerifiedTaskAssignment } from '@deepseek-ai/dsh-compute-core'
import { ComputeCapabilityId, ComputeTaskId } from '@deepseek-ai/dsh-compute-core/protocol'

test('public entries share one verified-assignment registry after bundling', async () => {
  const assignment = {
    envelope: { version: 'qianshou.task.v1', taskId: ComputeTaskId('built-task'), capabilityId: ComputeCapabilityId('image'), capabilityVersion: '1.0',
      inputRefs: [], parameters: {}, deadlineAt: '2026-09-14T23:00:00.000Z', maxOutputBytes: 100, idempotencyKey: 'built-task-1' },
    attempt: 1, leaseExpiresAt: '2026-09-14T22:00:00.000Z', receivedAt: '2026-09-14T21:00:00.000Z',
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const signature = sign(null, Buffer.from(assignmentFingerprint(assignment), 'hex'), privateKey).toString('base64')
  const credential = await verifyTaskAssignment(assignment, signature, (digest, signature) => verify(null, Buffer.from(digest, 'hex'), publicKey, Buffer.from(signature, 'base64')))
  assert.equal(isVerifiedTaskAssignment(credential), true)
  assert.equal(isVerifiedTaskAssignment({ ...credential }), false)
  await assert.rejects(verifyTaskAssignment({ ...assignment, attempt: 2 }, signature, (digest, signature) => verify(null, Buffer.from(digest, 'hex'), publicKey, Buffer.from(signature, 'base64'))), /COMPUTE_TASK_SIGNATURE_INVALID/)
})

test('plugin-market public entry exposes pure trust planning', async () => {
  const manifest = {
    manifestVersion: 1, pluginId: 'qianshou.image', version: '1.2.0', displayName: 'Image worker', hostRange: '>=0.1.0',
    pluginDigest: 'a'.repeat(64), capabilities: [{ id: ComputeCapabilityId('image.generate'), version: '1.0.0', inputKinds: ['text'], outputKinds: ['image'], permissions: ['workspace.read'], dataScope: 'task-inputs' }],
  }
  const plan = await planCapabilityPluginInstall({
    manifest, packageDigest: manifest.pluginDigest, signature: 'sig-' + 'b'.repeat(24), hostVersion: '0.2.0',
    grantedPermissions: ['workspace.read'], verifySignature: async fingerprint => fingerprint === pluginManifestFingerprint(manifest),
  })
  assert.equal(plan.phase, 'verified')
  assert.equal(Object.isFrozen(plan), true)
})

test('resident-loop public entry exposes redacted heartbeat planning', () => {
  const heartbeat = createResidentHeartbeat({
    now: '2026-09-15T12:00:00.000Z',
    snapshot: { userActive: false, voiceActive: false, cpuPercent: 1, gpuPercent: 1, temperatureC: 30, diskFreeBytes: 1024, runningTasks: 0 },
    availableCapabilities: new Set(['z@1.0.0', 'a@1.0.0']),
  })
  assert.deepEqual(heartbeat, { now: '2026-09-15T12:00:00.000Z', status: 'IDLE', runningTasks: 0, availableCapabilities: ['a@1.0.0', 'z@1.0.0'] })
})

test('native H3 public modules resolve through Node package exports', async () => {
  for (const name of ['native-h3-binding', 'native-h3-device-proof', 'native-h3-review',
    'native-h3-presence', 'native-h3-task-lease', 'native-h3-v2-evidence']) {
    const module = await import(`@deepseek-ai/dsh-compute-core/${name}`)
    assert.ok(Object.keys(module).length > 0, name)
  }
})

test('native lease public entries share the original process credential', async () => {
  const root = await import('@deepseek-ai/dsh-compute-core')
  const leaseModule = await import('@deepseek-ai/dsh-compute-core/native-h3-task-lease')
  const context = { ownerId: 167, deviceId: 'built-h3-device',
    connectionId: '00000000-0000-4000-8000-000000000001', taskType: 'qianshou_h3_built_v2',
    workloadId: '00000000-0000-4000-8000-000000000002',
    shardId: '00000000-0000-4000-8000-000000000003', attempt: 1 }
  const value = { schema: 'qianshou.native-h3-task-lease.v2',
    publication_id: '00000000-0000-4000-8000-000000000004', owner_id: context.ownerId,
    device_id: context.deviceId, task_type: context.taskType, capability_id: 'video.render',
    contract_version: 'v2', contract_sha256: 'a'.repeat(64), artifact_digest: 'sha256:' + 'b'.repeat(64),
    source_digest: 'sha256:' + 'b'.repeat(64), logical_binding_sha256: 'c'.repeat(64),
    local_owner_config_digest: 'sha256:' + 'd'.repeat(64), device_binding_revision: 1,
    connection_id: context.connectionId, device_key_id: 'built-h3-device-key',
    workload_id: context.workloadId, shard_id: context.shardId, attempt: context.attempt }
  const lease = leaseModule.parseNativeH3TaskLeaseV2(value, context)
  assert.equal(root.isAdmittedNativeH3TaskLeaseV2(lease), true)
  assert.equal(leaseModule.isAdmittedNativeH3TaskLeaseV2(root.parseNativeH3TaskLeaseV2(value, context)), true)
  assert.equal(root.isAdmittedNativeH3TaskLeaseV2({ ...lease }), false)
  assert.throws(() => leaseModule.parseNativeH3TaskLeaseV2({ ...value, owner_id: 168 }, context),
    /H3_NATIVE_TASK_LEASE_INVALID/)
})

test('built contributor and catalog load their native H3 dependencies without source aliases', async () => {
  const node = await import(new URL('../../node-contributor/lib/index.js', import.meta.url).href)
  const catalog = await import(new URL('../../qianshou-plugin-catalog/lib/index.js', import.meta.url).href)
  assert.equal(typeof node.apply, 'function')
  assert.equal(typeof catalog.default, 'function')
})
