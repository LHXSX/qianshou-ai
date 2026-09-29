/** Explicit owner binding from one installed local text-statistics plugin to the text order landing. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createIsolatedInlineRunner, type IsolatedInlineRunner } from '@deepseek-ai/dsh-compute-core'
import { NodeContributorError } from './errors.ts'
import { expectedTextSort, inlineOrderContractOf, type InlineOrderContract, type InlineOrderTaskType } from './inline-order-contracts.ts'

// Package origin is irrelevant: a selected profile bundle must meet the same
// narrow adapter contract, pinned bytes and output self-test regardless of installer.
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,127}\/)?[a-z0-9][a-z0-9._-]{0,127}$/u
const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_-]{0,127}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const MAX_INPUT_BYTES = 65_536
const FILES = ['package.json', 'cordis.patch.yml', 'index.js'] as const
const MAX_PACKAGE_FILES = 128
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024

/** This separate owner setting is required even after the package is installed and enabled. */
export interface LocalTextStatisticsOrderBinding {
  readonly packageName: string
  readonly toolName: string
  readonly packageDigest: string
  /** Legacy three-field selections mean word_count; new selections pin this exact landing. */
  readonly taskType?: InlineOrderTaskType
}

/** Current Host observations. Installation alone is not an order authorization. */
export interface LocalTextStatisticsOrderHost {
  profileDir(): string | undefined
  manager(): { checkBundle(name: string): Promise<{ state: string; selected: boolean;
    rows: readonly { moduleName: string; enabled: boolean | null; phase: string | null }[] }> } | undefined
  tools(): {
    get(name: string): unknown
    execute(input: { name: string; arguments: unknown; callId: ReturnType<typeof ToolCallId>; signal: AbortSignal }): Promise<
      { isError: false; value: unknown } | { isError: true }
    >
  } | undefined
}

function failure(code: string): NodeContributorError { return new NodeContributorError(code) }

/** Validate the exact candidate identity the owner pinned in the node configuration.
 * @param value - Optional owner setting; omission leaves built-in execution unchanged.
 * @returns Validated binding, or null when no plugin was selected.
 */
export function resolveLocalTextStatisticsOrderBinding(value: LocalTextStatisticsOrderBinding | undefined): LocalTextStatisticsOrderBinding | null {
  if (value === undefined || (value.packageName === '' && value.toolName === '' && value.packageDigest === ''
    && value.taskType === undefined)) return null
  if (!PACKAGE_NAME.test(value.packageName) || !TOOL_NAME.test(value.toolName) || !SHA256.test(value.packageDigest)
    || inlineOrderContractOf(value.taskType ?? 'word_count') === null) {
    throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_CONFIG_INVALID')
  }
  return Object.freeze({ packageName: value.packageName, toolName: value.toolName,
    packageDigest: value.packageDigest, taskType: value.taskType ?? 'word_count' })
}

/** Hash a bounded, self-contained installed bundle. Three-file local candidates keep their original receipt digest.
 * @param profileDir - Active dsh profile directory, never a draft location.
 * @param packageName - Exact installed package identity.
 * @returns The package digest, or null when any file is unreadable.
 */
export async function installedLocalPluginDigest(profileDir: string, packageName: string): Promise<string | null> {
  try {
    if (!PACKAGE_NAME.test(packageName)) return null
    const packageDir = await realpath(join(profileDir, 'node_modules', packageName))
    const contents = new Map<string, Buffer>()
    let total = 0
    const visit = async (dir: string, prefix: string, depth: number): Promise<void> => {
      if (depth > 8) throw new Error('ORDER_PLUGIN_TREE_TOO_DEEP')
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
        const path = join(dir, entry.name)
        const stat = await lstat(path)
        if (stat.isSymbolicLink()) throw new Error('ORDER_PLUGIN_TREE_LINK')
        if (stat.isDirectory()) { await visit(path, relative, depth + 1); continue }
        if (!stat.isFile() || stat.size > MAX_PACKAGE_BYTES) throw new Error('ORDER_PLUGIN_TREE_INVALID')
        if (contents.size >= MAX_PACKAGE_FILES || total + stat.size > MAX_PACKAGE_BYTES) {
          throw new Error('ORDER_PLUGIN_TREE_TOO_LARGE')
        }
        const bytes = await readFile(path)
        if (bytes.length !== stat.size) throw new Error('ORDER_PLUGIN_TREE_CHANGED')
        contents.set(relative, bytes)
        total += bytes.length
      }
    }
    await visit(packageDir, '', 0)
    if (!contents.has('package.json') || !contents.has('cordis.patch.yml')) return null
    if (contents.size === FILES.length && FILES.every(name => contents.has(name))) {
      return createHash('sha256').update(FILES.map(name => `${name}\0${contents.get(name)!.toString('utf8')}`).join('\0')).digest('hex')
    }
    const hash = createHash('sha256').update('qianshou.order-bundle.v1\0')
    for (const name of [...contents.keys()].sort()) {
      const bytes = contents.get(name)!
      hash.update(`${name}\0${bytes.length}\0`).update(bytes).update('\0')
    }
    return hash.digest('hex')
  } catch {
    return null
  }
}

