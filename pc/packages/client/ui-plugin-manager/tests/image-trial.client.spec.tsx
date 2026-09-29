// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { URL as NodeURL } from 'node:url'
import { createHash, webcrypto } from 'node:crypto'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ImageTrialCard } from '../src/client/ImageTrialCard.tsx'
import { ImageTrialProgress } from '../src/client/ImageTrialProgress.tsx'
import { createImageTrialSubmitter } from '../src/client/conversation-image-trial.tsx'
import { createMarketMentionSource } from '../src/client/market-mention-source.ts'
import { MarketCapabilitiesController } from '../src/client/market-capabilities-controller.ts'
import { createImageTrialStore, isImageTrialCall, recordImageTrialCall, type ImageTrialCall } from '../src/client/image-trial-store.ts'
import { ImageTrialHostError, createImageTrialTransport, imageTrialJob, imageTrialSize,
  type ImageTrialJob, type ImageTrialRequest, type ImageTrialTransport } from '../src/client/image-trial-transport.ts'
import { zh } from '../src/client/image-trial-locales.ts'

beforeEach(() => {
  localStorage.clear()
  URL.createObjectURL = vi.fn().mockReturnValue('blob:image-trial-result')
  URL.revokeObjectURL = vi.fn()
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const request: ImageTrialRequest = { id: 'c131c1ae-971d-494d-8060-b22c4778b8ee', sessionId: 'session-a',
  prompt: '一个外星人', size: 'landscape' }
const call: ImageTrialCall = { id: `image-trial-${request.id}`, sessionId: request.sessionId as SessionId,
  createdAt: '2026-09-29T00:00:00Z', prompt: request.prompt, size: request.size, request: null }
const idle = () => false
const t = (key: keyof typeof zh): string => zh[key]
function receipt(value: ImageTrialRequest, status: ImageTrialJob['status'] = 'completed'): ImageTrialJob {
  const dimensions = { landscape: [2048, 1152], portrait: [1152, 2048], square: [1024, 1024] }
  return { ...value, status, steps: 8, width: dimensions[value.size][0]!, height: dimensions[value.size][1]!, billing: 'research-no-charge',
    ...(status === 'completed' ? { result: { bytes: 4567, sha256: 'a'.repeat(64) } } : {}) }
}
function transport(): ImageTrialTransport {
  return { enabled: vi.fn().mockResolvedValue(true), start: vi.fn(async value => receipt(value)),
    read: vi.fn(async value => receipt(value)), image: vi.fn(async () => new Blob(['png'], { type: 'image/png' })) }
}

it.each([12, 20] as const)('binds %i-step Host receipts to the exact submitted preset', (steps) => {
  const input = { ...request, steps }
  const job = { ...receipt(input), steps }
  expect(imageTrialJob(job, input)).toEqual(job)
  expect(() => imageTrialJob({ ...job, steps: 8 }, input)).toThrow('IMAGE_TRIAL_INVALID_RESPONSE')
  expect(() => imageTrialJob(job, request)).toThrow('IMAGE_TRIAL_INVALID_RESPONSE')
})

it('delivers a complete independently encoded PNG for a twenty-step receipt', async () => {
  vi.stubGlobal('crypto', webcrypto)
  const png = readFileSync(new NodeURL('./fixtures/image-trial-1024.png', import.meta.url))
  const input: ImageTrialRequest = { ...request, size: 'square', steps: 20 }
  const job: ImageTrialJob = { ...input, status: 'completed', steps: 20, width: 1024, height: 1024,
    billing: 'research-no-charge', result: { bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') } }
  const remote = createImageTrialTransport('http://127.0.0.1/', vi.fn(async () => new Response(png,
    { headers: { 'content-type': 'image/png' } })))
  const image = await remote.image(job, new AbortController().signal)
  expect(image.size).toBe(png.length)
  expect(image.type).toBe('image/png')
  await expect(remote.image({ ...job, height: 2048 }, new AbortController().signal)).rejects.toThrow('IMAGE_TRIAL_IMAGE_INVALID')
})

it.each([
  [[8, 12, 20], [8, 12, 20]],
  [undefined, [8]],
  [[8, 12, 50], []],
  [[8, '12', 20], []],
  [[20, 12, 8], []],
] as const)('reads preset advertisement %j without accepting unexpected values', async (advertised, expected) => {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ enabled: true, steps: 8, billing: 'research-no-charge',
    ...(advertised === undefined ? {} : { supportedSteps: advertised }) }))
  const remote = createImageTrialTransport('http://127.0.0.1/', fetcher)
  expect(await remote.supportedSteps!(new AbortController().signal)).toEqual(expected)
  expect(fetcher.mock.calls[0]?.[1]?.method).toBe('GET')
})

it.each([
  ['IMAGE_TRIAL_OUTCOME_UNKNOWN', 'uncertain'],
  ['IMAGE_TRIAL_GATEWAY_UNAVAILABLE', 'gatewayUnavailable'],
] as const)('explains %s without restarting the saved request', async (errorCode, copyKey) => {
  const remote = transport()
  remote.read = vi.fn(async value => ({ ...receipt(value, 'failed'), errorCode }))
  render(<ImageTrialCard call={{ ...call, request }} transport={remote} isSubmitting={idle} t={t} />)
  expect((await screen.findByRole('alert')).textContent).toContain(zh[copyKey])
  expect(screen.queryByRole('progressbar')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(remote.read).toHaveBeenCalledTimes(2) })
  expect(remote.start).not.toHaveBeenCalled()
  expect(remote.image).not.toHaveBeenCalled()
})

