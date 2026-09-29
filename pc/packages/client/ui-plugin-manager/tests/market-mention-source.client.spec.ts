import { expect, it, vi } from 'vitest'
import { createMarketMentionSource } from '../src/client/market-mention-source.ts'
import { categoryLabel } from '../src/client/market-mention-source.ts'
import { MarketCapabilitiesController } from '../src/client/market-capabilities-controller.ts'
import { MarketUsageController } from '../src/client/market-usage.ts'
import { zh as imageTrialCopy } from '../src/client/image-trial-locales.ts'
import type { MarketTaskType } from '../src/client/market-task-transport.ts'
import type { SubmitAttachment } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

const product = {
  taskType: 'legal_term_scan_v1', capabilityId: 'text.transform', name: '法律术语扫描',
  description: '标出文本中的易混术语', category: 'legal', version: '1.0.0',
  categoryLabelZh: '法律', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
  requiredParams: [], outputKind: 'inline', contractVersion: 'task-registry.v1',
  publisherKind: 'user' as const, publisherKinds: ['user' as const], executionMode: 'device' as const,
  availability: 'contract_ready' as const, requiresQuote: true as const,
  executionQuotePath: '/api/v8/developer/tasks/estimate' as const, currency: 'CNY' as const, products: [],
}

function reviewedVideoForm(taskType: string): MarketTaskType {
  const publicationId = '11111111-2222-4333-8444-555555555555'
  return { taskType, capabilityId: 'video.render', acceptedInputKinds: ['multi_file'],
    requiredParams: ['input_manifest', 'prompt'], canQuoteInline: false, canQuoteFiles: true,
    paramFields: [{ name: 'prompt', title: '视频描述', type: 'string', required: true }],
    reviewedVideoInput: { schema: 'qianshou.reviewed-video-task-input.v1', publicationId,
      approvedContractDigest: `sha256:${'a'.repeat(64)}`, firstFrameSlot: 'first_frame',
      promptSlot: 'prompt', firstFrameManifestParam: 'input_manifest', firstFrameManifestIndex: 0,
      promptParam: 'prompt', mimeType: 'image/png', maxBytes: 16 * 1024 * 1024,
      maxPromptUtf8Bytes: 8192 },
    reviewedPublication: { schema: 'qianshou.reviewed-publication-selection.v1', publicationId,
      artifactDigest: `sha256:${'b'.repeat(64)}`, contractSha256: `sha256:${'c'.repeat(64)}` } }
}

it('finds any approved market category through @ and keeps its token in the conversation', async () => {
  const remote = { orderAdapterCapabilities: vi.fn().mockResolvedValue({ ok: true, value: { capabilities: [product] } }) }
  const capabilities = new MarketCapabilitiesController(remote)
  const callCapability = vi.fn().mockReturnValue(true)
  const source = createMarketMentionSource({ capabilities, callCapability })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const query = { query: '法律', position: 'inline' as const, drilled: false, signal: new AbortController().signal }
  const [candidate] = await source.candidates(session, query)
  expect(remote.orderAdapterCapabilities).toHaveBeenCalledOnce()
  expect(candidate).toMatchObject({ name: 'legal_term_scan_v1', label: '法律术语扫描',
    section: '市场 · 法律', value: 'market:capability:legal_term_scan_v1' })
  expect(await source.candidates(session, { ...query, query: '扫描' })).toHaveLength(1)
  expect(remote.orderAdapterCapabilities).toHaveBeenCalledOnce()
  const picked = source.onPick({ candidate: candidate!, session, position: 'inline', action: 'pick', via: 'menu',
    span: {} as never })
  expect(picked).toEqual({ text: '@法律术语扫描 ' })
  expect(callCapability).not.toHaveBeenCalled()
  capabilities.dispose()
})

it('does not turn unavailable or stale market listings into a dispatch instruction', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: false, error: { message: 'order-product-unavailable' },
  }) })
  const source = createMarketMentionSource({ capabilities, callCapability: vi.fn() })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const browse = await source.candidates(session, { query: '', position: 'leading', drilled: false,
    signal: new AbortController().signal })
  expect(browse).toMatchObject([{ label: '选择市场能力', value: 'market:browse', drill: true }])
  expect(source.onPick({ candidate: browse[0]!, session, position: 'leading', action: 'pick',
    via: 'menu', span: {} as never })).toEqual({ text: '@市场/', continue: true })
  expect(source.onPick({ candidate: { name: 'stale', value: `market:capability:${product.taskType}` }, session, position: 'leading',
    action: 'pick', via: 'menu', span: {} as never })).toBeUndefined()
  capabilities.dispose()
})

