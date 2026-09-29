import { lstat, mkdir, readFile, readdir, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArchivePluginPackageSource,
  InMemoryPluginLoaderRegistry,
  LocalPluginInstaller,
  StaticPluginPackageSource,
  type PluginIdentity,
  type PluginInstallationReceipt,
  type PluginLoaderRegistry,
  type StagedPluginFile,
} from '../src/index.ts'
import { LIMITS, cleanupTempRoots, expectRejection, pluginFixture, tempRoot } from './market-fixture.ts'
import { buildZip } from './zip-builder.ts'

const identity: PluginIdentity = { pluginId: 'image.local', version: '1.0.0' }
const text = (value: string): Buffer => Buffer.from(value, 'utf8')

async function names(path: string): Promise<string[]> {
  try { return (await readdir(path)).sort() } catch { return [] }
}

async function writeGeneration(root: string, key: string, generation: string, files: readonly StagedPluginFile[]): Promise<string> {
  const directory = join(root, 'generations', key, generation)
  for (const file of files) {
    const path = join(directory, file.path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, file.bytes)
  }
  return directory
}

async function writeJournal(root: string, key: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(join(root, 'journal'), { recursive: true })
  await writeFile(join(root, 'journal', `${key}.json`), JSON.stringify(value))
}

function journalOf(fixture: { plan: { manifest: { pluginId: string; version: string }; packageDigest: string; manifestFingerprint: string }; generation: string }, staging = 'a'.repeat(24)): Record<string, unknown> {
  return { formatVersion: 1, pluginId: fixture.plan.manifest.pluginId, version: fixture.plan.manifest.version,
    packageDigest: fixture.plan.packageDigest, manifestFingerprint: fixture.plan.manifestFingerprint,
    generation: fixture.generation, staging }
}

afterEach(async () => { await cleanupTempRoots() })