it('explains interrupted delivery without asking the owner to generate again', async () => {
  const remote = transport()
  remote.read = vi.fn(async value => ({ ...receipt(value, 'failed'), errorCode: 'IMAGE_TRIAL_DELIVERY_UNAVAILABLE',
    timing: { submittedAt: '2026-09-29T00:00:00.000Z', phase: 'receiving' as const } }))
  render(<ImageTrialCard call={{ ...call, request }} transport={remote} isSubmitting={idle} t={t} />)
  expect((await screen.findByRole('alert')).textContent).toContain(zh.deliveryPending)
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(remote.read).toHaveBeenCalledTimes(2) })
  expect(remote.start).not.toHaveBeenCalled()
})

it('shows legacy drafts only as a resend instruction, without a form or automatic submission', () => {
  const remote = transport()
  const mounted = render(<ImageTrialCard call={call} transport={remote} isSubmitting={idle} t={t} />)
  expect(screen.getByText(zh.resend)).toBeTruthy()
  expect(mounted.container.querySelector('textarea, select, input, form')).toBeNull()
  expect(screen.queryByRole('button', { name: zh.start })).toBeNull()
  expect(remote.start).not.toHaveBeenCalled(); expect(remote.read).not.toHaveBeenCalled()
})
it('persists a request before explicit POST and reconciles after acceptance without an early GET', async () => {
  const remote = transport()
  let finishPost!: (job: ImageTrialJob) => void
  remote.start = vi.fn(() => new Promise<ImageTrialJob>((resolve) => { finishPost = resolve }))
  const saved: ImageTrialCall[] = []
  const submitter = createImageTrialSubmitter({ transport: remote,
    record: (value) => { saved.push(value); return true }, update: (value) => { saved.push(value) } })
  const submitted = submitter.submit({ sessionId: call.sessionId }, '外星人在红色沙漠，竖屏', 'portrait')
  const pending = saved[0]!
  expect(pending.request?.prompt).toBe('外星人在红色沙漠，竖屏')
  expect(remote.start).toHaveBeenCalledOnce()
  expect(vi.mocked(remote.start).mock.calls[0]?.[0]).toEqual(pending.request)
  expect(pending.submission).toBe('pending')
  const mounted = render(<ImageTrialCard call={pending} transport={remote} isSubmitting={submitter.isSubmitting} t={t} />)
  expect(remote.read).not.toHaveBeenCalled()
  await act(async () => { finishPost(receipt(pending.request!, 'running')); await submitted })
  const accepted = saved[1]!
  expect(accepted.request?.id).toBe(pending.request?.id)
  expect(accepted.submission).toBe('settled')
  mounted.rerender(<ImageTrialCard call={accepted} transport={remote} isSubmitting={submitter.isSubmitting} t={t} />)
  await screen.findByRole('img')
  expect(screen.getByText('图片已生成 · 1152 × 2048 · 8 步')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(vi.mocked(remote.read).mock.calls.length).toBeGreaterThanOrEqual(2) })
  expect(remote.start).toHaveBeenCalledOnce()
  expect(vi.mocked(remote.read).mock.calls.every(([value]) => value.id === pending.request?.id)).toBe(true)
  expect(mounted.container.querySelector('textarea, select, input, form')).toBeNull()
  submitter.dispose()
})
it('reads back the actual Session storage before posting and restores the same request after reload', async () => {
  const instance = createImageTrialStore().create(call.sessionId)
  const remote = transport()
  remote.start = vi.fn(async (value) => {
    const persisted = JSON.parse(localStorage.getItem(`qianshou.image-trials.${call.sessionId}`)!) as { calls: ImageTrialCall[] }
    expect(persisted.calls[0]?.request).toEqual(value)
    return receipt(value)
  })
  const submitter = createImageTrialSubmitter({ transport: remote,
    record: value => recordImageTrialCall(instance.actions, value), update: instance.actions.save })
  expect(await submitter.submit({ sessionId: call.sessionId }, call.prompt, call.size)).toBe(true)
  const restored = createImageTrialStore().create(call.sessionId).getSnapshot().calls[0]!
  expect(restored.request).toEqual(vi.mocked(remote.start).mock.calls[0]?.[0])
  render(<ImageTrialCard call={restored} transport={remote} isSubmitting={idle} t={t} />)
  await screen.findByRole('img')
  expect(remote.start).toHaveBeenCalledOnce()
  submitter.dispose()
})
it.each(['write', 'read', 'wrong-session'] as const)('does not POST when persistence fails through %s', async (failure) => {
  const instance = createImageTrialStore().create(call.sessionId)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  if (failure === 'write') vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  if (failure === 'read') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
  if (failure === 'wrong-session') vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(JSON.stringify({ calls: [{ ...call, request, sessionId: 'other' }] }))
  const remote = transport()
  const submitter = createImageTrialSubmitter({ transport: remote,
    record: value => recordImageTrialCall(instance.actions, value), update: instance.actions.save })
  expect(await submitter.submit({ sessionId: call.sessionId }, call.prompt, call.size)).toBe(false)
  expect(remote.start).not.toHaveBeenCalled()
  expect(instance.getSnapshot().calls).toEqual([])
  submitter.dispose()
})
it('one explicit composer claim joins double submission while a fresh message may submit another job', async () => {
  const remote = transport()
  const recorded: ImageTrialCall[] = []
  const submitter = createImageTrialSubmitter({ transport: remote,
    record: (value) => { recorded.push(value); return true }, update: vi.fn() })
  const capabilities = new MarketCapabilitiesController({
    orderAdapterCapabilities: vi.fn().mockResolvedValue({ ok: true, value: { capabilities: [] } }),
  })
  const source = createMarketMentionSource({ capabilities, callingMode: () => true, callCapability: vi.fn(),
    imageTrial: { enabled: remote.enabled, open: submitter.submit, text: t } })
  const session = { sessionId: call.sessionId } as Parameters<typeof source.candidates>[0]
  const picked = source.matchSpace?.(session, '@出图')
  if (typeof picked !== 'object' || picked === null || !('claim' in picked)) throw new Error('expected claim')
  await Promise.all([picked.claim.submit('外星人，方图', {} as never, []), picked.claim.submit('外星人，方图', {} as never, [])])
  await picked.claim.submit('外星人，方图', {} as never, [])
  expect(remote.start).toHaveBeenCalledOnce()
  expect(recorded[0]?.request).toMatchObject({ prompt: '外星人，方图', size: 'square' })
  const next = source.matchSpace?.(session, '@出图')
  if (typeof next !== 'object' || next === null || !('claim' in next)) throw new Error('expected claim')
  await next.claim.submit('外星人，方图', {} as never, [])
  expect(remote.start).toHaveBeenCalledTimes(2)
  expect(recorded[0]?.request?.id).not.toBe(recorded[1]?.request?.id)
  capabilities.dispose(); submitter.dispose()
})
it('rejects conflicting orientations in the composer without sending or expanding the prompt', async () => {
  const open = vi.fn()
  const capabilities = new MarketCapabilitiesController({
    orderAdapterCapabilities: vi.fn().mockResolvedValue({ ok: true, value: { capabilities: [] } }),
  })
  const source = createMarketMentionSource({ capabilities, callingMode: () => true, callCapability: vi.fn(),
    imageTrial: { enabled: async () => true, open, text: t } })
  const session = { sessionId: call.sessionId } as Parameters<typeof source.candidates>[0]
  const picked = source.matchSpace?.(session, '@出图')
  if (typeof picked !== 'object' || picked === null || !('claim' in picked)) throw new Error('expected claim')
  expect(await picked.claim.submit('横屏或竖屏的外星人', {} as never, [])).toEqual({ kind: 'error', text: zh.sizeConflict })
  expect(open).not.toHaveBeenCalled()
  expect(imageTrialSize('外星人')).toBe('landscape')
  expect(imageTrialSize('外星人，竖屏')).toBe('portrait')
  expect(imageTrialSize('外星人，方图')).toBe('square')
  capabilities.dispose()
})
it('restores pending or completed references using GET only and revokes preview URLs', async () => {
  const remote = transport()
  const mounted = render(<ImageTrialCard call={{ ...call, request, submission: 'pending' }} transport={remote} isSubmitting={idle} t={t} />)
  await screen.findByRole('img')
  expect(remote.read).toHaveBeenCalledWith(request, expect.any(AbortSignal))
  expect(remote.start).not.toHaveBeenCalled()
  expect(screen.getByRole('link', { name: zh.download }).getAttribute('download')).toMatch(/\.png$/u)
  mounted.unmount()
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:image-trial-result')
})
it.each([['IMAGE_TRIAL_BUSY', 409, 'busy'], ['IMAGE_TRIAL_CREDENTIAL_UNAVAILABLE', 503, 'credential']] as const)(
  'records explicit rejection %s as inline resend guidance without an unknown job', async (code, status, rejection) => {
    const remote = transport(); remote.start = vi.fn().mockRejectedValue(new ImageTrialHostError(code, status))
    let result!: ImageTrialCall
    const submitter = createImageTrialSubmitter({ transport: remote, record: () => true, update: (value) => { result = value } })
    await submitter.submit({ sessionId: call.sessionId }, call.prompt, call.size)
    expect(result.request).toBeNull(); expect(result.rejection).toBe(rejection)
    render(<ImageTrialCard call={result} transport={remote} isSubmitting={idle} t={t} />)
    expect(screen.getByText(zh[rejection])).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull(); expect(remote.read).not.toHaveBeenCalled()
    expect(remote.start).toHaveBeenCalledOnce(); submitter.dispose()
  })
