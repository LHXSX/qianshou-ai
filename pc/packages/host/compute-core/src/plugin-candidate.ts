/** Build a bounded local bundle from one reviewed, allowlisted plugin draft. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import { lstat, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { ComputeError } from './errors.ts'
import { parsePluginDraftId, type LocalPluginDraft, type PluginDraftOperation, type PluginDraftSchema, type LocalPluginDraftStore } from './plugin-draft.ts'
import { safeLocalWorkflow } from './safe-local-workflows.ts'

export const ORDERABLE_TEXT_STATISTICS_REF = 'qianshou:text-statistics-v2'
const TEXT_REVERSE_REF = 'qianshou:text-reverse-v1'

/** A private package the owner may review and install; it has no market or order authority. */
export interface LocalPluginCandidate {
  readonly draftId: string
  readonly packageName: string
  readonly packagePath: string
  readonly toolName: string
  readonly sourceDigest: string
  readonly packageDigest: string
  readonly installableLocally: true
  readonly published: false
  readonly dispatchable: false
}

/** A candidate whose three on-disk files still match the saved, allowlisted draft. */
export interface ListedLocalPluginCandidate extends LocalPluginCandidate {
  readonly displayName: string
  readonly description: string
  readonly operationTitle: string
  readonly preparedAt: number
  /** Generated from the allowlisted draft, never inferred from an arbitrary package name. */
  readonly orderAdapter?: {
    readonly version: 1
    readonly capabilityId: 'text.transform'
    readonly taskType: 'word_count'
    readonly inputKind: 'inline'
    readonly outputKind: 'inline_json'
    readonly contractVersion: 'v1'
  }
}

function unsupported(): ComputeError { return new ComputeError('COMPUTE_PLUGIN_CANDIDATE_UNSUPPORTED', 409) }
function digest(value: string): string { return createHash('sha256').update(value).digest('hex') }

function schemaMatches(actual: PluginDraftSchema, expected: PluginDraftSchema): boolean {
  if (actual.type !== expected.type) return false
  if (expected.type === 'array') return actual.items !== undefined && expected.items !== undefined
    && schemaMatches(actual.items, expected.items)
  if (expected.type !== 'object') return true
  if (actual.additionalProperties !== false || actual.properties === undefined || expected.properties === undefined
    || actual.required === undefined || expected.required === undefined) return false
  const names = Object.keys(expected.properties)
  return Object.keys(actual.properties).length === names.length
    && actual.required.length === expected.required.length
    && names.every(name => actual.properties?.[name] !== undefined
      && schemaMatches(actual.properties[name], expected.properties![name]!)
      && actual.required?.includes(name) === expected.required?.includes(name))
}

function supported(operation: PluginDraftOperation): boolean {
  const workflow = safeLocalWorkflow(operation.binding.ref)
  return operation.binding.kind === 'workflow' && workflow !== undefined
    && schemaMatches(operation.inputSchema, workflow.inputSchema)
    && schemaMatches(operation.outputSchema, workflow.outputSchema)
    && operation.permissions.length === 0 && operation.dataScope === 'task-inputs'
    && operation.networkOrigins.length === 0 && operation.dependencies.length === 0
    && operation.resources.maxInputBytes <= 65536
    && operation.resources.maxOutputBytes >= workflow.minOutputBytes
    && operation.resources.maxRunMs <= 5000
    && operation.resources.minTotalMemoryBytes === 0 && operation.resources.minFreeDiskBytes === 0
    && operation.resources.platforms === undefined && operation.resources.architectures === undefined
    && (operation.resources.minVramBytes ?? 0) === 0
}

