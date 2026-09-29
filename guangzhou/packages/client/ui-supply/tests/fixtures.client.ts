/**
 * Snapshot fixtures for the supply specs. They are plain JSON payloads, shaped
 * exactly like `GET /api/qianshou/compute/supply` writes them, so every test
 * that needs typed facts also exercises the real wire parser.
 */
import type { SupplySnapshot } from '@deepseek-ai/dsh-compute-core/supply'
import { parseSupplySnapshot } from '../src/client/wire.ts'

/** A blocked observation: someone is using the machine and voice state is unreported. */
export const blockedJson = {
  version: 'qianshou.local-supply.v1', observedAt: '2026-09-15T10:00:00.000Z',
  ownerPolicy: {
    mode: 'idle', maxConcurrency: 2, minFreeMemoryBytes: 4294967296, minIdleSeconds: 300,
    enabledServiceIds: ['tool-ffmpeg'],
    nodeRates: [{ localServiceId: 'tool-ffmpeg', amountMinor: 250, unit: 'per-image', currency: 'CNY' }],
  },
  eligibility: {
    state: 'blocked',
    reasons: ['HOST_ACTIVITY_UNKNOWN', 'FOREGROUND_PRIORITY', 'USER_ACTIVE'],
  },
  advertisingState: 'withdrawn', advertisedCapabilityIds: [],
  hardware: {
    platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M3 Pro', logicalCores: 12,
    totalMemoryBytes: 38654705664, freeMemoryBytes: 1073741824,
    gpus: [{ name: 'Apple M3 Pro', vendor: 'Apple', memoryBytes: null }],
    probeErrors: ['IDLE_PROBE_UNAVAILABLE'],
  },
  localServices: [
    { id: 'tool-ffmpeg', kind: 'tool', name: 'ffmpeg', version: '6.1.1', verification: 'verified', reason: null },
    { id: 'ollama:abc', kind: 'local-model', name: 'qwen3:8b', version: null, verification: 'pending', reason: 'MODEL_INFERENCE_NOT_VERIFIED' },
  ],
  activity: { idleSeconds: 12, foregroundTaskActive: true, voiceActive: null },
}

/** A ready observation with one advertised capability. */
export const readyJson = {
  ...blockedJson,
  ownerPolicy: { ...blockedJson.ownerPolicy, mode: 'allowed' },
  eligibility: { state: 'ready', reasons: [] },
  advertisingState: 'advertising', advertisedCapabilityIds: ['tool-ffmpeg'],
  hardware: { ...blockedJson.hardware, probeErrors: [] },
  activity: { idleSeconds: 900, foregroundTaskActive: false, voiceActive: false },
}

/** The owner turned contribution off. */
export const disabledJson = {
  ...blockedJson,
  ownerPolicy: { ...blockedJson.ownerPolicy, mode: 'off' },
  eligibility: { state: 'disabled', reasons: ['OWNER_DISABLED'] },
  advertisingState: 'not-connected', advertisedCapabilityIds: [],
  activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null },
}

/** Nothing discovered and nothing enabled: the empty-inventory observation. */
export const emptyJson = {
  ...disabledJson,
  ownerPolicy: { ...blockedJson.ownerPolicy, mode: 'allowed', enabledServiceIds: [], nodeRates: [] },
  eligibility: { state: 'blocked', reasons: ['NO_VERIFIED_ENABLED_SERVICE', 'HOST_ACTIVITY_UNKNOWN'] },
  hardware: { ...blockedJson.hardware, gpus: [], probeErrors: [] },
  localServices: [],
  activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null },
}

/** Parse one fixture into the typed snapshot the page renders. */
export function snapshot(json: unknown = blockedJson): SupplySnapshot { return parseSupplySnapshot(json) }

/** A resolved/rejected response pair for a deferred transport. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
