/** Owner-approved preparation and installation of the one reviewed Mac video template. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ComputeError } from './errors.ts'
import type { ComputeExecutorRegistry } from './executor.ts'
import type { MacDrawnVideoFactory } from './mac-drawn-video-factory.ts'
import { parsePluginDraftId, parsePluginDraftSpec, type LocalPluginDraftStore, type PluginDraftSpec } from './plugin-draft.ts'
import { PRIVATE_MAC_VIDEO_ARCHIVE_SHA256, PRIVATE_MAC_VIDEO_PACKAGE, PRIVATE_MAC_VIDEO_VERSION,
  verifyPrivateMacVideoInstallation, type PrivateMacVideoBundleManager } from './private-mac-video-install.ts'
import { reviewedMacVideoPackageBytes } from './reviewed-mac-video-package.ts'

const ARCHIVE = `${PRIVATE_MAC_VIDEO_PACKAGE}-${PRIVATE_MAC_VIDEO_VERSION}.tgz`
const RECEIPT = `${PRIVATE_MAC_VIDEO_PACKAGE}-${PRIVATE_MAC_VIDEO_VERSION}.receipt.json`
const MANIFEST = `${PRIVATE_MAC_VIDEO_PACKAGE}-${PRIVATE_MAC_VIDEO_VERSION}.manifest.json`
const RECEIPT_SHA256 = '530de4dcb5dec4066e0a07be4c41374cc44632c1dd0d05e4ada782eb56b67b50'
const MANIFEST_SHA256 = 'c37a27b97cac3a36aafa36c432484431dde6ed2013a3947ea9ab841dde55d6f5'
const MAX_PACKAGE_BYTES = 1024 * 1024

/** This exact recipe names a reviewed adapter; no arbitrary workflow graph is compiled into code. */
export const MAC_VIDEO_DRAFT_TEMPLATE: PluginDraftSpec = parsePluginDraftSpec({
  pluginId: 'qianshou.mac-drawn-video', version: PRIVATE_MAC_VIDEO_VERSION,
  displayName: '千手 Mac 五秒绘图视频',
  operations: [{
    id: 'video.drawn-mac-5s', title: '生成五秒绘图视频',
    description: '在这台 Mac 上绘制固定海边骑车场景，并生成五秒 MP4。',
    binding: { kind: 'workflow', ref: 'mac-drawn-video:reviewed-template' },
    inputSchema: { type: 'object', properties: { title: { type: 'string' }, subtitle: { type: 'string' } },
      required: ['title', 'subtitle'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { attachmentId: { type: 'string' } },
      required: ['attachmentId'], additionalProperties: false },
    permissions: ['workspace.write'], dataScope: 'task-inputs', networkOrigins: [], dependencies: [],
    resources: { platforms: ['darwin'], minTotalMemoryBytes: 0, minFreeDiskBytes: 20 * 1024 * 1024,
      maxInputBytes: 1024, maxOutputBytes: 20 * 1024 * 1024, maxRunMs: 180_000 },
  }],
})
const REVIEWED_TEMPLATE_JSON = JSON.stringify(MAC_VIDEO_DRAFT_TEMPLATE)

/** An explicit private installation receipt; it is not a market or Shanghai registration. */
export interface PrivateMacVideoDraftInstallReceipt {
  readonly format: 'qianshou.private-mac-video-draft-install.v1'
  readonly draftId: string
  readonly draftUpdatedAt: string
  readonly packageName: typeof PRIVATE_MAC_VIDEO_PACKAGE
  readonly version: typeof PRIVATE_MAC_VIDEO_VERSION
  readonly archiveSha256: typeof PRIVATE_MAC_VIDEO_ARCHIVE_SHA256
  readonly archivePath: string
  readonly state: 'active-private' | 'restart-required'
  readonly localOnly: true
  readonly signed: false
  readonly marketInstalled: false
  readonly dispatchable: false
}

/** Only the current profile's trusted management service may install the prepared archive. */
export interface PrivateMacVideoInstallManager extends PrivateMacVideoBundleManager {
  installBundle(spec: string, options: { enabled: true }): Promise<{ application: string; bundle?: string; error?: unknown }>
}

function refused(code: string, status = 409): ComputeError { return new ComputeError(code, status) }
function sha256(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex') }
function matchesTemplate(spec: PluginDraftSpec): boolean {
  return JSON.stringify(parsePluginDraftSpec(spec)) === REVIEWED_TEMPLATE_JSON
}

function reviewedBytes(): Readonly<Record<string, Buffer>> {
  const bytes = reviewedMacVideoPackageBytes()
  if (bytes.archive.length < 1 || bytes.archive.length > MAX_PACKAGE_BYTES
    || sha256(bytes.archive) !== PRIVATE_MAC_VIDEO_ARCHIVE_SHA256
    || sha256(bytes.receipt) !== RECEIPT_SHA256 || sha256(bytes.manifest) !== MANIFEST_SHA256) {
    throw refused('COMPUTE_PRIVATE_MAC_VIDEO_REVIEWED_PACKAGE_INVALID', 503)
  }
  return { [ARCHIVE]: bytes.archive, [RECEIPT]: bytes.receipt, [MANIFEST]: bytes.manifest }
}

async function verifyDirectory(path: string, expected: Readonly<Record<string, Buffer>>): Promise<void> {
  const directory = await lstat(path)
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw refused('COMPUTE_PRIVATE_MAC_VIDEO_PACKAGE_CHANGED')
  for (const [name, bytes] of Object.entries(expected)) {
    const file = join(path, name)
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== bytes.length
      || !(await readFile(file)).equals(bytes)) throw refused('COMPUTE_PRIVATE_MAC_VIDEO_PACKAGE_CHANGED')
  }
}

async function materialize(root: string, signal: AbortSignal): Promise<string> {
  if (!isAbsolute(root) || root.includes('\0')) throw refused('COMPUTE_PRIVATE_MAC_VIDEO_PACKAGE_PATH_INVALID', 400)
  const expected = reviewedBytes()
  await mkdir(root, { recursive: true, mode: 0o700 })
  const rootStat = await lstat(root)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw refused('COMPUTE_PRIVATE_MAC_VIDEO_PACKAGE_PATH_INVALID', 400)
  const destination = join(root, `reviewed-${PRIVATE_MAC_VIDEO_ARCHIVE_SHA256}`)
  try {
    await verifyDirectory(destination, expected)
    return join(destination, ARCHIVE)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  signal.throwIfAborted()
  const staging = await mkdtemp(join(root, '.reviewed-mac-video-'))
  try {
    for (const [name, bytes] of Object.entries(expected)) {
      await writeFile(join(staging, name), bytes, { flag: 'wx', mode: 0o600 })
    }
    await verifyDirectory(staging, expected)
    signal.throwIfAborted()
    try { await rename(staging, destination) }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
    }
    await verifyDirectory(destination, expected)
    return join(destination, ARCHIVE)
  } finally { await rm(staging, { recursive: true, force: true }) }
}

/** Create the fixed private bundle and use the same profile transaction as the UI's local install. */
export async function installReviewedMacVideoDraft(value: {
  readonly draftId: string
  readonly expectedUpdatedAt: string
  readonly drafts: Pick<LocalPluginDraftStore, 'list'>
  readonly packageRoot: string
  readonly profileDir: string
  readonly manager: PrivateMacVideoInstallManager
  readonly executors: Pick<ComputeExecutorRegistry, 'resolve'>
  readonly factory: Pick<MacDrawnVideoFactory, 'available'>
  readonly signal: AbortSignal
  readonly approve: (reason: string) => Promise<string>
}): Promise<PrivateMacVideoDraftInstallReceipt> {
  const draftId = parsePluginDraftId(value.draftId)
  if (process.platform !== 'darwin' || !value.factory.available
    || typeof value.expectedUpdatedAt !== 'string' || !Number.isFinite(Date.parse(value.expectedUpdatedAt))) {
    throw refused('COMPUTE_PRIVATE_MAC_VIDEO_TEMPLATE_UNAVAILABLE')
  }
  const readDraft = async () => {
    const draft = (await value.drafts.list()).find(item => item.id === draftId)
    if (!draft || draft.updatedAt !== value.expectedUpdatedAt || !matchesTemplate(draft.spec)) {
      throw refused('COMPUTE_PRIVATE_MAC_VIDEO_DRAFT_MISMATCH')
    }
    return draft
  }
  value.signal.throwIfAborted()
  const draft = await readDraft()
  const decision = await value.approve(`把本机私有草稿 ${draft.id}（版本 ${draft.updatedAt}）安装为已审核的 ${PRIVATE_MAC_VIDEO_PACKAGE}@${PRIVATE_MAC_VIDEO_VERSION}。固定包 SHA-256 ${PRIVATE_MAC_VIDEO_ARCHIVE_SHA256}；只在这台 Mac 生效，安装后仍需本机试跑，不上架、不向上海声明接单、不收费。只授权这一次安装吗？`)
  if (decision !== 'allowed-once') throw refused('COMPUTE_PRIVATE_MAC_VIDEO_OWNER_APPROVAL_REQUIRED', 403)
  value.signal.throwIfAborted()
  await readDraft()
  const archivePath = await materialize(value.packageRoot, value.signal)
  const installed = (await value.manager.listBundles()).find(item => item.name === PRIVATE_MAC_VIDEO_PACKAGE)
  let state: PrivateMacVideoDraftInstallReceipt['state']
  if (installed?.installed) {
    await verifyPrivateMacVideoInstallation({ profileDir: value.profileDir,
      manager: value.manager, executors: value.executors, factory: value.factory })
    state = 'active-private'
  } else {
    value.signal.throwIfAborted()
    const result = await value.manager.installBundle(archivePath, { enabled: true })
    if (result.bundle !== PRIVATE_MAC_VIDEO_PACKAGE
      || (result.application !== 'applied' && result.application !== 'restart-required')) {
      throw refused('COMPUTE_PRIVATE_MAC_VIDEO_INSTALL_FAILED', 503)
    }
    if (result.application === 'applied') {
      await verifyPrivateMacVideoInstallation({ profileDir: value.profileDir,
        manager: value.manager, executors: value.executors, factory: value.factory })
      state = 'active-private'
    } else state = 'restart-required'
  }
  await readDraft()
  return { format: 'qianshou.private-mac-video-draft-install.v1', draftId,
    draftUpdatedAt: draft.updatedAt, packageName: PRIVATE_MAC_VIDEO_PACKAGE,
    version: PRIVATE_MAC_VIDEO_VERSION, archiveSha256: PRIVATE_MAC_VIDEO_ARCHIVE_SHA256,
    archivePath, state, localOnly: true, signed: false, marketInstalled: false, dispatchable: false }
}
