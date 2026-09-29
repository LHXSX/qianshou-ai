// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatTimelineEntryProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UiWorkspace, WorkspaceSessionPreviewProvider } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerConversationVideoTrials } from '../src/client/conversation-video-trial.tsx'
import type { VideoTrialCall } from '../src/client/video-trial-store.ts'
import type { VideoTrialJob, VideoTrialRequest } from '../src/client/video-trial-transport.ts'
import { zh } from '../src/client/video-trial-locales.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it.each(['pending', 'settled'] as const)('restores a %s record through the actual timeline and transport using GET only', async (submission) => {
  const request: VideoTrialRequest = { id: 'c131c1ae-971d-494d-8060-b22c4778b8ee',
    sessionId: 'video-restored-session', prompt: '葫芦娃，横屏', seconds: 5, orientation: 'landscape', quality: 'fast' }
  const call: VideoTrialCall = { id: `video-trial-${request.id}`, sessionId: request.sessionId as SessionId,
    createdAt: '2026-09-29T00:00:00Z', prompt: request.prompt, source: { kind: 'generated' }, request, submission }
  const mp4 = Uint8Array.from([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])
  const job: VideoTrialJob = { ...request, status: 'completed', steps: 4, width: 1344, height: 768,
    billing: 'research-no-charge', timing: { submittedAt: '2026-09-29T00:00:00.123Z', phase: 'receiving' },
    result: { bytes: mp4.byteLength, sha256: createHash('sha256').update(mp4).digest('hex') } }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    expect(init?.method).toBe('GET')
    expect(url.searchParams.get('id')).toBe(request.id)
    expect(url.searchParams.get('sessionId')).toBe(request.sessionId)
    if (url.pathname.endsWith('/job')) return Response.json(job)
    if (url.pathname.endsWith('/video')) return new Response(mp4.buffer, { headers: { 'content-type': 'video/mp4' } })
    throw new Error(`Unexpected request ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('crypto', webcrypto)
  URL.createObjectURL = vi.fn().mockReturnValue('blob:restored-video')
  URL.revokeObjectURL = vi.fn()
  localStorage.setItem(`qianshou.video-trials.${call.sessionId}`, JSON.stringify({ calls: [call] }))
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ 'conversation.content.entries': { kind: 'list', scope: 'session' },
    'conversation.chat.timelineEntry': { kind: 'keyed', scope: 'session' } })
  let provider!: ChatTimelineEntryProvider
  runtime.ctx.provide('chatTimelineEntries', { register: (value) => { provider = value; return () => {} } })
  let preview!: WorkspaceSessionPreviewProvider
  const removePreview = vi.fn()
  runtime.ctx.provide('uiWorkspace', { registerSessionPreview: (value: WorkspaceSessionPreviewProvider): (() => void) => {
    preview = value; return removePreview
  } } as UiWorkspace)
  await runtime.sessions.add({ id: call.sessionId })
  using held = runtime.sessions.retain(call.sessionId)
  await held.ready
  await runtime.mount({ inject: ['slots', 'sessions', 'locale'], apply: (ctx) => { registerConversationVideoTrials(ctx) } })
  try {
    expect(preview.read(call.sessionId)).toMatchObject({ kind: 'content', title: '@出视频 葫芦娃，横屏' })
    expect(fetcher).not.toHaveBeenCalled()
    runtime.renderSlot('conversation.content.entries', { reportPresence: vi.fn() } as never, { session: held })
    await waitFor(() => { expect(provider.read(held.sessionId)).toHaveLength(1) })
    const entry = provider.read(held.sessionId)[0]!
    const timeline = runtime.renderSlot('conversation.chat.timelineEntry', {
      sourceId: provider.id, entryId: entry.id, createdAt: entry.createdAt,
    }, { session: held, entryKey: provider.id })
    await timeline.view.findByRole('link', { name: zh.download })
    expect(timeline.view.queryByText(zh.uncertain)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(2)
    fireEvent.click(timeline.view.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(4) })
    expect(timeline.view.queryByText(zh.uncertain)).toBeNull()
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
    // Leaving the conversation removes its mounted views, not its feature registration.
    cleanup()
    expect(preview.read(call.sessionId)).toMatchObject({ kind: 'content' })
    expect(fetcher).toHaveBeenCalledTimes(4)
  } finally { await runtime.dispose() }
  expect(removePreview).toHaveBeenCalledOnce()
  expect(preview.read(call.sessionId)).toBeNull()
})
