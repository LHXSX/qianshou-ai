/** Buyer runtime installation from an independently reviewed v5 source archive. */
import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { verifyGenericOrderAdapter } from './generic-order-adapter.ts'
import { readGenericOrderSource, type GenericOrderSource } from './generic-order-source.ts'
import { QUICKJS_ORDER_RUNTIME } from './quickjs-order-runtime.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import { ensureOrderInstallHome, stageVerifiedOrderAdapterSource } from './order-product-source-stage.ts'
import { EMPTY_ORDER_SOURCE_LOCK, SOURCE_INVENTORY_ALGORITHM } from './order-source-inventory.ts'
import { CatalogFailure } from './registry.ts'
import type { OrderAdapterLocalInstall } from './types.ts'

const ID = /^[A-Za-z0-9_-]{1,64}$/u

function unavailable(): never { throw new CatalogFailure('order-install-not-ready') }
function invalid(): never { throw new CatalogFailure('order-install-manifest-invalid') }
function inside(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}

async function privateDirectory(parent: string, name: string, home: string): Promise<string> {
  const path = join(parent, name)
  try { await mkdir(path, { mode: 0o700 }) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  const entry = await lstat(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) unavailable()
  const resolved = await realpath(path)
  if (!inside(home, resolved)) unavailable()
  return resolved
}

async function binaryDigest(): Promise<string> {
  const hash = createHash('sha256')
  try { for await (const chunk of createReadStream(process.execPath)) hash.update(chunk) }
  catch { throw new CatalogFailure('order-runtime-unavailable') }
  return `sha256:${hash.digest('hex')}`
}

async function sourceBytes(path: string, root: string, size: number, digest: string): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size !== size
    || !inside(root, await realpath(path))) invalid()
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  let bytes: Buffer
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev
      || opened.size !== before.size) invalid()
    bytes = await handle.readFile()
  } finally { await handle.close() }
  const after = await lstat(path)
  if (bytes.length !== size || after.ino !== before.ino || after.dev !== before.dev
    || after.size !== before.size || after.mtimeMs !== before.mtimeMs
    || createHash('sha256').update(bytes).digest('hex') !== digest) invalid()
  return bytes
}

async function verifiedStagedFiles(stage: string, source: VerifiedOrderAdapterSource):
  Promise<ReadonlyMap<string, Buffer>> {
  const entry = await lstat(stage)
  if (!entry.isDirectory() || entry.isSymbolicLink()) invalid()
  const receipt = await lstat(join(stage, 'source-stage.json'))
  if (!receipt.isFile() || receipt.isSymbolicLink() || receipt.size > 4096) invalid()
  let metadata: Record<string, unknown>
  try { metadata = JSON.parse(await readFile(join(stage, 'source-stage.json'), 'utf8')) as Record<string, unknown> }
  catch { return invalid() }
  if (metadata.schema !== 'qianshou.order-adapter-source-stage.v1'
    || metadata.productId !== source.check.productId
    || metadata.entitlementId !== source.check.entitlementId
    || metadata.publicationId !== source.check.publicationId
    || metadata.archiveDigest !== source.check.archiveDigest
    || metadata.archiveVersionId !== source.check.archiveVersionId
    || metadata.artifactDigest !== source.artifactDigest
    || metadata.inventoryAlgorithm !== source.inventoryAlgorithm
    || metadata.reviewedSellerRuntimeDigest !== source.reviewedSellerRuntimeDigest) invalid()
  const files = new Map<string, Buffer>()
  const hash = createHash('sha256')
  for (const row of source.files) {
    const bytes = await sourceBytes(join(stage, row.path), stage, row.sizeBytes, row.sha256)
    files.set(row.path, bytes)
    hash.update(row.path).update('\0').update(String(bytes.length)).update('\0').update(bytes)
  }
  if (`sha256:${hash.digest('hex')}` !== source.artifactDigest) invalid()
  if (files.get('pnpm-lock.yaml')?.toString('utf8') !== EMPTY_ORDER_SOURCE_LOCK) unavailable()
  return files
}

