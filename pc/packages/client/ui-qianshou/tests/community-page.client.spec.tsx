// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommunityPage } from '../src/client/community/CommunityPage.tsx'
import { zh, type CommunityTranslate } from '../src/client/community/locales.ts'
import { CommunityFailure, createCommunityTransport, type CommunityTopic, type CommunityTransport } from '../src/client/community/transport.ts'
import { createCommunityMarketSearch, createCommunityMarketResolver, type CommunityMarketRemote } from '../src/client/community/related-market.ts'

const t: CommunityTranslate = (key, values) => String(zh[key]).replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? ''))
const topic: CommunityTopic = {
  id: 'topic-1', category: 'help', title: '怎么在对话里调用技能？', content: '我已经安装了技能，想知道如何在会话里使用。',
  authorId: '167', authorName: '测试用户', status: 'open', related: { kind: 'product', id: 'product-1' },
  replyCount: 1, createdAt: '2026-09-26T02:00:00.000Z', updatedAt: '2026-09-26T02:01:00.000Z',
  pinned: false, official: false,
}
const reply = {
  id: 'reply-1', topicId: topic.id, content: '在输入框输入 @ 后选择能力。', authorId: '200', authorName: '社区成员',
  createdAt: '2026-09-26T02:01:00.000Z', accepted: false,
}

function fixture(): CommunityTransport {
  return {
    categories: vi.fn(async () => [{ id: 'help', title: '问题求助', description: '询问使用问题' }]),
    topics: vi.fn(async () => ({ items: [topic], nextCursor: null })),
    topic: vi.fn(async () => ({ topic, replies: [reply], nextReplyCursor: null })),
    createTopic: vi.fn(async () => topic), createReply: vi.fn(async () => reply),
    solve: vi.fn(async () => ({ ...topic, status: 'solved' as const })), report: vi.fn(async () => {}),
  }
}

function marketFixture() {
  const capabilities = vi.fn<CommunityMarketRemote['orderAdapterCapabilities']>().mockResolvedValue({ ok: true, value: {
    capabilities: [{ taskType: 'char_count_v3', capabilityId: 'text.transform', name: '通用字符统计', description: '统计中文字符和表情数量' },
      { taskType: 'image_generate_v1', capabilityId: 'media.generate', name: '官方出图', description: '生成图片' }],
  } })
  const products = vi.fn<CommunityMarketRemote['orderAdapterProducts']>().mockResolvedValue({ ok: true, value: {
    products: [{ id: '8feffbae-bf67-458c-a3df-0711f9186621', name: '字符统计运行包',
      description: '安装后统计中文字符', version: '3.0.0', salePriceYuan: '0.00' }],
  } })
  return { capabilities, products, search: createCommunityMarketSearch({ orderAdapterCapabilities: capabilities, orderAdapterProducts: products }) }
}

afterEach(cleanup)

