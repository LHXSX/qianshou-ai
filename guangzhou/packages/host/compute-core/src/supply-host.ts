/** Host assembly for read-only local probes, private owner preferences and the advertisement channel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { SupplyController } from './supply/controller.ts'
import { HttpSupplyAdvertisementPort } from './supply/advertisement.ts'
import { FileSupplyPolicyStore } from './supply/policy.ts'
import { probeLocalSupply, type LocalToolProbe } from './supply/local-probe.ts'

/**
 * The narrow service shape this package reads for voice activity.
 *
 * The contract is declared here, on the consumer side, because contribution admission is the only place that must
 * never mistake "no producer" for "the owner is away". The producing plugin (`@deepseek-ai/dsh-host-voice-local`)
 * stays independent: it publishes the same shape under the `voiceActivity` name without depending on this package,
 * and `index.ts` hands the reader to `createHostSupply`.
 */
export interface HostVoiceActivity {
  /** Synchronous, I/O-free read: true only while real local voice work is actually in flight. */
  readonly active: () => boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional real voice-activity producer; absent means the Host cannot vouch for voice, which is unknown. */
    voiceActivity?: HostVoiceActivity
  }
}

/** Read the optional producer instead of trusting an untyped service value.
 *
 * A missing service, or one that does not answer `active()` with a boolean, is reported as unknown (`null`) so the
 * controller keeps pushing `HOST_ACTIVITY_UNKNOWN` and contribution stays blocked.
 * @param ctx - Host scope that may or may not have loaded a voice-activity producer.
 * @returns The real reading, or `null` when no conforming producer is loaded.
 */
export function readHostVoiceActivity(ctx: Context): boolean | null {
  const producer: unknown = ctx.get('voiceActivity')
  if (!conformingProducer(producer)) return null
  // The declared contract says boolean, but this seam exists because a service value is only ever as trustworthy
  // as its runtime shape: anything that is not literally `true` stays unknown instead of reading as idle.
  const reading: unknown = producer.active()
  return reading === true
}

/** Runtime guard for the optional producer; an unknown-shaped service value is never adopted. */
function conformingProducer(value: unknown): value is HostVoiceActivity {
  return typeof value === 'object' && value !== null && typeof Reflect.get(value, 'active') === 'function'
}

/** Default probe and advertisement timeout, applied by the schema and reused for the real transport. */
const DEFAULT_TIMEOUT_MS = 5000
/** Default bounded response size, applied by the schema and reused for the real transport. */
const DEFAULT_MAX_RESPONSE_BYTES = 262144
/** Default owner concurrency limit applied until the owner saves a policy. */
const DEFAULT_INITIAL_MAX_CONCURRENCY = 1
/** Default free-memory requirement applied until the owner saves a policy. */
const DEFAULT_INITIAL_MIN_FREE_MEMORY_BYTES = 0
/** Default OS idle-time requirement applied until the owner saves a policy. */
const DEFAULT_INITIAL_MIN_IDLE_SECONDS = 60

/** Deployment choices for local observation and advertisement; owner policy is saved separately. */
export interface SupplyHostConfig {
  /** Whole probe operation timeout in milliseconds. */
  timeoutMs?: number
  /** Maximum subprocess or loopback JSON response bytes. */
  maxResponseBytes?: number
  /** Optional literal-loopback Ollama origin; empty disables model discovery. */
  ollamaOrigin?: string
  /** Trusted executable/version checks; HTTP callers cannot alter these. */
  tools?: Array<Omit<LocalToolProbe, 'args'> & {
    /** Literal argument vector for this trusted probe; deployment-owned, never HTTP input. */
    args: string[]
  }>
  /** Initial owner concurrency limit until a policy is saved. */
  initialMaxConcurrency?: number
  /** Initial free-memory requirement in bytes until a policy is saved. */
  initialMinFreeMemoryBytes?: number
  /** Initial OS idle-time requirement in seconds until a policy is saved. */
  initialMinIdleSeconds?: number
  /** Absolute advertisement endpoint owned by the deployment; empty advertises nothing and is the default. */
  advertisementEndpoint?: string
}

