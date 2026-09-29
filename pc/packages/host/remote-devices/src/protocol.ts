/** Versioned device wire types; all untrusted frames enter through explicit parsers. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Coordinator-issued persistent paired-device identity. */
export type DeviceId = Branded<'qianshou-device-id'>
/** Coordinator-issued task identity used for receipts and cancellation. */
export type JobId = Branded<'qianshou-job-id'>
/** Peer-advertised identity for a locally approved directory. */
export type WorkspaceId = Branded<'qianshou-workspace-id'>
/** Native companion WebSocket upgrade route; it does not carry browser session credentials. */
export const DEVICE_PATH = '/qianshou-device'
/** Maximum serialized device transport frame size in bytes. */
export const MAX_FRAME_BYTES = 1_100_000
/** Maximum UTF-8 content bytes in a remote file task. */
export const MAX_FILE_BYTES = 512_000
/** Maximum retained command-output characters in a task receipt. */
export const MAX_OUTPUT_CHARS = 100_000
/** Finite remotely executable operations, each requiring companion approval. */
export const JOB_KINDS = ['command', 'read', 'write', 'list', 'desktop'] as const
/** Operation selected from the finite task protocol. */
export type JobKind = typeof JOB_KINDS[number]
/** Task receipt state; accepting a request does not imply successful execution. */
export type JobStatus = 'awaiting-approval' | 'running' | 'completed' | 'failed' | 'rejected' | 'cancelled' | 'interrupted'
/** A directory approved by the peer; its path is metadata, not a coordinator filesystem path. */
export interface RemoteWorkspace { id: WorkspaceId; name: string; path: string }
/** Public paired-device metadata safe for browser and model listings. */
export interface DeviceInfo {
  id: DeviceId; name: string; platform: string; arch: string
  workspaces: RemoteWorkspace[]; connected: boolean; lastSeen: string; pairedAt: string
}
/** Retained task request and actual peer receipt, including requested versus confirmed cancellation. */
export interface RemoteJob {
  id: JobId; deviceId: DeviceId; workspaceId: WorkspaceId; kind: JobKind
  payload: Record<string, string>; status: JobStatus; createdAt: string; updatedAt: string
  output: string; error?: string; result?: unknown; cancelRequested?: boolean
}
/** Peer-supplied display, platform and workspace metadata validated during authentication. */
export interface DeviceHello { name: string; platform: string; arch: string; workspaces: RemoteWorkspace[] }
/** Untrusted typed frame envelope whose remaining fields require operation-specific parsing. */
export interface ClientFrame { type: string; [key: string]: unknown }

/**
 * Require a non-array record at a device or browser input boundary.
 * @param value - Untrusted parsed JSON value.
 * @returns The record without copying or validating its fields.
 * @throws INVALID_MESSAGE for null, arrays or non-object values.
 */
export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('INVALID_MESSAGE')
  return value as Record<string, unknown>
}

/**
 * Validate a required nonempty string at a wire boundary.
 * @param value - Untrusted field value.
 * @param max - Maximum character count, defaulting to 200.
 * @returns The original string, without trimming or normalization.
 * @throws INVALID_FIELD for empty, overlong, non-string or NUL-containing values.
 */
export function textField(value: unknown, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw new Error('INVALID_FIELD')
  return value
}

/**
 * Parse peer metadata without trusting paths as coordinator filesystem locations.
 * @param value - Untrusted peer hello record.
 * @returns Validated display metadata and up to twenty uniquely identified workspaces.
 * @throws On invalid fields, duplicate workspace IDs or an invalid workspace collection.
 */
export function parseHello(value: unknown): DeviceHello {
  const item = record(value)
  if (!Array.isArray(item.workspaces) || item.workspaces.length > 20) throw new Error('INVALID_WORKSPACES')
  const seen = new Set<string>()
  const workspaces = item.workspaces.map(raw => {
    const workspace = record(raw)
    const id = textField(workspace.id, 100) as WorkspaceId
    if (seen.has(id)) throw new Error('DUPLICATE_WORKSPACE')
    seen.add(id)
    return { id, name: textField(workspace.name), path: textField(workspace.path, 4096) }
  })
  return { name: textField(item.name), platform: textField(item.platform, 50), arch: textField(item.arch, 50), workspaces }
}

/**
 * Parse the finite job request; only its own peer resolves the workspace.
 * @param value - Untrusted request with device, workspace, operation and payload.
 * @returns A bounded request containing only fields required by its selected operation.
 * @throws On unsupported operations, invalid fields or excessive payload/file bytes.
 */
export function parseJobRequest(value: unknown): Pick<RemoteJob, 'deviceId' | 'workspaceId' | 'kind' | 'payload'> {
  const item = record(value)
  if (!JOB_KINDS.includes(item.kind as JobKind)) throw new Error('INVALID_JOB_KIND')
  const kind = item.kind as JobKind
  const raw = record(item.payload)
  const payload: Record<string, string> = {}
  if (kind === 'command') payload.command = textField(raw.command, 16_000)
  if (kind === 'read' || kind === 'write' || kind === 'list') payload.path = textField(raw.path, 4096)
  if (kind === 'write') {
    if (typeof raw.content !== 'string' || Buffer.byteLength(raw.content) > MAX_FILE_BYTES) throw new Error('FILE_TOO_LARGE')
    payload.content = raw.content
  }
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_FRAME_BYTES - 8192) throw new Error('PAYLOAD_TOO_LARGE')
  return { deviceId: textField(item.deviceId, 100) as DeviceId, workspaceId: textField(item.workspaceId, 100) as WorkspaceId, kind, payload }
}

/**
 * Classify states that cannot accept replayed execution updates.
 * @param status - Valid task receipt state.
 * @returns Whether the receipt is completed, failed, rejected, cancelled or interrupted.
 */
export function isTerminal(status: JobStatus): boolean {
  return ['completed', 'failed', 'rejected', 'cancelled', 'interrupted'].includes(status)
}
