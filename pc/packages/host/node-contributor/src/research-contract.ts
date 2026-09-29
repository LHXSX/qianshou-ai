/** Strict R6 non-billable wire. Inputs cannot select devices, prices, graphs or replacement attempts. */
export class ResearchConsumerError extends Error {
  readonly code: string
  /** @param code - Finite protocol or storage refusal without private diagnostics. */
  constructor(code: string) { super(code); this.code = code }
}
/** Immutable owner/device/epoch assignment for the sole supported image workflow. */
export interface ResearchLease {
  readonly schema: 'qianshou.research-media-lease.v1'
  readonly requestId: string
  readonly taskId: string
  readonly attemptId: string
  readonly accountId: number
  readonly deviceId: string
  readonly connectionEpoch: number
  readonly observationRevision: string
  readonly leaseEpoch: 1
  readonly leaseExpiresAt: string
  readonly mode: 'image'
  readonly adapter: 'comfyui'
  readonly modelId: 'qwen-image-2.1-int8-convrot'
  readonly workflowId: 'comfy-pilot-image-154f7d6133fe0276'
  readonly input: { readonly prompt: string }
  readonly non_billable: true
}
/** Guangzhou-accepted PNG metadata; bytes are never sent to Shanghai. */
export interface ResearchArtifact {
  readonly assetId: string
  readonly sha256: string
  readonly size_bytes: number
  readonly content_type: 'image/png'
  readonly width: 2048
  readonly height: 1152
  readonly resultRevision: string
  readonly download_path: string
}
/** Original generation and delivery progress; only Guangzhou can declare completed. */
export type ResearchStage = 'leased' | 'accepted' | 'submitting' | 'running' | 'outcome_unknown' | 'uploading' | 'failed' | 'cancelled' | 'completed'
/** One server task and its permanently bound original attempt. */
export interface ResearchTask {
  readonly sequence: number
  readonly lease: ResearchLease
  readonly stage: ResearchStage
  readonly eventSequence: number
  readonly backendJobId: string | null
  readonly artifact: ResearchArtifact | null
  readonly submission: 'not_claimed' | 'claimed'
  readonly expired: boolean
}
/** Canonical wire UUID syntax. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
/** Canonical SHA256 syntax. */
export const HASH = /^[0-9a-f]{64}$/u
/** Reject an invalid research message with a finite code.
 * @param code - Stable refusal without private request contents.
 * @returns Never; the original operation receives a typed error.
 */
export function failure(code: string): never { throw new ResearchConsumerError(code) }
/** Require a JSON object at the protocol or journal reader.
 * @param value - Decoded untrusted JSON.
 * @returns A record after rejecting arrays and null.
 */
export function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) failure('RESEARCH_RESPONSE_INVALID')
  return value as Record<string, unknown>
}
/** Require only the fixed research message fields.
 * @param value - Decoded protocol or journal input.
 * @param fields - Complete accepted field set.
 * @returns The record after rejecting missing and extra fields.
 */
export function exact(value: unknown, fields: readonly string[]): Record<string, unknown> {
  const row = record(value)
  if (Object.keys(row).sort().join(',') !== [...fields].sort().join(',')) failure('RESEARCH_RESPONSE_INVALID')
  return row
}
/** Require a bounded nonnegative protocol integer.
 * @param value - Untrusted numeric value.
 * @param min - Inclusive protocol minimum.
 * @returns A safe integer at or above the minimum.
 */
export function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) failure('RESEARCH_RESPONSE_INVALID')
  return value
}
/** Read a canonical original task or attempt UUID.
 * @param value - Untrusted original identifier.
 * @returns The canonical UUID without creating a replacement.
 */
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) failure('RESEARCH_RESPONSE_INVALID')
  return value
}
/** Read a safe device or API identifier without local paths.
 * @param value - Untrusted public identifier.
 * @returns A bounded path-free identifier.
 */
export function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u.test(value) || value.includes('..')) failure('RESEARCH_RESPONSE_INVALID')
  return value
}
/** Read a lowercase SHA256 identity.
 * @param value - Untrusted digest.
 * @returns A complete lowercase SHA256.
 */
export function digest(value: unknown): string {
  if (typeof value !== 'string' || !HASH.test(value)) failure('RESEARCH_RESPONSE_INVALID')
  return value
}
/** Validate the fixed non-billable original Qwen lease.
 * @param value - Authenticated gateway lease JSON.
 * @returns The exact supported owner/device/workflow assignment.
 */
