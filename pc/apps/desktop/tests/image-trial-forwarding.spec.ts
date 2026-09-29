import { createHash } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { forwardWebRequest } from '../src/web-document.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('forwards the image trial routes with shell-owned authentication and preserves JSON and PNG bytes', async () => {
  const id = 'c131c1ae-971d-494d-8060-b22c4778b8ee'
  const sessionId = 'carrier-session'
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1])
  const digest = createHash('sha256').update(png).digest('hex')
  const request = { id, sessionId, prompt: '外星人，横屏', size: 'landscape' }
  const job = { ...request, status: 'completed', steps: 8, width: 2048, height: 1152,
    billing: 'research-no-charge', result: { bytes: png.length, sha256: digest } }
  const host = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    expect(url.origin).toBe('http://127.0.0.1:19387')
    expect(url.searchParams.has('token')).toBe(false)
    expect(new Headers(init?.headers).get('cookie')).toBe('session=shell-owned')
    expect(new Headers(init?.headers).get('origin')).toBeNull()
    if (url.pathname.endsWith('/jobs')) {
      expect(init?.method).toBe('POST')
      expect(await new Response(init?.body).json()).toEqual(request)
      return Response.json(job, { status: 202 })
    }
    expect(init?.method).toBe('GET')
    expect(url.searchParams.get('id')).toBe(id)
    expect(url.searchParams.get('sessionId')).toBe(sessionId)
    if (url.pathname.endsWith('/job')) return Response.json(job)
    expect(url.pathname).toBe('/api/qianshou/compute/image-trial/image')
    return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length),
      'content-encoding': 'gzip', 'set-cookie': 'private' } })
  })
  vi.stubGlobal('fetch', host)
  const query = new URLSearchParams({ id, sessionId })
  const forward = (suffix: string, init?: RequestInit) => forwardWebRequest(
    new Request(`dsh-app://app/api/qianshou/compute/image-trial/${suffix}`, {
      ...init, headers: { origin: 'dsh-app://app', 'content-type': 'application/json' },
    }), 'http://127.0.0.1:19387/?token=shell-owned', 'session=shell-owned')
  const submitted = await forward('jobs', { method: 'POST', body: JSON.stringify(request) })
  expect(submitted.status).toBe(202)
  expect(await submitted.json()).toEqual(job)
  const restored = await forward(`job?${query}`)
  expect(restored.status).toBe(200)
  expect(await restored.json()).toEqual(job)
  const image = await forward(`image?${query}`)
  expect(image.headers.get('content-type')).toBe('image/png')
  expect(image.headers.get('content-length')).toBeNull()
  expect(image.headers.get('content-encoding')).toBeNull()
  expect(image.headers.get('set-cookie')).toBeNull()
  const bytes = new Uint8Array(await image.arrayBuffer())
  expect(bytes).toEqual(png)
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(digest)
  expect(host).toHaveBeenCalledTimes(3)
})
