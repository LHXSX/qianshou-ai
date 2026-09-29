import { describe, expect, it } from 'vitest'
import { HostPluginAdapterRegistry, type HostPluginAdapter } from '../src/plugin-adapter-admission.ts'
import { parsePluginDraftSpec, type LocalPluginDraft } from '../src/plugin-draft.ts'
import { pluginDraftPlanManifest } from '../src/plugin-draft-preview.ts'

const NOW = Date.parse('2026-09-24T08:00:00.000Z')
const VIDEO_ASSET = { id: 'video.reviewed-bundle', bytes: 3058, sha256: 'a'.repeat(64) }

/** Two unrelated capabilities share only the generic operation contract. */
function draft(): LocalPluginDraft {
  const spec = parsePluginDraftSpec({ pluginId: 'creator.local-example', version: '1.0.0',
    displayName: 'Local example', operations: [
      { id: 'video.drawn-5s', title: 'Draw video', description: 'Draw five seconds of video.',
        binding: { kind: 'workflow', ref: 'mac-drawn-video:reviewed-template' },
        inputSchema: { type: 'object', properties: { title: { type: 'string' } },
          required: ['title'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } },
          required: ['attachmentId'], additionalProperties: false },
        permissions: ['workspace.write'], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
        resources: { platforms: ['darwin'], architectures: ['arm64'], minTotalMemoryBytes: 0,
          minFreeDiskBytes: 1000, maxInputBytes: 1024, maxOutputBytes: 20_000_000, maxRunMs: 180_000 } },
      { id: 'csv.profile', title: 'CSV profile', description: 'Inspect CSV columns and rows.',
        binding: { kind: 'tool', ref: 'csv-profile:host-adapter' },
        inputSchema: { type: 'object', properties: { csv: { type: 'string' } },
          required: ['csv'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { rowCount: { type: 'integer' } },
          required: ['rowCount'], additionalProperties: false },
        permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
        resources: { platforms: ['darwin'], architectures: ['arm64'], minTotalMemoryBytes: 0,
          minFreeDiskBytes: 0, maxInputBytes: 1_048_576, maxOutputBytes: 100_000, maxRunMs: 10_000 } },
    ] })
  return { id: 'plugin_draft_00000000-0000-0000-0000-000000000001',
    createdAt: '2026-09-24T07:00:00.000Z', updatedAt: '2026-09-24T07:30:00.000Z',
    state: 'private-draft', installable: false, dispatchable: false,
    readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec }
}

function adapter(saved: LocalPluginDraft, operationId: string): HostPluginAdapter {
  const operation = saved.spec.operations.find(item => item.id === operationId)!
  const plan = pluginDraftPlanManifest(saved).operations.find(item => item.id === operationId)!
  return { adapterId: operationId === 'csv.profile' ? 'qianshou.csv-host' : 'qianshou.video-host',
    adapterVersion: '1.0.0', operationId, bindingKind: operation.binding.kind,
    bindingRef: operation.binding.ref, inputSchemaSha256: plan.inputSchemaSha256,
    outputSchemaSha256: plan.outputSchemaSha256, permissions: operation.permissions,
    dataScope: operation.dataScope, networkOrigins: operation.networkOrigins,
    dependencies: operation.dependencies, resources: operation.resources,
    assets: operationId === 'csv.profile' ? [] : [VIDEO_ASSET], validUntilMs: NOW + 2 * 60 * 60 * 1000 }
}

function sample(registry: HostPluginAdapterRegistry, saved: LocalPluginDraft, reviewed: HostPluginAdapter) {
  return registry.recordSampleDigestClaim({ draft: saved, operationId: reviewed.operationId,
    adapterId: reviewed.adapterId, adapterVersion: reviewed.adapterVersion,
    inputSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64), assets: reviewed.assets })
}

