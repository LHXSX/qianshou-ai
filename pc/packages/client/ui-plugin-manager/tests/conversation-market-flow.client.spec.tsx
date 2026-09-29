// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ChatTimelineEntryProvider } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UiWorkspace, WorkspaceSessionPreviewProvider } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { InputTriggerController } from '../../ui-input-trigger/src/client/controller.ts'
import { SessionInputShell } from '../../ui-conversation/src/client/input/facade.ts'
import { MarketCapabilitiesController } from '../src/client/market-capabilities-controller.ts'
import { createMarketMentionSource, videoDraftCapability } from '../src/client/market-mention-source.ts'
import type { ConversationMarketCall } from '../src/client/conversation-market-store.ts'
import { createConversationMarketStore, isConversationMarketCall } from '../src/client/conversation-market-store.ts'

it('restores an exact market product selection without treating a blank call card as a generic @ request', () => {
  const sessionId = 'product-session' as SessionId
  const call: ConversationMarketCall = { id: 'market-call-12345678-1234-1234-1234-123456789abc',
    sessionId, createdAt: new Date().toISOString(), goal: '',
    capability: { taskType: 'legal_term_scan_v1', capabilityId: 'text.transform',
      name: '法律术语扫描', category: 'legal' },
    selectedProduct: { productId: 'product-1', publicationId: 'publication-1', ownerId: 167, version: '1.2' },
    continuation: { planId: null, workloadId: null, submission: 'idle' } }
  expect(isConversationMarketCall(call, sessionId)).toBe(true)
  expect(isConversationMarketCall({ ...call, selectedProduct: undefined }, sessionId)).toBe(false)
  expect(isConversationMarketCall({ ...call, selectedProduct: { ...call.selectedProduct, version: '' } },
    sessionId)).toBe(false)
})


usePinnedBrowserLanguages('zh-CN')
afterEach(() => { cleanup(); vi.unstubAllGlobals(); localStorage.clear() })

const image = { taskType: 'image.generate', capabilityId: 'image.generate', name: '官方出图',
  description: '已审核的出图任务', category: 'image', categoryLabelZh: '图片',
  acceptedInputKinds: ['inline'], defaultInputKind: 'inline', requiredParams: [], outputKind: 'image',
  contractVersion: 'task-registry.v1', publisherKind: 'official' as const,
  publisherKinds: ['official' as const], executionMode: 'cloud' as const,
  availability: 'contract_ready' as const, requiresQuote: true as const,
  executionQuotePath: '/api/v8/developer/tasks/estimate' as const, currency: 'CNY' as const, products: [] }

const PLAN = 'plan_123'
const QUOTE = 'a'.repeat(32)

function fetchAddress(input: RequestInfo | URL): string {
  if (input instanceof Request) return input.url
  return input instanceof URL ? input.href : input
}

function hostFetch() {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(fetchAddress(input))
    const path = url.pathname.split('/compute/')[1]
    if (path === 'task-types') return Response.json([{ taskType: image.taskType, capabilityId: image.capabilityId,
      requiredParams: [], acceptedInputKinds: ['inline'], canQuoteInline: true }])
    if (path === 'plans' && init?.method === 'POST') return Response.json({ id: PLAN, authorization: 'pending', workloadId: null })
    if (path === 'plans/confirm') return Response.json({ id: PLAN, authorization: 'approved', workloadId: null })
    if (path === 'plans/quote') return Response.json({ planId: PLAN, capabilityId: image.capabilityId,
      quoteId: QUOTE, taskType: image.taskType, recommendedBudget: '0.75', currency: 'CNY',
      balanceEnough: true, expiresAt: Math.floor(Date.now() / 1000) + 120 })
    if (path === 'plans/confirm-quoted') return Response.json({ id: PLAN, workloadId: 'workload_123' })
    if (path === 'plans') return Response.json([{ id: PLAN, workloadId: 'workload_123' }])
    if (path === 'workload') return Response.json({ id: 'workload_123', status: 'DONE', resultAvailable: true })
    if (path === 'workload/result') return Response.json({ id: 'workload_123', status: 'DONE',
      inlineOutput: '本次任务的结果', artifactRef: null })
    throw new Error(`Unexpected Host route: ${path}`)
  })
}

