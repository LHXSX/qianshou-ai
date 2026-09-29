/**
 * 网关服务层的契约测试：串起来之后行为还对不对。
 *
 * 用**注入的假转发**而不是真服务端：这一层要验的是**流程与账目**
 * （降级、预留、结算、失败退回、用量兜底），网络边界已经在 `forward.host.spec.ts` 里验过。
 * 两件事分开测，失败时才知道该查哪里。
 */
import { describe, expect, it, vi } from 'vitest'
import { createCreditLedger } from '../src/ledger.ts'
import type { Gateway, GatewayFailure } from '../src/service.ts'
import { createGateway, resolveModel } from '../src/service.ts'
import { createRoutingConsole } from '../src/routing.ts'
import { TIERS, estimateTokens } from '../src/tiers.ts'
import { FORWARD_COPY, ForwardFailure, type ForwardCall, type ForwardHandlers, type ForwardStream } from '../src/forward.ts'

/** 一次假转发：可以流若干片段、给用量，或直接失败。 */
function fakeForward(script: {
  readonly deltas?: readonly string[]
  readonly usage?: { readonly promptTokens: number; readonly completionTokens: number } | null
  readonly failure?: ForwardFailure
}): typeof import('../src/forward.ts').forwardStream {
  return (_config: unknown, _call: ForwardCall, handlers: ForwardHandlers): ForwardStream => {
    const run = async (): Promise<void> => {
      if (script.failure !== undefined) { handlers.onError(script.failure); return }
      for (const piece of script.deltas ?? []) handlers.onDelta(piece)
      handlers.onDone(script.usage ?? { promptTokens: 0, completionTokens: 0 })
    }
    return { abort: () => { /* 假转发没有可中止的东西 */ }, completed: run() }
  }
}

/** 搭一个网关 + 账本。 */
function setup(options: {
  readonly tier?: 'basic' | 'plus' | 'max'
  readonly monthlySp?: number
  readonly script?: Parameters<typeof fakeForward>[0]
} = {}) {
  const ledger = createCreditLedger()
  const tier = options.tier ?? 'plus'
  ledger.grant('acct', tier, options.monthlySp ?? TIERS[tier].monthlySp)
  const gateway = createGateway({
    ledger,
    tierOf: () => tier,
    forward: fakeForward(options.script ?? { deltas: ['答'], usage: { promptTokens: 100, completionTokens: 50 } }),
    forwardConfig: { baseUrl: 'https://example.test/v1', apiKey: () => 'test-key' },
  })
  return { ledger, gateway, tier }
}

/** 收一次调用的事件。 */
async function run(gateway: ReturnType<typeof setup>['gateway'], publishedName: string, messages = [{ role: 'user' as const, content: '你好' }]) {
  const deltas: string[] = []
  /**
   * 显式标注类型，**不用嵌套的 `Parameters<...>` 提取**。
   *
   * 早先写的是 `Parameters<Parameters<typeof gateway.chat>[1]['onError']>[0] | null`，
   * 推断结果是 `never`——于是所有 `result.error?.kind` 之类的断言都报
   * "Property 'kind' does not exist on type 'never'"。这种错在**跑单包 tsconfig 时看不到**
   * （那个配置不含 tests 目录），只有推送前的全量 typecheck 才暴露出来。
   */
  /**
   * 收结果用**对象**，不用两个 `let`。
   *
   * 为什么（这是一个只有全量 typecheck 才看得见的坑）：`let done: X | null = null`
   * 只在回调里被赋值，而 TypeScript 的控制流分析看不见"回调稍后执行"——于是 `done`
   * 在读取处仍被当成 `null`，`done?.chargedSp` 就报 "does not exist on type 'never'"。
   * 挂在对象上就没有这层（错误的）收窄。
   */
  const captured: {
    done: Parameters<Parameters<Gateway['chat']>[1]['onDone']>[0] | null
    error: GatewayFailure | null
  } = { done: null, error: null }
  const handle = gateway.chat(
    { callId: `c-${Math.random().toString(36).slice(2, 8)}`, accountId: 'acct', publishedName, messages },
    {
      onDelta: (text) => { deltas.push(text) },
      onDone: (result) => { captured.done = result },
      onError: (failure) => { captured.error = failure },
    },
  )
  await handle.completed
  return { deltas, done: captured.done, error: captured.error, callId: handle }
}

