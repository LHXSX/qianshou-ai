/** Explicit Host registration for installed skills that can become order adapters. */
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { installedOrderAdapter, installedOrderAdapterSource,
  type InstalledOrderAdapter, type InstalledOrderAdapterSource } from './installed-order-adapter.ts'
import { CatalogFailure } from './registry.ts'
import { readGenericOrderSource, verifyGenericOrderAdapter } from './generic-order-adapter.ts'
import type { GenericTaskDefinition } from './generic-order-source.ts'
import { nativeH3PublicBindingDigest,
  type AnyNativeH3Declaration as NativeH3Declaration } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { readNativeH3OrderSource, type NativeH3TaskDefinition } from './native-h3-order-source.ts'
import { readComfyVideoOrderSource, type ComfyVideoTaskDefinition } from './comfy-video-order-source.ts'
import { LEGACY_INVENTORY_ALGORITHM, SOURCE_INVENTORY_ALGORITHM, NATIVE_BINDING_INVENTORY_ALGORITHM,
  COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM } from './order-source-inventory.ts'

const MAX_DESCRIPTOR_BYTES = 8 * 1024
const DIGEST = /^sha256:[a-f0-9]{64}$/u

interface LocalSelection {
  readonly taskType: string
  readonly artifactDigest: string
  readonly packageDigest: string
  readonly localOwnerConfigDigest?: string
  readonly inventoryAlgorithm: string
  readonly localVerified: boolean
  readonly platformReady: boolean
}

export interface ArtifactContributor {
  /** Host must compare the author-private package and its current local trial to these public digests. */
  selectReviewedComfyVideoAuthorBinding?: (selection: {
    publicContract: ComfyVideoTaskDefinition['publicContract']
    sourceDigest: string
    taskDefinitionSha256: string
    packageDigest: string
  }) => Promise<LocalSelection>
  selectArtifactAdapter?: (selection: {
    root: string
    digest: string
    pythonPath: string
    swiftPath: string
  }) => Promise<LocalSelection>
  selectNativeH3AuthorBinding?: (selection: {
    declaration: NativeH3Declaration
    sourceDigest: string
    taskDefinitionSha256: string
  }) => Promise<LocalSelection>
}

export interface PreparedRegisteredOrderAdapter {
  readonly root: string
  readonly digest: string
  readonly version: string
  readonly taskType: string
  readonly capabilityId: string
  readonly inputKinds: readonly ['inline'] | readonly ['multi_file']
  readonly outputKind: 'artifact_ref' | 'inline_json'
  readonly contractVersion: 'v1' | 'v2'
  readonly category: string
  readonly inventoryAlgorithm: typeof LEGACY_INVENTORY_ALGORITHM | typeof SOURCE_INVENTORY_ALGORITHM
    | typeof NATIVE_BINDING_INVENTORY_ALGORITHM | typeof COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM
  readonly taskDefinition: GenericTaskDefinition | NativeH3TaskDefinition | ComfyVideoTaskDefinition | null
  readonly taskDefinitionSha256: string | null
  verifyLocal(contributor: ArtifactContributor | undefined): Promise<LocalSelection>
}

interface AdapterRegistration {
  readonly taskType: string
  readonly schema: string
  readonly declaredInputKind: string
  readonly declaredOutputKind: string
  readonly capabilityId: string
  readonly inputKinds: readonly ['inline']
  readonly outputKind: 'artifact_ref'
  readonly contractVersion: 'v1'
  readonly category: string
  identify(skillPath: string): Promise<InstalledOrderAdapterSource>
  prepare(skillPath: string): Promise<InstalledOrderAdapter>
  verify(adapter: InstalledOrderAdapter, contributor: ArtifactContributor | undefined): Promise<LocalSelection>
}

async function verifySvgMedia(adapter: InstalledOrderAdapter,
  contributor: ArtifactContributor | undefined): Promise<LocalSelection> {
  if (!contributor?.selectArtifactAdapter) throw new CatalogFailure('order-node-contributor-unavailable')
  let selected: LocalSelection
  try {
    selected = await contributor.selectArtifactAdapter({ root: adapter.root, digest: adapter.digest,
      pythonPath: adapter.pythonPath, swiftPath: adapter.swiftPath })
  } catch { throw new CatalogFailure('order-local-verification-failed') }
  if (selected.taskType !== adapter.taskType || selected.artifactDigest !== `sha256:${adapter.digest}`
    || !DIGEST.test(selected.packageDigest) || ! selected.localVerified
    || selected.inventoryAlgorithm !== 'qianshou.bar-chart-package.v4') {
    throw new CatalogFailure('order-local-verification-failed')
  }
  return selected
}