/** Host-side ports the local supply assembly needs beyond its own configuration. */
export interface SupplyHostPorts {
  /** Existing host access-token source for the advertisement channel; absent means no credential is available. */
  readonly tokenProvider?: () => string | undefined
  /** Real voice-activity reader owned by the composition; absent keeps voice activity unknown, never idle. */
  readonly voiceActive?: () => boolean | null
}

/** Bounds for trusted Host configuration; first-use contribution always starts off. */
export const SupplyHostConfig: z<SupplyHostConfig> = z.object({
  timeoutMs: z.number().step(1).min(1000).max(60000).default(DEFAULT_TIMEOUT_MS),
  maxResponseBytes: z.number().step(1).min(1024).max(4194304).default(DEFAULT_MAX_RESPONSE_BYTES),
  ollamaOrigin: z.string().default(''),
  tools: z.array(z.object({ id: z.string().required(), name: z.string().required(),
    command: z.string().required(), args: z.array(z.string()).required() })).default([
    { id: 'node', name: 'Node.js', command: process.execPath, args: ['--version'] },
    { id: 'git', name: 'Git', command: 'git', args: ['--version'] },
    { id: 'ffmpeg', name: 'FFmpeg', command: 'ffmpeg', args: ['-version'] },
  ]),
  initialMaxConcurrency: z.number().step(1).min(1).max(256).default(DEFAULT_INITIAL_MAX_CONCURRENCY),
  initialMinFreeMemoryBytes: z.number().step(1).min(0).default(DEFAULT_INITIAL_MIN_FREE_MEMORY_BYTES),
  initialMinIdleSeconds: z.number().step(1).min(0).default(DEFAULT_INITIAL_MIN_IDLE_SECONDS),
})

/** Create local supply observations and the real advertisement channel they feed.
 *
 * The advertisement port is always constructed, so a snapshot can never fall back to a silently missing port:
 * without `advertisementEndpoint` the port reports `not-configured` and every exchange rejects with a structured
 * code, and with one it performs the real authenticated request. No Worker identity is inferred either way.
 * @param ctx - Owner Host scope; the optional agent registry supplies actual running counts.
 * @param input - Deployment-owned probe and advertisement settings.
 * @param policyPath - Dedicated absolute private policy file.
 * @param ports - Optional host credential source for the advertisement channel.
 * @returns Controller whose close method drains its bounded observations and withdraws through the real transport.
 */
export function createHostSupply(ctx: Context, input: SupplyHostConfig, policyPath: string, ports: SupplyHostPorts = {}): SupplyController {
  const config = SupplyHostConfig(input)
  const taskCount = (): number | null => {
    const agents = ctx.get('agents')
    return agents ? agents.list().filter(agent => agent.status === 'running').length : null
  }
  const advertisement = new HttpSupplyAdvertisementPort({
    endpoint: config.advertisementEndpoint ?? '', tokenProvider: ports.tokenProvider ?? (() => undefined),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  })
  return new SupplyController({
    initialPolicy: { mode: 'off', maxConcurrency: config.initialMaxConcurrency ?? DEFAULT_INITIAL_MAX_CONCURRENCY,
      minFreeMemoryBytes: config.initialMinFreeMemoryBytes ?? DEFAULT_INITIAL_MIN_FREE_MEMORY_BYTES,
      minIdleSeconds: config.initialMinIdleSeconds ?? DEFAULT_INITIAL_MIN_IDLE_SECONDS,
      enabledServiceIds: [], nodeRates: [] },
    policyStore: new FileSupplyPolicyStore(policyPath),
    operationTimeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, activeTaskCount: taskCount,
    advertisement,
    probe: signal => probeLocalSupply({
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      tools: config.tools ?? [],
      ...(config.ollamaOrigin ? { ollamaOrigin: config.ollamaOrigin } : {}),
      readHostActivity: () => {
        const count = taskCount()
        // Voice activity comes from a real producer when one is loaded. With no producer the fact stays null, which
        // the controller turns into HOST_ACTIVITY_UNKNOWN: "nobody can tell" must never be read as "the owner is away".
        return { foregroundTaskActive: count === null ? null : count > 0, voiceActive: ports.voiceActive?.() ?? null }
      },
    }, signal),
  })
}