it('calling mode keeps ordinary dialogue and claims @ requests into the same Session quote/result flow', async () => {
  const fetcher = hostFetch()
  vi.stubGlobal('fetch', fetcher)
  // Import after installing the Host carrier so the production component uses this isolated fetch.
  const { registerConversationMarketCalls } = await import('../src/client/conversation-market-entry.ts')
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ 'conversation.content.entries': { kind: 'list', scope: 'session' },
    'conversation.chat.timelineEntry': { kind: 'keyed', scope: 'session' } })
  let timelineProvider!: ChatTimelineEntryProvider
  runtime.ctx.provide('chatTimelineEntries', { register: (provider) => {
    timelineProvider = provider
    return () => {}
  } })
  await runtime.sessions.add({ id: 'market-session-1', summary: { projectionValues: { agentPreset: 'qianshou-call' } } })
  await runtime.sessions.add({ id: 'market-session-2' })
  using first = runtime.sessions.retain('market-session-1' as SessionId)
  using second = runtime.sessions.retain('market-session-2' as SessionId)
  await Promise.all([first.ready, second.ready])
  let callCapability!: ReturnType<typeof registerConversationMarketCalls>
  const recordDispatch = vi.fn().mockResolvedValue(undefined)
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [image] },
  }) })
  await runtime.mount({ inject: ['slots', 'sessions', 'locale'], apply: (ctx) => {
    callCapability = registerConversationMarketCalls(ctx, { catalog: capabilities.store,
      reloadCatalog: () => capabilities.ensureLoaded(),
      readOwner: async () => 167, usage: { recordDispatch } })
  } })
  const reportPresence = vi.fn()
  const owner = { reportPresence } as never
  const dock = runtime.renderSlot('conversation.content.entries', owner, { session: first })
  const source = createMarketMentionSource({ capabilities,
    callCapability: (session, capability, goal) => callCapability(session, capability, goal) })
  const controller = new InputTriggerController({ actx: first.binding.ctx, sessionId: first.sessionId,
    roster: { sources: trigger => trigger === '@' ? [source] : [], all: () => [source] } })
  const modelSink = vi.fn().mockResolvedValue({ kind: 'success' })
  const shell = new SessionInputShell({ actx: first.binding.ctx, inputTriggers: () => controller,
    defaultSink: modelSink, commandAttachments: {
      serialize: async () => [], release: () => {}, unsupportedNotice: () => '不支持附件',
    } })
  try {
    act(() => { shell.setDraft('你好，介绍一下千手'); shell.submit() })
    await waitFor(() => { expect(modelSink).toHaveBeenCalledTimes(1) })
    await waitFor(() => { expect(shell.snapshot.draft).toBe('') })
    expect(timelineProvider.read(first.sessionId)).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
    modelSink.mockClear()
    act(() => { shell.setDraft('@官方出图\u00a0一个小猫'); shell.submit() })
    await waitFor(() =>{  expect(shell.snapshot.draft).toBe('') })
    const entry = timelineProvider.read(first.sessionId)[0]
    if (entry === undefined) throw new Error('market request did not enter the timeline')
    const timelineOwner = { sourceId: timelineProvider.id, entryId: entry.id, createdAt: entry.createdAt }
    const timeline = runtime.renderSlot('conversation.chat.timelineEntry', timelineOwner,
      { session: first, entryKey: timelineProvider.id })
    await timeline.view.findByText('本次执行价 ¥0.75')
    expect(reportPresence).toHaveBeenCalledWith('qianshou-market-calls', true)
    expect(modelSink).not.toHaveBeenCalled()
    expect(dock.container.textContent).not.toContain('@官方出图')
    expect(timeline.container.textContent).toContain('@官方出图 一个小猫')
    expect(timeline.container.querySelector('[data-conversation-market-calls]')?.getAttribute('data-conversation-market-calls'))
      .toBe(first.sessionId)
    expect(fetcher.mock.calls.some(([url]) => fetchAddress(url).includes('confirm-quoted'))).toBe(false)
    expect(recordDispatch).not.toHaveBeenCalled()
    const store = runtime.storeOf('conversation.content.entries', first)
    expect(runtime.storeOf('conversation.chat.timelineEntry', first)).toBe(store)
    const calls = (store.getSnapshot() as { calls: ConversationMarketCall[] }).calls
    expect(calls[0]).toMatchObject({ sessionId: first.sessionId, goal: '一个小猫', usageOwner: 167,
      continuation: { planId: PLAN, workloadId: null, submission: 'idle', amountYuan: '0.75' } })
    act(() => { capabilities.store.set({ capabilities: [image], loaded: true, loading: true, error: false }) })
    expect(timeline.view.getByRole('button', { name: '确认价格并派单' })).toHaveProperty('disabled', true)
    expect(timeline.container.textContent).toContain('@官方出图 一个小猫')
    act(() => { capabilities.store.set({ capabilities: [image], loaded: true, loading: false, error: true }) })
    expect(timeline.view.getByRole('button', { name: '确认价格并派单' })).toHaveProperty('disabled', true)
    expect(callCapability({ sessionId: first.sessionId }, image, '旧入口不得新派单')).toBe(false)
    expect(timelineProvider.read(first.sessionId)).toHaveLength(1)
    act(() => { capabilities.store.set({ capabilities: [{ ...image, capabilityId: 'other-provider' }],
      loaded: true, loading: false, error: false }) })
    expect(timeline.view.getByRole('button', { name: '确认价格并派单' })).toHaveProperty('disabled', true)
    act(() => { capabilities.store.set({ capabilities: [image], loaded: true, loading: false, error: false }) })
    fireEvent.click(timeline.view.getByRole('button', { name: '确认价格并派单' }))
    await timeline.view.findByText('本次任务的结果')
    expect(recordDispatch).toHaveBeenCalledExactlyOnceWith(image.taskType, 'workload_123', 167)
    expect((store.getSnapshot() as { calls: ConversationMarketCall[] }).calls[0]?.continuation)
      .toMatchObject({ planId: PLAN, workloadId: 'workload_123', submission: 'submitted' })
    act(() => { capabilities.store.set({ capabilities: [], loaded: true, loading: false, error: true }) })
    dock.update(owner, { session: second })
    timeline.update(timelineOwner, { session: second, entryKey: timelineProvider.id })
    expect(timeline.container.textContent).not.toContain('@官方出图')
    expect(dock.container.textContent).not.toContain('@官方出图')
    expect((runtime.storeOf('conversation.content.entries', second).getSnapshot() as { calls: unknown[] }).calls).toEqual([])
    dock.update(owner, { session: first })
    const restoredTimeline = runtime.renderSlot('conversation.chat.timelineEntry', timelineOwner,
      { session: first, entryKey: timelineProvider.id })
    await restoredTimeline.view.findByText('本次任务的结果')
    expect(fetcher.mock.calls.filter(([url]) => fetchAddress(url).includes('confirm-quoted'))).toHaveLength(1)
    expect(recordDispatch).toHaveBeenCalledTimes(1)
    act(() => { capabilities.store.set({ capabilities: [image], loaded: true, loading: false, error: false }) })
    act(() => { expect(callCapability({ sessionId: first.sessionId }, image, '返回后继续使用')).toBe(true) })
    expect(timelineProvider.read(first.sessionId)).toHaveLength(2)
    const saved = JSON.parse(localStorage.getItem(`qianshou.market-calls.${first.sessionId}`) ?? '{}') as { calls: ConversationMarketCall[] }
    expect(saved.calls[0])
      .toMatchObject({ sessionId: first.sessionId, continuation: { workloadId: 'workload_123', submission: 'submitted' } })
  } finally {
    shell.dispose(); controller.dispose(); capabilities.dispose(); await runtime.dispose()
  }
})

