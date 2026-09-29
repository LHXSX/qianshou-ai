/** Host-only, private Comfy package review. A reviewed archive is never a market install. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { writeFileAtomic, withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { preparePrivateComfyDraftAsset, PRIVATE_COMFY_EXECUTOR_CAPABILITY,
  PRIVATE_COMFY_EXECUTOR_VERSION, preflightLocalComfyWorkflow,
  createLocalCapabilityPluginRuntime, ComputeExecutorRegistry,
  type PrivateComfyDraftAsset, type ComputePluginPermission } from '@deepseek-ai/dsh-compute-core'
import { parseSignedReleaseBody } from './release-preview.ts'
import { inspectReviewedArchive, readReviewedArchiveEntry } from './reviewed-archive.ts'
import type { ReviewedStageResult } from './reviewed-staging.ts'

const MANIFEST_PATH = 'manifest.json'
const GRAPH_PATH = 'comfy/workflow-api.json'
const SHA256 = /^[a-f0-9]{64}$/u
const DECODER = new TextDecoder('utf-8', { fatal: true })

export interface PrivateComfyInstallIdentity {
  readonly releaseId: string
  readonly operationId: string
  readonly packageSha256: string
  readonly manifestSha256: string
  readonly graphSha256: string
  readonly executorVersion: string
}

/** Review artifact only: no publication, market install, or order admission. */
export interface PrivateComfyInstallCandidate {
  readonly identity: PrivateComfyInstallIdentity
  readonly identitySha256: string
  readonly pluginId: string
  readonly version: string
  readonly state: 'private-review-only'
  readonly installable: false
  readonly dispatchable: false
}

export interface PrivateComfyReviewRequest {
  readonly stage: ReviewedStageResult
  readonly operationId: string
  readonly publisherKeys: Readonly<Record<string, string>>
  readonly operatorKeys: Readonly<Record<string, string>>
  readonly signal: AbortSignal
}

interface PrivateManifest {
  format: 'qianshou.comfy-private-package.v1'
  releaseId: string
  pluginId: string
  version: string
  operationId: string
  capabilityId: typeof PRIVATE_COMFY_EXECUTOR_CAPABILITY
  executorVersion: typeof PRIVATE_COMFY_EXECUTOR_VERSION
  inputSchemaSha256: string
  outputSchemaSha256: string
  graphSha256: string
  mapping: PrivateComfyDraftAsset['mapping']
}

function invalid(): never { throw new Error('QIANSHOU_PRIVATE_COMFY_INSTALL_INVALID') }
function hash(value: Buffer | string): string { return createHash('sha256').update(value).digest('hex') }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function exact(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
function parseJson(bytes: Buffer): unknown {
  try { return JSON.parse(DECODER.decode(bytes)) as unknown } catch { return invalid() }
}
function identityDigest(identity: PrivateComfyInstallIdentity): string {
  return hash(JSON.stringify({ releaseId: identity.releaseId, operationId: identity.operationId,
    packageSha256: identity.packageSha256, manifestSha256: identity.manifestSha256,
    graphSha256: identity.graphSha256, executorVersion: identity.executorVersion }))
}
export { identityDigest as privateComfyInstallIdentitySha256 }

async function packageDigest(path: string, expectedBytes: number, signal: AbortSignal): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (!before.isFile() || (before.mode & 0o077) !== 0 || before.size !== expectedBytes) invalid()
    const digest = createHash('sha256')
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      signal.throwIfAborted()
      digest.update(chunk)
    }
    const after = await handle.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino) invalid()
    return digest.digest('hex')
  } finally { await handle.close() }
}

