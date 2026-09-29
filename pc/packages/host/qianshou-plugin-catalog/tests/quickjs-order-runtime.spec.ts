import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { assertQuickJsOrderRuntimeIntegrity, QUICKJS_ORDER_RUNTIME,
  runQuickJsOrderChallenge, verifyQuickJsOrderSamples } from '../src/quickjs-order-runtime.ts'

const bytes = (value: string): Uint8Array => Buffer.from(value, 'utf8')
const source = bytes('function run(input) { return { count: [...input.text].length } }')
const input = bytes('{"text":"你好🙂"}')

it('pins the installed QuickJS release WASM and returns a deterministic JSON digest', async () => {
  await expect(assertQuickJsOrderRuntimeIntegrity()).resolves.toBeUndefined()
  const result = await runQuickJsOrderChallenge(source, input)
  expect(result.output).toEqual({ count: 3 })
  expect(result.outputDigest).toBe(`sha256:${createHash('sha256').update('{"count":3}').digest('hex')}`)
  expect(QUICKJS_ORDER_RUNTIME.wasmSha256).toMatch(/^[0-9a-f]{64}$/u)
})

it('executes an arbitrary reviewed task type with no process, modules, network, or filesystem bridge', async () => {
  const result = await runQuickJsOrderChallenge(bytes(`function run(input) {
    return { type: input.kind, process: typeof process, require: typeof require,
      fetch: typeof fetch, WebSocket: typeof WebSocket, fs: typeof fs,
      console: typeof console }
  }`), bytes('{"kind":"new_task_type"}'))
  expect(result.output).toEqual({ type: 'new_task_type', process: 'undefined',
    require: 'undefined', fetch: 'undefined', WebSocket: 'undefined',
    fs: 'undefined', console: 'undefined' })
})

it('uses the same WASM executor with a simulated Windows platform instead of macOS sandbox-exec', async () => {
  const property = Object.getOwnPropertyDescriptor(process, 'platform')
  expect(property?.configurable).toBe(true)
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    expect((await runQuickJsOrderChallenge(source, input)).output).toEqual({ count: 3 })
  } finally {
    if (property) Object.defineProperty(process, 'platform', property)
  }
})

it('stops an infinite loop, catastrophic regular expression, and memory exhaustion', async () => {
  await expect(runQuickJsOrderChallenge(bytes('function run() { while (true) {} }'), bytes('{}'),
    undefined, 100)).rejects.toMatchObject({ code: 'order-local-verification-failed' })
  await expect(runQuickJsOrderChallenge(bytes(`function run() {
    return { matched: /(a+)+$/.test('a'.repeat(1000) + 'b') }
  }`), bytes('{}'), undefined, 100)).rejects.toMatchObject({ code: 'order-local-verification-failed' })
  await expect(runQuickJsOrderChallenge(bytes(`function run() {
    const values = []; while (true) values.push('x'.repeat(1000000))
  }`), bytes('{}'), undefined, 500)).rejects.toMatchObject({ code: 'order-local-verification-failed' })
})

it('rejects malformed input, missing run, oversized output, invalid limits, and abort', async () => {
  const failure = { code: 'order-local-verification-failed' }
  await expect(runQuickJsOrderChallenge(source, bytes('{'))).rejects.toMatchObject(failure)
  await expect(runQuickJsOrderChallenge(source, Uint8Array.of(0xff))).rejects.toMatchObject(failure)
  await expect(runQuickJsOrderChallenge(bytes('const x = 1'), input)).rejects.toMatchObject(failure)
  await expect(runQuickJsOrderChallenge(bytes(`function run() {
    return { output: 'x'.repeat(70000) }
  }`), bytes('{}'))).rejects.toMatchObject(failure)
  await expect(runQuickJsOrderChallenge(source, input, undefined,
    QUICKJS_ORDER_RUNTIME.maxExecutionMs + 1)).rejects.toMatchObject(failure)
  const controller = new AbortController()
  controller.abort()
  await expect(runQuickJsOrderChallenge(source, input, controller.signal)).rejects.toMatchObject(failure)
})

it('compares two real examples and rejects a changed expected result', async () => {
  const examples = [
    { input: bytes('{"text":"千手AI"}'), expected: bytes('{"count":4}') },
    { input, expected: bytes('{"count":3}') },
  ]
  await expect(verifyQuickJsOrderSamples(source, examples)).resolves.toBeUndefined()
  await expect(verifyQuickJsOrderSamples(source, examples.slice(0, 1))).rejects
    .toMatchObject({ code: 'order-local-verification-failed' })
  await expect(verifyQuickJsOrderSamples(source,
    [examples[0]!, { ...examples[1]!, expected: bytes('{"count":4}') }])).rejects
    .toMatchObject({ code: 'order-local-verification-failed' })
})
