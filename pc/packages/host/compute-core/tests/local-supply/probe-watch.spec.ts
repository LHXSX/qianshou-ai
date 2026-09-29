import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SEMANTIC_CAPABILITY_NAMES } from '../../src/capability-registry.ts'
import { advertisedNamesFromProbe, capabilitiesSatisfiedByAdvertised } from '../../src/node-capability.ts'
import { projectCapabilityDeclaration } from '../../src/supply/capability-declaration.ts'
import { SupplyController } from '../../src/supply/controller.ts'
import {
  FileProbeWatchStore,
  ZERO_CALLS_TODAY,
  probeWatchAlert,
  recordProbeWatch,
} from '../../src/supply/probe-watch.ts'
import type { SupplyPolicy, SupplyProbeResult } from '../../src/supply/types.ts'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

const policy: SupplyPolicy = {
  mode: 'off', maxConcurrency: 1, minFreeMemoryBytes: 0, minIdleSeconds: 0,
  enabledServiceIds: [], nodeRates: [],
}

function facts(toolId: string): SupplyProbeResult {
  return {
    hardware: {
      platform: 'test', arch: 'test', cpuModel: 'fixture', logicalCores: 2,
      totalMemoryBytes: 8, freeMemoryBytes: 4, gpus: [], probeErrors: [],
    },
    localServices: [
      { id: toolId, kind: 'tool', name: toolId, version: '1.24.0', verification: 'verified', reason: null },
    ],
    activity: { idleSeconds: 100, foregroundTaskActive: false, voiceActive: false },
  }
}

describe('local probe watch', () => {
  it('records a change and keeps local names aligned with the platform matcher', () => {
    const first = recordProbeWatch(null, ['doc.pdf.extract', 'doc.pdf.probe'], new Date('2026-09-19T00:00:00.000Z'))
    expect(first.callsToday).toBe(1)
    expect(first.day).toBe('2026-09-19')
    expect(first.changes[0]).toEqual({
      at: '2026-09-19T00:00:00.000Z',
      added: ['doc.pdf.extract', 'doc.pdf.probe'],
      removed: [],
    })
    const same = recordProbeWatch(first, ['doc.pdf.extract', 'doc.pdf.probe'], new Date('2026-09-19T01:00:00.000Z'))
    expect(same.callsToday).toBe(2)
    expect(same.changes).toHaveLength(1)
    const lost = recordProbeWatch(same, [], new Date('2026-09-19T02:00:00.000Z'))
    expect(lost.changes[0]?.removed).toEqual(['doc.pdf.extract', 'doc.pdf.probe'])
    expect(lost.lastChangedAt).toBe('2026-09-19T02:00:00.000Z')
    const probe = facts('pymupdf')
    const declaration = projectCapabilityDeclaration(probe)
    const hello = capabilitiesSatisfiedByAdvertised(advertisedNamesFromProbe(probe))
    expect(declaration.provides.map(row => row.capability).sort()).toEqual([...hello].sort())
    expect(declaration.provides.every(row => SEMANTIC_CAPABILITY_NAMES.includes(row.capability))).toBe(true)
  })

  it('reports zero calls today without probing, including a leftover yesterday row', () => {
    expect(probeWatchAlert(null, new Date('2026-09-19T08:00:00.000Z'))).toEqual({
      callsToday: 0, note: ZERO_CALLS_TODAY, attention: true,
    })
    const yesterday = recordProbeWatch(null, ['doc.pdf.extract'], new Date('2026-09-18T23:00:00.000Z'))
    expect(yesterday.callsToday).toBe(1)
    expect(probeWatchAlert(yesterday, new Date('2026-09-19T00:00:00.000Z'))).toEqual({
      callsToday: 0, note: ZERO_CALLS_TODAY, attention: true,
    })
    const today = recordProbeWatch(yesterday, ['doc.pdf.extract'], new Date('2026-09-19T00:00:00.000Z'))
    expect(today.callsToday).toBe(1)
    expect(today.changes.filter(item => item.at.startsWith('2026-09-19'))).toHaveLength(0)
    expect(probeWatchAlert(today, new Date('2026-09-19T12:00:00.000Z')).attention).toBe(false)
  })

  it('persists across snapshots so a later reader sees the change without being the probe', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-watch-'))
    roots.push(root)
    const store = new FileProbeWatchStore(join(root, 'supply.watch'))
    expect(await store.load()).toBeNull()
    const controller = new SupplyController({
      initialPolicy: policy,
      policyStore: { load: async () => null, save: async () => {} },
      probe: vi.fn(async () => facts('pymupdf')),
      activeTaskCount: () => 0,
      operationTimeoutMs: 1000,
      now: () => '2026-09-19T03:00:00.000Z',
      watchStore: store,
    })
    const first = await controller.querySupplySnapshot()
    expect(first.declaration.provides.map(row => row.capability).sort()).toEqual(['doc.pdf.extract', 'doc.pdf.probe'])
    expect(first.probeWatch.callsToday).toBe(1)
    expect(first.probeWatch.changes[0]?.added).toEqual(['doc.pdf.extract', 'doc.pdf.probe'])
    await controller.close()
    const later = probeWatchAlert(await store.load(), new Date('2026-09-19T04:00:00.000Z'))
    expect(later.callsToday).toBe(1)
    expect(later.attention).toBe(false)
    expect(probeWatchAlert(await store.load(), new Date('2026-09-20T00:00:00.000Z'))).toEqual({
      callsToday: 0, note: ZERO_CALLS_TODAY, attention: true,
    })
  })
})
