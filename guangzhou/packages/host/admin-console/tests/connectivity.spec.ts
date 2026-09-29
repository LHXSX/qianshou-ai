/**
 * 连通性测试的判定逻辑：**逐条钉住每一种失效模式**。
 *
 * 为什么这些用例必须存在（而不能"跑一遍看看"）：这里的分类直接决定管理员下一步
 * 做什么。把"上游 5xx"误判成"密钥无效"，管理员会去换一把本来没问题的密钥，
 * 而真正的问题（上游/链路）被掩盖 —— 那比不做测试更糟。
 *
 * 所有用例都**注入 fetch**：测试绝不拿真密钥发请求，也不把成败绑在上游可用性上。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  PROBE_TARGETS,
  classifyProbeResponse,
  probeUpstreamKey,
  type ProbeDeps,
} from '../src/connectivity.ts'

/** 记录每次调用，按顺序给出响应。 */
function fetchSequence(responses: readonly (() => Promise<Response>)[]): { readonly fetch: typeof fetch; readonly calls: number[] } {
  const calls: number[] = []
  const fetchImpl = (async () => {
    const index = calls.length
    calls.push(index)
    const next = responses[Math.min(index, responses.length - 1)]
    return await (next as () => Promise<Response>)()
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

/** 测试用依赖：不真的睡、不真的打网络。 */
function deps(overrides: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    sleep: async () => { /* 不睡 */ },
    now: () => 0,
    ...overrides,
  }
}

/** 明显的假密钥：一眼能看出不是真值。 */
const FAKE_KEY = 'sk-invalid-for-test'

describe('响应分类：确定性失败与"无法确认"必须分开', () => {
  it('2xx → 通过，并带上往返延迟与上游回的模型名', () => {
    const verdict = classifyProbeResponse(200, JSON.stringify({ model: 'deepseek-chat', choices: [] }))
    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.model).toBe('deepseek-chat')
  })

  it('2xx 但正文不是 JSON 仍然算通过（上游可用性不取决于正文形状）', () => {
    const verdict = classifyProbeResponse(200, 'not json at all')
    expect(verdict.ok).toBe(true)
    expect(verdict.ok && verdict.model).toBeNull()
  })

  it('401 / 403 → 密钥被拒（确定性失败，不该写入）', () => {
    for (const status of [401, 403]) {
      const verdict = classifyProbeResponse(status, JSON.stringify({ error: { message: 'Authentication Fails' } }))
      expect(verdict.ok).toBe(false)
      expect(!verdict.ok && verdict.kind).toBe('credential_rejected')
      expect(!verdict.ok && verdict.message).toContain('Authentication Fails')
    }
  })

  it('429 → 限流，**必须说明这不能证明密钥无效**', () => {
    const verdict = classifyProbeResponse(429, '{"error":{"message":"rate limit"}}')
    expect(!verdict.ok && verdict.kind).toBe('rate_limited')
    expect(!verdict.ok && verdict.message).toMatch(/不能证明/)
  })

  it('500 / 502 / 503 → 上游不可用，**必须说明这不是密钥的问题**', () => {
    for (const status of [500, 502, 503]) {
      const verdict = classifyProbeResponse(status, '')
      expect(!verdict.ok && verdict.kind).toBe('upstream_unavailable')
      expect(!verdict.ok && verdict.message).toMatch(/不能证明/)
    }
  })

  it('400 / 404 → 探测目标配置可能过期（暴露出来，不假装密钥没问题）', () => {
    const verdict = classifyProbeResponse(404, '{"error":{"message":"model not found"}}')
    expect(!verdict.ok && verdict.kind).toBe('upstream_unavailable')
    expect(!verdict.ok && verdict.message).toMatch(/配置可能已过期/)
  })

  it('错误正文里没有可用信息时不硬凑原因', () => {
    const verdict = classifyProbeResponse(401, '')
    expect(!verdict.ok && verdict.message).toContain('HTTP 401')
    expect(!verdict.ok && verdict.message).not.toContain('：')
  })
})

describe('探测：只重试"无法确认"的那几类', () => {
  it('401 不重试（确定性结论，重试只是让管理员多等）', async () => {
    const { fetch: fetchImpl, calls } = fetchSequence([async () => new Response('{"error":{"message":"bad key"}}', { status: 401 })])
    const result = await probeUpstreamKey('DEEPSEEK_API_KEY', FAKE_KEY, deps({ fetch: fetchImpl }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('credential_rejected')
    expect(calls.length).toBe(1)
  })

  it('500 重试一次（上游抖动不该让管理员以为密钥坏了）', async () => {
    const { fetch: fetchImpl, calls } = fetchSequence([
      async () => new Response('boom', { status: 500 }),
      async () => new Response('{"model":"deepseek-chat"}', { status: 200 }),
    ])
    const result = await probeUpstreamKey('DEEPSEEK_API_KEY', 'sk-whatever', deps({ fetch: fetchImpl }))
    expect(result.ok).toBe(true)
    expect(calls.length).toBe(2)
  })

  it('两次都 500 就如实回上游不可用', async () => {
    const { fetch: fetchImpl, calls } = fetchSequence([
      async () => new Response('boom', { status: 503 }),
      async () => new Response('boom', { status: 503 }),
    ])
    const result = await probeUpstreamKey('DEEPSEEK_API_KEY', 'sk-whatever', deps({ fetch: fetchImpl }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('upstream_unavailable')
    expect(calls.length).toBe(2)
  })

  it('网络层失败（DNS/连不上）→ network_error，且不声称密钥无效', async () => {
    const { fetch: fetchImpl, calls } = fetchSequence([
      async () => { throw new TypeError('fetch failed') },
      async () => { throw new TypeError('fetch failed') },
    ])
    const result = await probeUpstreamKey('DEEPSEEK_API_KEY', 'sk-whatever', deps({ fetch: fetchImpl }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('network_error')
    expect(!result.ok && result.message).toMatch(/不能证明/)
    expect(calls.length).toBe(2)
  })

  it('超时 → upstream_unavailable，并说明是链路问题', async () => {
    const fetchImpl = (async () => {
      throw Object.assign(new Error('timed out'), { name: 'TimeoutError' })
    }) as typeof fetch
    const result = await probeUpstreamKey('DEEPSEEK_API_KEY', 'sk-whatever', deps({ fetch: fetchImpl, timeoutMs: 1234 }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('upstream_unavailable')
    expect(!result.ok && result.message).toContain('1234')
  })

  it('没配置探测目标的引用 → 明确说"不知道打哪里"，不去猜一个地址', async () => {
    const spy = vi.fn()
    const result = await probeUpstreamKey('SOME_OTHER_KEY', 'sk-whatever', deps({ fetch: spy as unknown as typeof fetch }))
    expect(result.ok).toBe(false)
    expect(!result.ok && result.kind).toBe('probe_not_configured')
    expect(spy).not.toHaveBeenCalled()
  })

  it('请求体与请求头正确：Bearer 携带候选密钥、max_tokens 极小（近零成本）', async () => {
    let seenUrl = ''
    let seenInit: RequestInit | undefined
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seenUrl = url
      seenInit = init
      return new Response('{"model":"deepseek-chat"}', { status: 200 })
    }) as unknown as typeof fetch
    await probeUpstreamKey('DEEPSEEK_API_KEY', FAKE_KEY, deps({ fetch: fetchImpl }))
    expect(seenUrl).toBe('https://api.deepseek.com/v1/chat/completions')
    const headers = seenInit?.headers as Record<string, string>
    expect(headers['authorization']).toBe(`Bearer ${FAKE_KEY}`)
    const body = JSON.parse(String(seenInit?.body)) as Record<string, unknown>
    expect(body['max_tokens']).toBe(1)
    expect(body['model']).toBe('deepseek-chat')
    expect(body['stream']).toBe(false)
  })

  it('内置探测目标表声明了 DEEPSEEK_API_KEY 的地址与"需重启"事实', () => {
    const target = PROBE_TARGETS['DEEPSEEK_API_KEY']
    expect(target?.baseUrl).toBe('https://api.deepseek.com/v1')
    expect(target?.model).toBe('deepseek-chat')
    // 网关成功值永久缓存 → 必须重启。这条是实测结论，写成断言防止被无声改掉。
    expect(target?.restartRequired).toBe(true)
    expect(target?.restartService).toBe('qianshou-workbench')
  })
})
