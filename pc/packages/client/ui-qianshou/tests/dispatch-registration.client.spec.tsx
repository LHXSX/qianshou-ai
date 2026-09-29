// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ThemeRuntime, type ThemeSettings } from '@deepseek-ai/dsh-client-ui-theme/client'
import {
  RemoteError, SlotTestRuntime, stubSettingsScope, type SessionBehaviorOverrides,
} from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'
import type { AgentTaskActions } from '../src/client/AgentTasks.tsx'
import { DelegationForm } from '../src/client/DelegationForm.tsx'
import type { ConversationPlugin, SkillSeatInjected } from '../src/client/SkillSeat.tsx'
import type { QianshouMarketSelection } from '../src/client/qianshou-market-selection.ts'
import type { IntakeOrderSources } from '../src/client/node-status/supply-transport.ts'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type { CommunityMarketRemote, CommunityMarketSearch } from '../src/client/community/related-market.ts'

type Prompt = NonNullable<SessionBehaviorOverrides['prompt']>
const runtimes: SlotTestRuntime[] = []

afterEach(async () => {
  cleanup()
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  vi.unstubAllEnvs()
})

async function bench(prompt: Prompt, withSkills = false, withMarketSelector = true) {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const orderSources = vi.fn(async (): Promise<{ ok: true; value: IntakeOrderSources }> => ({
    ok: true, value: { complete: true, sources: [] },
  }))
  const marketCapabilities = vi.fn<CommunityMarketRemote['orderAdapterCapabilities']>()
    .mockResolvedValue({ ok: true, value: { capabilities: [] } })
  const marketProducts = vi.fn<CommunityMarketRemote['orderAdapterProducts']>()
    .mockResolvedValue({ ok: true, value: { products: [] } })
  const conversationPlugins = vi.fn(async (): Promise<{ ok: true; value: ConversationPlugin[] }> => ({ ok: true, value: [] }))
  runtime.remote.provideNamespaces({ qianshouPluginCatalog: {
    myCapabilities: vi.fn(), orderSources, conversationPlugins,
    setOwnerSupplyEnabled: vi.fn(), setLocalServiceEnabled: vi.fn(),
    orderAdapterCapabilities: marketCapabilities, orderAdapterProducts: marketProducts,
  } })
  const listSkills = vi.fn(async (): Promise<{ ok: true; value: { skills: readonly SkillEntry[] } }> => ({
    ok: true, value: { skills: [] },
  }))
  if (withSkills) runtime.remote.provideNamespaces({ skills: { list: listSkills } })
  const refreshAndSelect = vi.fn(async () => false)
  const listAbilities = vi.fn<NonNullable<QianshouMarketSelection['listAbilities']>>().mockResolvedValue([])
  const marketSelector = withMarketSelector ? await runtime.mount({
    apply(ctx) { ctx.provide('qianshouMarketSelection', { refreshAndSelect, listAbilities }) },
  }) : null
  const locale = new LocaleRuntime(runtime.ctx)
  locale.setLocale('zh')
  runtime.ctx.provide('locale', locale)
  runtime.ctx.provide('theme', new ThemeRuntime(runtime.ctx, stubSettingsScope<ThemeSettings>().scope))
  const tabs: Array<{ sessionId: string; tabId: string; kind: string }> = []
  const sidebar = {
    openTabs: { getSnapshot: () => tabs }, openTab: vi.fn(), focus: vi.fn(),
    isExpanded: vi.fn(() => false), toggleExpanded: vi.fn(),
  }
  runtime.ctx.provide('sidebarRight', sidebar as never)
  runtime.ctx.provide('sidebarRightTabs', { register: () => () => {} } as never)
  const selectPanel = vi.fn()
  runtime.ctx.provide('layout', { selectPanel } as never)
  // A sibling provider reproduces the real DI boundary. Merely injecting this
  // service into the feature does not inject it into the borrowed Agent scope.
  const inputState = { phase: 'plain', draft: '帮我统计这段文本', draftRev: 1, occurrences: [] }
  const setDraft = vi.fn((text: string) => { inputState.draft = text; inputState.draftRev++ })
  const focus = vi.fn()
  await runtime.mount({
    apply(ctx) { ctx.provide('conversation', {
      send: () => Promise.resolve(),
      input: { for: () => ({ state: { getSnapshot: () => inputState }, setDraft, focus,
        composeReference: (reference: string, revision: number) => {
          if ((inputState.phase !== 'plain' && inputState.phase !== 'claimed') || revision !== inputState.draftRev) return false
          const prefix = `${reference} `
          if (!inputState.draft.startsWith(prefix)) setDraft(prefix + inputState.draft)
          focus(); return true
        },
      }) },
    } as never) },
  })
  const parent = await runtime.sessions.add({ id: 'ceo-parent', session: { prompt } })
  const reference = runtime.sessions.retain(parent)
  await reference.ready
  await runtime.declare({
    'conversation.session.header.actions': { kind: 'list', scope: 'session' },
    'conversation.input.left': { kind: 'list', scope: 'session' },
    'main': { kind: 'keyed', scope: 'root' },
    'sidebar.panellist': { kind: 'list', scope: 'root' },
  })
  const feature = await runtime.mount({ inject, apply })
  const entries = runtime.slots.entries('conversation.session.header.actions')
  // U1 added an unrelated second header action (compute-node status). This suite is
  // about the dispatch admission entry, which must still be registered exactly once.
  const dispatchEntries = entries.filter(entry => entry.options.id === 'qianshou-agent-tasks')
  expect(dispatchEntries).toHaveLength(1)
  const actions = (dispatchEntries[0]!.inject as unknown as () => AgentTaskActions)()
  const view = render(<DelegationForm parent={parent} dispatch={actions.dispatch} t={locale.bind('qianshou.brand')} />)
  const task = '检查通信协议兼容性，只读取样本。'
  const submit = () => {
    fireEvent.change(view.getByRole('textbox', { name: '任务目标与验收要求' }), { target: { value: task } })
    fireEvent.click(view.getByRole('button', { name: '交给 CEO 派发' }))
  }
  return { runtime, parent, reference, view, task, submit, tabs, sidebar, actions, orderSources,
    marketCapabilities, marketProducts, conversationPlugins, listAbilities, setDraft, focus,
    selectPanel, refreshAndSelect, inputState, listSkills, marketSelector, feature,
  }
}

