// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SubmitAttachment } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createVideoTrialSubmitter } from '../src/client/conversation-video-trial.tsx'
import { createVideoTrialStore, isVideoTrialCall, recordVideoTrialCall, type VideoTrialCall } from '../src/client/video-trial-store.ts'
import { createVideoTrialTransport, VideoTrialHostError, videoTrialJob, type VideoTrialJob,
  type VideoTrialReference, type VideoTrialTransport } from '../src/client/video-trial-transport.ts'
import { videoTrialFrame, videoTrialPromptError } from '../src/client/video-trial-input.ts'
import { createConversationVideoTrialPreview } from '../src/client/conversation-video-trial-preview.ts'
import { createMarketMentionSource } from '../src/client/market-mention-source.ts'
import { MarketCapabilitiesController } from '../src/client/market-capabilities-controller.ts'
import { VideoTrialCard } from '../src/client/VideoTrialCard.tsx'
import { zh } from '../src/client/video-trial-locales.ts'

const request: VideoTrialReference = { id: 'c131c1ae-971d-494d-8060-b22c4778b8ee', sessionId: 'video-session',
  prompt: '外星人在树林中缓慢转身', seconds: 5, orientation: 'landscape', quality: 'fast' }
const call: VideoTrialCall = { id: `video-trial-${request.id}`, sessionId: request.sessionId as SessionId,
  prompt: request.prompt, createdAt: '2026-09-29T00:00:00.000Z', request, source: { kind: 'generated' }, submission: 'settled' }
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])
const attachment: SubmitAttachment = { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: '首帧.png' }
const mp4 = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])
const result = { bytes: mp4.length, sha256: createHash('sha256').update(mp4).digest('hex') }
function receipt(ref = request, status: VideoTrialJob['status'] = 'running'): VideoTrialJob {
  return { ...ref, status, steps: 4, width: 1344, height: 768, billing: 'research-no-charge',
    timing: { submittedAt: '2026-09-29T00:00:00.000Z', phase: 'preparing-first-frame' },
    ...(status === 'completed' ? { result } : {}), ...(status === 'failed' ? { errorCode: 'VIDEO_TRIAL_UPSTREAM_FAILED' } : {}) }
}
function remote() {
  return { enabled: vi.fn<VideoTrialTransport['enabled']>().mockResolvedValue(true),
    start: vi.fn<VideoTrialTransport['start']>(async ref => receipt(ref)),
    read: vi.fn<VideoTrialTransport['read']>(async ref => receipt(ref)),
    video: vi.fn<VideoTrialTransport['video']>().mockResolvedValue(new Blob([mp4], { type: 'video/mp4' })) }
}
function harness() {
  const transport = remote()
  const store = createVideoTrialStore().create(call.sessionId)
  const submitter = createVideoTrialSubmitter({ transport,
    record: row => recordVideoTrialCall(store.actions, row), update: store.actions.save })
  return { transport, store, submitter }
}
beforeEach(() => { localStorage.clear(); vi.stubGlobal('crypto', webcrypto) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it.each(['外星人走路', '横屏，5秒，极速，外星人', '五秒横屏', '5 seconds landscape', 'five-second landscape, four steps, 24 fps', '四步，五秒'])('keeps supported original prompt: %s', (prompt) => {
  expect(videoTrialPromptError(prompt)).toBeNull()
})
it.each(['10秒外星人', '三秒', '5分钟', '横屏和竖屏', '9:16', '方形画面', '高清', '4K', '首尾帧', 'last frame', '5秒至10秒', '8步', '1920x1080', '半分钟', 'ten-second landscape', '10-second landscape', 'six steps', '八步', '60 fps'])('blocks unsupported parameters without replacement: %s', (prompt) => {
  expect(videoTrialPromptError(prompt)).toBe('unsupported')
})
it('admits one original PNG and hashes its bytes without rewriting or dropping assets', async () => {
  const parsed = await videoTrialFrame([attachment])
  expect(parsed).toEqual({ frame: { mediaType: 'image/png', data: png.toString('base64') },
    sha256: createHash('sha256').update(png).digest('hex') })
  expect(await videoTrialFrame([])).toEqual({})
  await expect(videoTrialFrame([attachment, attachment])).rejects.toThrow()
  await expect(videoTrialFrame([{ type: 'file', receiptId: 'receipt' }])).rejects.toThrow()
  await expect(videoTrialFrame([{ type: 'image', mediaType: 'image/webp', data: attachment.data }])).rejects.toThrow()
  await expect(videoTrialFrame([{ ...attachment, data: `data:image/png;base64,${attachment.data}` }])).rejects.toThrow()
})
it('durably records UUID and first-frame hash before POST, never stores base64, and previews the cold Session', async () => {
  const { submitter, transport, store } = harness()
  const input = await videoTrialFrame([attachment])
  transport.start.mockImplementation(async (sent) => {
    const raw = localStorage.getItem(`qianshou.video-trials.${call.sessionId}`)!
    expect(raw).not.toContain(attachment.data)
    expect(JSON.parse(raw)).toMatchObject({ calls: [{ request: { id: sent.id }, source: { kind: 'attachment', sha256: input.sha256 } }] })
    expect(sent.firstFrame).toEqual(input.frame)
    return receipt(sent)
  })
  expect(await submitter.submit(call, call.prompt, input.frame, input.sha256)).toMatchObject({ outcome: 'accepted' })
  expect(transport.start).toHaveBeenCalledOnce()
  const preview = createConversationVideoTrialPreview()
  expect(preview.provider.read(call.sessionId)).toMatchObject({ kind: 'content', title: `@出视频 ${call.prompt}` })
  expect(preview.provider.read('other' as SessionId)).toBeNull()
  expect(store.getSnapshot().calls[0]?.submission).toBe('settled')
  preview.dispose(); submitter.dispose()
})
it('storage failure sends nothing and removes the temporary row', async () => {
  const { submitter, transport, store } = harness()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full') })
  expect(await submitter.submit(call, call.prompt)).toEqual({ outcome: 'notReady' })
  expect(transport.start).not.toHaveBeenCalled()
  expect(store.getSnapshot().calls).toEqual([])
  submitter.dispose()
})
it.each([
  ['busy', new VideoTrialHostError('VIDEO_TRIAL_BUSY', 409), false],
  ['unknown', new TypeError('network interrupted'), true],
  ['unknown', new VideoTrialHostError('VIDEO_TRIAL_ID_CONFLICT', 409), true],
] as const)('distinguishes %s and never replays stored state', async (outcome, error, retained) => {
  const { submitter, transport, store } = harness()
  transport.start.mockRejectedValue(error)
  expect(await submitter.submit(call, call.prompt)).toMatchObject({ outcome })
  const row = store.getSnapshot().calls[0]!
  expect(row.request !== null).toBe(retained)
  const restored = createVideoTrialStore().create(call.sessionId)
  expect(restored.getSnapshot().calls).toEqual([row])
  expect(transport.start).toHaveBeenCalledOnce()
  submitter.dispose()
})
it('explicit repeat uses a new ID and Host-owned original first frame with one POST for double click', async () => {
  const { submitter, transport, store } = harness()
  store.actions.add(call)
  const first = submitter.regenerate(call)
  const double = submitter.regenerate(call)
  expect(first).toBe(double)
  expect(await first).toBe(true)
  const sent = transport.start.mock.calls[0]![0]
  expect(sent).toEqual({ ...request, id: sent.id, reuseJobId: request.id })
  expect(sent.id).not.toBe(request.id)
  expect(transport.start).toHaveBeenCalledOnce()
  expect(store.getSnapshot().calls[0]).toEqual(call)
  expect(isVideoTrialCall({ ...call, request: { ...request, sessionId: 'other' } }, call.sessionId)).toBe(false)
  submitter.dispose()
})

function mention(trial = { ...remote(), open: vi.fn().mockResolvedValue({ outcome: 'accepted' }),
  reconcile: vi.fn(), text: (key: keyof typeof zh) => zh[key] }) {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities:
    vi.fn().mockResolvedValue({ ok: true, value: { capabilities: [] } }) })
  const fallback = vi.fn().mockReturnValue(true)
  const source = createMarketMentionSource({ capabilities, callingMode: () => true,
    callCapability: vi.fn(), callVideoDraft: fallback, videoTrial: trial })
  const session = { sessionId: call.sessionId } as Parameters<typeof source.candidates>[0]
  return { trial, capabilities, fallback, source, session }
}
it('claimed @ video accepts an attachment and submits exact description once; repeated Enter joins it', async () => {
  const { source, session, trial, capabilities, fallback } = mention()
  const matched = await source.matchEnter!(session, '@出视频 外星人', new AbortController().signal, { attachments: 1 })
  if (typeof matched !== 'object' || matched === null || !('claim' in matched)) throw new Error('claim required')
  const claim = matched.claim
  expect(claim.attachments).toBe(true)
  const first = claim.submit(call.prompt, {} as never, [attachment])
  const second = claim.submit(call.prompt, {} as never, [attachment])
  expect(first).toBe(second)
  expect(await first).toEqual({ kind: 'success' })
  expect(trial.open).toHaveBeenCalledOnce()
  expect(trial.open).toHaveBeenCalledWith(session, call.prompt, { mediaType: 'image/png', data: attachment.data }, expect.any(String))
  expect(fallback).not.toHaveBeenCalled()
  capabilities.dispose()
})
it('unknown composer outcome remains an error retaining attachments and never creates another POST', async () => {
  const { source, session, trial, capabilities } = mention()
  trial.open.mockResolvedValue({ outcome: 'unknown' })
  const matched = source.matchSpace!(session, '@出视频')
  if (typeof matched !== 'object' || matched === null || !('claim' in matched)) throw new Error('claim required')
  expect(await matched.claim.submit(call.prompt, {} as never, [attachment])).toEqual({ kind: 'error', text: zh.uncertain })
  expect(await matched.claim.submit(call.prompt, {} as never, [attachment])).toEqual({ kind: 'error', text: zh.uncertain })
  expect(trial.open).toHaveBeenCalledOnce()
  capabilities.dispose()
})
it('disabled trial preserves the formal draft path and never calls the trial', async () => {
  const { source, session, trial, capabilities, fallback } = mention()
  trial.enabled.mockResolvedValue(false)
  const matched = source.matchSpace!(session, '@出视频')
  if (typeof matched !== 'object' || matched === null || !('claim' in matched)) throw new Error('claim required')
  expect((await matched.claim.submit(call.prompt, {} as never, [])).kind).toBe('success')
  expect(trial.open).not.toHaveBeenCalled()
  expect(fallback).toHaveBeenCalledWith(session, call.prompt)
  capabilities.dispose()
})
it('rejects unsupported composer requests while retaining draft and attached frame', async () => {
  const { source, session, trial, capabilities } = mention()
  const matched = source.matchSpace!(session, '@出视频')
  if (typeof matched !== 'object' || matched === null || !('claim' in matched)) throw new Error('claim required')
  expect(await matched.claim.submit('10秒竖屏高清', {} as never, [attachment])).toEqual({ kind: 'error', text: zh.unsupported })
  expect(trial.open).not.toHaveBeenCalled()
  capabilities.dispose()
})