it('uses Chinese market groups across capability types without treating unknown kinds as video', () => {
  expect(categoryLabel('presentation')).toBe('PPT')
  expect(categoryLabel('legal')).toBe('法律')
  expect(categoryLabel('finance')).toBe('财务')
  expect(categoryLabel('custom-domain')).toBe('其他 · custom-domain')
  expect(categoryLabel('world-building', '虚拟世界')).toBe('虚拟世界')
})

it('opens a Chinese category before showing its published goods', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [product] },
  }) })
  const source = createMarketMentionSource({ capabilities, callCapability: vi.fn() })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const req = { query: '', position: 'leading' as const, drilled: false,
    signal: new AbortController().signal }
  const root = await source.candidates(session, req)
  const category = root.find(item => item.value === 'market:category:法律')
  expect(category).toMatchObject({ label: '法律', drill: true, section: '市场分类' })
  expect(source.onPick({ candidate: category!, session, position: 'leading', action: 'drill',
    via: 'menu', span: {} as never })).toEqual({ text: '@市场/法律/', continue: true })
  expect(source.header?.(session, { query: '市场/法律/', drilled: true })).toMatchObject([
    { label: '市场' }, { label: '法律', current: true },
  ])
  expect(await source.candidates(session, { ...req, query: '市场/法律/' })).toMatchObject([
    { label: '法律术语扫描', value: 'market:capability:legal_term_scan_v1' },
  ])
  capabilities.dispose()
})

it('shows a verified official image ability in the same market list and asks what to draw in its task form', async () => {
  const image = { ...product, taskType: 'image_generate_v1', capabilityId: 'image.generate',
    name: '官方出图', description: '按文字生成图片', category: 'image', categoryLabelZh: '图片',
    publisherKind: 'official' as const, publisherKinds: ['official' as const], executionMode: 'cloud' as const }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [image] },
  }) })
  const callCapability = vi.fn().mockReturnValue(true)
  const source = createMarketMentionSource({ capabilities, callCapability })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const [candidate] = await source.candidates(session, { query: '官方出图', position: 'inline', drilled: false,
    signal: new AbortController().signal })
  expect(candidate).toMatchObject({ label: '官方出图', section: '市场 · 图片',
    value: 'market:capability:image_generate_v1' })
  expect(source.onPick({ candidate: candidate!, session, position: 'inline', action: 'pick', via: 'menu', span: {} as never }))
    .toEqual({ text: '@官方出图 ' })
  expect(callCapability).not.toHaveBeenCalled()
  capabilities.dispose()
})

it('limits the call preset to two fixed entries and binds @出图 to the current official quote contract', async () => {
  const image = { ...product, taskType: 'image_generate_v1', capabilityId: 'image.generate',
    name: '官方图片服务', description: '按文字生成图片', category: 'image', categoryLabelZh: '图片',
    publisherKind: 'official' as const, publisherKinds: ['official' as const], executionMode: 'device' as const }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [product, image] },
  }) })
  const callCapability = vi.fn().mockReturnValue(true)
  const source = createMarketMentionSource({ capabilities, callCapability, callingMode: () => true,
    callVideoDraft: vi.fn().mockReturnValue(true) })
  const session = { sessionId: 'calling-session' } as Parameters<typeof source.candidates>[0]
  const options = { query: '', position: 'leading' as const, drilled: false,
    signal: new AbortController().signal }
  const choices = await source.candidates(session, options)
  expect(choices.map(row => row.label)).toEqual(['出图', '出视频'])
  expect(await source.candidates(session, { ...options, query: '法律' })).toEqual([])
  const picked = source.onPick({ candidate: choices[0]!, session, position: 'leading', action: 'pick',
    via: 'menu', span: {} as never })
  expect(picked).toMatchObject({ claim: { token: '@出图 ', attachments: false } })
  if (!picked || typeof picked === 'string' || !('claim' in picked)) throw new Error('expected claim')
  expect(await picked.claim.submit('一只橘猫', {} as never, [])).toEqual({ kind: 'success' })
  expect(callCapability).toHaveBeenCalledExactlyOnceWith(session, image, '一只橘猫')
  expect(await source.matchEnter?.(session, '@出图 一只橘猫', new AbortController().signal,
    { attachments: 0 })).toMatchObject({ claim: { token: '@出图 ' } })
  await expect(source.matchEnter?.(session, '@官方图片服务 一只橘猫', new AbortController().signal,
    { attachments: 0 })).rejects.toThrow('调用模式当前只开放')
  capabilities.store.set({ capabilities: [product, { ...image, availability: 'paused', executionQuotePath: null }],
    loaded: true, loading: false, error: false })
  expect(await picked.claim.submit('一只橘猫', {} as never, [])).toMatchObject({ kind: 'error' })
  expect(callCapability).toHaveBeenCalledTimes(1)
  capabilities.dispose()
})