it('records a product selected from the market after its conversation Session becomes visible', async () => {
  const { registerConversationMarketCalls } = await import('../src/client/conversation-market-entry.ts')
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ 'conversation.content.entries': { kind: 'list', scope: 'session' },
    'conversation.chat.timelineEntry': { kind: 'keyed', scope: 'session' } })
  let timelineProvider!: ChatTimelineEntryProvider
  runtime.ctx.provide('chatTimelineEntries', { register: (provider) => {
    timelineProvider = provider
    return () => {}
  } })
  await runtime.sessions.add({ id: 'selected-product-session' })
  using held = runtime.sessions.retain('selected-product-session' as SessionId)
  await held.ready
  const selectedProduct = { productId: 'product-1', publicationId: 'publication-1',
    ownerId: 167, version: '1.2', salePriceYuan: '6.20', availableToPurchase: true }
  const listed = { ...image, products: [selectedProduct] }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [listed] },
  }) })
  await capabilities.ensureLoaded()
  let callCapability!: ReturnType<typeof registerConversationMarketCalls>
  await runtime.mount({ inject: ['slots', 'sessions', 'locale'], apply: (ctx) => {
    callCapability = registerConversationMarketCalls(ctx, { catalog: capabilities.store,
      reloadCatalog: () => capabilities.ensureLoaded(), readOwner: async () => 167,
      usage: { recordDispatch: vi.fn().mockResolvedValue(undefined) } })
  } })
  try {
    expect(callCapability({ sessionId: held.sessionId }, listed, '', undefined, selectedProduct)).toBe(true)
    expect(timelineProvider.read(held.sessionId)).toEqual([])
    runtime.renderSlot('conversation.content.entries', { reportPresence: vi.fn() } as never, { session: held })
    await waitFor(() => { expect(timelineProvider.read(held.sessionId)).toHaveLength(1) })
    expect((runtime.storeOf('conversation.content.entries', held).getSnapshot() as {
      calls: ConversationMarketCall[] }).calls[0]?.selectedProduct).toEqual({
      productId: 'product-1', publicationId: 'publication-1', ownerId: 167, version: '1.2',
    })
  } finally { capabilities.dispose(); await runtime.dispose() }
})