/** Recheck active loading and pinned installed bytes immediately before and after an order call.
 * @param binding - Owner-pinned candidate identity and digest.
 * @param host - Current profile, plugin manager and tool registry.
 * @returns The tool registry only while all observations agree.
 */
export async function checkLocalTextStatisticsOrderPlugin(binding: LocalTextStatisticsOrderBinding, host: LocalTextStatisticsOrderHost): Promise<ReturnType<LocalTextStatisticsOrderHost['tools']>> {
  const profileDir = host.profileDir()
  const manager = host.manager()
  const tools = host.tools()
  if (profileDir === undefined || manager === undefined || tools === undefined) {
    throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_UNAVAILABLE')
  }
  let check: Awaited<ReturnType<typeof manager.checkBundle>>
  try { check = await manager.checkBundle(binding.packageName) }
  catch { throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_UNAVAILABLE') }
  if (check.state !== 'active' || check.selected !== true || check.rows.length !== 1
    || check.rows[0]?.moduleName !== binding.packageName || check.rows[0]?.enabled !== true
    || check.rows[0]?.phase !== 'active'
    || tools.get(binding.toolName) === undefined) throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_UNAVAILABLE')
  const actual = await installedLocalPluginDigest(profileDir, binding.packageName)
  if (actual === null || actual !== binding.packageDigest) throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_CHANGED')
  // The v1 character/byte counter has no word_count adapter declaration and cannot
  // fulfill Shanghai's merger. This gate is independent of install origin.
  let manifest: unknown
  try { manifest = JSON.parse(await readFile(join(profileDir, 'node_modules', binding.packageName, 'package.json'), 'utf8')) }
  catch { throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_UNAVAILABLE') }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_TASK_TYPE_UNSUPPORTED')
  }
  const packageInfo = manifest as Record<string, unknown>
  const adapter = packageInfo.qianshouOrderAdapter
  const declaration = typeof adapter === 'object' && adapter !== null && !Array.isArray(adapter)
    ? adapter as Record<string, unknown> : null
  const entry = declaration?.entry
  const contract = inlineOrderContractOf(binding.taskType ?? 'word_count')
  const legacy = declaration?.version === 1 && contract?.taskType === 'word_count'
  const complete = declaration?.version === 2 && contract !== null
    && declaration.inputKind === contract.inputKind
    && declaration.outputKind === contract.outputKind
    && declaration.contractVersion === contract.contractVersion
  if (packageInfo.name !== binding.packageName || packageInfo.type !== 'module'
    || typeof entry !== 'string' || packageInfo.main !== entry
    || !/^[a-zA-Z0-9._/-]+\.js$/u.test(entry)
    || entry.split('/').some(part => part === '' || part === '.' || part === '..')
    || declaration === null || contract === null || (!legacy && !complete)
    || Object.keys(declaration).length !== (legacy ? 5 : 8)
    || declaration.capabilityId !== contract.capabilityId
    || declaration.taskType !== contract.taskType
    || declaration.toolName !== binding.toolName
    || Object.hasOwn(packageInfo, 'scripts')
    || ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies', 'bundledDependencies']
      .some(key => packageInfo[key] !== undefined && (typeof packageInfo[key] !== 'object'
        || packageInfo[key] === null || Array.isArray(packageInfo[key])
        || Object.keys(packageInfo[key] as Record<string, unknown>).length > 0))) {
    throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_TASK_TYPE_UNSUPPORTED')
  }
  return tools
}

/** Check load, exact adapter declaration and pinned file shape without running installed code. */
export async function findInstalledInlineOrderBinding(
  packageName: string, host: LocalTextStatisticsOrderHost,
): Promise<LocalTextStatisticsOrderBinding | null> {
  if (!PACKAGE_NAME.test(packageName)) return null
  const profileDir = host.profileDir()
  if (profileDir === undefined) return null
  const packageDigest = await installedLocalPluginDigest(profileDir, packageName)
  if (packageDigest === null) return null
  let toolName: unknown
  let taskType: unknown
  try {
    const manifest = JSON.parse(await readFile(join(profileDir, 'node_modules', packageName, 'package.json'), 'utf8')) as {
      qianshouOrderAdapter?: { toolName?: unknown; taskType?: unknown }
    }
    toolName = manifest.qianshouOrderAdapter?.toolName
    taskType = manifest.qianshouOrderAdapter?.taskType
  } catch { return null }
  if (typeof toolName !== 'string' || typeof taskType !== 'string' || inlineOrderContractOf(taskType) === null) return null
  let binding: LocalTextStatisticsOrderBinding | null
  try { binding = resolveLocalTextStatisticsOrderBinding({ packageName, toolName, packageDigest,
    taskType: taskType as InlineOrderTaskType }) }
  catch { return null }
  if (binding === null) return null
  try { await checkLocalTextStatisticsOrderPlugin(binding, host); return binding }
  catch { return null }
}

