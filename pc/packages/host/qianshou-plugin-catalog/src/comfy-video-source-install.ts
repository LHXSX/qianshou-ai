/** Buyer-side metadata installation for a published, signed Comfy source archive. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { readComfyVideoOrderSource } from './comfy-video-order-source.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import { ensureOrderInstallHome, stageVerifiedOrderAdapterSource } from './order-product-source-stage.ts'
import { COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM } from './order-source-inventory.ts'
import { CatalogFailure } from './registry.ts'
import type { ReviewedComfyVideoSourceInstall } from './types.ts'

const ID = /^[A-Za-z0-9_-]{1,64}$/u

function unavailable(): never { throw new CatalogFailure('order-install-not-ready') }
function invalid(): never { throw new CatalogFailure('order-install-manifest-invalid') }
function inside(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}
function validateSource(source: VerifiedOrderAdapterSource): void {
  const signatureVerified: unknown = Reflect.get(source.check, 'signatureVerified')
  const packageReceiptVerified: unknown = Reflect.get(source.check, 'packageReceiptVerified')
  const deviceInstalled: unknown = Reflect.get(source.check, 'deviceInstalled')
  if (source.inventoryAlgorithm !== COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM
    || source.capabilityId !== 'video.render'
    || source.acceptedInputKinds?.join(',') !== 'multi_file'
    || source.outputKind !== 'artifact_ref' || source.contractVersion !== 'v1'
    || signatureVerified !== true || packageReceiptVerified !== true
    || deviceInstalled !== false || !ID.test(source.check.productId)
    || !ID.test(source.check.entitlementId)) unavailable()
}
async function directory(parent: string, name: string, home: string): Promise<string> {
  const path = join(parent, name)
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) unavailable()
  const resolved = await realpath(path)
  if (!inside(home, resolved)) unavailable()
  return resolved
}
async function exactFile(path: string, root: string, size: number, digest: string): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
    || before.size !== size || !inside(root, await realpath(path))) invalid()
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  let bytes: Buffer
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev
      || opened.nlink !== 1 || opened.size !== before.size) invalid()
    bytes = await handle.readFile()
  } finally { await handle.close() }
  const after = await lstat(path)
  if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev
    || after.mtimeMs !== before.mtimeMs || after.size !== before.size || bytes.length !== size
    || createHash('sha256').update(bytes).digest('hex') !== digest) invalid()
  return bytes
}
async function verifyInstalled(root: string, source: VerifiedOrderAdapterSource): Promise<void> {
  const loaded = await readComfyVideoOrderSource(join(root, 'SKILL.md'))
  if (`sha256:${loaded.digest}` !== source.artifactDigest
    || loaded.declaration.taskType !== source.taskType
    || loaded.declaration.packageDigest !== source.reviewedSellerRuntimeDigest
    || loaded.taskDefinition.inputKinds.join(',') !== source.acceptedInputKinds?.join(',')) invalid()
  const markerPath = join(root, 'source-install.json')
  const entry = await lstat(markerPath)
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 4096) invalid()
  let marker: Record<string, unknown>
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown> }
  catch { return invalid() }
  if (Object.keys(marker).sort().join(',') !== 'archiveDigest,archiveVersionId,artifactDigest,entitlementId,productId,publicationId,schema,status'
    || marker.schema !== 'qianshou.comfy-video-source-install.v1'
    || marker.status !== 'metadata-only-awaiting-device-proof'
    || marker.productId !== source.check.productId || marker.entitlementId !== source.check.entitlementId
    || marker.publicationId !== source.check.publicationId
    || marker.archiveDigest !== source.check.archiveDigest
    || marker.archiveVersionId !== source.check.archiveVersionId
    || marker.artifactDigest !== source.artifactDigest) invalid()
}

function receipt(source: VerifiedOrderAdapterSource): ReviewedComfyVideoSourceInstall {
  return { productId: source.check.productId, entitlementId: source.check.entitlementId,
    publicationId: source.check.publicationId, taskType: source.taskType,
    artifactDigest: source.artifactDigest, sourceVerified: true, metadataInstalled: true,
    deviceInstalled: false, orderAvailable: false,
    nextStep: 'independent-device-install-attestation-required' }
}

/** Install only a signed, already published source inventory into a private data directory.
 * A later independently verified device installation may reference this exact digest.
 */
export async function installReviewedComfyVideoSource(source: VerifiedOrderAdapterSource, input: {
  home: string
  trustedArchiveHostname: string
  fetch?: typeof fetch
}): Promise<ReviewedComfyVideoSourceInstall> {
  validateSource(source)
  if (!isAbsolute(input.home)) unavailable()
  const home = await ensureOrderInstallHome(input.home)
  await stageVerifiedOrderAdapterSource(source, input)
  const version = createHash('sha256').update(source.check.archiveVersionId).digest('hex')
  const staged = join(home, 'qianshou', 'order-adapter-quarantine',
    source.check.productId, source.check.entitlementId, version)
  const stagedEntry = await lstat(staged)
  if (!stagedEntry.isDirectory() || stagedEntry.isSymbolicLink()) invalid()
  const stagedRoot = await realpath(staged)
  if (!inside(home, stagedRoot)) invalid()
  const files = new Map<string, Buffer>()
  const hash = createHash('sha256')
  for (const row of source.files) {
    const bytes = await exactFile(join(stagedRoot, row.path), stagedRoot, row.sizeBytes, row.sha256)
    files.set(row.path, bytes)
    hash.update(row.path).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  if (`sha256:${hash.digest('hex')}` !== source.artifactDigest) invalid()
  let parent = home
  for (const part of ['qianshou', 'reviewed-video-source', source.check.productId,
    source.check.entitlementId]) parent = await directory(parent, part, home)
  const target = join(parent, version)
  try {
    const entry = await lstat(target)
    if (!entry.isDirectory() || entry.isSymbolicLink()
      || !inside(parent, await realpath(target))) invalid()
    await verifyInstalled(target, source)
    return receipt(source)
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const temporary = await mkdtemp(join(parent, '.source-'))
  try {
    await writeFile(join(temporary, 'SKILL.md'), '# Reviewed Comfy video source metadata\n',
      { flag: 'wx', mode: 0o600 })
    const root = join(temporary, 'scripts', 'order_adapter')
    await mkdir(root, { recursive: true, mode: 0o700 })
    for (const [name, bytes] of files) {
      await mkdir(dirname(join(root, name)), { recursive: true, mode: 0o700 })
      await writeFile(join(root, name), bytes, { flag: 'wx', mode: 0o600 })
    }
    await writeFile(join(temporary, 'source-install.json'), JSON.stringify({
      schema: 'qianshou.comfy-video-source-install.v1', status: 'metadata-only-awaiting-device-proof',
      productId: source.check.productId, entitlementId: source.check.entitlementId,
      publicationId: source.check.publicationId, archiveDigest: source.check.archiveDigest,
      archiveVersionId: source.check.archiveVersionId, artifactDigest: source.artifactDigest,
    }), { flag: 'wx', mode: 0o600 })
    await verifyInstalled(temporary, source)
    await rename(temporary, target)
    return receipt(source)
  } finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined) }
}
