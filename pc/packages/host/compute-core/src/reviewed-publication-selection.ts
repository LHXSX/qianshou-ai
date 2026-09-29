/** Exact approved publication selected for one quote and its eventual order. */
import { ComputeError } from './errors.ts'

export interface ReviewedPublicationSelection {
  readonly schema: 'qianshou.reviewed-publication-selection.v1'
  readonly publication_id: string
  readonly artifact_digest: string
  readonly contract_sha256: string
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u

/** Parse only the public, immutable publication identity; no private graph or media bytes. */
export function parseReviewedPublicationSelection(value: unknown): ReviewedPublicationSelection {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ComputeError('COMPUTE_REVIEWED_PUBLICATION_INVALID', 409)
  }
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'artifact_digest,contract_sha256,publication_id,schema'
    || row.schema !== 'qianshou.reviewed-publication-selection.v1'
    || typeof row.publication_id !== 'string' || !UUID.test(row.publication_id)
    || typeof row.artifact_digest !== 'string' || !DIGEST.test(row.artifact_digest)
    || typeof row.contract_sha256 !== 'string' || !DIGEST.test(row.contract_sha256)) {
    throw new ComputeError('COMPUTE_REVIEWED_PUBLICATION_INVALID', 409)
  }
  return Object.freeze({ schema: row.schema, publication_id: row.publication_id,
    artifact_digest: row.artifact_digest, contract_sha256: row.contract_sha256 })
}