async function inspect(request: PrivateComfyReviewRequest): Promise<{
  candidate: PrivateComfyInstallCandidate; asset: PrivateComfyDraftAsset; manifest: PrivateManifest;
  permissions: readonly ComputePluginPermission[]
}> {
  request.signal.throwIfAborted()
  const stage = request.stage
  if (!stage || stage.installable !== false || !isAbsolute(stage.archivePath)
    || !SHA256.test(stage.packageSha256) || stage.signedRelease?.installable !== false) invalid()
  // The staged declaration can be mutated in memory; verify both signatures again at use time.
  const releases = parseSignedReleaseBody({ releases: [stage.signedRelease] },
    request.publisherKeys, request.operatorKeys)
  const release = releases?.[0]
  if (!release || release.releaseId !== stage.releaseId || release.pluginId !== stage.pluginId
    || release.version !== stage.version || release.packageSha256 !== stage.packageSha256
    || release.packageBytes !== stage.packageBytes || !release.platforms.includes(process.platform as never)
    || !release.architectures.includes(process.arch as never)) invalid()
  const operation = release.operations.find(item => item.operationId === request.operationId)
  if (!operation || operation.capabilityId !== PRIVATE_COMFY_EXECUTOR_CAPABILITY
    || operation.executorKind !== 'workflow') invalid()
  if (await packageDigest(stage.archivePath, stage.packageBytes, request.signal) !== stage.packageSha256) invalid()
  const entries = await inspectReviewedArchive(stage.archivePath, stage.packageBytes, request.signal)
  if (entries.length !== 2 || entries.some(entry => entry.path !== MANIFEST_PATH && entry.path !== GRAPH_PATH)
    || JSON.stringify(entries) !== JSON.stringify(stage.entries)) invalid()
  const manifestEntry = entries.find(entry => entry.path === MANIFEST_PATH)
  const graphEntry = entries.find(entry => entry.path === GRAPH_PATH)
  if (!manifestEntry || !graphEntry) invalid()
  const manifestBytes = await readReviewedArchiveEntry(stage.archivePath, stage.packageBytes,
    MANIFEST_PATH, manifestEntry.sha256, 32 * 1024, request.signal)
  const graphBytes = await readReviewedArchiveEntry(stage.archivePath, stage.packageBytes,
    GRAPH_PATH, graphEntry.sha256, 256 * 1024, request.signal)
  const parsed = record(parseJson(manifestBytes))
  if (!parsed || !exact(parsed, ['format', 'releaseId', 'pluginId', 'version', 'operationId',
    'capabilityId', 'executorVersion', 'inputSchemaSha256', 'outputSchemaSha256', 'graphSha256', 'mapping'])
    || parsed.format !== 'qianshou.comfy-private-package.v1'
    || parsed.releaseId !== release.releaseId || parsed.pluginId !== release.pluginId
    || parsed.version !== release.version || parsed.operationId !== operation.operationId
    || parsed.capabilityId !== PRIVATE_COMFY_EXECUTOR_CAPABILITY
    || parsed.executorVersion !== PRIVATE_COMFY_EXECUTOR_VERSION
    || parsed.inputSchemaSha256 !== operation.inputSchemaSha256
    || parsed.outputSchemaSha256 !== operation.outputSchemaSha256
    || typeof parsed.graphSha256 !== 'string' || !SHA256.test(parsed.graphSha256)) invalid()
  const asset = preparePrivateComfyDraftAsset({ operationId: request.operationId,
    workflow: parseJson(graphBytes), mapping: parsed.mapping })
  if (asset.graphSha256 !== parsed.graphSha256) invalid()
  const outputs = Object.values(asset.graph).filter(node => node.class_type === 'SaveImage' || node.class_type === 'SaveImageWebsocket')
  if (outputs.length !== 1 || outputs[0]?.class_type !== 'SaveImage'
    || asset.graph[asset.mapping.outputNodeId] !== outputs[0]) invalid()
  if (await packageDigest(stage.archivePath, stage.packageBytes, request.signal) !== stage.packageSha256) invalid()
  const identity: PrivateComfyInstallIdentity = Object.freeze({ releaseId: release.releaseId,
    operationId: operation.operationId, packageSha256: release.packageSha256,
    manifestSha256: hash(manifestBytes), graphSha256: asset.graphSha256,
    executorVersion: PRIVATE_COMFY_EXECUTOR_VERSION })
  return { candidate: Object.freeze({ identity, identitySha256: identityDigest(identity),
    pluginId: release.pluginId, version: release.version,
    state: 'private-review-only', installable: false, dispatchable: false }),
    asset, manifest: parsed as unknown as PrivateManifest,
    permissions: operation.permissions as ComputePluginPermission[] }
}

