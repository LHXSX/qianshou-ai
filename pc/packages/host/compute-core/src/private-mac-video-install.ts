/** Host-owned evidence for one reviewed, unsigned, Mac-only private bundle.
 *
 * The package's own code cannot attest itself. We bind the current profile's
 * exact tarball dependency, the pinned tarball digest and sidecars, the bytes
 * pnpm installed, the live Loader row, and the exact registered executor.
 * Any later package build needs an intentional review and new Host pins.
 */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { ComputeError } from './errors.ts'
import type { ComputeExecutorRegistry } from './executor.ts'
import type { MacDrawnVideoFactory } from './mac-drawn-video-factory.ts'
import { ComputeCapabilityId } from './protocol.ts'

export const PRIVATE_MAC_VIDEO_PACKAGE = 'qianshou-mac-drawn-video'
export const PRIVATE_MAC_VIDEO_VERSION = '0.1.0'
export const PRIVATE_MAC_VIDEO_CAPABILITY = 'video.drawn-mac-5s'
export const PRIVATE_MAC_VIDEO_ARCHIVE_SHA256 = 'b9c52f52df072162bcd748ae79160910a898b5d7deed7edb1f6a5d46527ad4c1'
const ARCHIVE_NAME = `${PRIVATE_MAC_VIDEO_PACKAGE}-${PRIVATE_MAC_VIDEO_VERSION}.tgz`
const SOURCE_HASHES = Object.freeze({
  'index.js': '1a0f676930e5216b2ce0e59505abda9314dfab230e3c88b9662666fcaa720dd9',
  'cordis.patch.yml': '0e3f807942fb2e5606bbe5430982e43c1ab190f9f74ad494b79918f8277f49c1',
  'capability.json': 'df9c908f6df580b168a8a1b4d8f06c415f152113302957215d89a754e195622b',
  'package.json': '0689cc20937de610b8d1b0acb50aac30511b032b7af97af89e589d357a50ec07',
  LICENSE: '05b05ce439c5c52297977d65b62ac8944d82c089eb985be3d8312efaac52685f',
})
const INSTALLED_HASHES = Object.freeze({ ...SOURCE_HASHES,
  'package.json': 'a9b3afa2c847c100a4831156107439e694415cdaa98c2e457b90a936e98187dd',
})
const MAX_ARCHIVE_BYTES = 1024 * 1024
const MAX_JSON_BYTES = 64 * 1024
const MAX_FILE_BYTES = 64 * 1024

export interface PrivateMacVideoBundleManager {
  listBundles(): Promise<readonly { name: string; version?: string; enabled: boolean; installed: boolean; error?: unknown }[]>
  checkBundle(name: string): Promise<{ state: string; selected: boolean; version?: string;
    rows: readonly { moduleName: string; phase: string | null }[] }>
}

export interface PrivateMacVideoInstallationEvidence {
  readonly packageName: typeof PRIVATE_MAC_VIDEO_PACKAGE
  readonly packageVersion: typeof PRIVATE_MAC_VIDEO_VERSION
  readonly capabilityId: typeof PRIVATE_MAC_VIDEO_CAPABILITY
  readonly capabilityVersion: typeof PRIVATE_MAC_VIDEO_VERSION
  /** SHA-256 of the exact, reviewed local tarball currently held by the profile. */
  readonly pluginDigest: typeof PRIVATE_MAC_VIDEO_ARCHIVE_SHA256
  readonly scope: 'private-local-trial'
  readonly marketInstalled: false
  readonly dispatchable: false
}

function invalid(): ComputeError { return new ComputeError('COMPUTE_PRIVATE_MAC_VIDEO_INSTALL_UNVERIFIED', 409) }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }

async function boundedFile(path: string, limit: number): Promise<Buffer> {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw invalid()
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size !== info.size) throw invalid()
    const bytes = await file.readFile()
    const after = await file.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs || bytes.length !== before.size) throw invalid()
    return bytes
  } finally { await file.close() }
}

