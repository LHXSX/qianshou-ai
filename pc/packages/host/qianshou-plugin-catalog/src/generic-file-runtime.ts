/** File content exists only on the compute Host; the control plane receives artifact.v1 metadata. */
import { createHash } from 'node:crypto'
import { canonicalOrderJson } from './order-json-canonical.ts'
import { canonicalSourceJson } from './order-source-json.ts'
import { validateGenericOrderInput, type GenericOrderSource } from './generic-order-source.ts'
import { fileGuestInput, fileGuestOutput, parseGenericFileSchema,
  type GenericFileAttachment, type GenericFileInput, type GenericProducedFile } from './generic-file-contract.ts'
import { runQuickJsOrderChallenge } from './quickjs-order-runtime.ts'
import { CatalogFailure } from './registry.ts'

/** The caller must bind this reader to one authenticated lease and frozen attachment references.
 * Only the reviewed slot is passed; the guest cannot choose a path, URL, key or credential.
 */
export type AuthorizedAttachmentReader = (slot: GenericFileInput) => Promise<GenericFileAttachment>

/** Structural Host port: its implementation owns the authenticated lease and direct-storage uploader. */
export interface GenericFileArtifact {
  readonly schema: 'artifact.v1'
  readonly object_key: string
  readonly object_version_id: string
  readonly filename: string
  readonly size_bytes: number
  readonly content_type: string
  readonly sha256: string
  readonly result_id: string
  readonly shard_id: string
  readonly workload_id: string
  readonly account_id: number
}

export async function runGenericOrderFileChallenge(source: GenericOrderSource, input: Uint8Array,
  read: AuthorizedAttachmentReader, signal?: AbortSignal): Promise<{
    readonly output: unknown; readonly outputDigest: string; readonly files: readonly GenericProducedFile[]
  }> {
  if (source.declaration.schema !== 'qianshou.local-adapter-candidate.v3'
    || source.declaration.outputKind !== 'artifact_ref' || source.taskDefinition?.fileSchema === undefined
    || input.byteLength < 1 || input.byteLength > 16 * 1024) throw new CatalogFailure('order-adapter-invalid')
  const schema = parseGenericFileSchema(source.taskDefinition.fileSchema)
  validateGenericOrderInput(source.taskDefinition, input)
  const logical = JSON.parse(canonicalSourceJson(Buffer.from(input)).toString('utf8')) as unknown
  const validText = (value: unknown): boolean => {
    if (typeof value === 'string') return value.isWellFormed()
    if (Array.isArray(value)) return value.every(validText)
    if (value !== null && typeof value === 'object') return Object.entries(value)
      .every(([key, item]) => key.isWellFormed() && validText(item))
    return true
  }
  if (logical === null || typeof logical !== 'object' || Array.isArray(logical)
    || Object.keys(logical).length === 0 || !validText(logical)) throw new CatalogFailure('order-adapter-invalid')
  const entry = source.files.find(file => file.path === source.entryPath)?.bytes
  if (entry === undefined) throw new CatalogFailure('order-adapter-invalid')
  const guest = await fileGuestInput(schema, logical, read, signal)
  const result = await runQuickJsOrderChallenge(entry, guest, signal)
  return { ...result, files: fileGuestOutput(schema, result.output) }
}

/** Same file ABI for author examples; attachment bytes are pinned in the source inventory. */
export async function verifyGenericOrderFileSamples(source: GenericOrderSource): Promise<void> {
  const inventory = new Map(source.files.map(file => [file.path, file.bytes]))
  for (const sample of source.declaration.selfTests) {
    const input = inventory.get(sample.input)
    const expected = inventory.get(sample.expected)
    if (input === undefined || expected === undefined) throw new CatalogFailure('order-adapter-invalid')
    const actual = await runGenericOrderFileChallenge(source, input, async slot => {
      const fixture = sample.attachments?.[slot.name]
      const bytes = fixture === undefined ? undefined : inventory.get(fixture.path)
      if (fixture === undefined || bytes === undefined) throw new CatalogFailure('order-adapter-invalid')
      return { contentType: fixture.contentType, bytes,
        sha256: createHash('sha256').update(bytes).digest('hex') }
    })
    if (canonicalOrderJson(actual.output) !== canonicalOrderJson(JSON.parse(expected.toString('utf8')) as unknown)) {
      throw new CatalogFailure('order-local-verification-failed')
    }
  }
}

/** A complete bounded execution and real lease-bound direct-storage upload.
 * Neither upload success nor this manifest is a verification or settlement receipt.
 * Upload credentials remain inside the authenticated Host port and never enter the guest envelope.
 */
export async function executeGenericOrderFile(source: GenericOrderSource, input: Uint8Array,
  read: AuthorizedAttachmentReader,
  upload: (file: GenericProducedFile) => Promise<GenericFileArtifact>, signal?: AbortSignal): Promise<GenericFileArtifact> {
  const result = await runGenericOrderFileChallenge(source, input, read, signal)
  const file = result.files[0]!
  signal?.throwIfAborted()
  const artifact = await upload(file)
  signal?.throwIfAborted()
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
  if (Object.keys(artifact).sort().join(',') !== 'account_id,content_type,filename,object_key,object_version_id,result_id,schema,sha256,shard_id,size_bytes,workload_id'
    || artifact.schema !== 'artifact.v1' || artifact.filename !== file.filename
    || artifact.content_type !== file.contentType || artifact.size_bytes !== file.bytes.byteLength
    || artifact.sha256 !== file.sha256 || !Number.isSafeInteger(artifact.account_id) || artifact.account_id < 1
    || ![artifact.workload_id, artifact.shard_id, artifact.result_id].every(value => uuid.test(value))
    || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(artifact.object_version_id) || artifact.object_version_id.toLowerCase() === 'null'
    || artifact.object_key !== `v8/account-${artifact.account_id}/workload-${artifact.workload_id}/shard-${artifact.shard_id}/result/${artifact.result_id}/${file.filename}`) {
    throw new CatalogFailure('order-adapter-invalid')
  }
  return Object.freeze({ ...artifact })
}
