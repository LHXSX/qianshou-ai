/** Build a verified, transport-neutral result asset manifest for node/Guangzhou/workbench uploaders. */
import { createHash } from 'node:crypto'
import type { ComputeExecutionResult, ComputeOutputReference } from './executor.ts'
import { ComputeError } from './errors.ts'
import { verifyTaskOutputs } from './task-output.ts'

/** A semantic claim reference owned by the capability or artifact provider; no claim bytes cross this seam. */
export interface ComputeSemanticEvidenceReference {
  kind: 'caption' | 'transcript' | 'quality' | 'provenance'
  ref: string
  sha256?: string
}

/** Trusted output metadata supplied by the installed capability manifest. */
export interface ComputeResultAssetDescriptor {
  name: string
  mediaType: string
  semanticEvidence?: readonly ComputeSemanticEvidenceReference[]
}

/** Options that bind a manifest to one task attempt and its negotiated media policy. */
export interface ComputeResultAssetManifestOptions {
  taskId: string
  idempotencyKey: string
  maxOutputBytes: number
  /** Per-output MIME allowlist. Omitted entries accept the built-in safe media set. */
  allowedMediaTypes?: Readonly<Record<string, readonly string[]>>
}

/** Upload-ready local references. A transfer adapter reads `path` on the producing node only. */
export interface ComputeResultAssetManifest {
  version: 'qianshou.result-assets.v1'
  taskId: string
  idempotencyKey: string
  totalBytes: number
  assets: readonly ComputeResultAsset[]
}

export interface ComputeResultAsset {
  assetId: string
  name: string
  path: string
  bytes: number
  sha256: string
  mediaType: string
  semanticEvidence: readonly ComputeSemanticEvidenceReference[]
}

/**
 * Verify local output bytes and create an immutable upload manifest.
 * This function does not upload, open a network connection, dereference evidence, or settle payment.
 */
export async function prepareResultAssetManifest(
  workspacePath: string,
  result: ComputeExecutionResult,
  descriptors: readonly ComputeResultAssetDescriptor[],
  options: ComputeResultAssetManifestOptions,
  signal: AbortSignal,
): Promise<ComputeResultAssetManifest> {
  validateOptions(options)
  if (descriptors.length !== result.outputs.length && descriptors.length === 0) throw new ComputeError('COMPUTE_ASSET_DESCRIPTOR_MISMATCH')
  const byName = new Map<string, ComputeResultAssetDescriptor>()
  for (const descriptor of descriptors) {
    validateDescriptor(descriptor, options.allowedMediaTypes)
    if (byName.has(descriptor.name)) throw new ComputeError('COMPUTE_ASSET_DESCRIPTOR_DUPLICATE')
    byName.set(descriptor.name, descriptor)
  }
  if (descriptors.length !== result.outputs.length) throw new ComputeError('COMPUTE_ASSET_DESCRIPTOR_MISMATCH')
  const verified = await verifyTaskOutputs(workspacePath, result, options.maxOutputBytes, signal)
  const assets: ComputeResultAsset[] = []
  for (const output of verified.outputs) {
    signal.throwIfAborted()
    const descriptor = byName.get(output.name)
    if (!descriptor) throw new ComputeError('COMPUTE_ASSET_DESCRIPTOR_MISSING')
    const semanticEvidence = Object.freeze((descriptor.semanticEvidence ?? []).map(item => Object.freeze({ ...item })))
    assets.push(Object.freeze({
      assetId: assetId(options.taskId, options.idempotencyKey, output), name: output.name, path: output.path,
      bytes: output.bytes, sha256: output.sha256, mediaType: descriptor.mediaType, semanticEvidence,
    }))
  }
  if (byName.size !== assets.length || descriptors.length !== result.outputs.length) throw new ComputeError('COMPUTE_ASSET_DESCRIPTOR_MISMATCH')
  return Object.freeze({ version: 'qianshou.result-assets.v1', taskId: options.taskId, idempotencyKey: options.idempotencyKey, totalBytes: assets.reduce((sum, item) => sum + item.bytes, 0), assets: Object.freeze(assets) })
}

const SAFE_MEDIA_TYPES = new Set([
  'application/json', 'application/octet-stream', 'application/pdf', 'text/plain', 'text/markdown',
  'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/webm', 'image/gif', 'image/jpeg', 'image/png', 'image/webp',
  'video/mp4', 'video/webm', 'video/quicktime',
])

function validateOptions(options: ComputeResultAssetManifestOptions): void {
  const candidate: unknown = options
  if (!record(candidate)) throw new ComputeError('COMPUTE_ASSET_OPTIONS_INVALID')
  if (!id(candidate.taskId) || !id(candidate.idempotencyKey) || typeof candidate.maxOutputBytes !== 'number' || !Number.isSafeInteger(candidate.maxOutputBytes) || candidate.maxOutputBytes < 0) throw new ComputeError('COMPUTE_ASSET_OPTIONS_INVALID')
}

function validateDescriptor(value: ComputeResultAssetDescriptor, allowed?: Readonly<Record<string, readonly string[]>>): void {
  const candidate: unknown = value
  if (!record(candidate) || !id(candidate.name) || !mediaType(candidate.mediaType)) throw new ComputeError('COMPUTE_ASSET_DESCRIPTOR_INVALID')
  const permitted = allowed?.[value.name] ?? SAFE_MEDIA_TYPES
  const accepted = permitted instanceof Set ? permitted.has(value.mediaType) : permitted.includes(value.mediaType)
  if (!accepted) throw new ComputeError('COMPUTE_ASSET_MEDIA_TYPE_INVALID')
  const evidenceValue: unknown = value.semanticEvidence
  if (evidenceValue !== undefined) {
    if (!Array.isArray(evidenceValue) || evidenceValue.length > 32) throw new ComputeError('COMPUTE_ASSET_EVIDENCE_INVALID')
    for (const rawEvidence of evidenceValue as readonly unknown[]) {
      if (!record(rawEvidence) || !['caption', 'transcript', 'quality', 'provenance'].includes(String(rawEvidence.kind)) || !evidenceRef(rawEvidence.ref)
        || (rawEvidence.sha256 !== undefined && (typeof rawEvidence.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(rawEvidence.sha256)))) throw new ComputeError('COMPUTE_ASSET_EVIDENCE_INVALID')
    }
  }
}

function record(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function id(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value) }
function mediaType(value: unknown): value is string { return typeof value === 'string' && value.length <= 128 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/iu.test(value) }
function evidenceRef(value: unknown): value is string { return typeof value === 'string' && value.length <= 512 && /^(?:evidence|artifact|urn):[A-Za-z0-9._~:/-]{1,511}$/u.test(value) }
function assetId(taskId: string, idempotencyKey: string, output: ComputeOutputReference): string { return createHash('sha256').update(`${taskId}\u0000${idempotencyKey}\u0000${output.name}\u0000${output.sha256}`).digest('hex') }
