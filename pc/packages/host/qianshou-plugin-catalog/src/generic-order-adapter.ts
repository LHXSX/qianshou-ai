/** Task-independent author preflight. Independent platform acceptance is a separate receipt. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGenericOrderSource, validateGenericOrderInput, type GenericOrderSource } from './generic-order-source.ts'
import { runQuickJsOrderChallenge, verifyQuickJsOrderSamples } from './quickjs-order-runtime.ts'
import { CatalogFailure } from './registry.ts'
import { verifyGenericOrderFileSamples } from './generic-file-runtime.ts'

const MAX_STDOUT = 64 * 1024
const MAX_STDERR = 8 * 1024
const SAMPLE_TIMEOUT_MS = 10_000

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) throw new CatalogFailure('order-local-verification-failed')
  return result
}

function sandboxPolicy(): string {
  // Node's permission flag alone does not block network on Node 22. The macOS
  // seatbelt policy denies network, writes and child forks at the OS boundary.
  // Node's permission flag limits source reads to this package root.
  return '(version 1) (allow default) (deny network*) (deny file-write*) (deny process-fork)'
}

async function runSample(source: GenericOrderSource, input: Buffer, signal?: AbortSignal): Promise<unknown> {
  if (process.platform !== 'darwin') throw new CatalogFailure('order-runtime-unavailable')
  if (signal?.aborted) throw new CatalogFailure('order-local-verification-failed')
  const path = join(source.root, 'src', 'adapter.mjs')
  const args = ['-p', sandboxPolicy(), process.execPath, '--permission',
    `--allow-fs-read=${source.root}`, '--max-old-space-size=64', path]
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', args, {
      cwd: source.root, windowsHide: true,
      env: { PATH: '/usr/bin:/bin', HOME: tmpdir(), TMPDIR: tmpdir(),
        LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const stdout: Buffer[] = []
    let outputBytes = 0
    let stderrBytes = 0
    let settled = false
    const fail = () => { if (!settled) { settled = true; reject(new CatalogFailure('order-local-verification-failed')) } }
    const abort = () => { child.kill('SIGKILL'); fail() }
    signal?.addEventListener('abort', abort, { once: true })
    const timeout = setTimeout(() => { child.kill('SIGKILL'); fail() }, SAMPLE_TIMEOUT_MS)
    timeout.unref()
    child.on('error', () => { clearTimeout(timeout); fail() })
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length
      if (outputBytes > MAX_STDOUT) { child.kill('SIGKILL'); fail() }
      else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      if (stderrBytes > MAX_STDERR) { child.kill('SIGKILL'); fail() }
    })
    child.on('close', code => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      if (settled) return
      if (code !== 0 || outputBytes < 1) { fail(); return }
      try {
        const result: unknown = JSON.parse(Buffer.concat(stdout).toString('utf8'))
        settled = true
        resolve(result)
      } catch { fail() }
    })
    child.stdin.on('error', () => { child.kill('SIGKILL'); fail() })
    child.stdin.end(input)
  })
}

/** Run a platform-chosen challenge in the same bounded sandbox as reviewed samples.
 * The caller must verify the attestor's signed challenge and the locked source
 * before calling this function. This output alone is never an install receipt.
 */
export async function runGenericOrderChallenge(source: GenericOrderSource,
  input: Uint8Array, signal?: AbortSignal): Promise<{ readonly output: unknown; readonly outputDigest: string }> {
  if (source.taskDefinition?.fileSchema !== undefined) {
    // File adapters require the separate authorized attachment/upload ports.
    throw new CatalogFailure('order-runtime-unavailable')
  }
  if (input.byteLength < 1 || input.byteLength > 64 * 1024) {
    throw new CatalogFailure('order-local-verification-failed')
  }
  try {
    JSON.parse(Buffer.from(input).toString('utf8')) as unknown
    validateGenericOrderInput(source.taskDefinition, input)
  }
  catch { throw new CatalogFailure('order-local-verification-failed') }
  if (source.declaration.schema === 'qianshou.local-adapter-candidate.v3') {
    const entry = source.files.find(file => file.path === source.entryPath)?.bytes
    if (entry === undefined) throw new CatalogFailure('order-adapter-invalid')
    return runQuickJsOrderChallenge(entry, input, signal)
  }
  const output = await runSample(source, Buffer.from(input), signal)
  const outputDigest = `sha256:${createHash('sha256').update(canonical(output)).digest('hex')}`
  return { output, outputDigest }
}

/** Execute bounded author examples without user HOME, network, child processes or host writes. */
export async function verifyGenericOrderAdapter(source: GenericOrderSource): Promise<{
  readonly taskType: string
  readonly artifactDigest: string
  readonly packageDigest: string
  readonly inventoryAlgorithm: string
  readonly localVerified: true
  readonly platformReady: false
}> {
  const files = new Map(source.files.map(file => [file.path, file.bytes]))
  for (const sample of source.declaration.selfTests) {
    const input = files.get(sample.input)
    if (input === undefined) throw new CatalogFailure('order-adapter-invalid')
    validateGenericOrderInput(source.taskDefinition, input)
  }
  if (source.taskDefinition?.fileSchema !== undefined) {
    await verifyGenericOrderFileSamples(source)
  } else if (source.declaration.schema === 'qianshou.local-adapter-candidate.v3') {
    const entry = files.get(source.entryPath)
    if (entry === undefined) throw new CatalogFailure('order-adapter-invalid')
    const samples = source.declaration.selfTests.map(sample => {
      const input = files.get(sample.input)
      const expected = files.get(sample.expected)
      if (input === undefined || expected === undefined) throw new CatalogFailure('order-adapter-invalid')
      return { input, expected }
    })
    await verifyQuickJsOrderSamples(entry, samples)
  } else {
    for (const sample of source.declaration.selfTests) {
      let expected: unknown
      try { expected = JSON.parse(files.get(sample.expected)!.toString('utf8')) as unknown }
      catch { throw new CatalogFailure('order-adapter-invalid') }
      const actual = await runSample(source, files.get(sample.input)!)
      if (canonical(actual) !== canonical(expected)) throw new CatalogFailure('order-local-verification-failed')
    }
  }
  return { taskType: source.declaration.taskType, artifactDigest: `sha256:${source.digest}`,
    // This v5 package is self-contained: runtime dependencies are forbidden in package.json.
    // The independent runner still has to attest its own installed runtime before approval.
    packageDigest: `sha256:${source.digest}`, inventoryAlgorithm: source.inventoryAlgorithm,
    localVerified: true, platformReady: false }
}

export { readGenericOrderSource }
