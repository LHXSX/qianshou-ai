import { describe, expect, it } from 'vitest'
import { planCapabilityPluginInstall } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { CordisLoaderDeployment, PluginLifecycle, PluginLifecycleError, stagedPackageDigest, type CordisLoaderLike, type PluginLifecycleDeployment, type StagedPluginPackage } from '../src/index.ts'

const bytes = [{ path: 'entry.js', bytes: new TextEncoder().encode('opaque') }]
const digest = stagedPackageDigest(bytes)
const manifest = { manifestVersion: 1, pluginId: 'image.local', version: '1.0.0', displayName: 'Image local', hostRange: '*', pluginDigest: digest, capabilities: [{ id: 'image.generate', version: '1.0.0', inputKinds: ['prompt'], outputKinds: ['image'], permissions: ['model.local'], dataScope: 'task-inputs' }] } as const
const makePlan = () => planCapabilityPluginInstall({ manifest, packageDigest: digest, signature: 'signature-123456', hostVersion: '1.0.0', grantedPermissions: ['model.local'], verifySignature: async () => true })

class FakeDeployment implements PluginLifecycleDeployment {
  readonly calls: string[] = []
  failActivation = false
  package: StagedPluginPackage = { manifest, packageDigest: digest, files: bytes, allowedFiles: ['entry.js'] }
  async readStagedPackage(): Promise<StagedPluginPackage> { this.calls.push('read'); return this.package }
  async activate(): Promise<void> { this.calls.push('activate'); if (this.failActivation) throw new Error('activation failed') }
  async deactivate(): Promise<void> { this.calls.push('deactivate') }
  async remove(): Promise<void> { this.calls.push('remove') }
}

describe('PluginLifecycle', () => {
  it('installs and repeats idempotently', async () => {
    const deployment = new FakeDeployment(); const lifecycle = new PluginLifecycle(deployment); const plan = await makePlan()
    await expect(lifecycle.install(plan)).resolves.toMatchObject({ phase: 'active', pluginId: 'image.local' })
    await expect(lifecycle.install(plan)).resolves.toMatchObject({ phase: 'active' })
    expect(deployment.calls).toEqual(['read', 'activate'])
  })
  it('serializes concurrent installs', async () => {
    const deployment = new FakeDeployment(); const lifecycle = new PluginLifecycle(deployment); const plan = await makePlan()
    await Promise.all([lifecycle.install(plan), lifecycle.install(plan)])
    expect(deployment.calls.filter(call => call === 'activate')).toHaveLength(1)
  })
  it('rejects traversal and extra files before activation', async () => {
    const deployment = new FakeDeployment(); const lifecycle = new PluginLifecycle(deployment); const plan = await makePlan()
    deployment.package = { ...deployment.package, files: [{ path: '../entry.js', bytes: bytes[0]!.bytes }] }
    await expect(lifecycle.install(plan)).rejects.toMatchObject({ code: 'PLUGIN_PATH_INVALID' })
    deployment.package = { ...deployment.package, files: [...bytes, { path: 'extra.bin', bytes: new Uint8Array() }] }
    await expect(lifecycle.install(plan)).rejects.toMatchObject({ code: 'PLUGIN_EXTRA_FILE' })
    expect(deployment.calls).toEqual(['read', 'read'])
  })
  it('marks failed activation rolled_back and restores previous package', async () => {
    const deployment = new FakeDeployment(); const lifecycle = new PluginLifecycle(deployment); const plan = await makePlan()
    deployment.failActivation = true
    await expect(lifecycle.install(plan)).rejects.toThrow('activation failed')
    expect(lifecycle.get({ pluginId: 'image.local', version: '1.0.0' })).toMatchObject({ phase: 'rolled_back' })
    expect(deployment.calls).toEqual(['read', 'activate', 'deactivate', 'remove'])
  })
  it('rejects a forged plan before reading staged bytes', async () => {
    const deployment = new FakeDeployment(); const lifecycle = new PluginLifecycle(deployment); const plan = await makePlan()
    await expect(lifecycle.install({ ...plan, grantedPermissions: [] })).rejects.toMatchObject({ code: 'PLUGIN_INSTALL_PLAN_INVALID' })
    expect(deployment.calls).toEqual([])
  })
  it('disables and uninstalls with cleanup', async () => {
    const deployment = new FakeDeployment(); const lifecycle = new PluginLifecycle(deployment)
    const plan = await makePlan(); await lifecycle.install(plan)
    await expect(lifecycle.disable({ pluginId: 'image.local', version: '1.0.0' })).resolves.toMatchObject({ phase: 'disabled' })
    await lifecycle.uninstall({ pluginId: 'image.local', version: '1.0.0' }); await lifecycle.uninstall({ pluginId: 'image.local', version: '1.0.0' })
    expect(lifecycle.get({ pluginId: 'image.local', version: '1.0.0' })).toBeUndefined(); expect(deployment.calls).toEqual(['read', 'activate', 'deactivate', 'remove'])
  })
  it('exposes stable missing-state failures', async () => {
    const lifecycle = new PluginLifecycle(new FakeDeployment())
    await expect(lifecycle.disable({ pluginId: 'none', version: '1.0.0' })).rejects.toEqual(new PluginLifecycleError('PLUGIN_NOT_INSTALLED'))
  })
})

