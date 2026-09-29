/** Frozen metadata for the bounded file ABI; object bytes and lease tokens are excluded. */
import { createHash } from 'node:crypto'
import { isArtifactContentType } from '../artifact-content-type.ts'
import { SupplyError } from '../supply/policy.ts'
import type { EdgeArtifactManifest } from './types.ts'

export interface FileAttachmentBinding {
  readonly source: { readonly workload_id: string; readonly shard_id: string; readonly result_id: string }
  readonly artifact: EdgeArtifactManifest
}
export interface EdgeFileContract {
  readonly schema: 'qianshou.file-attachment-bindings.v1'
  readonly account_id: number
  readonly task_type: string
  readonly contract_sha256: string
  readonly file_schema_sha256: string
  readonly attachments: Readonly<Record<string, FileAttachmentBinding>>
  readonly bindings_sha256: string
}
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA = /^[0-9a-f]{64}$/u
const VERSION = /^[A-Za-z0-9_.~+-]{1,200}$/u
function invalid(): never { throw new SupplyError('EDGE_FILE_CONTRACT_INVALID') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, fields: string): void {
  if (Object.keys(value).sort().join(',') !== fields) invalid()
}
/** Canonical JSON shared by the signed metadata digests.
 * @param value - Finite JSON metadata.
 * @returns UTF-8 text with recursively sorted object fields.
 */
export function canonicalFileMetadata(value: unknown): string {
  let nodes = 0
  const encode = (item: unknown, depth: number): string => {
    if (depth > 16 || ++nodes > 256) invalid()
    if (Array.isArray(item)) return '[' + item.map(child => encode(child, depth + 1)).join(',') + ']'
    if (item !== null && typeof item === 'object') return '{' + Object.entries(item)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => JSON.stringify(key) + ':' + encode(child, depth + 1)).join(',') + '}'
    if (typeof item === 'number' && !Number.isFinite(item)) invalid()
    const encoded = JSON.stringify(item)
    if (encoded === undefined) invalid()
    return encoded
  }
  return encode(value, 0)
}

/** Parse the exact server-frozen references before local admission or authorization.
 * @param value - Untrusted file_contract from the authenticated assignment.
 * @param taskType - Current assignment's declared task type.
 * @param accountId - Current assignment's workload owner.
 * @returns Fresh immutable metadata with its complete digest checked.
 */
export function parseEdgeFileContract(value: unknown, taskType: string, accountId: number): EdgeFileContract {
  const raw = record(value)
  keys(raw, 'account_id,attachments,bindings_sha256,contract_sha256,file_schema_sha256,schema,task_type')
  if (raw.schema !== 'qianshou.file-attachment-bindings.v1' || raw.task_type !== taskType
    || raw.account_id !== accountId || !Number.isSafeInteger(accountId) || accountId < 1
    || typeof raw.contract_sha256 !== 'string' || !/^sha256:[0-9a-f]{64}$/u.test(raw.contract_sha256)
    || typeof raw.file_schema_sha256 !== 'string' || !SHA.test(raw.file_schema_sha256)
    || Buffer.byteLength(canonicalFileMetadata(raw)) > 8192) invalid()
  const attachments = record(raw.attachments)
  if (Object.keys(attachments).length > 1) invalid()
  const pinned: Record<string, FileAttachmentBinding> = {}
  for (const [slot, item] of Object.entries(attachments)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(slot)) invalid()
    const binding = record(item); keys(binding, 'artifact,source')
    const source = record(binding.source); keys(source, 'result_id,shard_id,workload_id')
    if (!Object.values(source).every(id => typeof id === 'string' && UUID.test(id))) invalid()
    const artifact = record(binding.artifact)
    keys(artifact, 'account_id,content_type,filename,object_key,object_version_id,result_id,schema,sha256,shard_id,size_bytes,workload_id')
    if (artifact.schema !== 'artifact.v1' || artifact.account_id !== accountId
      || artifact.workload_id !== source.workload_id || artifact.shard_id !== source.shard_id
      || artifact.result_id !== source.result_id || typeof artifact.sha256 !== 'string' || !SHA.test(artifact.sha256)
      || !Number.isSafeInteger(artifact.size_bytes) || Number(artifact.size_bytes) < 1 || Number(artifact.size_bytes) > 16 * 1024
      || !isArtifactContentType(artifact.content_type) || typeof artifact.filename !== 'string'
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(artifact.filename) || artifact.filename.includes('..')
      || typeof artifact.object_version_id !== 'string' || !VERSION.test(artifact.object_version_id)
      || artifact.object_version_id.toLowerCase() === 'null'
      || artifact.object_key !== `v8/account-${accountId}/workload-${source.workload_id}/shard-${source.shard_id}/result/${source.result_id}/${artifact.filename}`) invalid()
    pinned[slot] = Object.freeze({ source: Object.freeze({ ...source }) as FileAttachmentBinding['source'],
      artifact: Object.freeze({ ...artifact }) as unknown as EdgeArtifactManifest })
  }
  const unsigned = { schema: raw.schema, account_id: accountId, task_type: taskType,
    contract_sha256: raw.contract_sha256, file_schema_sha256: raw.file_schema_sha256, attachments: pinned }
  const digest = 'sha256:' + createHash('sha256').update(canonicalFileMetadata(unsigned)).digest('hex')
  if (raw.bindings_sha256 !== digest) invalid()
  return Object.freeze({ ...unsigned, attachments: Object.freeze(pinned), bindings_sha256: digest }) as EdgeFileContract
}