describe('LocalPluginInstaller installation', () => {
  it('installs a verified package atomically and records a durable receipt', async () => {
    const root = await tempRoot()
    const registry = new InMemoryPluginLoaderRegistry()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry })
    const fixture = await pluginFixture()
    const { receipt, reused } = await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))

    expect(reused).toBe(false)
    expect(receipt).toMatchObject({
      formatVersion: 1, pluginId: 'image.local', version: '1.0.0',
      packageDigest: fixture.plan.packageDigest, manifestFingerprint: fixture.plan.manifestFingerprint,
      generation: fixture.generation, entryId: 'image-local', loaderSpecifier: 'image-local',
      registryKind: 'in-memory', sourceKind: 'static', replaced: false,
    })
    expect(receipt.files).toEqual(['assets/spec.json', 'entry.js'])
    expect(receipt.grantedPermissions).toEqual(['model.local'])
    expect(receipt.assets).toEqual([{ path: 'assets/spec.json', bytes: 15, sha256: receipt.assets[0]!.sha256 }])

    // The payload reached disk byte-for-byte and nothing else is left behind.
    const generationDirectory = join(root, 'generations', fixture.identityKey, fixture.generation)
    expect((await readdir(generationDirectory)).sort()).toEqual(['assets', 'entry.js'])
    expect(await readFile(join(generationDirectory, 'entry.js'))).toEqual(text('export const capability = 1'))
    expect(await names(join(root, '.staging'))).toEqual([])
    expect(await names(join(root, 'journal'))).toEqual([])
    expect(await names(join(root, 'receipts'))).toEqual([`${fixture.identityKey}.json`])
    expect(await names(join(root, 'generations', fixture.identityKey))).toEqual([fixture.generation])
    // The installer reports the canonical root: macOS resolves /var to /private/var.
    expect(await installer.directoryOf(receipt)).toBe(await realpath(generationDirectory))
    expect(await installer.getInstallation(identity)).toMatchObject({ packageDigest: fixture.plan.packageDigest })
    expect(await installer.verifyInstallation(identity)).toBe(true)
    expect(registry.get(identity)?.specifier).toBe('image-local')
    expect(registry.get(identity)?.directory).toBe(await realpath(generationDirectory))
  })

  it('installs from a real local archive', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const fixture = await pluginFixture()
    const archivePath = join(await tempRoot(), 'package.zip')
    await writeFile(archivePath, buildZip(fixture.payload.map(file => ({ name: file.path, bytes: file.bytes, method: 8 }))))
    const { receipt } = await installer.install(fixture.plan, new ArchivePluginPackageSource(archivePath))
    expect(receipt.sourceKind).toBe('archive')
    expect(await installer.verifyInstallation(identity)).toBe(true)
  })

  it('repeats an install idempotently without rewriting the payload', async () => {
    const root = await tempRoot()
    const registry = new InMemoryPluginLoaderRegistry()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry })
    const fixture = await pluginFixture()
    const first = await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    const generationDirectory = join(root, 'generations', fixture.identityKey, fixture.generation)
    const before = (await lstat(generationDirectory)).mtimeMs
    const second = await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))

    expect(second.reused).toBe(true)
    expect(second.receipt.installedAt).toBe(first.receipt.installedAt)
    expect((await lstat(generationDirectory)).mtimeMs).toBe(before)
    expect(await names(join(root, 'generations', fixture.identityKey))).toEqual([fixture.generation])
    expect(registry.list()).toHaveLength(1)
    expect(await names(join(root, '.staging'))).toEqual([])
  })

  it('replaces a previous generation and prunes it under the default retention', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const first = await pluginFixture()
    await installer.install(first.plan, new StaticPluginPackageSource(first.payload))
    const upgrade = await pluginFixture({
      pluginId: 'image.local',
      version: '1.0.0',
      payload: [
        { path: 'entry.js', bytes: text('export const capability = 2') },
        { path: 'assets/spec.json', bytes: text('{"kind":"spec-2"}') },
      ],
    })
    const { receipt, reused } = await installer.install(upgrade.plan, new StaticPluginPackageSource(upgrade.payload))

    expect(reused).toBe(false)
    expect(receipt.replaced).toBe(true)
    expect(receipt.packageDigest).toBe(upgrade.plan.packageDigest)
    expect(await names(join(root, 'generations', first.identityKey))).toEqual([upgrade.generation])
    expect(await installer.getInstallation(identity)).toMatchObject({ packageDigest: upgrade.plan.packageDigest })
  })

  it('keeps the requested number of generations for an explicit rollback window', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry(), retainGenerations: 2 })
    const first = await pluginFixture()
    await installer.install(first.plan, new StaticPluginPackageSource(first.payload))
    const upgrade = await pluginFixture({ payload: [{ path: 'entry.js', bytes: text('second') }], declaredAssets: [] })
    await installer.install(upgrade.plan, new StaticPluginPackageSource(upgrade.payload))
    expect((await names(join(root, 'generations', first.identityKey))).sort()).toEqual([first.generation, upgrade.generation].sort())
  })

  it('reuses an already committed generation when the receipt was lost', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const fixture = await pluginFixture()
    await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    await unlink(join(root, 'receipts', `${fixture.identityKey}.json`))
    const { receipt, reused } = await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    expect(reused).toBe(false)
    expect(receipt.generation).toBe(fixture.generation)
    expect(await names(join(root, 'generations', fixture.identityKey))).toEqual([fixture.generation])
  })

  it('leaves no partial state when the loader seam rejects the registration', async () => {
    const root = await tempRoot()
    const registry = new InMemoryPluginLoaderRegistry(() => '../escape')
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry })
    const fixture = await pluginFixture()
    await expectRejection(installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload)), 'PLUGIN_ENTRY_SPECIFIER_INVALID')
    expect(await names(join(root, 'receipts'))).toEqual([])
    expect(await names(join(root, 'journal'))).toEqual([])
    expect(await names(join(root, '.staging'))).toEqual([])
    expect(await names(join(root, 'generations', fixture.identityKey))).toEqual([])
  })

  it('rejects an oversized package before writing package data', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: { maxFileCount: 1, maxFileBytes: 4, maxPackageBytes: 8 }, registry: new InMemoryPluginLoaderRegistry() })
    const fixture = await pluginFixture()
    await expectRejection(installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload)), 'PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    expect(await names(join(root, 'receipts'))).toEqual([])
    expect(await names(join(root, 'generations', fixture.identityKey))).toEqual([])
  })

  it('validates its own options and the inspected identity', async () => {
    const root = await tempRoot()
    const registry = new InMemoryPluginLoaderRegistry()
    expect(() => new LocalPluginInstaller({ root, limits: { maxFileCount: 0, maxFileBytes: 1, maxPackageBytes: 1 }, registry }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_PACKAGE_LIMIT_INVALID' }))
    expect(() => new LocalPluginInstaller({ root, limits: LIMITS, registry, retainGenerations: 0 }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_INSTALLER_OPTIONS_INVALID' }))
    expect(() => new LocalPluginInstaller({ root, limits: LIMITS, registry: {} as PluginLoaderRegistry }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_INSTALLER_OPTIONS_INVALID' }))
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry })
    await expectRejection(installer.getInstallation({ pluginId: '', version: '1.0.0' }), 'PLUGIN_IDENTITY_INVALID')
  })

  it('lists every stored receipt for restart-time re-advertisement', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const first = await pluginFixture()
    const second = await pluginFixture({ pluginId: 'documents.local', payload: [{ path: 'entry.js', bytes: text('documents') }], declaredAssets: [] })
    await installer.install(first.plan, new StaticPluginPackageSource(first.payload))
    await installer.install(second.plan, new StaticPluginPackageSource(second.payload))
    const receipts = await installer.listInstallations()
    expect(receipts.map((receipt: PluginInstallationReceipt) => receipt.pluginId).sort()).toEqual(['documents.local', 'image.local'])
    expect(await names(join(root, 'receipts'))).toHaveLength(2)
  })
})

describe('LocalPluginInstaller crash recovery', () => {
  it('removes an unreferenced staging directory left before the journal write', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const staging = join(root, '.staging', 'b'.repeat(24), 'payload')
    await mkdir(staging, { recursive: true })
    await writeFile(join(staging, 'entry.js'), 'half written')
    const report = await installer.recover()
    expect(report.removedStaging).toEqual(['b'.repeat(24)])
    expect(await names(join(root, '.staging'))).toEqual([])
  })

  it('rolls back a promotion that never reached a receipt and keeps the prior install', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const committed = await pluginFixture()
    await installer.install(committed.plan, new StaticPluginPackageSource(committed.payload))
    const aborted = await pluginFixture({ payload: [{ path: 'entry.js', bytes: text('aborted') }], declaredAssets: [] })
    await writeGeneration(root, aborted.identityKey, aborted.generation, aborted.payload)
    await writeJournal(root, aborted.identityKey, journalOf(aborted, 'c'.repeat(24)))

    const report = await installer.recover()
    expect(report.rolledBackGenerations).toEqual([`${aborted.identityKey}/${aborted.generation}`])
    expect(report.droppedJournals).toEqual([aborted.identityKey])
    expect(report.verifiedInstallations).toEqual([committed.identityKey])
    expect(report.invalidInstallations).toEqual([])
    expect(await names(join(root, 'generations', aborted.identityKey))).toEqual([committed.generation])
    expect(await installer.verifyInstallation(identity)).toBe(true)
    expect(await installer.getInstallation(identity)).toMatchObject({ packageDigest: committed.plan.packageDigest })
    expect(await names(join(root, 'journal'))).toEqual([])
  })

  it('drops the journal of a transaction that already committed', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const fixture = await pluginFixture()
    await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    await writeJournal(root, fixture.identityKey, journalOf(fixture))

    const report = await installer.recover()
    expect(report.droppedJournals).toEqual([fixture.identityKey])
    expect(report.verifiedInstallations).toEqual([fixture.identityKey])
    expect(report.rolledBackGenerations).toEqual([])
    expect(await installer.verifyInstallation(identity)).toBe(true)
  })

  it('retracts an installation whose payload no longer verifies and unblocks a fresh install', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const fixture = await pluginFixture()
    await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    await writeFile(join(root, 'generations', fixture.identityKey, fixture.generation, 'entry.js'), 'tampered on disk')

    expect(await installer.verifyInstallation(identity)).toBe(false)
    const report = await installer.recover()
    expect(report.invalidInstallations).toEqual([fixture.identityKey])
    expect(await installer.getInstallation(identity)).toBeUndefined()
    expect(await names(join(root, 'generations', fixture.identityKey))).toEqual([])
    const { receipt } = await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    expect(await installer.verifyInstallation(identity)).toBe(true)
    expect(receipt.packageDigest).toBe(fixture.plan.packageDigest)
  })

  it('refuses to start an install while a crashed transaction still needs recovery', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    const fixture = await pluginFixture()
    await writeJournal(root, fixture.identityKey, journalOf(fixture, 'd'.repeat(24)))
    await expectRejection(installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload)), 'PLUGIN_INSTALLER_RECOVERY_REQUIRED')
    await installer.recover()
    const { receipt } = await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    expect(receipt.packageDigest).toBe(fixture.plan.packageDigest)
  })

  it('rejects a corrupted journal instead of guessing', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    await writeJournal(root, 'e'.repeat(64), { formatVersion: 1, generation: 'not-a-generation' })
    await expectRejection(installer.recover(), 'PLUGIN_INSTALLER_JOURNAL_INVALID')
  })

  it('reports an empty root as a clean recovery', async () => {
    const installer = new LocalPluginInstaller({ root: await tempRoot(), limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    await expect(installer.recover()).resolves.toEqual({
      removedStaging: [], rolledBackGenerations: [], removedOrphanGenerations: [],
      droppedJournals: [], verifiedInstallations: [], invalidInstallations: [],
    })
  })
})

