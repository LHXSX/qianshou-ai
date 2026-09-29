import { describe, expect, it } from 'vitest'
import { createWeChatLoginAdapter } from '../src/wechat-login.ts'

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}

describe('public WeChat login hand-off', () => {
  it('stays unavailable without public configuration and never needs an AppSecret', () => {
    const adapter = createWeChatLoginAdapter({ enabled: true, storage: storage() })
    expect(adapter.status()).toBe('unconfigured')
    expect(adapter.begin()).toEqual({ kind: 'unconfigured', reason: 'missing-config' })
  })

  it('creates a state and nonce, then only returns a server exchange ticket', () => {
    let clock = 1000; const store = storage(); let next = 0
    const adapter = createWeChatLoginAdapter({ enabled: true, appId: 'wx-public', authorizeEndpoint: 'https://open.weixin.qq.com/connect/qrconnect', redirectUri: 'https://mobile.example.test/auth/wechat/callback', storage: store, now: () => clock, randomToken: () => `token-${++next}` })
    const started = adapter.begin()
    expect(started.kind).toBe('started')
    if (started.kind !== 'started') throw new Error('expected started')
    expect(new URL(started.url).searchParams.get('appid')).toBe('wx-public')
    expect(adapter.status()).toBe('pending')
    expect(adapter.consumeCallback(new URLSearchParams({ state: 'wrong', code: 'code-1' })).kind).toBe('failed')
    const retry = adapter.begin(); if (retry.kind !== 'started') throw new Error('expected retry')
    const result = adapter.consumeCallback(new URLSearchParams({ state: retry.state, code: 'code-2' }))
    expect(result).toMatchObject({ kind: 'ready-for-server', code: 'code-2', nonce: 'token-4' })
    expect(adapter.status()).toBe('ready')
  })

  it('distinguishes cancellation and expiry', () => {
    let clock = 0; const adapter = createWeChatLoginAdapter({ enabled: true, appId: 'wx-public', authorizeEndpoint: 'https://open.weixin.qq.com/connect/qrconnect', redirectUri: 'https://mobile.example.test/auth/wechat/callback', storage: storage(), now: () => clock, randomToken: () => 'stable' , timeoutMs: 10 })
    adapter.begin(); expect(adapter.consumeCallback(new URLSearchParams({ error: 'access_denied' }))).toMatchObject({ kind: 'cancelled' })
    adapter.begin(); clock = 11; expect(adapter.consumeCallback(new URLSearchParams({ state: 'stable', code: 'code' }))).toMatchObject({ kind: 'timed-out' })
  })
})