it('persists a local video draft without a callable Shanghai catalog and never upgrades its identity', async () => {
  const { registerConversationMarketCalls } = await import('../src/client/conversation-market-entry.ts')
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ 'conversation.content.entries': { kind: 'list', scope: 'session' },
    'conversation.chat.timelineEntry': { kind: 'keyed', scope: 'session' } })
  let timelineProvider!: ChatTimelineEntryProvider
  runtime.ctx.provide('chatTimelineEntries', { register: (provider) => {
    timelineProvider = provider
    return () => {}
  } })
  await runtime.sessions.add({ id: 'video-draft-session' })
  using held = runtime.sessions.retain('video-draft-session' as SessionId)
  await held.ready
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockRejectedValue(
    new Error('Shanghai unavailable')) })
  let callCapability!: ReturnType<typeof registerConversationMarketCalls>
  await runtime.mount({ inject: ['slots', 'sessions', 'locale'], apply: (ctx) => {
    callCapability = registerConversationMarketCalls(ctx, { catalog: capabilities.store,
      reloadCatalog: () => capabilities.ensureLoaded(), readOwner: async () => 167,
      usage: { recordDispatch: vi.fn().mockResolvedValue(undefined) } })
  } })
  try {
    expect(callCapability({ sessionId: held.sessionId }, videoDraftCapability,
      '海边小狗奔跑', undefined, undefined, true)).toBe(true)
    runtime.renderSlot('conversation.content.entries', { reportPresence: vi.fn() } as never, { session: held })
    const store = runtime.storeOf('conversation.content.entries', held)
    await waitFor(() => { expect((store.getSnapshot() as { calls: ConversationMarketCall[] }).calls).toHaveLength(1) })
    const [call] = (store.getSnapshot() as { calls: ConversationMarketCall[] }).calls
    expect(call).toMatchObject({ goal: '海边小狗奔跑', draftOnly: true, directVideoEntry: true,
      continuation: { planId: null, workloadId: null, submission: 'idle' } })
    expect(isConversationMarketCall(call, held.sessionId)).toBe(true)
    const entry = timelineProvider.read(held.sessionId)[0]
    if (entry === undefined) throw new Error('missing video draft timeline entry')
    const timeline = runtime.renderSlot('conversation.chat.timelineEntry', {
      sourceId: timelineProvider.id, entryId: entry.id, createdAt: entry.createdAt,
    }, { session: held, entryKey: timelineProvider.id })
    expect(timeline.view.getByRole('status').textContent).toContain('需求已保留在本对话')
    expect(timeline.view.queryByRole('textbox')).toBeNull()
    expect(timeline.view.queryByRole('button', { name: '专业出片' })).toBeNull()
    expect((store.getSnapshot() as { calls: ConversationMarketCall[] }).calls[0]?.goal).toBe('海边小狗奔跑')
    expect((store.getSnapshot() as { calls: ConversationMarketCall[] }).calls[0]?.continuation.draft)
      .toBeUndefined()
    act(() => { capabilities.store.set({ capabilities: [{ ...image, taskType: 'video_generate',
      capabilityId: 'video.render', category: 'video' }], loaded: true, loading: false, error: false }) })
    expect((store.getSnapshot() as { calls: ConversationMarketCall[] }).calls[0]?.draftOnly).toBe(true)
  } finally { capabilities.dispose(); await runtime.dispose() }
})

