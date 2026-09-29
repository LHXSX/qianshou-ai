import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildOfflinePluginDeclaration } from '../src/offline-plugin-declaration.ts'
import { parsePluginDraftSpec, type LocalPluginDraft, type PluginDraftResources } from '../src/plugin-draft.ts'

function verifyInGuangzhou(bytes: Buffer): Record<string, unknown> {
  // Guangzhou is a separate sparse project without a tsconfig. Use its own Node loader.
  const moduleUrl = new URL('../../../../../广州工作台/packages/host/model-gateway/src/plugin-seed-package.ts', import.meta.url)
  const script = `import { verifyDeclarationPluginPackage } from ${JSON.stringify(moduleUrl.href)};
    const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk);
    process.stdout.write(JSON.stringify(verifyDeclarationPluginPackage(Buffer.concat(chunks))));`
  const run = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', script],
    { input: bytes, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (run.status !== 0) throw new Error(`Guangzhou verifier failed: ${run.stderr}`)
  return JSON.parse(run.stdout) as Record<string, unknown>
}

const resources: PluginDraftResources = { platforms: ['darwin'], architectures: ['arm64'], minTotalMemoryBytes: 0,
  minFreeDiskBytes: 0, maxInputBytes: 4096, maxOutputBytes: 4096, maxRunMs: 10_000 }
function draft(): LocalPluginDraft {
  const spec = parsePluginDraftSpec({ pluginId: 'creator.media-tools', version: '1.0.0',
    displayName: 'Private media tools', operations: [
      { id: 'video.draw', title: 'Draw video', description: 'Do not export /Users/private/project',
        binding: { kind: 'workflow', ref: 'drawn-video:reviewed' },
        inputSchema: { type: 'object', description: 'secret-demo-token and /Users/private',
          properties: { title: { type: 'string', description: 'do not upload secret-demo-token' } },
          required: ['title'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } },
          required: ['attachmentId'], additionalProperties: false },
        permissions: ['workspace.write'], dataScope: 'task-inputs', networkOrigins: [], dependencies: [], resources },
      { id: 'text.local', title: 'Local model', description: 'Transform text.',
        binding: { kind: 'local-model', ref: 'local-model:reviewed' },
        inputSchema: { type: 'object', properties: { prompt: { type: 'string' } },
          required: ['prompt'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { text: { type: 'string' } },
          required: ['text'], additionalProperties: false },
        permissions: ['model.local'], dataScope: 'task-inputs', networkOrigins: [], dependencies: [], resources },
    ] })
  return { id: 'plugin_draft_00000000-0000-0000-0000-000000000002',
    createdAt: '2026-09-24T08:00:00.000Z', updatedAt: '2026-09-24T08:30:00.000Z',
    state: 'private-draft', installable: false, dispatchable: false,
    readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec }
}

describe('offline generic declaration export', () => {
  it('produces a deterministic archive accepted by the Guangzhou verifier without private data', () => {
    const input = { draft: draft(), capabilityIds: { 'video.draw': 'media.video', 'text.local': 'text.transform' } }
    const first = buildOfflinePluginDeclaration(input)
    const second = buildOfflinePluginDeclaration(input)
    expect(first.bytes.equals(second.bytes)).toBe(true)
    expect(first).toMatchObject({ state: 'built-offline-unsubmitted', uploaded: false,
      reviewed: false, publishable: false, dispatchable: false })
    expect(first.manifest.operations.map(item => [item.capabilityId, item.executorKind])).toEqual([
      ['media.video', 'workflow'], ['text.transform', 'model'],
    ])
    const guangzhou = verifyInGuangzhou(first.bytes)
    expect(guangzhou.manifest).toEqual(first.manifest)
    expect(guangzhou.packageSha256).toBe(first.packageSha256)
    expect(guangzhou.unpackedTreeSha256).toBe(first.unpackedTreeSha256)
    for (const forbidden of ['secret-demo-token', '/Users/private', 'drawn-video:reviewed',
      'local-model:reviewed', 'Private media tools', 'sample-input', 'networkOrigins']) {
      expect(first.bytes.includes(Buffer.from(forbidden))).toBe(false)
    }
  })

  it('requires explicit capability claims and compatible platform, version and ID syntax', () => {
    const valid = draft()
    expect(() => buildOfflinePluginDeclaration({ draft: valid,
      capabilityIds: { 'video.draw': 'media.video' } })).toThrow('COMPUTE_PLUGIN_DECLARATION_INVALID')
    expect(() => buildOfflinePluginDeclaration({ draft: valid,
      capabilityIds: { 'wrong.operation': 'media.video', 'text.local': 'text.transform' } }))
      .toThrow('COMPUTE_PLUGIN_DECLARATION_INVALID')
    expect(() => buildOfflinePluginDeclaration({ draft: valid,
      capabilityIds: { 'video.draw': 'media.video', 'text.local': 'bad/path' } }))
      .toThrow('COMPUTE_PLUGIN_DECLARATION_INVALID')
    expect(() => buildOfflinePluginDeclaration({ draft: { ...valid,
      spec: { ...valid.spec, pluginId: 'creator_private' } },
      capabilityIds: { 'video.draw': 'media.video', 'text.local': 'text.transform' } }))
      .toThrow('COMPUTE_PLUGIN_DECLARATION_INVALID')
    const incompatible = { ...valid, spec: { ...valid.spec, operations: [valid.spec.operations[0]!,
      { ...valid.spec.operations[1]!, resources: { ...resources, platforms: ['win32'] as const } }] } }
    expect(() => buildOfflinePluginDeclaration({ draft: incompatible,
      capabilityIds: { 'video.draw': 'media.video', 'text.local': 'text.transform' } }))
      .toThrow('COMPUTE_PLUGIN_DECLARATION_INVALID')
  })

  it('maps a tool without treating it as a fixed CSV adapter, and rejects unrepresentable review claims', () => {
    const valid = draft()
    const second = { ...valid.spec.operations[1]!, binding: { kind: 'tool' as const, ref: 'local-tool:reviewed' },
      permissions: [] }
    const toolDraft = { ...valid, spec: { ...valid.spec,
      operations: [valid.spec.operations[0]!, second] } }
    const tool = buildOfflinePluginDeclaration({ draft: toolDraft,
      capabilityIds: { 'video.draw': 'media.video', 'text.local': 'text.transform' } })
    expect(verifyInGuangzhou(tool.bytes).manifest).toEqual(tool.manifest)
    expect(tool.manifest.operations[1]?.executorKind).toBe('tool')
    const network = { ...valid, spec: { ...valid.spec, operations: [
      { ...valid.spec.operations[0]!, permissions: ['workspace.write', 'network.declared'] as const,
        networkOrigins: ['https://api.example.com'] }, valid.spec.operations[1]!,
    ] } }
    expect(() => buildOfflinePluginDeclaration({ draft: network,
      capabilityIds: { 'video.draw': 'media.video', 'text.local': 'text.transform' } }))
      .toThrow('COMPUTE_PLUGIN_DECLARATION_INVALID')
    const dependency = { ...valid, spec: { ...valid.spec, operations: [
      { ...valid.spec.operations[0]!, dependencies: [{ id: 'plugin.other', version: '1.0.0' }] },
      valid.spec.operations[1]!,
    ] } }
    expect(() => buildOfflinePluginDeclaration({ draft: dependency,
      capabilityIds: { 'video.draw': 'media.video', 'text.local': 'text.transform' } }))
      .toThrow('COMPUTE_PLUGIN_DECLARATION_INVALID')
    const workspaceScope = { ...valid, spec: { ...valid.spec, operations: [
      { ...valid.spec.operations[0]!, dataScope: 'workspace' as const }, valid.spec.operations[1]!,
    ] } }
    expect(() => buildOfflinePluginDeclaration({ draft: workspaceScope,
      capabilityIds: { 'video.draw': 'media.video', 'text.local': 'text.transform' } }))
      .toThrow('COMPUTE_PLUGIN_DECLARATION_INVALID')
  })
})
