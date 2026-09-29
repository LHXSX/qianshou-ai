/** Bounded, platform-independent executor for reviewed v3 order adapters.
 *
 * The guest is a plain script declaring `function run(input)`. It receives only
 * JSON and no native functions, module loader, filesystem, network, or process
 * object. Source identity and task-contract approval remain the caller's job.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { getQuickJS } from 'quickjs-emscripten'
import { canonicalOrderJson } from './order-json-canonical.ts'
import { CatalogFailure } from './registry.ts'

const require = createRequire(import.meta.url)

export const QUICKJS_ORDER_RUNTIME = Object.freeze({
  engine: 'quickjs-emscripten',
  version: '0.32.0',
  variant: '@jitl/quickjs-wasmfile-release-sync',
  wasmSha256: '105c3bed22d457e43e3d1c3c1c6959fda62a8fe06f0fc8a985303c3a2be72232',
  maxSourceBytes: 256 * 1024,
  maxInputBytes: 64 * 1024,
  maxOutputBytes: 64 * 1024,
  memoryLimitBytes: 16 * 1024 * 1024,
  maxStackSizeBytes: 256 * 1024,
  maxExecutionMs: 2_000,
})

export interface QuickJsOrderSample {
  readonly input: Uint8Array
  readonly expected: Uint8Array
}

function failed(): never { throw new CatalogFailure('order-local-verification-failed') }
function unavailable(): never { throw new CatalogFailure('order-runtime-unavailable') }

/** Check the installed engine and actual WASM bytes before running untrusted code. */
export async function assertQuickJsOrderRuntimeIntegrity(): Promise<void> {
  try {
    const engine = JSON.parse(await readFile(require.resolve('quickjs-emscripten/package.json'), 'utf8')) as { version?: string }
    const variant = JSON.parse(await readFile(require.resolve(`${QUICKJS_ORDER_RUNTIME.variant}/package.json`), 'utf8')) as { version?: string }
    if (engine.version !== QUICKJS_ORDER_RUNTIME.version || variant.version !== QUICKJS_ORDER_RUNTIME.version) unavailable()
    const wasm = await readFile(require.resolve(`${QUICKJS_ORDER_RUNTIME.variant}/wasm`))
    if (createHash('sha256').update(wasm).digest('hex') !== QUICKJS_ORDER_RUNTIME.wasmSha256) unavailable()
  } catch { unavailable() }
}

function decode(bytes: Uint8Array, limit: number): string {
  if (bytes.byteLength < 1 || bytes.byteLength > limit) failed()
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { failed() }
}

function parseJson(bytes: Uint8Array, limit: number): unknown {
  try { return JSON.parse(decode(bytes, limit)) as unknown }
  catch { failed() }
}

/** Execute one task with no host bridges. The QuickJS interrupt handler bounds
 * tight loops and regular-expression work; the WASM runtime limits guest memory
 * and stack. No Windows ACL or macOS sandbox-exec is involved.
 */
export async function runQuickJsOrderChallenge(sourceCode: Uint8Array, input: Uint8Array,
  signal?: AbortSignal, executionMs = 1_000): Promise<{
  readonly output: unknown
  readonly outputDigest: string
}> {
  if (signal?.aborted || !Number.isSafeInteger(executionMs) || executionMs < 1
    || executionMs > QUICKJS_ORDER_RUNTIME.maxExecutionMs) failed()
  const source = decode(sourceCode, QUICKJS_ORDER_RUNTIME.maxSourceBytes)
  const inputValue = parseJson(input, QUICKJS_ORDER_RUNTIME.maxInputBytes)
  const encodedInput = JSON.stringify(inputValue)
  await assertQuickJsOrderRuntimeIntegrity()
  const QuickJS = await getQuickJS()
  if (signal?.aborted) failed()
  const deadline = Date.now() + executionMs
  // No imports, require, callbacks, or native handles are installed in this VM.
  // Embedding the input as a JSON string literal prevents code injection.
  const script = `${source}\n;JSON.stringify(run(JSON.parse(${JSON.stringify(encodedInput)})))`
  let encodedOutput: unknown
  try {
    encodedOutput = QuickJS.evalCode(script, {
      shouldInterrupt: () => signal?.aborted === true || Date.now() >= deadline,
      memoryLimitBytes: QUICKJS_ORDER_RUNTIME.memoryLimitBytes,
      maxStackSizeBytes: QUICKJS_ORDER_RUNTIME.maxStackSizeBytes,
    })
  } catch { failed() }
  if (typeof encodedOutput !== 'string'
    || Buffer.byteLength(encodedOutput, 'utf8') > QUICKJS_ORDER_RUNTIME.maxOutputBytes) failed()
  let output: unknown
  try { output = JSON.parse(encodedOutput) as unknown }
  catch { failed() }
  try {
    const canonical = canonicalOrderJson(output)
    if (Buffer.byteLength(canonical, 'utf8') > QUICKJS_ORDER_RUNTIME.maxOutputBytes) failed()
    return { output, outputDigest: `sha256:${createHash('sha256').update(canonical).digest('hex')}` }
  } catch { failed() }
}

/** Author-side self-test. Independent Guangzhou sample verification and signed
 * Shanghai review remain mandatory before a source becomes dispatchable.
 */
export async function verifyQuickJsOrderSamples(sourceCode: Uint8Array,
  samples: readonly QuickJsOrderSample[], signal?: AbortSignal): Promise<void> {
  if (samples.length < 2 || samples.length > 8) failed()
  for (const sample of samples) {
    const expected = parseJson(sample.expected, QUICKJS_ORDER_RUNTIME.maxOutputBytes)
    const actual = (await runQuickJsOrderChallenge(sourceCode, sample.input, signal)).output
    try {
      if (canonicalOrderJson(actual) !== canonicalOrderJson(expected)) failed()
    } catch { failed() }
  }
}
