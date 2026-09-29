import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { HostPluginAdapterRegistry, type HostPluginAdapter, type PluginAdapterSelection } from '../src/plugin-adapter-admission.ts'
import { buildOfflinePluginArtifact, offlinePluginSampleSha256, verifyOfflinePluginArtifact,
  type OfflinePluginSample } from '../src/offline-plugin-artifact.ts'
import { parsePluginDraftSpec, type LocalPluginDraft } from '../src/plugin-draft.ts'
import { pluginDraftPlanManifest } from '../src/plugin-draft-preview.ts'
import { ComputeError } from '../src/errors.ts'

const NOW = Date.parse('2026-09-24T09:00:00.000Z')
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}
function expectControlledInvalid(run: () => unknown): void {
  try { run(); throw new Error('unexpectedly accepted') }
  catch (error) {
    expect(error).toBeInstanceOf(ComputeError)
    expect((error as ComputeError).code).toBe('COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID')
  }
}
const resources = { platforms: ['darwin'], architectures: ['arm64'], minTotalMemoryBytes: 0,
  minFreeDiskBytes: 0, maxInputBytes: 4096, maxOutputBytes: 4096, maxRunMs: 10_000 }

function setup() {
  const spec = parsePluginDraftSpec({ pluginId: 'creator.three-kinds', version: '1.0.0',
    displayName: 'Three kinds', operations: [
      { id: 'video.draw', title: 'Draw video', description: 'Render a local video.',
        binding: { kind: 'workflow', ref: 'drawn-video:reviewed' },
        inputSchema: { type: 'object', properties: { title: { type: 'string' } },
          required: ['title'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } },
          required: ['attachmentId'], additionalProperties: false },
        permissions: ['workspace.write'], dataScope: 'task-inputs', networkOrigins: [], dependencies: [], resources },
      { id: 'csv.profile', title: 'CSV profile', description: 'Inspect supplied CSV.',
        binding: { kind: 'tool', ref: 'csv-profile:reviewed' },
        inputSchema: { type: 'object', properties: { csv: { type: 'string' } },
          required: ['csv'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { rowCount: { type: 'integer' } },
          required: ['rowCount'], additionalProperties: false },
        permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [], resources },
      { id: 'text.local', title: 'Local model', description: 'Transform text locally.',
        binding: { kind: 'local-model', ref: 'local-model:reviewed' },
        inputSchema: { type: 'object', properties: { prompt: { type: 'string' } },
          required: ['prompt'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { text: { type: 'string' } },
          required: ['text'], additionalProperties: false },
        permissions: ['model.local'], dataScope: 'task-inputs', networkOrigins: [], dependencies: [], resources },
    ] })
  const draft: LocalPluginDraft = { id: 'plugin_draft_00000000-0000-0000-0000-000000000002',
    createdAt: '2026-09-24T08:00:00.000Z', updatedAt: '2026-09-24T08:30:00.000Z',
    state: 'private-draft', installable: false, dispatchable: false,
    readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec }
  const samples: OfflinePluginSample[] = [
    { operationId: 'video.draw', input: { title: 'seaside' }, output: { attachmentId: 'sha256:video' } },
    { operationId: 'csv.profile', input: { csv: 'name\nAlice' }, output: { rowCount: 1 } },
    { operationId: 'text.local', input: { prompt: 'hello' }, output: { text: 'hello' } },
  ]
  const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => NOW })
  const plan = pluginDraftPlanManifest(draft)
  const selections: PluginAdapterSelection[] = []
  const unload: Array<() => void> = []
  for (const operation of spec.operations) {
    const schemas = plan.operations.find(item => item.id === operation.id)!
    const assets = operation.id === 'csv.profile' ? [] : [{ id: `${operation.id}.asset`, bytes: 64,
      sha256: (operation.id === 'video.draw' ? 'a' : 'b').repeat(64) }]
    const adapter: HostPluginAdapter = { adapterId: `qianshou.${operation.id}`,
      adapterVersion: '1.0.0', operationId: operation.id,
      bindingKind: operation.binding.kind, bindingRef: operation.binding.ref,
      inputSchemaSha256: schemas.inputSchemaSha256, outputSchemaSha256: schemas.outputSchemaSha256,
      permissions: operation.permissions, dataScope: operation.dataScope,
      networkOrigins: operation.networkOrigins, dependencies: operation.dependencies,
      resources: operation.resources, assets, validUntilMs: NOW + 2 * 60 * 60 * 1000 }
    unload.push(registry.register(adapter))
    const sample = samples.find(item => item.operationId === operation.id)!
    const receipt = registry.recordSampleDigestClaim({ draft, operationId: operation.id,
      adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion,
      inputSha256: offlinePluginSampleSha256(sample.input),
      outputSha256: offlinePluginSampleSha256(sample.output), assets })
    selections.push({ operationId: operation.id, adapterId: adapter.adapterId,
      adapterVersion: adapter.adapterVersion, sampleDigestClaimId: receipt.id })
  }
  return { draft, samples, registry, unload, candidate: registry.admitPrivateCandidate(draft, selections) }
}

