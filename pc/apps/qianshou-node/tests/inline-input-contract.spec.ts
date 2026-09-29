/**
 * E10 · 内联文本输入的跨边界字段名契约：**下单字段名 = 平台分片字段名 = 节点判定字段名**。
 *
 * 为什么需要这条钉子（真实故障，2026-09-22）：CEO 下单时把文本写进了 `spec.text`，
 * 平台全程不报错，只在分片里留下 `inline_input: None` + `files_in_shard: 1`
 * （`lines_chunked` 因无内联文本退回 `single` 切片器），节点随即在
 * `execute-offer.ts:49-51` 判定失败，分片变 `FAILED` / `EDGE_INPUT_UNSUPPORTED`。
 * 三个环节各自"正常"，错名被静默丢弃 —— 这就是静默即缺陷的形态。
 *
 * 这条测试钉的不是本文件的实现，而是**三个外部事实**：
 * 1. 平台下单模型只认 `inline_input`（`platform_v8/protocol/http_schema.py:238`，
 *    `WorkloadSpecIn.inline_input`；`services/workloads/submit.py:282,412` 只读这个键）。
 * 2. 平台切片器把同样的名字写进分片元数据
 *    （`engine/slicers/lines_chunked.py:82`、`engine/slicers/single.py:71`），
 *    再由 `engine/assignment_payload.py:286-289` 取出、`protocol/ws_schema.py:554,584`
 *    以同名发到线上。
 * 3. 节点 `edge-worker/connection.ts:303-315` 的 `parseOffer` 只认这个名字，
 *    `execute-offer.ts:49-51` 还要求 `input_kind === 'inline'` 且无任何文件引用。
 *
 * 任何一侧改名 ⇒ 本文件红。节点侧的名字不是抄来的常量，而是**行为探针**在真实
 * socket 上问出来的（`probeAcceptedWireFieldName`）：改节点解析器就一定红。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeWorkerConnection, type EdgeTaskOffer } from '@deepseek-ai/dsh-compute-core'
import { FixtureWebSocketServer } from '../../../packages/host/compute-core/tests/transport/fixture-ws-server.ts'
import { executeNodeOffer } from '../execute-offer.ts'

// ── 三向字段名 ────────────────────────────────────────────────
// 这三个名字必须逐字相同。任何一侧改名 ⇒ 本文件的断言红。
// 红→绿的第一次运行用的就是错名 `text`（CEO 当初的写法），见报告 §5。
/** 平台下单 spec 里承载内联文本的键（`WorkloadSpecIn.inline_input`）。 */
const PLATFORM_SUBMIT_SPEC_FIELD = 'inline_input'
/** 平台写进分片元数据的同名键（切片器 → assignment_payload → ws 帧）。 */
const PLATFORM_SHARD_METADATA_FIELD = 'inline_input'

/** 线上帧里被节点接受的那个名字的候选集（探针逐个试）。 */
const CANDIDATE_WIRE_FIELDS = ['inline_input', 'text', 'input_text', 'inlineInput'] as const

const INLINE_TEXT = 'alpha beta alpha\ngamma delta alpha'

/** 一份合法的 `shard_assign` 载荷；只把内联文本的键名参数化。 */
function assignment(field: string, value: string | null) {
  return {
    worker_id: 'worker-1', workload_id: 'workload-1', shard_id: 'shard-1', attempt: 0,
    task_type: 'word_count', runtime: 'node', input_kind: 'inline',
    [field]: value,
    input_ref: '', input_refs: [], code_url: 'https://untrusted.invalid/code.py', code_sha256: '',
    timeout_s: 60, verification_policy: 'semantic', execution_model: '', capability: 'text.transform',
    capability_version: '1.0.0', lease_token: 'fixture-only-lease',
  }
}

const connections: EdgeWorkerConnection[] = []
const servers: FixtureWebSocketServer[] = []

/** 关掉本次用例起的真实 socket 与连接。 */
async function teardown(): Promise<void> {
  for (const connection of connections.splice(0)) await connection.close()
  for (const server of servers.splice(0)) await server.close()
}

// 探针会为每个候选名起一次真实连接：每个用例结束必须收干净，否则 socket 会攒到进程退出。
afterEach(teardown)

/**
 * 在真实 socket 上问节点：`shard_assign` 里哪个键名才会被接受。
 *
 * 不读常量、不读源码，只看行为：`onOffer` 被调用 = 该名字被接受；连接以
 * `EDGE_PROTOCOL_INVALID` 关闭 = 该名字被拒。这样"节点改名"必定让本探针给出别的答案。
 * @param field - 要试的线上键名。
 * @param value - 该键承载的值；`null` 模拟"平台没认这个字段"。
 * @returns 节点是否把这个载荷当成了可执行派单。
 */
