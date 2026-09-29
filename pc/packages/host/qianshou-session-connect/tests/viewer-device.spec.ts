/** Unit: narrow viewer requests send X-Qianshou-Device only when a presentable id is given. */
import { afterEach, expect, it, vi } from 'vitest'
import { request } from '../src/viewer/protocol.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('sets X-Qianshou-Device and keeps credentials omit when a device id is present', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  await request('00000000-0000-4000-8000-000000000001.' + 'A'.repeat(43), 'read', { cursor: null },
    AbortSignal.timeout(5000), 'phone-device-a')
  expect(fetchMock).toHaveBeenCalledOnce()
  const init = fetchMock.mock.calls[0]?.[1]
  expect(init?.credentials).toBe('omit')
  const headers = init?.headers as Record<string, string> | undefined
  expect(headers?.['X-Qianshou-Device']).toBe('phone-device-a')
  expect(headers?.Authorization).toMatch(/^Bearer /u)
})

it('omits X-Qianshou-Device when no device id is given', async () => {
  const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
  vi.stubGlobal('fetch', fetchMock)
  await request('00000000-0000-4000-8000-000000000001.' + 'A'.repeat(43), 'read', { cursor: null },
    AbortSignal.timeout(5000))
  expect(fetchMock).toHaveBeenCalledOnce()
  const init = fetchMock.mock.calls[0]?.[1]
  expect(init?.credentials).toBe('omit')
  const headers = init?.headers as Record<string, string> | undefined
  expect(headers).not.toHaveProperty('X-Qianshou-Device')
})
