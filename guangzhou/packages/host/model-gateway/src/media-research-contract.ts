/** Closed, non-billable research control messages. No price, media bytes or local endpoint is accepted. */
import { MediaNodeError, mediaNodeId, mediaNodeInteger } from './media-node-store.ts'

export interface ResearchMediaLeaseRequest {
  schema: 'qianshou.research-media-lease.v1'; requestId: string; taskId: string; attemptId: string
  accountId: number; deviceId: string; connectionEpoch: number; leaseEpoch: 1; leaseExpiresAt: string
  mode: 'image'; adapter: string; modelId: string; workflowId: string; input: { prompt: string }
}
export interface ResearchMediaLease extends ResearchMediaLeaseRequest { observationRevision: string; non_billable: true }
export interface ResearchTaskRow {
  sequence: number; task_id: string; attempt_id: string; request_id: string; device_id: string
  owner_id: string; assignment_epoch: number; expires_at: number; submitted: string; payload: string
  stage: string; event_sequence: number; claimed_at: number; backend_job_id: string | null
}
export const researchTerminal = new Set(['failed', 'cancelled', 'completed'])
/** Resource observations expire independently of API identity and probe confirmation. */
export const RESEARCH_EXECUTION_TTL_MS = 15_000
/** Server-stamped research resources; activeTasks counts persisted reservations, not a node assertion. */
export interface ResearchNodeExecution {
  schema: 'qianshou.research-node-execution.v1'; observedAt: string; connectionEpoch: number
  observationRevision: string; idle: boolean | null; resourceAllowed: boolean | null
  activeTasks: number; slotCount: 1
}
export function researchExact(value: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(value).length !== fields.length || Object.keys(value).some(k => !fields.includes(k))) throw new MediaNodeError('RESEARCH_MESSAGE_INVALID')
}
export function researchUuid(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)) throw new MediaNodeError('RESEARCH_IDENTIFIER_INVALID')
  return value
}
export function researchIdentity(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.+-]{0,127}$/u.test(value) || value.includes('..')) throw new MediaNodeError('RESEARCH_IDENTITY_INVALID')
  return value
}
export function parseResearchLease(p: Record<string, unknown>): ResearchMediaLeaseRequest {
  researchExact(p, ['schema', 'requestId', 'taskId', 'attemptId', 'accountId', 'deviceId', 'connectionEpoch', 'leaseEpoch', 'leaseExpiresAt', 'mode', 'adapter', 'modelId', 'workflowId', 'input'])
  if (p['schema'] !== 'qianshou.research-media-lease.v1' || p['mode'] !== 'image' || p['leaseEpoch'] !== 1
    || typeof p['leaseExpiresAt'] !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/u.test(p['leaseExpiresAt']) || !Number.isFinite(Date.parse(p['leaseExpiresAt']))) throw new MediaNodeError('RESEARCH_LEASE_INVALID')
  const input = p['input']
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new MediaNodeError('RESEARCH_INPUT_INVALID')
  const i = input as Record<string, unknown>; researchExact(i, ['prompt'])
  if (typeof i['prompt'] !== 'string' || i['prompt'].trim().length === 0 || Buffer.byteLength(i['prompt']) > 8192 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(i['prompt'])) throw new MediaNodeError('RESEARCH_INPUT_INVALID')
  return { schema: 'qianshou.research-media-lease.v1', requestId: researchUuid(p['requestId']), taskId: researchUuid(p['taskId']), attemptId: researchUuid(p['attemptId']),
    accountId: mediaNodeInteger(p['accountId'], Number.MAX_SAFE_INTEGER, 1), deviceId: mediaNodeId(p['deviceId']), connectionEpoch: mediaNodeInteger(p['connectionEpoch'], Number.MAX_SAFE_INTEGER, 1),
    leaseEpoch: 1, leaseExpiresAt: p['leaseExpiresAt'], mode: 'image', adapter: researchIdentity(p['adapter']), modelId: researchIdentity(p['modelId']), workflowId: researchIdentity(p['workflowId']), input: { prompt: i['prompt'] } }
}
