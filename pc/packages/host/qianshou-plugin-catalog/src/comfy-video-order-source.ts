/** Four-file, data-only source for one reviewed five-second Comfy video product. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { comfyVideoPublicContractDigest, parseComfyVideoPublicContract,
  type ComfyVideoPublicContract } from '@deepseek-ai/dsh-compute-core/comfy-video-public-contract'
import { canonicalOrderJson } from './order-json-canonical.ts'
import { canonicalSourceJson } from './order-source-json.ts'
import { COMFY_VIDEO_BINDING_FILES, COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM,
  EMPTY_ORDER_SOURCE_LOCK, validateOrderSourceInventory } from './order-source-inventory.ts'
import { CatalogFailure } from './registry.ts'

const HASH = /^sha256:[a-f0-9]{64}$/u
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u
const PACKAGE_NAME = /^qianshou-[a-z0-9][a-z0-9-]{0,80}$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/u

function invalid(): never { throw new CatalogFailure('order-adapter-invalid') }
function inside(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function canonicalRecord(bytes: Buffer): Record<string, unknown> {
  try {
    if (!bytes.equals(canonicalSourceJson(bytes))) invalid()
    return record(JSON.parse(bytes.toString('utf8')) as unknown)
  } catch { return invalid() }
}

/** Public source binding; its private graph and executable dependencies never enter the archive. */
export interface ComfyVideoOrderDeclaration {
  readonly schema: 'qianshou.comfy-video-binding.v1'
  readonly taskType: string
  readonly capabilityId: 'video.render'
  readonly inputKinds: readonly ['multi_file']
  readonly outputKind: 'artifact_ref'
  readonly contractVersion: 'v1'
  readonly category: 'video'
  readonly platformDispatchable: true
  readonly approvedContractDigest: string
  /** Digest of the independently installed, owner-private runner package. */
  readonly packageDigest: string
}

export interface ComfyVideoTaskDefinition {
  readonly schema: 'qianshou.reviewed-task-definition.v1'
  readonly taskType: string
  readonly capabilityId: 'video.render'
  readonly category: 'video'
  readonly inputKinds: readonly ['multi_file']
  readonly outputKind: 'artifact_ref'
  readonly inputContract: 'comfy-video-graph.v1'
  readonly resultStrategy: 'external-media.v1'
  readonly paramsSchema: Record<string, unknown>
  readonly inputSchema: Record<string, never>
  readonly publicContract: ComfyVideoPublicContract
}

export interface ComfyVideoOrderSource {
  readonly root: string
  readonly digest: string
  readonly version: string
  readonly declaration: ComfyVideoOrderDeclaration
  readonly taskDefinition: ComfyVideoTaskDefinition
  readonly files: readonly { readonly path: string; readonly bytes: Buffer }[]
}

/** Restrict the first product to one frame and a signed 120-frame/24-fps five-second tuple. */
export function firstComfyVideoContract(value: unknown): ComfyVideoPublicContract {
  let contract: ComfyVideoPublicContract
  try { contract = parseComfyVideoPublicContract(value) } catch { return invalid() }
  const prompt = contract.inputSlots.find(slot => slot.name === 'prompt')
  const frame = contract.inputSlots.find(slot => slot.name === 'first_frame')
  const frames = contract.inputSlots.find(slot => slot.name === 'frames')
  const fps = contract.inputSlots.find(slot => slot.name === 'fps')
  if (contract.inputSlots.length !== 4 || prompt?.kind !== 'text' || frame?.kind !== 'artifact_ref'
    || frames?.kind !== 'integer' || !['frames', 'frame_count', 'length'].includes(frames.field)
    || frames.min !== 120 || frames.max !== 120
    || fps?.kind !== 'integer' || fps.field !== 'fps' || fps.min !== 24 || fps.max !== 24
    || prompt.maxUtf8Bytes > 4096 || frame.maxBytes > 16 * 1024 * 1024
    || contract.limits.maxDurationSeconds !== 5 || contract.limits.maxFrames !== 120
    || contract.limits.maxInputBytes > 17 * 1024 * 1024
    || contract.limits.maxOutputBytes < 1024 * 1024
    || contract.limits.maxOutputBytes > 64 * 1024 * 1024) invalid()
  return contract
}

/** Match Shanghai's exact eleven-field reviewed task definition. */
export function comfyVideoTaskDefinition(value: unknown): ComfyVideoTaskDefinition {
  const publicContract = firstComfyVideoContract(value)
  const properties: Record<string, unknown> = { input_manifest: { type: 'string', maxLength: 8192 } }
  for (const slot of publicContract.inputSlots) {
    if (slot.kind === 'artifact_ref') continue
    properties[slot.name] = slot.kind === 'text'
      ? { type: 'string', minLength: 1, maxLength: slot.maxUtf8Bytes }
      : { type: 'integer', minimum: slot.min, maximum: slot.max }
  }
  return { schema: 'qianshou.reviewed-task-definition.v1', taskType: publicContract.taskType,
    capabilityId: 'video.render', category: 'video', inputKinds: ['multi_file'],
    outputKind: 'artifact_ref', inputContract: 'comfy-video-graph.v1',
    resultStrategy: 'external-media.v1',
    paramsSchema: { type: 'object', properties, required: Object.keys(properties).sort(),
      additionalProperties: false }, inputSchema: {}, publicContract }
}

