import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createIsolatedInlineRunner, EdgeWorkerConnection, type EdgeTaskOffer } from '@deepseek-ai/dsh-compute-core'
import { FixtureWebSocketServer } from '../../../packages/host/compute-core/tests/transport/fixture-ws-server.ts'
import { parseWorkloadResult } from '../../../packages/host/compute-core/src/workload-result.ts'
import { executeNodeOffer } from '../execute-offer.ts'

const offer: EdgeTaskOffer = {
  workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 3,
  taskType: 'word_count', runtime: 'node', inputKind: 'inline', inlineInput: 'Hello hello 世界 constructor',
  inputRef: '', inputRefs: [], codeUrl: 'https://untrusted.invalid/code.py', codeSha256: '',
  timeoutSeconds: 60, verificationPolicy: 'semantic', executionModel: '', capability: 'text.transform', capabilityVersion: '1.0.0',
}
const assignment = {
  worker_id: offer.workerId, workload_id: offer.workloadId, shard_id: offer.shardId, attempt: offer.attempt,
  task_type: offer.taskType, runtime: offer.runtime, input_kind: offer.inputKind, inline_input: offer.inlineInput,
  input_ref: '', input_refs: [], code_url: offer.codeUrl, code_sha256: '', timeout_s: 60,
  verification_policy: offer.verificationPolicy, execution_model: '', capability: offer.capability,
  capability_version: offer.capabilityVersion, lease_token: 'fixture-only-lease',
}
const connections: EdgeWorkerConnection[] = []
const servers: FixtureWebSocketServer[] = []

/**
 * 权威的 `word_count` 交付文档（`resident/isolated-inline-runner.ts` 的形状）。
 *
 * 键序也是契约的一部分：平台按 `result_lines` 逐行合并，写成对象字面量可以同时钉住
 * 字段名、字段集合与顺序，改形状时这条断言会红。
 */
const WORD_COUNT_DOCUMENT = JSON.stringify({
  status: 'ok',
  schema_version: 'v1',
  task_type: 'word_count',
  elapsed_ms: 0,
  summary: { input_bytes: 30, total_tokens: 4, unique_tokens: 3, top_n_returned: 3, jieba_enabled: false },
  result_lines: ['hello\t2', '世界\t1', 'constructor\t1'],
})

/**
 * 把结果文档里的 `elapsed_ms` 归零后再比较。
 *
 * 文档内部的计时字段由 runner 用 `Date.now` 真实测量（0 或 1 ms），帧级 `elapsed_ms`
 * 来自被 mock 的单调时钟：两者不同源，其余每一个字节都必须相同。
 * @param payload - 一帧的原始 payload。
 * @returns 计时字段归一后的 payload。
 */
function normalizeDocumentClock(payload: Record<string, unknown>): Record<string, unknown> {
  if (typeof payload.inline_output !== 'string') return payload
  const document = JSON.parse(payload.inline_output) as Record<string, unknown>
  return { ...payload, inline_output: JSON.stringify({ ...document, elapsed_ms: 0 }) }
}

afterEach(async () => {
  for (const connection of connections.splice(0)) await connection.close()
  for (const server of servers.splice(0)) await server.close()
  vi.restoreAllMocks()
})

function port() {
  return {
    reportProgress: vi.fn(),
    complete: vi.fn(() => ({ state: 'sent-awaiting-verification' as const })),
    reject: vi.fn(),
  }
}

