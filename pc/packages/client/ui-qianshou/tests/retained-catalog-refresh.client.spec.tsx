// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketCapability, SessionId, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { SkillSeat } from '../src/client/SkillSeat.tsx'
import { SkillsController } from '../src/client/skills-controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

describe('same-source catalog refresh', () => {
  it('retains the last session catalog while pending and failed, and replaces it only with a successful current read', async () => {
    const skill: SkillEntry = { name: 'write-report', description: '写报告', modelInvocable: true }
    const session = 'session-1' as SessionId
    const pending = deferred<{ ok: true; value: { skills: readonly SkillEntry[] } }>()
    const list = vi.fn().mockResolvedValueOnce({ ok: true, value: { skills: [skill] } })
      .mockReturnValueOnce(pending.promise).mockResolvedValueOnce({ ok: true, value: { skills: [] } })
    const controller = new SkillsController({ list })
    await controller.load(session)
    const refresh = controller.reload(session)
    expect(controller.storeFor(session).getSnapshot()).toMatchObject({ skills: [skill], loading: true, error: false })
    pending.reject(new Error('offline'))
    await refresh
    expect(controller.storeFor(session).getSnapshot()).toMatchObject({ skills: [skill], loading: false, error: true })
    expect(controller.storeFor('other-session' as SessionId).getSnapshot().skills).toEqual([])
    await controller.reload(session)
    expect(controller.storeFor(session).getSnapshot()).toEqual({ skills: [], loading: false, error: false })
    controller.dispose()
  })

  it('preserves market and plugin cards, filters and scroll but disables stale selection after a failed refresh', async () => {
    const market: MarketCapability = { taskType: 'text-statistics', capabilityId: 'text-statistics', name: '文字统计服务',
      description: '统计文字', category: 'text', categoryLabelZh: '文字', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
      requiredParams: [], outputKind: 'json', contractVersion: '1', publisherKind: 'official', publisherKinds: ['official'],
      executionMode: 'cloud', availability: 'contract_ready', requiresQuote: true,
      executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [{ productId: 'product-1',
        publicationId: 'publication-1', ownerId: 1, version: '1.2', salePriceYuan: '3.00', availableToPurchase: true }] }
    const pendingMarket = deferred<readonly MarketCapability[]>()
    const pendingPlugins = deferred<readonly { id: string; title: string; description: string }[]>()
    const state = { skills: [], loading: false, error: false }
    const selectMarketAbility = vi.fn(async () => true), requestPlugin = vi.fn(async () => true)
    const props = { load: vi.fn(async () => {}), reload: vi.fn(async () => {}), selectSkill: vi.fn(() => true),
      listPlugins: vi.fn().mockResolvedValueOnce([{ id: 'bundle:plugin', title: '文字插件', description: '处理文字' }])
        .mockReturnValueOnce(pendingPlugins.promise), requestPlugin,
      listMarketAbilities: vi.fn().mockResolvedValueOnce([market]).mockReturnValueOnce(pendingMarket.promise), selectMarketAbility,
      useSkills: <T,>(select: (value: typeof state) => T): T => select(state),
      useSessions: <T,>(select: (value: { byId: Record<string, never> }) => T): T => select({ byId: {} }),
      sessionId: 'retained-session', t: (key: keyof typeof zh) => zh[key],
    } as unknown as Parameters<typeof SkillSeat>[0]
    const view = render(<SkillSeat {...props} />)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: zh.skillsHint })) })
    const article = view.getByText(market.name, { selector: 'strong' }).closest('article')!
    const plugin = view.getByText('文字插件', { selector: 'strong' }).closest('article')!
    const list = view.getByRole('list', { name: zh.abilityResults })
    list.scrollTop = 350
    fireEvent.change(view.getByRole('searchbox', { name: zh.abilitySearch }), { target: { value: '文字' } })
    fireEvent.click(view.getByRole('button', { name: zh.refresh }))
    expect(view.getByText(market.name, { selector: 'strong' }).closest('article')).toBe(article)
    expect(view.getByText('文字插件', { selector: 'strong' }).closest('article')).toBe(plugin)
    expect(within(article).getByRole('button', { name: zh.abilitySelect }).hasAttribute('disabled')).toBe(false)
    await act(async () => {
      pendingMarket.reject(new Error('offline')); pendingPlugins.reject(new Error('offline'))
      await Promise.allSettled([pendingMarket.promise, pendingPlugins.promise])
    })
    expect(view.getByText(zh.abilityMarketUnavailable)).toBeTruthy()
    expect(view.getByText(zh.pluginsUnavailable)).toBeTruthy()
    expect((view.getByRole('searchbox', { name: zh.abilitySearch }) as HTMLInputElement).value).toBe('文字')
    expect(list.scrollTop).toBe(350)
    const choose = within(article).getByRole('button', { name: zh.abilitySelect })
    expect(choose.hasAttribute('disabled')).toBe(true)
    fireEvent.click(choose)
    expect(selectMarketAbility).not.toHaveBeenCalled()
    const borrow = within(plugin).getByRole('button', { name: zh.pluginBorrowAction })
    expect(borrow.hasAttribute('disabled')).toBe(true)
    fireEvent.click(borrow)
    expect(requestPlugin).not.toHaveBeenCalled()
  })

  it('lets a cached market card start revalidation while loading and reports a rejected selection', async () => {
    const item: MarketCapability = { taskType: 'remote-count', capabilityId: 'text.count', name: '市场统计',
      description: '统计文字', category: 'text', categoryLabelZh: '文字', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
      requiredParams: [], outputKind: 'json', contractVersion: '1', publisherKind: 'user', publisherKinds: ['user'],
      executionMode: 'device', availability: 'contract_ready', requiresQuote: true,
      executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [] }
    const pending = deferred<readonly MarketCapability[]>()
    const selection = deferred<boolean>()
    const state = { skills: [], loading: false, error: false }
    const selectMarketAbility = vi.fn(() => selection.promise)
    const props = { load: vi.fn(async () => {}), reload: vi.fn(async () => {}), selectSkill: vi.fn(() => true),
      listPlugins: vi.fn(async () => []), requestPlugin: vi.fn(async () => false),
      listMarketAbilities: vi.fn().mockResolvedValue([item]).mockResolvedValueOnce([item]).mockReturnValueOnce(pending.promise),
      selectMarketAbility, useSkills: <T,>(select: (value: typeof state) => T): T => select(state),
      useSessions: <T,>(select: (value: { byId: Record<string, never> }) => T): T => select({ byId: {} }),
      sessionId: 'cached-session', t: (key: keyof typeof zh) => zh[key],
    } as unknown as Parameters<typeof SkillSeat>[0]
    const view = render(<><textarea aria-label="原草稿" defaultValue="原需求仍在" /><SkillSeat {...props} /></>)
    await act(async () => { fireEvent.click(view.getByRole('button', { name: zh.skillsHint })) })
    fireEvent.click(view.getByRole('button', { name: zh.refresh }))
    expect(view.getByText(zh.abilityMarketLoading)).toBeTruthy()
    const article = view.getByText(item.name, { selector: 'strong' }).closest('article')!
    const choose = within(article).getByRole('button', { name: zh.abilitySelect })
    expect(choose.hasAttribute('disabled')).toBe(false)
    fireEvent.click(choose)
    expect(selectMarketAbility).toHaveBeenCalledExactlyOnceWith(item.taskType, item, expect.any(AbortSignal))
    expect(choose.hasAttribute('disabled')).toBe(true)
    await act(async () => { pending.resolve([item]); selection.resolve(false); await selection.promise })
    expect(view.getByRole('alert').textContent).toBe(zh.abilitySelectionFailed)
    expect(view.getByRole('dialog')).toBeTruthy()
    expect((view.getByRole('textbox', { name: '原草稿' }) as HTMLTextAreaElement).value).toBe('原需求仍在')
  })
})