class FakeLoader implements CordisLoaderLike {
  readonly calls: string[] = []
  readonly entries = new Map<string, { disabled: boolean; drains: number }>()
  failAwait = false
  private nextId = 0
  async create(options: { name: string; config?: unknown; disabled?: boolean }): Promise<string> {
    const id = `entry-${++this.nextId}`
    this.calls.push(`create:${id}:${options.name}`)
    this.entries.set(id, { disabled: Boolean(options.disabled), drains: 0 })
    return id
  }
  async update(id: string, options: { disabled?: boolean }): Promise<void> {
    this.calls.push(`update:${id}:${String(options.disabled)}`)
    const entry = this.entries.get(id); if (!entry) throw new Error('missing entry')
    entry.disabled = Boolean(options.disabled)
  }
  async remove(id: string): Promise<void> { this.calls.push(`remove:${id}`); this.entries.delete(id) }
  async await(): Promise<void> { this.calls.push('await'); if (this.failAwait) throw new Error('fiber failed') }
  resolve(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return {}
    return { fiber: { await: async () => { entry.drains += 1; this.calls.push(`fiber:${id}`) } } }
  }
}

describe('CordisLoaderDeployment', () => {
  const staged = { manifest, packageDigest: digest, files: bytes, allowedFiles: ['entry.js'], entrySpecifier: 'cordis:image-local' }
  it('creates, drains, disables and removes a loader entry', async () => {
    const loader = new FakeLoader()
    const deployment = new CordisLoaderDeployment({
      loader,
      readStagedPackage: async () => staged,
      entrySpecifier: (_identity, packageValue) => packageValue.entrySpecifier!,
    })
    const identity = { pluginId: manifest.pluginId, version: manifest.version }
    await deployment.activate(identity, staged)
    await deployment.deactivate(identity)
    await deployment.remove(identity)
    expect(loader.calls.filter(call => call.startsWith('create:'))).toHaveLength(1)
    expect(loader.calls.some(call => call.startsWith('update:'))).toBe(true)
    expect(loader.calls.some(call => call.startsWith('fiber:'))).toBe(true)
    expect([...loader.entries]).toHaveLength(0)
  })
  it('keeps a failed generation available for lifecycle rollback', async () => {
    const loader = new FakeLoader(); loader.failAwait = true
    const deployment = new CordisLoaderDeployment({
      loader,
      readStagedPackage: async () => staged,
      entrySpecifier: () => 'cordis:image-local',
    })
    const identity = { pluginId: manifest.pluginId, version: manifest.version }
    await expect(deployment.activate(identity, staged)).rejects.toThrow('fiber failed')
    loader.failAwait = false
    await deployment.deactivate(identity)
    await deployment.remove(identity)
    expect(loader.entries.size).toBe(0)
  })
  it('drains the old generation first when replacing an active entry', async () => {
    const loader = new FakeLoader()
    const deployment = new CordisLoaderDeployment({
      loader,
      readStagedPackage: async () => staged,
      entrySpecifier: () => 'cordis:image-local',
    })
    const identity = { pluginId: manifest.pluginId, version: manifest.version }
    await deployment.activate(identity, staged)
    await deployment.activate(identity, { ...staged, packageDigest: `${'a'.repeat(63)}0` })
    await deployment.deactivate(identity)
    const updates = loader.calls.filter(call => call.startsWith('update:'))
    expect(updates).toEqual(['update:entry-1:true'])
    expect(loader.entries.get('entry-2')?.disabled).toBe(false)
  })
  it('does not duplicate the previous generation during failed replacement recovery', async () => {
    const loader = new FakeLoader()
    const deployment = new CordisLoaderDeployment({
      loader,
      readStagedPackage: async () => staged,
      entrySpecifier: () => 'cordis:image-local',
    })
    const identity = { pluginId: manifest.pluginId, version: manifest.version }
    const replacement = { ...staged, packageDigest: `${'b'.repeat(63)}0` }
    await deployment.activate(identity, staged)
    loader.failAwait = true
    await expect(deployment.activate(identity, replacement)).rejects.toThrow('fiber failed')
    loader.failAwait = false
    await deployment.deactivate(identity)
    await deployment.activate(identity, staged)
    expect(loader.calls.filter(call => call.startsWith('create:'))).toHaveLength(2)
    expect(loader.entries.get('entry-1')?.disabled).toBe(false)
    expect(loader.entries.get('entry-2')?.disabled).toBe(true)
    await deployment.remove(identity)
    expect(loader.entries.size).toBe(0)
  })
  it('rejects unsafe loader specifiers before creating an entry', async () => {
    const loader = new FakeLoader()
    const deployment = new CordisLoaderDeployment({
      loader,
      readStagedPackage: async () => staged,
      entrySpecifier: () => '../escape',
    })
    await expect(deployment.activate({ pluginId: manifest.pluginId, version: manifest.version }, staged)).rejects.toMatchObject({ code: 'PLUGIN_ENTRY_SPECIFIER_INVALID' })
    expect(loader.calls).toEqual([])
  })
})
