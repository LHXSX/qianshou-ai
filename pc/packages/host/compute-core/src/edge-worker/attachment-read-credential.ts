/** Authenticated metadata POST. Storage reads remain on the compute Host. */
import { requestJson } from '../supply/http.ts'
import { SupplyError } from '../supply/policy.ts'
import type { AttachmentReadGrant } from './artifact-read.ts'
import type { EdgeTaskIdentity } from './types.ts'
import { parseEdgeFileContract, type EdgeFileContract } from './file-task-contract.ts'

/** Request the exact-version read credential for one current lease and frozen slot.
 * @param input - Host-owned authentication, assignment and server-frozen references.
 * @returns The read grant after all metadata agrees with this exact assignment.
 */
export async function requestAttachmentReadCredential(input: {
  readonly origin: URL; readonly token: string; readonly leaseToken: string
  readonly identity: EdgeTaskIdentity; readonly fileContract: EdgeFileContract; readonly slot: string
  readonly signal?: AbortSignal; readonly fetch?: typeof fetch; readonly now?: () => number
}): Promise<AttachmentReadGrant> {
  const fail = (): never => { throw new SupplyError('EDGE_ATTACHMENT_READ_DENIED') }
  const contract = parseEdgeFileContract(input.fileContract, input.fileContract.task_type, input.fileContract.account_id)
  const binding = contract.attachments[input.slot]
  if (binding === undefined) throw new SupplyError('EDGE_ATTACHMENT_READ_DENIED')
  const local = input.origin.hostname === '127.0.0.1' || input.origin.hostname === '[::1]'
  if (binding === undefined || (input.origin.protocol !== 'https:' && !(local && input.origin.protocol === 'http:'))
    || input.origin.pathname !== '/' || input.origin.username || input.origin.password || input.origin.search || input.origin.hash
    || !input.token || /[\r\n]/u.test(input.token) || !input.leaseToken || input.leaseToken.length > 2048
    || !Number.isSafeInteger(input.identity.attempt) || input.identity.attempt < 1) fail()
  const body = { workload_id: input.identity.workloadId, shard_id: input.identity.shardId,
    worker_id: input.identity.workerId, attempt: input.identity.attempt, account_id: contract.account_id,
    task_type: contract.task_type, contract_sha256: contract.contract_sha256, slot: input.slot,
    lease_token: input.leaseToken }
  const value = await requestJson(new URL('/api/v8/files/attachment-read-credential', input.origin), {
    method: 'POST', headers: { authorization: `Bearer ${input.token}`, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  }, { timeoutMs: 15_000, maxResponseBytes: 8192, ...(input.fetch === undefined ? {} : { fetch: input.fetch }) }, input.signal)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  const grant = value as Record<string, unknown>
  const fields = ['schema', ...Object.keys(body).filter(key => key !== 'lease_token'), 'object_key', 'object_version_id',
    'sha256', 'size_bytes', 'content_type', 'file_schema_sha256', 'bindings_sha256', 'url', 'method', 'expires_at']
  if (Object.keys(grant).sort().join(',') !== fields.sort().join(',')
    || grant.schema !== 'qianshou.file-attachment-read-credential.v1' || grant.method !== 'GET'
    || Object.entries(body).some(([key, expected]) => key !== 'lease_token' && grant[key] !== expected)
    || grant.file_schema_sha256 !== contract.file_schema_sha256 || grant.bindings_sha256 !== contract.bindings_sha256
    || ['object_key', 'object_version_id', 'sha256', 'size_bytes', 'content_type'].some(key =>
      grant[key] !== binding.artifact[key as keyof typeof binding.artifact])
    || typeof grant.url !== 'string' || grant.url.length > 4096 || !Number.isSafeInteger(grant.expires_at)
    || Number(grant.expires_at) <= (input.now ?? Date.now)() / 1000 + 5
    || Number(grant.expires_at) > Math.floor((input.now ?? Date.now)() / 1000) + 60) fail()
  return Object.freeze({ objectKey: binding.artifact.object_key, objectVersionId: binding.artifact.object_version_id,
    sha256: binding.artifact.sha256, sizeBytes: binding.artifact.size_bytes, contentType: binding.artifact.content_type,
    url: grant.url as string, expiresAt: grant.expires_at as number })
}
