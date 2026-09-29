/** Bounded, signed, read-only Guangzhou release discovery. No archive is downloaded here. */
import { createPublicKey, verify } from 'node:crypto'
import { CatalogFailure } from './registry.ts'
import type { MarketReleasePreview } from './types.ts'

const MAX_RESPONSE_BYTES = 1024 * 1024
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024
const MAX_TOTAL_PACKAGE_BYTES = 1024 * 1024 * 1024
const ID = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u
const OPERATION_ID = /^[a-z0-9][a-z0-9._-]{0,79}$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const SHA256 = /^[0-9a-f]{64}$/u
const SIGNATURE = /^[A-Za-z0-9+/]{86}==$/u
const CONTROL = /[\u0000-\u001f\u007f]/u
const PLATFORMS = ['darwin', 'win32', 'linux'] as const
const ARCHITECTURES = ['arm64', 'x64', 'ia32', 'arm'] as const
const EXECUTORS = ['workflow', 'node', 'python', 'model'] as const
const PERMISSIONS = ['workspace.read', 'workspace.write', 'network.declared', 'model.local', 'gpu'] as const

type SignedOperation = MarketReleasePreview['operations'][number] & {
  inputSchemaSha256: string
  outputSchemaSha256: string
}

/** Exact signed server declaration retained inside the Host for one artifact request. */
export interface SignedRelease extends Omit<MarketReleasePreview, 'operations' | 'publisherId' | 'reviewId' | 'reviewedAt'> {
  packageSha256: string
  operations: SignedOperation[]
  publisher: { id: string; signature: string }
  approval: { reviewId: string; reviewedAt: number; operatorId: string; signature: string }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function only(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every(key => fields.includes(key)) && fields.every(key => Object.hasOwn(value, key))
}

function string(value: unknown, max: number, pattern?: RegExp): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max && !CONTROL.test(value)
    && (pattern === undefined || pattern.test(value)) ? value : null
}

function enumArray<T extends string>(value: unknown, values: readonly T[]): T[] | null {
  return Array.isArray(value) && value.length > 0 && value.length <= values.length
    && value.every(item => typeof item === 'string' && values.includes(item as T))
    && new Set(value).size === value.length ? value as T[] : null
}

function signature(value: unknown): string | null {
  const encoded = string(value, 88, SIGNATURE)
  return encoded !== null && Buffer.from(encoded, 'base64').toString('base64') === encoded ? encoded : null
}

/** Canonical publisher declaration bytes, excluding trust wrappers.
 * @param release - One signed release declaration.
 * @returns The exact UTF-8 JSON text the publisher signed.
 */
export function releasePayload(release: SignedRelease): string {
  return JSON.stringify({
    pluginId: release.pluginId, version: release.version, releaseId: release.releaseId,
    title: release.title, summary: release.summary, packageSha256: release.packageSha256,
    packageBytes: release.packageBytes, platforms: release.platforms, architectures: release.architectures,
    operations: release.operations.map(operation => ({
      capabilityId: operation.capabilityId, operationId: operation.operationId,
      executorKind: operation.executorKind, inputSchemaSha256: operation.inputSchemaSha256,
      outputSchemaSha256: operation.outputSchemaSha256, permissions: operation.permissions,
    })),
  })
}

/** Canonical Guangzhou reviewer approval bytes.
 * @param release - One signed release declaration and its publisher proof.
 * @returns The exact UTF-8 JSON text the reviewer signed.
 */
export function approvalPayload(release: SignedRelease): string {
  return JSON.stringify({
    release: JSON.parse(releasePayload(release)) as unknown,
    publisher: release.publisher,
    reviewId: release.approval.reviewId,
    reviewedAt: release.approval.reviewedAt,
    operatorId: release.approval.operatorId,
  })
}

function signedBy(payload: string, encodedSignature: string, encodedKey: string | undefined): boolean {
  if (encodedKey === undefined || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedKey)) return false
  try {
    const key = createPublicKey({ key: Buffer.from(encodedKey, 'base64'), format: 'der', type: 'spki' })
    return key.asymmetricKeyType === 'ed25519'
      && verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(encodedSignature, 'base64'))
  } catch { return false }
}