it('keeps @出图 visible but refuses a quote when no unique official execution contract exists', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [product] },
  }) })
  const callCapability = vi.fn()
  const source = createMarketMentionSource({ capabilities, callCapability, callingMode: () => true,
    callVideoDraft: vi.fn().mockReturnValue(true) })
  const session = { sessionId: 'calling-session' } as Parameters<typeof source.candidates>[0]
  const [choice] = await source.candidates(session, { query: '出图', position: 'leading', drilled: false,
    signal: new AbortController().signal })
  expect(choice).toMatchObject({ label: '出图', value: 'market:image-entry' })
  const picked = source.onPick({ candidate: choice!, session, position: 'leading', action: 'pick',
    via: 'menu', span: {} as never })
  if (!picked || typeof picked === 'string' || !('claim' in picked)) throw new Error('expected claim')
  expect(await picked.claim.submit('一只橘猫', {} as never, [])).toMatchObject({ kind: 'error',
    text: expect.stringContaining('不能报价或派单') as unknown })
  expect(callCapability).not.toHaveBeenCalled()
  capabilities.dispose()
})

it('routes @出视频 only to a reviewed first-frame task without uploading composer attachments', async () => {
  const video = { ...product, taskType: 'comfy_video_graph_v1', capabilityId: 'video.render',
    name: '已审核视频生成', description: '根据首帧和描述生成视频', category: 'video', categoryLabelZh: '视频',
    acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file', outputKind: 'artifact' }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [video] },
  }) })
  const callCapability = vi.fn().mockReturnValue(true)
  const callVideoDraft = vi.fn().mockReturnValue(true)
  const prepareAttachments = vi.fn()
  let forms = [reviewedVideoForm(video.taskType)]
  const source = createMarketMentionSource({ capabilities, callCapability, callVideoDraft, prepareAttachments,
    videoTaskTypes: async () => forms })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const [choice] = await source.candidates(session, { query: '出视频', position: 'leading', drilled: false,
    signal: new AbortController().signal })
  expect(choice).toMatchObject({ label: '出视频', value: 'market:capability:comfy_video_graph_v1' })
  const picked = source.onPick({ candidate: choice!, session, position: 'leading', action: 'pick', via: 'menu',
    span: {} as never })
  expect(picked).toMatchObject({ claim: { token: '@出视频 ', attachments: false,
    hint: expect.stringContaining('秒数、画质和横竖屏') as unknown } })
  expect(source.matchSpace?.(session, '@出视频')).toMatchObject({ claim: { token: '@出视频 ' } })
  expect(await source.matchEnter?.(session, '@出视频 海边的小狗奔跑', new AbortController().signal,
    { attachments: 0 })).toMatchObject({ claim: { token: '@出视频 ' } })
  if (!picked || typeof picked === 'string' || !('claim' in picked)) throw new Error('expected claim')
  expect(await picked.claim.submit('海边的小狗奔跑', {} as never, [])).toEqual({ kind: 'success' })
  expect(callCapability).toHaveBeenCalledWith(session, video, '海边的小狗奔跑', undefined, true)
  expect(callVideoDraft).not.toHaveBeenCalled()
  await expect(source.matchEnter?.(session, '@出视频 海边的小狗奔跑', new AbortController().signal,
    { attachments: 1 })).rejects.toThrow('视频调用暂未开放')
  expect(prepareAttachments).not.toHaveBeenCalled()
  forms = [forms[0]!, reviewedVideoForm('video_render_v2')]
  capabilities.store.set({ capabilities: [video, { ...video, taskType: 'video_render_v2',
    name: '另一项视频生成', acceptedInputKinds: ['multi_file'] }], loaded: true, loading: false, error: false })
  expect(await picked.claim.submit('海边的小狗奔跑', {} as never, []))
    .toMatchObject({ kind: 'error' })
  expect(callCapability).toHaveBeenCalledTimes(1)
  capabilities.dispose()
})

