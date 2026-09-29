import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId } from '../src/protocol.ts'
import { planCapabilityPluginInstall, pluginManifestFingerprint, type ComputePluginInstallRequest } from '../src/plugin-market.ts'
import type { ComputeCapabilityPluginManifest } from '../src/capability-manifest.ts'

const manifest = {
  manifestVersion: 1, pluginId: 'qianshou.image', version: '1.2.0', displayName: 'Image worker', hostRange: '>=0.1.0',
  pluginDigest: 'a'.repeat(64), capabilities: [{ id: ComputeCapabilityId('image.generate'), version: '1.0.0', inputKinds: ['text'], outputKinds: ['image'], permissions: ['workspace.read', 'workspace.write', 'gpu'], dataScope: 'task-inputs' }],
} as const satisfies ComputeCapabilityPluginManifest
const request = (overrides: Record<string, unknown> = {}): ComputePluginInstallRequest => ({
  manifest, packageDigest: 'a'.repeat(64), signature: 'sig-' + 'b'.repeat(24), hostVersion: '0.2.0',
  grantedPermissions: ['workspace.read', 'workspace.write', 'gpu'], verifySignature: async () => true, ...overrides,
})

describe('plugin market trust planning', () => {
  it('verifies digest, signature, host range and grants without loading code', async () => {
    const plan = await planCapabilityPluginInstall(request())
    expect(plan.phase).toBe('verified')
    expect(plan.manifestFingerprint).toBe(pluginManifestFingerprint(manifest))
    expect(plan.requiresNativeReview).toBe(true)
    expect(Object.isFrozen(plan)).toBe(true)
  })
  it.each([
    ['digest', { packageDigest: 'c'.repeat(64) }, 'COMPUTE_PLUGIN_DIGEST_MISMATCH'],
    ['host', { hostVersion: '0.0.1' }, 'COMPUTE_PLUGIN_HOST_INCOMPATIBLE'],
    ['permission', { grantedPermissions: ['workspace.read'] }, 'COMPUTE_PLUGIN_PERMISSION_REQUIRED'],
    ['signature', { verifySignature: async () => false }, 'COMPUTE_PLUGIN_SIGNATURE_INVALID'],
  ])('fails closed for %s', async (_label, overrides, code) => {
    await expect(planCapabilityPluginInstall(request(overrides))).rejects.toMatchObject({ code })
  })
  it('does not accept malformed install facts or duplicate grant authority', async () => {
    await expect(planCapabilityPluginInstall(request({ hostVersion: '0.2' }))).rejects.toMatchObject({ code: 'COMPUTE_PLUGIN_INSTALL_REQUEST_INVALID' })
    await expect(planCapabilityPluginInstall(request({ verifySignature: undefined }))).rejects.toMatchObject({ code: 'COMPUTE_PLUGIN_INSTALL_REQUEST_INVALID' })
    const plan = await planCapabilityPluginInstall(request({ grantedPermissions: ['gpu', 'gpu', 'workspace.read', 'workspace.write'] }))
    expect(plan.grantedPermissions).toEqual(['gpu', 'workspace.read', 'workspace.write'])
  })
})
