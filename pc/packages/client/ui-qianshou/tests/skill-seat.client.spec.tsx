// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketCapability, SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { SkillSeat } from '../src/client/SkillSeat.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.useRealTimers() })

function ability(taskType: string, name: string, publisherKind: 'official' | 'user', salePriceYuan?: string): MarketCapability {
  return { taskType, capabilityId: taskType, name, description: '统计文字', category: 'text', categoryLabelZh: '文字',
    acceptedInputKinds: ['inline'], defaultInputKind: 'inline', requiredParams: [], outputKind: 'json',
    contractVersion: '1', publisherKind, publisherKinds: [publisherKind], executionMode: 'cloud',
    availability: 'contract_ready', requiresQuote: true, executionQuotePath: '/api/v8/developer/tasks/estimate',
    currency: 'CNY', products: salePriceYuan === undefined ? [] : [{ productId: `${taskType}-product`,
      publicationId: `${taskType}-publication`, ownerId: 1, version: '1.2', salePriceYuan, availableToPurchase: true }] }
}

function bench(skills: readonly SkillEntry[] = [], market: readonly MarketCapability[] = [], preset = 'qianshou-ceo') {
  const state = { skills, loading: false, error: false }
  const callbacks = {
    load: vi.fn(async () => {}), reload: vi.fn(async () => {}), selectSkill: vi.fn(() => { screen.getByTestId('composer').focus(); return true }),
    listPlugins: vi.fn(async () => [{ id: 'bundle:wordfreq', title: '已装词频插件', description: '统计词频。' }]),
    requestPlugin: vi.fn(async () => true), listMarketAbilities: vi.fn(async () => market),
    selectMarketAbility: vi.fn(async () => { screen.getByTestId('composer').focus(); return true }),
    composeCallEntry: vi.fn(() => { screen.getByTestId('composer').focus(); return true }),
  }
  const props = { ...callbacks, useSkills: <T,>(select: (value: typeof state) => T): T => select(state),
    sessionId: 'calling-session', useSessions: <T,>(select: (value: {
      byId: { 'calling-session': { projectionValues: { agentPreset: string } } }
    }) => T): T => select({ byId: { 'calling-session': { projectionValues: { agentPreset: preset } } } }),
    coverAtlasUrl: '/assets/qianshou-skill-category-atlas.png', abilitySelectionTimeoutMs: 1000,
    t: (key: keyof typeof zh) => zh[key] } as unknown as Parameters<typeof SkillSeat>[0]
  render(<><textarea data-testid="composer" /><SkillSeat {...props} /></>)
  const open = async () => { await act(async () => { fireEvent.click(screen.getByRole('button', {
    name: preset === 'qianshou-call' ? zh.callingAbilityHint : zh.skillsHint,
  })) }) }
  return { ...callbacks, open }
}

function card(name: string): HTMLElement {
  return screen.getByText(name, { selector: 'strong' }).closest('article')!
}
function filter(group: string, name: string): void {
  fireEvent.click(within(screen.getByRole('group', { name: group })).getByRole('button', { name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }))
}