it('opens only a local @出视频 draft while Shanghai has no callable video supply', async () => {
  const video = { ...product, taskType: 'video_generate', capabilityId: 'video.render',
    name: '视频生成', category: 'video', categoryLabelZh: '视频', availability: 'unavailable' as const,
    executionQuotePath: null, products: [] }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [video] },
  }) })
  const callCapability = vi.fn()
  const callVideoDraft = vi.fn().mockReturnValue(true)
  const source = createMarketMentionSource({ capabilities, callCapability, callVideoDraft })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const [choice] = await source.candidates(session, { query: '出视频', position: 'leading', drilled: false,
    signal: new AbortController().signal })
  expect(choice).toMatchObject({ label: '出视频', value: 'market:video-draft' })
  expect(choice?.description).toContain('秒数、画质和横竖屏')
  expect(choice?.description).toContain('自动成片暂未接通')
  expect(choice?.description).not.toContain('首帧')
  const picked = source.onPick({ candidate: choice!, session, position: 'leading', action: 'pick', via: 'menu',
    span: {} as never })
  if (!picked || typeof picked === 'string' || !('claim' in picked)) throw new Error('expected claim')
  expect(picked.claim.hint).toContain('秒数、画质和横竖屏')
  expect(picked.claim.hint).toContain('当前自动成片暂未接通')
  expect(await picked.claim.submit('海边小狗奔跑', {} as never, [])).toEqual({ kind: 'success' })
  expect(callVideoDraft).toHaveBeenCalledWith(session, '海边小狗奔跑')
  expect(callCapability).not.toHaveBeenCalled()
  expect(source.matchSpace?.(session, '@出视频')).toMatchObject({ claim: { token: '@出视频 ' } })
  await expect(source.matchEnter?.(session, '@出视频 海边小狗奔跑', new AbortController().signal,
    { attachments: 1 })).rejects.toThrow('视频调用暂未开放')
  capabilities.dispose()
})

it('refuses a legacy native H3 video and an unreviewed multi-file row as the short video alias', async () => {
  const video = { ...product, taskType: 'video_generate', capabilityId: 'video.render',
    name: '旧版五秒视频', category: 'video', categoryLabelZh: '视频' }
  const unreviewed = { ...video, taskType: 'unreviewed_video_v1', name: '未审核视频',
    acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file' }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [video, unreviewed] },
  }) })
  const callCapability = vi.fn().mockReturnValue(true)
  const source = createMarketMentionSource({ capabilities, callCapability,
    videoTaskTypes: async () => { const { reviewedPublication: _publication, ...form } = reviewedVideoForm(unreviewed.taskType)
      return [form] } })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  expect(await source.candidates(session, { query: '出视频', position: 'leading', drilled: false,
    signal: new AbortController().signal })).toEqual([])
  expect(source.matchSpace?.(session, '@出视频')).toBeUndefined()
  await expect(source.matchEnter?.(session, '@出视频 小猫奔跑', new AbortController().signal,
    { attachments: 0 })).rejects.toThrow('目前没有唯一可用的出视频能力')
  expect(callCapability).not.toHaveBeenCalled()
  capabilities.dispose()
})

