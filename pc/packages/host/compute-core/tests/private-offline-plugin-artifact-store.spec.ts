import { afterEach, describe, expect, it } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HostPluginAdapterRegistry, type HostPluginAdapter } from '../src/plugin-adapter-admission.ts'
import { buildOfflinePluginArtifact, offlinePluginSampleSha256 } from '../src/offline-plugin-artifact.ts'
import { PrivateOfflinePluginArtifactStore } from '../src/private-offline-plugin-artifact-store.ts'
import { parsePluginDraftSpec, type LocalPluginDraft } from '../src/plugin-draft.ts'
import { pluginDraftPlanManifest } from '../src/plugin-draft-preview.ts'

const NOW = Date.parse('2026-09-24T10:00:00.000Z')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function privateRoot(): Promise<{ parent: string; root: string }> {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'qianshou-private-artifact-'))
  roots.push(parent)
  return { parent, root: join(parent, 'private-artifacts') }
}

function artifact(csv: string) {
  const spec = parsePluginDraftSpec({ pluginId: 'owner.csv-tool', version: '1.0.0',
    displayName: 'CSV tool', operations: [{
      id: 'csv.profile', title: 'CSV profile', description: 'Count supplied CSV rows.',
      binding: { kind: 'tool', ref: 'csv-profile:host-adapter' },
      inputSchema: { type: 'object', properties: { csv: { type: 'string' } },
        required: ['csv'], additionalProperties: false },
      outputSchema: { type: 'object', properties: { rowCount: { type: 'integer' } },
        required: ['rowCount'], additionalProperties: false },
      permissions: [], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
      resources: { platforms: ['darwin'], architectures: ['arm64'], minTotalMemoryBytes: 0,
        minFreeDiskBytes: 0, maxInputBytes: 4096, maxOutputBytes: 4096, maxRunMs: 10_000 },
    }] })
  const draft: LocalPluginDraft = { id: 'plugin_draft_00000000-0000-0000-0000-000000000003',
    createdAt: '2026-09-24T09:00:00.000Z', updatedAt: '2026-09-24T09:30:00.000Z',
    state: 'private-draft', installable: false, dispatchable: false,
    readiness: { adapter: 'pending', probe: 'pending', signing: 'pending', review: 'pending' }, spec }
  const operation = spec.operations[0]!
  const plan = pluginDraftPlanManifest(draft).operations[0]!
  const adapter: HostPluginAdapter = { adapterId: 'qianshou.csv-host', adapterVersion: '1.0.0',
    operationId: operation.id, bindingKind: operation.binding.kind, bindingRef: operation.binding.ref,
    inputSchemaSha256: plan.inputSchemaSha256, outputSchemaSha256: plan.outputSchemaSha256,
    permissions: operation.permissions, dataScope: operation.dataScope,
    networkOrigins: operation.networkOrigins, dependencies: operation.dependencies,
    resources: operation.resources, assets: [], validUntilMs: NOW + 2 * 60 * 60 * 1000 }
  const sample = { operationId: operation.id, input: { csv }, output: { rowCount: 1 } }
  const registry = new HostPluginAdapterRegistry({ platform: 'darwin', architecture: 'arm64', now: () => NOW })
  registry.register(adapter)
  const claim = registry.recordSampleDigestClaim({ draft, operationId: operation.id,
    adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion,
    inputSha256: offlinePluginSampleSha256(sample.input),
    outputSha256: offlinePluginSampleSha256(sample.output), assets: [] })
  const candidate = registry.admitPrivateCandidate(draft, [{ operationId: operation.id,
    adapterId: adapter.adapterId, adapterVersion: adapter.adapterVersion,
    sampleDigestClaimId: claim.id }])
  return buildOfflinePluginArtifact({ registry, draft, candidate, samples: [sample] })
}