export function parseLease(value: unknown): ResearchLease {
  const p = exact(value, ['schema', 'requestId', 'taskId', 'attemptId', 'accountId', 'deviceId', 'connectionEpoch', 'observationRevision',
    'leaseEpoch', 'leaseExpiresAt', 'mode', 'adapter', 'modelId', 'workflowId', 'input', 'non_billable'])
  const input = exact(p.input, ['prompt'])
  if (p.schema !== 'qianshou.research-media-lease.v1' || p.mode !== 'image' || p.leaseEpoch !== 1 || p.non_billable !== true
    || p.adapter !== 'comfyui' || p.modelId !== 'qwen-image-2.1-int8-convrot' || p.workflowId !== 'comfy-pilot-image-154f7d6133fe0276'
    || typeof p.leaseExpiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(p.leaseExpiresAt)
    || !Number.isFinite(Date.parse(p.leaseExpiresAt)) || typeof input.prompt !== 'string' || !input.prompt.trim()
    || Buffer.byteLength(input.prompt) > 8192
    || Array.from(input.prompt).some(character => character.charCodeAt(0) === 127 || character.charCodeAt(0) < 32 && !'\t\n\r'.includes(character))) failure('RESEARCH_LEASE_INVALID')
  return { schema: 'qianshou.research-media-lease.v1', requestId: identifier(p.requestId), taskId: identifier(p.taskId),
    attemptId: identifier(p.attemptId), accountId: integer(p.accountId, 1), deviceId: identity(p.deviceId),
    connectionEpoch: integer(p.connectionEpoch, 1), observationRevision: digest(p.observationRevision), leaseEpoch: 1,
    leaseExpiresAt: p.leaseExpiresAt, mode: 'image', adapter: 'comfyui', modelId: 'qwen-image-2.1-int8-convrot',
    workflowId: 'comfy-pilot-image-154f7d6133fe0276', input: { prompt: input.prompt }, non_billable: true }
}
/** Validate the independently accepted original Guangzhou PNG receipt.
 * @param value - Gateway-accepted result metadata.
 * @param lease - The permanently bound original lease.
 * @returns A fixed-size PNG receipt and original download path.
 */
export function parseArtifact(value: unknown, lease: ResearchLease): ResearchArtifact {
  const a = exact(value, ['assetId', 'sha256', 'size_bytes', 'content_type', 'width', 'height', 'resultRevision', 'download_path'])
  const download = '/v1/media/research/result?taskId=' + lease.taskId + '&attemptId=' + lease.attemptId
  if (a.assetId !== lease.attemptId || a.content_type !== 'image/png' || a.width !== 2048 || a.height !== 1152
    || a.download_path !== download || integer(a.size_bytes, 1) > 67108864) failure('RESEARCH_ARTIFACT_INVALID')
  return { assetId: lease.attemptId, sha256: digest(a.sha256), size_bytes: integer(a.size_bytes, 1), content_type: 'image/png',
    width: 2048, height: 1152, resultRevision: digest(a.resultRevision), download_path: download }
}
/** Validate the original task projection without widening submission rights.
 * @param value - Authenticated task/channel response JSON.
 * @returns Original progress without any new generation permission.
 */
export function parseTask(value: unknown): ResearchTask {
  const t = exact(value, ['sequence', 'lease', 'stage', 'eventSequence', 'backendJobId', 'artifact', 'submission', 'expired'])
  const lease = parseLease(t.lease)
  if (typeof t.stage !== 'string' || !['leased', 'accepted', 'submitting', 'running', 'outcome_unknown', 'uploading', 'failed', 'cancelled', 'completed'].includes(t.stage)
    || typeof t.expired !== 'boolean' || t.submission !== 'not_claimed' && t.submission !== 'claimed') failure('RESEARCH_RESPONSE_INVALID')
  const artifact = t.artifact === null ? null : parseArtifact(t.artifact, lease)
  if (t.stage === 'completed' && artifact === null || artifact !== null && t.stage !== 'completed') failure('RESEARCH_RESPONSE_INVALID')
  return { sequence: integer(t.sequence, 1), lease, stage: t.stage as ResearchStage, eventSequence: integer(t.eventSequence),
    backendJobId: t.backendJobId === null ? null : identifier(t.backendJobId), artifact, submission: t.submission, expired: t.expired }
}
/** Encode immutable journal values with deterministic object key order.
 * @param value - Validated finite journal value.
 * @returns Stable JSON used to compare original assignments.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) => item !== null && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
}