function filesFor(draft: LocalPluginDraft): { packageName: string; toolName: string; files: Readonly<Record<string, string>> } {
  const spec = draft.spec
  if (!/^\d+\.\d+\.\d+$/u.test(spec.version) || spec.operations.length !== 1) throw unsupported()
  const operation = spec.operations[0]
  if (operation === undefined || !supported(operation)) throw unsupported()
  const workflow = safeLocalWorkflow(operation.binding.ref)!
  if (spec.version !== workflow.version) throw unsupported()
  const v2 = operation.binding.ref === ORDERABLE_TEXT_STATISTICS_REF
  const reverse = operation.binding.ref === TEXT_REVERSE_REF
  const suffix = draft.id.slice('plugin_draft_'.length).replaceAll('-', '')
  const packageName = 'qianshou-local-' + suffix
  const toolName = 'qianshou_local_' + suffix
  const maxInputBytes = operation.resources.maxInputBytes
  const maxOutputBytes = operation.resources.maxOutputBytes
  const packageJson = JSON.stringify({ name: packageName, version: spec.version, private: true, type: 'module',
    main: 'index.js', qianshouDisplayName: spec.displayName,
    description: spec.displayName + '：' + workflow.description, license: 'MIT',
    files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } },
    ...(v2 ? { qianshouWorkflowRef: ORDERABLE_TEXT_STATISTICS_REF,
      qianshouOrderAdapter: { version: 1, capabilityId: 'text.transform', taskType: 'word_count', toolName,
        entry: 'index.js' } } : {}) }, null, 2) + '\n'
  const patch = '- insert:\n    - id: ' + packageName + '\n      name: ' + packageName + '\n'
  const code = [
    '/** Generated from a reviewed, no-network local workflow recipe. */',
    ...(!reverse ? ["import { createHash } from 'node:crypto'"] : []),
    'export const name = ' + JSON.stringify(packageName),
    "export const inject = ['tools']",
    'export function apply(ctx) {',
    '  ctx.effect(() => ctx.tools.register({',
    '    name: ' + JSON.stringify(toolName) + ',',
    '    description: ' + JSON.stringify(workflow.description) + ',',
    "    parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },",
    "    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },",
    '    isConcurrencySafe: () => true,',
    '    async execute(args, exec) {',
    "      if (typeof args !== 'object' || args === null || typeof args.text !== 'string'",
    "        || Object.keys(args).some(key => key !== 'text')) throw new Error('INVALID_TEXT_ARGUMENT')",
    '      exec.signal.throwIfAborted()',
    '      const bytes = Buffer.byteLength(args.text)',
    '      if (bytes > ' + maxInputBytes + ") throw new Error('TEXT_TOO_LARGE')",
    ...(reverse ? [
      "      const result = JSON.stringify({ reversed: Array.from(args.text).reverse().join('') })",
      '      if (Buffer.byteLength(result) > ' + maxOutputBytes + ") throw new Error('RESULT_TOO_LARGE')",
      '      return result',
    ] : v2 ? [
      '      const counts = new Map()',
      '      for (const match of args.text.toLowerCase().matchAll(/[\\p{L}\\p{N}_]+/gu)) {',
      '        counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)',
      '      }',
      '      const wordCounts = [...counts.entries()].sort((a, b) => b[1] - a[1])',
      '        .slice(0, 100).map(([word, count]) => ({ word, count }))',
      '      const result = JSON.stringify({ characters: Array.from(args.text).length, utf8Bytes: bytes,',
      "        nonemptyLines: args.text.split(/\\r?\\n/u).filter(line => line.trim() !== '').length,",
      "        sha256: createHash('sha256').update(args.text).digest('hex'), wordCounts })",
      '      if (Buffer.byteLength(result) > ' + maxOutputBytes + ") throw new Error('RESULT_TOO_LARGE')",
      '      return result',
    ] : [
      "      return JSON.stringify({ characters: Array.from(args.text).length, utf8Bytes: bytes,",
      "        nonemptyLines: args.text.split(/\\r?\\n/u).filter(line => line.trim() !== '').length,",
      "        sha256: createHash('sha256').update(args.text).digest('hex') })",
    ]),
    '    },',
    "    presentCall: () => ({ card: 'generic', title: " + JSON.stringify(workflow.title) + ", kind: 'read' }),",
    "  }), 'qianshou local candidate')",
    '}',
    '',
  ].join('\n')
  return { packageName, toolName, files: { 'package.json': packageJson, 'cordis.patch.yml': patch, 'index.js': code } }
}

/** Create one private, reviewable package from the currently saved draft. No code from the draft is executed.
 * @param drafts - Host-owned private draft store.
 * @param root - Absolute private candidate directory under the Host state root.
 */
export class LocalPluginCandidateBuilder {
  constructor(private readonly drafts: LocalPluginDraftStore, private readonly root: string) {
    if (!isAbsolute(root)) throw new ComputeError('COMPUTE_PLUGIN_CANDIDATE_ROOT_INVALID', 400)
  }

