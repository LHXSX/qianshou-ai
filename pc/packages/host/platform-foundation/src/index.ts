/** Shared, transport-neutral platform records for the Qianshou host. */

import type { ComputeNodeId, NodeCapabilityAdvertisement } from '@deepseek-ai/dsh-compute-core/node-protocol'
import type { DeviceId } from '@deepseek-ai/dsh-host-remote-devices/protocol'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** Version stamped on events exchanged by platform adapters. */
export const PLATFORM_EVENT_VERSION = 'qianshou.platform.event.v1' as const

/** Maximum event data size accepted by the shared parser. */
export const MAX_PLATFORM_EVENT_BYTES = 256 * 1024

/** Agent, compute node or paired device identity already issued by its owner. */
export type PlatformIdentity =
  | { kind: 'agent'; id: SessionId }
  | { kind: 'node'; id: ComputeNodeId }
  | { kind: 'device'; id: DeviceId }

/** Runtime capability facts advertised by one participant. */
export interface PlatformCapabilityRecord extends NodeCapabilityAdvertisement {
  /** Whether this capability can accept another task now. */
  available: boolean
}

/** Registration input shared by host plugins that expose a participant. */
export interface PlatformParticipantRegistration {
  identity: PlatformIdentity
  agentVersion: string
  capabilities: readonly PlatformCapabilityRecord[]
  maxConcurrency: number
  runningTasks: number
  lastSeenAt: string
}

/** Immutable directory view; no credentials, paths or media bytes are retained. */
export interface PlatformParticipantSnapshot extends PlatformParticipantRegistration {
  key: string
}

/** Versioned control-plane event with bounded, JSON-safe data. */
export interface PlatformEventEnvelope {
  version: typeof PLATFORM_EVENT_VERSION
  eventId: string
  type: string
  source: PlatformIdentity
  sequence: number
  sentAt: string
  correlationId?: string
  data: unknown
}

/** Listener invoked after an event has passed parser validation. */
export type PlatformEventListener = (event: PlatformEventEnvelope) => void

/**
 * Register participants and publish validated events without selecting a transport.
 * The directory is process-local; a deployment may project its snapshots to a
 * durable store or control plane without changing plugin contracts.
 */
export class PlatformDirectory {
  private readonly participants = new Map<string, PlatformParticipantSnapshot>()
  private readonly revisions = new Map<string, object>()
  private readonly listeners = new Set<PlatformEventListener>()

  /**
   * Add or replace one participant and return an idempotent disposer.
   * @param registration - validated local facts owned by the caller.
   * @returns A disposer that removes only this registration revision.
   */
  register(registration: PlatformParticipantRegistration): () => void {
    validateRegistration(registration)
    const key = identityKey(registration.identity)
    const snapshot = freezeSnapshot({
      ...registration,
      capabilities: registration.capabilities.map(capability => ({ ...capability })),
    }, key)
    const revision = {}
    this.participants.set(key, snapshot)
    this.revisions.set(key, revision)
    return () => {
      if (this.revisions.get(key) === revision) {
        this.revisions.delete(key)
        this.participants.delete(key)
      }
    }
  }

  /**
   * Update liveness and capacity for an existing participant.
   * @param identity - participant identity previously registered.
   * @param heartbeat - latest bounded runtime facts.
   * @returns The new immutable snapshot.
   * @throws If the participant is unknown or the heartbeat is invalid.
   */
  heartbeat(identity: PlatformIdentity, heartbeat: Pick<PlatformParticipantRegistration, 'capabilities' | 'maxConcurrency' | 'runningTasks' | 'lastSeenAt'>): PlatformParticipantSnapshot {
    const key = identityKey(identity)
    const existing = this.participants.get(key)
    if (!existing) throw new Error('PLATFORM_PARTICIPANT_NOT_FOUND')
    validateHeartbeat(heartbeat)
    const next = freezeSnapshot({
      ...existing,
      capabilities: heartbeat.capabilities.map(capability => ({ ...capability })),
      maxConcurrency: heartbeat.maxConcurrency,
      runningTasks: heartbeat.runningTasks,
      lastSeenAt: heartbeat.lastSeenAt,
    }, key)
    this.participants.set(key, next)
    return next
  }

  /** @returns Deeply copied participant snapshots in registration order. */
  snapshot(): PlatformParticipantSnapshot[] {
    return structuredClone([...this.participants.values()])
  }

  /**
   * Subscribe to validated events.
   * @param listener - synchronous observer; exceptions are isolated per listener.
   * @returns A disposer for the subscription.
   */
  onEvent(listener: PlatformEventListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Validate and publish an event to current listeners.
   * @param value - untrusted transport-decoded event.
   * @returns The frozen parsed event.
   * @throws If the event envelope or data exceeds its bounds.
   */
  publish(value: unknown): PlatformEventEnvelope {
    const event = parsePlatformEvent(value)
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* Observers cannot block the control plane. */ }
    }
    return event
  }
}

