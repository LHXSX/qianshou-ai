/**
 * `tests/order-agent/` 的公共假件：脚本化 transport + 假环境。
 *
 * 铁律：**不打真模型网络**。所有用例都注入一个按剧本回答的 transport，
 * 并且把"模型被问了几次、问了什么、拿到什么凭据"记下来当断言依据。
 */
import type {
  CeoModelRequest, CeoModelResponse, CeoModelTransport, CeoModelUsage,
} from '../../src/order-agent/llm-worker.ts'

/** 一份用量（默认好看：10/5 token、1 微美元）。 */
export function usage(inputTokens = 10, outputTokens = 5, costMicroUsd: number | null = 1): CeoModelUsage {
  return { inputTokens, outputTokens, costMicroUsd }
}

/** 一条"这一轮就出产物"的响应。 */
export function finalText(text: string, usageOf: CeoModelUsage = usage()): CeoModelResponse {
  return { text, toolCalls: [], usage: usageOf, finishReason: 'stop' }
}

/** 一条"这一轮要调工具"的响应。 */
export function toolCall(name: string, args = '{}', id = 'call-1', usageOf: CeoModelUsage = usage()): CeoModelResponse {
  return { text: null, toolCalls: [{ id, name, arguments: args }], usage: usageOf, finishReason: 'tool-calls' }
}

/** 一条被长度截断的响应。 */
export function truncated(text: string, usageOf: CeoModelUsage = usage()): CeoModelResponse {
  return { text, toolCalls: [], usage: usageOf, finishReason: 'length' }
}

/** 脚本化 transport 的观察面。 */
export interface ScriptedTransport {
  readonly transport: CeoModelTransport
  /** 每一次模型调用收到的请求（顺序即调用顺序）。 */
  readonly requests: CeoModelRequest[]
  /** 每一次调用拿到的凭据（用来证明"凭据只递给了 transport"）。 */
  readonly credentialsSeen: string[]
  /** 被问了几次。 */
  readonly calls: () => number
}

/** 造一个假 transport：按剧本逐条回答，剧本用完就抛（跑飞的循环会立刻暴露）。 */
export function scriptedTransport(script: readonly (CeoModelResponse | Error)[], hooks: { readonly afterCall?: () => void } = {}): ScriptedTransport {
  const requests: CeoModelRequest[] = []
  const credentialsSeen: string[] = []
  return {
    requests,
    credentialsSeen,
    calls: () => requests.length,
    transport: {
      complete: async (request, context) => {
        requests.push(request)
        credentialsSeen.push(context.credential)
        hooks.afterCall?.()
        const step = script[requests.length - 1]
        if (step === undefined) throw new Error('剧本用完了：worker 要了比用例允许的更多次模型调用')
        if (step instanceof Error) throw step
        return step
      },
    },
  }
}

/** 一个永不作答、只在被中止时拒绝的 transport（测墙钟中止用）。 */
export function hangingTransport(): CeoModelTransport & { readonly calls: () => number } {
  let calls = 0
  return {
    calls: () => calls,
    complete: (_request, context) => {
      calls += 1
      return new Promise((_resolve, reject) => {
        context.signal.addEventListener('abort', () => reject(new Error('aborted by the host')), { once: true })
      })
    },
  }
}

/** 假环境：只按名字读，找不到返回 null（**不**碰真实 process.env）。 */
export function fakeEnvironment(values: Readonly<Record<string, string>>): (variable: string) => string | null {
  return (variable: string) => values[variable] ?? null
}

/** 假时钟：手动推进，用于确定性地跨过墙钟预算。 */
export function fakeClock(start = 0): { readonly now: () => number; readonly advance: (ms: number) => void } {
  let current = start
  return { now: () => current, advance: (ms: number) => { current += ms } }
}
