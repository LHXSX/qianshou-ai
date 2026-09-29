import { describe, expect, it } from 'vitest'
import { createAccountClient, createTokenStore, ENDPOINTS } from '../src/index.ts'
import { createFetchStub, memoryRefreshStore, tokenReply } from './fetch-stub.client.ts'

const baseUrl = 'https://accounts.test'
function setup(replies: Parameters<typeof createFetchStub>[0]) {
  const stub = createFetchStub(replies)
  const tokens = createTokenStore({ cookiesAvailable: false, refreshStore: memoryRefreshStore() })
  const client = createAccountClient({ baseUrl, fetch: stub.fetch, tokens })
  return { client, stub }
}

describe('Shanghai SMS authentication', () => {
  it('uses a purpose-bound send response before saying a code was sent', async () => {
    const h = setup([{ kind: 'json', body: { ok: true, phone: '138****8888', purpose: 'login', expires_in: 300, resend_after: 60 } }])
    expect(await h.client.sendSms({ phone: '13800138888', purpose: 'login' })).toEqual({
      phone: '138****8888', purpose: 'login', expiresIn: 300, resendAfter: 60,
    })
    expect(h.stub.last().url).toBe(`${baseUrl}/api/v8${ENDPOINTS.smsSend}`)
    expect(h.stub.last().json).toEqual({ phone: '13800138888', purpose: 'login' })
    const unavailable = setup([{ kind: 'json', status: 503, body: { ok: false, detail: 'SMS not configured' } }])
    await expect(unavailable.client.sendSms({ phone: '13800138888', purpose: 'login' })).rejects.toThrow('短信通道暂不可用')
  })

  it('stores real tokens and marks the same account session authenticated', async () => {
    const h = setup([tokenReply()])
    const result = await h.client.loginPhone({ phone: '13800138888', code: '123456', remember_me: false })
    expect(result.kind).toBe('tokens')
    expect(h.client.state()).toBe('authenticated')
    expect(h.stub.last().url).toBe(`${baseUrl}/api/v8${ENDPOINTS.loginPhone}`)
    expect(h.stub.last().json).toEqual({ phone: '13800138888', code: '123456', remember_me: false })
  })

  it('requires TOTP after a successful SMS first factor without storing tokens early', async () => {
    const h = setup([{ kind: 'json', body: { ok: true, two_factor_required: true, challenge_token: 'test-challenge',
      challenge_expires_in: 300, account_id: 42, available_methods: [{ method: 'totp' }], default_method: 'totp' } }, tokenReply()])
    const result = await h.client.loginPhone({ phone: '13800138888', code: '123456' })
    expect(result.kind).toBe('two-factor')
    expect(h.client.state()).not.toBe('authenticated')
    expect(h.client.tokens.readAccess()).toBe(null)
    if (result.kind !== 'two-factor') throw new Error('Expected TOTP')
    expect(result.challenge.available_methods).toEqual(['totp'])
    await h.client.loginTotp({ challenge_token: result.challenge.challenge_token, code: '654321' })
    expect(h.client.state()).toBe('authenticated')
    expect(h.stub.last().url).toBe(`${baseUrl}/api/v8${ENDPOINTS.loginTotp}`)
  })

  it('registers by phone and signs into only the server-returned identity', async () => {
    const h = setup([tokenReply()])
    await h.client.registerPhone({ phone: '13800138888', code: '123456', username: 'new-user', remember_me: false })
    expect(h.client.state()).toBe('authenticated')
    expect(h.stub.last().url).toBe(`${baseUrl}/api/v8${ENDPOINTS.registerPhone}`)
    expect(h.stub.last().json).toEqual({ phone: '13800138888', code: '123456', username: 'new-user', remember_me: false })
    const noTokens = setup([{ kind: 'json', body: { ok: true, account: { id: 42 } } }])
    await expect(noTokens.client.registerPhone({ phone: '13800138888', code: '123456' })).rejects.toThrow()
    expect(noTokens.client.state()).not.toBe('authenticated')
  })
})