it('never mistakes a video.render SVG chart for the @出视频 generation entry', async () => {
  const chart = { ...product, taskType: 'bar_chart_svg_v1', capabilityId: 'video.render',
    name: '柱状图', category: 'data', categoryLabelZh: '数据' }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [chart] },
  }) })
  const source = createMarketMentionSource({ capabilities, callCapability: vi.fn() })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  expect(await source.candidates(session, { query: '出视频', position: 'leading', drilled: false,
    signal: new AbortController().signal })).toEqual([])
  expect(source.matchSpace?.(session, '@出视频')).toBeUndefined()
  await expect(source.matchEnter?.(session, '@出视频 小猫奔跑', new AbortController().signal,
    { attachments: 0 })).rejects.toThrow('目前没有唯一可用的出视频能力')
  capabilities.dispose()
})

it('accepts one natural @official image request in its submitting Session with the prompt', async () => {
  const image = { ...product, taskType: 'image_generate_v1', capabilityId: 'image.generate',
    name: '官方出图', description: '按文字生成图片', category: 'image', categoryLabelZh: '图片',
    publisherKind: 'official' as const, publisherKinds: ['official' as const], executionMode: 'cloud' as const }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [image] },
  }) })
  const callCapability = vi.fn().mockReturnValue(true)
  const source = createMarketMentionSource({ capabilities, callCapability })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const [candidate] = await source.candidates(session, { query: '官方出图', position: 'leading', drilled: false,
    signal: new AbortController().signal })
  const picked = source.onPick({ candidate: candidate!, session, position: 'leading', action: 'pick', via: 'menu', span: {} as never })
  expect(picked).toMatchObject({ claim: { token: '@官方出图 ' } })
  if (!picked || typeof picked === 'string' || !('claim' in picked)) throw new Error('expected claim')
  expect(await picked.claim.submit('一只橘猫', {} as never, [])).toEqual({ kind: 'success' })
  expect(callCapability).toHaveBeenCalledWith(session, image, '一只橘猫')
  const typed = await source.matchEnter?.(session, '@官方出图 雨夜城市', new AbortController().signal, { attachments: 0 })
  expect(typed).toMatchObject({ claim: { token: '@官方出图 ' } })
  expect(source.matchSpace?.(session, '@官方出图')).toMatchObject({ claim: { token: '@官方出图 ' } })
  expect(await source.matchEnter?.(session, '@官方出图\u00a0一个小猫', new AbortController().signal, { attachments: 0 }))
    .toMatchObject({ claim: { token: '@官方出图 ' } })
  await expect(source.matchEnter?.(session, '@官方出图 雨夜城市', new AbortController().signal,
    { attachments: 1 })).rejects.toThrow('此技能当前只接受文字。附件和草稿已保留，请选择支持文件的技能。')
  capabilities.dispose()
})

it('keeps a paused official request intact and refuses it before the default model sink', async () => {
  const image = { ...product, taskType: 'image.generate', name: '官方出图', category: 'image',
    categoryLabelZh: '图片', availability: 'paused' as const, executionQuotePath: null }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [image] },
  }) })
  const callCapability = vi.fn()
  const source = createMarketMentionSource({ capabilities, callCapability })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  await expect(source.matchEnter?.(session, '@官方出图 画一只猫', new AbortController().signal,
    { attachments: 0 })).rejects.toThrow('此能力目前不能调用')
  expect(callCapability).not.toHaveBeenCalled()
  capabilities.dispose()
})

it('only offers usable conversation contracts and identifies source separately from per-task pricing', async () => {
  const unavailable = { ...product, taskType: 'monte_carlo', name: 'Monte Carlo 通用计算', formReady: false }
  const fileOnly = { ...product, taskType: 'image_compress', name: '图片压缩', acceptedInputKinds: ['single_file'] }
  const paused = { ...product, taskType: 'paused_task', name: '暂停的能力', availability: 'paused' as const }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [product, unavailable, fileOnly, paused] },
  }) })
  const callCapability = vi.fn()
  const source = createMarketMentionSource({ capabilities, callCapability })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const req = { query: '市场/法律/', position: 'leading' as const, drilled: true,
    signal: new AbortController().signal }
  const choices = await source.candidates(session, req)
  expect(choices).toHaveLength(1)
  expect(choices[0]?.description).toContain('用户市场 · 按次报价')
  expect(await source.candidates(session, { ...req, query: 'Monte Carlo' })).toEqual([])
  expect(source.onPick({ candidate: { name: unavailable.taskType,
    value: `market:capability:${unavailable.taskType}` }, session, position: 'leading',
  action: 'pick', via: 'menu', span: {} as never })).toBeUndefined()
  expect(callCapability).not.toHaveBeenCalled()
  capabilities.dispose()
})

