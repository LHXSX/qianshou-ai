/** Author-side, bounded source identity for a task-independent order package. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { EMPTY_ORDER_SOURCE_LOCK, SOURCE_INVENTORY_ALGORITHM, validSourcePath } from './order-source-inventory.ts'
import { canonicalOrderJson } from './order-json-canonical.ts'
import { canonicalSourceJson } from './order-source-json.ts'
import { QUICKJS_ORDER_RUNTIME } from './quickjs-order-runtime.ts'
import { parseGenericFileSchema, fileGuestOutput, FILE_BYTES_POLICY, type GenericFileSchema } from './generic-file-contract.ts'
import { CatalogFailure } from './registry.ts'
import { OrderSourceFailure, type OrderSourceDiagnostic } from './order-source-diagnostics.ts'

const REQUIRED = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json'] as const
const V2_ENTRY = 'src/adapter.mjs'
const V3_ENTRY = 'src/adapter.quickjs.js'
const TASK = /^[a-z][a-z0-9_]{2,63}$/u
const CAPABILITY = /^[a-z][a-z0-9_.-]{2,63}$/u
const CATEGORY = /^[a-z][a-z0-9_-]{1,31}$/u
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,39}$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9_.-]{0,63}\/)?[a-z0-9][a-z0-9_.-]{0,99}$/u
const MAX_FILE_BYTES = 2_000_000
const MAX_TOTAL_BYTES = 16 * 1024 * 1024

function invalid(diagnostic?: OrderSourceDiagnostic): never {
  throw diagnostic === undefined ? new CatalogFailure('order-adapter-invalid') : new OrderSourceFailure(diagnostic)
}
function inside(parent: string, child: string): boolean {
  const offset = relative(parent, child)
  return offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
}
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function json(bytes: Buffer): Record<string, unknown> {
  try { return record(JSON.parse(bytes.toString('utf8')) as unknown) }
  catch { return invalid() }
}

export interface GenericOrderDeclaration {
  readonly schema: 'qianshou.local-adapter-candidate.v2' | 'qianshou.local-adapter-candidate.v3'
  readonly runtime?: { readonly engine: 'quickjs-wasm'; readonly version: '0.32.0'; readonly wasmSha256: string }
  readonly taskType: string
  readonly capabilityId: string
  readonly inputKinds: readonly ['inline']
  readonly outputKind: 'inline_json' | 'artifact_ref'
  readonly contractVersion: 'v1'
  readonly category: string
  readonly platformDispatchable: true
  readonly selfTests: readonly { readonly input: string; readonly expected: string;
    readonly attachments?: Readonly<Record<string, { readonly path: string; readonly contentType: string }>> }[]
}

/** Machine task contract carried inside, and digested with, the author source package. */
export interface GenericTaskDefinition {
  readonly schema: 'qianshou.reviewed-task-definition.v1'
  readonly title?: string
  readonly description?: string
  readonly taskType: string
  readonly capabilityId: string
  readonly category: string
  readonly inputKinds: readonly ['inline']
  readonly outputKind: 'inline_json' | 'artifact_ref'
  readonly inputContract: string
  readonly resultStrategy: string
  readonly paramsSchema: Record<string, unknown>
  readonly inputSchema: Record<string, unknown>
  readonly outputSchema?: Record<string, unknown>
  readonly fileSchema?: GenericFileSchema
}

export interface GenericOrderSource {
  readonly root: string
  readonly digest: string
  readonly version: string
  readonly inventoryAlgorithm: typeof SOURCE_INVENTORY_ALGORITHM
  readonly declaration: GenericOrderDeclaration
  readonly entryPath: typeof V2_ENTRY | typeof V3_ENTRY
  readonly taskDefinition: GenericTaskDefinition | null
  readonly files: readonly { readonly path: string; readonly bytes: Buffer }[]
}