// A new task type needs its own audited Host preparer, local verifier and platform contract.
// Merely adding local-adapter.json or SKILL.md never registers executable code here.
const REGISTRATIONS: readonly AdapterRegistration[] = [{
  taskType: 'bar_chart_svg_v1', schema: 'qianshou.local-adapter-candidate.v1',
  declaredInputKind: 'inline_json', declaredOutputKind: 'local_artifact_manifest',
  capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref',
  contractVersion: 'v1', category: 'video',
  identify: installedOrderAdapterSource,
  prepare: skillPath => installedOrderAdapter(skillPath, { prepareRuntime: true }),
  verify: verifySvgMedia,
}]

function inside(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}

async function declaredAdapter(skillPath: string): Promise<Record<string, unknown>> {
  try {
    const skillDir = await realpath(dirname(skillPath))
    const root = await realpath(join(skillDir, 'scripts', 'order_adapter'))
    if (!inside(skillDir, root)) throw new Error('Adapter escaped installed skill')
    const descriptorPath = join(root, 'local-adapter.json')
    const stat = await lstat(descriptorPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_DESCRIPTOR_BYTES) {
      throw new Error('Adapter declaration must be a bounded regular file')
    }
    const bytes = await readFile(descriptorPath)
    if (bytes.length !== stat.size) throw new Error('Adapter declaration changed during read')
    const parsed: unknown = JSON.parse(bytes.toString('utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid declaration')
    return parsed as Record<string, unknown>
  } catch { throw new CatalogFailure('order-adapter-invalid') }
}

async function registrationOf(skillPath: string): Promise<AdapterRegistration> {
  const declaration = await declaredAdapter(skillPath)
  const registration = REGISTRATIONS.find(item => item.taskType === declaration.taskType
    && item.schema === declaration.schema && item.declaredInputKind === declaration.inputKind
    && item.declaredOutputKind === declaration.outputKind)
  if (!registration) throw new CatalogFailure('order-adapter-invalid')
  return registration
}

/** Identify the exact installed source without changing or executing its runtime. */
export async function identifyRegisteredOrderAdapter(skillPath: string): Promise<{
  taskType: string
  artifactDigest: string
  platformPriced: boolean
  serviceTitle?: string
  serviceDescription?: string
}> {
  const declaration = await declaredAdapter(skillPath)
  if (declaration.schema === 'qianshou.comfy-video-binding.v1') {
    const source = await readComfyVideoOrderSource(skillPath)
    return { taskType: source.declaration.taskType, artifactDigest: `sha256:${source.digest}`,
      platformPriced: true, serviceTitle: '五秒视频生成',
      serviceDescription: '输入提示词与首帧，由受审的本机 Comfy 视频能力生成 MP4。' }
  }
  if ((declaration.schema === 'qianshou.native-h3-binding.v1' || declaration.schema === 'qianshou.native-h3-binding.v2')) {
    const source = await readNativeH3OrderSource(skillPath)
    return { taskType: source.declaration.taskType, artifactDigest: `sha256:${source.digest}`,
      platformPriced: true, serviceTitle: source.taskDefinition.title,
      serviceDescription: source.taskDefinition.description }
  }
  if (declaration.schema === 'qianshou.local-adapter-candidate.v2'
    || declaration.schema === 'qianshou.local-adapter-candidate.v3') {
    const source = await readGenericOrderSource(skillPath)
    return { taskType: source.declaration.taskType, artifactDigest: `sha256:${source.digest}`,
      platformPriced: source.taskDefinition !== null,
      ...(source.taskDefinition?.title === undefined ? {} : { serviceTitle: source.taskDefinition.title }),
      ...(source.taskDefinition?.description === undefined ? {} : { serviceDescription: source.taskDefinition.description }) }
  }
  const registration = await registrationOf(skillPath)
  try {
    const source = await registration.identify(skillPath)
    if (source.taskType !== registration.taskType || source.capabilityId !== registration.capabilityId) {
      throw new CatalogFailure('order-adapter-invalid')
    }
    return { taskType: source.taskType, artifactDigest: `sha256:${source.digest}`, platformPriced: false }
  } catch { throw new CatalogFailure('order-adapter-invalid') }
}

/** Resolve by a bounded declared contract, then run only the matching built-in preparer. */
export async function prepareRegisteredOrderAdapter(skillPath: string): Promise<PreparedRegisteredOrderAdapter> {
  const declaration = await declaredAdapter(skillPath)
  if (declaration.schema === 'qianshou.comfy-video-binding.v1') {
    const source = await readComfyVideoOrderSource(skillPath)
    const definition = source.files.find(file => file.path === 'task-definition.json')
    if (definition === undefined) throw new CatalogFailure('order-draft-invalid')
    const definitionDigest = `sha256:${createHash('sha256').update(definition.bytes).digest('hex')}`
    return { root: source.root, digest: source.digest, version: source.version,
      taskType: source.declaration.taskType, capabilityId: 'video.render', inputKinds: ['multi_file'],
      outputKind: 'artifact_ref', contractVersion: 'v1', category: 'video',
      inventoryAlgorithm: COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM,
      taskDefinition: source.taskDefinition, taskDefinitionSha256: definitionDigest,
      verifyLocal: async contributor => {
        if (!contributor?.selectReviewedComfyVideoAuthorBinding) {
          throw new CatalogFailure('order-node-contributor-unavailable')
        }
        let selected: LocalSelection
        try {
          selected = await contributor.selectReviewedComfyVideoAuthorBinding({
            publicContract: source.taskDefinition.publicContract,
            sourceDigest: `sha256:${source.digest}`, taskDefinitionSha256: definitionDigest,
            packageDigest: source.declaration.packageDigest })
        } catch { throw new CatalogFailure('order-local-verification-failed') }
        if (selected.taskType !== source.declaration.taskType
          || selected.artifactDigest !== `sha256:${source.digest}`
          || selected.packageDigest !== source.declaration.packageDigest
          || selected.inventoryAlgorithm !== COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM
          || selected.localVerified !== true || selected.platformReady !== false) {
          throw new CatalogFailure('order-local-verification-failed')
        }
        return selected
      } }
  }
  if ((declaration.schema === 'qianshou.native-h3-binding.v1' || declaration.schema === 'qianshou.native-h3-binding.v2')) {
    const source = await readNativeH3OrderSource(skillPath)
    const definition = source.files.find(file => file.path === 'task-definition.json')
    if (definition === undefined) throw new CatalogFailure('order-draft-invalid')
    const definitionDigest = `sha256:${createHash('sha256').update(definition.bytes).digest('hex')}`
    return { root: source.root, digest: source.digest, version: source.version,
      taskType: source.declaration.taskType, capabilityId: 'video.render', inputKinds: ['inline'],
      outputKind: 'artifact_ref', contractVersion: source.declaration.contractVersion, category: 'video',
      inventoryAlgorithm: NATIVE_BINDING_INVENTORY_ALGORITHM, taskDefinition: source.taskDefinition,
      taskDefinitionSha256: definitionDigest,
      verifyLocal: async (contributor) => {
        if (!contributor?.selectNativeH3AuthorBinding) throw new CatalogFailure('order-node-contributor-unavailable')
        let selected: LocalSelection
        try { selected = await contributor.selectNativeH3AuthorBinding({ declaration: source.declaration,
          sourceDigest: `sha256:${source.digest}`, taskDefinitionSha256: definitionDigest }) }
        catch { throw new CatalogFailure('order-local-verification-failed') }
        if (selected.taskType !== source.declaration.taskType || selected.artifactDigest !== `sha256:${source.digest}`
          || selected.packageDigest !== nativeH3PublicBindingDigest(source.declaration)
          || selected.inventoryAlgorithm !== NATIVE_BINDING_INVENTORY_ALGORITHM || ! selected.localVerified) {
          throw new CatalogFailure('order-local-verification-failed')
        }
        return selected
      } }
  }
  if (declaration.schema === 'qianshou.local-adapter-candidate.v2'
    || declaration.schema === 'qianshou.local-adapter-candidate.v3') {
    const source = await readGenericOrderSource(skillPath)
    const contract = source.declaration
    const definitionBytes = source.files.find(file => file.path === 'task-definition.json')?.bytes
    return { root: source.root, digest: source.digest, version: source.version,
      taskType: contract.taskType, capabilityId: contract.capabilityId,
      inputKinds: contract.inputKinds, outputKind: contract.outputKind,
      contractVersion: contract.contractVersion, category: contract.category,
      inventoryAlgorithm: SOURCE_INVENTORY_ALGORITHM,
      taskDefinition: source.taskDefinition,
      taskDefinitionSha256: definitionBytes === undefined ? null
        : `sha256:${createHash('sha256').update(definitionBytes).digest('hex')}`,
      verifyLocal: () => verifyGenericOrderAdapter(source) }
  }
  const registration = await registrationOf(skillPath)
  let adapter: InstalledOrderAdapter
  try { adapter = await registration.prepare(skillPath) }
  catch (error) {
    if (error instanceof CatalogFailure && error.code === 'order-runtime-unavailable') throw error
    throw new CatalogFailure('order-adapter-invalid')
  }
  if (adapter.taskType !== registration.taskType || adapter.capabilityId !== registration.capabilityId) {
    throw new CatalogFailure('order-adapter-invalid')
  }
  return {
    root: adapter.root, digest: adapter.digest, version: adapter.version,
    taskType: registration.taskType, capabilityId: registration.capabilityId,
    inputKinds: registration.inputKinds, outputKind: registration.outputKind,
    contractVersion: registration.contractVersion, category: registration.category,
    inventoryAlgorithm: LEGACY_INVENTORY_ALGORITHM,
    taskDefinition: null,
    taskDefinitionSha256: null,
    verifyLocal: contributor => registration.verify(adapter, contributor),
  }
}