describe('private offline plugin artifact store', () => {
  it('atomically saves and rechecks exact bytes with private modes and a sample-free receipt', async () => {
    const { root } = await privateRoot()
    const store = new PrivateOfflinePluginArtifactStore(root)
    const built = artifact('name\nAda')
    const stored = await store.persist(built)
    expect(stored).toMatchObject({ packageSha256: built.packageSha256,
      candidateSha256: built.candidateSha256, pluginId: 'owner.csv-tool',
      state: 'stored-private-uninstalled', executionVerified: false,
      installable: false, dispatchable: false })
    expect(JSON.stringify(stored)).not.toContain('Ada')
    expect(JSON.stringify(stored)).not.toContain(root)
    expect(await store.inspect(built.packageSha256, built.candidateSha256)).toEqual(stored)
    expect((await lstat(root)).mode & 0o777).toBe(0o700)
    const entries = await readdir(root)
    expect(entries).toEqual([`artifact-${built.packageSha256}.zip`])
    expect((await lstat(join(root, entries[0]!))).mode & 0o777).toBe(0o600)
  })

  it('is idempotent for concurrent identical bytes and isolates different digests through removal', async () => {
    const { root } = await privateRoot()
    const store = new PrivateOfflinePluginArtifactStore(root)
    const first = artifact('name\nAda')
    const second = artifact('name\nBen')
    const receipts = await Promise.all(Array.from({ length: 5 }, () => store.persist(first)))
    expect(receipts.every(receipt => JSON.stringify(receipt) === JSON.stringify(receipts[0]))).toBe(true)
    expect(await readdir(root)).toEqual([`artifact-${first.packageSha256}.zip`])
    const other = await store.persist(second)
    expect(other.packageSha256).not.toBe(first.packageSha256)
    expect((await readdir(root)).filter(name => name.endsWith('.zip'))).toHaveLength(2)
    const removed = await store.remove(first.packageSha256, first.candidateSha256)
    expect(removed.state).toBe('removed-private')
    await expect(store.inspect(first.packageSha256, first.candidateSha256))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_NOT_FOUND' })
    expect(await store.inspect(second.packageSha256, second.candidateSha256)).toEqual(other)
    expect(await readdir(root)).toEqual([`artifact-${second.packageSha256}.zip`])
  })

  it('rejects tampering, symlinks, traversal and an unsafe existing root without overwriting them', async () => {
    const { parent, root } = await privateRoot()
    const store = new PrivateOfflinePluginArtifactStore(root)
    const built = artifact('name\nAda')
    expect(() => new PrivateOfflinePluginArtifactStore(`${parent}/a/../elsewhere`))
      .toThrow('COMPUTE_PRIVATE_ARTIFACT_ROOT_INVALID')
    await expect(store.inspect('../outside', built.candidateSha256))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_DIGEST_INVALID' })
    await expect(store.persist({ ...built, packageSha256: '0'.repeat(64) }))
      .rejects.toMatchObject({ code: 'COMPUTE_OFFLINE_PLUGIN_ARTIFACT_INVALID' })
    await store.persist(built)
    const path = join(root, `artifact-${built.packageSha256}.zip`)
    await chmod(path, 0o644)
    await expect(store.inspect(built.packageSha256, built.candidateSha256))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_CHANGED' })
    await chmod(path, 0o600)
    const altered = Buffer.from(built.bytes)
    altered[80] = altered[80]! ^ 1
    await writeFile(path, altered)
    await expect(store.inspect(built.packageSha256, built.candidateSha256))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_CHANGED' })
    await writeFile(path, 'tampered')
    await expect(store.inspect(built.packageSha256, built.candidateSha256))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_CHANGED' })
    await expect(store.persist(built)).rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_CHANGED' })
    expect(await readFile(path, 'utf8')).toBe('tampered')
    await rm(path)
    const outside = join(parent, 'outside.txt')
    await writeFile(outside, 'private outside')
    await symlink(outside, path)
    await expect(store.persist(built)).rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_CHANGED' })
    expect(await readFile(outside, 'utf8')).toBe('private outside')
    expect((await readdir(root)).filter(name => name.includes('.tmp'))).toHaveLength(0)
    const alias = join(parent, 'alias')
    await symlink(root, alias)
    await expect(new PrivateOfflinePluginArtifactStore(alias).persist(built))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_ROOT_UNSAFE' })
    const publicRoot = join(parent, 'public')
    await mkdir(publicRoot, { mode: 0o755 })
    await chmod(publicRoot, 0o755)
    await expect(new PrivateOfflinePluginArtifactStore(publicRoot).persist(built))
      .rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_ROOT_UNSAFE' })
    expect((await lstat(publicRoot)).mode & 0o777).toBe(0o755)
  })

  it('cleans staging after a late write failure and can retry without changing the digest', async () => {
    const { root } = await privateRoot()
    const store = new PrivateOfflinePluginArtifactStore(root)
    const built = artifact('name\nAda')
    const seam = store as unknown as { syncRoot: () => Promise<void> }
    const original = seam.syncRoot
    seam.syncRoot = async () => { throw new Error('injected sync failure') }
    await expect(store.persist(built)).rejects.toMatchObject({ code: 'COMPUTE_PRIVATE_ARTIFACT_IO_FAILED' })
    seam.syncRoot = original
    expect((await readdir(root)).filter(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toHaveLength(0)
    const recovered = await store.persist(built)
    expect(recovered.packageSha256).toBe(built.packageSha256)
  })
})