describe('模型解析：三种情况分开', () => {
  it('名字存在且档位能用 → 照用，不算降级', () => {
    const resolved = resolveModel('千手·强力', TIERS.plus)
    expect('model' in resolved).toBe(true)
    if ('model' in resolved) {
      expect(resolved.model.publishedName).toBe('千手·强力')
      expect(resolved.downgraded).toBe(false)
    }
  })

  it('名字存在但档位不能用 → **退回该档位最好的模型**，并标记降级', () => {
    const resolved = resolveModel('千手·强力', TIERS.basic)
    expect('model' in resolved).toBe(true)
    if ('model' in resolved) {
      expect(resolved.model.publishedName).toBe('千手·迅捷')
      expect(resolved.downgraded).toBe(true)
    }
  })

  it('名字不存在 → 拒绝（不静默替它选一个）', () => {
    const resolved = resolveModel('gpt-5', TIERS.plus)
    expect('ok' in resolved).toBe(true)
  })
})

describe('完整流程', () => {
  it('正常一问一答：流出去的东西交给调用方，并按用量扣费', async () => {
    const { gateway, ledger } = setup({ script: { deltas: ['你', '好'], usage: { promptTokens: 100, completionTokens: 50 } } })
    const result = await run(gateway, '千手·迅捷')

    expect(result.deltas).toEqual(['你', '好'])
    expect(result.error).toBeNull()
    expect(result.done?.chargedSp).toBeGreaterThan(0)
    expect(result.done?.downgraded).toBe(false)
    expect(ledger.recordsOf('acct')).toHaveLength(1)
  })

  it('额度充足时预留会被结算掉，余额相应减少', async () => {
    const { gateway, ledger } = setup({ script: { deltas: ['答'], usage: { promptTokens: 100, completionTokens: 50 } } })
    const before = ledger.creditOf('acct', 'plus').remainingMonthlySp
    await run(gateway, '千手·迅捷')
    expect(ledger.creditOf('acct', 'plus').remainingMonthlySp).toBeLessThan(before)
  })

  it('档位不够时**降级**到该档位最好的模型，并如实上报降级', async () => {
    const { gateway } = setup({ tier: 'basic', script: { deltas: ['答'], usage: { promptTokens: 10, completionTokens: 5 } } })
    const result = await run(gateway, '千手·强力')
    expect(result.done?.publishedName).toBe('千手·迅捷')
    expect(result.done?.downgraded).toBe(true)
  })

  it('额度不足 → 拒绝，且**不产生任何扣费**', async () => {
    const { gateway, ledger } = setup({ monthlySp: 0 })
    const result = await run(gateway, '千手·迅捷')
    expect(result.error?.kind).toBe('rejected')
    expect(result.deltas).toHaveLength(0)
    expect(ledger.recordsOf('acct')).toHaveLength(0)
  })

  it('上下文超限 → 拒绝，并说清上限', async () => {
    const { gateway } = setup({ tier: 'basic' })
    const result = await run(gateway, '千手·迅捷', [{ role: 'user', content: '字'.repeat(TIERS.basic.contextLimitTokens + 10) }])
    expect(result.error?.kind).toBe('rejected')
    expect(result.error?.rejection?.kind).toBe('context-too-long')
  })
})