function parseOperation(raw: unknown): SignedOperation | null {
  const item = object(raw)
  if (item === null || !only(item, [
    'capabilityId', 'operationId', 'executorKind', 'inputSchemaSha256', 'outputSchemaSha256', 'permissions',
  ])) return null
  const capabilityId = string(item.capabilityId, 80, OPERATION_ID)
  const operationId = string(item.operationId, 80, OPERATION_ID)
  const executorKind = string(item.executorKind, 20)
  const inputSchemaSha256 = string(item.inputSchemaSha256, 64, SHA256)
  const outputSchemaSha256 = string(item.outputSchemaSha256, 64, SHA256)
  if (capabilityId === null || operationId === null || executorKind === null
    || !EXECUTORS.includes(executorKind as typeof EXECUTORS[number]) || inputSchemaSha256 === null
    || outputSchemaSha256 === null || !Array.isArray(item.permissions)
    || item.permissions.length > PERMISSIONS.length
    || item.permissions.some(value => typeof value !== 'string' || !PERMISSIONS.includes(value as typeof PERMISSIONS[number]))
    || new Set(item.permissions).size !== item.permissions.length) return null
  return { capabilityId, operationId, executorKind: executorKind as SignedOperation['executorKind'],
    inputSchemaSha256, outputSchemaSha256, permissions: item.permissions as string[] }
}

function parseRelease(raw: unknown, publisherKeys: Readonly<Record<string, string>>,
  operatorKeys: Readonly<Record<string, string>>): SignedRelease | null {
  const item = object(raw)
  if (item === null || !only(item, [
    'pluginId', 'version', 'releaseId', 'title', 'summary', 'packageSha256', 'packageBytes',
    'platforms', 'architectures', 'operations', 'publisher', 'approval', 'verificationScope', 'installable',
  ]) || item.verificationScope !== 'opaque-archive-bytes' || item.installable !== false) return null
  const pluginId = string(item.pluginId, 80, ID)
  const version = string(item.version, 40, VERSION)
  const releaseId = string(item.releaseId, 80, ID)
  const title = string(item.title, 80)
  const summary = string(item.summary, 400)
  const packageSha256 = string(item.packageSha256, 64, SHA256)
  const packageBytes = item.packageBytes
  const platforms = enumArray(item.platforms, PLATFORMS)
  const architectures = enumArray(item.architectures, ARCHITECTURES)
  if (pluginId === null || version === null || releaseId === null || title === null || summary === null
    || packageSha256 === null || typeof packageBytes !== 'number' || !Number.isSafeInteger(packageBytes)
    || packageBytes < 1 || packageBytes > MAX_PACKAGE_BYTES || platforms === null || architectures === null
    || !Array.isArray(item.operations) || item.operations.length < 1 || item.operations.length > 16) return null
  const operations: SignedOperation[] = []
  for (const rawOperation of item.operations) {
    const operation = parseOperation(rawOperation)
    if (operation === null || operations.some(previous => previous.capabilityId === operation.capabilityId
      && previous.operationId === operation.operationId)) return null
    operations.push(operation)
  }
  const publisher = object(item.publisher)
  const approval = object(item.approval)
  if (publisher === null || !only(publisher, ['id', 'signature'])
    || approval === null || !only(approval, ['reviewId', 'reviewedAt', 'operatorId', 'signature'])) return null
  const publisherId = string(publisher.id, 80, ID)
  const publisherSignature = signature(publisher.signature)
  const reviewId = string(approval.reviewId, 80, ID)
  const reviewedAt = approval.reviewedAt
  const operatorId = string(approval.operatorId, 80, ID)
  const operatorSignature = signature(approval.signature)
  if (publisherId === null || publisherSignature === null || reviewId === null || operatorId === null
    || operatorSignature === null || typeof reviewedAt !== 'number' || !Number.isSafeInteger(reviewedAt)
    || reviewedAt < 1) return null
  const signed: SignedRelease = {
    pluginId, version, releaseId, title, summary, packageSha256, packageBytes,
    platforms, architectures, operations, publisher: { id: publisherId, signature: publisherSignature },
    approval: { reviewId, reviewedAt, operatorId, signature: operatorSignature },
    verificationScope: 'opaque-archive-bytes', installable: false,
  }
  const publisherKey = Object.hasOwn(publisherKeys, publisherId) ? publisherKeys[publisherId] : undefined
  const operatorKey = Object.hasOwn(operatorKeys, operatorId) ? operatorKeys[operatorId] : undefined
  if (publisherKey === undefined || operatorKey === undefined
    || Buffer.from(publisherKey, 'base64').equals(Buffer.from(operatorKey, 'base64'))
    || !signedBy(releasePayload(signed), publisherSignature, publisherKey)
    || !signedBy(approvalPayload(signed), operatorSignature, operatorKey)) return null
  return signed
}

