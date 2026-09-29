/** Provider-neutral mobile agent shell for OS adapters and control-plane clients. */
import type { AuthorizationMethod, AuthorizationOutcome } from '@deepseek-ai/dsh-authorization/types'
import {
  MOBILE_SYNC_VERSION,
  parseMobileSyncAck,
  type MobileCapabilityHeartbeat,
  type MobileSyncAck,
  type MobileSyncRequest,
  type SurfaceState,
  type TaskAcceptanceMode,
} from '@deepseek-ai/dsh-host-platform-observability-contract'
import type { PlatformCapabilityRecord, PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'
import { parseComputeTaskCard, type ComputeTaskCard } from '@deepseek-ai/dsh-client-ui-compute/client/status-card'
import { MOBILE_SYNC_INITIAL_STATE, type MobileSyncStatePort } from './sync-state.ts'

export { MOBILE_SYNC_INITIAL_STATE, parseMobileSyncState, type MobileSyncState, type MobileSyncStatePort } from './sync-state.ts'
export { IndexedDbMobileSyncState } from './indexeddb-sync-state.ts'
export { MOBILE_SYNC_PATH, createMobileHttpSyncPort, type MobileHttpSyncPortOptions, type MobileSyncWireRequest } from './http-sync-port.ts'

/** Authentication state exposed by a mobile adapter without exposing credentials. */
export type MobileAuthState = 'signed-out' | 'authorizing' | 'authenticated' | 'expired'

/** The login/logout operations supplied by a native or browser host. */
export interface MobileAuthPort {
  /** Available user-facing methods, ordered by the host's preference. */
  readonly methods: readonly AuthorizationMethod[]
  /** Return the current non-secret authentication state. */
  readonly state: () => MobileAuthState
  /** Start one user-authorized attempt; the shell does not persist its result. */
  readonly begin: (request?: { method?: string; signal?: AbortSignal }) => Promise<AuthorizationOutcome>
  /** Invalidate the host's current session. */
  readonly logout: () => Promise<void>
}

/** Transport owned by the embedding app; this method is metadata sync only. */
export interface MobileAgentSyncPort {
  /** Send one authenticated cursor request and its current capability heartbeat. */
  readonly sync: (request: MobileSyncRequest, heartbeat: MobileCapabilityHeartbeat) => Promise<unknown>
}

/** Explicit policy for unattended task-card handling on one device. */
export interface MobileAcceptancePolicy {
  /** Allow the scheduler to consider this device for policy-approved offers. */
  readonly enabled: boolean
  /** Require the app to be visible before accepting an offer. */
  readonly requireForeground: boolean
  /** Upper bound owned by this shell; the scheduler remains authoritative. */
  readonly maxConcurrentTasks: number
  /** Permit cards without a quote only when the deployment has made that policy explicit. */
  readonly acceptWithoutQuote: boolean
}

/** Inputs required to create one shell; all tunables are explicit. */
export interface MobileAgentShellOptions {
  readonly identity: PlatformIdentity
  readonly platform: 'ios' | 'android' | 'desktop' | 'web'
  readonly agentVersion: string
  readonly maxConcurrency: number
  readonly auth: MobileAuthPort
  readonly capabilities: () => readonly PlatformCapabilityRecord[]
  readonly sync: MobileAgentSyncPort
  readonly policy: MobileAcceptancePolicy
  /** Durable cursor storage supplied by the embedding application; without it state is process-local. */
  readonly state?: MobileSyncStatePort
  readonly now?: () => string
}

/** Result of evaluating one received task card against local policy and facts. */
export interface MobileTaskDecision {
  readonly cardId: string
  readonly disposition: 'accept' | 'hold' | 'reject'
  readonly reason:
    | 'accepted'
    | 'policy-disabled'
    | 'offline'
    | 'suspended'
    | 'background'
    | 'auth-required'
    | 'at-capacity'
    | 'capability-unavailable'
    | 'quote-required'
    | 'quote-expired'
    | 'authorization-required'
    | 'submission-not-ready'
    | 'card-not-actionable'
}

/** Read-only shell projection suitable for a status card or native bridge. */
export interface MobileAgentShellSnapshot {
  readonly version: typeof MOBILE_SYNC_VERSION
  readonly identity: PlatformIdentity
  readonly platform: MobileAgentShellOptions['platform']
  readonly surface: SurfaceState
  readonly online: boolean
  readonly sequence: number
  readonly cursor: string
  readonly runningTasks: number
  readonly lastSyncRevision: number | null
  readonly lastCard: ComputeTaskCard | null
  readonly lastDecision: MobileTaskDecision | null
}

/**
 * Owns client-side mobile lifecycle facts and task-card policy evaluation.
 * The shell never opens a push channel, submits work, transfers media, or
 * grants entitlements; those actions remain in the supplied adapters.
 */
export class MobileAgentShell {
  private readonly options: MobileAgentShellOptions
  private surface: SurfaceState = 'foreground'
  private online = true
  private sequence = 0
  private cursor = 'start'
  private runningTasks = 0
  private lastSyncRevision: number | null = null
  private lastCard: ComputeTaskCard | null = null
  private lastDecision: MobileTaskDecision | null = null

  constructor(options: MobileAgentShellOptions) {
    validateOptions(options)
    this.options = options
    const restored = options.state?.snapshot() ?? MOBILE_SYNC_INITIAL_STATE
    this.cursor = restored.cursor
    this.sequence = restored.sequence
    this.lastSyncRevision = restored.lastSyncRevision
  }

  /** Return the current immutable projection for a native or UI renderer. */
  snapshot(): MobileAgentShellSnapshot {
    return Object.freeze({
      version: MOBILE_SYNC_VERSION, identity: this.options.identity, platform: this.options.platform,
      surface: this.surface, online: this.online, sequence: this.sequence, cursor: this.cursor,
      runningTasks: this.runningTasks, lastSyncRevision: this.lastSyncRevision,
      lastCard: this.lastCard, lastDecision: this.lastDecision,
    })
  }

  /** Update OS visibility state; the next heartbeat carries the result. */
  setSurface(surface: SurfaceState): void {
    this.surface = surface
  }

  /** Update reachability reported by the embedding app. */
  setOnline(online: boolean): void {
    this.online = online
  }

  /** Record scheduler-visible work owned by this shell without executing it. */
  markTaskStarted(): void {
    if (this.runningTasks >= this.options.policy.maxConcurrentTasks) throw new Error('MOBILE_TASK_CAPACITY_REACHED')
    this.runningTasks += 1
  }

  /** Release one shell-owned task slot after the scheduler reports completion. */
  markTaskFinished(): void {
    if (this.runningTasks === 0) throw new Error('MOBILE_TASK_NOT_RUNNING')
    this.runningTasks -= 1
  }

  /** Build one bounded heartbeat; no transport call occurs here. */
  createHeartbeat(): MobileCapabilityHeartbeat {
    this.sequence += 1
    const heartbeat: MobileCapabilityHeartbeat = {
      version: MOBILE_SYNC_VERSION, identity: this.options.identity, platform: this.options.platform,
      agentVersion: this.options.agentVersion, sequence: this.sequence,
      sentAt: this.now(), surface: this.surface, acceptance: this.acceptanceMode(),
      capabilities: this.options.capabilities(), maxConcurrency: this.options.maxConcurrency,
      runningTasks: this.runningTasks, cursor: this.cursor,
    }
    return Object.freeze({
      ...heartbeat,
      capabilities: Object.freeze(heartbeat.capabilities.map(capability => Object.freeze({ ...capability }))),
    })
  }

  /** Sync one cursor page through the embedding transport and commit its ack.
   *
   * A refused or stale acknowledgement never advances local state and is never
   * persisted, so a reload can only resume from progress the server actually
   * confirmed. Durable write failures surface to the caller instead of being dropped.
   */
  async sync(limit: number): Promise<MobileSyncAck> {
    if (this.options.auth.state() !== 'authenticated') throw new Error('MOBILE_AUTH_REQUIRED')
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error('MOBILE_SYNC_LIMIT_INVALID')
    const heartbeat = this.createHeartbeat()
    const request: MobileSyncRequest = { version: MOBILE_SYNC_VERSION, identity: this.options.identity, cursor: this.cursor, limit }
    const ack = parseMobileSyncAck(await this.options.sync.sync(request, heartbeat))
    if (!sameIdentity(ack.identity, this.options.identity) || ack.heartbeat.sequence < heartbeat.sequence
      || (this.lastSyncRevision !== null && ack.revision < this.lastSyncRevision)) throw new Error('MOBILE_SYNC_ACK_STALE')
    this.cursor = ack.cursor
    this.lastSyncRevision = ack.revision
    this.runningTasks = ack.heartbeat.runningTasks
    this.sequence = ack.heartbeat.sequence
    if (this.options.state !== undefined) {
      await this.options.state.save(Object.freeze({ cursor: this.cursor, lastSyncRevision: this.lastSyncRevision, sequence: this.sequence }))
    }
    return ack
  }

  /** Parse and evaluate one event-delivered or cached task card. */
  receiveTaskCard(value: unknown): MobileTaskDecision {
    const card = parseComputeTaskCard(value)
    const decision = this.decide(card)
    this.lastCard = card
    this.lastDecision = decision
    return decision
  }

  /** Evaluate a valid task card without mutating shell state. */
  decide(card: ComputeTaskCard): MobileTaskDecision {
    const result = (disposition: MobileTaskDecision['disposition'], reason: MobileTaskDecision['reason']): MobileTaskDecision => Object.freeze({ cardId: card.cardId, disposition, reason })
    if (!this.options.policy.enabled) return result('reject', 'policy-disabled')
    if (!this.online) return result('hold', 'offline')
    if (this.surface === 'suspended') return result('hold', 'suspended')
    if (this.options.policy.requireForeground && this.surface !== 'foreground') return result('hold', 'background')
    if (this.options.auth.state() !== 'authenticated') return result('hold', 'auth-required')
    if (this.runningTasks >= this.options.policy.maxConcurrentTasks) return result('hold', 'at-capacity')
    if (card.error || card.phase === 'completed' || card.phase === 'error') return result('reject', 'card-not-actionable')
    if (card.capability.availability !== 'available') return result('hold', 'capability-unavailable')
    if (card.quote.status === 'expired') return result('hold', 'quote-expired')
    if (card.quote.status === 'none' && !this.options.policy.acceptWithoutQuote) return result('hold', 'quote-required')
    if (card.quote.status === 'available' && card.authorization !== 'approved') return result('hold', 'authorization-required')
    if (card.submission !== 'ready') return result('hold', 'submission-not-ready')
    return result('accept', 'accepted')
  }

  private acceptanceMode(): TaskAcceptanceMode {
    return this.options.policy.enabled && this.online && this.surface !== 'suspended'
      && (!this.options.policy.requireForeground || this.surface === 'foreground')
      && this.options.auth.state() === 'authenticated' ? 'autonomous'
      : this.options.policy.enabled ? 'policy-paused' : 'policy-reject'
  }

  private now(): string {
    return (this.options.now ?? (() => new Date().toISOString()))()
  }
}

function validateOptions(options: MobileAgentShellOptions): void {
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1 || options.maxConcurrency > 4096
    || !Number.isSafeInteger(options.policy.maxConcurrentTasks) || options.policy.maxConcurrentTasks < 1
    || options.policy.maxConcurrentTasks > options.maxConcurrency) throw new Error('MOBILE_SHELL_OPTIONS_INVALID')
}

function sameIdentity(left: PlatformIdentity, right: PlatformIdentity): boolean {
  return left.kind === right.kind && left.id === right.id
}

export type { MobileCapabilityHeartbeat, MobileSyncAck, MobileSyncRequest, SurfaceState, TaskAcceptanceMode }