/** Parse a transport value at the shared event boundary. */
export function parsePlatformEvent(value: unknown): PlatformEventEnvelope {
  const item = record(value)
  if (item.version !== PLATFORM_EVENT_VERSION || !boundedId(item.eventId) || !boundedId(item.type)) throw new Error('PLATFORM_EVENT_INVALID')
  const sequence = item.sequence
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 0) throw new Error('PLATFORM_EVENT_INVALID')
  const sentAt = item.sentAt
  if (typeof sentAt !== 'string' || !isTimestamp(sentAt)) throw new Error('PLATFORM_EVENT_INVALID')
  const source = parseIdentity(item.source)
  const correlationId = item.correlationId
  if (correlationId !== undefined && !boundedId(correlationId)) throw new Error('PLATFORM_EVENT_INVALID')
  const data = item.data
  if (!isJsonSafe(data)) throw new Error('PLATFORM_EVENT_INVALID')
  let bytes: number
  try { bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength } catch { throw new Error('PLATFORM_EVENT_INVALID') }
  if (bytes > MAX_PLATFORM_EVENT_BYTES) throw new Error('PLATFORM_EVENT_DATA_TOO_LARGE')
  const event = {
    version: PLATFORM_EVENT_VERSION,
    eventId: item.eventId,
    type: item.type,
    source,
    sequence: sequence as number,
    sentAt,
    ...(correlationId === undefined ? {} : { correlationId }),
    data: structuredClone(data),
  }
  return Object.freeze(event)
}

/** Convert a node heartbeat's issued id into a platform registration. */
export function registrationFromNodeHeartbeat(heartbeat: {
  nodeId: ComputeNodeId
  agentVersion: string
  sentAt: string
  capabilities: readonly NodeCapabilityAdvertisement[]
  maxConcurrency: number
  runningTasks: number
}): PlatformParticipantRegistration {
  const registration: PlatformParticipantRegistration = { identity: { kind: 'node', id: heartbeat.nodeId }, agentVersion: heartbeat.agentVersion, capabilities: heartbeat.capabilities.map(capability => ({ ...capability, available: heartbeat.runningTasks < heartbeat.maxConcurrency })), maxConcurrency: heartbeat.maxConcurrency, runningTasks: heartbeat.runningTasks, lastSeenAt: heartbeat.sentAt }
  validateRegistration(registration)
  return registration
}

function validateRegistration(registration: PlatformParticipantRegistration): void {
  parseIdentity(registration.identity)
  if (!boundedId(registration.agentVersion)) throw new Error('PLATFORM_REGISTRATION_INVALID')
  validateHeartbeat(registration)
}

function validateHeartbeat(heartbeat: Pick<PlatformParticipantRegistration, 'capabilities' | 'maxConcurrency' | 'runningTasks' | 'lastSeenAt'>): void {
  if (!Number.isSafeInteger(heartbeat.maxConcurrency) || heartbeat.maxConcurrency < 1 || heartbeat.maxConcurrency > 4096 || !Number.isSafeInteger(heartbeat.runningTasks) || heartbeat.runningTasks < 0 || heartbeat.runningTasks > heartbeat.maxConcurrency || !isTimestamp(heartbeat.lastSeenAt) || heartbeat.capabilities.length > 256) throw new Error('PLATFORM_REGISTRATION_INVALID')
  const keys = new Set<string>()
  for (const capability of heartbeat.capabilities) {
    if (!boundedId(capability.capabilityId) || !boundedId(capability.version) || !/^[a-f0-9]{64}$/u.test(capability.pluginDigest) || typeof capability.available !== 'boolean') throw new Error('PLATFORM_REGISTRATION_INVALID')
    const key = `${capability.capabilityId}\u0000${capability.version}`
    if (keys.has(key)) throw new Error('PLATFORM_REGISTRATION_INVALID')
    keys.add(key)
  }
}

function parseIdentity(value: unknown): PlatformIdentity {
  const item = record(value)
  if (item.kind !== 'agent' && item.kind !== 'node' && item.kind !== 'device') throw new Error('PLATFORM_IDENTITY_INVALID')
  if (!boundedId(item.id)) throw new Error('PLATFORM_IDENTITY_INVALID')
  return { kind: item.kind, id: item.id } as PlatformIdentity
}

function identityKey(identity: PlatformIdentity): string {
  parseIdentity(identity)
  return `${identity.kind}\u0000${identity.id}`
}
function boundedId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._:-]{1,256}$/u.test(value)
}
function isTimestamp(value: string): boolean {
  const parsed = new Date(value)
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('PLATFORM_EVENT_INVALID')
  return value as Record<string, unknown>
}
function isJsonSafe(value: unknown, depth = 0): boolean {
  if (depth > 100) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(item => isJsonSafe(item, depth + 1))
  if (typeof value !== 'object') return false
  const prototype = Reflect.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  return Object.entries(value).every(([key, item]) => key.length <= 256 && !key.includes('\0') && isJsonSafe(item, depth + 1))
}
function freezeSnapshot(value: Omit<PlatformParticipantSnapshot, 'key'>, key: string): PlatformParticipantSnapshot {
  return Object.freeze({
    ...value,
    key,
    capabilities: Object.freeze(value.capabilities.map(capability => Object.freeze({ ...capability }))),
  })
}
