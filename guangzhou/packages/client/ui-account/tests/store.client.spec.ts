/**
 * 读层的契约测试。
 *
 * 盯住的是四件**错了不会被发现、但会真的害人**的事：
 *
 * 1. **必须是 POST**。同一路径 GET 在宿主上得到 `404 not found`，
 *    而 404 在界面上会显示成"没有这个功能"，不是"读不到"——两种诊断差得很远。
 *    所以这里断言的是**方法本身**，不是"请求发出去了"。
 * 2. **读不懂就不猜**。网关少给一个 `monthlySp` 时，界面必须说"算不出比例"，
 *    绝不能画成 0%（那等于告诉用户额度用光了）。
 * 3. **失败要分类**。`unavailable` 与 `anonymous` 导向相反的动作：
 *    前者"稍后再试"、后者"去登录"。混成一个"失败"会让已登录的人跑去重新登录。
 * 4. **force 必须真的绕过 TTL**。用户点了刷新就该去读，不能拿缓存糊弄他。
 *
 * 传输层是构造参数，所以这里不需要浏览器、也不需要宿主在跑。
 */

import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_STATE_PATH, AI_STATUS_PATH } from '../src/client/endpoints.ts'
import { AccountViewService, readAccountState, readGateway } from '../src/client/store.ts'
import { parseAccountState, parseGatewayStatus, remainingRatio, yuanOfSp } from '../src/client/status.ts'

/** 真实抓到的 200 正文（2026-09-16，本机 3091）。 */
const REAL_STATUS = {
  ok: true,
  version: 'qianshou.ai.v1',
  tier: { id: 'basic', label: '普通版', monthlyYuan: 39 },
  credit: { remainingSp: 389.53, monthlySp: 390, usedInWindowSp: 0.47, windowLimitSp: 60 },
  limits: { contextLimitTokens: 64000, concurrency: 5 },
}

/** 真实抓到的账号会话正文。 */
const REAL_ACCOUNT = {
  ok: true,
  state: 'authenticated',
  account: { id: 167, username: '111111', email: '1111111111@qq.com', role: 'personal' },
}

/** 一个假 fetch：记录调用，按路径回答。 */
function fakeFetch(routes: Record<string, () => Response>) {
  const calls: { readonly url: string; readonly init: RequestInit | undefined }[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const handler = routes[url]
    if (handler === undefined) throw new Error(`unexpected url ${url}`)
    return handler()
  }) as unknown as typeof fetch
  return { calls, impl }
}