it('keeps the original draft when a market claim cannot record its Session card', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [image] },
  }) })
  const source = createMarketMentionSource({ capabilities, callCapability: () => false })
  const session = { sessionId: 'missing-session' as SessionId }
  const actx = {} as never
  const controller = new InputTriggerController({ actx, sessionId: session.sessionId,
    roster: { sources: () => [source], all: () => [source] } })
  const modelSink = vi.fn().mockResolvedValue({ kind: 'success' })
  const shell = new SessionInputShell({ actx, inputTriggers: () => controller, defaultSink: modelSink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' } })
  try {
    shell.setDraft('@官方出图 一个小猫')
    shell.submit()
    await waitFor(() =>{  expect(shell.notices.getSnapshot()?.text).toContain('当前会话尚未准备好') })
    expect(shell.snapshot.draft).toBe('@官方出图 一个小猫')
    expect(modelSink).not.toHaveBeenCalled()
  } finally { shell.dispose(); controller.dispose(); capabilities.dispose() }
})

it('keeps a blocked video prompt and its first-frame attachment in the composer without model or upload calls', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [] },
  }) })
  const call = vi.fn()
  const prepareAttachments = vi.fn()
  const source = createMarketMentionSource({ capabilities, callCapability: call,
    callVideoDraft: call, prepareAttachments })
  const actx = {} as never
  const controller = new InputTriggerController({ actx, sessionId: 'video-attachment-session' as SessionId,
    roster: { sources: () => [source], all: () => [source] } })
  const modelSink = vi.fn().mockResolvedValue({ kind: 'success' })
  const release = vi.fn()
  const serialize = vi.fn().mockResolvedValue([{ type: 'image', mediaType: 'image/png', data: 'image-bytes' }])
  const shell = new SessionInputShell({ actx, inputTriggers: () => controller, defaultSink: modelSink,
    commandAttachments: { serialize, release, unsupportedNotice: () => '' } })
  const attachment = 'video-first-frame' as Parameters<typeof shell.addAttachments>[0][number]
  const draft = '@出视频 用这张图做首帧，竖屏，8 秒'
  try {
    shell.setDraft(draft)
    shell.addAttachments([attachment])
    shell.submit()
    await waitFor(() => { expect(shell.notices.getSnapshot()?.text).toContain('需求和附件已保留在输入框') })
    expect(shell.snapshot.draft).toBe(draft)
    expect(shell.snapshot.attachmentIds).toEqual([attachment])
    expect(release).not.toHaveBeenCalled()
    expect(serialize).not.toHaveBeenCalled()
    expect(prepareAttachments).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
    expect(modelSink).not.toHaveBeenCalled()
  } finally { shell.dispose(); controller.dispose(); capabilities.dispose() }
})

it.each(['@市场/', '@市场/视频/', '@市场/ 帮我找 SVG 转视频'])('keeps the market namespace out of the model and filesystem sink: %s', async (draft) => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [image] },
  }) })
  const call = vi.fn()
  const source = createMarketMentionSource({ capabilities, callCapability: call })
  const actx = {} as never
  const controller = new InputTriggerController({ actx, sessionId: 'directory-session' as SessionId,
    roster: { sources: () => [source], all: () => [source] } })
  const modelSink = vi.fn().mockResolvedValue({ kind: 'success' })
  const shell = new SessionInputShell({ actx, inputTriggers: () => controller, defaultSink: modelSink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => '' } })
  try {
    shell.setDraft(draft)
    shell.submit()
    await waitFor(() => { expect(shell.notices.getSnapshot()?.text).toContain('选择一个具体能力') })
    expect(shell.snapshot.draft).toBe(draft)
    expect(modelSink).not.toHaveBeenCalled()
    expect(call).not.toHaveBeenCalled()
  } finally { shell.dispose(); controller.dispose(); capabilities.dispose() }
})