it('places bounded account frequent/recent skills before browsing and only records real dispatch callbacks', async () => {
  const values = new Map<string, string>()
  const store = { getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) } }
  let owner: number | null = 6
  let time = 1000
  const usage = new MarketUsageController({ storage: store, readOwner: async () => owner, clock: () => time++ })
  const items = Array.from({ length: 9 }, (_, i) => ({ ...product, taskType: `task_${i}`, name: `能力${i}` }))
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: items },
  }) })
  const source = createMarketMentionSource({ capabilities, usage, callCapability: vi.fn().mockReturnValue(true) })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const request = { query: '', position: 'leading' as const, drilled: false, signal: new AbortController().signal }
  const initial = await source.candidates(session, request)
  expect(initial[0]?.value).toBe('market:browse')
  for (let i = 0; i < 9; i++) await usage.recordDispatch(`task_${i}`,
    `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`, 6)
  await usage.recordDispatch('task_0', '00000000-0000-4000-8000-000000000010', 6)
  const quick = await source.candidates(session, request)
  expect(quick[0]).toMatchObject({ label: '能力0', section: '常用能力' })
  expect(quick[1]).toMatchObject({ label: '能力8', section: '最近使用' })
  expect(quick.filter(item => item.value?.startsWith('market:capability:'))).toHaveLength(6)
  expect(quick[6]?.value).toBe('market:browse')
  const picked = source.onPick({ candidate: quick[0]!, session, position: 'leading', action: 'pick',
    via: 'menu', span: {} as never })
  if (!picked || typeof picked === 'string' || !('claim' in picked)) throw new Error('expected claim')
  const before = [...values.values()][0]
  expect(await picked.claim.submit('用户需求', {} as never, [])).toEqual({ kind: 'success' })
  expect([...values.values()][0]).toBe(before)
  owner = 7
  expect(await source.candidates(session, request)).toEqual(initial)
  owner = null
  expect(await source.candidates(session, request)).toEqual(initial)
  capabilities.dispose()
})

it('ranks textual matches before usage and puts browsing after matching skills', async () => {
  const exact = { ...product, taskType: 'image_exact', name: '猫图', description: '生成图片' }
  const prefix = { ...product, taskType: 'image_prefix', name: '猫图生成' }
  const mentions = { ...product, taskType: 'frequent_other', name: '通用生成', description: '猫图' }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [mentions, prefix, exact] },
  }) })
  const usage = { rankedTaskTypes: async () => ({ frequent: ['frequent_other', 'image_prefix'], recent: [] }) }
  const source = createMarketMentionSource({ capabilities, usage, callCapability: vi.fn() })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const req = { query: '猫图', position: 'leading' as const, drilled: false, signal: new AbortController().signal }
  expect((await source.candidates(session, req)).map(item => item.name)).toEqual([
    'image_exact', 'image_prefix', 'frequent_other',
  ])
  expect((await source.candidates(session, { ...req, query: '法律' })).map(item => item.name)).toEqual([
    'frequent_other', 'image_prefix', 'image_exact',
  ])
  const market = await source.candidates(session, { ...req, query: '市场' })
  expect(market[0]?.value).toBe('market:browse')
  capabilities.dispose()
})

it('drops missing, paused, unsupported and ambiguous history using the complete current catalog', async () => {
  const duplicate = { ...product, taskType: 'duplicate_name', name: '法律术语扫描', availability: 'paused' as const }
  const paused = { ...product, taskType: 'paused_task', name: '暂停技能', availability: 'paused' as const }
  const unsupported = { ...product, taskType: 'file_task', name: '文件技能', acceptedInputKinds: ['single_file'] }
  const good = { ...product, taskType: 'good_task', name: '合法通用服务' }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [product, duplicate, paused, unsupported, good] },
  }) })
  const usage = { rankedTaskTypes: async () => ({ frequent: ['missing_task', product.taskType, 'paused_task', 'file_task'],
    recent: ['good_task'] }) }
  const source = createMarketMentionSource({ capabilities, usage, callCapability: vi.fn() })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const req = { query: '', position: 'leading' as const, drilled: false, signal: new AbortController().signal }
  const choices = await source.candidates(session, req)
  expect(choices.filter(item => item.value?.startsWith('market:capability:'))).toMatchObject([
    { label: '合法通用服务', section: '最近使用' },
  ])
  expect(await source.candidates(session, { ...req, query: '法律术语扫描' })).toEqual([])
  capabilities.dispose()
})

