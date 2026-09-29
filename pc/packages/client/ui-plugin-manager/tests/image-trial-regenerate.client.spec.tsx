// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatTimelineEntryProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createImageTrialSubmitter, registerConversationImageTrials } from '../src/client/conversation-image-trial.tsx'
import { createImageTrialStore, isImageTrialCall, recordImageTrialCall, type ImageTrialCall } from '../src/client/image-trial-store.ts'
import { ImageTrialHostError, type ImageTrialJob, type ImageTrialRequest, type ImageTrialTransport } from '../src/client/image-trial-transport.ts'

// Card's completed-result gate is covered by its own suite; exercise the real timeline injection here.
vi.mock('../src/client/ImageTrialCard.tsx', () => ({ ImageTrialCard: ({ call, onRegenerate }: {
  call: ImageTrialCall
  onRegenerate?: (value: ImageTrialCall) => Promise<boolean>
}) => <button onClick={() => { void onRegenerate?.(call) }}>regenerate {call.id}</button> }))

const request: ImageTrialRequest = { id: 'c131c1ae-971d-494d-8060-b22c4778b8ee',
  sessionId: 'image-regenerate-session', prompt: '原始提示词：外星人在花园，竖屏', size: 'portrait' }
const original: ImageTrialCall = { id: `image-trial-${request.id}`, sessionId: request.sessionId as SessionId,
  createdAt: '2026-09-29T00:00:00Z', prompt: request.prompt, size: request.size,
  request, submission: 'settled' }
function receipt(value: ImageTrialRequest, status: ImageTrialJob['status'] = 'running'): ImageTrialJob {
  return { ...value, status, width: 1152, height: 2048, steps: value.steps ?? 8, billing: 'research-no-charge' }
}
function transport() {
  return { enabled: vi.fn<ImageTrialTransport['enabled']>().mockResolvedValue(true),
    start: vi.fn<ImageTrialTransport['start']>(async value => receipt(value)),
    read: vi.fn<ImageTrialTransport['read']>(), image: vi.fn<ImageTrialTransport['image']>() }
}
function harness(remote = transport()) {
  const store = createImageTrialStore().create(original.sessionId)
  store.actions.add(original)
  const submitter = createImageTrialSubmitter({ transport: remote,
    record: call => recordImageTrialCall(store.actions, call), update: store.actions.save })
  return { store, submitter, remote }
}
beforeEach(() => { localStorage.clear() })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it.each([12, 20] as const)('persists an explicit %i-step upgrade and uses its original UUID for restoration after an unknown POST', async (steps) => {
  const { store, submitter, remote } = harness()
  remote.start.mockRejectedValue(new TypeError('response lost'))
  expect(await submitter.regenerate(original, steps)).toBe(false)
  expect(remote.start).toHaveBeenCalledOnce()
  const upgraded = store.getSnapshot().calls[1]!
  expect(upgraded.steps).toBe(steps)
  expect(upgraded.request).toMatchObject({ steps, prompt: original.prompt, size: original.size, sessionId: original.sessionId })
  expect(upgraded.request?.id).not.toBe(original.request?.id)
  expect(store.getSnapshot().calls[0]).toEqual(original)
  const restored = createImageTrialStore().create(original.sessionId)
  expect(restored.getSnapshot().calls[1]).toEqual(upgraded)
  expect(isImageTrialCall(upgraded, original.sessionId)).toBe(true)
  expect(isImageTrialCall({ ...upgraded, steps: 8 }, original.sessionId)).toBe(false)
  expect(remote.start).toHaveBeenCalledOnce()
  submitter.dispose()
})

