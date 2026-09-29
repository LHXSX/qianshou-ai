import { mkdir, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ArchivePluginPackageSource,
  DirectoryPluginPackageSource,
  StaticPluginPackageSource,
  loadVerifiedPluginPackage,
  type PluginPackageEntry,
  type PluginPackageSource,
} from '../src/index.ts'
import { LIMITS, cleanupTempRoots, expectRejection, pluginFixture, tempRoot } from './market-fixture.ts'
import { buildZip } from './zip-builder.ts'

const text = (value: string): Buffer => Buffer.from(value, 'utf8')
const source = (entries: readonly PluginPackageEntry[], kind = 'static'): PluginPackageSource => new StaticPluginPackageSource(entries, kind)

afterEach(async () => { await cleanupTempRoots() })

describe('loadVerifiedPluginPackage', () => {
  it('accepts a payload that matches the signed digest and declared assets', async () => {
    const { plan, payload } = await pluginFixture()
    const verified = await loadVerifiedPluginPackage(source(payload), plan, { limits: LIMITS })
    expect(verified.staged.packageDigest).toBe(plan.packageDigest)
    // Intake returns canonical (sorted) order, not source order.
    expect(verified.staged.allowedFiles).toEqual(['assets/spec.json', 'entry.js'])
    expect(verified.assets.map(asset => asset.path)).toEqual(['assets/spec.json'])
    expect(verified.entryId).toBe('image-local')
    expect(verified.sourceKind).toBe('static')
  })

  it('rejects a tampered, missing or extra payload file through the digest gate', async () => {
    const { plan, payload } = await pluginFixture()
    await expectRejection(loadVerifiedPluginPackage(source([{ path: 'entry.js', bytes: text('tampered') }]), plan, { limits: LIMITS }), 'PLUGIN_DIGEST_MISMATCH')
    await expectRejection(loadVerifiedPluginPackage(source(payload.slice(0, 1)), plan, { limits: LIMITS }), 'PLUGIN_DIGEST_MISMATCH')
    await expectRejection(loadVerifiedPluginPackage(source([...payload, { path: 'extra.bin', bytes: new Uint8Array() }]), plan, { limits: LIMITS }), 'PLUGIN_DIGEST_MISMATCH')
    await expectRejection(loadVerifiedPluginPackage(source([]), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_EMPTY')
  })

  it('rejects duplicate entry paths before the digest comparison', async () => {
    const { plan } = await pluginFixture({ payload: [{ path: 'entry.js', bytes: text('only') }] })
    await expectRejection(loadVerifiedPluginPackage(source([
      { path: 'entry.js', bytes: text('only') },
      { path: 'entry.js', bytes: text('only') },
    ]), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_DUPLICATE_FILE')
  })

  it('rejects traversal, absolute and non-canonical paths from any source', async () => {
    const { plan } = await pluginFixture()
    for (const path of ['../escape.js', '/etc/passwd', 'assets/../../escape.js', 'C:outside.txt', 'assets\\spec.json', './entry.js', 'dir/']) {
      await expectRejection(loadVerifiedPluginPackage(source([{ path, bytes: text('x') }]), plan, { limits: LIMITS }), 'PLUGIN_PATH_INVALID')
    }
  })

  it('enforces file count, per-file and total byte budgets', async () => {
    const { plan } = await pluginFixture()
    await expectRejection(loadVerifiedPluginPackage(source([{ path: 'big.bin', bytes: Buffer.alloc(LIMITS.maxFileBytes + 1) }]), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    await expectRejection(loadVerifiedPluginPackage(source(Array.from({ length: LIMITS.maxFileCount + 1 }, (_value, index) => ({ path: `file-${index}.bin`, bytes: new Uint8Array() }))), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_LIMIT_EXCEEDED')
    await expectRejection(loadVerifiedPluginPackage(source([{ path: 'a.bin', bytes: Buffer.alloc(4000) }, { path: 'b.bin', bytes: Buffer.alloc(4000) }, { path: 'c.bin', bytes: Buffer.alloc(4000) }, { path: 'd.bin', bytes: Buffer.alloc(4000) }, { path: 'e.bin', bytes: Buffer.alloc(4000) }]), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_LIMIT_EXCEEDED')
  })

  it('rejects a manifest-declared asset whose size or digest does not match the payload', async () => {
    const payload = [{ path: 'assets/spec.json', bytes: text('{"kind":"spec"}') }]
    const wrongSize = await pluginFixture({ payload, declaredAssets: [{ path: 'assets/spec.json', bytes: 999, sha256: 'a'.repeat(64) }] })
    await expectRejection(loadVerifiedPluginPackage(source(payload), wrongSize.plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_ASSET_SIZE_MISMATCH')
    const wrongDigest = await pluginFixture({ payload, declaredAssets: [{ path: 'assets/spec.json', bytes: 15, sha256: 'b'.repeat(64) }] })
    await expectRejection(loadVerifiedPluginPackage(source(payload), wrongDigest.plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_ASSET_DIGEST_MISMATCH')
    const missingAsset = await pluginFixture({ payload, declaredAssets: [{ path: 'assets/missing.bin', bytes: 1, sha256: 'c'.repeat(64) }] })
    await expectRejection(loadVerifiedPluginPackage(source(payload), missingAsset.plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_ASSET_MISSING')
  })

  it('refuses a payload larger than the contract budget declared in the manifest', async () => {
    const payload = [{ path: 'entry.js', bytes: Buffer.alloc(2048) }]
    const { plan } = await pluginFixture({ payload, maxBundleBytes: 1024 })
    await expectRejection(loadVerifiedPluginPackage(source(payload), plan, { limits: LIMITS }), 'COMPUTE_PLUGIN_BUNDLE_TOO_LARGE')
  })

  it('reports an invalid limit declaration before touching the source', async () => {
    const { plan } = await pluginFixture()
    await expectRejection(loadVerifiedPluginPackage(source([{ path: 'entry.js', bytes: text('x') }]), plan, { limits: { maxFileCount: 0, maxFileBytes: 1, maxPackageBytes: 1 } }), 'PLUGIN_PACKAGE_LIMIT_INVALID')
  })
})

describe('DirectoryPluginPackageSource', () => {
  it('reads nested files with canonical relative paths', async () => {
    const root = await tempRoot()
    const directory = join(root, 'package')
    await mkdir(join(directory, 'assets'), { recursive: true })
    await writeFile(join(directory, 'entry.js'), 'entry')
    await writeFile(join(directory, 'assets', 'spec.json'), '{}')
    const { plan } = await pluginFixture({ payload: [
      { path: 'entry.js', bytes: text('entry') },
      { path: 'assets/spec.json', bytes: text('{}') },
    ] })
    const verified = await loadVerifiedPluginPackage(new DirectoryPluginPackageSource(directory), plan, { limits: LIMITS })
    expect(verified.staged.files.map(file => file.path)).toEqual(['assets/spec.json', 'entry.js'])
    expect(verified.sourceKind).toBe('directory')
  })

  it('rejects a symlink anywhere inside the package', async () => {
    const root = await tempRoot()
    const directory = join(root, 'package')
    await mkdir(directory, { recursive: true })
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'do not read')
    await symlink(outside, join(directory, 'link.js'))
    const { plan } = await pluginFixture({ payload: [{ path: 'link.js', bytes: text('do not read') }] })
    await expectRejection(loadVerifiedPluginPackage(new DirectoryPluginPackageSource(directory), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_LINK_REJECTED')
  })

  it('rejects a package directory that is itself a symlink or a file', async () => {
    const root = await tempRoot()
    const real = join(root, 'real')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'entry.js'), 'entry')
    const link = join(root, 'link')
    await symlink(real, link)
    const file = join(root, 'package.txt')
    await writeFile(file, 'not a directory')
    const { plan } = await pluginFixture()
    await expectRejection(loadVerifiedPluginPackage(new DirectoryPluginPackageSource(link), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_SOURCE_INVALID')
    await expectRejection(loadVerifiedPluginPackage(new DirectoryPluginPackageSource(file), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_SOURCE_INVALID')
    await expectRejection(loadVerifiedPluginPackage(new DirectoryPluginPackageSource(join(root, 'missing')), plan, { limits: LIMITS }), 'ENOENT')
  })

  it('enforces the per-file budget while walking', async () => {
    const root = await tempRoot()
    const directory = join(root, 'package')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'big.bin'), Buffer.alloc(LIMITS.maxFileBytes + 1))
    const { plan } = await pluginFixture()
    await expectRejection(loadVerifiedPluginPackage(new DirectoryPluginPackageSource(directory), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_LIMIT_EXCEEDED')
  })
})

describe('ArchivePluginPackageSource', () => {
  it('installs from a real local archive', async () => {
    const { plan, payload } = await pluginFixture()
    const root = await tempRoot()
    const archivePath = join(root, 'package.zip')
    await writeFile(archivePath, buildZip([
      { name: 'entry.js', bytes: payload[0]!.bytes, method: 8 },
      { name: 'assets/spec.json', bytes: payload[1]!.bytes, method: 8 },
    ]))
    const verified = await loadVerifiedPluginPackage(new ArchivePluginPackageSource(archivePath), plan, { limits: LIMITS })
    expect(verified.staged.files.map(file => file.path)).toEqual(['assets/spec.json', 'entry.js'])
    expect(verified.sourceKind).toBe('archive')
  })

  it('rejects an archive smuggling a symlink or a traversal entry', async () => {
    const { plan } = await pluginFixture({ payload: [{ path: 'entry.js', bytes: text('entry') }] })
    const root = await tempRoot()
    const symlinkArchive = join(root, 'symlink.zip')
    await writeFile(symlinkArchive, buildZip([{ name: 'entry.js', bytes: text('entry'), mode: 0o120777 }]))
    await expectRejection(loadVerifiedPluginPackage(new ArchivePluginPackageSource(symlinkArchive), plan, { limits: LIMITS }), 'PLUGIN_ZIP_ENTRY_TYPE_REJECTED')
    const traversalArchive = join(root, 'traversal.zip')
    await writeFile(traversalArchive, buildZip([{ name: '../escape.js', bytes: text('entry') }]))
    await expectRejection(loadVerifiedPluginPackage(new ArchivePluginPackageSource(traversalArchive), plan, { limits: LIMITS }), 'PLUGIN_PATH_INVALID')
  })

  it('rejects a directory or oversized archive path', async () => {
    const { plan } = await pluginFixture()
    const root = await tempRoot()
    await expectRejection(loadVerifiedPluginPackage(new ArchivePluginPackageSource(root), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_SOURCE_INVALID')
    const bigPath = join(root, 'big.zip')
    await writeFile(bigPath, Buffer.alloc(LIMITS.maxPackageBytes + LIMITS.maxFileCount * 512 + 2048))
    await expectRejection(loadVerifiedPluginPackage(new ArchivePluginPackageSource(bigPath), plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_LIMIT_EXCEEDED')
  })
})

describe('StaticPluginPackageSource', () => {
  it('keeps untrusted entries untrusted and rejects a non-array result', async () => {
    const { plan } = await pluginFixture()
    const broken = { kind: 'broken', load: async () => null } as unknown as PluginPackageSource
    await expectRejection(loadVerifiedPluginPackage(broken, plan, { limits: LIMITS }), 'PLUGIN_PACKAGE_SOURCE_INVALID')
    expect(new StaticPluginPackageSource([]).kind).toBe('static')
  })

  it('surfaces a source failure without swallowing it', async () => {
    const { plan } = await pluginFixture()
    const failing = { kind: 'failing', load: async () => { throw new Error('source offline') } } as unknown as PluginPackageSource
    await expect(loadVerifiedPluginPackage(failing, plan, { limits: LIMITS })).rejects.toThrow('source offline')
  })
})
