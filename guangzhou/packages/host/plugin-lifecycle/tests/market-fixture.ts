/** Shared, test-only fixtures for the market intake and installer suites. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from 'vitest'
import { planCapabilityPluginInstall, type ComputePluginInstallPlan } from '@deepseek-ai/dsh-compute-core/plugin-market'
import { stagedPackageDigest, type StagedPluginFile } from '../src/index.ts'
import type { PluginPackageAsset } from '../src/package-intake.ts'

/** Budget used by most fixtures: small enough to test limits, large enough to install. */
export const LIMITS = { maxFileCount: 8, maxFileBytes: 4096, maxPackageBytes: 16_384 }

/** Verified plugin fixture: payload bytes, matching plan and the generation name. */
export interface PluginFixture {
  payload: StagedPluginFile[]
  plan: ComputePluginInstallPlan
  generation: string
  identityKey: string
}

/** Options for a fixture; every value has a valid default. */
export interface PluginFixtureOptions {
  pluginId?: string
  version?: string
  payload?: StagedPluginFile[]
  declaredAssets?: readonly PluginPackageAsset[]
  maxBundleBytes?: number
}

const bytes = (value: string): Buffer => Buffer.from(value, 'utf8')
const sha256 = (value: Uint8Array): string => createHash('sha256').update(value).digest('hex')

/** Build a payload, its signed plan and the derived storage names. */
export async function pluginFixture(options: PluginFixtureOptions = {}): Promise<PluginFixture> {
  const payload = options.payload ?? [
    { path: 'entry.js', bytes: bytes('export const capability = 1') },
    { path: 'assets/spec.json', bytes: bytes('{"kind":"spec"}') },
  ]
  const declaredAssets = options.declaredAssets ?? payload
    .filter(file => file.path.startsWith('assets/'))
    .map(file => ({ path: file.path, bytes: file.bytes.byteLength, sha256: sha256(file.bytes) }))
  const pluginId = options.pluginId ?? 'image.local'
  const version = options.version ?? '1.0.0'
  const digest = stagedPackageDigest(payload)
  const manifest = {
    manifestVersion: 1,
    pluginId,
    version,
    displayName: 'Local image plugin',
    hostRange: '*',
    pluginDigest: digest,
    capabilities: [{ id: 'image.generate', version: '1.0.0', inputKinds: ['prompt'], outputKinds: ['image'], permissions: ['model.local'], dataScope: 'task-inputs' }],
    contract: {
      contractVersion: 1,
      runtime: 'host',
      entryId: 'image-local',
      tools: [],
      dependencies: [],
      assets: declaredAssets,
      budget: { maxBundleBytes: options.maxBundleBytes ?? 65_536, maxDependencies: 4, maxAssets: 8, maxTools: 4 },
    },
  }
  const plan = await planCapabilityPluginInstall({
    manifest,
    packageDigest: digest,
    signature: 'signature-abcdef',
    hostVersion: '1.0.0',
    grantedPermissions: ['model.local'],
    verifySignature: async () => true,
  })
  return { payload, plan, generation: `${digest}-${plan.manifestFingerprint}`, identityKey: identityKeyOf(pluginId, version) }
}

/** Storage key used by the installer for one identity. */
export function identityKeyOf(pluginId: string, version: string): string {
  return createHash('sha256').update(JSON.stringify([pluginId, version])).digest('hex')
}

/** Assert that a promise rejects with a PluginLifecycleError carrying this code. */
export async function expectRejection(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

const roots: string[] = []

/** Create a temporary directory removed by `cleanupTempRoots()`. */
export async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-plugin-install-'))
  roots.push(root)
  return root
}

/** Remove every temporary directory created since the last call. */
export async function cleanupTempRoots(): Promise<void> {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
}
