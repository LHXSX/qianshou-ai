/** Ordinary native jobs freeze device identity independently of short-lived presence evidence. */
import { ComputeError } from './errors.ts'
import type { NativeH3DeviceTupleV2 } from './native-h3-device-proof.ts'

/** Server-owned ordinary lease metadata, delivered only as an authenticated assignment top-level field. */
export interface NativeH3TaskLeaseV2 extends NativeH3DeviceTupleV2 {
  readonly schema: 'qianshou.native-h3-task-lease.v2'
  readonly device_key_id: string
  readonly connection_id: string
  readonly workload_id: string
  readonly shard_id: string
  readonly attempt: number
}
const admitted = new WeakSet<object>()
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
const RAW = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
function invalid(): never { throw new ComputeError('H3_NATIVE_TASK_LEASE_INVALID', 409) }
/** Validate dispatcher metadata against this process's actual authenticated connection and assignment.
 * @param value - The server assignment top-level field, never buyer task parameters.
 * @param context - Current ACK identity and the parent assignment's immutable lease identifiers.
 * @returns An immutable process-local lease credential; JSON copies carry no authority.
 */
export function parseNativeH3TaskLeaseV2(value: unknown, context: {
  ownerId: number
  deviceId: string
  connectionId: string
  taskType: string
  workloadId: string
  shardId: string
  attempt: number
}): NativeH3TaskLeaseV2 {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  const keys = ['schema', 'publication_id', 'owner_id', 'device_id', 'task_type', 'capability_id',
    'contract_version', 'contract_sha256', 'artifact_digest', 'source_digest', 'logical_binding_sha256',
    'local_owner_config_digest', 'device_binding_revision', 'connection_id', 'device_key_id', 'workload_id', 'shard_id', 'attempt']
  if (Object.keys(row).length !== 18 || keys.some(key => !Object.hasOwn(row, key))
    || row.schema !== 'qianshou.native-h3-task-lease.v2' || row.contract_version !== 'v2' || row.capability_id !== 'video.render'
    || row.owner_id !== context.ownerId || row.device_id !== context.deviceId || row.connection_id !== context.connectionId
    || row.task_type !== context.taskType || row.workload_id !== context.workloadId || row.shard_id !== context.shardId
    || row.attempt !== context.attempt || !Number.isSafeInteger(row.owner_id) || row.owner_id < 1
    || !Number.isSafeInteger(row.attempt) || row.attempt < 1
    || !Number.isSafeInteger(row.device_binding_revision) || Number(row.device_binding_revision) < 1
    || ![row.publication_id, row.connection_id, row.workload_id, row.shard_id]
      .every(value => typeof value === 'string' && UUID.test(value))
    || typeof row.device_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,36}$/u.test(row.device_id)
    || typeof row.device_key_id !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/u.test(row.device_key_id)
    || typeof row.task_type !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/u.test(row.task_type)
    || ![row.contract_sha256, row.logical_binding_sha256].every(value => typeof value === 'string' && RAW.test(value))
    || ![row.artifact_digest, row.source_digest, row.local_owner_config_digest]
      .every(value => typeof value === 'string' && DIGEST.test(value))
    || row.artifact_digest !== row.source_digest) invalid()
  const lease = Object.freeze({ ...row }) as unknown as NativeH3TaskLeaseV2
  admitted.add(lease)
  return lease
}
/** Check the original same-process assignment credential, not a structurally identical copy.
 * @param value - Lease read from the Host-owned current task lease map.
 * @returns Whether it was admitted by this assignment parser.
 */
export function isAdmittedNativeH3TaskLeaseV2(value: unknown): value is NativeH3TaskLeaseV2 {
  return typeof value === 'object' && value !== null && admitted.has(value)
}