describe('LocalPluginInstaller uninstall and revocation', () => {
  it('revokes advertisement, drains in-flight work and only then deletes files', async () => {
    const root = await tempRoot()
    const registry = new InMemoryPluginLoaderRegistry()
    const order: string[] = []
    let payloadPresentDuringDrain = false
    const fixture = await pluginFixture()
    const installer = new LocalPluginInstaller({
      root, limits: LIMITS, registry,
      awaitInFlight: async () => {
        order.push('drain')
        payloadPresentDuringDrain = (await names(join(root, 'generations', fixture.identityKey, fixture.generation))).length > 0
        order.push(registry.get(identity) === undefined ? 'revoked-before-drain' : 'still-advertised')
      },
    })
    await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    const result = await installer.uninstall(identity)

    expect(result).toEqual({ removed: true, revoked: true, drained: true })
    expect(order).toEqual(['drain', 'revoked-before-drain'])
    expect(payloadPresentDuringDrain).toBe(true)
    expect(registry.list()).toEqual([])
    expect(await installer.getInstallation(identity)).toBeUndefined()
    expect(await names(join(root, 'generations', fixture.identityKey))).toEqual([])
    expect(await names(join(root, 'receipts'))).toEqual([])
    await expect(installer.uninstall(identity)).resolves.toEqual({ removed: false, revoked: false, drained: false })
  })

  it('uninstalls an unknown identity without touching advertisement', async () => {
    const root = await tempRoot()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry: new InMemoryPluginLoaderRegistry() })
    await expect(installer.uninstall({ pluginId: 'missing.plugin', version: '1.0.0' })).resolves.toEqual({ removed: false, revoked: false, drained: false })
  })

  it('removes the receipt before the payload so a crash cannot advertise dead bytes', async () => {
    const root = await tempRoot()
    const registry = new InMemoryPluginLoaderRegistry()
    const fixture = await pluginFixture()
    const installer = new LocalPluginInstaller({ root, limits: LIMITS, registry })
    await installer.install(fixture.plan, new StaticPluginPackageSource(fixture.payload))
    await installer.uninstall(identity)
    const report = await installer.recover()
    expect(report).toEqual({ removedStaging: [], rolledBackGenerations: [], removedOrphanGenerations: [],
      droppedJournals: [], verifiedInstallations: [], invalidInstallations: [] })
  })
})