  /** Prepare an allowlisted bundle; the caller separately approves profile installation.
   * @param value - Opaque id returned by plugin_draft_save.
   * @returns Candidate path and content digests for owner review.
   */
  async prepare(value: unknown): Promise<LocalPluginCandidate> {
    const id = parsePluginDraftId(value)
    const draft = (await this.drafts.list()).find(item => item.id === id)
    if (draft === undefined) throw new ComputeError('COMPUTE_PLUGIN_DRAFT_NOT_FOUND', 404)
    const built = filesFor(draft)
    const sourceDigest = digest(JSON.stringify(draft.spec))
    const packageDigest = digest(Object.entries(built.files).map(([name, contents]) => name + '\0' + contents).join('\0'))
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const rootInfo = await lstat(this.root)
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new ComputeError('COMPUTE_PLUGIN_CANDIDATE_ROOT_INVALID', 400)
    const packagePath = join(this.root, 'candidate-' + randomUUID())
    await mkdir(packagePath, { mode: 0o700 })
    try {
      for (const [name, contents] of Object.entries(built.files)) {
        await writeFile(join(packagePath, name), contents, { flag: 'wx', mode: 0o600 })
        if (await readFile(join(packagePath, name), 'utf8') !== contents) {
          throw new ComputeError('COMPUTE_PLUGIN_CANDIDATE_WRITE_MISMATCH', 503)
        }
      }
    } catch (error) {
      await rm(packagePath, { recursive: true, force: true })
      throw error
    }
    return { draftId: draft.id, packageName: built.packageName, packagePath, toolName: built.toolName,
      sourceDigest, packageDigest, installableLocally: true, published: false, dispatchable: false }
  }

  /** List only packages whose bytes still match the current saved draft. A changed or linked file is omitted. */
  async list(): Promise<ListedLocalPluginCandidate[]> {
    let entries: Dirent[]
    try {
      const root = await lstat(this.root)
      if (root.isSymbolicLink() || !root.isDirectory()) return []
      entries = await readdir(this.root, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const drafts = await this.drafts.list()
    const expected = new Map<string, { draft: LocalPluginDraft; files: Readonly<Record<string, string>>; toolName: string }>()
    for (const draft of drafts) {
      try {
        const built = filesFor(draft)
        expected.set(built.packageName, { draft, files: built.files, toolName: built.toolName })
      } catch (error) {
        if (error instanceof ComputeError && error.code === 'COMPUTE_PLUGIN_CANDIDATE_UNSUPPORTED') continue
        throw error
      }
    }
    const found: ListedLocalPluginCandidate[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^candidate-[0-9a-f-]{36}$/u.test(entry.name)) continue
      const packagePath = join(this.root, entry.name)
      const packageJson = await readCandidateFile(join(packagePath, 'package.json'))
      if (packageJson === null) continue
      let packageName: unknown
      try { packageName = (JSON.parse(packageJson) as { name?: unknown }).name } catch { continue }
      if (typeof packageName !== 'string') continue
      const match = expected.get(packageName)
      if (match === undefined || match.files['package.json'] !== packageJson) continue
      let valid = true
      for (const name of ['cordis.patch.yml', 'index.js']) {
        if (await readCandidateFile(join(packagePath, name)) !== match.files[name]) { valid = false; break }
      }
      if (!valid) continue
      let info: Awaited<ReturnType<typeof lstat>>
      try { info = await lstat(packagePath) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      if (info.isSymbolicLink() || !info.isDirectory()) continue
      const operation = match.draft.spec.operations[0]!
      const workflow = safeLocalWorkflow(operation.binding.ref)!
      found.push({
        draftId: match.draft.id, packageName, packagePath, toolName: match.toolName,
        sourceDigest: digest(JSON.stringify(match.draft.spec)),
        packageDigest: digest(Object.entries(match.files).map(([name, contents]) => name + '\0' + contents).join('\0')),
        installableLocally: true, published: false, dispatchable: false,
        displayName: match.draft.spec.displayName, description: workflow.description,
        operationTitle: workflow.title, preparedAt: info.mtimeMs,
        ...(operation.binding.ref === ORDERABLE_TEXT_STATISTICS_REF ? { orderAdapter: {
          version: 1 as const, capabilityId: 'text.transform' as const, taskType: 'word_count' as const,
          inputKind: 'inline' as const, outputKind: 'inline_json' as const, contractVersion: 'v1' as const,
        } } : {}),
      })
    }
    const newest = new Set<string>()
    return found.sort((a, b) => b.preparedAt - a.preparedAt)
      .filter(item => { if (newest.has(item.packageName)) return false; newest.add(item.packageName); return true })
      .slice(0, 20)
  }
}

/** Read one small regular file without following a symlink. */
async function readCandidateFile(path: string): Promise<string | null> {
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size > 64 * 1024) return null
      return await handle.readFile('utf8')
    } finally { await handle.close() }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return null
    throw error
  }
}
