/** window embedding of the mobile agent shell. No compute contribution, no token store. */
import type { PlatformCapabilityRecord, PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'
import {
  MobileAgentShell,
  createMobileHttpSyncPort,
  parseMobileSyncState,
  type MobileAcceptancePolicy,
  type MobileAgentShellSnapshot,
  type MobileAuthPort,
  type MobileTaskDecision,
  type MobileSyncState,
  type MobileSyncStatePort,
  type SurfaceState,
} from './mobile-agent-shell.ts'

/** Visibility events supplied by a window or test host. */
export interface SurfacePort {
  /** Subscribe to surface changes; the returned disposer must remove the listener. */
  readonly subscribe: (listener: (surface: SurfaceState) => void) => () => void
}

/** Native phone and desktop faces. A separate browser renderer can preview the mobile frame without a native `web` platform. */
export const WINDOW_HOST_PLATFORMS = ['ios', 'android', 'desktop', 'harmony'] as const
export type WindowHostPlatform = (typeof WINDOW_HOST_PLATFORMS)[number]

function isWindowHostPlatform(value: unknown): value is WindowHostPlatform {
  return typeof value === 'string' && (WINDOW_HOST_PLATFORMS as readonly string[]).includes(value)
}

/** Inputs a mount must make explicit before the shell is constructed. */
export interface WindowHostOptions {
  readonly identity: PlatformIdentity
  readonly platform: WindowHostPlatform
  readonly agentVersion: string
  readonly origin: string
  readonly auth: MobileAuthPort
  readonly capabilities?: () => readonly PlatformCapabilityRecord[]
  readonly state?: MobileSyncStatePort
  /** Text blob used when {@link WindowHostOptions.state} is omitted. */
  readonly persist?: WindowSyncTextPort
  readonly cookie?: string
  readonly fetch?: typeof globalThis.fetch
  readonly now?: () => string
  readonly policy?: Partial<MobileAcceptancePolicy>
}

/** Fail-soft result of {@link bootWindowHost}. */
export interface WindowHostBoot {
  readonly ok: boolean
  readonly error: string | null
  readonly host: WindowHost | null
}

/** Default policy: cards stay off until a face turns them on. */
export const WINDOW_DEFAULT_POLICY: MobileAcceptancePolicy = Object.freeze({
  enabled: false,
  requireForeground: true,
  maxConcurrentTasks: 1,
  acceptWithoutQuote: false,
})

/** Process-local cursor store; native storage is supplied by a later adapter. */
export class MemoryMobileSyncState implements MobileSyncStatePort {
  private current: MobileSyncState | null

  /**
   * @param initial - Previously parsed state, or `null` when this participant has none.
   */
  constructor(initial: MobileSyncState | null = null) {
    this.current = initial === null ? null : parseMobileSyncState(initial)
  }

  /** @returns The last committed state, or `null` before any accepted sync. */
  snapshot(): MobileSyncState | null {
    return this.current
  }

  /**
   * @param state - Cursor the shell accepted.
   * @returns Resolves after the record is replaced.
   */
  async save(state: MobileSyncState): Promise<void> {
    this.current = state
  }
}

/** Text blob the window or desktop host owns; this class never opens a file or database. */
export interface WindowSyncTextPort {
  /** Last written JSON, or `null` when this participant has none. */
  readonly read: () => string | null
  /** Replace the blob; rejection must leave the previous snapshot intact. */
  readonly write: (text: string) => Promise<void>
}

function parseStoredText(text: string | null): MobileSyncState | null {
  if (text === null || text === '') return null
  try {
    return parseMobileSyncState(JSON.parse(text) as unknown)
  } catch {
    return null
  }
}

/** Durable cursor store for hosts that cannot use IndexedDB. */
export class TextMobileSyncState implements MobileSyncStatePort {
  private current: MobileSyncState | null
  private readonly text: WindowSyncTextPort

  /**
   * @param text - Embedding read/write of one JSON blob per participant.
   */
  constructor(text: WindowSyncTextPort) {
    this.text = text
    this.current = parseStoredText(text.read())
  }

  /** @returns The last committed state, or `null` before any accepted sync. */
  snapshot(): MobileSyncState | null {
    return this.current
  }

  /**
   * @param state - Cursor the shell accepted.
   * @returns Resolves after the blob is replaced.
   */
  async save(state: MobileSyncState): Promise<void> {
    await this.text.write(JSON.stringify(state))
    this.current = state
  }
}

/**
 * Construct a shell that talks HTTP sync and reports surface through a port.
 * @param options - Identity, platform, origin and auth; policy defaults to {@link WINDOW_DEFAULT_POLICY}.
 */
export class WindowHost {
  readonly shell: MobileAgentShell
  private readonly capabilities: () => readonly PlatformCapabilityRecord[]

  constructor(options: WindowHostOptions) {
    const policy: MobileAcceptancePolicy = {
      enabled: options.policy?.enabled ?? WINDOW_DEFAULT_POLICY.enabled,
      requireForeground: options.policy?.requireForeground ?? WINDOW_DEFAULT_POLICY.requireForeground,
      maxConcurrentTasks: options.policy?.maxConcurrentTasks ?? WINDOW_DEFAULT_POLICY.maxConcurrentTasks,
      acceptWithoutQuote: options.policy?.acceptWithoutQuote ?? WINDOW_DEFAULT_POLICY.acceptWithoutQuote,
    }
    const state = options.state ?? (
      options.persist === undefined ? undefined : new TextMobileSyncState(options.persist)
    )
    this.capabilities = options.capabilities ?? (() => [])
    this.shell = new MobileAgentShell({
      identity: options.identity,
      platform: options.platform,
      agentVersion: options.agentVersion,
      maxConcurrency: policy.maxConcurrentTasks,
      auth: options.auth,
      capabilities: this.capabilities,
      sync: createMobileHttpSyncPort({
        origin: options.origin,
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      }),
      policy,
      ...(state === undefined ? {} : { state }),
      ...(options.now === undefined ? {} : { now: options.now }),
    })
  }

  /**
   * Forward OS visibility into the shell. The next heartbeat carries the value.
   * @param port - window or test surface source.
   * @returns Disposer that stops forwarding.
   */
  bindSurface(port: SurfacePort): () => void {
    return port.subscribe((surface) => { this.shell.setSurface(surface) })
  }

  /** @returns Frozen shell projection for a status card. */
  snapshot(): MobileAgentShellSnapshot {
    return this.shell.snapshot()
  }

  /**
   * @returns Capability ids this face advertised, in declaration order.
   */
  capabilityIds(): readonly string[] {
    return Object.freeze(this.capabilities().map(record => record.capabilityId))
  }

  /**
   * Parse one task card and record the local policy decision.
   * The host does not submit, quote, or charge.
   * @param value - Wire or cached card.
   * @returns The decision the shell stored on this snapshot.
   */
  receiveTaskCard(value: unknown): MobileTaskDecision {
    return this.shell.receiveTaskCard(value)
  }

  /**
   * @param limit - Page size the shell already validates.
   * @returns The acknowledgement the shell accepted.
   */
  sync(limit = 20): ReturnType<MobileAgentShell['sync']> {
    return this.shell.sync(limit)
  }
}

/**
 * Build a host without throwing at the window entry. Missing origin, identity or
 * auth stay as a named error so the face can show a card instead of crashing.
 * @param options - Same fields as {@link WindowHost}, all optional at this gate.
 * @returns A host or a named error; never throws for missing required fields.
 */
export function bootWindowHost(
  options: Partial<WindowHostOptions> = {},
): WindowHostBoot {
  if (options.origin === undefined || options.origin === '') {
    return { ok: false, error: 'WINDOW_HOST_ORIGIN_REQUIRED', host: null }
  }
  if (options.identity === undefined) {
    return { ok: false, error: 'WINDOW_HOST_IDENTITY_REQUIRED', host: null }
  }
  if (options.auth === undefined) {
    return { ok: false, error: 'WINDOW_HOST_AUTH_REQUIRED', host: null }
  }
  if (options.platform === undefined) {
    return { ok: false, error: 'WINDOW_HOST_PLATFORM_REQUIRED', host: null }
  }
  if (!isWindowHostPlatform(options.platform)) {
    return { ok: false, error: 'WINDOW_HOST_PLATFORM_UNSUPPORTED', host: null }
  }
  if (options.agentVersion === undefined || options.agentVersion === '') {
    return { ok: false, error: 'WINDOW_HOST_AGENT_VERSION_REQUIRED', host: null }
  }
  try {
    return {
      ok: true,
      error: null,
      host: new WindowHost({
        identity: options.identity,
        platform: options.platform,
        agentVersion: options.agentVersion,
        origin: options.origin,
        auth: options.auth,
        ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        ...(options.state === undefined ? {} : { state: options.state }),
        ...(options.persist === undefined ? {} : { persist: options.persist }),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.policy === undefined ? {} : { policy: options.policy }),
      }),
    }
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : 'WINDOW_HOST_BOOT_FAILED'
    return { ok: false, error: message, host: null }
  }
}

/**
 * Test and native hosts that push surface by method call.
 * @returns A port plus a setter the embedding code owns.
 */
export function createManualSurfacePort(): { port: SurfacePort; set: (surface: SurfaceState) => void } {
  const listeners = new Set<(surface: SurfaceState) => void>()
  return {
    port: {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
    set: (surface) => {
      for (const listener of listeners) listener(surface)
    },
  }
}