it('persists a distinct request using the original inputs before POST and retains the previous result', async () => {
  const { store, submitter, remote } = harness()
  expect(remote.start).not.toHaveBeenCalled()
  remote.start.mockImplementation(async (next) => {
    const saved = JSON.parse(localStorage.getItem(`qianshou.image-trials.${original.sessionId}`)!) as { calls: ImageTrialCall[] }
    expect(saved.calls).toHaveLength(2)
    expect(saved.calls[0]).toEqual(original)
    expect(saved.calls[1]).toMatchObject({ request: next, submission: 'pending' })
    return receipt(next)
  })
  expect(await submitter.regenerate(original)).toBe(true)
  expect(remote.start).toHaveBeenCalledOnce()
  const next = store.getSnapshot().calls[1]!
  expect(next.id).not.toBe(original.id)
  expect(next.request?.id).not.toBe(original.request?.id)
  expect(next.request).toEqual({ ...original.request, id: next.request?.id })
  expect(next.submission).toBe('settled')
  expect(store.getSnapshot().calls[0]).toEqual(original)
  expect(createImageTrialStore().create(original.sessionId).getSnapshot().calls).toEqual(store.getSnapshot().calls)
  expect(remote.read).not.toHaveBeenCalled()
  expect(remote.image).not.toHaveBeenCalled()
  submitter.dispose()
})

it('joins concurrent result clicks into one POST while a later explicit click creates another request', async () => {
  const { store, submitter, remote } = harness()
  let finish!: (job: ImageTrialJob) => void
  remote.start.mockImplementation(() => new Promise<ImageTrialJob>((resolve) => { finish = resolve }))
  const first = submitter.regenerate(original)
  const double = submitter.regenerate(original)
  expect(double).toBe(first)
  await Promise.resolve()
  expect(remote.start).toHaveBeenCalledOnce()
  const next = store.getSnapshot().calls[1]!
  finish(receipt(next.request!))
  expect(await first).toBe(true)
  remote.start.mockClear().mockImplementation(async value => receipt(value))
  expect(await submitter.regenerate(original)).toBe(true)
  expect(remote.start).toHaveBeenCalledOnce()
  expect(store.getSnapshot().calls).toHaveLength(3)
  expect(store.getSnapshot().calls[2]?.request?.id).not.toBe(next.request?.id)
  submitter.dispose()
})

it.each(['write', 'read'] as const)('returns false without POST when the new request cannot be persisted through %s', async (failure) => {
  const { store, submitter, remote } = harness()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  if (failure === 'write') vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  else vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
  expect(await submitter.regenerate(original)).toBe(false)
  expect(remote.start).not.toHaveBeenCalled()
  expect(store.getSnapshot().calls).toEqual([original])
  submitter.dispose()
})

it.each([
  ['known rejection', new ImageTrialHostError('IMAGE_TRIAL_BUSY', 409), false],
  ['unknown outcome', new TypeError('connection interrupted'), true],
] as const)('returns false for %s and preserves the old result and new receipt without replay', async (_label, error, retainsRequest) => {
  const { store, submitter, remote } = harness()
  remote.start.mockRejectedValue(error)
  expect(await submitter.regenerate(original)).toBe(false)
  expect(remote.start).toHaveBeenCalledOnce()
  const rows = store.getSnapshot().calls
  expect(rows).toHaveLength(2)
  expect(rows[0]).toEqual(original)
  expect(rows[1]?.submission).toBe('settled')
  expect(rows[1]?.request !== null).toBe(retainsRequest)
  const restored = createImageTrialStore().create(original.sessionId)
  const replacement = createImageTrialSubmitter({ transport: remote,
    record: value => recordImageTrialCall(restored.actions, value), update: restored.actions.save })
  expect(restored.getSnapshot().calls).toEqual(rows)
  expect(remote.start).toHaveBeenCalledOnce()
  expect(remote.read).not.toHaveBeenCalled()
  replacement.dispose(); submitter.dispose()
})

