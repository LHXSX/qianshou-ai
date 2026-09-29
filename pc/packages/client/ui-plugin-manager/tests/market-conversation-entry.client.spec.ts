import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createMarketConversationEntry } from '../src/client/market-conversation-entry.ts'
import { createMarketSelection } from '../src/client/market-selection.ts'
import { MarketCapabilitiesController, type MarketCapabilityView } from '../src/client/market-capabilities-controller.ts'

const item: MarketCapabilityView = {
  taskType: 'document.read', capabilityId: 'document.read', name: '文档助理', description: '读取文件',
  category: 'text', categoryLabelZh: '文字', acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file',
  requiredParams: [], outputKind: 'artifact', contractVersion: '1', publisherKind: 'official', publisherKinds: ['official'],
  executionMode: 'device', availability: 'contract_ready', requiresQuote: true,
  executionQuotePath: '/api/v8/developer/tasks/estimate', currency: 'CNY', products: [],
}

function bench() {
  const original = SessionId('original')
  let active: SessionId | null = original
  const listeners = new Set<() => void>()
  const compose = vi.fn(() => true)
  const openConversation = vi.fn()
  const response = Promise.withResolvers<{ ok: true; value: { capabilities: MarketCapabilityView[] } }>()
  const remote = { orderAdapterCapabilities: vi.fn(() => response.promise) }
  const capabilities = new MarketCapabilitiesController(remote)
  const binding = { scope: {}, compose }
  const selection = createMarketSelection(capabilities, id => id === original ? binding : undefined)
  const enter = createMarketConversationEntry({ selection, openConversation,
    currentSession: () => active,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  })
  return { enter, compose, openConversation, listeners, response, remote,
    selectSession: (next: SessionId | null) => { active = next; for (const listener of listeners) listener() },
  }
}

it('returns to the captured conversation only after the actual parser refresh accepts a multi-file reference', async () => {
  const b = bench()
  const pending = b.enter({ taskType: item.taskType, expected: item, goal: '核对原始材料' })
  expect(b.compose).not.toHaveBeenCalled(); expect(b.openConversation).not.toHaveBeenCalled()
  b.response.resolve({ ok: true, value: { capabilities: [item] } })
  expect(await pending).toBe(true)
  expect(b.compose).toHaveBeenCalledExactlyOnceWith('@文档助理', '核对原始材料')
  expect(b.openConversation).toHaveBeenCalledOnce()
  expect(b.listeners.size).toBe(0)
})

it.each([null, SessionId('different')])('aborts a pending selection when the originating conversation leaves the main view (%s)', async (next) => {
  const b = bench()
  const pending = b.enter({ taskType: item.taskType, expected: item })
  b.selectSession(next)
  b.response.resolve({ ok: true, value: { capabilities: [item] } })
  expect(await pending).toBe(false)
  expect(b.compose).not.toHaveBeenCalled(); expect(b.openConversation).not.toHaveBeenCalled()
  expect(b.listeners.size).toBe(0)
})

it('leaves the original draft and page intact when a newer choice cancels a late response', async () => {
  const b = bench(), abort = new AbortController()
  const pending = b.enter({ taskType: item.taskType }, abort.signal)
  abort.abort()
  b.response.resolve({ ok: true, value: { capabilities: [item] } })
  expect(await pending).toBe(false)
  expect(b.compose).not.toHaveBeenCalled(); expect(b.openConversation).not.toHaveBeenCalled()
  expect(b.listeners.size).toBe(0)
})

it('requires an actual current conversation and refuses a changed displayed contract without navigating', async () => {
  const b = bench()
  b.selectSession(null)
  expect(await b.enter({ taskType: item.taskType })).toBe(false)
  expect(b.remote.orderAdapterCapabilities).not.toHaveBeenCalled()
  b.selectSession(SessionId('original'))
  const pending = b.enter({ taskType: item.taskType, expected: item })
  b.response.resolve({ ok: true, value: { capabilities: [{ ...item, contractVersion: '2' }] } })
  expect(await pending).toBe(false)
  expect(b.compose).not.toHaveBeenCalled(); expect(b.openConversation).not.toHaveBeenCalled()
})