/** Match Shanghai's bounded shape contract before a buyer-confirmed source leaves this device. */
function validJsonSchema(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Buffer.byteLength(canonicalOrderJson(value), 'utf8') > 4096) return false
  let nodes = 0
  const field = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u
  const walk = (item: unknown, depth: number): boolean => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)
      || ++nodes > 64 || depth > 5) return false
    const rule = item as Record<string, unknown>
    const kind = rule.type
    if (typeof kind !== 'string' || !['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'].includes(kind)
      || (rule.title !== undefined && (typeof rule.title !== 'string'
        || !rule.title.isWellFormed() || [...rule.title].length > 100))) return false
    const keys = new Set(['type', 'title'])
    if (kind === 'object') {
      for (const key of ['properties', 'required', 'additionalProperties']) keys.add(key)
      if (rule.properties === null || typeof rule.properties !== 'object' || Array.isArray(rule.properties)
        || !Array.isArray(rule.required) && rule.required !== undefined
        || rule.additionalProperties !== false) return false
      const properties = rule.properties as Record<string, unknown>
      const required = (rule.required ?? []) as unknown[]
      if (Object.keys(properties).length > 32 || required.length > 32
        || required.some(name => typeof name !== 'string' || !Object.hasOwn(properties, name))
        || new Set(required).size !== required.length
        || Object.keys(properties).some(name => !field.test(name))) return false
      if (Object.values(properties).some(child => !walk(child, depth + 1))) return false
    } else if (kind === 'array') {
      for (const key of ['items', 'minItems', 'maxItems']) keys.add(key)
      const low = rule.minItems === undefined ? 0 : rule.minItems
      const high = rule.maxItems === undefined ? 128 : rule.maxItems
      if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)
        || Number(low) < 0 || Number(low) > Number(high) || Number(high) > 128
        || !walk(rule.items, depth + 1)) return false
    } else if (kind === 'string') {
      for (const key of ['minLength', 'maxLength', 'enum']) keys.add(key)
      const low = rule.minLength === undefined ? 0 : rule.minLength
      const high = rule.maxLength === undefined ? 16384 : rule.maxLength
      if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high)
        || Number(low) < 0 || Number(low) > Number(high) || Number(high) > 16384
        || (rule.enum !== undefined && (!Array.isArray(rule.enum) || rule.enum.length < 1
          || rule.enum.length > 32 || rule.enum.some(entry => typeof entry !== 'string' || !entry.isWellFormed())))) return false
    } else if (kind === 'integer' || kind === 'number') {
      for (const key of ['minimum', 'maximum']) keys.add(key)
      const low = rule.minimum
      const high = rule.maximum
      if ([low, high].some(entry => entry !== undefined && (typeof entry !== 'number' || !Number.isFinite(entry)))
        || (low !== undefined && high !== undefined && Number(low) > Number(high))) return false
    }
    return Object.keys(rule).every(key => keys.has(key))
  }
  return walk(value, 0)
}