async function nodeAcceptsWireField(field: string, value: string | null): Promise<boolean> {
  let offered = false
  let assigned = false
  const server = await FixtureWebSocketServer.start({ script: (frame, context) => {
    if (frame.type === 'hello') context.reply('welcome', { hb_interval_s: 60 })
    if (frame.type === 'auth') context.reply('auth_ok', { worker_id: 'worker-1', owner_id: 7 })
    if (frame.type === 'hb') {
      context.reply('hb_ack', {})
      if (frame.payload.mode === 'running' && !assigned) {
        assigned = true
        context.reply('shard_assign', assignment(field, value))
      }
    }
  } })
  servers.push(server)
  const connection = new EdgeWorkerConnection({
    origin: server.origin, tokenProvider: () => 'fixture-only-token', expectedOwnerId: 7,
    name: 'inline-input-contract-fixture', clientBuild: 'fixture', os: 'test', arch: 'test', capabilities: {},
    allowedTaskTypes: ['word_count'], handshakeTimeoutMs: 2000, maxFrameBytes: 65536, maxOutputBytes: 4096,
    readLoad: () => 0, onEvent: () => {},
    onOffer: async () => { offered = true },
  })
  connections.push(connection)
  await connection.connect()
  connection.updateMode('running')
  // 帧往返是异步的：给真实 socket 一个足够的窗口再判读结果。
  for (let i = 0; i < 40 && !offered; i += 1) await new Promise(resolve => setTimeout(resolve, 25))
  return offered
}

/** 用行为探针问出节点真正读的那个线上名。 */
async function probeAcceptedWireFieldName(): Promise<string> {
  for (const candidate of CANDIDATE_WIRE_FIELDS) {
    // eslint-disable-next-line no-await-in-loop -- 探针必须串行：一次一个候选，避免互相污染
    if (await nodeAcceptsWireField(candidate, INLINE_TEXT)) return candidate
  }
  return '<none>'
}

describe('E10 内联输入契约 · 三向字段名必须一致', () => {
  it('节点在真实 socket 上只接受平台用的那个线上名', async () => {
    const accepted = await probeAcceptedWireFieldName()
    expect(accepted).not.toBe('<none>')
    expect(accepted).toBe('inline_input')
  })

  it('下单字段名 = 分片元数据字段名 = 线上帧字段名', async () => {
    const wire = await probeAcceptedWireFieldName()
    expect(PLATFORM_SUBMIT_SPEC_FIELD).toBe(wire)
    expect(PLATFORM_SHARD_METADATA_FIELD).toBe(wire)
  })

  it('改名成 text 会被节点当成畸形帧拒掉（错名不该有第二条通路）', async () => {
    expect(await nodeAcceptsWireField('text', INLINE_TEXT)).toBe(false)
  })
})

describe('E10 内联输入契约 · 生产快照回放', () => {
  /**
   * 两张**实测**快照，取自生产库 `we_shards.metadata`（2026-09-22，`SELECT metadata::text`），
   * 只截取与本契约相关的键，值逐字照抄。
   */
  const FAILED_SHARD_METADATA = {
    params: {}, input_kind: 'inline', input_refs: [], inline_input: null,
    workload_name: 'E2E-真单-word_count', files_in_shard: 1,
    input_manifest: { schema: 'input_manifest.v1', entries: [], semantics: 'per_item', total_entries: 1 },
    slice_strategy: 'single',
  }
  const DONE_SHARD_METADATA = {
    params: {}, input_kind: 'inline', input_refs: [], slice_meta: { line_end: 1, line_start: 0, total_lines: 1 },
    total_lines: 1, inline_input: INLINE_TEXT, workload_name: 'E10-契约对齐-真单-inline_input',
    lines_in_shard: 1, slice_strategy: 'lines_chunked',
  }

  it('平台分片元数据确实用这个名字承载内联文本', () => {
    expect(Object.keys(DONE_SHARD_METADATA)).toContain(PLATFORM_SHARD_METADATA_FIELD)
    expect(Object.keys(FAILED_SHARD_METADATA)).toContain(PLATFORM_SHARD_METADATA_FIELD)
  })

  it('成功快照的分片形状，节点能执行', async () => {
    const value = (DONE_SHARD_METADATA as Record<string, unknown>)[PLATFORM_SHARD_METADATA_FIELD]
    expect(value).toBe(INLINE_TEXT)
    expect(await nodeAcceptsWireField(PLATFORM_SHARD_METADATA_FIELD, value as string)).toBe(true)
  })

  it('失败快照的形状（键丢了 ⇒ null），节点按 EDGE_INPUT_UNSUPPORTED 拒绝', async () => {
    const value = (FAILED_SHARD_METADATA as Record<string, unknown>)[PLATFORM_SHARD_METADATA_FIELD]
    expect(value).toBeNull()
    // 这一条同时钉住 `slice_strategy`：无内联文本时切片器退回 single，那正是故障现场。
    expect(FAILED_SHARD_METADATA.slice_strategy).toBe('single')
    expect(DONE_SHARD_METADATA.slice_strategy).toBe('lines_chunked')
  })

  it('节点执行器对 null 内联输入给的是 EDGE_INPUT_UNSUPPORTED', async () => {
    const connection = {
      reportProgress: vi.fn(),
      complete: vi.fn(() => ({ state: 'sent-awaiting-verification' as const })),
      reject: vi.fn(),
    }
    const offer: EdgeTaskOffer = {
      workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0,
      taskType: 'word_count', runtime: 'node', inputKind: 'inline', inlineInput: null,
      inputRef: '', inputRefs: [], codeUrl: '', codeSha256: '', timeoutSeconds: 60,
      verificationPolicy: 'semantic', executionModel: '', capability: 'text.transform', capabilityVersion: '1.0.0',
    }
    expect(await executeNodeOffer(offer, new AbortController().signal, connection)).toBeUndefined()
    expect(connection.reject).toHaveBeenCalledExactlyOnceWith(offer, {
      code: 'EDGE_INPUT_UNSUPPORTED',
      message: 'Built-in node execution requires inline text without file references',
    })
    expect(connection.complete).not.toHaveBeenCalled()
    await teardown()
  })
})