describe('用量兜底：绝不能出现「用了但不计费」的缝隙', () => {
  it('上游不给用量时用**模型无关的估算**，且中文不被低估', async () => {
    const { gateway, ledger } = setup({ script: { deltas: ['这是一段中文回答'], usage: { promptTokens: 0, completionTokens: 0 } } })
    const result = await run(gateway, '千手·迅捷')

    expect(result.done?.usageSource).toBe('estimated')
    expect(result.done?.chargedSp).toBeGreaterThan(0)
    const record = ledger.recordsOf('acct')[0]
    expect(record?.outputTokens).toBe(estimateTokens('这是一段中文回答'))
    // 8 个汉字 = 8 token，而不是「字符数÷4」的 2
    expect(record?.outputTokens).toBe(8)
  })

  it('上游给了权威用量就用它', async () => {
    const { gateway, ledger } = setup({ script: { deltas: ['答'], usage: { promptTokens: 1234, completionTokens: 567 } } })
    const result = await run(gateway, '千手·迅捷')
    expect(result.done?.usageSource).toBe('provider')
    const record = ledger.recordsOf('acct')[0]
    expect(record?.inputTokens).toBe(1234)
    expect(record?.outputTokens).toBe(567)
  })
})

describe('失败收尾', () => {
  it('调用失败 → 预留**全额退回**（没拿到回答不该付钱）', async () => {
    const { gateway, ledger } = setup({ script: { failure: new ForwardFailure('rate-limited', FORWARD_COPY['rate-limited'], 429) } })
    const before = ledger.creditOf('acct', 'plus').remainingMonthlySp
    const result = await run(gateway, '千手·迅捷')

    expect(result.error?.kind).toBe('rate-limited')
    expect(ledger.creditOf('acct', 'plus').remainingMonthlySp).toBe(before)
    expect(ledger.recordsOf('acct')).toHaveLength(0)
  })

  it('部分到达后失败 → 已流出的正文**如实交回**，不让用户以为那些字是幻觉', async () => {
    const partial = new ForwardFailure('unreachable', FORWARD_COPY.unreachable)
    const forward = ((_c: unknown, _call: ForwardCall, handlers: ForwardHandlers): ForwardStream => {
      const run = async (): Promise<void> => {
        handlers.onDelta('已经到达的开头')
        handlers.onError(partial)
      }
      return { abort: () => { /* 无 */ }, completed: run() }
    }) as typeof import('../src/forward.ts').forwardStream

    const ledger = createCreditLedger()
    ledger.grant('acct', 'plus', 990)
    const gateway = createGateway({
      ledger,
      tierOf: () => 'plus',
      forward,
      forwardConfig: { baseUrl: 'https://example.test/v1', apiKey: () => 'k' },
    })
    const result = await run(gateway, '千手·迅捷')

    expect(result.deltas).toEqual(['已经到达的开头'])
    expect(result.error?.partialText).toBe('已经到达的开头')
    // 仍然退回：回答没完成
    expect(ledger.recordsOf('acct')).toHaveLength(0)
  })

  it('失败只收尾一次（不重复记账）', async () => {
    const forward = ((_c: unknown, _call: ForwardCall, handlers: ForwardHandlers): ForwardStream => {
      const run = async (): Promise<void> => {
        handlers.onDelta('x')
        // 先失败、再"完成"——真实服务商不会这样，但重复收尾必须被挡住。
        handlers.onError(new ForwardFailure('unreachable', FORWARD_COPY.unreachable))
        handlers.onDone({ promptTokens: 1, completionTokens: 1 })
      }
      return { abort: () => { /* 无 */ }, completed: run() }
    }) as typeof import('../src/forward.ts').forwardStream

    const ledger = createCreditLedger()
    ledger.grant('acct', 'plus', 990)
    const gateway = createGateway({
      ledger,
      tierOf: () => 'plus',
      forward,
      forwardConfig: { baseUrl: 'https://example.test/v1', apiKey: () => 'k' },
    })
    const onDone = vi.fn()
    const onError = vi.fn()
    const handle = gateway.chat(
      { callId: 'c1', accountId: 'acct', publishedName: '千手·迅捷', messages: [{ role: 'user', content: 'hi' }] },
      { onDelta: () => { /* 不关心 */ }, onDone, onError },
    )
    await handle.completed

    expect(onError).toHaveBeenCalledTimes(1)
    expect(onDone).not.toHaveBeenCalled()
    expect(ledger.recordsOf('acct')).toHaveLength(0)
  })
})

