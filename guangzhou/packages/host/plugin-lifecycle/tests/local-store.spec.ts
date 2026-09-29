import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeCapabilityId } from '@deepseek-ai/dsh-compute-core/protocol'
import { planCapabilityPluginInstall, pluginManifestFingerprint } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { stagedPackageDigest, type StagedPluginFile } from '../src/index.ts'
import { LocalPluginStore } from '../src/local-store.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-store-'))
  directories.push(root)
  const options = { root: join(root, 'store'), maxBundleBytes: 16_384, maxFileCount: 10 }
  const files = [{ path: 'assets/message.txt', bytes: Buffer.from('A real persisted package payload.') }]
  const manifest = { manifestVersion: 1, pluginId: 'documents.local', version: '1.0.0',
    displayName: 'Local documents', hostRange: '*', pluginDigest: stagedPackageDigest(files),
    capabilities: [{ id: ComputeCapabilityId('document.read'), version: '1.0.0', inputKinds: ['document'], outputKinds: ['text'],
      permissions: ['workspace.read'], dataScope: 'task-inputs' }] } as const
  const keys = generateKeyPairSync('ed25519')
  const signature = sign(null, Buffer.from(pluginManifestFingerprint(manifest)), keys.privateKey).toString('base64')
  const plan = await planCapabilityPluginInstall({ manifest, packageDigest: manifest.pluginDigest,
    signature, hostVersion: '1.0.0', grantedPermissions: ['workspace.read'],
    verifySignature: (fingerprint, value) => verify(null, Buffer.from(fingerprint), keys.publicKey, Buffer.from(value, 'base64')) })
  return { root, options, files, plan, store: new LocalPluginStore(options) }
}

describe('LocalPluginStore real filesystem persistence', () => {
  it('reads exact verified bytes and owner preference through a new store after restart', async () => {
    const { store, plan, files, options } = await fixture()
    await store.stage(plan, files)
    await store.setInstallation(plan, 'enabled')
    const restarted = new LocalPluginStore(options)
    const restored = await restarted.readStagedPackage(plan)
    expect(restored.files[0]?.bytes).toEqual(files[0]?.bytes)
    expect(restored).not.toHaveProperty('entrySpecifier')
    expect(await restarted.getInstallation(plan.manifest)).toMatchObject({ desiredState: 'enabled', packageDigest: plan.packageDigest })
    expect(await restarted.getInstallation(plan.manifest)).not.toHaveProperty('active')
  })

  it('persists disabled state and retains immutable bytes after forgetting installation', async () => {
    const { store, plan, files, options } = await fixture()
    await store.stage(plan, files)
    await store.setInstallation(plan, 'enabled')
    await store.setInstallation(plan, 'disabled')
    expect(await new LocalPluginStore(options).getInstallation(plan.manifest)).toMatchObject({ desiredState: 'disabled' })
    await store.forgetInstallation(plan.manifest)
    await store.forgetInstallation(plan.manifest)
    expect(await store.getInstallation(plan.manifest)).toBeUndefined()
    expect((await store.readStagedPackage(plan)).files).toHaveLength(1)
  })

  it('requires current owner permissions again on restart', async () => {
    const { store, plan, files, options } = await fixture()
    await store.stage(plan, files)
    await store.setInstallation(plan, 'enabled')
    await expect(new LocalPluginStore(options).readStagedPackage({ ...plan, grantedPermissions: [] }))
      .rejects.toMatchObject({ code: 'PLUGIN_INSTALL_PLAN_INVALID' })
  })

  it('serializes content identity with atomic rename across concurrent store instances', async () => {
    const { store, plan, files, options } = await fixture()
    await Promise.all([store.stage(plan, files), new LocalPluginStore(options).stage(plan, files)])
    expect((await readdir(join(options.root, 'packages'))).filter(name => !name.startsWith('.'))).toHaveLength(1)
    expect((await store.readStagedPackage(plan)).files).toHaveLength(1)
    expect((await readdir(join(options.root, 'packages'))).some(name => name.startsWith('.stage-'))).toBe(false)
  })

  it('detects payload tampering before selecting an installation', async () => {
    const { store, plan, files, options } = await fixture()
    await store.stage(plan, files)
    const [object] = await readdir(join(options.root, 'packages'))
    await writeFile(join(options.root, 'packages', object!, 'payload/assets/message.txt'), 'modified')
    await expect(store.setInstallation(plan, 'enabled')).rejects.toMatchObject({ code: 'PLUGIN_DIGEST_MISMATCH' })
    expect(await store.getInstallation(plan.manifest)).toBeUndefined()
  })

  it('rejects extra payload files instead of exposing them to a later loader', async () => {
    const { store, plan, files, options } = await fixture()
    await store.stage(plan, files)
    const [object] = await readdir(join(options.root, 'packages'))
    await writeFile(join(options.root, 'packages', object!, 'payload/extra.js'), 'unlisted')
    await expect(store.readStagedPackage(plan)).rejects.toMatchObject({ code: 'PLUGIN_EXTRA_FILE' })
  })

  it.each(['../escaped.txt', '/absolute.txt', 'a/../b', 'a\\b', 'C:outside.txt', './entry.txt'])('rejects non-canonical path %s', async (path) => {
    const { store, plan } = await fixture()
    await expect(store.stage(plan, [{ path, bytes: Buffer.from('data') }])).rejects.toMatchObject({ code: 'PLUGIN_PATH_INVALID' })
  })

  it('rejects content symlinks without reading their target', async () => {
    const { store, plan, files, root, options } = await fixture()
    await store.stage(plan, files)
    const [object] = await readdir(join(options.root, 'packages'))
    const file = join(options.root, 'packages', object!, 'payload/assets/message.txt')
    const target = join(root, 'external.txt')
    await writeFile(target, 'do not import')
    await rm(file)
    await symlink(target, file)
    await expect(store.readStagedPackage(plan)).rejects.toMatchObject({ code: 'PLUGIN_STORE_LINK_REJECTED' })
    expect(await readFile(target, 'utf8')).toBe('do not import')
  })

  it('rejects a symlink storage root', async () => {
    const { root, plan, files, options } = await fixture()
    await symlink(root, options.root)
    await expect(new LocalPluginStore(options).stage(plan, files)).rejects.toMatchObject({ code: 'PLUGIN_STORE_LINK_REJECTED' })
  })

  it('bounds package bytes and file count before filesystem writes', async () => {
    const { plan, options } = await fixture()
    const small = new LocalPluginStore({ ...options, maxBundleBytes: 8, maxFileCount: 1 })
    await expect(small.stage(plan, [{ path: 'one', bytes: Buffer.alloc(9) }])).rejects.toMatchObject({ code: 'PLUGIN_STORE_LIMIT_EXCEEDED' })
    const files: StagedPluginFile[] = ['one', 'two'].map(path => ({ path, bytes: Buffer.alloc(0) }))
    await expect(small.stage(plan, files)).rejects.toMatchObject({ code: 'PLUGIN_STORE_LIMIT_EXCEEDED' })
  })
})