it('returns false for a failed Host receipt and never changes the original result', async () => {
  const { store, submitter, remote } = harness()
  remote.start.mockImplementation(async value => receipt(value, 'failed'))
  expect(await submitter.regenerate(original)).toBe(false)
  expect(store.getSnapshot().calls[0]).toEqual(original)
  expect(store.getSnapshot().calls[1]?.request).not.toBeNull()
  expect(remote.start).toHaveBeenCalledOnce()
  submitter.dispose()
})

it('permits a completed result restored from an interrupted pending write after its Card verifies completion', async () => {
  const { submitter, remote } = harness()
  expect(await submitter.regenerate({ ...original, submission: 'pending' })).toBe(true)
  expect(remote.start).toHaveBeenCalledOnce()
  submitter.dispose()
})

it('does not submit a draft, cross-Session reference or disposed callback', async () => {
  const { store, submitter, remote } = harness()
  expect(await submitter.regenerate({ ...original, request: null })).toBe(false)
  expect(await submitter.regenerate({ ...original, request: { ...request, sessionId: 'other-session' } })).toBe(false)
  const queued = submitter.regenerate(original)
  submitter.dispose()
  expect(await queued).toBe(false)
  expect(await submitter.regenerate(original)).toBe(false)
  expect(remote.start).not.toHaveBeenCalled()
  expect(store.getSnapshot().calls).toEqual([original])
})

it('connects the actual timeline callback to one Session-bound POST and never posts on mount or restore', async () => {
  localStorage.setItem(`qianshou.image-trials.${original.sessionId}`, JSON.stringify({ calls: [original] }))
  const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method !== 'POST') throw new Error('Only the explicit result action may submit')
    if (typeof init.body !== 'string') throw new Error('Expected JSON request body')
    return Response.json(receipt(JSON.parse(init.body) as ImageTrialRequest))
  })
  vi.stubGlobal('fetch', fetcher)
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ 'conversation.content.entries': { kind: 'list', scope: 'session' },
    'conversation.chat.timelineEntry': { kind: 'keyed', scope: 'session' } })
  let provider!: ChatTimelineEntryProvider
  runtime.ctx.provide('chatTimelineEntries', { register: (value) => { provider = value; return () => {} } })
  await runtime.sessions.add({ id: original.sessionId })
  using held = runtime.sessions.retain(original.sessionId)
  await held.ready
  await runtime.mount({ inject: ['slots', 'sessions', 'locale'], apply: (ctx) => { registerConversationImageTrials(ctx) } })
  try {
    runtime.renderSlot('conversation.content.entries', { reportPresence: vi.fn() } as never, { session: held })
    await waitFor(() => { expect(provider.read(held.sessionId)).toHaveLength(1) })
    const entry = provider.read(held.sessionId)[0]!
    const owner = { sourceId: provider.id, entryId: entry.id, createdAt: entry.createdAt }
    const timeline = runtime.renderSlot('conversation.chat.timelineEntry', owner, { session: held, entryKey: provider.id })
    expect(fetcher).not.toHaveBeenCalled()
    const button = timeline.view.getByRole('button', { name: `regenerate ${original.id}` })
    await act(async () => { fireEvent.click(button); fireEvent.click(button) })
    await waitFor(() => { expect(provider.read(held.sessionId)).toHaveLength(2) })
    expect(fetcher).toHaveBeenCalledOnce()
    const body = fetcher.mock.calls[0]?.[1]?.body
    if (typeof body !== 'string') throw new Error('Expected JSON request body')
    const sent = JSON.parse(body) as ImageTrialRequest
    expect(sent).toEqual({ ...request, id: sent.id })
    expect(sent.id).not.toBe(request.id)
    const rows = (runtime.storeOf('conversation.content.entries', held).getSnapshot() as { calls: ImageTrialCall[] }).calls
    expect(rows[0]).toEqual(original)
    expect(rows[1]?.request).toEqual(sent)
    timeline.update({ ...owner, entryId: 'no-result-selected' })
    timeline.update(owner)
    expect(fetcher).toHaveBeenCalledOnce()
  } finally { await runtime.dispose() }
})
