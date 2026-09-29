// @vitest-environment jsdom
import { cleanup, fireEvent, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LocalSkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import { MarketCapabilitiesController, type MarketCapabilityView } from '../src/client/market-capabilities-controller.ts'
import { LocalSkillsController } from '../src/client/local-skills-controller.ts'
import { MarketCapabilitiesPanel } from '../src/client/MarketCapabilitiesPanel.tsx'
import { LocalSkillsPanel } from '../src/client/LocalSkillsPanel.tsx'
import { createMarketMentionSource } from '../src/client/market-mention-source.ts'
import type { EnterMarketConversation } from '../src/client/market-conversation-entry.ts'
import { zh } from '../src/client/local-skill-locales.ts'

afterEach(cleanup)

const capability: MarketCapabilityView = { taskType: 'legal-scan', capabilityId: 'legal-scan', name: '术语扫描',
  description: '检查文字', category: 'text', categoryLabelZh: '文字', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
  requiredParams: [], outputKind: 'inline_json', contractVersion: '1', publisherKind: 'user', publisherKinds: ['user'],
  executionMode: 'device', availability: 'contract_ready', requiresQuote: true,
  executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [] }
const skill: LocalSkillEntry = { name: 'legal-scan', displayName: '术语扫描', description: '检查文字', category: 'text',
  source: 'user-agents', path: '/owner/skills/legal-scan/SKILL.md', updatedAt: 1, modelInvocable: true, userInvocable: true }
const eligible = { source: skill.source, name: skill.name, path: skill.path, taskType: 'legal-scan', artifactDigest: `sha256:${'a'.repeat(64)}` }
const success = { ok: true as const, value: { capabilities: [capability] } }

describe('catalog display survives refresh without extending authority', () => {
  it('retains same-owner market data on failure while every cached @ entry and existing claim is closed', async () => {
    const pending = Promise.withResolvers<typeof success>()
    const remote = { orderAdapterCapabilities: vi.fn().mockResolvedValueOnce(success).mockReturnValueOnce(pending.promise) }
    const controller = new MarketCapabilitiesController(remote, async () => 1)
    await controller.reload()
    const callCapability = vi.fn(() => true)
    const source = createMarketMentionSource({ capabilities: controller, callCapability })
    const session = { sessionId: 'session' } as Parameters<typeof source.candidates>[0]
    const request = { query: '术语', position: 'leading' as const, drilled: false, signal: new AbortController().signal }
    const [candidate] = await source.candidates(session, request)
    const picked = source.onPick({ candidate: candidate!, session, position: 'leading', action: 'pick', via: 'menu', span: {} as never })
    if (typeof picked !== 'object' || picked === null || !('claim' in picked)) throw new Error('expected current claim')
    const refresh = controller.reload()
    expect(controller.store.getSnapshot()).toMatchObject({ capabilities: [capability], loading: true, error: false })
    expect(source.matchSpace?.(session, '@术语扫描')).toBeUndefined()
    expect(source.onPick({ candidate: candidate!, session, position: 'leading', action: 'pick', via: 'menu', span: {} as never })).toBeUndefined()
    expect(await picked.claim.submit('待检查文字', {} as never, [])).toMatchObject({ kind: 'error' })
    pending.reject(new Error('offline')); await refresh
    expect(controller.store.getSnapshot()).toMatchObject({ capabilities: [capability], loading: false, error: true })
    expect(await source.candidates(session, request)).toEqual([])
    expect(source.matchSpace?.(session, '@术语扫描')).toBeUndefined()
    expect(await picked.claim.submit('待检查文字', {} as never, [])).toMatchObject({ kind: 'error' })
    expect(callCapability).not.toHaveBeenCalled()
    controller.dispose()
  })

  it.each(['changed', 'unreadable'] as const)('clears market display when the owner is %s after a refresh starts', async (mode) => {
    let owner = 1, unreadable = false
    const pending = Promise.withResolvers<typeof success>()
    const remote = { orderAdapterCapabilities: vi.fn().mockResolvedValueOnce(success).mockReturnValueOnce(pending.promise) }
    const controller = new MarketCapabilitiesController(remote, async () => { if (unreadable) throw new Error('unknown'); return owner })
    await controller.reload()
    const refresh = controller.reload()
    await vi.waitFor(() =>{  expect(remote.orderAdapterCapabilities).toHaveBeenCalledTimes(2) })
    if (mode === 'changed') owner = 2
    else unreadable = true
    pending.resolve(success); await refresh
    expect(controller.store.getSnapshot()).toMatchObject({ capabilities: [], error: true, loading: false })
    controller.dispose()
  })

  it('retains local files after failure but drops eligibility, recovered activation and further enable attempts', async () => {
    const pending = Promise.withResolvers<{ ok: true; value: { skills: LocalSkillEntry[] } }>()
    const listLocal = vi.fn().mockResolvedValueOnce({ ok: true, value: { skills: [skill] } }).mockReturnValueOnce(pending.promise)
    const activateAuthorOrderSkill = vi.fn()
    const controller = new LocalSkillsController({ listLocal }, {
      localOrderSkillEligibility: async () => ({ ok: true, value: { items: [eligible] } }), activateAuthorOrderSkill,
      orderSources: async () => ({ ok: true, value: { sources: [{ id: 'skill:user-agents:legal-scan', kind: 'skill',
        source: 'user-agents', authorProductId: 'product', serviceId: 'node', eligible: true, enabled: true, reason: 'ready' }] } }),
      myCapabilities: async () => ({ ok: true, value: { order: { mode: 'idle' } } }),
    }, async () => 1)
    await controller.reload()
    await vi.waitFor(() => {
      expect(controller.store.getSnapshot().activations?.['user-agents:legal-scan']?.phase).toBe('ready')
    })
    const refresh = controller.reload()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'loading', skills: [skill], orderEligible: [] })
    expect(controller.store.getSnapshot().activations?.['user-agents:legal-scan']).toBeUndefined()
    await controller.enable('user-agents', 'legal-scan')
    pending.reject(new Error('offline')); await refresh
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', skills: [skill], eligibilityStatus: 'unavailable', orderEligible: [] })
    await controller.enable('user-agents', 'legal-scan')
    expect(activateAuthorOrderSkill).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('clears local account data when the account changes while the Host list is pending', async () => {
    let owner = 1
    const pending = Promise.withResolvers<{ ok: true; value: { skills: LocalSkillEntry[] } }>()
    const listLocal = vi.fn().mockResolvedValueOnce({ ok: true, value: { skills: [skill] } }).mockReturnValueOnce(pending.promise)
    const controller = new LocalSkillsController({ listLocal }, undefined, async () => owner)
    await controller.reload()
    const refresh = controller.reload()
    await vi.waitFor(() =>{  expect(listLocal).toHaveBeenCalledTimes(2) })
    owner = 2; pending.resolve({ ok: true, value: { skills: [skill] } }); await refresh
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'error', skills: [] })
    controller.dispose()
  })

  it('keeps a newer account catalog when an old activation completes late', async () => {
    let owner = 1
    const pending = Promise.withResolvers<{ ok: true; value: unknown }>()
    const controller = new LocalSkillsController({ listLocal: async () => ({ ok: true, value: { skills: [{ ...skill, name: `owner-${owner}` }] } }) }, {
      localOrderSkillEligibility: async () => ({ ok: true, value: { items: [eligible] } }), activateAuthorOrderSkill: () => pending.promise,
    }, async () => owner)
    await controller.reload()
    const activation = controller.enable('user-agents', 'legal-scan')
    await Promise.resolve(); owner = 2; await controller.reload()
    pending.resolve({ ok: true, value: { source: 'user-agents', name: 'legal-scan', deviceInstalled: true, dispatchEligible: true,
      productId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a', deviceId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a',
      publicationId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a', runtimeDigest: `sha256:${'a'.repeat(64)}`,
      order: { mode: 'idle', enabledServiceIds: ['node'] } } }); await activation
    expect(controller.store.getSnapshot().skills[0]?.name).toBe('owner-2')
    expect(controller.store.getSnapshot().status).toBe('ready')
    expect(controller.store.getSnapshot().activations?.['user-agents:legal-scan']).toBeUndefined()
    controller.dispose()
  })

  it('keeps market card and search state through refresh, with all task entry owned by the conversation', async () => {
    const initial = { capabilities: [capability], loaded: true, loading: false, error: false }
    const enterConversation = vi.fn<EnterMarketConversation>(async () => true)
    const view = render(<MarketCapabilitiesPanel view={initial} reload={vi.fn()} enterConversation={enterConversation} />)
    const search = view.getByRole('searchbox', { name: '搜索市场能力' }) as HTMLInputElement
    fireEvent.change(search, { target: { value: '术语' } })
    const article = view.getByRole('heading', { name: '术语扫描' }).closest('article')!
    article.scrollTop = 210
    for (const state of [{ ...initial, loading: true }, { ...initial, error: true }]) {
      view.rerender(<MarketCapabilitiesPanel view={state} reload={vi.fn()} enterConversation={enterConversation} />)
      expect(view.getByRole('searchbox', { name: '搜索市场能力' })).toBe(search)
      expect(search.value).toBe('术语')
      expect(view.getByRole('heading', { name: '术语扫描' }).closest('article')).toBe(article)
      expect(article.scrollTop).toBe(210)
      expect(view.queryByRole('textbox')).toBeNull()
      const action = view.getByRole('button', { name: '在对话中调用' })
      expect(action.hasAttribute('disabled')).toBe(state.error)
      if (state.error) fireEvent.click(action)
    }
    expect(enterConversation).not.toHaveBeenCalled()
    view.rerender(<MarketCapabilitiesPanel view={initial} reload={vi.fn()} enterConversation={enterConversation} />)
    fireEvent.click(view.getByRole('button', { name: '在对话中调用' }))
    await vi.waitFor(() => { expect(enterConversation).toHaveBeenCalledTimes(1) })
    expect(enterConversation.mock.calls[0]?.[0]).toMatchObject({ taskType: capability.taskType, expected: capability })
  })

  it('keeps local categories and card nodes while cached author actions are unavailable', () => {
    const initial = { status: 'ready' as const, skills: [skill], eligibilityStatus: 'ready' as const, orderEligible: [eligible] }
    const enableOrderSkill = vi.fn(async () => {})
    const props = { t: (key: keyof typeof zh) => zh[key], ensure: async () => {}, reload: async () => {}, enableOrderSkill,
      publication: { busyKey: null, items: { 'skill:user-agents:legal-scan': { phase: 'approved' as const,
        marketProductStatus: 'published', marketProductId: 'product-1', reviewReasons: [] } } },
    } as unknown as Omit<Parameters<typeof LocalSkillsPanel>[0], 'view'>
    const view = render(<LocalSkillsPanel view={initial} {...props} />)
    const card = view.getByRole('heading', { name: '术语扫描' }).closest('li')!
    fireEvent.click(within(view.getByRole('group', { name: zh.title })).getByRole('button', { name: zh.categoryText }))
    const search = view.getByPlaceholderText(zh.searchPlaceholder) as HTMLInputElement
    fireEvent.change(search, { target: { value: '术语' } })
    for (const status of ['loading', 'error'] as const) {
      view.rerender(<LocalSkillsPanel view={{ ...initial, status, eligibilityStatus: 'unavailable', orderEligible: [] }} {...props} />)
      expect(view.getByRole('heading', { name: '术语扫描' }).closest('li')).toBe(card)
      expect(view.getByPlaceholderText(zh.searchPlaceholder)).toBe(search)
      expect(search.value).toBe('术语')
      const action = view.getByRole('button', { name: zh.authorEnable })
      expect(action.hasAttribute('disabled')).toBe(true)
      fireEvent.click(action)
    }
    expect(enableOrderSkill).not.toHaveBeenCalled()
  })
})
