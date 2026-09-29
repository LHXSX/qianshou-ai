/**
 * 后端健康与冷却的契约测试。
 *
 * 守的是一处"**声明了但没执行**"的缺陷：控制台给一个前台名字绑的是**有序后端列表**，
 * 并宣称"主后端故障时按顺序落到备用"，而运行时只取 `backends[0]`——
 * 后面那些永远不会被调用。于是控制台上配的备用后端是空话，
 * 用户会一直卡在坏掉的上游上，换绑之前没法自愈。
 * （开源对比时在 one-api 里看到同一类缺陷：schema 有个 `Channel.Weight`，逻辑里从不读它。）
 */
import { describe, expect, it } from 'vitest'
import { createBackendHealth } from '../src/backend-health.ts'
import { BACKENDS, type BackendModel } from '../src/tiers.ts'

/** 拿两个真实后端来测（用真实数据，不用编的假对象）。 */
const A = BACKENDS['flash'] as BackendModel
const B = BACKENDS['pro'] as BackendModel
const C = BACKENDS['qwen'] as BackendModel

describe('跳过正在冷却的后端，让备用真的会被用上', () => {
  it('全都健康时用第一个（不无谓地换后端）', () => {
    const health = createBackendHealth()
    const picked = health.pick([A, B])
    expect(picked.backend.id).toBe(A.id)
    expect(picked.fellBack).toBe(false)
  })

  it('第一个进入冷却后，**第二个真的会被选中**（这就是修复的要点）', () => {
    const health = createBackendHealth({ failThreshold: 2 })
    health.recordFailure(A.id)
    // 只失败一次还不冷却：偶发一次网络抖动不该立刻把客户切到别的上游。
    expect(health.pick([A, B]).backend.id).toBe(A.id)
    health.recordFailure(A.id)
    expect(health.isCooling(A.id)).toBe(true)
    const picked = health.pick([A, B])
    expect(picked.backend.id).toBe(B.id)
    expect(picked.fellBack).toBe(true)
  })

  it('前两个都冷却时用第三个', () => {
    const health = createBackendHealth({ failThreshold: 1 })
    health.recordFailure(A.id)
    health.recordFailure(B.id)
    expect(health.pick([A, B, C]).backend.id).toBe(C.id)
  })

  it('冷却期满后回到原始优先级（第一次真实请求就是探针）', () => {
    let clock = 1_000_000
    const health = createBackendHealth({ failThreshold: 1, cooldownMs: 60_000, now: () => clock })
    health.recordFailure(A.id)
    expect(health.pick([A, B]).backend.id).toBe(B.id)
    clock += 60_001
    expect(health.isCooling(A.id)).toBe(false)
    expect(health.pick([A, B]).backend.id).toBe(A.id)
  })

  it('成功后清零：一次成功就恢复正常优先级', () => {
    const health = createBackendHealth({ failThreshold: 2 })
    health.recordFailure(A.id)
    health.recordSuccess(A.id)
    health.recordFailure(A.id)
    // 清零过，所以这次只是"第一次失败"，不该进入冷却。
    expect(health.isCooling(A.id)).toBe(false)
    expect(health.pick([A, B]).backend.id).toBe(A.id)
  })

  it('**全都冷却时仍然回第一个**（宁可试一下，也不要让用户完全发不出消息）', () => {
    const health = createBackendHealth({ failThreshold: 1 })
    health.recordFailure(A.id)
    health.recordFailure(B.id)
    const picked = health.pick([A, B])
    // 全坏的情况本来就无解，交给上游按时回错；"直接不许用"是更差的选择。
    expect(picked.backend.id).toBe(A.id)
  })

  it('后端之间互不影响（A 的失败不该让 B 也冷却）', () => {
    const health = createBackendHealth({ failThreshold: 1 })
    health.recordFailure(A.id)
    expect(health.isCooling(A.id)).toBe(true)
    expect(health.isCooling(B.id)).toBe(false)
  })

  it('按后端标识区分而不是按数组下标（同一后端换位置也认得）', () => {
    const health = createBackendHealth({ failThreshold: 1 })
    health.recordFailure(A.id)
    // 顺序反过来，A 仍然应当被跳过。
    expect(health.pick([B, A]).backend.id).toBe(B.id)
  })
})