async function verifyRuntime(root: string, source: VerifiedOrderAdapterSource): Promise<string> {
  const skill = join(root, 'SKILL.md')
  const loaded = await readGenericOrderSource(skill)
  if (`sha256:${loaded.digest}` !== source.artifactDigest
    || loaded.declaration.taskType !== source.taskType
    || loaded.declaration.capabilityId !== source.capabilityId
    || loaded.declaration.inputKinds.join(',') !== source.acceptedInputKinds?.join(',')
    || loaded.declaration.outputKind !== source.outputKind
    || loaded.declaration.contractVersion !== source.contractVersion) invalid()
  if (process.platform === 'win32'
    && loaded.declaration.schema !== 'qianshou.local-adapter-candidate.v3') unavailable()
  const verified = await verifyGenericOrderAdapter(loaded)
  if (verified.artifactDigest !== source.artifactDigest || verified.localVerified !== true) invalid()
  const node = await binaryDigest()
  const identity = loaded.declaration.schema === 'qianshou.local-adapter-candidate.v3'
    ? { schema: 'qianshou.order-adapter-buyer-runtime.v2',
      artifactDigest: source.artifactDigest, node, nodeVersion: process.version,
      platform: platform(), arch: arch(), dependencyMode: 'pinned-quickjs-wasm',
      wasmSha256: QUICKJS_ORDER_RUNTIME.wasmSha256,
      quickJsVersion: QUICKJS_ORDER_RUNTIME.version }
    : { schema: 'qianshou.order-adapter-buyer-runtime.v1',
      artifactDigest: source.artifactDigest, node, nodeVersion: process.version,
      platform: platform(), arch: arch(), dependencyMode: 'self-contained' }
  return `sha256:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}

/** Reopen a private runtime without downloading or trusting its install marker. */
export async function loadInstalledVerifiedOrderAdapterSource(source: VerifiedOrderAdapterSource,
  homePath: string): Promise<{ source: GenericOrderSource; runtimeDigest: string }> {
  if (!['darwin', 'win32'].includes(process.platform) || !isAbsolute(homePath)
    || source.inventoryAlgorithm !== SOURCE_INVENTORY_ALGORITHM
    || source.acceptedInputKinds?.join(',') !== 'inline'
    || !['inline_json', 'artifact_ref'].includes(source.outputKind ?? '') || source.contractVersion !== 'v1'
    || !ID.test(source.check.productId) || !ID.test(source.check.entitlementId)) unavailable()
  const home = await realpath(homePath).catch(unavailable)
  let base = home
  for (const part of ['qianshou', 'order-adapter-runtime', source.check.productId,
    source.check.entitlementId]) {
    const child = join(base, part)
    const entry = await lstat(child).catch(unavailable)
    if (!entry.isDirectory() || entry.isSymbolicLink()) unavailable()
    base = await realpath(child).catch(unavailable)
    if (!inside(home, base)) unavailable()
  }
  const version = createHash('sha256').update(source.check.archiveVersionId).digest('hex')
  const target = join(base, version)
  const entry = await lstat(target).catch(unavailable)
  if (!entry.isDirectory() || entry.isSymbolicLink()
    || !inside(base, await realpath(target).catch(unavailable))) unavailable()
  const markerPath = join(target, 'local-install.json')
  const markerEntry = await lstat(markerPath).catch(unavailable)
  if (!markerEntry.isFile() || markerEntry.isSymbolicLink()
    || markerEntry.size < 2 || markerEntry.size > 4096) unavailable()
  let marker: Record<string, unknown>
  try { marker = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown> }
  catch { return unavailable() }
  const runtimeDigest = await verifyRuntime(target, source)
  if (marker.schema !== 'qianshou.order-adapter-local-install.v1'
    || marker.productId !== source.check.productId
    || marker.entitlementId !== source.check.entitlementId
    || marker.publicationId !== source.check.publicationId
    || marker.archiveDigest !== source.check.archiveDigest
    || marker.archiveVersionId !== source.check.archiveVersionId
    || marker.artifactDigest !== source.artifactDigest
    || marker.taskType !== source.taskType
    || marker.capabilityId !== source.capabilityId
    || marker.dependenciesInstalled !== 0
    || marker.status !== 'locally-verified-awaiting-independent-attestation'
    || marker.runtimeDigest !== runtimeDigest) unavailable()
  const loaded = await readGenericOrderSource(join(target, 'SKILL.md'))
  if (`sha256:${loaded.digest}` !== source.artifactDigest) unavailable()
  if (source.outputKind === 'artifact_ref' && (loaded.declaration.schema !== 'qianshou.local-adapter-candidate.v3'
    || loaded.taskDefinition?.fileSchema === undefined)) unavailable()
  return { source: loaded, runtimeDigest }
}

function result(source: VerifiedOrderAdapterSource, runtimeDigest: string): OrderAdapterLocalInstall {
  return { productId: source.check.productId, entitlementId: source.check.entitlementId,
    taskType: source.taskType, capabilityId: source.capabilityId,
    artifactDigest: source.artifactDigest, runtimeDigest, sourceVerified: true,
    localVerified: true, deviceInstalled: false, orderAvailable: false,
    nextStep: 'independent-device-install-attestation-required' }
}

/** Stage, install and execute signed v5 examples in the actual private runtime tree. */
export async function installVerifiedOrderAdapterSource(source: VerifiedOrderAdapterSource, input: {
  home: string; trustedArchiveHostname: string; fetch?: typeof fetch
}): Promise<OrderAdapterLocalInstall> {
  if (!['darwin', 'win32'].includes(process.platform) || !isAbsolute(input.home)
    || source.inventoryAlgorithm !== SOURCE_INVENTORY_ALGORITHM
    || !ID.test(source.check.productId) || !ID.test(source.check.entitlementId)
    || source.acceptedInputKinds?.join(',') !== 'inline'
    || !['inline_json', 'artifact_ref'].includes(source.outputKind ?? '')
    || source.contractVersion !== 'v1') unavailable()
  const home = await ensureOrderInstallHome(input.home)
  await stageVerifiedOrderAdapterSource(source, input)
  const version = createHash('sha256').update(source.check.archiveVersionId).digest('hex')
  const staged = join(home, 'qianshou', 'order-adapter-quarantine',
    source.check.productId, source.check.entitlementId, version)
  const files = await verifiedStagedFiles(staged, source)
  let base = home
  for (const part of ['qianshou', 'order-adapter-runtime', source.check.productId,
    source.check.entitlementId]) base = await privateDirectory(base, part, home)
  const target = join(base, version)
  try {
    const entry = await lstat(target)
    if (!entry.isDirectory() || entry.isSymbolicLink()) unavailable()
    const markerEntry = await lstat(join(target, 'local-install.json'))
    if (!markerEntry.isFile() || markerEntry.isSymbolicLink()
      || markerEntry.size < 2 || markerEntry.size > 4096) unavailable()
    const marker = JSON.parse(await readFile(join(target, 'local-install.json'), 'utf8')) as Record<string, unknown>
    const digest = await verifyRuntime(target, source)
    if (marker.schema !== 'qianshou.order-adapter-local-install.v1'
      || marker.productId !== source.check.productId
      || marker.entitlementId !== source.check.entitlementId
      || marker.publicationId !== source.check.publicationId
      || marker.archiveDigest !== source.check.archiveDigest
      || marker.archiveVersionId !== source.check.archiveVersionId
      || marker.artifactDigest !== source.artifactDigest
      || marker.taskType !== source.taskType
      || marker.capabilityId !== source.capabilityId
      || marker.dependenciesInstalled !== 0
      || marker.status !== 'locally-verified-awaiting-independent-attestation'
      || marker.runtimeDigest !== digest) unavailable()
    return result(source, digest)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const temporary = await mkdtemp(join(base, '.runtime-'))
  try {
    await writeFile(join(temporary, 'SKILL.md'), '# Installed order adapter\n', { flag: 'wx', mode: 0o600 })
    const sourceRoot = join(temporary, 'scripts', 'order_adapter')
    await mkdir(sourceRoot, { recursive: true, mode: 0o700 })
    for (const [name, bytes] of files) {
      await mkdir(dirname(join(sourceRoot, name)), { recursive: true, mode: 0o700 })
      await writeFile(join(sourceRoot, name), bytes, { flag: 'wx', mode: 0o600 })
    }
    const digest = await verifyRuntime(temporary, source)
    await writeFile(join(temporary, 'local-install.json'), JSON.stringify({
      schema: 'qianshou.order-adapter-local-install.v1',
      productId: source.check.productId, entitlementId: source.check.entitlementId,
      publicationId: source.check.publicationId, archiveDigest: source.check.archiveDigest,
      archiveVersionId: source.check.archiveVersionId, artifactDigest: source.artifactDigest,
      runtimeDigest: digest, taskType: source.taskType, capabilityId: source.capabilityId,
      dependenciesInstalled: 0, status: 'locally-verified-awaiting-independent-attestation',
    }), { flag: 'wx', mode: 0o600 })
    await rename(temporary, target)
    return result(source, digest)
  } finally { await rm(temporary, { recursive: true, force: true }).catch(() => undefined) }
}