it('restores video inline through GET, exposes original download, and revokes its Blob URL', async () => {
  const transport = remote()
  transport.read.mockResolvedValue(receipt(request, 'completed'))
  const create = vi.fn().mockReturnValue('blob:verified-video')
  const revoke = vi.fn()
  vi.stubGlobal('URL', Object.assign(class extends URL {}, { createObjectURL: create, revokeObjectURL: revoke }))
  const rerun = vi.fn().mockResolvedValue(true)
  const view = render(<VideoTrialCard call={call} transport={transport} isSubmitting={() => false}
    onRegenerate={rerun} t={key => zh[key]} />)
  const link = await view.findByRole('link', { name: zh.download })
  expect(link.getAttribute('href')).toBe('blob:verified-video')
  expect(view.container.querySelector('video')?.controls).toBe(true)
  expect(view.queryByRole('textbox')).toBeNull()
  expect(view.queryByRole('combobox')).toBeNull()
  expect(view.queryByRole('progressbar')).toBeNull()
  expect(transport.start).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(transport.read).toHaveBeenCalledTimes(2) })
  expect(transport.read).toHaveBeenNthCalledWith(2, request, expect.any(AbortSignal), true)
  await act(async () => { fireEvent.click(view.getByRole('button', { name: zh.regenerate })); fireEvent.click(view.getByRole('button', { name: zh.regenerate })) })
  expect(rerun).toHaveBeenCalledOnce()
  view.unmount()
  expect(revoke).toHaveBeenCalledWith('blob:verified-video')
})