it('keeps selection available on optional usage failure and honors cancellation while reading preferences', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [product] },
  }) })
  const usage = { rankedTaskTypes: vi.fn().mockRejectedValue(new Error('history unavailable')) }
  const source = createMarketMentionSource({ capabilities, usage, callCapability: vi.fn() })
  const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
  const req = { query: '法律', position: 'leading' as const, drilled: false, signal: new AbortController().signal }
  expect((await source.candidates(session, req))[0]?.name).toBe(product.taskType)
  const controller = new AbortController()
  usage.rankedTaskTypes.mockImplementation(async () => { controller.abort(); return { frequent: [], recent: [] } })
  expect(await source.candidates(session, { ...req, signal: controller.signal })).toEqual([])
  capabilities.dispose()
})

it('opens an explicitly enabled image trial in the submitting call Session without using the paid catalog', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: false, error: { message: 'catalog-unavailable' },
  }) })
  const paid = vi.fn()
  const trial = { enabled: vi.fn().mockResolvedValue(true), open: vi.fn().mockReturnValue(true), text: (key: string) => key }
  const source = createMarketMentionSource({ capabilities, callCapability: paid, callingMode: () => true, imageTrial: trial })
  const session = { sessionId: 'image-trial-session' } as Parameters<typeof source.candidates>[0]
  const match = await source.matchEnter?.(session, '@出图 外星人', new AbortController().signal, { attachments: 0 })
  if (typeof match !== 'object' || match === null || !('claim' in match)) throw new Error('expected image claim')
  expect(trial.open).not.toHaveBeenCalled()
  expect(await match.claim.submit('外星人', {} as never, [])).toEqual({ kind: 'success' })
  expect(trial.open).toHaveBeenCalledWith(session, '外星人', 'landscape')
  expect(paid).not.toHaveBeenCalled()
  capabilities.dispose()
})
it('keeps disabled or unreadable free image trials out of the paid catalog without submitting', async () => {
  const image = { ...product, taskType: 'image_generate_v1', capabilityId: 'image.generate',
    name: '官方图片服务', category: 'image', publisherKind: 'official' as const,
    publisherKinds: ['official' as const] }
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [image] },
  }) })
  const paid = vi.fn()
  const formal = { enabled: vi.fn(async () => false), open: vi.fn(), text: (key: string) => key }
  const trial = { enabled: vi.fn().mockResolvedValue(false), open: vi.fn(),
    text: (key: keyof typeof imageTrialCopy) => imageTrialCopy[key] }
  const source = createMarketMentionSource({ capabilities, callCapability: paid,
    callingMode: () => true, imageTrial: trial, formalMedia: formal })
  const session = { sessionId: 'image-session' } as Parameters<typeof source.candidates>[0]
  for (const failure of [false, true]) {
    if (failure) trial.enabled.mockRejectedValue(new Error('offline'))
    const choices = await source.candidates(session, { query: '出图', position: 'leading', drilled: false,
      signal: new AbortController().signal })
    expect(choices[0]?.description).toBe(imageTrialCopy.unavailable)
    const match = source.matchSpace?.(session, '@出图')
    if (typeof match !== 'object' || match === null || !('claim' in match)) throw new Error('expected image claim')
    const attachment: SubmitAttachment = { type: 'image', mediaType: 'image/png', data: 'retained' }
    expect(await match.claim.submit('外星人', {} as never, [attachment])).toEqual({
      kind: 'error', text: imageTrialCopy.unavailable,
    })
  }
  expect(trial.open).not.toHaveBeenCalled(); expect(formal.open).not.toHaveBeenCalled()
  expect(paid).not.toHaveBeenCalled()
  capabilities.dispose()
})
it('never offers the research route to a CEO Session', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [] },
  }) })
  const trial = { enabled: vi.fn().mockResolvedValue(true), open: vi.fn(), text: (key: string) => key }
  const source = createMarketMentionSource({ capabilities, callCapability: vi.fn(), callingMode: () => false, imageTrial: trial })
  const session = { sessionId: 'ceo-session' } as Parameters<typeof source.candidates>[0]
  const match = source.matchSpace?.(session, '@出图')
  if (typeof match !== 'object' || match === null || !('claim' in match)) throw new Error('expected image claim')
  expect(await match.claim.submit('外星人', {} as never, [])).toMatchObject({ kind: 'error' })
  expect(trial.enabled).not.toHaveBeenCalled(); expect(trial.open).not.toHaveBeenCalled()
  capabilities.dispose()
})
it.each(['image', 'video'] as const)('routes the original %s conversation and attachments to a formal quote instead of the enabled trial', async (capability) => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: false, error: { message: 'old catalog offline' },
  }) })
  const formal = { enabled: vi.fn(async () => true), open: vi.fn(async () => ({ kind: 'success' as const })), text: (key: string) => key }
  const imageTrial = { enabled: vi.fn(async () => true), open: vi.fn(async () => true), text: (key: string) => key }
  const videoTrial = { enabled: vi.fn(async () => true), open: vi.fn(async () => ({ outcome: 'accepted' as const })), text: (key: string) => key }
  const paid = vi.fn(); const draft = vi.fn()
  const source = createMarketMentionSource({ capabilities, callCapability: paid, callVideoDraft: draft,
    callingMode: () => true, formalMedia: formal, imageTrial, videoTrial })
  const session = { sessionId: 'formal-session' } as Parameters<typeof source.candidates>[0]
  const token = capability === 'image' ? '@出图' : '@出视频'
  const attachment: SubmitAttachment = { type: 'image', mediaType: 'image/png', data: 'fixture' }
  const match = await source.matchEnter?.(session, token + ' 极速横屏5秒', new AbortController().signal, { attachments: 1 })
  if (typeof match !== 'object' || match === null || !('claim' in match)) throw new Error('expected formal claim')
  expect(match.claim.attachments).toBe(true)
  const original = '  极速横屏5秒，保留原文  '
  await Promise.all([match.claim.submit(original, {} as never, [attachment]), match.claim.submit(original, {} as never, [attachment])])
  expect(formal.open).toHaveBeenCalledExactlyOnceWith(session, capability, original, [attachment])
  expect(imageTrial.open).not.toHaveBeenCalled(); expect(videoTrial.open).not.toHaveBeenCalled()
  expect(paid).not.toHaveBeenCalled(); expect(draft).not.toHaveBeenCalled()
  const candidates = await source.candidates(session, { query: '', position: 'leading', drilled: false, signal: new AbortController().signal })
  expect(candidates.map(c => c.label)).toEqual(['出图', '出视频'])
  expect(candidates.map(c => c.description)).toEqual(['hint', 'hint'])
  capabilities.dispose()
})
it('keeps a failed formal directory query out of both paid dispatch and research submission', async () => {
  const capabilities = new MarketCapabilitiesController({ orderAdapterCapabilities: vi.fn().mockResolvedValue({
    ok: true, value: { capabilities: [] },
  }) })
  const formal = { enabled: vi.fn(async () => { throw new Error('offline') }), open: vi.fn(), text: (key: string) => key }
  const trial = { enabled: vi.fn(async () => true), open: vi.fn(), text: (key: string) => key }
  const source = createMarketMentionSource({ capabilities, callCapability: vi.fn(),
    callingMode: () => true, formalMedia: formal, imageTrial: trial })
  const session = { sessionId: 'formal-session' } as Parameters<typeof source.candidates>[0]
  const match = source.matchSpace?.(session, '@出图')
  if (typeof match !== 'object' || match === null || !('claim' in match)) throw new Error('expected formal claim')
  expect(await match.claim.submit('极速横屏猫', {} as never, [])).toEqual({ kind: 'error', text: 'quoteFailed' })
  expect(trial.open).not.toHaveBeenCalled(); expect(formal.open).not.toHaveBeenCalled()
  capabilities.dispose()
})
