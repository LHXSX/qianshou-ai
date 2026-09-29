/** Native document admission and lease-selected storage reads; no QuickJS ABI widening. */
import { createHash } from 'node:crypto'
import { ComputeError } from './errors.ts'
import { LEGAL_DOCUMENT_CAPABILITY, LEGAL_DOCUMENT_TASK, LEGAL_DOCUMENT_VERSION, parseLegalDocumentRequest } from './legal-document-bundle.ts'
import { parsePlanFileInput, type PlanInputFile } from './plan-file-input.ts'
import { ComputeCapabilityId, ComputeTaskId, type ComputeTaskEnvelope } from './protocol.ts'
import type { EdgeTaskIdentity } from './edge-worker/types.ts'
import type { ComputeTaskInputSource } from './task-workspace.ts'
import { parseTaskEnvelope } from './validation.ts'

export interface LegalDocumentAdmission {
  /** Already authenticated current lease identity, supplied by the installed Host. */
  identity: EdgeTaskIdentity
  accountId: number
  contractSha256: string
  deadlineAt: string
  maxOutputBytes: number
  params: unknown
}
export interface LegalInputGrantRequest extends EdgeTaskIdentity {
  account_id: number
  task_type: typeof LEGAL_DOCUMENT_TASK
  contract_sha256: string
  object_key: string
  object_version_id: string
  sha256: string
  size_bytes: number
}
export interface LegalInputGrant extends LegalInputGrantRequest {
  schema: 'qianshou.native-document-input-grant.v1'
  url: string
  method: 'GET'
  expires_at: number
}
/** The installed Host retains authentication/lease credentials; callers cannot supply a URL. */
export type LegalInputGrantProvider = (request: LegalInputGrantRequest, signal: AbortSignal) => Promise<unknown>
function invalid(): never { throw new ComputeError('COMPUTE_LEGAL_ASSIGNMENT_INVALID', 422) }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

/** Convert the reviewed scalar form into the executor contract before staging any bytes. */
export function bindLegalDocumentAssignment(admission: LegalDocumentAdmission): {
  task: ComputeTaskEnvelope
  files: readonly PlanInputFile[]
} {
  const identity = admission.identity
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
  if (![identity.workerId, identity.workloadId, identity.shardId].every(value => uuid.test(value))
    || !Number.isSafeInteger(identity.attempt) || identity.attempt < 1 || identity.attempt > 1_000_000
    || !Number.isSafeInteger(admission.accountId) || admission.accountId < 1
    || !/^sha256:[0-9a-f]{64}$/u.test(admission.contractSha256)
    || !Number.isSafeInteger(admission.maxOutputBytes) || admission.maxOutputBytes < 1
    || admission.maxOutputBytes > 16 * 1024 * 1024) invalid()
  const params = record(admission.params)
  if (Object.keys(params).sort().join(',') !== 'document_plan,input_manifest,instructions'
    || typeof params.instructions !== 'string' || typeof params.document_plan !== 'string'
    || typeof params.input_manifest !== 'string' || params.document_plan.length > 8000
    || params.input_manifest.length > 8000) invalid()
  let documents: unknown, manifest: Record<string, unknown>
  try { documents = JSON.parse(params.document_plan); manifest = record(JSON.parse(params.input_manifest) as unknown) }
  catch { return invalid() }
  if (Object.keys(manifest).sort().join(',') !== 'files,schema' || manifest.schema !== 'qianshou.uploaded-inputs.v1') invalid()
  const files = parsePlanFileInput({ kind: 'multi_file', files: manifest.files }).files
  if (new Set(files.map(file => file.filename)).size !== files.length || files.some(file => file.objectVersionId === undefined
    || !file.objectKey.startsWith(`v8/account-${admission.accountId}/`))) invalid()
  const parameters = parseLegalDocumentRequest({ taskType: LEGAL_DOCUMENT_TASK, instructions: params.instructions, documents })
  const tuple = `${identity.workerId}\0${identity.workloadId}\0${identity.shardId}\0${identity.attempt}\0${admission.contractSha256}`
  const digest = createHash('sha256').update(tuple).digest('hex')
  const task = parseTaskEnvelope({ version: 'qianshou.task.v1', taskId: ComputeTaskId(`legal-${digest}`),
    capabilityId: ComputeCapabilityId(LEGAL_DOCUMENT_CAPABILITY), capabilityVersion: LEGAL_DOCUMENT_VERSION,
    inputRefs: files.map(file => ({ name: file.filename, bytes: file.bytes, sha256: file.sha256 })),
    parameters, deadlineAt: admission.deadlineAt, maxOutputBytes: admission.maxOutputBytes, idempotencyKey: digest })
  return Object.freeze({ task, files })
}

/** Only a current lease grant can open the pinned upload version directly from COS on this PC. */
export function createLegalUploadedInputSource(admission: LegalDocumentAdmission, storageHostname: string,
  grants: LegalInputGrantProvider, fetchImpl: typeof fetch = fetch): ComputeTaskInputSource {
  if (!/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(storageHostname)) invalid()
  const bound = bindLegalDocumentAssignment(admission)
  const exactTask = JSON.stringify(bound.task)
  return { async open(task, input, signal) {
    signal.throwIfAborted()
    const file = bound.files.find(file => file.filename === input.name && file.bytes === input.bytes && file.sha256 === input.sha256)
    if (JSON.stringify(task) !== exactTask
      || file?.objectVersionId === undefined) invalid()
    const request: LegalInputGrantRequest = { ...admission.identity, account_id: admission.accountId,
      task_type: LEGAL_DOCUMENT_TASK, contract_sha256: admission.contractSha256,
      object_key: file.objectKey, object_version_id: file.objectVersionId, sha256: file.sha256, size_bytes: file.bytes }
    const grant = record(await grants(request, signal))
    if (grant.schema !== 'qianshou.native-document-input-grant.v1' || grant.method !== 'GET'
      || Object.entries(request).some(([key, value]) => grant[key] !== value)
      || typeof grant.url !== 'string' || typeof grant.expires_at !== 'number' || !Number.isSafeInteger(grant.expires_at) || grant.expires_at <= Date.now() / 1000 + 5
      || grant.expires_at > Date.now() / 1000 + 65) invalid()
    let url: URL
    try { url = new URL(grant.url) } catch { return invalid() }
    if (url.protocol !== 'https:' || url.hostname !== storageHostname || url.port || url.username || url.password || url.hash
      || decodeURIComponent(url.pathname) !== '/' + file.objectKey
      || url.searchParams.getAll('versionId').join(',') !== file.objectVersionId) invalid()
    const response = await fetchImpl(url, { method: 'GET', signal, credentials: 'omit', redirect: 'error' })
    if (!response.ok || response.body === null) throw new ComputeError('COMPUTE_LEGAL_INPUT_UNAVAILABLE', 502)
    return response.body
  } }
}