/** Compatibility helper for the existing word_count-only caller and tests. */
export async function findInstalledWordCountBinding(packageName: string, host: LocalTextStatisticsOrderHost): Promise<LocalTextStatisticsOrderBinding | null> {
  const binding = await findInstalledInlineOrderBinding(packageName, host)
  return binding?.taskType === 'word_count' ? binding : null
}

/** Execute a bounded fixture and verify the exact platform artifact before selection. */
export async function inspectInstalledInlineOrderBundle(packageName: string, host: LocalTextStatisticsOrderHost): Promise<
  { readonly eligible: true; readonly reason: 'ready'; readonly binding: LocalTextStatisticsOrderBinding;
    readonly contract: InlineOrderContract }
  | { readonly eligible: false; readonly reason: 'not-active' | 'platform-task-unmapped' | 'executor-unverified' | 'output-unverified' }
> {
  const binding = await findInstalledInlineOrderBinding(packageName, host)
  if (binding === null) return { eligible: false, reason: 'platform-task-unmapped' }
  const contract = inlineOrderContractOf(binding.taskType ?? 'word_count')!
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const runner = createLocalInlineOrderRunner(binding, host, createIsolatedInlineRunner())
    const deadline = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => {
      controller.abort()
      reject(new Error('ORDER_PLUGIN_PROBE_TIMEOUT'))
    }, 5_000) })
    for (const sampleInput of [contract.sampleInput, ...(contract.additionalSampleInputs ?? [])]) {
      const response = await Promise.race([
        runner({ taskType: contract.taskType, inlineInput: sampleInput, signal: controller.signal }), deadline,
      ])
      const document = JSON.parse(response.text) as { status?: unknown; task_type?: unknown;
        schema_version?: unknown; result_lines?: unknown }
      const expected = contract.taskType === 'text_sort' ? expectedTextSort(sampleInput) : null
      if (document.status !== 'ok' || document.task_type !== contract.taskType
        || document.schema_version !== contract.contractVersion
        || !Array.isArray(document.result_lines)
        || (expected === null
          ? JSON.stringify(document.result_lines) !== JSON.stringify(contract.sampleResultLines)
          : !expected.accepts(document.result_lines))) {
        return { eligible: false, reason: 'output-unverified' }
      }
    }
    return { eligible: true, reason: 'ready', binding, contract }
  } catch (error) {
    if (error instanceof NodeContributorError) {
      if (error.code === 'COMPUTE_LOCAL_ORDER_PLUGIN_TASK_TYPE_UNSUPPORTED') {
        return { eligible: false, reason: 'platform-task-unmapped' }
      }
      if (error.code === 'COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID') {
        return { eligible: false, reason: 'output-unverified' }
      }
      if (error.code === 'COMPUTE_LOCAL_ORDER_PLUGIN_UNAVAILABLE') return { eligible: false, reason: 'not-active' }
    }
    return { eligible: false, reason: 'executor-unverified' }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Existing word_count-specific API never labels another task as word_count. */
export async function inspectInstalledWordCountBundle(packageName: string, host: LocalTextStatisticsOrderHost): ReturnType<typeof inspectInstalledInlineOrderBundle> {
  const inspected = await inspectInstalledInlineOrderBundle(packageName, host)
  return inspected.eligible && inspected.contract.taskType !== 'word_count'
    ? { eligible: false, reason: 'platform-task-unmapped' } : inspected
}

async function parsedStatistics(value: unknown, text: string, signal: AbortSignal): Promise<{
  characters: number; utf8Bytes: number; nonemptyLines: number; sha256: string; resultLines: string[]
}> {
  if (typeof value !== 'string') throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID')
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown }
  catch { throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID')
  const row = parsed as Record<string, unknown>
  const expected = {
    characters: Array.from(text).length,
    utf8Bytes: Buffer.byteLength(text, 'utf8'),
    nonemptyLines: text.split(/\r?\n/u).filter(line => line.trim() !== '').length,
    sha256: createHash('sha256').update(text).digest('hex'),
  }
  if (Object.keys(row).length !== 5 || Object.entries(expected).some(([key, result]) => row[key] !== result)
    || !Array.isArray(row.wordCounts) || row.wordCounts.length > 100) {
    throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID')
  }
  const resultLines: string[] = []
  for (const item of row.wordCounts) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)
      || Object.keys(item).length !== 2 || typeof item.word !== 'string' || item.word.length === 0
      || item.word.includes('\t') || item.word.includes('\n')
      || !Number.isSafeInteger(item.count) || item.count < 1) {
      throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID')
    }
    resultLines.push(`${item.word}\t${item.count}`)
  }
  const reference = await createIsolatedInlineRunner()({ taskType: 'word_count', inlineInput: text, signal })
  const expectedLines = (JSON.parse(reference.text) as { result_lines: string[] }).result_lines
  if (resultLines.length !== expectedLines.length
    || resultLines.some((line, index) => line !== expectedLines[index])) {
    throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID')
  }
  return { ...expected, resultLines }
}

