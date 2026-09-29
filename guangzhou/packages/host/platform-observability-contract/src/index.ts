/** Provider-neutral mobile sync and bounded observability contracts. */
import type { PlatformCapabilityRecord, PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'

export const MOBILE_SYNC_VERSION = 'qianshou.mobile.sync.v1' as const
export const OBSERVABILITY_EVENT_VERSION = 'qianshou.observability.event.v1' as const
export const MAX_OBSERVABILITY_ATTRIBUTES = 64
export const MAX_OBSERVABILITY_BYTES = 64 * 1024

export type ClientPlatform = 'ios' | 'android' | 'desktop' | 'web'
export type SurfaceState = 'foreground' | 'background' | 'suspended'
/** Policy-owned autonomous acceptance state; no human prompt is implied by this record. */
export type TaskAcceptanceMode = 'autonomous' | 'policy-paused' | 'policy-reject'

export interface MobileCapabilityHeartbeat {
  version: typeof MOBILE_SYNC_VERSION
  identity: PlatformIdentity
  platform: ClientPlatform
  agentVersion: string
  sequence: number
  sentAt: string
  surface: SurfaceState
  acceptance: TaskAcceptanceMode
  capabilities: readonly PlatformCapabilityRecord[]
  maxConcurrency: number
  runningTasks: number
  cursor: string
}

export interface MobileSyncRequest {
  version: typeof MOBILE_SYNC_VERSION
  identity: PlatformIdentity
  cursor: string
  limit: number
}

export interface MobileSyncAck {
  version: typeof MOBILE_SYNC_VERSION
  identity: PlatformIdentity
  cursor: string
  revision: number
  heartbeat: MobileCapabilityHeartbeat
}

/** Parse a sync acknowledgement before a client publishes its cursor. */
export function parseMobileSyncAck(value: unknown): MobileSyncAck {
  const item = record(value)
  if (item.version !== MOBILE_SYNC_VERSION || !identity(item.identity) || !bounded(item.cursor)
    || !integer(item.revision, 0, Number.MAX_SAFE_INTEGER)) throw new Error('MOBILE_SYNC_ACK_INVALID')
  const heartbeat = parseMobileCapabilityHeartbeat(item.heartbeat)
  return Object.freeze({
    version: MOBILE_SYNC_VERSION, identity: item.identity, cursor: item.cursor,
    revision: item.revision, heartbeat,
  })
}

export type ObservabilitySeverity = 'debug' | 'info' | 'warn' | 'error'
export interface ObservabilityEvent {
  version: typeof OBSERVABILITY_EVENT_VERSION
  eventId: string
  type: string
  severity: ObservabilitySeverity
  source: PlatformIdentity
  occurredAt: string
  correlationId?: string
  attributes: Readonly<Record<string, string | number | boolean | null>>
}

export function parseMobileCapabilityHeartbeat(value: unknown): MobileCapabilityHeartbeat {
  const item = record(value)
  if (
    item.version !== MOBILE_SYNC_VERSION || !identity(item.identity) || !platform(item.platform)
    || !bounded(item.agentVersion) || !bounded(item.cursor) || !timestamp(item.sentAt)
    || !surface(item.surface) || !acceptance(item.acceptance)
  ) throw new Error('MOBILE_HEARTBEAT_INVALID')
  if (
    !integer(item.sequence, 0, Number.MAX_SAFE_INTEGER) || !integer(item.maxConcurrency, 1, 4096)
    || !integer(item.runningTasks, 0, item.maxConcurrency) || !Array.isArray(item.capabilities)
    || item.capabilities.length > 256
  ) throw new Error('MOBILE_HEARTBEAT_INVALID')
  const capabilities = item.capabilities.map(parseCapability)
  const keys = new Set<string>()
  for (const capability of capabilities) {
    const key = capability.capabilityId + '\u0000' + capability.version
    if (keys.has(key)) throw new Error('MOBILE_HEARTBEAT_INVALID')
    keys.add(key)
  }
  const heartbeat: MobileCapabilityHeartbeat = {
    version: MOBILE_SYNC_VERSION, identity: item.identity, platform: item.platform,
    agentVersion: item.agentVersion, sequence: item.sequence, sentAt: item.sentAt, surface: item.surface,
    acceptance: item.acceptance, capabilities: Object.freeze(capabilities), maxConcurrency: item.maxConcurrency,
    runningTasks: item.runningTasks, cursor: item.cursor,
  }
  return Object.freeze(heartbeat)
}

export function parseMobileSyncRequest(value: unknown): MobileSyncRequest {
  const item = record(value)
  if (item.version !== MOBILE_SYNC_VERSION || !identity(item.identity) || !bounded(item.cursor) || !integer(item.limit, 1, 256)) {
    throw new Error('MOBILE_SYNC_REQUEST_INVALID')
  }
  return Object.freeze({
    version: MOBILE_SYNC_VERSION, identity: item.identity, cursor: item.cursor, limit: item.limit,
  })
}

export function parseObservabilityEvent(value: unknown): ObservabilityEvent {
  const item = record(value)
  if (
    item.version !== OBSERVABILITY_EVENT_VERSION || !bounded(item.eventId) || !bounded(item.type)
    || !severity(item.severity) || !identity(item.source) || !timestamp(item.occurredAt)
  ) {
    throw new Error('OBSERVABILITY_EVENT_INVALID')
  }
  if (item.correlationId !== undefined && !bounded(item.correlationId)) throw new Error('OBSERVABILITY_EVENT_INVALID')
  const attrs = item.attributes
  if (!isRecord(attrs) || Object.keys(attrs).length > MAX_OBSERVABILITY_ATTRIBUTES
    || !Object.entries(attrs).every(([key, value]) => safeKey(key) && scalar(value))) {
    throw new Error('OBSERVABILITY_EVENT_INVALID')
  }
  const bytes = new TextEncoder().encode(JSON.stringify(attrs)).byteLength
  if (bytes > MAX_OBSERVABILITY_BYTES) throw new Error('OBSERVABILITY_EVENT_TOO_LARGE')
  const attributes = Object.freeze({ ...attrs }) as Readonly<Record<string, string | number | boolean | null>>
  const event: ObservabilityEvent = {
    version: OBSERVABILITY_EVENT_VERSION, eventId: item.eventId, type: item.type, severity: item.severity,
    source: item.source, occurredAt: item.occurredAt,
    ...(item.correlationId === undefined ? {} : { correlationId: item.correlationId }), attributes,
  }
  return Object.freeze(event)
}

function parseCapability(value: unknown): PlatformCapabilityRecord {
  const item = record(value)
  if (!bounded(item.capabilityId) || !bounded(item.version) || typeof item.pluginDigest !== 'string'
    || !/^[a-f0-9]{64}$/u.test(item.pluginDigest) || typeof item.available !== 'boolean') {
    throw new Error('MOBILE_HEARTBEAT_INVALID')
  }
  return { capabilityId: item.capabilityId as PlatformCapabilityRecord['capabilityId'], version: item.version, pluginDigest: item.pluginDigest, available: item.available }
}
function identity(value: unknown): value is PlatformIdentity {
  const item = record(value)
  return (item.kind === 'agent' || item.kind === 'node' || item.kind === 'device') && bounded(item.id)
}
function platform(value: unknown): value is ClientPlatform { return value === 'ios' || value === 'android' || value === 'desktop' || value === 'web' }
function surface(value: unknown): value is SurfaceState { return value === 'foreground' || value === 'background' || value === 'suspended' }
function acceptance(value: unknown): value is TaskAcceptanceMode { return value === 'autonomous' || value === 'policy-paused' || value === 'policy-reject' }
function severity(value: unknown): value is ObservabilitySeverity { return value === 'debug' || value === 'info' || value === 'warn' || value === 'error' }
function timestamp(value: unknown): value is string { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value }
function bounded(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/u.test(value) }
function integer(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max }
function safeKey(value: string): boolean {
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(value)
    && !/(?:token|secret|password|credential|path|media|blob|content)/iu.test(value)
}
function scalar(value: unknown): value is string | number | boolean | null { return value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)) }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {} }
