/** Current ownership, immutable installed bytes and independent file-purpose proof are separate gates. */
import { constants } from 'node:fs'
import { lstat, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { loadInstalledVerifiedOrderAdapterSource } from './order-buyer-install.ts'
import { parseGenericFileSchema, type GenericFileSchema } from './generic-file-contract.ts'
import { verifyFileDeviceChallengeReceipt, type FileDeviceChallengeReceipt } from './order-file-device-challenge.ts'
import { canonicalOrderJson } from './order-json-canonical.ts'
import type { GenericOrderSource } from './generic-order-source.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import type { OrderAdapterBuyerEntitlement } from './types.ts'
import { CatalogFailure } from './registry.ts'

export interface VerifiedPurchasedFileOrderRuntime {
  readonly productId: string
  readonly entitlementId: string
  readonly taskType: string
  readonly capabilityId: string
  readonly outputKind: 'artifact_ref'
  readonly artifactDigest: string
  readonly packageDigest: string
  readonly runtimeDigest: string
  readonly contractVersion: 'v1'
  readonly contractSha256: string
  readonly fileSchemaSha256: string
  readonly fileSchema: GenericFileSchema
}
export interface FileRuntimeRoots {
  readonly fileAttestorKeys: Readonly<Record<string, string>>
  readonly nonFilePurposeKeys: readonly string[]
}
function invalid(): never { throw new CatalogFailure('order-runtime-unavailable') }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function markerPath(source: GenericOrderSource): string {
  return join(dirname(dirname(source.root)), 'file-device-install.json')
}
async function readMarker(source: GenericOrderSource): Promise<unknown> {
  const entry = await lstat(markerPath(source)).catch(invalid)
  if (!entry.isFile() || entry.isSymbolicLink()) invalid()
  const file = await open(markerPath(source), constants.O_RDONLY | constants.O_NOFOLLOW).catch(invalid)
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 2 || stat.size > 8192) invalid()
    const bytes = await file.readFile()
    if (bytes.length > 8192) invalid()
    const marker = row(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown)
    if (Object.keys(marker).sort().join(',') !== 'receipt,schema'
      || marker.schema !== 'qianshou.file-device-install.v1') invalid()
    return marker.receipt
  } finally { await file.close() }
}
/** Save only an already verified receipt after Shanghai has committed this exact device installation.
 * @param source - Reopened immutable installed source; its parent is the private runtime directory.
 * @param receipt - Dedicated file-purpose signed proof. No bearer tokens or storage URLs are persisted.
 */
export async function saveFileDeviceInstallReceipt(source: GenericOrderSource,
  receipt: FileDeviceChallengeReceipt, guardAfterCommit?: () => Promise<void>): Promise<void> {
  const text = canonicalOrderJson({ schema: 'qianshou.file-device-install.v1', receipt })
  if (Buffer.byteLength(text) > 8192) invalid()
  const target = markerPath(source)
  const temporary = `${target}.${randomUUID()}.tmp`
  const readPrevious = async (): Promise<Buffer | null> => {
    const stat = await lstat(target).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (stat === null) return null
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192) invalid()
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const bytes = await file.readFile()
      if (bytes.length > 8192) invalid()
      return bytes
    } finally { await file.close() }
  }
  const previous = await readPrevious()
  let committed = false
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: 'wx' })
    await rename(temporary, target)
    committed = true
    await guardAfterCommit?.()
  } catch (error) {
    // Do not remove a receipt written by another activation while this guard awaited.
    if (committed && (await readPrevious())?.equals(Buffer.from(text))) {
      if (previous === null) await rm(target)
      else {
        await writeFile(temporary, previous, { mode: 0o600, flag: 'wx' })
        await rename(temporary, target)
      }
    }
    throw error
  } finally { await rm(temporary, { force: true }) }
}

/** Recheck server device ownership and bytes before accepting a persisted dedicated file proof.
 * @param input - Fresh authenticated entitlement, signed archive identity and locally enrolled purpose roots.
 * @returns Exact callable file runtime, or null when a required admission fact is absent.
 */
export async function loadOwnedInstalledFileRuntime(input: FileRuntimeRoots & {
  entitlement: OrderAdapterBuyerEntitlement; signed: VerifiedOrderAdapterSource; home: string;
  workerId: string; accountId: number
}): Promise<{ runtime: VerifiedPurchasedFileOrderRuntime; source: GenericOrderSource } | null> {
  const { entitlement, signed } = input
  if (entitlement.status !== 'installed' || !entitlement.deviceInstalled || entitlement.runtimeDigest === null
    || signed.check.productId !== entitlement.productId || signed.check.entitlementId !== entitlement.entitlementId
    || signed.acceptedInputKinds?.join(',') !== 'inline' || signed.outputKind !== 'artifact_ref'
    || signed.contractVersion !== 'v1' || input.nonFilePurposeKeys.length === 0) return null
  const installed = await loadInstalledVerifiedOrderAdapterSource(signed, input.home)
  if (installed.runtimeDigest !== entitlement.runtimeDigest || installed.source.taskDefinition?.fileSchema === undefined) return null
  const fileSchema = parseGenericFileSchema(installed.source.taskDefinition.fileSchema)
  const params = installed.source.taskDefinition.paramsSchema
  if (params && (Object.keys(params.properties as object).length > 0 || (params.required as unknown[]).length > 0)) return null
  const receipt = row(await readMarker(installed.source))
  const payload = row(receipt.payload)
  const binding = row(payload.file_binding)
  const keyId = receipt.key_id
  if (typeof keyId !== 'string' || typeof input.fileAttestorKeys[keyId] !== 'string'
    || typeof binding.contract_sha256 !== 'string') return null
  verifyFileDeviceChallengeReceipt(receipt, { source: signed, fileAttestorKeyId: keyId,
    fileAttestorPublicKey: input.fileAttestorKeys[keyId]!, ordinaryAttestorPublicKeys: input.nonFilePurposeKeys,
    nodeId: input.workerId, accountId: input.accountId, contractSha256: binding.contract_sha256,
    fileSchema, runtimeDigest: installed.runtimeDigest, requireFresh: false })
  return { source: installed.source, runtime: { productId: entitlement.productId,
    entitlementId: entitlement.entitlementId, taskType: signed.taskType, capabilityId: signed.capabilityId,
    outputKind: 'artifact_ref', artifactDigest: signed.artifactDigest, packageDigest: signed.reviewedSellerRuntimeDigest,
    runtimeDigest: installed.runtimeDigest, contractVersion: 'v1', contractSha256: binding.contract_sha256,
    fileSchemaSha256: createHash('sha256').update(canonicalOrderJson(fileSchema)).digest('hex'), fileSchema } }
}
