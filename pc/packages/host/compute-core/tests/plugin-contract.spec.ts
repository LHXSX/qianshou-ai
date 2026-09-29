import { describe, expect, it } from 'vitest'
import { ComputeError } from '../src/errors.ts'
import { assertComputePluginBundleSize, parseComputePluginContract, type ComputePluginContract } from '../src/plugin-contract.ts'
import { parseCapabilityPluginManifest } from '../src/capability-manifest.ts'

const contract = {
  contractVersion: 1, runtime: 'node', entryId: 'image.generate',
  tools: [{ id: 'render', description: 'Render an image', inputSchemaRef: 'schema:image.input', outputSchemaRef: 'schema:image.output' }],
  dependencies: [{ id: 'h3-runtime', version: '^1.0.0', optional: true }],
  assets: [{ path: 'schemas/input.json', bytes: 100, sha256: 'a'.repeat(64) }],
  budget: { maxBundleBytes: 1024, maxDependencies: 4, maxAssets: 4, maxTools: 4 },
} as const satisfies ComputePluginContract

describe('lightweight plugin contract', () => {
  it('accepts and freezes declarative entry, tools, dependencies and assets', () => {
    const parsed = parseComputePluginContract(contract)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.tools[0])).toBe(true)
    expect(parsed.entryId).toBe('image.generate')
    expect(parseCapabilityPluginManifest({ manifestVersion: 1, pluginId: 'qianshou.image', version: '1.0.0', displayName: 'Image', hostRange: '*', pluginDigest: 'a'.repeat(64), capabilities: [{ id: 'image.generate', version: '1.0.0', inputKinds: ['text'], outputKinds: ['image'], permissions: [], dataScope: 'none' }], contract })).toMatchObject({ contract: { runtime: 'node' } })
  })
  it.each([
    ['absolute asset', { assets: [{ path: '/tmp/x', bytes: 1, sha256: 'a'.repeat(64) }] }],
    ['duplicate tool', { tools: [contract.tools[0], contract.tools[0]] }],
    ['inline-looking entry', { entryId: 'file:///tmp/plugin.mjs' }],
    ['budget overflow', { assets: [{ path: 'large.bin', bytes: 1025, sha256: 'a'.repeat(64) }] }],
  ])('rejects %s without loading code', (_label, override) => {
    expect(() => parseComputePluginContract({ ...contract, ...override })).toThrow(ComputeError)
  })
  it('checks observed staged bytes against the host budget', () => {
    expect(() => { assertComputePluginBundleSize(contract, 1024) }).not.toThrow()
    expect(() => { assertComputePluginBundleSize(contract, 1025) }).toThrow('COMPUTE_PLUGIN_BUNDLE_TOO_LARGE')
  })
})
