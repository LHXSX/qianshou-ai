import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComputeExecutorRegistry } from '../src/executor.ts'
import { verifyPrivateMacVideoInstallation, PRIVATE_MAC_VIDEO_ARCHIVE_SHA256 } from '../src/private-mac-video-install.ts'
import { ComputeCapabilityId } from '../src/protocol.ts'
import { reviewedMacVideoPackageBytes } from '../src/reviewed-mac-video-package.ts'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-private-video-install-')); roots.push(root)
  const dist = join(root, 'dist')
  await mkdir(dist)
  const reviewed = reviewedMacVideoPackageBytes()
  await Promise.all([
    writeFile(join(dist, 'qianshou-mac-drawn-video-0.1.0.tgz'), reviewed.archive),
    writeFile(join(dist, 'qianshou-mac-drawn-video-0.1.0.receipt.json'), reviewed.receipt),
    writeFile(join(dist, 'qianshou-mac-drawn-video-0.1.0.manifest.json'), reviewed.manifest),
  ])
  const archive = join(dist, 'qianshou-mac-drawn-video-0.1.0.tgz')
  const unpack = join(root, 'unpacked')
  await mkdir(unpack)
  await run('/usr/bin/tar', ['-xzf', archive, '-C', unpack], { timeout: 10_000 })
  const profileDir = join(root, 'profile')
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({ name: 'test', dependencies: {
    'qianshou-mac-drawn-video': `file:${archive}`,
  } }))
  await symlink(join(unpack, 'package'), join(profileDir, 'node_modules', 'qianshou-mac-drawn-video'))
  const executors = new ComputeExecutorRegistry()
  executors.register({ capabilityId: ComputeCapabilityId('video.drawn-mac-5s'), version: '0.1.0',
    execute: async () => ({ outputs: [] }) })
  const manager = { listBundles: async () => [{ name: 'qianshou-mac-drawn-video', version: '0.1.0',
    enabled: true, installed: true }],
    checkBundle: async () => ({ state: 'active', selected: true, version: '0.1.0',
      rows: [{ moduleName: 'qianshou-mac-drawn-video', phase: 'active' }] }) }
  return { root, archive, profileDir, executors, manager, factory: { available: true } }
}

describe.skipIf(process.platform !== 'darwin')('private Mac video installation evidence', () => {
  it('binds exact profile package, archive, sidecars, installed files and active executor', async () => {
    const input = await harness()
    expect(await verifyPrivateMacVideoInstallation(input)).toEqual({
      packageName: 'qianshou-mac-drawn-video', packageVersion: '0.1.0',
      capabilityId: 'video.drawn-mac-5s', capabilityVersion: '0.1.0',
      pluginDigest: PRIVATE_MAC_VIDEO_ARCHIVE_SHA256, scope: 'private-local-trial',
      marketInstalled: false, dispatchable: false,
    })
  }, 45_000)

  it('fails closed on an inactive bundle, mutated installed code, or missing archive', async () => {
    const input = await harness()
    await expect(verifyPrivateMacVideoInstallation({ ...input,
      manager: { ...input.manager, checkBundle: async () => ({ state: 'disabled', selected: false,
        version: '0.1.0', rows: [] }) } })).rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_INSTALL_UNVERIFIED')
    const installed = join(input.root, 'unpacked', 'package', 'index.js')
    await writeFile(installed, (await readFile(installed, 'utf8')) + '\n// changed')
    await expect(verifyPrivateMacVideoInstallation(input)).rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_INSTALL_UNVERIFIED')
    await rm(input.archive)
    await expect(verifyPrivateMacVideoInstallation(input)).rejects.toThrow('COMPUTE_PRIVATE_MAC_VIDEO_INSTALL_UNVERIFIED')
  }, 45_000)
})