describe('控制台驱动的后端选择（这一条验的是"控制台真的接上了"）', () => {
  it('控制台把「千手·迅捷」指向 pro 时，实际调用的就是 pro', async () => {
    const calls: string[] = []
    const forward = ((_c: unknown, call: ForwardCall, handlers: ForwardHandlers): ForwardStream => {
      calls.push(call.model)
      const run = async (): Promise<void> => {
        handlers.onDelta('答')
        handlers.onDone({ promptTokens: 10, completionTokens: 5 })
      }
      return { abort: () => { /* 无 */ }, completed: run() }
    }) as typeof import('../src/forward.ts').forwardStream

    const console_ = createRoutingConsole()
    console_.publish({
      publishedName: '千手·迅捷', label: '千手·迅捷', tiers: ['basic', 'plus', 'max'],
      maxOutputTokens: 4096, order: 0, upgradeRule: 'on-expiry', lifecycleStage: 'ga',
      shutdownDate: null, migrationTarget: null,
    })
    console_.bind({ publishedName: '千手·迅捷', backendKeys: ['pro'], effectiveFrom: 0, reason: '测试：故意指向 pro', operator: 'test' })

    const ledger = createCreditLedger()
    ledger.grant('acct', 'plus', 990)
    const gateway = createGateway({
      ledger,
      tierOf: () => 'plus',
      routing: console_,
      now: () => 1000,
      forward,
      forwardConfig: { baseUrl: 'https://example.test/v1', apiKey: () => 'k' },
    })
    const result = await run(gateway, '千手·迅捷')

    expect(result.error).toBeNull()
    // 静态目录说「迅捷 → flash」，但控制台说了算：实际发出的是 pro
    expect(calls).toEqual(['deepseek-v4-pro'])
  })

  it('控制台说已下线时拒绝，而不是偷偷用一个它没批准的模型', async () => {
    const console_ = createRoutingConsole()
    console_.publish({
      publishedName: '千手·迅捷', label: '千手·迅捷', tiers: ['basic', 'plus', 'max'],
      maxOutputTokens: 4096, order: 0, upgradeRule: 'on-expiry', lifecycleStage: 'retired',
      shutdownDate: 500, migrationTarget: '千手·迅捷二代',
    })
    console_.bind({ publishedName: '千手·迅捷', backendKeys: ['flash'], effectiveFrom: 0, reason: 't', operator: 't' })

    const ledger = createCreditLedger()
    ledger.grant('acct', 'plus', 990)
    const gateway = createGateway({
      ledger,
      tierOf: () => 'plus',
      routing: console_,
      now: () => 1000, // 已过 shutdownDate
      forward: fakeForward({ deltas: ['不应出现'] }),
      forwardConfig: { baseUrl: 'https://example.test/v1', apiKey: () => 'k' },
    })
    const result = await run(gateway, '千手·迅捷')

    expect(result.error?.kind).toBe('rejected')
    expect(result.error?.message).toContain('二代')
    expect(result.deltas).toHaveLength(0)
    // 没扣钱、没记账
    expect(ledger.recordsOf('acct')).toHaveLength(0)
  })

  it('没接控制台时保持既有行为（静态声明的后端顺序）', async () => {
    const calls: string[] = []
    const forward = ((_c: unknown, call: ForwardCall, handlers: ForwardHandlers): ForwardStream => {
      calls.push(call.model)
      const run = async (): Promise<void> => { handlers.onDone({ promptTokens: 1, completionTokens: 1 }) }
      return { abort: () => { /* 无 */ }, completed: run() }
    }) as typeof import('../src/forward.ts').forwardStream

    const ledger = createCreditLedger()
    ledger.grant('acct', 'plus', 990)
    const gateway = createGateway({
      ledger,
      tierOf: () => 'plus',
      forward,
      forwardConfig: { baseUrl: 'https://example.test/v1', apiKey: () => 'k' },
    })
    await run(gateway, '千手·迅捷')
    expect(calls).toEqual(['deepseek-flash'])
  })
})