it.each([
  new ImageTrialHostError('IMAGE_TRIAL_ID_CONFLICT', 409), new ImageTrialHostError('IMAGE_TRIAL_BUSY', 502),
  new ImageTrialHostError('IMAGE_TRIAL_REQUEST_FAILED', 502), new SyntaxError('unparseable response'), new TypeError('network interrupted'),
])('retains the same request for uncertain submission %s and only reconciles', async (failure) => {
  const remote = transport(); remote.start = vi.fn().mockRejectedValue(failure)
  remote.read = vi.fn().mockRejectedValue(new ImageTrialHostError('IMAGE_TRIAL_NOT_FOUND', 404))
  let result!: ImageTrialCall
  const submitter = createImageTrialSubmitter({ transport: remote, record: () => true, update: (value) => { result = value } })
  await submitter.submit({ sessionId: call.sessionId }, call.prompt, call.size)
  expect(result.request).not.toBeNull()
  render(<ImageTrialCard call={result} transport={remote} isSubmitting={idle} t={t} />)
  await screen.findByText(zh.uncertain)
  fireEvent.click(screen.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(vi.mocked(remote.read).mock.calls.length).toBeGreaterThanOrEqual(2) })
  expect(remote.start).toHaveBeenCalledOnce()
  expect(vi.mocked(remote.read).mock.calls.every(([value]) => value.id === result.request?.id)).toBe(true)
  submitter.dispose()
})
it('rejects saved or returned jobs from another Session', () => {
  expect(isImageTrialCall({ ...call, request }, call.sessionId)).toBe(true)
  expect(isImageTrialCall({ ...call, request: { ...request, sessionId: 'session-b' } }, call.sessionId)).toBe(false)
  expect(isImageTrialCall(call, 'session-b' as SessionId)).toBe(false)
  expect(() => imageTrialJob({ ...receipt(request), sessionId: 'session-b' }, request)).toThrow('IMAGE_TRIAL_INVALID_RESPONSE')
})
it('checks explicit enablement and restricts all requests to the same-origin trial routes', async () => {
  const fetcher = vi.fn<typeof fetch>(async url => new Response(JSON.stringify(String(url).endsWith('/status')
    ? { enabled: true, sizes: ['square', 'landscape', 'portrait'], steps: 8, billing: 'research-no-charge' }
    : receipt(request)), { headers: { 'content-type': 'application/json' } }))
  const remote = createImageTrialTransport('dsh-app://app/', fetcher)
  expect(await remote.enabled()).toBe(true)
  await remote.start(request, new AbortController().signal); await remote.read(request, new AbortController().signal)
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual(['dsh-app://app/api/qianshou/compute/image-trial/status',
    'dsh-app://app/api/qianshou/compute/image-trial/jobs', `dsh-app://app/api/qianshou/compute/image-trial/job?id=${request.id}&sessionId=session-a`])
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', body: JSON.stringify(request) })
})
it('keeps missing or incomplete trial status disabled', async () => {
  expect(await createImageTrialTransport('http://127.0.0.1/', vi.fn().mockRejectedValue(new Error('offline'))).enabled()).toBe(false)
  expect(await createImageTrialTransport('http://127.0.0.1/', vi.fn(async () => Response.json({ enabled: true }))).enabled()).toBe(false)
})
it('fetches and verifies PNG bytes and rejects an altered image', async () => {
  const { webcrypto } = await import('node:crypto'); vi.stubGlobal('crypto', webcrypto)
  const bytes = new Uint8Array(32); bytes.set([137, 80, 78, 71, 13, 10, 26, 10])
  new DataView(bytes.buffer).setUint32(16, 2048); new DataView(bytes.buffer).setUint32(20, 1152)
  const sha = Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes)), value => value.toString(16).padStart(2, '0')).join('')
  const value = { ...receipt(request), result: { bytes: bytes.length, sha256: sha } }
  const fetcher = vi.fn<typeof fetch>(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))
  const remote = createImageTrialTransport('dsh-app://app/', fetcher)
  expect((await remote.image(value, new AbortController().signal)).size).toBe(32)
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(`dsh-app://app/api/qianshou/compute/image-trial/image?id=${request.id}&sessionId=session-a`)
  await expect(remote.image({ ...value, result: { bytes: bytes.length, sha256: 'f'.repeat(64) } }, new AbortController().signal)).rejects.toThrow('IMAGE_TRIAL_IMAGE_INVALID')
})
it.each([[409, 'IMAGE_TRIAL_BUSY', true], [503, 'IMAGE_TRIAL_CREDENTIAL_UNAVAILABLE', true],
  [409, 'IMAGE_TRIAL_ID_CONFLICT', false], [503, 'IMAGE_TRIAL_SOMETHING_NEW', false], [500, 'IMAGE_TRIAL_BUSY', false]] as const)(
  'preserves Host error %s %s with strict rejection classification', async (status, code, rejected) => {
    const remote = createImageTrialTransport('dsh-app://app/', vi.fn<typeof fetch>(async () => Response.json({ error: { code, message: code } }, { status })))
    const failure = await remote.start(request, new AbortController().signal).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ImageTrialHostError); expect(failure).toMatchObject({ code, status, rejectedBeforeAcceptance: rejected })
  })
