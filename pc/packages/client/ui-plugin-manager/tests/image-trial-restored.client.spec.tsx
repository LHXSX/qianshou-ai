// @vitest-environment jsdom
import { createHash, webcrypto } from 'node:crypto'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatTimelineEntryProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { UiWorkspace, WorkspaceSessionPreviewProvider } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { registerConversationImageTrials } from '../src/client/conversation-image-trial.tsx'
import type { ImageTrialCall } from '../src/client/image-trial-store.ts'
import type { ImageTrialJob, ImageTrialRequest } from '../src/client/image-trial-transport.ts'
import { zh } from '../src/client/image-trial-locales.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

it.each(['pending', 'settled'] as const)('restores a %s record through the actual timeline and transport using GET only', async (submission) => {
  const request: ImageTrialRequest = { id: 'c131c1ae-971d-494d-8060-b22c4778b8ee',
    sessionId: 'image-restored-session', prompt: '葫芦娃，横屏', size: 'landscape' }
  const call: ImageTrialCall = { id: `image-trial-${request.id}`, sessionId: request.sessionId as SessionId,
    createdAt: '2026-09-29T00:00:00Z', prompt: request.prompt, size: request.size, request, submission }
  const png = new Uint8Array(24)
  png.set([137, 80, 78, 71, 13, 10, 26, 10])
  const header = new DataView(png.buffer)
  header.setUint32(16, 2048); header.setUint32(20, 1152)
  const job: ImageTrialJob = { ...request, status: 'completed', steps: 8, width: 2048, height: 1152,
    billing: 'research-no-charge', timing: { submittedAt: '2026-09-29T00:00:00.123Z', phase: 'receiving' },
    result: { bytes: png.byteLength, sha256: createHash('sha256').update(png).digest('hex') } }
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input)
    expect(init?.method).toBe('GET')
    if (url.pathname.endsWith('/status')) return Response.json({ enabled: true, steps: 8, supportedSteps: [8, 12, 20], billing: 'research-no-charge' })
    expect(url.searchParams.get('id')).toBe(request.id)
    expect(url.searchParams.get('sessionId')).toBe(request.sessionId)
    if (url.pathname.endsWith('/job')) return Response.json(job)
    if (url.pathname.endsWith('/image')) return new Response(png.buffer, { headers: { 'content-type': 'image/png' } })
    throw new Error(`Unexpected request ${url.pathname}`)
  })
  vi.stubGlobal('fetch', fetcher)
  vi.stubGlobal('crypto', webcrypto)
  URL.createObjectURL = vi.fn().mockReturnValue('blob:restored-image')
  URL.revokeObjectURL = vi.fn()
  localStorage.setItem(`qianshou.image-trials.${call.sessionId}`, JSON.stringify({ calls: [call] }))
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
  await runtime.mount({ inject: ['slots', 'sessions', 'locale'], apply: (ctx) => { registerConversationImageTrials(ctx) } })
  try {
    expect(preview.read(call.sessionId)).toMatchObject({ kind: 'content', title: '@出图 葫芦娃，横屏' })
    expect(fetcher).not.toHaveBeenCalled()
    runtime.renderSlot('conversation.content.entries', { reportPresence: vi.fn() } as never, { session: held })
    await waitFor(() => { expect(provider.read(held.sessionId)).toHaveLength(1) })
    const entry = provider.read(held.sessionId)[0]!
    const timeline = runtime.renderSlot('conversation.chat.timelineEntry', {
      sourceId: provider.id, entryId: entry.id, createdAt: entry.createdAt,
    }, { session: held, entryKey: provider.id })
    await timeline.view.findByRole('img')
    expect(timeline.view.queryByText(zh.uncertain)).toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(3)
    fireEvent.click(timeline.view.getByRole('button', { name: zh.refresh }))
    await waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(5) })
    expect(timeline.view.queryByText(zh.uncertain)).toBeNull()
    expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true)
    // Leaving the conversation removes its mounted views, not its feature registration.
    cleanup()
    expect(preview.read(call.sessionId)).toMatchObject({ kind: 'content' })
    expect(fetcher).toHaveBeenCalledTimes(5)
  } finally { await runtime.dispose() }
  expect(removePreview).toHaveBeenCalledOnce()
  expect(preview.read(call.sessionId)).toBeNull()
})