describe('desktop community', () => {
  it('shows the reviewed Chinese name for an old linked topic and retains its exact identity for navigation', async () => {
    const transport = fixture()
    const openRelated = vi.fn()
    const products = vi.fn<CommunityMarketRemote['orderAdapterProducts']>().mockResolvedValue({ ok: true, value: {
      products: Array.from({ length: 21 }, (_, index) => ({ id: index === 20 ? 'product-1' : `other-${index}`,
        name: index === 20 ? '通用发布验收示例' : `其他商品${index}`, description: '', version: '0.0.1', salePriceYuan: '0.00' })),
    } })
    const resolve = createCommunityMarketResolver({ orderAdapterProducts: products,
      orderAdapterCapabilities: vi.fn().mockResolvedValue({ ok: true, value: { capabilities: [] } }) })
    const view = render(<CommunityPage t={t} transport={transport} resolveRelated={resolve} openRelated={openRelated} />)
    fireEvent.click(await view.findByRole('button', { name: /怎么在对话里调用技能/u }))
    expect(await view.findByText('关联商品：通用发布验收示例')).toBeTruthy()
    expect(view.queryByText(/product-1/u)).toBeNull()
    fireEvent.click(view.getByRole('button', { name: /去市场查看/u }))
    expect(openRelated).toHaveBeenCalledExactlyOnceWith({ kind: 'product', id: 'product-1' })
    expect(transport.createTopic).not.toHaveBeenCalled()
  })

  it('keeps an unavailable related entry readable without exposing its internal id', async () => {
    const transport = fixture()
    const view = render(<CommunityPage t={t} transport={transport}
      resolveRelated={async () => { throw new Error('market unavailable') }} />)
    fireEvent.click(await view.findByRole('button', { name: /怎么在对话里调用技能/u }))
    expect(await view.findByText('关联商品：市场条目暂不可用')).toBeTruthy()
    expect(view.queryByText(/product-1/u)).toBeNull()
  })

  it('opens a real topic, follows its product, replies, and lets only the author resolve it', async () => {
    const transport = fixture()
    const openRelated = vi.fn()
    const view = render(<CommunityPage t={t} transport={transport} accountId={async () => '167'} openRelated={openRelated} />)
    fireEvent.click(await view.findByRole('button', { name: /怎么在对话里调用技能/u }))
    expect(await view.findByRole('heading', { name: topic.title })).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: /去市场查看/u }))
    expect(openRelated).toHaveBeenCalledWith({ kind: 'product', id: 'product-1' })
    fireEvent.change(view.getByPlaceholderText('写下你的建议或补充信息'), { target: { value: '谢谢，我试一下。' } })
    fireEvent.click(view.getByRole('button', { name: '发送回复' }))
    await waitFor(() => { expect(transport.createReply).toHaveBeenCalledWith(topic.id, '谢谢，我试一下。') })
    fireEvent.click(view.getByRole('button', { name: '标记已解决' }))
    await waitFor(() => { expect(transport.solve).toHaveBeenCalledWith(topic.id) })
  })

  it('publishes linked topics only after fields are present and keeps server errors visible', async () => {
    const transport = fixture()
    const market = marketFixture()
    const view = render(<CommunityPage t={t} transport={transport} searchRelated={market.search} />)
    await view.findByRole('button', { name: /怎么在对话里调用技能/u })
    fireEvent.click(view.getByRole('button', { name: '发帖' }))
    fireEvent.change(view.getByPlaceholderText('一句话说清你要讨论的问题'), { target: { value: '新的讨论标题' } })
    fireEvent.change(view.getByPlaceholderText('说明背景、尝试过什么，以及你希望得到的帮助'), { target: { value: '我想知道这个技能如何安装、调用、发布。' } })
    fireEvent.change(view.getByLabelText('关联能力'), { target: { value: 'skill' } })
    fireEvent.click(view.getByRole('button', { name: '发布帖子' }))
    expect(view.getByRole('alert').textContent).toContain(zh.invalidRelated)
    expect(view.queryByLabelText('技能或商品 ID')).toBeNull()
    fireEvent.change(view.getByLabelText(zh.relatedSearch), { target: { value: '中文字符' } })
    fireEvent.keyDown(view.getByLabelText(zh.relatedSearch), { key: 'Enter' })
    fireEvent.click(await view.findByRole('button', { name: '选择 通用字符统计' }))
    expect(view.queryByText('官方出图')).toBeNull()
    expect(transport.createTopic).not.toHaveBeenCalled()
    expect(market.capabilities).toHaveBeenCalledOnce()
    expect(market.products).not.toHaveBeenCalled()
    vi.mocked(transport.createTopic).mockRejectedValueOnce(new CommunityFailure('FORBIDDEN'))
    fireEvent.click(view.getByRole('button', { name: '发布帖子' }))
    expect((await view.findByRole('alert')).textContent).toContain(zh.forbidden)
    expect(view.getByText('已关联：通用字符统计')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '发布帖子' }))
    await waitFor(() => { expect(transport.createTopic).toHaveBeenCalledWith({
      category: 'help', title: '新的讨论标题', content: '我想知道这个技能如何安装、调用、发布。',
      related: { kind: 'skill', id: 'char_count_v3' },
    }) })
  })

  it('selects a free published product card and preserves topic fields while changing association kind', async () => {
    const transport = fixture()
    const market = marketFixture()
    const view = render(<CommunityPage t={t} transport={transport} searchRelated={market.search} />)
    fireEvent.click(await view.findByRole('button', { name: '发帖' }))
    fireEvent.change(view.getByPlaceholderText(zh.titlePlaceholder), { target: { value: '字符统计安装问题' } })
    fireEvent.change(view.getByPlaceholderText(zh.contentPlaceholder), { target: { value: '我想询问字符统计运行包安装后的使用方式。' } })
    fireEvent.change(view.getByLabelText(zh.relatedKind), { target: { value: 'product' } })
    fireEvent.change(view.getByLabelText(zh.relatedSearch), { target: { value: '统计' } })
    fireEvent.click(view.getByRole('button', { name: zh.relatedSearchButton }))
    expect(await view.findByText('买断售价 ¥0.00')).toBeTruthy()
    expect(view.getByText('版本 3.0.0')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '选择 字符统计运行包' }))
    expect(market.products).toHaveBeenCalledOnce()
    expect(transport.createTopic).not.toHaveBeenCalled()
    fireEvent.change(view.getByLabelText(zh.relatedKind), { target: { value: 'skill' } })
    expect(view.queryByText('已关联：字符统计运行包')).toBeNull()
    expect(view.getByPlaceholderText(zh.titlePlaceholder)).toHaveProperty('value', '字符统计安装问题')
    fireEvent.click(view.getByRole('button', { name: zh.publish }))
    expect(view.getByRole('alert').textContent).toContain(zh.invalidRelated)
    fireEvent.change(view.getByLabelText(zh.relatedKind), { target: { value: 'product' } })
    fireEvent.click(view.getByRole('button', { name: zh.relatedSearchButton }))
    fireEvent.click(await view.findByRole('button', { name: '选择 字符统计运行包' }))
    fireEvent.click(view.getByRole('button', { name: zh.publish }))
    await waitFor(() => expect(transport.createTopic).toHaveBeenCalledExactlyOnceWith({ category: 'help',
      title: '字符统计安装问题', content: '我想询问字符统计运行包安装后的使用方式。',
      related: { kind: 'product', id: '8feffbae-bf67-458c-a3df-0711f9186621' } }))
  })

  it('discards a stale search result and shows market failure without inventing an empty market', async () => {
    const transport = fixture()
    const deferred = Promise.withResolvers<Awaited<ReturnType<CommunityMarketRemote['orderAdapterCapabilities']>>>()
    const market = marketFixture()
    market.capabilities.mockReturnValueOnce(deferred.promise).mockRejectedValueOnce(new Error('market unavailable'))
    const view = render(<CommunityPage t={t} transport={transport} searchRelated={market.search} />)
    fireEvent.click(await view.findByRole('button', { name: '发帖' }))
    fireEvent.change(view.getByLabelText(zh.relatedKind), { target: { value: 'skill' } })
    fireEvent.click(view.getByRole('button', { name: zh.relatedSearchButton }))
    fireEvent.change(view.getByLabelText(zh.relatedSearch), { target: { value: '新用途' } })
    deferred.resolve({ ok: true, value: { capabilities: [{ taskType: 'old_contract', capabilityId: 'text.transform',
      name: '旧结果', description: '已过期的搜索结果' }] } })
    await waitFor(() => expect(view.queryByRole('button', { name: '选择 旧结果' })).toBeNull())
    fireEvent.click(view.getByRole('button', { name: zh.relatedSearchButton }))
    expect((await view.findByRole('alert')).textContent).toContain(zh.relatedSearchUnavailable)
    expect(view.queryByText(zh.relatedSearchEmpty)).toBeNull()
    expect(view.queryByRole('button', { name: '选择 旧结果' })).toBeNull()
    expect(transport.createTopic).not.toHaveBeenCalled()
  })

  it('shows an account prompt rather than an empty forum when the Host has no signed-in session', async () => {
    const transport = { ...fixture(), categories: vi.fn(async () => { throw new CommunityFailure('FORUM_ACCOUNT_REQUIRED') }) }
    const openAccount = vi.fn()
    const view = render(<CommunityPage t={t} transport={transport} openAccount={openAccount} />)
    expect(await view.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('登录千手账号'))
    fireEvent.click(view.getByRole('button', { name: '打开账号登录' }))
    expect(openAccount).toHaveBeenCalledOnce()
  })

  it('uses same-origin JSON requests for forum reads', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, categories: [] }), {
      headers: { 'content-type': 'application/json' },
    }))
    const transport = createCommunityTransport({ fetchImpl, baseUri: 'http://127.0.0.1:3180/' })
    expect(await transport.categories()).toEqual([])
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(String(url)).toBe('http://127.0.0.1:3180/api/qianshou/community/categories')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin', body: '{}' })
  })

  it('loads additional reply pages without replacing visible replies', async () => {
    const transport = fixture()
    transport.topic = vi.fn(async (_id, input) => input?.replyCursor === '1'
      ? { topic, replies: [{ ...reply, id: 'reply-2', content: '这是第二页。' }], nextReplyCursor: null }
      : { topic, replies: [reply], nextReplyCursor: '1' })
    const view = render(<CommunityPage t={t} transport={transport} />)
    fireEvent.click(await view.findByRole('button', { name: /怎么在对话里调用技能/u }))
    expect(await view.findByText(reply.content)).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '加载更多' }))
    expect(await view.findByText('这是第二页。')).toBeTruthy()
    expect(view.getByText(reply.content)).toBeTruthy()
    expect(transport.topic).toHaveBeenCalledWith(topic.id, { replyCursor: '1' })
  })
})