function taskDefinitionOf(bytes: Buffer | undefined,
  declaration: GenericOrderDeclaration, forNormalization: boolean): GenericTaskDefinition | null {
  if (bytes === undefined) return null
  if (bytes.length < 2 || bytes.length > 8 * 1024) invalid()
  const raw = json(bytes)
  if (raw.resultStrategy === 'buyer-confirmed-structure.v1' && !validJsonSchema(raw.outputSchema)) {
    invalid({ check: 'task-definition', reason: 'output-schema' })
  }
  const required = ['capabilityId', 'category', 'inputContract', 'inputKinds', 'inputSchema',
    'outputKind', 'paramsSchema', 'resultStrategy', 'schema', 'taskType']
  if ((!forNormalization && bytes.toString('utf8') !== canonicalOrderJson(raw))
    || required.some(key => !Object.hasOwn(raw, key))
    || Object.keys(raw).some(key => ![...required, 'outputSchema', 'title', 'description', 'fileSchema'].includes(key))
    || (raw.title !== undefined && (typeof raw.title !== 'string' || !raw.title.isWellFormed()
      || raw.title.trim().length === 0 || [...raw.title].length > 80))
    || (raw.description !== undefined && (typeof raw.description !== 'string' || !raw.description.isWellFormed()
      || raw.description.trim().length === 0 || [...raw.description].length > 500))
    || raw.schema !== 'qianshou.reviewed-task-definition.v1'
    || raw.taskType !== declaration.taskType || raw.capabilityId !== declaration.capabilityId
    || raw.category !== declaration.category || raw.outputKind !== declaration.outputKind
    || !Array.isArray(raw.inputKinds) || raw.inputKinds.length !== 1 || raw.inputKinds[0] !== 'inline'
    || typeof raw.inputContract !== 'string' || !CAPABILITY.test(raw.inputContract)
    || typeof raw.resultStrategy !== 'string' || !CAPABILITY.test(raw.resultStrategy)
    || (raw.resultStrategy === 'buyer-confirmed-structure.v1'
      ? raw.inputContract !== 'inline-json-bounded.v1' || raw.outputKind !== 'inline_json'
        || !validJsonSchema(raw.outputSchema)
      : raw.outputSchema !== undefined)) invalid()
  if (raw.fileSchema !== undefined) {
    if (declaration.schema !== 'qianshou.local-adapter-candidate.v3'
      || raw.outputKind !== 'artifact_ref' || raw.inputContract !== 'inline-json-bounded.v1'
      || raw.resultStrategy !== FILE_BYTES_POLICY) invalid()
    parseGenericFileSchema(raw.fileSchema)
  } else if (raw.resultStrategy === FILE_BYTES_POLICY) invalid()
  const params = record(raw.paramsSchema)
  const input = record(raw.inputSchema)
  if (Object.keys(params).sort().join(',') !== 'additionalProperties,properties,required,type'
    || params.type !== 'object' || params.additionalProperties !== false
    || !Array.isArray(params.required) || params.required.length > 16
    || !params.required.every(name => typeof name === 'string')
    || new Set(params.required).size !== params.required.length
    || Object.keys(record(params.properties)).length > 16
    || !params.required.every(name => Object.hasOwn(record(params.properties), name))
    || Object.keys(input).some(key => !['type', 'title', 'minLength', 'maxLength',
      'contentMediaType', 'contentSchema'].includes(key))
    || input.type !== 'string'
    || (input.contentMediaType === undefined ? 'application/json' : input.contentMediaType) !== 'application/json'
    || !Number.isSafeInteger(input.minLength === undefined ? 0 : input.minLength) || Number(input.minLength ?? 0) < 0
    || typeof input.maxLength !== 'number'
    || !Number.isSafeInteger(input.maxLength) || input.maxLength < 1 || input.maxLength > 16384
    || Number(input.minLength ?? 0) > input.maxLength
    || (input.title !== undefined && (typeof input.title !== 'string'
      || !input.title.isWellFormed() || [...input.title].length > 100))
    || Buffer.byteLength(canonicalOrderJson(input), 'utf8') > 4096) invalid()
  if (input.contentSchema !== undefined && (input.contentMediaType !== 'application/json'
    || raw.inputContract !== 'inline-json-bounded.v1'
    || !validJsonSchema(input.contentSchema) || record(input.contentSchema).type !== 'object')) {
    invalid({ check: 'task-definition', reason: 'input-schema' })
  }
  for (const [name, value] of Object.entries(record(params.properties))) {
    const field = record(value)
    if (!CAPABILITY.test(name) || !['string', 'integer', 'number', 'boolean'].includes(String(field.type))
      || Object.keys(field).some(key => !['type', 'minimum', 'maximum', 'minLength', 'maxLength', 'enum', 'title'].includes(key))) invalid()
  }
  if (raw.fileSchema !== undefined && (Object.keys(record(params.properties)).length > 0 || params.required.length > 0)) invalid()
  return raw as unknown as GenericTaskDefinition
}

