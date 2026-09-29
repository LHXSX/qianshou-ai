import type { ComputeCapability, ComputeConnectionState, ComputePlanDraft, ComputePlanRequest } from '@deepseek-ai/dsh-compute-core/protocol'

/** Narrow values crossing the Host Fetch boundary before publishing them. */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 && !value.includes('\0') }
function identity(value: unknown): value is string {
  return text(value) && value.length <= 128 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
}
function timestamp(value: unknown): value is string {
  if (!text(value) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false
  const date = new Date(value)
  return Number.isFinite(date.getTime()) && date.toISOString() === value
}
function fail(): never { throw new Error('INVALID_COMPUTE_RESPONSE') }
function validRequest(value: unknown): value is ComputePlanRequest {
  return record(value) && identity(value.capabilityId) && text(value.goal) && value.goal.length <= 8000
    && value.currency === 'CNY' && Number.isSafeInteger(value.budgetMinor) && Number(value.budgetMinor) >= 0
    && (value.maxNodes === null || (Number.isInteger(value.maxNodes) && Number(value.maxNodes) >= 1 && Number(value.maxNodes) <= 64))
}
function validAuthorization(value: unknown): value is ComputePlanDraft['authorization'] {
  return value === 'pending' || value === 'approved' || value === 'declined'
}
/** Parse connection facts; configuration does not imply authentication succeeded. */
export function parseConnection(value: unknown): ComputeConnectionState {
  if (!record(value) || typeof value.configured !== 'boolean' || !text(value.message) || !record(value.capabilities)
    || !['workloadRead', 'quoting', 'submission'].every(key => typeof value.capabilities === 'object'
      && value.capabilities !== null && typeof (value.capabilities as Record<string, unknown>)[key] === 'boolean')) fail()
  return value as unknown as ComputeConnectionState
}
/** Reject a malformed catalog atomically instead of treating unknown values as executable. */
export function parseCapabilities(value: unknown): ComputeCapability[] {
  if (!Array.isArray(value) || value.some(item => !record(item) || !identity(item.id) || !text(item.name)
    || typeof item.description !== 'string' || !['remote', 'local', 'contributor'].includes(String(item.delivery))
    || typeof item.available !== 'boolean' || (item.unavailableReason !== undefined && typeof item.unavailableReason !== 'string'))
    || new Set(value.map(item => (item as ComputeCapability).id)).size !== value.length) fail()
  return value as ComputeCapability[]
}
function validWorkloadId(value: unknown): value is string | null {
  return value === undefined || value === null || identity(value)
}
/** Accept only drafts with no quote; this page has no priced offer. */
export function parseDraft(value: unknown): ComputePlanDraft {
  if (!record(value) || !identity(value.id) || value.status !== 'draft' || value.quote !== null
    || !validRequest(value.request) || !timestamp(value.createdAt)
    || !validAuthorization(value.authorization) || !text(value.reason) || !validWorkloadId(value.workloadId)) fail()
  return { ...value, workloadId: value.workloadId ?? null } as unknown as ComputePlanDraft
}
/** Read persisted drafts from the Host without inferring completion or current capability readiness. */
export function parseDrafts(value: unknown): ComputePlanDraft[] {
  if (!Array.isArray(value)) fail()
  const drafts = value.map(parseDraft)
  if (new Set(drafts.map(draft => draft.id)).size !== drafts.length) fail()
  return drafts
}
/** Extract structured Host errors without rendering objects or raw HTML as status. */
export function hostError(value: unknown, status: number): Error {
  if (record(value) && record(value.error) && text(value.error.code) && text(value.error.message)) {
    const error = new Error(value.error.message)
    error.name = value.error.code
    return error
  }
  const error = new Error(`HTTP_${status}`)
  error.name = status === 401 || status === 403 ? 'AUTH_REQUIRED' : 'REQUEST_FAILED'
  return error
}
