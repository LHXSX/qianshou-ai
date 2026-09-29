// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formalMediaIntent } from '../src/client/formal-media-intent.ts'
import { createFormalMediaTransport, FormalMediaHostError, type FormalMediaInput, type FormalMediaProfile, type FormalMediaQuote,
  type FormalMediaState } from '../src/client/formal-media-transport.ts'
import { FormalMediaCard } from '../src/client/FormalMediaCard.tsx'
import { createFormalMediaStore, isFormalMediaCall, persistFormalMediaCall, type FormalMediaCall } from '../src/client/formal-media-store.ts'
import { zh } from '../src/client/formal-media-locales.ts'
import { formalMediaAttachments } from '../src/client/formal-media-attachments.ts'

const reference = { requestId: '941c5482-910d-4100-817f-9c7d8fda415d', sessionId: 'formal-session' }
const profile: FormalMediaProfile = { profile_id: 'fixture.image.fast', profile_version: 1, capability: 'image', mode: 'text_to_image',
  quality: 'fast', orientation: 'landscape', width: 1024, height: 768, steps: 4, fps: null, allowed_seconds: [], input_roles: [], max_assets: 0, enabled: true }
const prompt = '极速横屏，一只猫在花园，保留这段原文'
const input: FormalMediaInput = { capability: 'image', mode: 'text_to_image', prompt, negative_prompt: '', quality: 'fast',
  orientation: 'landscape', seconds: null, assets: [], profile_id: profile.profile_id, profile_version: profile.profile_version }
const quote: FormalMediaQuote = { ...reference, input, quoteId: 'f91da330-0429-437d-872d-b76d075bbf6c',
  amountYuan: '2.00', currency: 'CNY', balanceEnough: true, expiresAt: new Date(Date.now() + 300000).toISOString() }
const call: FormalMediaCall = { ...reference, sessionId: reference.sessionId as SessionId, id: `formal-media-${reference.requestId}`,
  input, quote, createdAt: new Date().toISOString(), submission: 'quoted', taskId: null }
const state: FormalMediaState = { ...reference, taskId: 'fixture-task', attemptId: null, leaseEpoch: null, status: 'RUNNING',
  phase: 'running', progress: null, elapsedSeconds: 71, pollIntervalMs: 1500,
  resultMetadata: null, settlement: null, deliveryAvailable: false }
beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanup(); localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
function transport() {
  const requests: Array<{ path: string; method: string; body: unknown }> = []
  const fakeFetch = vi.fn<typeof fetch>(async (url, init) => {
    const parsed = new URL(url instanceof Request ? url.url : url)
    if (init?.body !== undefined && typeof init.body !== 'string') throw new Error('unexpected fixture request body')
    requests.push({ path: parsed.pathname, method: init?.method ?? 'GET',
      body: init?.body === undefined ? undefined : JSON.parse(init.body) as unknown })
    if (parsed.pathname.endsWith('/profiles')) return Response.json({ billing_status: 'ready', profiles: [profile] })
    if (parsed.pathname.endsWith('/quote')) return Response.json(quote)
    if (parsed.pathname.endsWith('/confirm')) return Response.json({ taskId: state.taskId, requestId: reference.requestId })
    if (parsed.pathname.endsWith('/state')) return Response.json(state)
    return new Response(null, { status: 404 })
  })
  return { remote: createFormalMediaTransport('http://local-host/', fakeFetch), requests, fakeFetch }
}
it.each([
  ['一只猫', 'missingQuality'], ['极速猫', 'missingOrientation'], ['极速标准横屏猫', 'conflict'],
  ['极速横屏竖屏猫', 'conflict'], ['高清横屏猫', 'profileUnavailable'],
])('keeps ambiguous or unavailable original parameters out of quotes: %s', (text, error) => {
  expect(formalMediaIntent('image', text, [profile])).toEqual({ error })
})
it('selects an exact official version and preserves the original prompt without deriving a tier or price', () => {
  expect(formalMediaIntent('image', prompt, [profile])).toEqual({ input })
  expect(formalMediaIntent('image', prompt, [profile, { ...profile, profile_version: 2 }])).toEqual({ error: 'profileUnavailable' })
  expect(formalMediaIntent('image', prompt, [])).toEqual({ error: 'profileUnavailable' })
})
it('uses the current official allowed video seconds and never fills in omitted seconds', () => {
  const video: FormalMediaProfile = { ...profile, profile_id: 'fixture.video.fast', capability: 'video', mode: 'text_to_video', fps: 24, allowed_seconds: [5] }
  expect(formalMediaIntent('video', '极速横屏外星人', [video])).toEqual({ error: 'missingSeconds' })
  expect(formalMediaIntent('video', '极速横屏5秒外星人', [video])).toMatchObject({ input: { seconds: 5, prompt: '极速横屏5秒外星人' } })
  expect(formalMediaIntent('video', '极速横屏10秒外星人', [video])).toEqual({ error: 'profileUnavailable' })
  expect(formalMediaIntent('video', '极速横屏5秒或10秒', [video])).toEqual({ error: 'conflict' })
})
it('quotes without a paid POST and retains the same confirmed submission promise', async () => {
  const fixture = transport(); const signal = new AbortController().signal
  expect(await fixture.remote.quote(reference, input, signal)).toEqual(quote)
  expect(fixture.requests.map(r => r.path)).toEqual(['/api/qianshou/compute/media/quote'])
  expect(fixture.requests[0]?.body).toEqual({ ...reference, input })
  const first = fixture.remote.confirm(quote, signal); const second = fixture.remote.confirm(quote, signal)
  expect(second).toBe(first)
  await expect(first).resolves.toEqual({ taskId: 'fixture-task', requestId: reference.requestId })
  expect(fixture.requests.filter(r => r.path.endsWith('/confirm'))).toHaveLength(1)
  expect(JSON.stringify(fixture.requests)).not.toMatch(/quote_token|viewerReceipt|Authorization/u)
})
it('mounts a quote with no submit or state query and requires a fresh owner button click', async () => {
  const fixture = transport(); const confirm = vi.fn(async () => true); const reQuote = vi.fn(async () => true)
  const ui = render(<FormalMediaCard call={call} transport={fixture.remote} onConfirm={confirm} onQuote={reQuote} t={key => zh[key]} />)
  expect(ui.getByText(prompt)).toBeTruthy()
  expect(ui.getByText('官方报价 · ¥2.00 · CNY')).toBeTruthy()
  expect(confirm).not.toHaveBeenCalled(); expect(fixture.requests).toHaveLength(0)
  fireEvent.click(ui.getByRole('button', { name: zh.confirm }))
  await waitFor(() => { expect(confirm).toHaveBeenCalledTimes(1) })
  expect(confirm).toHaveBeenCalledWith(call)
})
it('cold-restores an uncertain task with GET only and leaves unknown progress without a fake percent', async () => {
  const fixture = transport(); const confirm = vi.fn(async () => true)
  const ui = render(<FormalMediaCard call={{ ...call, submission: 'uncertain' }} transport={fixture.remote}
    onConfirm={confirm} onQuote={async () => true} t={key => zh[key]} />)
  await waitFor(() => { expect(ui.getByText(zh.running)).toBeTruthy() })
  expect(ui.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  expect(ui.getByText('已等待 · 1:11')).toBeTruthy()
  fireEvent.click(ui.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(fixture.requests).toHaveLength(2) })
  expect(fixture.requests.every(r => r.method === 'GET' && r.path.endsWith('/state'))).toBe(true)
  expect(confirm).not.toHaveBeenCalled()
})
it('requires durable Session-local readback before storing a payment intent and rejects foreign Session records', () => {
  const instance = createFormalMediaStore().create(call.sessionId)
  expect(persistFormalMediaCall(instance.actions, call)).toBe(true)
  expect(isFormalMediaCall(call, 'other-session' as SessionId)).toBe(false)
  const uncertain = { ...call, submission: 'uncertain' as const }
  expect(persistFormalMediaCall(instance.actions, uncertain, true)).toBe(true)
  const raw = localStorage.getItem(`qianshou.formal-media-calls.${call.sessionId}`)
  expect(raw).toContain('uncertain')
  expect(raw).not.toMatch(/quote_token|viewerReceipt|base64/u)
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full') })
  expect(persistFormalMediaCall(instance.actions, { ...call, submission: 'submitted', taskId: 'fixture-task' }, true)).toBe(false)
})
it('mechanically hashes exact delivered bytes and uses a Host result query without credential or arbitrary URL', async () => {
  const bytes = Uint8Array.from([1, 2, 3])
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const resultRevision = 'f'.repeat(64)
  const ready: FormalMediaState = { ...state, status: 'DONE', phase: 'settled', deliveryAvailable: true,
    resultMetadata: { assetId: 'fixture-asset', sha256, sizeBytes: bytes.length, contentType: 'video/mp4', capability: 'video',
      width: 1344, height: 768, fpsNum: 24, fpsDen: 1, secondsMs: 5000, resultRevision },
    settlement: { settled: true, billableResultRevision: resultRevision, ledgerReceiptId: 'release:fixture-task' } }
  const fakeFetch = vi.fn<typeof fetch>(async () => new Response(bytes, { headers: { 'content-type': 'video/mp4',
    'content-length': String(bytes.length), 'x-qianshou-sha256': sha256 } }))
  const remote = createFormalMediaTransport('http://local-host/', fakeFetch)
  const blob = await remote.media(ready, new AbortController().signal)
  expect(blob.size).toBe(bytes.length)
  const requested = fakeFetch.mock.calls[0]?.[0]
  expect(requested instanceof URL ? requested.href : requested).toBe(
    `http://local-host/api/qianshou/compute/media/result?requestId=${reference.requestId}&sessionId=${reference.sessionId}`)
  fakeFetch.mockImplementation(async () => new Response(Uint8Array.from([1, 2, 4]), { headers: { 'content-type': 'video/mp4', 'x-qianshou-sha256': sha256 } }))
  await expect(remote.media(ready, new AbortController().signal)).rejects.toThrow('FORMAL_MEDIA_DELIVERY_INVALID')
})
it('parses a complete Chinese duration and refuses silently substituted steps, frame rate and missing last frame', () => {
  const video: FormalMediaProfile = { ...profile, capability: 'video', mode: 'text_to_video',
    profile_id: 'fixture.video.fast', width: 1344, fps: 24, allowed_seconds: [5, 15] }
  expect(formalMediaIntent('video', '极速横屏十五秒猫', [video])).toMatchObject({ input: { seconds: 15 } })
  expect(formalMediaIntent('video', '极速横屏五秒8步猫', [video])).toEqual({ error: 'profileUnavailable' })
  expect(formalMediaIntent('video', '极速横屏五秒30fps猫', [video])).toEqual({ error: 'profileUnavailable' })
  expect(formalMediaIntent('video', '极速横屏五秒1024x768猫', [video])).toEqual({ error: 'profileUnavailable' })
  expect(formalMediaIntent('video', '极速横屏五秒首尾帧猫', [video])).toEqual({ error: 'assetsUnavailable' })
  expect(formalMediaIntent('video', '极速横屏半秒猫', [video])).toEqual({ error: 'conflict' })
})
it('prepares ordered first and last frames with stable digests without storing their bytes in a call', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0])
  const data = Buffer.from(bytes).toString('base64')
  const attachments = [{ type: 'image' as const, mediaType: 'image/png' as const, data }]
  const prepared = await formalMediaAttachments(reference.sessionId, 'video', [...attachments, ...attachments])
  expect(prepared.map(a => a.intent.role)).toEqual(['first_frame', 'last_frame'])
  expect(prepared[0]?.intent.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
  expect(prepared[0]?.intent.assetId).not.toBe(prepared[1]?.intent.assetId)
  await expect(formalMediaAttachments(reference.sessionId, 'video', [...attachments, ...attachments, ...attachments])).rejects.toThrow('COMPUTE_MEDIA_ASSET_INVALID')
  await expect(formalMediaAttachments(reference.sessionId, 'image', [{ type: 'image', mediaType: 'image/webp', data }])).rejects.toThrow('COMPUTE_MEDIA_ASSET_INVALID')
})
it('reconciles the same attachment identifier with no bytes or credential in the status request', async () => {
  const intent = { assetId: reference.requestId, sessionId: reference.sessionId, sha256: 'a'.repeat(64),
    role: 'first_frame' as const, mediaType: 'image/png' as const }
  const requests: Array<{ url: string; body: unknown }> = []
  const fakeFetch = vi.fn<typeof fetch>(async (url, init) => {
    if (typeof init?.body !== 'string') throw new Error('unexpected fixture body')
    requests.push({ url: url instanceof URL ? url.href : 'unexpected', body: JSON.parse(init.body) as unknown })
    return Response.json({ assetId: intent.assetId, status: 'registered',
      asset: { asset_id: intent.assetId, sha256: intent.sha256, role: intent.role } })
  })
  const remote = createFormalMediaTransport('http://local-host/', fakeFetch)
  expect(await remote.assetStatus(intent, new AbortController().signal)).toMatchObject({ status: 'registered' })
  expect(requests).toEqual([{ url: 'http://local-host/api/qianshou/compute/media/asset-status',
    body: { assetId: intent.assetId, sessionId: reference.sessionId } }])
})
it('cold-restores an uncertain attachment without a task query, upload, quote or payment until a fresh status click', async () => {
  const fixture = transport(); const confirm = vi.fn(async () => true); const status = vi.fn(async () => false)
  const assetId = 'd41fbf3c-df28-4c79-a748-23478826e2be'
  const pending: FormalMediaCall = { ...call, input: { ...input, mode: 'image_to_image',
    assets: [{ asset_id: assetId, sha256: 'a'.repeat(64), role: 'reference' }] }, quote: null, submission: 'assets-pending',
  assetUploads: [{ assetId, sessionId: call.sessionId, sha256: 'a'.repeat(64), role: 'reference', mediaType: 'image/png', status: 'uncertain' }] }
  expect(isFormalMediaCall(pending, call.sessionId)).toBe(true)
  const instance = createFormalMediaStore().create(call.sessionId)
  expect(persistFormalMediaCall(instance.actions, pending)).toBe(true)
  expect(localStorage.getItem(`qianshou.formal-media-calls.${call.sessionId}`)).not.toMatch(/data|base64|ticket|signature/u)
  const ui = render(<FormalMediaCard call={pending} transport={fixture.remote} onConfirm={confirm} onQuote={status} t={key => zh[key]} />)
  expect(ui.getByText(zh.assetsPending)).toBeTruthy()
  expect(fixture.requests).toHaveLength(0); expect(status).not.toHaveBeenCalled(); expect(confirm).not.toHaveBeenCalled()
  fireEvent.click(ui.getByRole('button', { name: zh.assetStatus }))
  await waitFor(() => { expect(status).toHaveBeenCalledExactlyOnceWith(pending) })
})
it('compares admitted quote fields independently of JSON key ordering and strips result credentials', async () => {
  const reordered = Object.fromEntries(Object.entries(input).reverse())
  const fakeFetch = vi.fn<typeof fetch>(async url => new URL(url instanceof Request ? url.url : url).pathname.endsWith('/quote')
    ? Response.json({ ...quote, input: reordered }) : Response.json({ ...state, viewerReceipt: 'must-not-project' }))
  const remote = createFormalMediaTransport('http://local-host/', fakeFetch)
  expect(await remote.quote(reference, input, new AbortController().signal)).toEqual(quote)
  expect(await remote.state(reference, new AbortController().signal)).not.toHaveProperty('viewerReceipt')
  expect(isFormalMediaCall({ ...call, ticket: 'secret' }, call.sessionId)).toBe(false)
})
it('aborts delayed media from the previous task and revokes each current preview URL on unmount', async () => {
  const fixture = transport()
  const create = vi.fn(() => 'blob:current-result'); const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  let release: ((blob: Blob) => void) | undefined
  const revision = 'a'.repeat(64)
  const ready: FormalMediaState = { ...state, status: 'DONE', phase: 'settled', deliveryAvailable: true,
    resultMetadata: { assetId: 'fixture-asset', capability: 'image', sha256: revision, sizeBytes: 3, contentType: 'image/png',
      width: 1024, height: 768, fpsNum: null, fpsDen: null, secondsMs: null, resultRevision: revision },
    settlement: { settled: true, billableResultRevision: revision, ledgerReceiptId: 'release:fixture-task' } }
  const remote = { ...fixture.remote,
    state: vi.fn(async (reference: { requestId: string; sessionId: string }) => ({ ...ready, ...reference })),
    media: vi.fn(async (row: FormalMediaState, _signal: AbortSignal) => row.requestId === call.requestId
      ? new Promise<Blob>((resolve) => { release = resolve }) : new Blob(['new'], { type: 'image/png' })) }
  const ui = render(<FormalMediaCard call={{ ...call, submission: 'submitted' }} transport={remote}
    onConfirm={async () => true} onQuote={async () => true} t={key => zh[key]} />)
  await waitFor(() => { expect(release).toBeTypeOf('function') })
  const second = { ...call, submission: 'submitted' as const, requestId: 'a41d7c9f-50f8-46bd-bc38-b7d32c35be25' }
  ui.rerender(<FormalMediaCard call={second} transport={remote}
    onConfirm={async () => true} onQuote={async () => true} t={key => zh[key]} />)
  await waitFor(() => { expect(ui.getByRole('link', { name: zh.download }).getAttribute('href')).toBe('blob:current-result') })
  release?.(new Blob(['old'], { type: 'image/png' }))
  await Promise.resolve()
  expect(create).toHaveBeenCalledTimes(1)
  expect(remote.media.mock.calls[0]?.[1]?.aborted).toBe(true)
  ui.unmount()
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:current-result')
})
it.each([
  ['COMPUTE_MEDIA_CONFIRM_NOT_STARTED', true], ['COMPUTE_QUOTE_CONFIRMATION_INVALID', true],
  ['COMPUTE_SUBMISSION_UNKNOWN', false], ['CORE_UNAVAILABLE', false],
] as const)('classifies %s without giving an unknown paid outcome permission to requote and resubmit', async (code, rejected) => {
  const remote = createFormalMediaTransport('http://local-host/', vi.fn<typeof fetch>(async () =>
    Response.json({ error: { code } }, { status: 409 })))
  const error: unknown = await remote.confirm(quote, new AbortController().signal).catch((failure: unknown) => failure)
  expect(error).toBeInstanceOf(FormalMediaHostError)
  if (!(error instanceof FormalMediaHostError)) throw new Error('missing expected Host refusal')
  expect(error.rejectedBeforeSubmission).toBe(rejected)
})