describe('Qianshou composer ability board', () => {
  it('shows only image and video in calling mode and composes a verified @ entry', async () => {
    const b = bench([], [ability('reviewed-remote', '远端文字统计', 'user')], 'qianshou-call')
    expect(screen.getByRole('button', { name: zh.callingAbilityHint }).textContent).toContain(zh.callingAbility)
    expect(screen.queryByRole('dialog')).toBeNull()
    await b.open()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    expect(card(zh.callingImage)).toBeTruthy()
    expect(card(zh.callingVideo)).toBeTruthy()
    expect(screen.queryByText('远端文字统计')).toBeNull()
    expect(b.listMarketAbilities).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(within(card(zh.callingImage))
      .getByRole('button', { name: zh.abilitySelect })) })
    expect(b.composeCallEntry).toHaveBeenCalledExactlyOnceWith('image')
    expect(b.selectMarketAbility).not.toHaveBeenCalled()
    expect(b.selectSkill).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    await b.open()
    await act(async () => { fireEvent.click(within(card(zh.callingVideo))
      .getByRole('button', { name: zh.abilitySelect })) })
    expect(b.composeCallEntry).toHaveBeenNthCalledWith(2, 'video')
  })

  it('opens cached local skills without forcing a reload and reserves refresh for its explicit action', async () => {
    const b = bench([{ name: 'local', displayName: '本机统计', description: '统计文字', modelInvocable: true }])
    await b.open()
    expect(b.reload).not.toHaveBeenCalled()
    expect(within(card('本机统计')).getByRole('button', { name: zh.abilitySelect }).hasAttribute('disabled')).toBe(false)
    expect(within(card('本机统计')).getByText(zh.abilityTechnicalDetails).closest('details')?.open).toBe(false)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.refresh })) })
    expect(b.reload).toHaveBeenCalledTimes(1)
  })

  it('keeps a cached plugin selectable during a slow background inventory refresh', async () => {
    const b = bench()
    await b.open()
    filter(zh.abilitySourceFilter, zh.installedPlugins)
    const pending = Promise.withResolvers<{ id: string; title: string; description: string }[]>()
    b.listPlugins.mockImplementationOnce(() => pending.promise)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.refresh })) })
    const button = within(card('已装词频插件')).getByRole('button', { name: zh.pluginBorrowAction })
    expect(button.hasAttribute('disabled')).toBe(false)
    await act(async () => { fireEvent.click(button) })
    expect(b.requestPlugin).toHaveBeenCalledExactlyOnceWith('bundle:wordfreq', expect.any(AbortSignal))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { pending.resolve([]) })
  })

  it('keeps real labels, prices and controls beside static local category covers', async () => {
    const b = bench([{ name: 'automate', description: '自动执行任务', modelInvocable: true }], [
      ability('reviewed-remote', '远端文字统计', 'user', '6.20'),
    ])
    await b.open()
    const marketCard = card('远端文字统计')
    const cover = marketCard.querySelector<HTMLElement>('[data-skill-cover]')!
    expect(cover.getAttribute('aria-hidden')).toBe('true')
    expect(cover.style.backgroundImage).toBe('url("/assets/qianshou-skill-category-atlas.png")')
    expect(within(marketCard).getByText(`${zh.abilityProductBuyout} · ¥6.20 · 1.2`)).toBeTruthy()
    expect(within(marketCard).getByRole('button', { name: zh.abilitySelect }).hasAttribute('disabled')).toBe(false)
    expect(card(zh.skillNameAutomate).querySelector('[data-skill-cover]')).not.toBeNull()
    expect(screen.getByRole('dialog').querySelector('video, iframe')).toBeNull()
  })

  it('opens a large searchable board and selects an authored local skill without opening the market', async () => {
    const b = bench([
      { name: 'svg-to-video', description: 'Turn SVG drawing into animated video', modelInvocable: true },
      { name: 'video-poster', displayName: '海报设计', category: 'design', description: '根据品牌制作海报。', modelInvocable: true },
    ])
    await b.open()
    expect(screen.getByRole('dialog', { name: zh.skillsMenuTitle })).toBeTruthy()
    const search = screen.getByRole('searchbox', { name: zh.abilitySearch })
    expect(document.activeElement).toBe(search)
    expect(screen.queryByRole('menu')).toBeNull()
    filter(zh.abilityCategoryFilter, zh.skillCategoryVideo)
    filter(zh.abilitySubdivisionFilter, zh.abilitySubVideoAnimation)
    expect(within(card('SVG 动画视频')).getByText('/svg-to-video')).toBeTruthy()
    expect(screen.queryByText('海报设计')).toBeNull()
    expect(screen.getByRole('searchbox', { name: zh.abilitySearch })).toBe(search)
    fireEvent.click(within(card('SVG 动画视频')).getByRole('button', { name: zh.abilitySelect }))
    expect(b.selectSkill).toHaveBeenCalledExactlyOnceWith('svg-to-video')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('composer'))
    expect(b.selectMarketAbility).not.toHaveBeenCalled()
  })

  it('keeps search available across primary and secondary categories and only classifies existing abilities', async () => {
    const b = bench([
      { name: 'count-text', displayName: '字符统计', category: 'text', description: '统计字符', modelInvocable: true },
      { name: 'translate-text', displayName: '文字翻译', category: 'text', description: '转换文字', modelInvocable: true },
      { name: 'write-report', displayName: '报告写作', category: 'text', description: '写作报告', modelInvocable: true },
      { name: 'custom', displayName: '自定义能力', category: 'text', description: '检查此内容', modelInvocable: true },
    ])
    await b.open()
    filter(zh.abilitySourceFilter, zh.abilitySourceLocal)
    filter(zh.abilityCategoryFilter, zh.skillCategoryText)
    filter(zh.abilitySubdivisionFilter, zh.abilitySubTextStatistics)
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(card('字符统计')).toBeTruthy()
    const search = screen.getByRole('searchbox', { name: zh.abilitySearch })
    fireEvent.change(search, { target: { value: '翻译' } })
    expect(screen.getByText(zh.abilityNoMatches)).toBeTruthy()
    filter(zh.abilitySubdivisionFilter, zh.abilitySubdivisionAll)
    expect(card('文字翻译')).toBeTruthy()
    expect(search.getAttribute('value')).toBe('翻译')
    fireEvent.change(search, { target: { value: '' } })
    filter(zh.abilitySubdivisionFilter, zh.skillCategoryOther)
    expect(screen.getAllByRole('listitem')).toHaveLength(1)
    expect(card('自定义能力')).toBeTruthy()
  })

  it('distinguishes sources and actual buyout prices from per-execution quotes and unknown local costs', async () => {
    const b = bench([{ name: 'local', displayName: '本机统计', category: 'text', description: '统计文字', modelInvocable: true }], [
      ability('official-free', '官方零价商品', 'official', '0.00'), ability('official-paid', '官方付费商品', 'official', '12.50'),
      ability('user-free', '市场零价商品', 'user', '0.00'), ability('user-paid', '市场付费商品', 'user', '6.20'),
      ability('no-price', '仅报价能力', 'official'),
    ])
    await b.open()
    expect(within(card('官方零价商品')).getByText(zh.abilityOfficialFreeProduct)).toBeTruthy()
    expect(within(card('官方付费商品')).getByText(zh.abilityOfficialPaidProduct)).toBeTruthy()
    expect(within(card('市场零价商品')).getByText(zh.abilityUserFreeProduct)).toBeTruthy()
    expect(within(card('市场付费商品')).getByText(zh.abilityUserPaidProduct)).toBeTruthy()
    expect(within(card('官方付费商品')).getByText(`${zh.abilityProductBuyout} · ¥12.50 · 1.2`)).toBeTruthy()
    for (const name of ['官方零价商品', '官方付费商品', '市场零价商品', '市场付费商品', '仅报价能力']) {
      expect(within(card(name)).getByText(zh.abilityExecutionQuote)).toBeTruthy()
    }
    expect(card('本机统计').textContent).not.toContain('免费')
    expect(within(card('本机统计')).getByText(zh.abilityLocalCostUnknown)).toBeTruthy()
    expect(card('仅报价能力').textContent).not.toContain('免费')
    expect(screen.getByRole('dialog').textContent).toMatchSnapshot()
    filter(zh.abilitySourceFilter, zh.abilitySourceUser)
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    await act(async () => { fireEvent.click(within(card('市场零价商品')).getByRole('button', { name: zh.abilitySelect })) })
    expect(b.selectMarketAbility).toHaveBeenCalledExactlyOnceWith('user-free', expect.objectContaining({
      taskType: 'user-free', products: [expect.objectContaining({ publicationId: 'user-free-publication', version: '1.2' })],
    }), expect.any(AbortSignal))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByTestId('composer'))
  })

  it('keeps unavailable or ambiguous market contracts out of selectable cards', async () => {
    const base = ability('a', '同名能力', 'official')
    const b = bench([], [base, { ...base, taskType: 'b' },
      { ...ability('paused', '暂停能力', 'user'), availability: 'paused' },
      { ...ability('file', '文件能力', 'user'), acceptedInputKinds: ['file'] },
      { ...ability('form', '未就绪能力', 'user'), formReady: false },
      ability('prefix', '官方生成', 'official'), ability('long', '官方生成 高质量', 'official'),
    ])
    await b.open()
    filter(zh.abilitySourceFilter, zh.abilitySourceOfficial)
    expect(screen.queryByRole('listitem')).toBeNull()
    expect(b.selectMarketAbility).not.toHaveBeenCalled()
  })

  it('does not assign a product price to a publisher when the catalog combines official and user implementations', async () => {
    const shared = { ...ability('shared', '共同实现', 'official', '0.00'), publisherKinds: ['official', 'user'] as Array<'official' | 'user'> }
    const b = bench([], [shared])
    await b.open()
    expect(within(card('共同实现')).getByText(zh.abilitySourceOfficial)).toBeTruthy()
    expect(within(card('共同实现')).getByText(zh.abilitySourceUser)).toBeTruthy()
    expect(within(card('共同实现')).queryByText(zh.abilityOfficialFreeProduct)).toBeNull()
    expect(within(card('共同实现')).queryByText(zh.abilityUserFreeProduct)).toBeNull()
    expect(within(card('共同实现')).getByText(`${zh.abilityProductBuyout} · ¥0.00 · 1.2`)).toBeTruthy()
    expect(within(card('共同实现')).getByText(zh.abilityExecutionQuote)).toBeTruthy()
  })

  it('requests a plugin receipt and retains the board on failed selection', async () => {
    const b = bench()
    await b.open()
    filter(zh.abilitySourceFilter, zh.installedPlugins)
    expect(screen.getByText(zh.pluginBorrowExplanation)).toBeTruthy()
    b.requestPlugin.mockResolvedValueOnce(false)
    await act(async () => { fireEvent.click(within(card('已装词频插件')).getByRole('button', { name: zh.pluginBorrowAction })) })
    expect(b.requestPlugin).toHaveBeenCalledExactlyOnceWith('bundle:wordfreq', expect.any(AbortSignal))
    expect(screen.getByRole('alert').textContent).toBe(zh.abilitySelectionFailed)
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('shows a readable generated-plugin title but selects its unchanged local identity', async () => {
    const b = bench()
    const originalTitle = 'qianshou-local-372c8f492ed345b6ad39cadc785a9410'
    b.listPlugins.mockResolvedValue([{ id: 'bundle:generated-local', title: originalTitle,
      description: '字符统计插件：统计中文与 emoji。' }])
    await b.open()
    filter(zh.abilitySourceFilter, zh.installedPlugins)
    const pluginCard = card('字符统计插件')
    const details = within(pluginCard).getByText(zh.abilityTechnicalDetails).closest('details')!
    expect(details.open).toBe(false)
    expect(within(details).getByText(originalTitle)).toBeTruthy()
    expect(within(details).getByText('bundle:generated-local')).toBeTruthy()
    await act(async () => { fireEvent.click(within(pluginCard).getByRole('button', { name: zh.pluginBorrowAction })) })
    expect(b.requestPlugin).toHaveBeenCalledExactlyOnceWith('bundle:generated-local', expect.any(AbortSignal))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('restores trigger focus on Escape and traps Tab from the modal close button', async () => {
    const b = bench()
    await b.open()
    const close = screen.getByRole('button', { name: zh.abilityClose })
    close.focus()
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.refresh }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' })
    expect(document.activeElement).toBe(close)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.skillsHint }))
  })
})