describe('Host-local plugin adapter claim matching', () => {
  it('admits a video workflow and a CSV tool through one multi-operation private candidate', () => {
    const saved = draft()
    const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => NOW })
    const video = adapter(saved, 'video.drawn-5s')
    const csv = adapter(saved, 'csv.profile')
    registry.register(video)
    registry.register(csv)
    expect(registry.listBindings()).toEqual(expect.arrayContaining([
      expect.objectContaining({ bindingKind: 'workflow', bindingRef: video.bindingRef,
        state: 'registered-needs-sample', sampleRequired: true, executionVerified: false }),
      expect.objectContaining({ bindingKind: 'tool', bindingRef: csv.bindingRef,
        state: 'registered-needs-sample', sampleRequired: true, executionVerified: false }),
    ]))
    const videoReceipt = sample(registry, saved, video)
    const csvReceipt = sample(registry, saved, csv)
    const candidate = registry.admitPrivateCandidate(saved, [
      { operationId: video.operationId, adapterId: video.adapterId,
        adapterVersion: video.adapterVersion, sampleDigestClaimId: videoReceipt.id },
      { operationId: csv.operationId, adapterId: csv.adapterId,
        adapterVersion: csv.adapterVersion, sampleDigestClaimId: csvReceipt.id },
    ])
    expect(candidate).toMatchObject({ state: 'private-candidate', packageProduced: false,
      executionVerified: false,
      installable: false, dispatchable: false, operations: [
        { bindingKind: 'workflow', adapterId: video.adapterId, assets: [VIDEO_ASSET] },
        { bindingKind: 'tool', adapterId: csv.adapterId, assets: [] },
      ] })
    expect(candidate.candidateSha256).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects absent adapters, incomplete or invented samples, and revisions of a saved draft', () => {
    const saved = draft()
    const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => NOW })
    const video = adapter(saved, 'video.drawn-5s')
    const csv = adapter(saved, 'csv.profile')
    expect(() => sample(registry, saved, video)).toThrow('COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE')
    registry.register(video)
    registry.register(csv)
    const videoReceipt = sample(registry, saved, video)
    const selections = [
      { operationId: video.operationId, adapterId: video.adapterId,
        adapterVersion: video.adapterVersion, sampleDigestClaimId: videoReceipt.id },
      { operationId: csv.operationId, adapterId: csv.adapterId,
        adapterVersion: csv.adapterVersion, sampleDigestClaimId: 'fabricated' },
    ]
    expect(() => registry.admitPrivateCandidate(saved, selections.slice(0, 1)))
      .toThrow('COMPUTE_PLUGIN_ADAPTER_SELECTION_INVALID')
    expect(() => registry.admitPrivateCandidate(saved, selections)).toThrow('COMPUTE_PLUGIN_SAMPLE_STALE')
    selections[1] = { ...selections[1]!, sampleDigestClaimId: sample(registry, saved, csv).id }
    const revised = { ...saved, spec: { ...saved.spec, displayName: 'Changed without a new revision' } }
    expect(() => registry.admitPrivateCandidate(revised, selections)).toThrow('COMPUTE_PLUGIN_SAMPLE_STALE')
    expect(() => registry.admitPrivateCandidate({ ...saved, installable: true } as unknown as LocalPluginDraft, selections))
      .toThrow('COMPUTE_PLUGIN_DRAFT_NOT_PRIVATE')
  })

  it('checks an exact draft-operation contract before a Host run without creating a claim', () => {
    const saved = draft()
    const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => NOW })
    const video = adapter(saved, 'video.drawn-5s')
    expect(() => registry.checkDraftOperation(saved, video.operationId, video.adapterId, video.adapterVersion))
      .toThrow('COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE')
    registry.register(video)
    expect(() => registry.checkDraftOperation(saved, video.operationId, video.adapterId, video.adapterVersion))
      .not.toThrow()
    expect(() => registry.checkDraftOperation({ ...saved,
      spec: { ...saved.spec, operations: saved.spec.operations.map(operation => operation.id === video.operationId
        ? { ...operation, permissions: [] } : operation) } } as LocalPluginDraft,
    video.operationId, video.adapterId, video.adapterVersion)).toThrow('COMPUTE_PLUGIN_ADAPTER_MISMATCH')
    const csv = adapter(saved, 'csv.profile')
    registry.register(csv)
    expect(() => registry.admitPrivateCandidate(saved, [{ operationId: video.operationId,
      adapterId: video.adapterId, adapterVersion: video.adapterVersion,
      sampleDigestClaimId: 'none' }, { operationId: csv.operationId,
      adapterId: csv.adapterId, adapterVersion: csv.adapterVersion,
      sampleDigestClaimId: 'none' }])).toThrow('COMPUTE_PLUGIN_SAMPLE_STALE')
  })

  it('rejects schema, binding, permission, platform, asset and review mismatches', () => {
    const saved = draft()
    const base = adapter(saved, 'video.drawn-5s')
    const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => NOW })
    expect(() => registry.register({ ...base, resources: { ...base.resources, platforms: ['win32'] } }))
      .toThrow('COMPUTE_PLUGIN_ADAPTER_INVALID')
    const mismatches: HostPluginAdapter[] = [
      { ...base, bindingRef: 'other:workflow' },
      { ...base, inputSchemaSha256: 'd'.repeat(64) },
      { ...base, permissions: [] },
      { ...base, resources: { ...base.resources, minFreeDiskBytes: 0 } },
    ]
    for (const reviewed of mismatches) {
      const local = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => NOW })
      local.register(reviewed)
      expect(() => sample(local, saved, reviewed)).toThrow('COMPUTE_PLUGIN_ADAPTER_MISMATCH')
    }
    registry.register(base)
    expect(() => registry.recordSampleDigestClaim({ draft: saved, operationId: base.operationId,
      adapterId: base.adapterId, adapterVersion: base.adapterVersion,
      inputSha256: 'b'.repeat(64), outputSha256: 'c'.repeat(64),
      assets: [{ ...VIDEO_ASSET, sha256: 'd'.repeat(64) }] })).toThrow('COMPUTE_PLUGIN_SAMPLE_INVALID')
  })

  it('invalidates sample tokens when an adapter unloads or either review or sample expires', () => {
    const saved = draft()
    let now = NOW
    const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => now })
    const video = adapter(saved, 'video.drawn-5s')
    const csv = adapter(saved, 'csv.profile')
    const dispose = registry.register(video)
    registry.register(csv)
    const videoReceipt = sample(registry, saved, video)
    const csvReceipt = sample(registry, saved, csv)
    const selections = [
      { operationId: video.operationId, adapterId: video.adapterId,
        adapterVersion: video.adapterVersion, sampleDigestClaimId: videoReceipt.id },
      { operationId: csv.operationId, adapterId: csv.adapterId,
        adapterVersion: csv.adapterVersion, sampleDigestClaimId: csvReceipt.id },
    ]
    dispose()
    expect(registry.listBindings()).toHaveLength(1)
    expect(() => registry.admitPrivateCandidate(saved, selections)).toThrow('COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE')
    registry.register(video)
    expect(() => registry.admitPrivateCandidate(saved, selections)).toThrow('COMPUTE_PLUGIN_SAMPLE_STALE')
    now = NOW + 60 * 60 * 1000
    expect(() => registry.admitPrivateCandidate(saved, selections)).toThrow('COMPUTE_PLUGIN_SAMPLE_STALE')
    now = NOW + 2 * 60 * 60 * 1000
    expect(registry.listBindings()).toHaveLength(0)
    expect(() => registry.admitPrivateCandidate(saved, selections)).toThrow('COMPUTE_PLUGIN_ADAPTER_UNAVAILABLE')
  })

  it('rejects paths, URLs and command-shaped binding references before read-only listing', () => {
    const saved = draft()
    const base = adapter(saved, 'video.drawn-5s')
    const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => NOW })
    for (const bindingRef of ['/tmp/model', 'https://example.com/key', 'safe:../../secret',
      'safe:one/two', 'safe:$(whoami)', 'safe:ok\nprivate', 'file:secret', 'exec:run']) {
      expect(() => registry.register({ ...base, bindingRef })).toThrow('COMPUTE_PLUGIN_ADAPTER_INVALID')
    }
    expect(registry.listBindings()).toHaveLength(0)
    registry.register(base)
    expect(registry.listBindings()).toHaveLength(1)
  })

  it('bounds registrations and prunes expired entries before admitting a new one', () => {
    const saved = draft()
    const base = adapter(saved, 'video.drawn-5s')
    let now = NOW
    const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => now })
    for (let index = 0; index < 128; index += 1) {
      registry.register({ ...base, adapterId: `adapter.${index}` })
    }
    expect(registry.listBindings()).toHaveLength(128)
    expect(() => registry.register({ ...base, adapterId: 'adapter.extra' }))
      .toThrow('COMPUTE_PLUGIN_ADAPTER_CAPACITY')
    now = NOW + 2 * 60 * 60 * 1000
    registry.register({ ...base, adapterId: 'adapter.fresh', validUntilMs: now + 60_000 })
    expect(registry.listBindings()).toHaveLength(1)
  })

  it('bounds digest claims, removes expired claims and never revives them after clock rollback', () => {
    const saved = draft()
    const video = adapter(saved, 'video.drawn-5s')
    const csv = adapter(saved, 'csv.profile')
    let now = NOW
    const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => now })
    registry.register(video)
    registry.register(csv)
    const first = sample(registry, saved, video)
    for (let index = 1; index < 512; index += 1) sample(registry, saved, video)
    expect(() => sample(registry, saved, video)).toThrow('COMPUTE_PLUGIN_SAMPLE_CAPACITY')
    now = NOW + 60 * 60 * 1000
    const fresh = sample(registry, saved, csv)
    const selections = [
      { operationId: video.operationId, adapterId: video.adapterId,
        adapterVersion: video.adapterVersion, sampleDigestClaimId: first.id },
      { operationId: csv.operationId, adapterId: csv.adapterId,
        adapterVersion: csv.adapterVersion, sampleDigestClaimId: fresh.id },
    ]
    expect(() => registry.admitPrivateCandidate(saved, selections)).toThrow('COMPUTE_PLUGIN_SAMPLE_STALE')
    now = NOW
    expect(() => registry.admitPrivateCandidate(saved, selections)).toThrow('COMPUTE_PLUGIN_ADAPTER_CLOCK_ROLLBACK')
    expect(() => registry.listBindings()).toThrow('COMPUTE_PLUGIN_ADAPTER_CLOCK_ROLLBACK')
    now = NOW + 60 * 60 * 1000
    expect(() => registry.admitPrivateCandidate(saved, selections)).toThrow('COMPUTE_PLUGIN_SAMPLE_STALE')
  })
})
