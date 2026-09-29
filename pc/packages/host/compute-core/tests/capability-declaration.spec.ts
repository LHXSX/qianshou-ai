import { describe, expect, it } from 'vitest'
import { projectCapabilityDeclaration } from '../src/supply/capability-declaration.ts'
import { advertisedNamesFromProbe, capabilitiesSatisfiedByAdvertised } from '../src/node-capability.ts'
import type { SupplyProbeResult } from '../src/supply/types.ts'

function probe(services: SupplyProbeResult['localServices']): SupplyProbeResult {
  return {
    hardware: {
      platform: 'darwin', arch: 'arm64', cpuModel: 'Apple M4', logicalCores: 1,
      totalMemoryBytes: 8, freeMemoryBytes: 4, gpus: [], probeErrors: [],
    },
    localServices: services,
    activity: { idleSeconds: null, foregroundTaskActive: null, voiceActive: null },
  }
}

describe('capability declaration from a local probe', () => {
  it('lands doc.pdf.extract with the registered pymupdf runtime and agrees with hello ads', () => {
    const facts = probe([
      { id: 'pymupdf', kind: 'tool', name: 'pymupdf', version: '1.24.0', verification: 'verified', reason: null },
    ])
    const declaration = projectCapabilityDeclaration(facts)
    const helloNames = capabilitiesSatisfiedByAdvertised(advertisedNamesFromProbe(facts))
    expect(declaration.contract).toBe('qianshou/capability/v1')
    expect(declaration.provides.map(row => row.capability).sort()).toEqual([...helloNames])
    expect(declaration.provides.map(row => row.capability).sort()).toEqual(['doc.pdf.extract', 'doc.pdf.probe'])
    const extract = declaration.provides.find(row => row.capability === 'doc.pdf.extract')
    expect(extract?.impl).toEqual({ runtime: 'pymupdf', version: '1.24.0' })
    expect(extract?.health).toBe('ok')
    expect(JSON.stringify(declaration.provides)).not.toContain('ocr.image')
  })

  it('binds a verified package id without putting it in native_binaries', () => {
    const facts = probe([
      { id: 'numpy', kind: 'package', name: 'NumPy', version: '2.4.3', verification: 'verified', reason: null },
    ])
    const declaration = projectCapabilityDeclaration(facts)
    expect(declaration.provides.map(row => row.capability)).toEqual(['compute.numeric'])
    expect(declaration.provides[0]?.impl).toEqual({ runtime: 'numpy', version: '2.4.3' })
    expect(declaration.native_binaries).toEqual([])
  })

  it('does not turn a working Ollama binary and pending model into inference readiness', () => {
    const facts = probe([
      { id: 'ollama', kind: 'tool', name: 'ollama', version: '0.3.0', verification: 'verified', reason: null },
      {
        id: 'ollama:model', kind: 'local-model', name: 'style-model', version: null,
        verification: 'pending', reason: 'MODEL_INFERENCE_NOT_VERIFIED',
        promptStyle: 'sdxl-turbo', lorasTrigger: 'ohwx',
      },
    ])
    expect(projectCapabilityDeclaration(facts).provides).toEqual([])
    expect(projectCapabilityDeclaration(facts).native_binaries).toEqual(['ollama'])
  })

  it('does not invent prompt_style or create a capability from a model inventory alone', () => {
    const facts = probe([
      {
        id: 'ollama:model', kind: 'local-model', name: 'style-model', version: null,
        verification: 'pending', reason: 'MODEL_INFERENCE_NOT_VERIFIED',
        promptStyle: 'sdxl-turbo', lorasTrigger: 'ohwx',
      },
    ])
    const declaration = projectCapabilityDeclaration(facts)
    expect(declaration.provides).toEqual([])
    expect(JSON.stringify(declaration)).not.toContain('prompt_style')
    expect(JSON.stringify(declaration)).not.toContain('sdxl-turbo')
  })

  it('requires capability-specific executor evidence even for a verified inventory model', () => {
    const facts = probe([
      { id: 'ollama', kind: 'tool', name: 'ollama', version: '0.3.0', verification: 'verified', reason: null },
      {
        id: 'ollama:model', kind: 'local-model', name: 'plain', version: null,
        verification: 'verified', reason: null,
      },
    ])
    expect(projectCapabilityDeclaration(facts).provides).toEqual([])
  })
})