it('records the request while optional account state is pending and retires its late writer on unload', async () => {
  vi.stubGlobal('fetch', hostFetch())
  const { registerConversationMarketCalls } = await import('../src/client/conversation-market-entry.ts')
  const runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.ctx.slots.installLocale(locale)
  await runtime.declare({ 'conversation.content.entries': { kind: 'list', scope: 'session' },
    'conversation.chat.timelineEntry': { kind: 'keyed', scope: 'session' } })
  let timelineProvider!: ChatTimelineEntryProvider
  runtime.ctx.provide('chatTimelineEntries', { register: (provider) => {
    timelineProvider = provider
    return () => {}
  } })
  await runtime.sessions.add({ id: 'pending-account-session' })
  using session = runtime.sessions.retain('pending-account-session' as SessionId)
  await session.ready
  let resolveOwner!: (owner: number | null) => void
  const account = new Promise<number | null>((resolve) => { resolveOwner = resolve })
  let preview!: WorkspaceSessionPreviewProvider
  const notify = vi.fn()
  const unregistered = vi.fn()
  runtime.ctx.provide('uiWorkspace', { registerSessionPreview: (provider: WorkspaceSessionPreviewProvider) => {
    preview = provider
    const stop = provider.subscribe(notify)
    return () => { stop(); unregistered() }
  } } as unknown as UiWorkspace)
  let submit!: ReturnType<typeof registerConversationMarketCalls>
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [image] },
  }) })
  await capabilities.reload()
  const feature = await runtime.mount({ inject: ['slots', 'sessions', 'locale'], apply: (ctx) => {
    submit = registerConversationMarketCalls(ctx, {
      catalog: capabilities.store,
      reloadCatalog: () => capabilities.ensureLoaded(),
      readOwner: () => account, usage: { recordDispatch: vi.fn().mockResolvedValue(undefined) },
    })
  } })
  runtime.renderSlot('conversation.content.entries', { reportPresence: vi.fn() } as never, { session })
  try {
    act(() => { expect(submit({ sessionId: session.sessionId }, image, '保留这条需求')).toBe(true) })
    const calls = (runtime.storeOf('conversation.content.entries', session).getSnapshot() as { calls: ConversationMarketCall[] }).calls
    expect(calls).toHaveLength(1)
    expect(timelineProvider.read(session.sessionId)).toHaveLength(1)
    expect(calls[0]).toMatchObject({ goal: '保留这条需求' })
    expect(calls[0]?.usageOwner).toBeUndefined()
    expect(preview.read(session.sessionId)).toMatchObject({ kind: 'content', title: '@官方出图 保留这条需求' })
    expect(notify).toHaveBeenCalledExactlyOnceWith(session.sessionId)
    await feature.dispose()
    expect(unregistered).toHaveBeenCalledTimes(1)
    resolveOwner(167)
    await account
    await Promise.resolve()
    const saved = JSON.parse(localStorage.getItem(`qianshou.market-calls.${session.sessionId}`) ?? '{}') as { calls: ConversationMarketCall[] }
    expect(saved.calls).toHaveLength(1)
    expect(saved.calls[0]?.usageOwner).toBeUndefined()
    expect(preview.read(session.sessionId)).toBeNull()
    expect(notify).toHaveBeenCalledTimes(1)
    expect(submit({ sessionId: session.sessionId }, image, '不能写入旧组件')).toBe(false)
  } finally { capabilities.dispose(); await runtime.dispose() }
})

it('rehydrates Session metadata into a new store instance and refuses foreign or malformed saved rows', () => {
  const sessionId = 'persisted-market-session' as SessionId
  const call: ConversationMarketCall = { id: 'market-call-11111111-1111-4111-8111-111111111111',
    sessionId, createdAt: new Date().toISOString(), capability: image, goal: '一个小猫',
    continuation: { planId: PLAN, workloadId: null, submission: 'idle' } }
  const original = createConversationMarketStore().create(sessionId)
  original.actions.addCall(call)
  original.actions.continueCall(call.id, { planId: PLAN, workloadId: null, submission: 'uncertain', amountYuan: '0.75',
    draft: { goal: '一个小猫', input: { prompt: '一个小猫' }, params: {} } })
  const restarted = createConversationMarketStore().create(sessionId)
  const restored = restarted.store.getSnapshot().calls[0]!
  expect(restored).toMatchObject({ goal: '一个小猫',
    continuation: { planId: PLAN, workloadId: null, submission: 'uncertain', amountYuan: '0.75' } })
  expect(isConversationMarketCall(restored, sessionId)).toBe(true)
  expect(isConversationMarketCall({ ...restored, usageOwner: 167 }, sessionId)).toBe(true)
  expect(isConversationMarketCall({ ...restored, usageOwner: 0 }, sessionId)).toBe(false)
  expect(isConversationMarketCall(restored, 'other-session' as SessionId)).toBe(false)
  expect(isConversationMarketCall({ ...restored, continuation: { ...restored.continuation, planId: null } }, sessionId)).toBe(false)
  expect(isConversationMarketCall({ ...restored, continuation: { ...restored.continuation,
    draft: { goal: 'x', input: { prompt: 'x'.repeat(16385) }, params: {} } } }, sessionId)).toBe(false)
  expect(createConversationMarketStore().create('other-session').store.getSnapshot().calls).toEqual([])
})