function parsedTextSort(value: unknown, text: string): { lines: readonly string[]; summary: ReturnType<typeof expectedTextSort>['summary'] } {
  let expected: ReturnType<typeof expectedTextSort>
  try { expected = expectedTextSort(text) }
  catch { throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_INPUT_UNSUPPORTED') }
  if (typeof value !== 'string') throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID')
  let parsed: unknown
  try { parsed = JSON.parse(value) as unknown }
  catch { throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID') }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID')
  }
  const row = parsed as Record<string, unknown>
  if (Object.keys(row).length !== 1 || !expected.accepts(row.sortedLines)) {
    throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_OUTPUT_INVALID')
  }
  return { lines: row.sortedLines as string[], summary: expected.summary }
}

/** Execute the explicitly bound package through a trusted, exact inline platform contract.
 * @param binding - Exact owner setting; no market row or task text can set it.
 * @param host - Live desktop Host services.
 * @param fallback - Existing isolated runner for other task types.
 * @returns An isolated runner suitable for the resident order consumer.
 */
export function createLocalInlineOrderRunner(
  binding: LocalTextStatisticsOrderBinding, host: LocalTextStatisticsOrderHost, fallback: IsolatedInlineRunner,
): IsolatedInlineRunner {
  return async (input) => {
    const contract = inlineOrderContractOf(binding.taskType ?? 'word_count')
    if (contract === null) throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_TASK_TYPE_UNSUPPORTED')
    if (input.taskType !== contract.taskType
      && !(contract.taskType === 'word_count' && input.taskType === 'text.transform')) return fallback(input)
    input.signal.throwIfAborted()
    if (Buffer.byteLength(input.inlineInput, 'utf8') > MAX_INPUT_BYTES) throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_INPUT_TOO_LARGE')
    if (contract.taskType === 'text_sort') {
      try { expectedTextSort(input.inlineInput) }
      catch { throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_INPUT_UNSUPPORTED') }
    }
    const tools = await checkLocalTextStatisticsOrderPlugin(binding, host)
    if (tools === undefined) throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_UNAVAILABLE')
    let result: Awaited<ReturnType<typeof tools.execute>>
    try {
      result = await tools.execute({ name: binding.toolName, arguments: { text: input.inlineInput },
        callId: ToolCallId(`qianshou-order-plugin-${randomUUID()}`), signal: input.signal })
    } catch {
      throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_EXECUTION_FAILED')
    }
    input.signal.throwIfAborted()
    if (result.isError) throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_EXECUTION_FAILED')
    const statistics = contract.taskType === 'word_count'
      ? await parsedStatistics(result.value, input.inlineInput, input.signal) : null
    const sorted = contract.taskType === 'text_sort'
      ? parsedTextSort(result.value, input.inlineInput) : null
    await checkLocalTextStatisticsOrderPlugin(binding, host)
    input.signal.throwIfAborted()
    if (sorted !== null) return { text: JSON.stringify({
      status: 'ok', schema_version: contract.contractVersion, task_type: contract.taskType,
      summary: sorted.summary, result_lines: sorted.lines,
      summary_text: `排序完成 · ${sorted.summary.input_lines} 行输入 · ${sorted.summary.output_lines} 行输出`,
    }) }
    if (statistics === null) throw failure('COMPUTE_LOCAL_ORDER_PLUGIN_TASK_TYPE_UNSUPPORTED')
    const reference = await createIsolatedInlineRunner()({ taskType: 'word_count',
      inlineInput: input.inlineInput, signal: input.signal })
    const document = JSON.parse(reference.text) as Record<string, unknown>
    return { text: JSON.stringify({ ...document,
      summary_text: `词频 ${statistics.resultLines.length} 项 · 字符 ${statistics.characters} · UTF-8 字节 ${statistics.utf8Bytes}`,
      result_lines: statistics.resultLines,
    }) }
  }
}

/** Legacy export kept for old callers; its binding now pins an exact supported task type. */
export const createLocalTextStatisticsOrderRunner = createLocalInlineOrderRunner
