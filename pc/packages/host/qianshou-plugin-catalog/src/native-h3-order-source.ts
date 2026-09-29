/** Metadata-only skill package for the audited Windows H3 runner. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { parseAnyNativeH3Declaration, nativeH3DeclarationBinding, type AnyNativeH3ContractBinding as NativeH3AuthorBinding,
  type AnyNativeH3Declaration as NativeH3Declaration }
  from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { canonicalOrderJson } from './order-json-canonical.ts'
import { canonicalSourceJson } from './order-source-json.ts'
import { EMPTY_ORDER_SOURCE_LOCK, NATIVE_BINDING_FILES, NATIVE_BINDING_INVENTORY_ALGORITHM,
  validateOrderSourceInventory } from './order-source-inventory.ts'
import { CatalogFailure } from './registry.ts'
import type { GenericTaskDefinition } from './generic-order-source.ts'

/** Public video form and immutable runtime digests without private model, workflow or executable paths. */
export interface NativeH3TaskDefinition extends Omit<GenericTaskDefinition, 'schema'> {
  readonly schema: 'qianshou.reviewed-task-definition.v1' | 'qianshou.reviewed-task-definition.v2'
  readonly title: string
  readonly description: string
  readonly nativeBinding: NativeH3AuthorBinding
}

/** Validated four-file metadata inventory and its content digest for an author publication. */
export interface NativeH3OrderSource {
  readonly root: string
  readonly digest: string
  readonly version: string
  readonly declaration: NativeH3Declaration
  readonly taskDefinition: NativeH3TaskDefinition
  readonly files: readonly { readonly path: string; readonly bytes: Buffer }[]
}

