/** Strict owner-process measurements for the witnessed canonical API; no registration or execution. */
import { createHash } from 'node:crypto'
import { canonicalH3Endpoint, H3CanonicalProtocolError, parseH3CanonicalIdentity, parseH3CanonicalJob,
  type H3CanonicalIdentity, type H3CanonicalJob, type H3CanonicalJobExpectation } from './h3-canonical-protocol.ts'

const SCHEMA = 'qs.h3.owner-runtime-identity.v1' as const
const HASH = /^[a-f0-9]{64}$/u
const KEYS = ['schemaVersion', 'ownerConfigDigest', 'apiProcessWitnessSha256', 'comfyProcessWitnessSha256',
  'queueAdmissionGuardVersion', 'sourceManifestSha256', 'classOriginSha256', 'comfyFfmpegSha256',
  'deliveryFfmpegSha256', 'ownerRuntimeWitnessSha256'] as const

/** Actual process/configuration/encoder measurements; this is not a platform authorization. */
export interface H3OwnerRuntimeIdentity {
  readonly schemaVersion: typeof SCHEMA
  readonly ownerConfigDigest: string
  readonly apiProcessWitnessSha256: string
  readonly comfyProcessWitnessSha256: string
  readonly queueAdmissionGuardVersion: 1
  readonly sourceManifestSha256: string
  readonly classOriginSha256: string
  readonly comfyFfmpegSha256: string
  readonly deliveryFfmpegSha256: string
  readonly ownerRuntimeWitnessSha256: string
}

/** Same-job expectations captured before submission by the owning Host. */
export interface H3WitnessedJobExpectation extends H3CanonicalJobExpectation {
  readonly owner: H3OwnerRuntimeIdentity
}

/** Finite job status retaining the owner witness validated against its submitting operation. */
export type H3WitnessedJob = H3CanonicalJob & {
  readonly ownerRuntimeWitnessSha256: string
  readonly adapterOrigin: string
  readonly executionRecipeSha256: string
  readonly modelSha256: string
}

function invalid(): never { throw new H3CanonicalProtocolError() }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) invalid()
}
function digest(value: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(value, Object.keys(value).sort()), 'utf8').digest('hex')
}
function hash(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) invalid()
  return value
}

/** Validate the exact ten-field owner packet and its self-digest against the measured public recipe.
 * @param value - The actual owner endpoint JSON, without private paths or configuration contents.
 * @param identity - Independently parsed twelve-field public recipe for the same software.
 * @returns Frozen measurements after schema, guard version, source/class pins and digest agree.
 */
export function parseH3OwnerRuntimeIdentity(value: unknown, identity: H3CanonicalIdentity): H3OwnerRuntimeIdentity {
  const actual = row(value); exact(actual, KEYS)
  const recipe = parseH3CanonicalIdentity(identity)
  if (actual.schemaVersion !== SCHEMA || actual.queueAdmissionGuardVersion !== 1) invalid()
  for (const key of KEYS) {
    if (key === 'schemaVersion' || key === 'queueAdmissionGuardVersion') continue
    if (typeof actual[key] !== 'string' || !HASH.test(actual[key])) invalid()
  }
  if (actual.sourceManifestSha256 !== recipe.sourceManifestSha256
    || actual.classOriginSha256 !== recipe.classOriginSha256) invalid()
  const { ownerRuntimeWitnessSha256: witness, ...measured } = actual
  if (digest(measured) !== witness) invalid()
  return Object.freeze({ schemaVersion: SCHEMA, ownerConfigDigest: hash(actual.ownerConfigDigest),
    apiProcessWitnessSha256: hash(actual.apiProcessWitnessSha256),
    comfyProcessWitnessSha256: hash(actual.comfyProcessWitnessSha256), queueAdmissionGuardVersion: 1,
    sourceManifestSha256: recipe.sourceManifestSha256, classOriginSha256: recipe.classOriginSha256,
    comfyFfmpegSha256: hash(actual.comfyFfmpegSha256), deliveryFfmpegSha256: hash(actual.deliveryFfmpegSha256),
    ownerRuntimeWitnessSha256: hash(witness) })
}

/** Parse only witnessed jobs; legacy four-field receipts remain confined to the legacy parser.
 * @param value - Actual canonical job JSON with a five-field receipt and ten-field completed actual.
 * @param expected - Same submitting job, source, encoders and captured owner-process witness.
 * @returns Finite status retaining the witness; missing, stale and mixed-version receipts fail.
 */
export function parseH3WitnessedJob(value: unknown, expected: H3WitnessedJobExpectation): H3WitnessedJob {
  const owner = parseH3OwnerRuntimeIdentity(expected.owner, expected.identity)
  if (owner.comfyFfmpegSha256 !== expected.comfyFfmpegSha256
    || owner.deliveryFfmpegSha256 !== expected.deliveryFfmpegSha256) invalid()
  const packet = row(value)
  let text: string
  try { text = JSON.stringify(packet) } catch { return invalid() }
  if (Buffer.byteLength(text) > 64 * 1024) invalid()
  const receipt = row(packet.recipe_identity)
  exact(receipt, ['schemaVersion', 'expected', 'ownerRuntimeWitnessSha256', 'actual', 'attested'])
  if (receipt.ownerRuntimeWitnessSha256 !== owner.ownerRuntimeWitnessSha256) invalid()
  let actual = receipt.actual
  if (packet.status === 'done') {
    const measured = row(actual)
    exact(measured, ['executionRecipeSha256', 'modelSha256', 'modelSetSha256', 'sourceManifestSha256',
      'classOriginSha256', 'deliverySha256', 'deliverySize', 'comfyFfmpegSha256', 'deliveryFfmpegSha256',
      'ownerRuntimeWitnessSha256'])
    if (measured.ownerRuntimeWitnessSha256 !== owner.ownerRuntimeWitnessSha256) invalid()
    const { ownerRuntimeWitnessSha256: _witness, ...legacyActual } = measured
    actual = legacyActual
  }
  const { ownerRuntimeWitnessSha256: _witness, ...legacyReceipt } = receipt
  const parsed = parseH3CanonicalJob({ ...packet, recipe_identity: { ...legacyReceipt, actual } }, expected)
  return Object.freeze({ ...parsed, ownerRuntimeWitnessSha256: owner.ownerRuntimeWitnessSha256,
    adapterOrigin: canonicalH3Endpoint(expected.adapterBase, { kind: 'jobs' }).origin,
    executionRecipeSha256: expected.identity.executionRecipeSha256, modelSha256: expected.identity.modelSha256 })
}
