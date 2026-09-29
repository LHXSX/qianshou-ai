/** Canonical task fingerprint and signature seam for dispatch adapters. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'
import type { ComputeTaskEnvelope } from './protocol.ts'
import { parseTaskEnvelope } from './validation.ts'

/** Adapter supplied by the authenticated dispatch connection; key management stays outside compute-core. */
export type ComputeTaskSignatureVerifier = (fingerprint: string, signature: string) => boolean | Promise<boolean>

/** Versioned domain separator for assignment signatures. */
export const COMPUTE_TASK_ASSIGNMENT_PROTOCOL = 'qianshou.task.assignment.v1' as const

/** Assignment fields covered by the dispatch signature. `receivedAt` is the
 * issuer timestamp carried on the wire; it is therefore part of the signed
 * value rather than a local receive timestamp.
 */
export interface ComputeTaskAssignment {
  envelope: ComputeTaskEnvelope
  attempt: number
  /** Exact plugin digest selected from the node capability advertisement. */
  capabilityPluginDigest?: string
  leaseExpiresAt: string
  /** Dispatch-issued timestamp covered by the signature; local receive time is independent. */
  receivedAt: string
}

/** A process-local credential minted only by {@link verifyTaskAssignment}. */
export interface VerifiedComputeTaskAssignment extends ComputeTaskAssignment {
  readonly verified: true
  readonly envelopeFingerprint: string
  readonly assignmentFingerprint: string
}

const verifiedAssignments = new WeakSet<object>()

/** Return the deterministic SHA-256 fingerprint of an admitted task envelope.
 * @param value - Validated task envelope to fingerprint.
 * @returns SHA-256 hex digest of the canonical envelope.
 */
export function taskFingerprint(value: ComputeTaskEnvelope): string {
  const task = parseTaskEnvelope(value)
  return createHash('sha256').update(canonicalJson(task)).digest('hex')
}

/** Return the deterministic fingerprint of all signed assignment facts.
 * @param value - Validated assignment fields to fingerprint.
 * @returns SHA-256 hex digest over the versioned assignment signing domain.
 */
export function assignmentFingerprint(value: ComputeTaskAssignment): string {
  const envelope = parseTaskEnvelope(value.envelope)
  const assignment = parseAssignment({ ...value, envelope })
  return createHash('sha256').update(canonicalJson({
    protocol: COMPUTE_TASK_ASSIGNMENT_PROTOCOL,
    envelope: assignment.envelope,
    attempt: assignment.attempt,
    ...(assignment.capabilityPluginDigest ? { capabilityPluginDigest: assignment.capabilityPluginDigest } : {}),
    leaseExpiresAt: assignment.leaseExpiresAt,
    receivedAt: assignment.receivedAt,
  })).digest('hex')
}

/** Verify a dispatch assignment signature over protocol, envelope, attempt,
 * lease expiry and issuer receive timestamp, then mint a process-local
 * admission credential.
 * @param value - Untrusted assignment fields received from dispatch.
 * @param signature - Adapter-provided signature over the assignment digest.
 * @param verify - Authenticated key verifier owned by the dispatch adapter.
 * @returns An immutable process-local credential accepted by the coordinator.
 */
export async function verifyTaskAssignment(
  value: unknown,
  signature: string,
  verify: ComputeTaskSignatureVerifier,
): Promise<VerifiedComputeTaskAssignment> {
  if (!validSignature(signature)) throw new ComputeError('COMPUTE_TASK_SIGNATURE_INVALID', 401)
  let assignment: ComputeTaskAssignment
  try { assignment = parseAssignment(value) } catch { throw new ComputeError('COMPUTE_TASK_ASSIGNMENT_INVALID', 400) }
  const envelopeFingerprint = taskFingerprint(assignment.envelope)
  const fingerprint = assignmentFingerprint(assignment)
  let valid = false
  try { valid = await verify(fingerprint, signature) } catch { throw new ComputeError('COMPUTE_TASK_SIGNATURE_UNAVAILABLE', 503) }
  if (!valid) throw new ComputeError('COMPUTE_TASK_SIGNATURE_INVALID', 401)
  const credential = Object.freeze({ ...assignment, verified: true as const, envelopeFingerprint, assignmentFingerprint: fingerprint })
  verifiedAssignments.add(credential)
  return credential
}

/** Check whether an assignment credential was minted by this process verifier.
 * @param value - Candidate assignment supplied to the coordinator.
 * @returns True only for credentials minted by this module instance.
 */
export function isVerifiedTaskAssignment(value: unknown): value is VerifiedComputeTaskAssignment {
  return typeof value === 'object' && value !== null && verifiedAssignments.has(value)
}

/** Verify task content only; admission additionally requires verifyTaskAssignment.
 * @param value - Untrusted JSON received from a dispatch adapter.
 * @param signature - Adapter-provided signature over the returned fingerprint.
 * @param verify - Authenticated key verifier owned by the dispatch adapter.
 * @returns The deeply frozen admitted envelope.
 */
export async function verifyTaskEnvelope(
  value: unknown,
  signature: string,
  verify: ComputeTaskSignatureVerifier,
): Promise<ComputeTaskEnvelope> {
  if (!validSignature(signature)) {
    throw new ComputeError('COMPUTE_TASK_SIGNATURE_INVALID', 401)
  }
  const task = parseTaskEnvelope(value)
  const fingerprint = taskFingerprint(task)
  let valid = false
  try { valid = await verify(fingerprint, signature) } catch { throw new ComputeError('COMPUTE_TASK_SIGNATURE_UNAVAILABLE', 503) }
  if (!valid) throw new ComputeError('COMPUTE_TASK_SIGNATURE_INVALID', 401)
  return task
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ComputeError('COMPUTE_TASK_CANONICAL_INVALID')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  throw new ComputeError('COMPUTE_TASK_CANONICAL_INVALID')
}

function validSignature(signature: unknown): signature is string {
  return typeof signature === 'string' && signature.length >= 16 && signature.length <= 8192 && /^[A-Za-z0-9+/_=-]+$/u.test(signature)
}

function parseAssignment(value: unknown): ComputeTaskAssignment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('assignment')
  const item = value as Record<string, unknown>
  const attempt = item.attempt
  const digest = item.capabilityPluginDigest
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1 || (attempt as number) > 1_000_000
    || typeof item.leaseExpiresAt !== 'string' || typeof item.receivedAt !== 'string'
    || (digest !== undefined && (typeof digest !== 'string' || !/^[a-f0-9]{64}$/u.test(digest)))) throw new Error('assignment')
  timestamp(item.leaseExpiresAt)
  timestamp(item.receivedAt)
  return Object.freeze({
    envelope: parseTaskEnvelope(item.envelope), attempt: attempt as number,
    ...(digest === undefined ? {} : { capabilityPluginDigest: digest }),
    leaseExpiresAt: item.leaseExpiresAt, receivedAt: item.receivedAt,
  })
}

function timestamp(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) throw new Error('timestamp')
  const parsed = new Date(value)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) throw new Error('timestamp')
}