it('keeps other cards selectable and cancels the earlier check when switching abilities', async () => {
  const b = bench([], [ability('first', '第一个能力', 'user'), ability('second', '第二个能力', 'user')])
  await b.open()
  const first = Promise.withResolvers<boolean>()
  b.selectMarketAbility.mockImplementationOnce(() => first.promise)
  await act(async () => { fireEvent.click(within(card('第一个能力')).getByRole('button', { name: zh.abilitySelect })) })
  expect(within(card('第二个能力')).getByRole('button').hasAttribute('disabled')).toBe(false)
  const args = b.selectMarketAbility.mock.calls[0] as unknown as [string, MarketCapability, AbortSignal]
  await act(async () => { fireEvent.click(within(card('第二个能力')).getByRole('button', { name: zh.abilitySelect })) })
  expect(args[2].aborted).toBe(true)
  expect(screen.queryByRole('dialog')).toBeNull()
  await act(async () => { first.resolve(false) })
  expect(screen.queryByRole('alert')).toBeNull()
})

it('releases a hanging check after its configured limit and keeps the board open for another choice', async () => {
  const b = bench([], [ability('first', '第一个能力', 'user')])
  await b.open()
  vi.useFakeTimers()
  const first = Promise.withResolvers<boolean>()
  b.selectMarketAbility.mockImplementationOnce(() => first.promise)
  await act(async () => { fireEvent.click(within(card('第一个能力')).getByRole('button')) })
  const args = b.selectMarketAbility.mock.calls[0] as unknown as [string, MarketCapability, AbortSignal]
  await act(async () => { vi.advanceTimersByTime(1000) })
  expect(args[2].aborted).toBe(true)
  expect(screen.getByRole('alert').textContent).toBe(zh.abilitySelectionFailed)
  expect(within(card('第一个能力')).getByRole('button').hasAttribute('disabled')).toBe(false)
  await act(async () => { first.resolve(true) })
  expect(screen.getByRole('dialog')).toBeTruthy()
})
