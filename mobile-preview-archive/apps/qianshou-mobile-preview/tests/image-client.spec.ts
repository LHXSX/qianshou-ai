import { describe, expect, it, vi } from 'vitest'
import { createImageGenerationClient, ImageGenerationError } from '../src/image-client.ts'

const signal = new AbortController().signal

function client(fetchImpl: typeof fetch = vi.fn(async () => Response.json({
  model: '千手·绘画',
  data: [{ b64_json: 'AAAB', revised_prompt: '一只猫' }],
  qianshou: { request_id: 'r1', mime_type: 'image/jpeg', elapsed_ms: 1200 },
  qianshou_gateway: { metering: { priced: false, note: '未定价' } },
}))) {
  return createImageGenerationClient({ fetch: fetchImpl, accountId: () => 'acct-1', access: async () => 'access-token' })
}

describe('authenticated mobile image client', () => {
  it('sends original bytes to edits once and never silently falls back to generation', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { code: 'edit_unavailable', message: '修图服务暂不可用。' } }, { status: 503 }))
    const original = 'data:image/png;base64,iVBORw0KGgo='
    await expect(client(fetchImpl).edit({ model: '千手·绘画', prompt: '背景变蓝', image: original }, signal))
      .rejects.toMatchObject({ code: 'edit_unavailable', status: 503 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/qianshou/ai/images/edits')
    expect(JSON.parse(String(init.body))).toMatchObject({ image: original, prompt: '背景变蓝', n: 1 })
  })

  it('rejects remote URLs and local paths instead of asking a server to fetch them', async () => {
    const fetchImpl = vi.fn()
    for (const image of ['https://example.com/private.png', '/tmp/private.png', 'file:///private.png']) {
      await expect(client(fetchImpl).edit({ model: '千手·绘画', prompt: '背景变蓝', image }, signal))
        .rejects.toMatchObject({ code: 'invalid-image' })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('emits queue and processing states, then decodes the gateway b64 result', async () => {
    const states: string[] = []
    const result = await client().generate({ model: '千手·绘画', prompt: '一只猫' }, signal, state => states.push(state.phase))
    expect(states).toEqual(['queued', 'processing', 'succeeded'])
    expect(result.images[0]?.dataUri).toBe('data:image/jpeg;base64,AAAB')
    expect(result.gateway?.metering?.priced).toBe(false)
  })

  it('does not retry or report success on a gateway error', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { code: 'model_not_allowed', message: '该模型暂不可用。' } }, { status: 403 }))
    const states: string[] = []
    await expect(client(fetchImpl).generate({ model: '千手·绘画', prompt: '一只猫' }, signal, state => states.push(state.phase)))
      .rejects.toMatchObject({ code: 'model_not_allowed', status: 403 })
    expect(states).toEqual(['queued', 'processing', 'failed'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('requires an account and never calls fetch without one', async () => {
    const fetchImpl = vi.fn()
    const image = createImageGenerationClient({ fetch: fetchImpl, accountId: () => null, access: async () => null })
    await expect(image.generate({ model: '千手·绘画', prompt: '猫' }, signal)).rejects.toBeInstanceOf(ImageGenerationError)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps a cookie-gate AUTH_REQUIRED body to a login-channel failure, not a pool failure', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: false, code: 'AUTH_REQUIRED' }, { status: 401 }))
    const states: string[] = []
    await expect(client(fetchImpl).generate({ model: '千手·绘画', prompt: '一只小狗' }, signal, state => states.push(state.phase)))
      .rejects.toMatchObject({ code: 'AUTH_REQUIRED', status: 401, message: '出图通道没有认到这次登录，图还没交到号池。' })
    expect(states).toEqual(['queued', 'processing', 'failed'])
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it.each([
    [402, 'no-credit'],
    [503, 'insufficient-balance'],
    [429, 'quota_exceeded'],
  ])('keeps a quota refusal explicit when the gateway omits a message: %s %s', async (status, code) => {
    const fetchImpl = vi.fn(async () => Response.json({ error: { code } }, { status }))
    await expect(client(fetchImpl).generate({ model: '千手·绘画', prompt: '一只小狗' }, signal))
      .rejects.toMatchObject({ code, status, message: '当前可用额度不足，请打开账户中心的「额度与订阅」充值或续订后再试。' })
  })
})
