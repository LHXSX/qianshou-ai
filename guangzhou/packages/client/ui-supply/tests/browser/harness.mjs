/**
 * Real-browser harness for the supply workspace.
 *
 * The Node lane has no layout engine, so overflow cannot be observed there.
 * This module renders the real `SupplyPage` (real CSS module, real wire
 * parser, real snapshot shape) in Chrome through the repo's own Vite dev
 * server, and exposes the rendered facts for measurement by `verify.mjs`.
 *
 * Only React itself and the three UI primitives are aliased (see verify.mjs);
 * every other import is the package's own source.
 */
import { createElement, useSyncExternalStore } from 'react'
import { createRoot } from 'react-dom/client'
import { SupplyPage } from '../../src/client/SupplyPage.tsx'
import { parseSupplySnapshot } from '../../src/client/wire.ts'
import { zh } from '../../src/client/locales.ts'

/** A blocked observation with deliberately long identifiers and model names. */
const raw = {
  version: 'qianshou.local-supply.v1',
  observedAt: '2026-09-15T10:00:00.000Z',
  ownerPolicy: {
    mode: 'idle',
    maxConcurrency: 2,
    minFreeMemoryBytes: 4294967296,
    minIdleSeconds: 300,
    enabledServiceIds: ['tool-ffmpeg-with-a-very-long-capability-identifier-0001', 'ollama:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'],
    nodeRates: [{ localServiceId: 'ollama:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', amountMinor: 250, unit: 'per-image-frame-with-a-long-unit-name', currency: 'CNY' }],
  },
  eligibility: {
    state: 'blocked',
    reasons: ['HOST_ACTIVITY_UNKNOWN', 'FOREGROUND_PRIORITY', 'USER_ACTIVE', 'SOME_UNRECORDED_HOST_REASON_WITH_A_LONG_CODE'],
  },
  advertisingState: 'withdrawn',
  advertisedCapabilityIds: [],
  hardware: {
    platform: 'darwin',
    arch: 'arm64',
    cpuModel: 'Apple M3 Max with an unusually long marketing processor name',
    logicalCores: 16,
    totalMemoryBytes: 137438953472,
    freeMemoryBytes: 8589934592,
    gpus: [{ name: 'Apple M3 Max with a very long integrated graphics name', vendor: 'Apple Incorporated', memoryBytes: null }],
    probeErrors: ['GPU_PROBE_UNAVAILABLE', 'IDLE_PROBE_UNAVAILABLE'],
  },
  localServices: [
    { id: 'tool-ffmpeg-with-a-very-long-capability-identifier-0001', kind: 'tool', name: 'ffmpeg', version: '6.1.1', verification: 'verified', reason: null },
    { id: 'ollama:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', kind: 'local-model', name: 'qwen3-coder-480b-a35b-instruct-q4_K_M-with-a-long-model-name', version: null, verification: 'pending', reason: 'MODEL_INFERENCE_NOT_VERIFIED' },
  ],
  activity: { idleSeconds: 12, foregroundTaskActive: true, voiceActive: null },
}

const snapshot = parseSupplySnapshot(raw)
const state = { snapshot, stale: true, loading: false, saving: false, error: { code: 'SUPPLY_STORAGE_UNAVAILABLE', message: 'SUPPLY_STORAGE_UNAVAILABLE' } }
const listeners = new Set()
const store = {
  getSnapshot: () => state,
  subscribe: (fn) => { listeners.add(fn); return () => { listeners.delete(fn) } },
}
const t = (key, values) => Object.entries(values ?? {})
  .reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), zh[key])
const useSupply = (selector) => useSyncExternalStore(store.subscribe, () => selector(store.getSnapshot()))

createRoot(document.getElementById('root')).render(
  createElement(SupplyPage, { refresh: async () => {}, savePolicy: async () => true, t, useSupply }),
)

/** Facts the verify script asserts on, read after React has committed the DOM. */
globalThis.__supplyFacts = () => ({
  observedAt: snapshot.observedAt,
  reasons: [...document.querySelectorAll('[data-reason]')].map(node => node.getAttribute('data-reason')),
  voiceFact: document.querySelector('[data-fact="voice"] dd')?.textContent ?? null,
  unknownVoiceText: zh.unknown,
  settlementText: document.querySelector('[aria-label="收益"] strong')?.textContent ?? null,
  unknownVramText: document.querySelector('main')?.textContent?.includes(zh.gpuMemoryUnknown) ?? false,
  rendered: document.querySelectorAll('[aria-label]').length,
})