async function start(overrides: Record<string, unknown> = {}, maxOutputBytes = 4096, beforeExecution = () => {}) {
  let assigned = false
  const server = await FixtureWebSocketServer.start({ script: (frame, context) => {
    if (frame.type === 'hello') context.reply('welcome', { hb_interval_s: 60 })
    if (frame.type === 'auth') context.reply('auth_ok', { worker_id: offer.workerId, owner_id: 7 })
    if (frame.type === 'hb') {
      context.reply('hb_ack', {})
      if (frame.payload.mode === 'running' && !assigned) {
        assigned = true
        context.reply('shard_assign', { ...assignment, ...overrides })
        context.reply('shard_assign', { ...assignment, ...overrides })
      }
    }
  } })
  servers.push(server)
  const connection = new EdgeWorkerConnection({
    origin: server.origin, tokenProvider: () => 'fixture-only-token', expectedOwnerId: 7,
    name: 'node-execution-fixture', clientBuild: 'fixture', os: 'test', arch: 'test', capabilities: {},
    allowedTaskTypes: ['word_count'], handshakeTimeoutMs: 2000, maxFrameBytes: 65536, maxOutputBytes,
    readLoad: () => 0, onEvent: () => {},
    onOffer: async (received, signal) => { beforeExecution(); await executeNodeOffer(received, signal, connection) },
  })
  connections.push(connection)
  await connection.connect()
  return { connection, server }
}

describe('built-in node execution lifecycle', () => {
  it.each(['word_count', 'text.transform'])('reports start and measured duration for %s', async (taskType) => {
    const connection = port()
    vi.spyOn(performance, 'now').mockReturnValueOnce(100.25).mockReturnValueOnce(149.1)
    // The document carries the runner's own measured elapsed_ms; a fixed clock keeps it at 0.
    vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    const receipt = await executeNodeOffer({ ...offer, taskType }, new AbortController().signal, connection)
    expect(receipt).toEqual({ state: 'sent-awaiting-verification' })
    expect(connection.reportProgress).toHaveBeenCalledExactlyOnceWith({ ...offer, taskType }, 0)
    expect(connection.reportProgress.mock.invocationCallOrder[0]).toBeLessThan(connection.complete.mock.invocationCallOrder[0]!)
    expect(connection.complete).toHaveBeenCalledExactlyOnceWith({ ...offer, taskType }, {
      inlineOutputUtf8: WORD_COUNT_DOCUMENT, elapsedMs: 49,
    })
    expect(connection.reject).not.toHaveBeenCalled()
  })

  it.each([
    { taskType: 'dedup_lines' }, { taskType: 'constructor' },
    { inputKind: 'file' }, { inlineInput: null }, { inputRef: 'artifact://input' }, { inputRefs: ['artifact://input'] },
  ])('refuses unsupported input before execution: %j', async (change) => {
    const connection = port()
    expect(await executeNodeOffer({ ...offer, ...change }, new AbortController().signal, connection)).toBeUndefined()
    expect(connection.reject).toHaveBeenCalledOnce()
    expect(connection.reportProgress).not.toHaveBeenCalled()
    expect(connection.complete).not.toHaveBeenCalled()
  })

  it('does not report or execute an already cancelled assignment', async () => {
    const controller = new AbortController(); controller.abort()
    const connection = port()
    await expect(executeNodeOffer(offer, controller.signal, connection)).rejects.toThrow()
    expect(connection.reportProgress).not.toHaveBeenCalled()
    expect(connection.complete).not.toHaveBeenCalled()
    expect(connection.reject).not.toHaveBeenCalled()
  })

  it('reports a serialization failure without leaking task or exception text', async () => {
    const connection = port()
    vi.spyOn(JSON, 'stringify').mockImplementationOnce(() => { throw new Error('private-task-data') })
    expect(await executeNodeOffer(offer, new AbortController().signal, connection)).toBeUndefined()
    expect(connection.reportProgress).toHaveBeenCalledOnce()
    expect(connection.complete).not.toHaveBeenCalled()
    expect(connection.reject).toHaveBeenCalledExactlyOnceWith(offer, {
      code: 'EDGE_EXECUTION_FAILED', message: 'Built-in node execution or result submission failed',
    })
  })

  it('propagates a failed start send to the connection owner', async () => {
    const connection = port()
    connection.reportProgress.mockImplementation(() => { throw new Error('disconnected') })
    await expect(executeNodeOffer(offer, new AbortController().signal, connection)).rejects.toThrow('disconnected')
    expect(connection.complete).not.toHaveBeenCalled()
    expect(connection.reject).not.toHaveBeenCalled()
  })

  it('carries one start and result for duplicate deliveries over the real socket', async () => {
    const { connection, server } = await start({}, 4096, () => {
      vi.spyOn(performance, 'now').mockReturnValueOnce(100.25).mockReturnValueOnce(149.1)
    })
    connection.updateMode('running')
    await vi.waitFor(() => { expect(server.frames.filter(frame => frame.type === 'shard_result')).toHaveLength(1) })
    const frames = server.frames.filter(frame => frame.type.startsWith('shard_'))
      .map(({ type, payload }) => ({ type, payload: normalizeDocumentClock(payload) }))
    const expected: unknown = JSON.parse(readFileSync(new URL('./expected/execution-success.json', import.meta.url), 'utf8'))
    expect(frames).toEqual(expected)
  })

  it('reports an oversized result as failure after start, without a success frame', async () => {
    const { connection, server } = await start({}, 1)
    connection.updateMode('running')
    await vi.waitFor(() => { expect(server.frames.some(frame => frame.type === 'shard_result')).toBe(true) })
    const results = server.frames.filter(frame => frame.type === 'shard_result')
    expect(results.every(frame => frame.payload.ok === false && frame.payload.failure_class === 'EDGE_EXECUTION_FAILED')).toBe(true)
    expect(server.frames.find(frame => frame.type === 'shard_progress')?.payload.pct).toBe(0)
  })
})