it('shows a recoverable Host read failure without losing the original ID or submitting again', async () => {
  const transport = remote()
  transport.read.mockResolvedValue({ ...receipt(), errorCode: 'VIDEO_TRIAL_READ_UNAVAILABLE' })
  const view = render(<VideoTrialCard call={call} transport={transport} isSubmitting={() => false} t={key => zh[key]} />)
  expect((await view.findByRole('alert')).textContent).toContain(zh.uncertain)
  expect(view.getByRole('alert').textContent).not.toContain('VIDEO_TRIAL_READ_UNAVAILABLE')
  expect(view.getByText('VIDEO_TRIAL_READ_UNAVAILABLE').closest('details')?.open).toBe(false)
  expect(transport.read).toHaveBeenCalledWith(request, expect.any(AbortSignal))
  expect(transport.start).not.toHaveBeenCalled()
})

it.each(['transport', 'request', 'session', 'submission'] as const)(
  'consumes explicit delivery refresh before a %s rerender', async (change) => {
    const transport = remote()
    const failed = async (ref: VideoTrialReference): Promise<VideoTrialJob> => ({ ...receipt(ref, 'failed'),
      timing: { ...receipt(ref).timing, phase: 'receiving' }, errorCode: 'VIDEO_TRIAL_RESULT_INVALID' })
    transport.read.mockImplementation(failed)
    const isSubmitting = () => false
    const pendingCall: VideoTrialCall = { ...call, submission: 'pending' }
    const view = render(<VideoTrialCard call={pendingCall} transport={transport} isSubmitting={isSubmitting} t={key => zh[key]} />)
    await view.findByRole('alert')
    expect(transport.read).toHaveBeenLastCalledWith(request, expect.any(AbortSignal))
    fireEvent.click(view.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(transport.read).toHaveBeenCalledTimes(2) })
    expect(transport.read).toHaveBeenLastCalledWith(request, expect.any(AbortSignal), true)
    const nextRequest: VideoTrialReference = { ...request,
      ...(change === 'request' ? { id: 'eb9c41b6-111f-47e9-b84f-81fbd0c71f6f' } : {}),
      ...(change === 'session' ? { sessionId: 'another-video-session' } : {}) }
    const nextCall: VideoTrialCall = { ...pendingCall, id: `video-trial-${nextRequest.id}`,
      sessionId: nextRequest.sessionId as SessionId, request: nextRequest,
      ...(change === 'submission' ? { submission: 'settled' } : {}) }
    const nextTransport = change === 'transport' ? remote() : transport
    nextTransport.read.mockImplementation(failed)
    view.rerender(<VideoTrialCard call={nextCall} transport={nextTransport} isSubmitting={isSubmitting} t={key => zh[key]} />)
    await waitFor(() => { expect(nextTransport.read).toHaveBeenCalledTimes(change === 'transport' ? 1 : 3) })
    expect(nextTransport.read).toHaveBeenLastCalledWith(nextRequest, expect.any(AbortSignal))
    expect(transport.start).not.toHaveBeenCalled()
    expect(nextTransport.start).not.toHaveBeenCalled()
  },
)

