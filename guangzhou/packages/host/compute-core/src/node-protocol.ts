/** Browser-safe node control-plane messages; media bytes and credentials stay local. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ComputeCapabilityId, ComputeTaskEnvelope } from './protocol.ts'
import { ComputeError } from './errors.ts'
import { parseTaskEnvelope } from './validation.ts'

/** Provider-issued identity of one contributing node. */
export type ComputeNodeId = Branded<'qianshou-compute-node-id'>
/** Brand a validated node identity.
 * @param value - Provider-issued node identifier.
 * @returns The identifier with its nominal node-id type.
 */
export function ComputeNodeId(value: string): ComputeNodeId { return value as ComputeNodeId }

/** Exact capability/plugin version advertised by a node. */
export interface NodeCapabilityAdvertisement {
  capabilityId: ComputeCapabilityId
  version: string
  pluginDigest: string
}

/** Periodic liveness and capability message; it contains no local paths or secrets. */
export interface NodeHeartbeatMessage {
  version: 'qianshou.node.v1'
  nodeId: ComputeNodeId
  agentVersion: string
  sentAt: string
  capabilities: readonly NodeCapabilityAdvertisement[]
  maxConcurrency: number
  runningTasks: number
}

/** Signed dispatch offer after transport authentication; signature verification is external. */
export interface NodeTaskOfferMessage {
  type: 'task.offer'
  envelope: ComputeTaskEnvelope
  attempt: number
  leaseExpiresAt: string
  /** Dispatch-issued timestamp; adapters must not replace it with their local receive time. */
  receivedAt: string
  signature: string
}

/** Monotonic progress receipt sent by the local employee adapter. */
export interface NodeTaskProgressMessage {
  type: 'task.progress'
  taskId: string
  attempt: number
  sequence: number
  progress: number
  phase: string
}

/** Result manifest; output paths never cross the node boundary. */
export interface NodeTaskReturnMessage {
  type: 'task.return'
  taskId: string
  attempt: number
  outputs: readonly { name: string; bytes: number; sha256: string }[]
}

/** Validate a heartbeat before publishing it to the dispatch control plane.
 * @param value - Untrusted heartbeat JSON.
 * @returns Deeply frozen validated heartbeat.
 */
export function parseNodeHeartbeat(value: unknown): NodeHeartbeatMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_NODE_HEARTBEAT_INVALID')
  const item = value as Record<string, unknown>
  const maxConcurrency = item.maxConcurrency as number
  const runningTasks = item.runningTasks as number
  if (item.version !== 'qianshou.node.v1' || !id(item.nodeId) || !id(item.agentVersion) || typeof item.sentAt !== 'string'
    || !Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 64
    || !Number.isSafeInteger(runningTasks) || runningTasks < 0 || runningTasks > maxConcurrency
    || !Array.isArray(item.capabilities) || item.capabilities.length > 256) throw new ComputeError('COMPUTE_NODE_HEARTBEAT_INVALID')
  timestamp(item.sentAt)
  const capabilities = item.capabilities.map(parseCapability)
  const capabilityKeys = new Set(capabilities.map(capability => `${capability.capabilityId}\u0000${capability.version}`))
  if (capabilityKeys.size !== capabilities.length) throw new ComputeError('COMPUTE_NODE_HEARTBEAT_INVALID')
  return deepFreeze({ version: 'qianshou.node.v1', nodeId: ComputeNodeId(item.nodeId), agentVersion: item.agentVersion, sentAt: item.sentAt, capabilities, maxConcurrency, runningTasks })
}

/** Validate an untrusted offer envelope before passing it to the scheduler.
 * @param value - Untrusted task-offer JSON.
 * @returns Deeply frozen validated task offer.
 */
export function parseNodeTaskOffer(value: unknown): NodeTaskOfferMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_NODE_TASK_OFFER_INVALID')
  const item = value as Record<string, unknown>
  const attempt = item.attempt as number
  if (item.type !== 'task.offer' || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1_000_000
    || typeof item.leaseExpiresAt !== 'string' || typeof item.receivedAt !== 'string' || typeof item.signature !== 'string'
    || item.signature.length < 16 || item.signature.length > 8192) throw new ComputeError('COMPUTE_NODE_TASK_OFFER_INVALID')
  try { timestamp(item.leaseExpiresAt); timestamp(item.receivedAt) } catch { throw new ComputeError('COMPUTE_NODE_TASK_OFFER_INVALID') }
  let envelope: ComputeTaskEnvelope
  try { envelope = parseTaskEnvelope(item.envelope) } catch { throw new ComputeError('COMPUTE_NODE_TASK_OFFER_INVALID') }
  return deepFreeze({ type: 'task.offer', envelope, attempt, leaseExpiresAt: item.leaseExpiresAt, receivedAt: item.receivedAt, signature: item.signature })
}

function parseCapability(value: unknown): NodeCapabilityAdvertisement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_NODE_HEARTBEAT_INVALID')
  const item = value as Record<string, unknown>
  if (!id(item.capabilityId) || !id(item.version) || typeof item.pluginDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(item.pluginDigest)) throw new ComputeError('COMPUTE_NODE_HEARTBEAT_INVALID')
  return { capabilityId: item.capabilityId as ComputeCapabilityId, version: item.version, pluginDigest: item.pluginDigest }
}

function id(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._-]{1,128}$/u.test(value) }
function timestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_NODE_TIMESTAMP_INVALID')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ComputeError('COMPUTE_NODE_TIMESTAMP_INVALID')
}
function deepFreeze<T>(value: T): T { if (value && typeof value === 'object') { Object.freeze(value); for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child) } return value }