/** Reject the entire release response if any row is malformed, duplicate or untrusted.
 * @param value - Parsed JSON body from the Guangzhou release route.
 * @param publisherKeys - Trusted publisher Ed25519 keys.
 * @param operatorKeys - Trusted reviewer Ed25519 keys.
 * @returns Signed releases or null when the whole body is invalid.
 */
export function parseSignedReleaseBody(value: unknown, publisherKeys: Readonly<Record<string, string>>,
  operatorKeys: Readonly<Record<string, string>>): SignedRelease[] | null {
  const body = object(value)
  if (body === null || !only(body, ['releases']) || !Array.isArray(body.releases)
    || body.releases.length > 100) return null
  const releases: SignedRelease[] = []
  const releaseIds = new Set<string>()
  const versionKeys = new Set<string>()
  let totalBytes = 0
  for (const raw of body.releases) {
    const release = parseRelease(raw, publisherKeys, operatorKeys)
    if (release === null) return null
    const versionKey = `${release.pluginId}@${release.version}`
    if (releaseIds.has(release.releaseId) || versionKeys.has(versionKey)) return null
    releaseIds.add(release.releaseId)
    versionKeys.add(versionKey)
    totalBytes += release.packageBytes
    if (totalBytes > MAX_TOTAL_PACKAGE_BYTES) return null
    releases.push(release)
  }
  return releases
}

function previewRelease(release: SignedRelease): MarketReleasePreview {
  return {
    pluginId: release.pluginId, version: release.version, releaseId: release.releaseId,
    title: release.title, summary: release.summary, packageBytes: release.packageBytes,
    platforms: release.platforms, architectures: release.architectures,
    operations: release.operations.map(({ capabilityId, operationId, executorKind, permissions }) =>
      ({ capabilityId, operationId, executorKind, permissions })),
    publisherId: release.publisher.id, reviewId: release.approval.reviewId,
    reviewedAt: release.approval.reviewedAt, verificationScope: 'opaque-archive-bytes', installable: false,
  }
}

/** Keep transport fields inside the Host; UI previews receive no signatures or hashes.
 * @param value - Parsed JSON body from the Guangzhou release route.
 * @param publisherKeys - Trusted publisher Ed25519 keys.
 * @param operatorKeys - Trusted reviewer Ed25519 keys.
 * @returns Read-only PC previews or null when the whole body is invalid.
 */
export function parseReleaseBody(value: unknown, publisherKeys: Readonly<Record<string, string>>,
  operatorKeys: Readonly<Record<string, string>>): MarketReleasePreview[] | null {
  return parseSignedReleaseBody(value, publisherKeys, operatorKeys)?.map(previewRelease) ?? null
}

/** Read one bounded signed release response; redirects and unknown identities fail closed.
 * @param base - Operator-validated Guangzhou origin.
 * @param signal - Cancellation and deadline signal.
 * @param publisherKeys - Trusted publisher Ed25519 keys.
 * @param operatorKeys - Trusted reviewer Ed25519 keys.
 * @returns Exact signed releases retained in the Host.
 */
export async function fetchSignedReleases(base: URL, signal: AbortSignal,
  publisherKeys: Readonly<Record<string, string>>, operatorKeys: Readonly<Record<string, string>>): Promise<SignedRelease[]> {
  const response = await fetch(new URL('/qianshou-market/releases', base), {
    signal, redirect: 'error', credentials: 'omit', headers: { Accept: 'application/json' },
  })
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new CatalogFailure('unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new CatalogFailure('invalid-response')
      chunks.push(part.value)
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new CatalogFailure('invalid-response') }
  const releases = parseSignedReleaseBody(value, publisherKeys, operatorKeys)
  if (releases === null) throw new CatalogFailure('invalid-response')
  return releases
}

/** Present only metadata to the PC market, with installation always disabled.
 * @param base - Operator-validated Guangzhou origin.
 * @param signal - Cancellation and deadline signal.
 * @param publisherKeys - Trusted publisher Ed25519 keys.
 * @param operatorKeys - Trusted reviewer Ed25519 keys.
 * @returns Read-only preview rows without transport digests or signatures.
 */
export async function fetchReleasePreviews(base: URL, signal: AbortSignal,
  publisherKeys: Readonly<Record<string, string>>, operatorKeys: Readonly<Record<string, string>>): Promise<MarketReleasePreview[]> {
  return (await fetchSignedReleases(base, signal, publisherKeys, operatorKeys)).map(previewRelease)
}