function matchesJsonSchema(value: unknown, schema: Record<string, unknown>): boolean {
  const kind = schema.type
  if (kind === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
    const properties = schema.properties as Record<string, Record<string, unknown>>
    const row = value as Record<string, unknown>
    return ((schema.required ?? []) as string[]).every(name => Object.hasOwn(row, name))
      && Object.entries(row).every(([name, item]) => Object.hasOwn(properties, name)
        && matchesJsonSchema(item, properties[name]!))
  }
  if (kind === 'array') return Array.isArray(value)
    && value.length >= Number(schema.minItems ?? 0) && value.length <= Number(schema.maxItems ?? 128)
    && value.every(item => matchesJsonSchema(item, schema.items as Record<string, unknown>))
  if (kind === 'string') return typeof value === 'string' && value.isWellFormed()
    && [...value].length >= Number(schema.minLength ?? 0) && [...value].length <= Number(schema.maxLength ?? 16384)
    && (schema.enum === undefined || (schema.enum as string[]).includes(value))
  if (kind === 'boolean') return typeof value === 'boolean'
  if (kind === 'null') return value === null
  return typeof value === 'number' && Number.isFinite(value)
    && (kind !== 'integer' || Number.isInteger(value))
    && (schema.minimum === undefined || value >= Number(schema.minimum))
    && (schema.maximum === undefined || value <= Number(schema.maximum))
}

/** Validate JSON inputs against the same reviewed content declaration used by Shanghai.
 * Legacy sources without contentSchema retain their existing execution input rules.
 * @param definition Machine declaration pinned in the source inventory.
 * @param input Exact JSON bytes passed to samples or runtime execution.
 */
export function validateGenericOrderInput(definition: GenericTaskDefinition | null, input: Uint8Array): void {
  const form = definition?.inputSchema
  if (form?.contentSchema === undefined) return
  if (input.byteLength < 1 || input.byteLength > 16 * 1024) invalid()
  const bytes = Buffer.from(input)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const size = [...text].length
  if (size < Number(form.minLength ?? 0) || size > Number(form.maxLength)) invalid()
  const value = json(canonicalSourceJson(bytes))
  if (Object.keys(value).length === 0
    || !matchesJsonSchema(value, record(form.contentSchema))) invalid()
}

function declarationOf(raw: Record<string, unknown>, paths: ReadonlySet<string>): GenericOrderDeclaration {
  const v3 = raw.schema === 'qianshou.local-adapter-candidate.v3'
  if (Object.keys(raw).sort().join(',') !== (v3
      ? 'capabilityId,category,contractVersion,inputKinds,outputKind,platformDispatchable,runtime,schema,selfTests,taskType'
      : 'capabilityId,category,contractVersion,inputKinds,outputKind,platformDispatchable,schema,selfTests,taskType')) {
    invalid({ check: 'declaration', reason: 'declaration-fields' })
  }
  if (raw.platformDispatchable !== true) invalid({ check: 'declaration', reason: 'local-only' })
  if ((raw.schema !== 'qianshou.local-adapter-candidate.v2' && !v3)
    || typeof raw.taskType !== 'string' || !TASK.test(raw.taskType)
    || typeof raw.capabilityId !== 'string' || !CAPABILITY.test(raw.capabilityId)
    || !Array.isArray(raw.inputKinds) || raw.inputKinds.length !== 1 || raw.inputKinds[0] !== 'inline'
    || (raw.outputKind !== 'inline_json' && raw.outputKind !== 'artifact_ref')
    || raw.contractVersion !== 'v1'
    || typeof raw.category !== 'string' || !CATEGORY.test(raw.category)
    || raw.platformDispatchable !== true
    || !Array.isArray(raw.selfTests) || raw.selfTests.length < (v3 ? 2 : 1)
    || raw.selfTests.length > 8) invalid()
  if (v3) {
    const runtime = record(raw.runtime)
    if (Object.keys(runtime).sort().join(',') !== 'engine,version,wasmSha256'
      || runtime.engine !== 'quickjs-wasm'
      || runtime.version !== QUICKJS_ORDER_RUNTIME.version
      || runtime.wasmSha256 !== QUICKJS_ORDER_RUNTIME.wasmSha256) {
      invalid({ check: 'declaration', reason: 'runtime-abi' })
    }
  }
  const tests: { input: string; expected: string;
    attachments?: Record<string, { path: string; contentType: string }> }[] = []
  for (const value of raw.selfTests) {
    const item = record(value)
    if (![...(v3 ? ['attachments,expected,input'] : []), 'expected,input'].includes(Object.keys(item).sort().join(','))
      || typeof item.input !== 'string' || typeof item.expected !== 'string'
      || !item.input.startsWith('samples/') || !item.expected.startsWith('samples/')
      || !item.input.endsWith('.json') || !item.expected.endsWith('.json')
      || !paths.has(item.input) || !paths.has(item.expected)) invalid()
    let attachments: Record<string, { path: string; contentType: string }> | undefined
    if (item.attachments !== undefined) {
      const rawAttachments = record(item.attachments)
      if (Object.keys(rawAttachments).length > 1) invalid()
      attachments = {}
      for (const [name, rawFile] of Object.entries(rawAttachments)) {
        const file = record(rawFile)
        if (!/^[a-z][a-z0-9_]{0,31}$/u.test(name)
          || Object.keys(file).sort().join(',') !== 'contentType,path'
          || typeof file.path !== 'string' || !file.path.startsWith('samples/') || !paths.has(file.path)
          || typeof file.contentType !== 'string') invalid()
        attachments[name] = { path: file.path, contentType: file.contentType }
      }
    }
    tests.push({ input: item.input, expected: item.expected, ...(attachments ? { attachments } : {}) })
  }
  return { schema: raw.schema as GenericOrderDeclaration['schema'],
    ...(v3 ? { runtime: raw.runtime as NonNullable<GenericOrderDeclaration['runtime']> } : {}),
    taskType: raw.taskType, capabilityId: raw.capabilityId,
    inputKinds: ['inline'], outputKind: raw.outputKind, contractVersion: 'v1',
    category: raw.category, platformDispatchable: true, selfTests: tests }
}