describe('registered CEO dispatch admission', () => {
  it('registers a permanent Help entry in the main column and sidebar', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }))
    const sidebarEntry = b.runtime.slots.entries('sidebar.panellist')
      .find(entry => entry.options.id === 'qianshou-help')
    const mainEntry = b.runtime.slots.entries('main').find(entry => entry.options.key === 'qianshou-help')
    expect(sidebarEntry).toBeDefined()
    const label = sidebarEntry?.options.label
    expect(typeof label === 'function' ? label() : label).toBe('算力共享')
    expect(mainEntry).toBeDefined()
    b.reference.release()
  })

  it('places the discussion area after Help and connects it to a main-column page', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }))
    const entries = b.runtime.slots.entries('sidebar.panellist')
    const help = entries.find(entry => entry.options.id === 'qianshou-help')
    const forum = entries.find(entry => entry.options.id === 'qianshou-community')
    expect(help?.options.order).toBe(10)
    expect(forum?.options.order).toBe(11)
    const label = forum?.options.label
    expect(typeof label === 'function' ? label() : label).toBe('讨论区')
    expect(b.runtime.slots.entries('main').some(entry => entry.options.key === 'qianshou-community')).toBe(true)
    b.reference.release()
  })

  it('navigates an associated product to the existing market with a retained focus target', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }))
    const entry = b.runtime.slots.entries('main').find(item => item.options.key === 'qianshou-community')!
    const props = (entry.inject as unknown as () => { openRelated(related: { kind: 'product'; id: string }): Promise<void> })()
    const event = vi.fn()
    window.addEventListener('qianshou:open-market-item', event)
    await props.openRelated({ kind: 'product', id: 'product-1' })
    expect(b.selectPanel).toHaveBeenCalledWith('plugins')
    expect(sessionStorage.getItem('qianshou:market-focus')).toBe(JSON.stringify({ kind: 'product', id: 'product-1' }))
    expect(event).toHaveBeenCalledOnce()
    expect((event.mock.calls[0]![0] as CustomEvent).detail).toEqual({ productId: 'product-1' })
    window.removeEventListener('qianshou:open-market-item', event)
    sessionStorage.removeItem('qianshou:market-focus')
    b.reference.release()
  })

  it('navigates an associated skill to a focused market search', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }))
    const entry = b.runtime.slots.entries('main').find(item => item.options.key === 'qianshou-community')!
    const props = (entry.inject as unknown as () => { openRelated(related: { kind: 'skill'; id: string }): Promise<void> })()
    const event = vi.fn()
    window.addEventListener('qianshou:open-market-item', event)
    await props.openRelated({ kind: 'skill', id: 'svg-to-video' })
    expect(b.selectPanel).toHaveBeenCalledWith('plugins')
    expect(sessionStorage.getItem('qianshou:market-focus')).toBe(JSON.stringify({ kind: 'skill', id: 'svg-to-video' }))
    expect((event.mock.calls[0]![0] as CustomEvent).detail).toEqual({ skillId: 'svg-to-video' })
    window.removeEventListener('qianshou:open-market-item', event)
    sessionStorage.removeItem('qianshou:market-focus')
    b.reference.release()
  })

  it('searches the actual market Remote for association and focuses the exact reviewed contract', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }))
    b.marketCapabilities.mockResolvedValue({ ok: true, value: { capabilities: [
      { taskType: 'char_count_v3', capabilityId: 'text.transform', name: '通用字符统计', description: '统计中文字符和表情' },
    ] } })
    b.marketProducts.mockResolvedValue({ ok: true, value: { products: [
      { id: '8feffbae-bf67-458c-a3df-0711f9186621', name: '字符统计运行包', description: '安装后统计字符', version: '3.0.0', salePriceYuan: '0.00' },
    ] } })
    const entry = b.runtime.slots.entries('main').find(item => item.options.key === 'qianshou-community')!
    const props = (entry.inject as unknown as () => { searchRelated: CommunityMarketSearch
      openRelated(related: { kind: 'skill'; id: string }): Promise<void> })()
    expect(await props.searchRelated('skill', '中文字符')).toEqual([
      { kind: 'skill', id: 'char_count_v3', name: '通用字符统计', description: '统计中文字符和表情' },
    ])
    expect(await props.searchRelated('product', '字符')).toMatchObject([
      { kind: 'product', id: '8feffbae-bf67-458c-a3df-0711f9186621', name: '字符统计运行包', salePriceYuan: '0.00' },
    ])
    expect(b.marketCapabilities).toHaveBeenCalledOnce()
    expect(b.marketProducts).toHaveBeenCalledOnce()
    const event = vi.fn()
    window.addEventListener('qianshou:open-market-item', event)
    await props.openRelated({ kind: 'skill', id: 'char_count_v3' })
    expect(b.selectPanel).toHaveBeenCalledWith('plugins')
    expect(sessionStorage.getItem('qianshou:market-focus')).toBe(JSON.stringify({ kind: 'capability', taskType: 'char_count_v3' }))
    expect((event.mock.calls[0]![0] as CustomEvent).detail).toEqual({ taskType: 'char_count_v3' })
    b.marketCapabilities.mockResolvedValue({ ok: true, value: { capabilities: [
      { taskType: 'char_count_v3', capabilityId: 'text.transform', name: '通用字符统计', description: '统计字符' },
      { taskType: 'word_count', capabilityId: 'text.transform', name: '词频统计', description: '统计词频' },
    ] } })
    await props.openRelated({ kind: 'skill', id: 'text.transform' })
    expect(sessionStorage.getItem('qianshou:market-focus')).toBe(JSON.stringify({ kind: 'skill', id: 'text.transform' }))
    expect((event.mock.calls.at(-1)![0] as CustomEvent).detail).toEqual({ skillId: 'text.transform' })
    window.removeEventListener('qianshou:open-market-item', event)
    sessionStorage.removeItem('qianshou:market-focus')
    b.reference.release()
  })

  it('routes the personal center income shortcut to the existing intake page', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }))
    window.dispatchEvent(new Event('qianshou:open-intake'))
    expect(b.selectPanel).toHaveBeenCalledWith('qianshou-intake')
    b.reference.release()
  })

  it('keeps CEO dispatch independent of the optional skill Remote while mounting the skill seat when it exists', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }), true)
    await waitFor(() => {
      expect(b.runtime.slots.entries('conversation.input.left').filter(entry => entry.options.id === 'qianshou-skills')).toHaveLength(1)
    })
    b.reference.release()
  })

  it('borrows only an active installed plugin and drafts a receipt-gated request', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }), true)
    b.conversationPlugins.mockResolvedValue({ ok: true, value: [
      { id: 'bundle:active', title: '本机词频处理', description: '词频处理' },
    ] })
    const entry = b.runtime.slots.entries('conversation.input.left').find(item => item.options.id === 'qianshou-skills')
    expect(entry).toBeDefined()
    const seat = (entry!.inject as unknown as (sessionId: typeof b.parent) => SkillSeatInjected)(b.parent)
    expect(await seat.listPlugins()).toEqual([{ id: 'bundle:active', title: '本机词频处理', description: '词频处理' }])
    expect(await seat.requestPlugin('bundle:off')).toBe(false)
    expect(b.setDraft).not.toHaveBeenCalled()
    expect(await seat.requestPlugin('bundle:active')).toBe(true)
    expect(b.conversationPlugins).toHaveBeenCalledTimes(3)
    expect(b.orderSources).not.toHaveBeenCalled()
    expect(b.setDraft).toHaveBeenCalledTimes(1)
    expect(b.setDraft.mock.calls[0]?.[0]).toContain('我的任务： 帮我统计这段文本')
    expect(b.setDraft.mock.calls[0]?.[0]).toContain('不要仅根据已安装状态声称已经执行')
    expect(b.focus).toHaveBeenCalledOnce()
    b.reference.release()
  })

  it('refuses a retained plugin selection after its provider unloads during catalog refresh', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }), true)
    const entry = b.runtime.slots.entries('conversation.input.left').find(item => item.options.id === 'qianshou-skills')!
    const seat = (entry.inject as unknown as (sessionId: typeof b.parent) => SkillSeatInjected)(b.parent)
    let finish!: (value: { ok: true; value: ConversationPlugin[] }) => void
    b.conversationPlugins.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const pending = seat.requestPlugin('bundle:active')
    await b.feature.dispose()
    finish({ ok: true, value: [{ id: 'bundle:active', title: '插件', description: '测试' }] })
    expect(await pending).toBe(false)
    expect(b.setDraft).not.toHaveBeenCalled()
    b.reference.release()
  })

  it('delegates exact market identity and Session to the shared selector without a text fallback or navigation', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }), true)
    const entry = b.runtime.slots.entries('conversation.input.left').find(item => item.options.id === 'qianshou-skills')
    const seat = (entry!.inject as unknown as (sessionId: typeof b.parent) => SkillSeatInjected)(b.parent)
    b.inputState.draft = '  \t原草稿\n\n保留末尾  '
    expect(seat.coverAtlasUrl).toBe('/assets/qianshou-skill-category-atlas.png')
    expect(await seat.listMarketAbilities()).toEqual([])
    expect(b.listAbilities).toHaveBeenCalledOnce()
    expect(b.marketCapabilities).not.toHaveBeenCalled()
    expect(await seat.selectMarketAbility('word_count')).toBe(false)
    expect(b.refreshAndSelect).toHaveBeenCalledExactlyOnceWith(b.parent, 'word_count')
    expect(b.setDraft).not.toHaveBeenCalled()
    expect(b.inputState.draft).toBe('  \t原草稿\n\n保留末尾  ')
    expect(b.selectPanel).not.toHaveBeenCalled()
    b.refreshAndSelect.mockResolvedValueOnce(true)
    expect(await seat.selectMarketAbility('word_count')).toBe(true)
    expect(b.setDraft).not.toHaveBeenCalled()
    b.reference.release()
  })

  it('composes fixed calling entries into the current Session without quoting or losing its draft', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }), true)
    const entry = b.runtime.slots.entries('conversation.input.left').find(item => item.options.id === 'qianshou-skills')!
    const seat = (entry.inject as unknown as (sessionId: typeof b.parent) => SkillSeatInjected)(b.parent)
    b.inputState.draft = '海边的小狗奔跑'
    expect(seat.composeCallEntry('video')).toBe(true)
    expect(b.inputState.draft).toBe('@出视频 海边的小狗奔跑')
    expect(b.refreshAndSelect).not.toHaveBeenCalled()
    expect(b.selectPanel).not.toHaveBeenCalled()
    b.inputState.draft = '画一只橘猫'
    expect(seat.composeCallEntry('image')).toBe(true)
    expect(b.inputState.draft).toBe('@出图 画一只橘猫')
    b.inputState.phase = 'submitting'
    expect(seat.composeCallEntry('image')).toBe(false)
    await b.feature.dispose()
    expect(seat.composeCallEntry('video')).toBe(false)
    b.reference.release()
  })

  it('preserves every local skill draft character and refuses frozen admission phases', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }), true)
    b.listSkills.mockResolvedValue({ ok: true, value: { skills: [{ name: 'local-count', description: '统计字符', modelInvocable: true }] } })
    const entry = b.runtime.slots.entries('conversation.input.left').find(item => item.options.id === 'qianshou-skills')
    const seat = (entry!.inject as unknown as (sessionId: typeof b.parent) => SkillSeatInjected)(b.parent)
    await seat.load()
    const draft = '  \t原任务\n\n末尾  '
    b.inputState.draft = draft
    expect(seat.selectSkill('local-count')).toBe(true)
    expect(b.inputState.draft).toBe(`/local-count ${draft}`)
    expect(b.selectPanel).not.toHaveBeenCalled()
    b.inputState.phase = 'submitting'
    expect(seat.selectSkill('local-count')).toBe(false)
    expect(b.setDraft).toHaveBeenCalledOnce()
    b.reference.release()
  })

  it('keeps local entry mounted with a missing or disposed market selector and refuses market selection', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }), true, false)
    const seatFor = () => {
      const entry = b.runtime.slots.entries('conversation.input.left').find(item => item.options.id === 'qianshou-skills')
      expect(entry).toBeDefined()
      return (entry!.inject as unknown as (sessionId: typeof b.parent) => SkillSeatInjected)(b.parent)
    }
    await expect(seatFor().listMarketAbilities()).rejects.toThrow('market-selection-unavailable')
    expect(await seatFor().selectMarketAbility('word_count')).toBe(false)
    const provider = await b.runtime.mount({ apply(ctx) { ctx.provide('qianshouMarketSelection', { refreshAndSelect: b.refreshAndSelect }) } })
    b.refreshAndSelect.mockResolvedValueOnce(true)
    expect(await seatFor().selectMarketAbility('word_count')).toBe(true)
    await provider.dispose()
    await expect(seatFor().listMarketAbilities()).rejects.toThrow('market-selection-unavailable')
    expect(await seatFor().selectMarketAbility('word_count')).toBe(false)
    expect(b.setDraft).not.toHaveBeenCalled()
    b.reference.release()
  })

  it('returns to this session task tab across panes instead of duplicating it beside a child', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }))
    b.tabs.push({ sessionId: 'another-parent', tabId: 'other-task-tab', kind: 'qianshou-tasks' },
      { sessionId: b.parent, tabId: 'existing-task-tab', kind: 'qianshou-tasks' })
    b.actions.openTasks(b.parent)
    expect(b.sidebar.focus).toHaveBeenCalledWith('existing-task-tab')
    expect(b.sidebar.openTab).not.toHaveBeenCalled()
    expect(b.sidebar.toggleExpanded).toHaveBeenCalledTimes(1)
    b.reference.release()
  })

  it('keeps an expanded child detail focused when background work is automatically revealed', async () => {
    const b = await bench(vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } }))
    b.sidebar.isExpanded.mockReturnValue(true)
    b.tabs.push({ sessionId: b.parent, tabId: 'child-detail', kind: 'subagentchat' })
    b.actions.openTasks(b.parent, true)
    expect(b.sidebar.focus).not.toHaveBeenCalled()
    expect(b.sidebar.openTab).not.toHaveBeenCalled()
    expect(b.sidebar.toggleExpanded).not.toHaveBeenCalled()
    b.sidebar.isExpanded.mockReturnValue(false)
    b.actions.openTasks(b.parent, true)
    expect(b.sidebar.openTab).toHaveBeenCalledWith('qianshou-tasks')
    b.reference.release()
  })

  it('reaches the retained parent queue across real DI and waits for its acknowledgement', async () => {
    const admission = Promise.withResolvers<Awaited<ReturnType<Prompt>>>()
    const prompt = vi.fn<Prompt>(() => admission.promise)
    const b = await bench(prompt)
    const scoped = b.runtime.sessions.scope(b.parent)!
    expect(scoped.get('conversation')).toBeDefined()
    expect(() => scoped.conversation).toThrow('cannot get property "conversation" without inject')

    b.submit()
    expect(prompt).toHaveBeenCalledTimes(1)
    const [content, mode] = prompt.mock.calls[0]!
    expect(mode).toBe('queue')
    expect(content).toHaveLength(1)
    const part = content[0]!
    if (part.type !== 'text') throw new Error('delegation should submit one text block')
    expect(part.text).toContain(b.task)
    expect(b.view.queryByRole('status')).toBeNull()
    expect(b.view.getByRole('button', { name: '正在提交…' })).toHaveProperty('disabled', true)

    admission.resolve({ ok: true, value: { accepted: true } })
    await waitFor(() => { expect(b.view.getByRole('status').textContent).toContain('请求已送达') })
    expect(b.view.getByRole('textbox', { name: '任务目标与验收要求' })).toHaveProperty('value', '')
    b.reference.release()
  })

  it('keeps the request after its parent binding has been released', async () => {
    const prompt = vi.fn<Prompt>().mockResolvedValue({ ok: true, value: { accepted: true } })
    const b = await bench(prompt)
    b.reference.release()
    b.submit()
    await waitFor(() => { expect(b.view.getByRole('alert').textContent).toContain('未提交成功') })
    expect(prompt).not.toHaveBeenCalled()
    expect(b.view.queryByRole('status')).toBeNull()
    expect(b.view.getByRole('textbox', { name: '任务目标与验收要求' })).toHaveProperty('value', b.task)
  })

  it('shows a Host refusal without claiming admission or discarding the request', async () => {
    const prompt = vi.fn<Prompt>().mockResolvedValue({
      ok: false, error: new RemoteError('session/agent-busy', 'prompt rejected', { reason: 'busy' }),
    })
    const b = await bench(prompt)
    b.submit()
    await waitFor(() => { expect(b.view.getByRole('alert').textContent).toContain('未提交成功') })
    expect(b.view.queryByRole('status')).toBeNull()
    expect(b.view.getByRole('textbox', { name: '任务目标与验收要求' })).toHaveProperty('value', b.task)
    expect(b.view.getByRole('button', { name: '交给 CEO 派发' })).toHaveProperty('disabled', false)
    b.reference.release()
  })
})
