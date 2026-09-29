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