/** Read only regular source files inside scripts/order_adapter; no links, hidden installs, or path traversal. */
export async function readGenericOrderSource(skillPath: string,
  options: { forNormalization?: true } = {}): Promise<GenericOrderSource> {
  let diagnostic: OrderSourceDiagnostic = { check: 'source-tree', reason: 'invalid-source' }
  try {
    const skillDir = await realpath(dirname(skillPath))
    const skillStat = await lstat(skillPath)
    if (!skillStat.isFile() || skillStat.isSymbolicLink()) invalid()
    const declaredRoot = join(skillDir, 'scripts', 'order_adapter')
    const declaredStat = await lstat(declaredRoot)
    if (!declaredStat.isDirectory() || declaredStat.isSymbolicLink()) invalid()
    const root = await realpath(declaredRoot)
    if (!inside(skillDir, root)) invalid()
    const rootStat = await lstat(root)
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) invalid()
    const files: { path: string; bytes: Buffer }[] = []
    diagnostic = { check: 'source-inventory', reason: 'unsafe-source' }
    const directories = [root]
    let visited = 0
    while (directories.length) {
      const directory = directories.pop()!
      if (++visited > 128) invalid()
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        const name = relative(root, path).split(sep).join('/')
        if (name.split('/').some(part => ['node_modules', '.venv'].includes(part))) {
          invalid({ check: 'source-inventory', reason: 'installed-environment' })
        }
        if (!validSourcePath(name) || !inside(root, path)
          || entry.isSymbolicLink() || name.split('/').some(part => part.startsWith('.'))
          || name.split('/').includes('node_modules')) invalid()
        const stat = await lstat(path)
        if (entry.isDirectory() && stat.isDirectory()) { directories.push(path); continue }
        if (!entry.isFile() || !stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES
          || !inside(root, await realpath(path))) invalid()
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
        let bytes: Buffer
        try {
          const opened = await handle.stat()
          if (!opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev
            || opened.size !== stat.size) invalid()
          bytes = await handle.readFile()
        } finally { await handle.close() }
        const after = await lstat(path)
        if (bytes.length !== stat.size || after.ino !== stat.ino || after.dev !== stat.dev
          || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) invalid()
        files.push({ path: name, bytes })
        if (files.length > 128 || files.reduce((sum, file) => sum + file.bytes.length, 0) > MAX_TOTAL_BYTES) invalid()
      }
    }
    files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const byPath = new Map(files.map(file => [file.path, file.bytes]))
    if (files.length < 4 || REQUIRED.some(name => !byPath.has(name))) invalid()
    diagnostic = { check: 'dependency-lock', reason: 'dependency-lock' }
    if (byPath.get('pnpm-lock.yaml')!.toString('utf8') !== EMPTY_ORDER_SOURCE_LOCK) invalid()
    diagnostic = { check: 'declaration', reason: 'declaration-fields' }
    const declaration = declarationOf(json(byPath.get('local-adapter.json')!), new Set(byPath.keys()))
    diagnostic = { check: 'runtime-entry', reason: 'runtime-entry' }
    const entryPath = declaration.schema === 'qianshou.local-adapter-candidate.v3' ? V3_ENTRY : V2_ENTRY
    const otherEntry = entryPath === V3_ENTRY ? V2_ENTRY : V3_ENTRY
    if (!byPath.has(entryPath) || byPath.has(otherEntry)
      || byPath.get(entryPath)!.length > QUICKJS_ORDER_RUNTIME.maxSourceBytes && entryPath === V3_ENTRY) invalid()
    diagnostic = { check: 'task-definition', reason: 'task-definition' }
    const taskDefinition = taskDefinitionOf(byPath.get('task-definition.json'), declaration,
      options.forNormalization === true)
    diagnostic = { check: 'package-manifest', reason: 'package-manifest' }
    const manifest = json(byPath.get('package.json')!)
    if (typeof manifest.name !== 'string' || !PACKAGE_NAME.test(manifest.name)
      || typeof manifest.version !== 'string' || !VERSION.test(manifest.version)
      || manifest.type !== 'module'
      || ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies',
        'peerDependencies', 'bundleDependencies', 'bundledDependencies'].some(key =>
        manifest[key] !== undefined && Object.keys(record(manifest[key])).length !== 0)) invalid()
    for (const sample of declaration.selfTests) {
      diagnostic = { check: 'samples', reason: 'sample-input' }
      for (const path of [sample.input, sample.expected]) {
        const bytes = byPath.get(path)!
        if (bytes.length > 64 * 1024) invalid()
        json(bytes)
      }
      validateGenericOrderInput(taskDefinition, byPath.get(sample.input)!)
      if (taskDefinition?.fileSchema !== undefined) {
        const schema = parseGenericFileSchema(taskDefinition.fileSchema)
        if (Object.keys(sample.attachments ?? {}).sort().join(',') !== schema.inputs.map(slot => slot.name).sort().join(',')) invalid()
        for (const slot of schema.inputs) {
          const fixture = sample.attachments?.[slot.name]
          if (fixture === undefined || !slot.contentTypes.includes(fixture.contentType)
            || byPath.get(fixture.path)!.byteLength > slot.maxBytes) invalid()
        }
        diagnostic = { check: 'samples', reason: 'sample-output' }
        fileGuestOutput(schema, json(byPath.get(sample.expected)!))
      } else if (sample.attachments !== undefined) invalid()
    }
    const hash = createHash('sha256')
    for (const file of files) hash.update(file.path).update('\0')
      .update(String(file.bytes.length)).update('\0').update(file.bytes)
    return { root, digest: hash.digest('hex'), version: manifest.version,
      inventoryAlgorithm: SOURCE_INVENTORY_ALGORITHM, declaration, entryPath, taskDefinition, files }
  } catch (error) {
    if (error instanceof OrderSourceFailure) throw error
    if (error instanceof CatalogFailure && error.code !== 'order-adapter-invalid') throw error
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new OrderSourceFailure({ ...diagnostic, reason: 'missing-source' })
    }
    throw new OrderSourceFailure(diagnostic)
  }
}