function invalid(): never { throw new CatalogFailure('order-adapter-invalid') }
function inside(root: string, path: string): boolean {
  const offset = relative(root, path)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function parseCanonical(bytes: Buffer): Record<string, unknown> {
  if (!bytes.equals(canonicalSourceJson(bytes))) invalid()
  return record(JSON.parse(bytes.toString('utf8')) as unknown)
}

/** Build the fixed public form while keeping model, workflow and executable paths private.
 * @param declaration - Native task identity and the provider's immutable runtime binding.
 * @param title - Nonblank public title containing at most eighty Unicode code points.
 * @param description - Nonblank public description containing at most five hundred Unicode code points.
 * @returns The canonical five-second video task definition with an optional bounded seed.
 */
export function nativeH3TaskDefinition(declaration: NativeH3Declaration,
  title: string, description: string): NativeH3TaskDefinition {
  if (!title.isWellFormed() || !description.isWellFormed() || !title.trim()
    || !description.trim() || Array.from(title).length > 80 || Array.from(description).length > 500) invalid()
  return {
    schema: declaration.contractVersion === 'v2' ? 'qianshou.reviewed-task-definition.v2'
      : 'qianshou.reviewed-task-definition.v1', title, description,
    taskType: declaration.taskType, capabilityId: declaration.capabilityId, category: declaration.category,
    inputKinds: ['inline'], outputKind: 'artifact_ref',
    inputContract: 'h3-prompt-fixed-frame.v1', resultStrategy: 'external-media.v1',
    inputSchema: { type: 'string', title: '描述你想生成的视频', contentMediaType: 'text/plain', minLength: 1, maxLength: 7000 },
    paramsSchema: { type: 'object', additionalProperties: false, properties: {
      seconds: { type: 'integer', title: '视频时长（秒）', enum: [5], minimum: 5, maximum: 5 },
      seed: { type: 'integer', title: '随机种子（可选）', minimum: 1, maximum: 2147483647 },
    }, required: [] },
    nativeBinding: nativeH3DeclarationBinding(declaration),
  }
}

/** Read four exact canonical metadata files with bounded reads and stable file identities.
 * @param skillPath - Regular SKILL.md path whose adjacent scripts/order_adapter inventory is read.
 * @returns Validated source files, declaration, public task definition, version and inventory digest.
 */
export async function readNativeH3OrderSource(skillPath: string): Promise<NativeH3OrderSource> {
  try {
    const skillStat = await lstat(skillPath)
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) invalid()
    const skillDir = await realpath(dirname(skillPath))
    const scripts = join(skillDir, 'scripts')
    const declaredRoot = join(scripts, 'order_adapter')
    for (const path of [scripts, declaredRoot]) {
      const stat = await lstat(path)
      if (!stat.isDirectory() || stat.isSymbolicLink()) invalid()
    }
    const root = await realpath(declaredRoot)
    if (!inside(skillDir, root)) invalid()
    const entries = await readdir(root, { withFileTypes: true })
    if (entries.length !== NATIVE_BINDING_FILES.length
      || entries.some(entry => !entry.isFile() || entry.isSymbolicLink()
        || !NATIVE_BINDING_FILES.some(name => name === entry.name))) invalid()
    const files: { path: string; bytes: Buffer }[] = []
    for (const name of NATIVE_BINDING_FILES) {
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
        const buffer = Buffer.alloc(8193)
        let length = 0
        while (length < buffer.length) {
          const read = await handle.read(buffer, length, buffer.length - length, null)
          if (read.bytesRead === 0) break
          length += read.bytesRead
        }
        if (length !== before.size) invalid()
        bytes = buffer.subarray(0, length)
        const after = await handle.stat()
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs
          || after.nlink !== 1) invalid()
      } finally { await handle.close() }
      const after = await lstat(path)
      if (!after.isFile() || after.isSymbolicLink() || after.ino !== before.ino
        || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) invalid()
      files.push({ path: name, bytes })
    }
    const byPath = new Map(files.map(file => [file.path, file.bytes]))
    const member = (name: string): Buffer => { const bytes = byPath.get(name); return bytes ?? invalid() }
    if (member('pnpm-lock.yaml').toString('utf8') !== EMPTY_ORDER_SOURCE_LOCK) invalid()
    const declaration = parseAnyNativeH3Declaration(parseCanonical(member('local-adapter.json')))
    const manifest = parseCanonical(member('package.json'))
    if (Object.keys(manifest).sort().join(',') !== 'name,type,version' || manifest.type !== 'module'
      || typeof manifest.name !== 'string' || !/^qianshou-[a-z0-9][a-z0-9-]{0,80}$/u.test(manifest.name)
      || typeof manifest.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.version)) invalid()
    const definition = parseCanonical(member('task-definition.json'))
    if (typeof definition.title !== 'string' || typeof definition.description !== 'string') invalid()
    const expected = nativeH3TaskDefinition(declaration, definition.title, definition.description)
    if (canonicalOrderJson(definition) !== canonicalOrderJson(expected)) invalid()
    validateOrderSourceInventory(NATIVE_BINDING_INVENTORY_ALGORITHM, files.map(file => ({ path: file.path,
      sizeBytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') })))
    const hash = createHash('sha256')
    for (const file of files) hash.update(file.path).update('\0').update(String(file.bytes.length)).update('\0').update(file.bytes)
    return { root, digest: hash.digest('hex'), version: manifest.version, declaration, taskDefinition: expected, files }
  } catch { return invalid() }
}

/** Exact metadata and instruction files built by the fixed native authoring template. */
export type NativeH3TemplateFile = 'SKILL.md' | 'scripts/order_adapter/package.json'
  | 'scripts/order_adapter/pnpm-lock.yaml' | 'scripts/order_adapter/local-adapter.json'
  | 'scripts/order_adapter/task-definition.json'

/** Construct metadata source text from the node's verified private execution binding.
 * @param binding - Provider runtime ABI and immutable configuration, recipe and model digests.
 * @param name - Lowercase skill/package name containing only letters, digits and hyphens.
 * @param taskType - Task type validated as part of the native declaration.
 * @returns Runtime ABI, author instructions and source text; no installation or publication is performed.
 */
export function nativeH3AuthoringTemplate(binding: NativeH3AuthorBinding, name: string,
  taskType: string): { runtimeAbi: string; instructions: string; files: Record<NativeH3TemplateFile, string> } {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)) invalid()
  // Canonical software retains the public V2 tuple but carries its independently pinned ABI.
  const v2 = 'schema' in binding
  const declaration = parseAnyNativeH3Declaration({ ...binding, schema: v2 ? 'qianshou.native-h3-binding.v2'
    : 'qianshou.native-h3-binding.v1',
  taskType, capabilityId: 'video.render', inputKinds: ['inline'], outputKind: 'artifact_ref',
  contractVersion: v2 ? 'v2' : 'v1', category: 'video', platformDispatchable: true })
  const title = 'H3 五秒视频生成'
  const description = '描述画面，使用提供者 Windows 的 H3 模型生成五秒视频。'
  return { runtimeAbi: declaration.runtimeAbi,
    instructions: '保存这些文件后发布接单技能。用户只填写视频描述；本机模型、首帧和工作流由受控执行器管理。已完成本机自测仍需平台独立样例核验，不能当作已上架或已交付。不要添加执行脚本、权重、私有路径或依赖。',
    files: {
      'SKILL.md': `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  displayName: ${title}\n  category: video\n---\n\n# ${title}\n\n填写视频描述，确认平台报价后由提供者的 Windows 本机生成并交付 MP4。固定五秒、固定机主首帧；可选随机种子。发布必须核验同一版本的实际配方、模型和视频样例。\n`,
      'scripts/order_adapter/package.json': canonicalOrderJson({ name: `qianshou-${name}`, type: 'module', version: '0.0.1' }),
      'scripts/order_adapter/pnpm-lock.yaml': EMPTY_ORDER_SOURCE_LOCK,
      'scripts/order_adapter/local-adapter.json': canonicalOrderJson(declaration),
      'scripts/order_adapter/task-definition.json': canonicalOrderJson(nativeH3TaskDefinition(declaration, title, description)),
    } }
}
