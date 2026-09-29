import { expect, it } from 'vitest'
import { parseNativeH3TaskLeaseV2, isAdmittedNativeH3TaskLeaseV2 } from '../src/native-h3-task-lease.ts'
import { createInlineEdgeBinding } from '../src/transport/inline-edge-bridge.ts'
const context = { ownerId: 167, deviceId: 'physical-a', connectionId: '11111111-1111-4111-8111-111111111111',
  taskType: 'qianshou_h3_fixture_v2', workloadId: '22222222-2222-4222-8222-222222222222',
  shardId: '33333333-3333-4333-8333-333333333333', attempt: 1 }
const raw = { schema: 'qianshou.native-h3-task-lease.v2', publication_id: '44444444-4444-4444-8444-444444444444',
  owner_id: 167, device_id: context.deviceId, task_type: context.taskType, capability_id: 'video.render', contract_version: 'v2',
  contract_sha256: 'a'.repeat(64), artifact_digest: 'sha256:' + 'b'.repeat(64), source_digest: 'sha256:' + 'b'.repeat(64),
  logical_binding_sha256: 'c'.repeat(64), local_owner_config_digest: 'sha256:' + 'd'.repeat(64), device_binding_revision: 1,
  device_key_id: 'native-device', connection_id: context.connectionId, workload_id: context.workloadId,
  shard_id: context.shardId, attempt: 1 }
it.each([{ attempt: 0 }, { device_id: 'x'.repeat(37) }, { device_key_id: 'colon:key' }, { device_key_id: 'x'.repeat(65) },
  { owner_id: 168 }, { connection_id: context.workloadId }, { device_binding_revision: 0 }, { injected: true }])(
  'rejects noncanonical or mismatched authenticated lease metadata %j', (change) => {
    expect(() => parseNativeH3TaskLeaseV2({ ...raw, ...change }, { ...context,
      ...change.attempt === undefined ? {} : { attempt: change.attempt },
      ...change.device_id === undefined ? {} : { deviceId: change.device_id } })).toThrow('H3_NATIVE_TASK_LEASE_INVALID')
  })
it('retains the original server credential in the Host lease map while HMAC covers the separate task slot', () => {
  const lease = parseNativeH3TaskLeaseV2(raw, context)
  expect(isAdmittedNativeH3TaskLeaseV2(lease)).toBe(true)
  expect(isAdmittedNativeH3TaskLeaseV2({ ...lease })).toBe(false)
  const binding = createInlineEdgeBinding({ nodeId: 'local-node', allowedTaskTypes: [context.taskType],
    artifactTaskTypes: [context.taskType], artifactMaxOutputBytes: 16 * 1024 * 1024, maxOutputBytes: 4096,
    sessionKey: Buffer.alloc(32, 3) })
  const offer = { workerId: context.deviceId, workloadId: context.workloadId, shardId: context.shardId, attempt: 1,
    taskType: context.taskType, runtime: 'python3', inputKind: 'inline', inlineInput: '普通中文描述', inputRef: '', inputRefs: [],
    codeUrl: '', codeSha256: '', timeoutSeconds: 1500, verificationPolicy: 'artifact' as const, executionModel: '', capability: '',
    capabilityVersion: '', nativeDeviceLease: lease, params: { seconds: 5, nativeDeviceLease: { device_binding_revision: 99 } } }
  const mapped = binding.bridge.toNodeOffer(offer, { receivedAt: '2026-09-27T03:00:00.000Z', workerId: context.deviceId })
  expect('refuse' in mapped).toBe(false)
  if ('refuse' in mapped) throw new Error(mapped.refuse)
  const actual = binding.leaseOf(mapped.envelope.taskId, mapped.attempt, mapped.leaseExpiresAt)
  expect(actual.nativeDeviceLease).toBe(lease)
  expect(mapped.envelope.parameters).toMatchObject({ nativeDeviceLease: raw,
    taskParams: { nativeDeviceLease: { device_binding_revision: 99 } } })
  expect(binding.bridge.toNodeOffer({ ...offer, nativeDeviceLease: { ...lease } },
    { receivedAt: '2026-09-27T03:00:00.000Z', workerId: context.deviceId })).toEqual({ refuse: 'NATIVE_DEVICE_LEASE_INVALID' })
})