/** Fail closed unless the active Host bundle is byte-for-byte the reviewed private release. */
export async function verifyPrivateMacVideoInstallation(input: {
  readonly profileDir: string
  readonly manager: PrivateMacVideoBundleManager
  readonly executors: Pick<ComputeExecutorRegistry, 'resolve'>
  readonly factory: Pick<MacDrawnVideoFactory, 'available'>
}): Promise<PrivateMacVideoInstallationEvidence> {
  if (process.platform !== 'darwin' || !input.factory.available
    || !isAbsolute(input.profileDir) || input.profileDir.includes('\0')) throw invalid()
  try {
    const bundle = (await input.manager.listBundles()).find(row => row.name === PRIVATE_MAC_VIDEO_PACKAGE)
    if (bundle?.version !== PRIVATE_MAC_VIDEO_VERSION || !bundle.enabled || !bundle.installed || bundle.error !== undefined) throw invalid()
    const active = await input.manager.checkBundle(PRIVATE_MAC_VIDEO_PACKAGE)
    if (active.state !== 'active' || !active.selected || active.version !== PRIVATE_MAC_VIDEO_VERSION
      || !active.rows.some(row => row.moduleName === PRIVATE_MAC_VIDEO_PACKAGE && row.phase === 'active')) throw invalid()
    input.executors.resolve(ComputeCapabilityId(PRIVATE_MAC_VIDEO_CAPABILITY), PRIVATE_MAC_VIDEO_VERSION)

    const profile = record(JSON.parse((await boundedFile(join(input.profileDir, 'package.json'), MAX_JSON_BYTES)).toString('utf8')))
    const spec = record(profile?.dependencies)?.[PRIVATE_MAC_VIDEO_PACKAGE]
    if (typeof spec !== 'string' || !spec.startsWith('file:') || spec.includes('?') || spec.includes('#')) throw invalid()
    const archive = resolve(input.profileDir, spec.slice(5))
    if (!isAbsolute(archive) || archive.includes('\0') || archive.split('/').at(-1) !== ARCHIVE_NAME) throw invalid()
    const archiveBytes = await boundedFile(archive, MAX_ARCHIVE_BYTES)
    const digest = createHash('sha256').update(archiveBytes).digest('hex')
    if (digest !== PRIVATE_MAC_VIDEO_ARCHIVE_SHA256) throw invalid()
    const sidecarRoot = dirname(archive)
    const receipt = record(JSON.parse((await boundedFile(join(sidecarRoot, `${PRIVATE_MAC_VIDEO_PACKAGE}-${PRIVATE_MAC_VIDEO_VERSION}.receipt.json`), MAX_JSON_BYTES)).toString('utf8')))
    const manifest = record(JSON.parse((await boundedFile(join(sidecarRoot, `${PRIVATE_MAC_VIDEO_PACKAGE}-${PRIVATE_MAC_VIDEO_VERSION}.manifest.json`), MAX_JSON_BYTES)).toString('utf8')))
    if (receipt?.format !== 'qianshou.private-package-receipt.v1'
      || receipt.packageName !== PRIVATE_MAC_VIDEO_PACKAGE || receipt.version !== PRIVATE_MAC_VIDEO_VERSION
      || receipt.archive !== ARCHIVE_NAME || receipt.archiveBytes !== archiveBytes.length
      || receipt.archiveSha256 !== digest || !equal(receipt.reviewedFiles, SOURCE_HASHES)
      || receipt.localOnly !== true || receipt.signed !== false || receipt.dispatchable !== false
      || manifest?.manifestVersion !== 1 || manifest.pluginId !== 'qianshou.mac-drawn-video'
      || manifest.version !== PRIVATE_MAC_VIDEO_VERSION || manifest.pluginDigest !== digest
      || !equal(manifest.capabilities, [{ id: PRIVATE_MAC_VIDEO_CAPABILITY, version: PRIVATE_MAC_VIDEO_VERSION,
        inputKinds: ['text'], outputKinds: ['video'], permissions: ['workspace.write'], dataScope: 'task-inputs' }])) throw invalid()

    // Resolve from this profile, never from the model's cwd or a supplied path.
    const requireFromProfile = createRequire(join(input.profileDir, 'package.json'))
    const packagePath = await realpath(requireFromProfile.resolve(`${PRIVATE_MAC_VIDEO_PACKAGE}/package.json`))
    const packageDir = dirname(packagePath)
    for (const [name, expected] of Object.entries(INSTALLED_HASHES)) {
      const bytes = await boundedFile(join(packageDir, name), MAX_FILE_BYTES)
      if (createHash('sha256').update(bytes).digest('hex') !== expected) throw invalid()
    }
    return Object.freeze({ packageName: PRIVATE_MAC_VIDEO_PACKAGE,
      packageVersion: PRIVATE_MAC_VIDEO_VERSION, capabilityId: PRIVATE_MAC_VIDEO_CAPABILITY,
      capabilityVersion: PRIVATE_MAC_VIDEO_VERSION, pluginDigest: PRIVATE_MAC_VIDEO_ARCHIVE_SHA256,
      scope: 'private-local-trial', marketInstalled: false, dispatchable: false })
  } catch { throw invalid() }
}