it('discards a queued refresh when its original pending task leaves the card', async () => {
  const transport = remote()
  transport.read.mockImplementation(async ref => receipt(ref, 'failed'))
  const pendingCall: VideoTrialCall = { ...call, submission: 'pending' }
  const isSubmitting = (id: string) => id === request.id
  const view = render(<VideoTrialCard call={pendingCall} transport={transport} isSubmitting={isSubmitting} t={key => zh[key]} />)
  expect(transport.read).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: zh.refresh }))
  expect(transport.read).not.toHaveBeenCalled()
  const nextRequest: VideoTrialReference = { ...request, id: 'eb9c41b6-111f-47e9-b84f-81fbd0c71f6f', sessionId: 'another-video-session' }
  const nextCall: VideoTrialCall = { ...call, id: `video-trial-${nextRequest.id}`,
    sessionId: nextRequest.sessionId as SessionId, request: nextRequest }
  view.rerender(<VideoTrialCard call={nextCall} transport={transport} isSubmitting={isSubmitting} t={key => zh[key]} />)
  await view.findByRole('alert')
  expect(transport.read).toHaveBeenCalledOnce()
  expect(transport.read).toHaveBeenLastCalledWith(nextRequest, expect.any(AbortSignal))
  view.rerender(<VideoTrialCard call={call} transport={transport} isSubmitting={isSubmitting} t={key => zh[key]} />)
  await waitFor(() => { expect(transport.read).toHaveBeenCalledTimes(2) })
  expect(transport.read).toHaveBeenLastCalledWith(request, expect.any(AbortSignal))
  expect(transport.start).not.toHaveBeenCalled()
})