describe('端到端：主后端坏掉后，请求真的会落到备用后端', () => {
  /**
   * 这是"备用后端从未被执行"那处缺陷的**直接反证**。
   * 做法：两个后端分别指向两个本地服务——一个总是回 500（坏），一个正常回答（好）。
   * 主后端冷却之后，请求必须**落在好的那个**上。
   */
  it('主后端连续失败 → 后续请求走备用后端', async () => {
    const { createServer } = await import('node:http')
    const { createCreditLedger } = await import('../src/ledger.ts')
    const { createGateway } = await import('../src/service.ts')
    const { createRoutingConsole } = await import('../src/routing.ts')
    const { createBackendHealth } = await import('../src/backend-health.ts')

    /** 起一个本地上游：`broken` 为真时总回 500。 */
    async function upstream(broken: boolean): Promise<{ port: number; close: () => Promise<void> }> {
      const server = createServer((_request, response) => {
        if (broken) { response.writeHead(500, { 'content-type': 'application/json' }); response.end('{"error":"boom"}'); return }
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: '备用作答' } }] })}\n\n`)
        response.write(`data: ${JSON.stringify({ choices: [{ delta: {} }], usage: { prompt_tokens: 5, completion_tokens: 3 } })}\n\n`)
        response.write('data: [DONE]\n\n')
        response.end()
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('未能取得端口')
      return {
        port: address.port,
        close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }) }) },
      }
    }

    const bad = await upstream(true)
    const good = await upstream(false)
    try {
      const ledger = createCreditLedger()
      const routing = createRoutingConsole()
      routing.publish({ publishedName: '千手·迅捷', label: '千手·迅捷', tiers: ['basic', 'plus', 'max'], maxOutputTokens: 4096, order: 0, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
      // **绑两个后端**：主用 flash，备用用 qwen。这正是控制台里能配的东西。
      routing.bind({ publishedName: '千手·迅捷', backendKeys: ['flash', 'qwen'], effectiveFrom: 0, reason: '主备验证', operator: 'system', rolloutPercent: 100 })
      ledger.grant('acc', 'basic', 390)

      const health = createBackendHealth({ failThreshold: 1, cooldownMs: 60_000 })
      const gateway = createGateway({
        ledger, routing, tierOf: () => 'basic', backendHealth: health,
        // 按后端给不同端点：flash 指向坏的那个，qwen 指向好的那个。
        // 显式声明 `BackendModel`：不写就是隐式 `any`（`noImplicitAny` + `no-unsafe-member-access`）。
        forwardConfigFor: (backend: BackendModel) => ({
          baseUrl: backend.id === BACKENDS['flash']?.id ? `http://127.0.0.1:${bad.port}` : `http://127.0.0.1:${good.port}`,
          apiKey: () => 'k',
        }),
      } as never)

      /** 发一次，返回正文与失败分类。 */
      const send = async (index: number): Promise<{ text: string; fail: string | null }> => {
        let text = ''
        let fail: string | null = null
        await new Promise<void>((resolve) => {
          const handle = gateway.chat(
            { callId: `c-${index}`, accountId: 'acc', publishedName: '千手·迅捷', messages: [{ role: 'user', content: '你好' }] },
            {
              onDelta: (value) => { text += value },
              onDone: () => { resolve() },
              onError: (value) => { fail = value.kind; resolve() },
            },
          )
          void handle.completed
        })
        return { text, fail }
      }

      const first = await send(1)
      // 第一次：主后端是坏的，用户确实吃到这一次失败——这是"不做请求内重试"的代价
      // （重试会让两家输出拼在一起，还可能双重计费）。
      expect(first.text).toBe('')
      expect(first.fail).not.toBeNull()
      expect(health.isCooling(BACKENDS['flash']?.id ?? '')).toBe(true)

      const second = await send(2)
      // 第二次：**备用后端真的被用上了**。修复前这里会一直失败。
      expect(second.text).toBe('备用作答')
      expect(second.fail).toBeNull()
    } finally {
      await bad.close()
      await good.close()
    }
  })
})