/**
 * 结果形状契约：这个开发用节点必须发出**平台能打开**的那一份 `word_count` 文档。
 *
 * 为什么这两条断言绑在两个外部事实上，而不是绑在本文件的实现上：
 * 1. 生产者 —— `node-contributor/src/edge-binding.ts:112` 与 `plugin.ts:390` 用的是
 *    `createIsolatedInlineRunner()`；开发节点若另写一份分词，就会第二次分叉（C7 N9）。
 * 2. 消费者 —— 平台结果读取器 `workload-result.ts:75-83` 只认 `result_lines` / `result` /
 *    `results`，都没有就回落到 `null`（任务显示完成、用户却打不开交付物）。
 */
describe('word_count result shape', () => {
  /** 文档里除 `elapsed_ms`（真实测量值）以外的全部字段。 */
  function documentShape(text: string): Record<string, unknown> {
    const { elapsed_ms: _measured, ...rest } = JSON.parse(text) as Record<string, unknown>
    return rest
  }

  /** 平台侧读取交付物文本；`null` 表示"用户拿不到东西"。 */
  function deliverable(text: string): string | null {
    return parseWorkloadResult('workload-1', {
      ok: true, id: 'workload-1', workload_id: 'workload-1', status: 'done', result: JSON.parse(text),
    }, 1_048_576).inlineOutput
  }

  it('sends the same document the shipped resident runner sends', async () => {
    const connection = port()
    await executeNodeOffer(offer, new AbortController().signal, connection)
    const sent = connection.complete.mock.calls[0]?.[1] as { inlineOutputUtf8: string } | undefined
    expect(sent).toBeDefined()
    const shipped = (await createIsolatedInlineRunner()({
      taskType: 'word_count', inlineInput: offer.inlineInput, signal: new AbortController().signal,
    })).text
    expect(documentShape(sent!.inlineOutputUtf8)).toEqual(documentShape(shipped))
  })

  it('sends a document the platform result reader can open', async () => {
    const connection = port()
    await executeNodeOffer(offer, new AbortController().signal, connection)
    const sent = connection.complete.mock.calls[0]?.[1] as { inlineOutputUtf8: string } | undefined
    const shipped = (await createIsolatedInlineRunner()({
      taskType: 'word_count', inlineInput: offer.inlineInput, signal: new AbortController().signal,
    })).text
    expect(deliverable(sent!.inlineOutputUtf8)).toBe(deliverable(shipped))
    expect(deliverable(sent!.inlineOutputUtf8)).not.toBeNull()
  })
})
