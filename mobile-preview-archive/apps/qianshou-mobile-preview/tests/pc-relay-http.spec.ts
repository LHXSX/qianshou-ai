import { describe, expect, it, vi } from 'vitest'
import { createMobilePcRelayPort } from '../src/pc-relay-http.ts'
import type { WindowBinding } from '@deepseek-ai/dsh-client-pc-window-bridge'

const binding: WindowBinding = { accountId: '42', pcId: 'pc-mac', sessionId: 'session-1' as WindowBinding['sessionId'], sourceDeviceId: 'phone-1' }

describe('formal mobile PC relay adapter', () => {
  it('wraps every pc-window call with the mapped worker and a fresh Bearer token', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      calls.push(init === undefined ? { url } : { url, init })
      const action = new URL(url, 'http://local').pathname.split('/').at(-1)
      const outer = JSON.parse(String(init?.body)) as { workerId: string; payload: Record<string, unknown> }
      expect(outer.workerId).toBe('worker-mac')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-1')
      expect(init?.credentials).toBe('omit')
      if (action === 'bootstrap') return Response.json({ binding, access: { state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] } })
      if (action === 'transcript') return Response.json({ binding, status: 'idle', turns: [{ id: 'turn-1', role: 'assistant', text: 'PC result', at: 1 }] })
      throw new Error(`unexpected action ${action}`)
    })
    const port = createMobilePcRelayPort({ workerId: 'worker-mac', accountId: '42', access: async () => 'access-1', fetch: fetcher })
    await expect(port.bootstrap('phone-1', new AbortController().signal, 'session-1')).resolves.toMatchObject({ binding, access: { state: 'online' } })
    await expect(port.transcript(binding, new AbortController().signal)).resolves.toMatchObject({ binding, turns: [{ text: 'PC result' }] })
    expect(calls).toHaveLength(2)
    expect(calls.every(call => call.url === '/api/qianshou/mobile-pc/v1/bootstrap' || call.url === '/api/qianshou/mobile-pc/v1/transcript')).toBe(true)
  })

  it('refuses an empty access token before making a relay request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const port = createMobilePcRelayPort({ workerId: 'worker-mac', accountId: '42', access: async () => null, fetch: fetcher })
    await expect(port.bootstrap('phone-1', new AbortController().signal)).rejects.toThrow('PC_WINDOW_TRANSPORT_FAILED')
    expect(fetcher).not.toHaveBeenCalled()
  })
})