/** Review signed transport plus an exact, data-only Comfy package; never install it. */
export async function preparePrivateComfyInstallCandidate(request: PrivateComfyReviewRequest): Promise<PrivateComfyInstallCandidate> {
  return (await inspect(request)).candidate
}

/** These callbacks are deliberately absent from the shipping catalog. A caller must supply
 * a trusted license verifier, a fresh owner decision, and an exact graph-bound loader. */
export interface PrivateComfyActivationGates {
  readonly verifyLicense: (identity: PrivateComfyInstallIdentity, signal: AbortSignal) => Promise<boolean>
  readonly approveOwner: (identitySha256: string, signal: AbortSignal) => Promise<boolean>
  readonly loadBoundExecutor: (identity: PrivateComfyInstallIdentity, asset: PrivateComfyDraftAsset,
    signal: AbortSignal) => Promise<{ readonly identitySha256: string;
      readonly executors: ComputeExecutorRegistry; readonly dispose: () => Promise<void> }>
}

export interface PrivateComfyActivationRequest extends PrivateComfyReviewRequest {
  readonly candidate: PrivateComfyInstallCandidate
  readonly privateRecordDir: string
  readonly port: number
  readonly gates?: PrivateComfyActivationGates
  readonly fetcher?: typeof fetch
}

/** Atomically persist a private local activation receipt only after every gate succeeds.
 * The record never grants market installation, dispatch, or post-restart readiness. */
export async function activatePrivateComfyInstallCandidate(request: PrivateComfyActivationRequest): Promise<{
  readonly recordPath: string; readonly dispose: () => Promise<void>
}> {
  const { candidate, asset, manifest, permissions } = await inspect(request)
  if (request.candidate?.identitySha256 !== candidate.identitySha256
    || JSON.stringify(request.candidate.identity) !== JSON.stringify(candidate.identity)
    || !request.gates || !Number.isSafeInteger(request.port) || request.port < 1024 || request.port > 65535
    || !isAbsolute(request.privateRecordDir)) invalid()
  const dir = await lstat(request.privateRecordDir)
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) !== 0) invalid()
  if (!await request.gates.verifyLicense(candidate.identity, request.signal)
    || !await request.gates.approveOwner(candidate.identitySha256, request.signal)) invalid()
  const live = await preflightLocalComfyWorkflow({ workflow: asset.graph, port: request.port },
    request.signal, request.fetcher)
  if (live.sha256 !== candidate.identity.graphSha256 || live.nodes.length !== asset.nodeCount
    || live.nodes.every(node => node.modelFields.length === 0)
    || live.nodes.some(node => node.available !== true
      || node.modelFields.some(field => field.selectable !== true))) invalid()
  const bound = await request.gates.loadBoundExecutor(candidate.identity, asset, request.signal)
  let committed = false
  try {
    if (bound.identitySha256 !== candidate.identitySha256
      || !(bound.executors instanceof ComputeExecutorRegistry)
      || typeof bound.dispose !== 'function') invalid()
    const runtime = createLocalCapabilityPluginRuntime({
      manifest: { manifestVersion: 1, pluginId: candidate.pluginId, version: candidate.version,
        displayName: candidate.pluginId, hostRange: '*', pluginDigest: candidate.identity.packageSha256,
        capabilities: [{ id: PRIVATE_COMFY_EXECUTOR_CAPABILITY,
          version: manifest.executorVersion, inputKinds: ['text'], outputKinds: ['image.png'],
          permissions, dataScope: 'task-inputs' }] },
      executors: bound.executors,
    })
    if (runtime.preflight().state !== 'ready') invalid()
    request.signal.throwIfAborted()
    const recordPath = join(request.privateRecordDir, `${candidate.identitySha256}.json`)
    await withFileLock(recordPath, async () => {
      try { await lstat(recordPath); invalid() } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      request.signal.throwIfAborted()
      await writeFileAtomic(recordPath, JSON.stringify({ format: 'qianshou.comfy-private-activation.v1',
        identity: candidate.identity, identitySha256: candidate.identitySha256,
        installable: false, dispatchable: false }) + '\n', { mode: 0o600, dirMode: 0o700 })
    })
    committed = true
    return { recordPath, dispose: bound.dispose }
  } finally { if (!committed) await bound.dispose() }
}