it('shows observed generation and delivery stages without numeric progress or parameter forms', async () => {
  const remote = transport()
  const timing = { submittedAt: new Date(Date.now() - 65000).toISOString(), phase: 'generating' as const }
  remote.read = vi.fn().mockResolvedValue({ ...receipt(request, 'running'), timing })
  let finishImage!: (value: Blob) => void
  remote.image = vi.fn(() => new Promise<Blob>((resolve) => { finishImage = resolve }))
  const mounted = render(<ImageTrialCard call={{ ...call, request }} transport={remote} isSubmitting={idle} t={t} />)
  await screen.findByText(zh.phaseGenerating)
  expect(screen.getByText(zh.workerWorking)).toBeTruthy()
  expect(screen.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  expect(screen.getByText(/已用时间 · 1:0[56]/u)).toBeTruthy()
  expect(mounted.container.querySelector('textarea, select, input, form')).toBeNull()
  vi.mocked(remote.read).mockResolvedValue({ ...receipt(request, 'running'), timing: { ...timing, phase: 'receiving' } })
  fireEvent.click(screen.getByRole('button', { name: zh.refresh })); await screen.findByText(zh.phaseReceiving)
  vi.mocked(remote.read).mockResolvedValue({ ...receipt(request), timing: { ...timing, phase: 'receiving' } })
  fireEvent.click(screen.getByRole('button', { name: zh.refresh })); await screen.findByText(zh.imageLoading)
  expect(screen.queryByText(zh.workerWorking)).toBeNull()
  await act(async () => { finishImage(new Blob(['png'], { type: 'image/png' })) }); await screen.findByRole('img')
  expect(screen.queryByRole('progressbar')).toBeNull(); expect(remote.start).not.toHaveBeenCalled()
})
it('advances elapsed time from the Host timestamp and stops its timer on unmount', () => {
  vi.useFakeTimers()
  try {
    vi.setSystemTime(new Date('2026-09-29T01:02:10Z'))
    const mounted = render(<ImageTrialProgress phase="generating" submittedAt="2026-09-29T01:01:00Z" t={t} />)
    expect(screen.getByText('已用时间 · 1:10')).toBeTruthy()
    act(() => { vi.advanceTimersByTime(2000) }); expect(screen.getByText('已用时间 · 1:12')).toBeTruthy()
    mounted.unmount(); expect(vi.getTimerCount()).toBe(0)
  } finally { vi.useRealTimers() }
})
it('labels only observed waiting for legacy receipts and rejects invented phases', () => {
  render(<ImageTrialProgress phase="generating" t={t} />)
  expect(screen.getByText('本次查看已等待 · 0:00')).toBeTruthy()
  expect(imageTrialJob(receipt(request, 'running'), request).timing).toBeUndefined()
  const value = { ...receipt(request, 'running'), timing: { submittedAt: '2026-09-29T00:00:00.000Z', phase: 'generating' } }
  expect(imageTrialJob(value, request).timing).toEqual(value.timing)
  for (const timing of [null, { submittedAt: 'invalid', phase: 'generating' }, { submittedAt: value.timing.submittedAt, phase: 'sampling' }]) {
    expect(() => imageTrialJob({ ...value, timing }, request)).toThrow('IMAGE_TRIAL_INVALID_RESPONSE')
  }
})