it('retains a precise pre-acceptance failure in the Session and explains the missing first-frame route', async () => {
  const { submitter, transport, store } = harness()
  transport.start.mockRejectedValue(new VideoTrialHostError('VIDEO_TRIAL_IMAGE_UNAVAILABLE', 503))
  expect(await submitter.submit(call, call.prompt)).toMatchObject({ outcome: 'refused' })
  const rejected = store.getSnapshot().calls[0]!
  expect(rejected).toMatchObject({ request: null, rejectionCode: 'VIDEO_TRIAL_IMAGE_UNAVAILABLE' })
  expect(isVideoTrialCall(rejected, call.sessionId)).toBe(true)
  expect(isVideoTrialCall({ ...rejected, rejectionCode: 'upstream private content' }, call.sessionId)).toBe(false)
  const view = render(<VideoTrialCard call={rejected} transport={transport} isSubmitting={submitter.isSubmitting} t={key => zh[key]} />)
  expect(view.getByRole('alert').textContent).toContain(zh.imageUnavailable)
  expect(view.queryByRole('button', { name: zh.refresh })).toBeNull()
  expect(transport.read).not.toHaveBeenCalled()
  submitter.dispose()
})
it('shows observed first-frame and node progress without fake percentages', async () => {
  const transport = remote()
  const view = render(<VideoTrialCard call={call} transport={transport} isSubmitting={() => false} t={key => zh[key]} />)
  await view.findByText(zh['preparing-first-frame'])
  expect(view.getByRole('progressbar').hasAttribute('aria-valuenow')).toBe(false)
  transport.read.mockResolvedValue({ ...receipt(), timing: { ...receipt().timing, phase: 'generating' }, progress: 23 })
  fireEvent.click(view.getByRole('button', { name: zh.refresh }))
  await waitFor(() => { expect(view.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('23') })
  expect(transport.start).not.toHaveBeenCalled()
})
it('same-origin transport validates job identity and original MP4 size/hash', async () => {
  const done = receipt(request, 'completed')
  const address = (url: Parameters<typeof fetch>[0]): string => url instanceof Request ? url.url : url instanceof URL ? url.href : url
  const fetcher = vi.fn<typeof fetch>(async url => address(url).includes('/video?')
    ? new Response(mp4, { headers: { 'content-type': 'video/mp4' } }) : Response.json(done))
  const transport = createVideoTrialTransport('dsh-app://app/', fetcher)
  expect(await transport.read(request, new AbortController().signal)).toEqual(done)
  expect(address(fetcher.mock.calls[0]![0])).not.toContain('retryDelivery')
  expect(await transport.read(request, new AbortController().signal, true)).toEqual(done)
  expect(address(fetcher.mock.calls[1]![0])).toContain('retryDelivery=1')
  const video = await transport.video(done, new AbortController().signal)
  expect(video.size).toBe(mp4.length)
  for (const [url, init] of fetcher.mock.calls) {
    expect(address(url).startsWith('dsh-app://app/api/qianshou/compute/video-trial/')).toBe(true)
    expect(init).toMatchObject({ method: 'GET', credentials: 'same-origin', redirect: 'error' })
  }
  expect(() => videoTrialJob({ ...done, sessionId: 'other' }, request)).toThrow()
  expect(() => videoTrialJob({ ...done, result: { ...result, bytes: 16 * 1024 * 1024 + 1 } }, request)).toThrow()
  expect(() => videoTrialJob({ ...done, progress: 101 }, request)).toThrow()
  await expect(transport.video({ ...done, result: { ...result, sha256: '0'.repeat(64) } }, new AbortController().signal)).rejects.toThrow()
})
