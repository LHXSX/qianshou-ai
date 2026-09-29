import { describe, expect, it } from 'vitest'
import { ComputeCapabilityId } from '../src/protocol.ts'
import { assertCapabilityPluginExecutors, parseCapabilityPluginManifest } from '../src/capability-manifest.ts'

const manifest = {
  manifestVersion: 1, pluginId: 'qianshou.image', version: '1.2.0', displayName: 'Image worker', hostRange: '>=0.1.0',
  pluginDigest: 'a'.repeat(64), capabilities: [{ id: ComputeCapabilityId('image.generate'), version: '1.0.0', inputKinds: ['text'], outputKinds: ['image'], permissions: ['workspace.read', 'workspace.write', 'gpu'], dataScope: 'task-inputs' }],
}
describe('capability plugin manifest', () => {
  it('freezes market metadata and preserves explicit permissions', () => {
    const parsed = parseCapabilityPluginManifest(manifest)
    expect(parsed.capabilities[0]).toMatchObject({ id: 'image.generate', dataScope: 'task-inputs', permissions: ['workspace.read', 'workspace.write', 'gpu'] })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.capabilities[0])).toBe(true)
  })
  it('rejects duplicate versions and unknown permissions without loading code', () => {
    expect(() => parseCapabilityPluginManifest({ ...manifest, capabilities: [manifest.capabilities[0], manifest.capabilities[0]] })).toThrow('COMPUTE_PLUGIN_MANIFEST_INVALID')
    expect(() => parseCapabilityPluginManifest({ ...manifest, capabilities: [{ ...manifest.capabilities[0], permissions: ['shell'] }] })).toThrow('COMPUTE_PLUGIN_MANIFEST_INVALID')
  })
  it('requires runtime executors to match the declared capability versions exactly', () => {
    const executor = { capabilityId: ComputeCapabilityId('image.generate'), version: '1.0.0', execute: async () => ({ outputs: [] }) }
    expect(() => { assertCapabilityPluginExecutors(parseCapabilityPluginManifest(manifest), [executor]) }).not.toThrow()
    expect(() => { assertCapabilityPluginExecutors(parseCapabilityPluginManifest(manifest), [{ ...executor, version: '2.0.0' }]) }).toThrow('COMPUTE_PLUGIN_EXECUTOR_MISMATCH')
  })
})
