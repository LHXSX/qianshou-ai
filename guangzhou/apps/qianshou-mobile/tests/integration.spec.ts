/**
 * 手机端调用链路的**端到端**集成测试。
 *
 * 跑在 `tools/mock-llm-server.mjs` 这个真实的 OpenAI 兼容服务端上（不是 fetch 打桩）：
 * 验证「构造请求 → 真实 HTTP → SSE 逐字节到达 → 调用层拼装 → 回调交付」整条链路，
 * 以及 401 时用户看到的是可读文案而不是技术堆栈。
 *
 * 与 `llm.spec.ts` 的分工：那份用内联服务端测边界（半行、无 [DONE]、逐字节）；
 * 这份用**仓库里真实的测试服务端**测完整链路，并作为手动联调的参照实现。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatFailure, streamChat } from '../src/llm.ts'

/**
 * 端口由**系统分配**（传 0），不在测试里写死。
 *
 * 早先这里写死 18997，与别的测试并发跑时会抢端口，表现为"单跑全绿、合跑偶发红"。
 * 那种随机失败最难查，也最容易被当成噪音忽略——所以让内核挑一个空闲端口。
 */
let port = 0
let server: ChildProcess | undefined

/** 等端口就绪；超时则失败，避免测试悬挂。 */
async function waitReady(port: number, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(500),
      })
      if (res.status > 0) return
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('测试服务端未能就绪')
}

beforeAll(async () => {
  server = spawn(process.execPath, ['tools/mock-llm-server.mjs', '0'], {
    cwd: new URL('..', import.meta.url).pathname,
    // 要读 stdout 才知道系统分配了哪个端口，所以不能再 ignore。
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('测试服务端未在 15 秒内报告端口')), 15_000)
    let buffer = ''
    server?.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString()
      const match = /QIANSHOU_MOCK_PORT=(\d+)/.exec(buffer)
      if (match !== null) { clearTimeout(timer); resolve(Number(match[1])) }
    })
    server?.on('exit', code => { clearTimeout(timer); reject(new Error(`测试服务端提前退出（code=${String(code)}）`)) })
  })
  await waitReady(port)
}, 25000)

afterAll(() => { server?.kill() })

/** 一次往返的结果；用判别式字段而不是可空字段，避免闭包赋值导致的类型收窄问题。 */
/** 一次往返里必然拿到的三个观测值。 */
interface RoundTripBase {
  readonly text: string
  readonly deltas: readonly string[]
  readonly done: boolean
}

/** 成功或失败；用判别式字段而不是可空标量，闭包赋值下的类型收窄才可靠。 */
type RoundTrip =
  | (RoundTripBase & { readonly outcome: 'ok' })
  | (RoundTripBase & { readonly outcome: 'failed'; readonly failure: ChatFailure })

/** 跑一次完整的流式往返。 */
async function roundTrip(apiKey: string, content: string): Promise<RoundTrip> {
  const deltas: string[] = []
  let done = false
  // 收集式而不是可空标量：`onError` 在回调里赋值，TypeScript 的控制流分析看不到
  // 那次写入，可空标量会被收窄成 `never`；数组的元素类型是声明类型，保真。
  const failures: ChatFailure[] = []
  const stream = streamChat(
    { baseUrl: `http://127.0.0.1:${port}/v1`, apiKey, model: 'deepseek-chat',
      messages: [{ role: 'user', content }] },
    { onDelta: t => deltas.push(t), onDone: () => { done = true }, onError: (f) => { failures.push(f) } },
  )
  await stream.completed
  const text = deltas.join('')
  if (failures.length === 0) return { text, deltas, done, outcome: 'ok' }
  const first = failures[0]
  if (first === undefined) throw new Error('失败数组非空但取不到首项')
  return { text, deltas, done, outcome: 'failed', failure: first }
}

describe('端到端：界面 → 调用层 → 真实 HTTP → 流式渲染', () => {
  it('一次完整往返拿到回复，且是多次增量而非一次性', async () => {
    const result = await roundTrip('sk-test-abc', '你好')
    expect(result.outcome).toBe('ok')
    expect(result.done).toBe(true)
    expect(result.text).toContain('你好')
    // 逐字节写出的服务端必须被拼装成多次增量；只有一次说明流式没生效。
    expect(result.deltas.length).toBeGreaterThan(5)
  })

  it('服务端逐字节发送时，回复内容不含协议残留', async () => {
    const result = await roundTrip('sk-test-abc', '检查协议残留')
    expect(result.text).not.toContain('data:')
    expect(result.text).not.toContain('[DONE]')
    expect(result.text.trim().length).toBeGreaterThan(0)
  })

  it('缺少 Bearer 时服务端 401，用户看到可读文案', async () => {
    const result = await roundTrip('', '你好')
    if (result.outcome !== 'failed') throw new Error('应当收到失败，但没有')
    expect(result.failure.kind).toBe('unauthorized')
    expect(result.failure.status).toBe(401)
    expect(result.failure.message).toContain('密钥')
    // 不许把服务商原文透出去
    expect(result.failure.message).not.toContain('invalid api key')
  })

  it('模型标记被真实带进请求（服务端把它写进回复）', async () => {
    const result = await roundTrip('sk-test-abc', '模型检查')
    expect(result.text).toContain('deepseek-chat')
  })
})
