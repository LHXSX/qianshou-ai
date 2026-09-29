// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ImageTrialCard } from '../src/client/ImageTrialCard.tsx'
import { createImageTrialTransport, type ImageTrialJob, type ImageTrialRequest } from '../src/client/image-trial-transport.ts'
import { zh } from '../src/client/image-trial-locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const request: ImageTrialRequest = { id: 'c131c1ae-971d-494d-8060-b22c4778b8ee',
  sessionId: 'carrier-session', prompt: '外星人，横屏', size: 'landscape' }
const png = new Uint8Array(24)
png.set([137, 80, 78, 71, 13, 10, 26, 10])
new DataView(png.buffer).setUint32(16, 2048)
new DataView(png.buffer).setUint32(20, 1152)
const job: ImageTrialJob = { ...request, status: 'completed', steps: 8, width: 2048, height: 1152,
  billing: 'research-no-charge', timing: { submittedAt: '2026-09-29T00:00:00.123Z', phase: 'receiving' },
  result: { bytes: png.byteLength, sha256: createHash('sha256').update(png).digest('hex') } }
it('keeps image requests on the desktop origin and verifies an original PNG without content-length', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const carrier = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    expect(url.protocol).toBe('dsh-app:')
    expect(url.hostname).toBe('app')
    expect(url.searchParams.has('token')).toBe(false)
    if (url.pathname.endsWith('/status')) return Response.json({ enabled: true,
      sizes: ['square', 'landscape', 'portrait'], steps: 8, billing: 'research-no-charge' })
    if (url.pathname.endsWith('/jobs')) return Response.json(job, { status: 202 })
    expect(url.searchParams.get('id')).toBe(request.id)
    expect(url.searchParams.get('sessionId')).toBe(request.sessionId)
    if (url.pathname.endsWith('/job')) return Response.json(job)
    return new Response(png.buffer, { headers: { 'content-type': 'image/png' } })
  })
  const transport = createImageTrialTransport('dsh-app://app/', carrier)
  const signal = new AbortController().signal
  expect(await transport.enabled(signal)).toBe(true)
  expect(await transport.start(request, signal)).toEqual(job)
  expect(await transport.read(request, signal)).toEqual(job)
  const image = await transport.image(job, signal)
  expect(image.type).toBe('image/png')
  expect(image.size).toBe(png.length)
  expect(carrier.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'POST', 'GET', 'GET'])
  for (const [input, init] of carrier.mock.calls) {
    const url = new URL(input instanceof Request ? input.url : input)
    expect(url.origin).toBe('null')
    expect(url.href).toMatch(/^dsh-app:\/\/app\/api\//u)
    expect(new Headers(init?.headers).has('cookie')).toBe(false)
    expect(new Headers(init?.headers).has('authorization')).toBe(false)
  }
})

it.each([
  ['content-type', () => new Response('<html>unrelated page</html>', { headers: { 'content-type': 'text/html' } })],
  ['receipt-session', () => Response.json({ ...job, sessionId: 'different-session' })],
  ['receipt-input', () => Response.json({ ...job, prompt: 'different-private-input' })],
  ['receipt-profile', () => Response.json({ ...job, steps: 4 })],
  ['receipt-result', () => Response.json({ ...job, result: null })],
] as const)('rejects a 200 response with %s diagnostics while preserving the exact saved request', async (diagnostic, reply) => {
  const carrier = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    expect(init?.method).toBe('GET')
    if (url.pathname.endsWith('/status')) {
      expect(url.search).toBe('')
      return Response.json({ enabled: true, steps: 8, supportedSteps: [8, 12, 20], billing: 'research-no-charge' })
    }
    expect(url.pathname).toBe('/api/qianshou/compute/image-trial/job')
    expect([...url.searchParams]).toEqual([['id', request.id], ['sessionId', request.sessionId]])
    return reply()
  })
  const transport = createImageTrialTransport('dsh-app://app/', carrier)
  const view = render(<ImageTrialCard call={{ id: `image-trial-${request.id}`,
    sessionId: request.sessionId as SessionId, createdAt: '2026-09-29T00:00:00Z',
    prompt: request.prompt, size: request.size, request, submission: 'settled' }}
  transport={transport} isSubmitting={() => false} t={key => zh[key]} />)
  expect((await screen.findByRole('alert')).textContent).toBe(zh.uncertain)
  expect(view.container.querySelector('[data-image-trial-read-error]')?.getAttribute('data-image-trial-read-error'))
    .toBe(diagnostic)
  expect(view.container.innerHTML).not.toContain('different-private-input')
  expect(carrier.mock.calls.map(([, init]) => init?.method)).toEqual(['GET', 'GET'])
  expect(carrier.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input).pathname))
    .toEqual(['/api/qianshou/compute/image-trial/status', '/api/qianshou/compute/image-trial/job'])
  expect(screen.queryByRole('img')).toBeNull()
})

it('restores a twenty-step image with status and original UUID delivery reads, without any POST', async () => {
  const bytes = readFileSync(new NodeURL('./fixtures/image-trial-1024.png', import.meta.url))
  const original: ImageTrialRequest = { ...request, size: 'square', steps: 20 }
  const completed: ImageTrialJob = { ...original, status: 'completed', steps: 20, width: 1024, height: 1024,
    billing: 'research-no-charge', result: { bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') } }
  vi.stubGlobal('crypto', webcrypto)
  const NativeURL = URL
  vi.stubGlobal('URL', class extends NativeURL {
    static override createObjectURL(): string { return 'blob:carrier-restored-image' }
    static override revokeObjectURL(): void { /* The fixture creates no native object URL. */ }
  })
  const carrier = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    expect(init?.method).toBe('GET')
    expect(url.protocol).toBe('dsh-app:')
    expect(url.hostname).toBe('app')
    if (url.pathname.endsWith('/status')) {
      expect(url.search).toBe('')
      return Response.json({ enabled: true, steps: 8, supportedSteps: [8, 12, 20], billing: 'research-no-charge' })
    }
    expect([...url.searchParams]).toEqual([['id', original.id], ['sessionId', original.sessionId]])
    if (url.pathname.endsWith('/job')) return Response.json(completed)
    expect(url.pathname).toBe('/api/qianshou/compute/image-trial/image')
    return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'image/png' } })
  })
  const transport = createImageTrialTransport('dsh-app://app/', carrier)
  render(<ImageTrialCard call={{ id: `image-trial-${original.id}`, sessionId: original.sessionId as SessionId,
    createdAt: '2026-09-29T00:00:00Z', prompt: original.prompt, size: original.size, steps: 20,
    request: original, submission: 'settled' }} transport={transport} isSubmitting={() => false} t={key => zh[key]} />)
  expect((await screen.findByRole('img')).getAttribute('src')).toBe('blob:carrier-restored-image')
  expect(screen.queryByRole('alert')).toBeNull()
  expect(carrier.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input).pathname))
    .toEqual(['/api/qianshou/compute/image-trial/status', '/api/qianshou/compute/image-trial/job', '/api/qianshou/compute/image-trial/image'])
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(carrier).toHaveBeenCalledTimes(5) })
  await screen.findByRole('img')
  expect(carrier.mock.calls.map(([input]) => new URL(input instanceof Request ? input.url : input).pathname))
    .toEqual(['/api/qianshou/compute/image-trial/status', '/api/qianshou/compute/image-trial/job', '/api/qianshou/compute/image-trial/image',
      '/api/qianshou/compute/image-trial/job', '/api/qianshou/compute/image-trial/image'])
  expect(carrier.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
})