describe('offline plugin artifact', () => {
  it('builds deterministic data-only ZIP for workflow, tool and local-model operations', () => {
    const input = setup()
    const first = buildOfflinePluginArtifact(input)
    const second = buildOfflinePluginArtifact(input)
    expect(first.bytes.equals(second.bytes)).toBe(true)
    expect(first).toMatchObject({ state: 'built-offline-uninstalled', packageProduced: true,
      executionVerified: false,
      installable: false, dispatchable: false })
    expect(first.bytes.includes(Buffer.from('cordis.patch.yml'))).toBe(false)
    expect(first.bytes.includes(Buffer.from('index.js'))).toBe(false)
    expect(verifyOfflinePluginArtifact(first.bytes, first)).toMatchObject({
      verificationScope: 'data-only-archive-and-claimed-digests', state: 'verified-offline-uninstalled',
      executionVerified: false,
      installable: false, dispatchable: false,
      operationIds: ['video.draw', 'csv.profile', 'text.local'],
    })
  })

  it('refuses changed sample data, fabricated candidates and unloaded adapter evidence', () => {
    const input = setup()
    expect(() => buildOfflinePluginArtifact({ ...input, samples: [
      { ...input.samples[0]!, output: { attachmentId: 'different' } }, ...input.samples.slice(1),
    ] })).toThrow('COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID')
    expect(() => buildOfflinePluginArtifact({ ...input, samples: [
      { ...input.samples[0]!, input: { title: 42 } }, ...input.samples.slice(1),
    ] })).toThrow('COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID')
    expect(() => buildOfflinePluginArtifact({ ...input,
      candidate: { ...input.candidate, pluginId: 'forged.plugin' } })).toThrow('COMPUTE_PLUGIN_CANDIDATE_INVALID')
    input.unload[0]!()
    expect(() => buildOfflinePluginArtifact(input)).toThrow('COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE')
  })

  it('rejects unpinned, altered and non-canonical archive bytes even with a matching claimed digest', () => {
    const artifact = buildOfflinePluginArtifact(setup())
    expect(() => verifyOfflinePluginArtifact(artifact.bytes, {
      packageSha256: '0'.repeat(64), candidateSha256: artifact.candidateSha256,
    })).toThrow('COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID')
    const changed = Buffer.from(artifact.bytes)
    changed[80] = changed[80]! ^ 1
    expect(() => verifyOfflinePluginArtifact(changed, {
      packageSha256: hash(changed), candidateSha256: artifact.candidateSha256,
    })).toThrow('COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID')
    const trailing = Buffer.concat([artifact.bytes, Buffer.from('unexpected')])
    expect(() => verifyOfflinePluginArtifact(trailing, {
      packageSha256: hash(trailing), candidateSha256: artifact.candidateSha256,
    })).toThrow('COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID')
    expect(() => verifyOfflinePluginArtifact(artifact.bytes, {
      packageSha256: artifact.packageSha256, candidateSha256: 'f'.repeat(64),
    })).toThrow('COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID')
  })

  it('rejects deep, cyclic, accessor and proxy JSON without leaking runtime exceptions', () => {
    const deep = Array.from({ length: 80 }).reduce<unknown>((inner) => [inner], { title: 'x' })
    expectControlledInvalid(() => offlinePluginSampleSha256(deep))
    expectControlledInvalid(() => offlinePluginSampleSha256(Array.from({ length: 16_384 }, () => 0)))
    expectControlledInvalid(() => offlinePluginSampleSha256({ text: 'x'.repeat(256 * 1024) }))
    const cyclic: Record<string, unknown> = { title: 'loop' }
    cyclic.self = cyclic
    expectControlledInvalid(() => offlinePluginSampleSha256(cyclic))
    const accessor = Object.defineProperty({}, 'title', { enumerable: true, get() { throw new Error('secret') } })
    expectControlledInvalid(() => offlinePluginSampleSha256(accessor))
    const input = setup()
    expectControlledInvalid(() => buildOfflinePluginArtifact({ ...input, samples: [
      { ...input.samples[0]!, input: deep }, ...input.samples.slice(1),
    ] }))
    expectControlledInvalid(() => buildOfflinePluginArtifact({ ...input, samples: [
      { ...input.samples[0]!, input: accessor }, ...input.samples.slice(1),
    ] }))
    const throwingSample = new Proxy(input.samples[0]!, { get(_target, property) {
      if (property === 'operationId') throw new Error('proxy trap')
      return Reflect.get(_target, property)
    } })
    expectControlledInvalid(() => buildOfflinePluginArtifact({ ...input,
      samples: [throwingSample, ...input.samples.slice(1)] }))
  })

  it('rejects hostile ZIP headers and a deeply nested manifest after valid CRC and SHA', () => {
    const artifact = buildOfflinePluginArtifact(setup())
    const end = artifact.bytes.length - 22
    const centralOffset = artifact.bytes.readUInt32LE(end + 16)
    for (const offset of [4, 10, centralOffset + 12, centralOffset + 36]) {
      const changed = Buffer.from(artifact.bytes)
      changed[offset] = changed[offset]! ^ 1
      expectControlledInvalid(() => verifyOfflinePluginArtifact(changed, {
        packageSha256: hash(changed), candidateSha256: artifact.candidateSha256,
      }))
    }
    const deepManifest = Buffer.from(artifact.bytes)
    const nameLength = deepManifest.readUInt16LE(26)
    const manifestLength = deepManifest.readUInt32LE(18)
    const content = Buffer.from(`${'['.repeat(80)}0${']'.repeat(80)}`)
    expect(content.length).toBeLessThan(manifestLength)
    const padded = Buffer.alloc(manifestLength, 0x20)
    content.copy(padded)
    padded.copy(deepManifest, 30 + nameLength)
    const crc = crc32(padded)
    deepManifest.writeUInt32LE(crc, 14)
    deepManifest.writeUInt32LE(crc, centralOffset + 16)
    expectControlledInvalid(() => verifyOfflinePluginArtifact(deepManifest, {
      packageSha256: hash(deepManifest), candidateSha256: artifact.candidateSha256,
    }))
  })

  it('rejects missing or trap-backed expected digests with a controlled error', () => {
    const artifact = buildOfflinePluginArtifact(setup())
    expectControlledInvalid(() => verifyOfflinePluginArtifact(artifact.bytes, null as never))
    const throwingExpected = new Proxy({}, { get() { throw new Error('secret') } })
    expectControlledInvalid(() => verifyOfflinePluginArtifact(artifact.bytes, throwingExpected as never))
  })
})
