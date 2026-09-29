/** Deterministic lifecycle for one passive worker task assignment. */
import { ComputeError } from './errors.ts'
import type { ComputeTaskId } from './protocol.ts'

/** Worker task states shared by the local scheduler and remote event adapter. */
export type ComputeTaskStatus = 'OFFERED' | 'ACCEPTED' | 'EXECUTING' | 'UPLOADING' | 'RETURNED' | 'SETTLED' | 'PAUSED' | 'FAILED' | 'REVOKED' | 'OFFLINE' | 'EXPIRED' | 'REFUSED'

/** Durable local facts for one task attempt; no credentials or media bytes are stored. */
export interface ComputeTaskState {
  taskId: ComputeTaskId
  attempt: number
  envelopeFingerprint: string
  idempotencyKey: string
  status: ComputeTaskStatus
  leaseExpiresAt: string | null
  progress: number
  updatedAt: string
  /** Stable refusal code for terminal admission decisions. */
  decisionReason?: string
}

/** Parse persisted task metadata without accepting completion or settlement claims.
 * @param value - Untrusted persisted task JSON.
 * @returns Validated task state.
 */
export function parseTaskState(value: unknown): ComputeTaskState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ComputeError('COMPUTE_TASK_STATE_INVALID', 503)
  const item = value as Record<string, unknown>
  if (typeof item.taskId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(item.taskId)
    || typeof item.attempt !== 'number' || !Number.isSafeInteger(item.attempt) || item.attempt < 1
    || typeof item.envelopeFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(item.envelopeFingerprint)
    || typeof item.idempotencyKey !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(item.idempotencyKey)
    || typeof item.status !== 'string' || !statuses.has(item.status as ComputeTaskStatus)
    || (item.leaseExpiresAt !== null && typeof item.leaseExpiresAt !== 'string')
    || typeof item.progress !== 'number' || !Number.isFinite(item.progress) || item.progress < 0 || item.progress > 1
    || typeof item.updatedAt !== 'string'
    || (item.decisionReason !== undefined && (typeof item.decisionReason !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/u.test(item.decisionReason)))) throw new ComputeError('COMPUTE_TASK_STATE_INVALID', 503)
  timestamp(item.updatedAt)
  if (item.leaseExpiresAt !== null) timestamp(item.leaseExpiresAt)
  return {
    taskId: item.taskId as ComputeTaskId,
    attempt: item.attempt,
    envelopeFingerprint: item.envelopeFingerprint,
    idempotencyKey: item.idempotencyKey,
    status: item.status as ComputeTaskStatus,
    leaseExpiresAt: item.leaseExpiresAt,
    progress: item.progress,
    updatedAt: item.updatedAt,
    ...(item.decisionReason === undefined ? {} : { decisionReason: item.decisionReason }),
  }
}

/** Events accepted by the lifecycle reducer. */
export type ComputeTaskEvent =
  | { type: 'accept'; leaseExpiresAt: string }
  | { type: 'refuse'; reason: string }
  | { type: 'start' }
  | { type: 'progress'; progress: number }
  | { type: 'upload' }
  | { type: 'return' }
  | { type: 'settle' }
  | { type: 'pause' }
  | { type: 'resume'; leaseExpiresAt: string }
  | { type: 'fail' }
  | { type: 'revoke' }
  | { type: 'offline' }
  | { type: 'expire' }

const transitions: Record<ComputeTaskStatus, Partial<Record<ComputeTaskEvent['type'], ComputeTaskStatus>>> = {
  OFFERED: { accept: 'ACCEPTED', refuse: 'REFUSED', revoke: 'REVOKED', expire: 'EXPIRED' },
  ACCEPTED: { start: 'EXECUTING', pause: 'PAUSED', revoke: 'REVOKED', offline: 'OFFLINE', expire: 'EXPIRED' },
  EXECUTING: { progress: 'EXECUTING', upload: 'UPLOADING', pause: 'PAUSED', fail: 'FAILED', revoke: 'REVOKED', offline: 'OFFLINE', expire: 'EXPIRED' },
  UPLOADING: { return: 'RETURNED', fail: 'FAILED', revoke: 'REVOKED', offline: 'OFFLINE', expire: 'EXPIRED' },
  RETURNED: { settle: 'SETTLED', fail: 'FAILED' },
  SETTLED: {},
  PAUSED: { resume: 'EXECUTING', revoke: 'REVOKED', offline: 'OFFLINE', expire: 'EXPIRED' },
  FAILED: {},
  REVOKED: {},
  OFFLINE: { resume: 'EXECUTING', fail: 'FAILED', revoke: 'REVOKED', expire: 'EXPIRED' },
  EXPIRED: {},
  REFUSED: {},
}
const statuses = new Set<ComputeTaskStatus>(Object.keys(transitions) as ComputeTaskStatus[])

/** Apply one event and reject illegal or stale lifecycle changes.
 * @param state - Current state for one task attempt.
 * @param event - Event from the local policy or a verified dispatch message.
 * @param now - Canonical current UTC timestamp used for lease checks and receipts.
 * @returns A new state value; the input object is never mutated.
 */
export function transitionTask(state: ComputeTaskState, event: ComputeTaskEvent, now: string): ComputeTaskState {
  const at = timestamp(now)
  const nextStatus = transitions[state.status][event.type]
  if (!nextStatus) throw new ComputeError('COMPUTE_TASK_TRANSITION_INVALID', 409)
  if (state.leaseExpiresAt && event.type !== 'expire' && Date.parse(at) > Date.parse(state.leaseExpiresAt)) {
    throw new ComputeError('COMPUTE_TASK_LEASE_EXPIRED', 409)
  }
  if (event.type === 'accept' || event.type === 'resume') {
    timestamp(event.leaseExpiresAt)
    if (Date.parse(event.leaseExpiresAt) <= Date.parse(at)) throw new ComputeError('COMPUTE_TASK_LEASE_INVALID', 409)
  }
  if (event.type === 'refuse' && !/^[A-Z][A-Z0-9_]{1,63}$/u.test(event.reason)) throw new ComputeError('COMPUTE_TASK_REFUSAL_INVALID', 409)
  let progress = state.progress
  if (event.type === 'progress') {
    if (!Number.isFinite(event.progress) || event.progress < progress || event.progress > 1) throw new ComputeError('COMPUTE_TASK_PROGRESS_INVALID', 409)
    progress = event.progress
  }
  return {
    ...state,
    status: nextStatus,
    leaseExpiresAt: event.type === 'accept' || event.type === 'resume' ? event.leaseExpiresAt : state.leaseExpiresAt,
    progress: nextStatus === 'SETTLED' ? 1 : progress,
    updatedAt: at,
    ...(event.type === 'refuse' ? { decisionReason: event.reason } : {}),
  }
}

function timestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new ComputeError('COMPUTE_TASK_TIMESTAMP_INVALID')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new ComputeError('COMPUTE_TASK_TIMESTAMP_INVALID')
  return value
}