function declarationOf(raw: Record<string, unknown>, contract: ComfyVideoPublicContract): ComfyVideoOrderDeclaration {
  if (Object.keys(raw).sort().join(',') !== 'approvedContractDigest,capabilityId,category,contractVersion,inputKinds,outputKind,packageDigest,platformDispatchable,schema,taskType'
    || raw.schema !== 'qianshou.comfy-video-binding.v1' || raw.taskType !== contract.taskType
    || raw.capabilityId !== 'video.render' || raw.category !== 'video'
    || !Array.isArray(raw.inputKinds) || raw.inputKinds.length !== 1 || raw.inputKinds[0] !== 'multi_file'
    || raw.outputKind !== 'artifact_ref' || raw.contractVersion !== 'v1'
    || raw.platformDispatchable !== true || typeof raw.approvedContractDigest !== 'string'
    || raw.approvedContractDigest !== comfyVideoPublicContractDigest(contract)
    || typeof raw.packageDigest !== 'string' || !HASH.test(raw.packageDigest)) invalid()
  return raw as unknown as ComfyVideoOrderDeclaration
}

/** Reopen only four regular metadata files and bind their exact canonical bytes. */
export async function readComfyVideoOrderSource(skillPath: string): Promise<ComfyVideoOrderSource> {
  try {
    const skill = await lstat(skillPath)
    if (!skill.isFile() || skill.isSymbolicLink()) invalid()
    const skillDir = await realpath(dirname(skillPath))
    const root = await realpath(join(skillDir, 'scripts', 'order_adapter'))
    if (!inside(skillDir, root)) invalid()
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length !== COMFY_VIDEO_BINDING_FILES.length
      || entries.some(entry => !entry.isFile() || entry.isSymbolicLink()
        || !COMFY_VIDEO_BINDING_FILES.some(name => name === entry.name))) invalid()
    const files: { path: string; bytes: Buffer }[] = []
    for (const name of COMFY_VIDEO_BINDING_FILES) {
      const path = join(root, name)
      const before = await lstat(path)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1
        || before.size < 1 || before.size > 8192 || !inside(root, await realpath(path))) invalid()
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let bytes: Buffer
      try {
        const opened = await handle.stat()
        if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev
          || opened.nlink !== 1 || opened.size !== before.size) invalid()
        bytes = await handle.readFile()
        if (bytes.length !== before.size) invalid()
        const after = await handle.stat()
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.nlink !== 1) invalid()
      } finally { await handle.close() }
      const after = await lstat(path)
      if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
        || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid()
      files.push({ path: name, bytes })
    }
    const byPath = new Map(files.map(file => [file.path, file.bytes]))
    const member = (name: string): Buffer => byPath.get(name) ?? invalid()
    if (member('pnpm-lock.yaml').toString('utf8') !== EMPTY_ORDER_SOURCE_LOCK) invalid()
    const manifest = canonicalRecord(member('package.json'))
    if (Object.keys(manifest).sort().join(',') !== 'name,type,version'
      || typeof manifest.name !== 'string' || !PACKAGE_NAME.test(manifest.name)
      || manifest.type !== 'module' || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)) invalid()
    const definition = canonicalRecord(member('task-definition.json'))
    const expected = comfyVideoTaskDefinition(definition.publicContract)
    if (canonicalOrderJson(definition) !== canonicalOrderJson(expected)) invalid()
    const declaration = declarationOf(canonicalRecord(member('local-adapter.json')), expected.publicContract)
    validateOrderSourceInventory(COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM,
      files.map(file => ({ path: file.path, sizeBytes: file.bytes.length,
        sha256: createHash('sha256').update(file.bytes).digest('hex') })))
    const hash = createHash('sha256')
    for (const file of files) hash.update(file.path).update('\0').update(String(file.bytes.length)).update('\0').update(file.bytes)
    return { root, digest: hash.digest('hex'), version: manifest.version, declaration,
      taskDefinition: expected, files }
  } catch { return invalid() }
}

/** Create a review candidate from a measured public contract and sealed private-package digest. */
export function comfyVideoAuthoringTemplate(value: unknown, packageDigest: string,
  name: string): { instructions: string; files: Record<string, string> } {
  if (!NAME.test(name) || !HASH.test(packageDigest)) invalid()
  const publicContract = firstComfyVideoContract(value)
  const declaration: ComfyVideoOrderDeclaration = {
    schema: 'qianshou.comfy-video-binding.v1', taskType: publicContract.taskType,
    capabilityId: 'video.render', inputKinds: ['multi_file'], outputKind: 'artifact_ref',
    contractVersion: 'v1', category: 'video', platformDispatchable: true,
    approvedContractDigest: comfyVideoPublicContractDigest(publicContract), packageDigest,
  }
  return { instructions: '这只是待审源码元数据。首商品固定 120 帧、24 fps、五秒，只接受一张首帧和提示词。工作流、模型、路径和执行脚本不得放进此目录；提交后仍须平台审核、独立视频样例与本机安装证明才能接单。',
    files: {
      'SKILL.md': `---\nname: ${name}\ndescription: 受审 Comfy 五秒视频生成\nmetadata:\n  displayName: 五秒视频生成\n  category: video\n---\n\n# 五秒视频生成\n\n输入提示词与一张首帧，确认报价后提交受审生成任务。此技能保存不等于审核通过或已经接单。\n`,
      'scripts/order_adapter/package.json': canonicalOrderJson({ name: `qianshou-${name}`, type: 'module', version: '0.0.1' }),
      'scripts/order_adapter/pnpm-lock.yaml': EMPTY_ORDER_SOURCE_LOCK,
      'scripts/order_adapter/local-adapter.json': canonicalOrderJson(declaration),
      'scripts/order_adapter/task-definition.json': canonicalOrderJson(comfyVideoTaskDefinition(publicContract)),
    } }
}