/** 造一个 JSON 响应。 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

describe('契约：端点的形状', () => {
  it('两条读请求都是 POST 且带同源凭据', async () => {
    const { calls, impl } = fakeFetch({
      [ACCOUNT_STATE_PATH]: () => json(REAL_ACCOUNT),
      [AI_STATUS_PATH]: () => json(REAL_STATUS),
    })
    vi.stubGlobal('fetch', impl)
    try {
      await readAccountState(new AbortController().signal)
      await readGateway(new AbortController().signal)
      expect(calls.map(c => c.init?.method)).toEqual(['POST', 'POST'])
      expect(calls.map(c => c.init?.credentials)).toEqual(['include', 'include'])
      expect(calls.map(c => c.url)).toEqual([ACCOUNT_STATE_PATH, AI_STATUS_PATH])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('路径常量就是宿主注册的那两条（改错了会 404）', () => {
    expect(ACCOUNT_STATE_PATH).toBe('/api/qianshou/account/state')
    expect(AI_STATUS_PATH).toBe('/api/qianshou/ai/status')
  })
})

describe('契约：解析真实响应', () => {
  it('真实额度正文逐字段读对', () => {
    const facts = parseGatewayStatus(REAL_STATUS)
    expect(facts).not.toBeNull()
    expect(facts?.version).toBe('qianshou.ai.v1')
    expect(facts?.tier).toEqual({ id: 'basic', label: '普通版', monthlyYuan: 39 })
    expect(facts?.credit.remainingSp).toBe(389.53)
    expect(facts?.limits.concurrency).toBe(5)
  })

  it('真实账号会话正文读对，数字 id 折成字符串', () => {
    const facts = parseAccountState(REAL_ACCOUNT)
    expect(facts.state).toBe('authenticated')
    if (facts.state !== 'authenticated') return
    expect(facts.account.id).toBe('167')
    expect(facts.account.username).toBe('111111')
  })

  it('ok 不为 true 一律不认', () => {
    expect(parseGatewayStatus({ ...REAL_STATUS, ok: false })).toBeNull()
    expect(parseAccountState({ ok: false, state: 'authenticated' })).toEqual({ state: 'unknown' })
  })

  it('缺 tier.id 或 remainingSp 就返回 null，不猜一个数字', () => {
    expect(parseGatewayStatus({ ok: true, credit: { remainingSp: 1 } })).toBeNull()
    expect(parseGatewayStatus({ ok: true, tier: { id: 'basic' }, credit: {} })).toBeNull()
  })

  it('monthlySp 缺失时比例返回 null（界面据此画"算不出"，而不是 0%）', () => {
    const facts = parseGatewayStatus({ ...REAL_STATUS, credit: { remainingSp: 10 } })
    expect(facts).not.toBeNull()
    expect(facts?.credit.monthlySp).toBeNull()
    expect(remainingRatio(facts!.credit)).toBeNull()
  })

  it('account.id 读不出来就是 unknown，不降级成"未登录"', () => {
    expect(parseAccountState({ ok: true, state: 'authenticated', account: {} })).toEqual({ state: 'unknown' })
  })

  it('SP → 元的显示换算是 1:100', () => {
    expect(yuanOfSp(389.53)).toBe('3.90')
    expect(yuanOfSp(0)).toBe('0.00')
  })

  it('比例被夹在 [0,1]：超额与负余额都不画到框外', () => {
    expect(remainingRatio({ remainingSp: 500, monthlySp: 390, usedInWindowSp: null, windowLimitSp: null })).toBe(1)
    expect(remainingRatio({ remainingSp: -5, monthlySp: 390, usedInWindowSp: null, windowLimitSp: null })).toBe(0)
  })
})

describe('契约：失败分类', () => {
  it('401 归为 rejected，并把服务端中文原话带出来', async () => {
    vi.stubGlobal('fetch', (async () => json({ ok: false, message: '请先登录。' }, 401)) as unknown as typeof fetch)
    try {
      const read = await readGateway(new AbortController().signal)
      expect(read.kind).toBe('rejected')
      expect(read.message).toBe('请先登录。')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('网络异常归为 unavailable，且**不抛**（读不到不该让界面崩）', async () => {
    vi.stubGlobal('fetch', (async () => { throw new Error('boom') }) as unknown as typeof fetch)
    try {
      const read = await readGateway(new AbortController().signal)
      expect(read.kind).toBe('unavailable')
      expect(read.facts).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('200 但正文读不懂 → unavailable，不是"额度 0"', async () => {
    vi.stubGlobal('fetch', (async () => json({ ok: true })) as unknown as typeof fetch)
    try {
      const read = await readGateway(new AbortController().signal)
      expect(read.kind).toBe('unavailable')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('契约：读状态机', () => {
  /** 造一个服务：两条读取由测试提供。 */
  function service(overrides: {
    readonly account?: () => Promise<'anonymous' | 'unavailable' | { id: string; username: string; email: string; role: string }>
    readonly gateway?: () => Promise<{ kind: 'ok' | 'rejected' | 'unavailable'; facts: unknown; message: string | null }>
    readonly now?: () => number
  } = {}) {
    const accountCalls: number[] = []
    const gatewayCalls: number[] = []
    let clock = 1_000
    const svc = new AccountViewService({
      now: overrides.now ?? (() => clock),
      readAccount: async () => {
        accountCalls.push(clock)
        return overrides.account === undefined ? { id: '167', username: '111111', email: 'a@b.c', role: 'personal' } : await overrides.account()
      },
      readGateway: async () => {
        gatewayCalls.push(clock)
        const result = overrides.gateway === undefined
          ? { kind: 'ok' as const, facts: parseGatewayStatus(REAL_STATUS), message: null }
          : await overrides.gateway()
        return result as never
      },
    })
    return { svc, accountCalls, gatewayCalls, advance: (ms: number) => { clock += ms } }
  }

  it('成功一次后两处都 ready，数字落在快照里', async () => {
    const { svc } = service()
    await svc.refresh()
    const view = svc.store.getSnapshot()
    expect(view.accountPhase).toBe('ready')
    expect(view.gatewayPhase).toBe('ready')
    expect(view.gateway?.credit.remainingSp).toBe(389.53)
    expect(view.account?.username).toBe('111111')
  })

  it('TTL 内重复调用复用结果；过了 TTL 才再打一次', async () => {
    const { svc, gatewayCalls, advance } = service()
    await svc.refresh()
    await svc.refresh()
    expect(gatewayCalls).toHaveLength(1)
    advance(10_000)
    await svc.refresh()
    expect(gatewayCalls).toHaveLength(2)
  })

  it('force 绕过 TTL：用户点了刷新就必须真的去读', async () => {
    const { svc, gatewayCalls } = service()
    await svc.refresh()
    await svc.refresh({ force: true })
    expect(gatewayCalls).toHaveLength(2)
  })

  it('并发调用共享同一次往返（侧栏卡片可能被多次挂载）', async () => {
    const { svc, gatewayCalls } = service()
    await Promise.all([svc.refresh(), svc.refresh(), svc.refresh()])
    expect(gatewayCalls).toHaveLength(1)
  })

  it('网关读不到时，账号仍然显示为已登录 —— 这正是最需要它的场合', async () => {
    const { svc } = service({ gateway: async () => ({ kind: 'unavailable', facts: null, message: null }) })
    await svc.refresh()
    const view = svc.store.getSnapshot()
    expect(view.accountPhase).toBe('ready')
    expect(view.account?.id).toBe('167')
    expect(view.gatewayPhase).toBe('unavailable')
    expect(view.gateway).toBeNull()
  })

  it('未登录与读不到是两种状态（导向相反的动作）', async () => {
    const anon = service({ account: async () => 'anonymous' })
    await anon.svc.refresh()
    expect(anon.svc.store.getSnapshot().accountPhase).toBe('anonymous')

    const down = service({ account: async () => 'unavailable' })
    await down.svc.refresh()
    expect(down.svc.store.getSnapshot().accountPhase).toBe('unavailable')
  })

  it('被服务端拒绝时快照里没有额度，但有原因原话', async () => {
    const { svc } = service({ gateway: async () => ({ kind: 'rejected', facts: null, message: '请先登录。' }) })
    await svc.refresh()
    const view = svc.store.getSnapshot()
    expect(view.gateway).toBeNull()
    expect(view.gatewayMessage).toBe('请先登录。')
    expect(view.gatewayPhase).toBe('anonymous')
  })

  it('读取失败后的重试间隔更长，避免界面反复戳后端', async () => {
    let failing = true
    const { svc, gatewayCalls, advance } = service({
      gateway: async () => failing
        ? { kind: 'unavailable', facts: null, message: null }
        : { kind: 'ok', facts: parseGatewayStatus(REAL_STATUS), message: null },
    })
    await svc.refresh()
    advance(3_000)
    await svc.refresh()      // 3s < 失败后的 5s 退避 → 不重打
    expect(gatewayCalls).toHaveLength(1)
    advance(3_000)
    failing = false
    await svc.refresh()      // 累计 6s > 5s → 重打并成功
    expect(gatewayCalls).toHaveLength(2)
    expect(svc.store.getSnapshot().gatewayPhase).toBe('ready')
  })

  it('dispose 之后在途结果不再写入快照', async () => {
    // 初值给一个空函数而不是 null：赋值发生在 Promise 执行器的闭包里，
    // TS 的控制流分析看不到那条路径，`| null` 会被收窄成 `never`，
    // 于是 `release?.()` 报「不可调用」。空函数既满足类型也不改变测试语义。
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const svc = new AccountViewService({
      readAccount: async () => { await gate; return { id: '167', username: 'u', email: '', role: 'personal' } },
      readGateway: async () => { await gate; return { kind: 'ok', facts: parseGatewayStatus(REAL_STATUS), message: null } },
    })
    const pending = svc.refresh()
    svc.dispose()
    release()
    await pending
    expect(svc.store.getSnapshot().accountPhase).toBe('idle')
  })
})
