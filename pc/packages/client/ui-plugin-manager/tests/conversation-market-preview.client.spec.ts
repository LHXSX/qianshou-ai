// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { createConversationMarketStore, type ConversationMarketCall } from '../src/client/conversation-market-store.ts'
import { createConversationMarketPreview } from '../src/client/conversation-market-preview.ts'

afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })
const sessionId = 'preview-market-session' as SessionId
const other = 'preview-other-session' as SessionId
const key = (id: SessionId): string => `qianshou.market-calls.${id}`
const call: ConversationMarketCall = {
  id: 'market-call-11111111-1111-4111-8111-111111111111', sessionId,
  createdAt: '2026-09-26T13:00:00.000Z', goal: '一个小猫',
  capability: { taskType: 'image.generate', capabilityId: 'image.generate', name: '官方出图', category: 'image' },
  continuation: { planId: null, workloadId: null, submission: 'idle' },
}

it('reads an exact cold Session written by the real store without creating a store or mutating persisted calls', () => {
  const original = createConversationMarketStore().create(sessionId)
  original.actions.addCall(call)
  const raw = localStorage.getItem(key(sessionId))
  const set = vi.spyOn(Storage.prototype, 'setItem')
  const get = vi.spyOn(Storage.prototype, 'getItem')
  const preview = createConversationMarketPreview()
  try {
    expect(preview.provider.read(sessionId)).toEqual({ kind: 'content', title: '@官方出图 一个小猫',
      searchText: '@官方出图 一个小猫', updatedAt: Date.parse(call.createdAt) })
    expect(preview.provider.read(other)).toBeNull()
    expect(get.mock.calls.map(([name]) => name)).toEqual([key(sessionId), key(other)])
    expect(set).not.toHaveBeenCalled()
    expect(localStorage.getItem(key(sessionId))).toBe(raw)
  } finally { preview.dispose() }
})

it('counts unquoted and uncertain valid calls without attributing legacy calls to a login', () => {
  const original = createConversationMarketStore().create(sessionId)
  original.actions.addCall(call)
  original.actions.continueCall(call.id, { planId: 'plan_123', workloadId: null, submission: 'uncertain' })
  const preview = createConversationMarketPreview()
  try {
    expect(preview.provider.read(sessionId)?.kind).toBe('content')
    expect(original.getSnapshot().calls[0]?.usageOwner).toBeUndefined()
    expect(original.getSnapshot().calls[0]?.continuation.submission).toBe('uncertain')
  } finally { preview.dispose() }
})

it('keeps foreign, invalid or unreadable history unavailable without inventing a title or search result', () => {
  const preview = createConversationMarketPreview()
  try {
    localStorage.setItem(key(sessionId), JSON.stringify({ calls: [] }))
    expect(preview.provider.read(sessionId)).toBeNull()
    for (const calls of [[{ ...call, sessionId: other }], [{ ...call, id: 'invalid' }]]) {
      localStorage.setItem(key(sessionId), JSON.stringify({ calls }))
      expect(preview.provider.read(sessionId)).toEqual({ kind: 'unavailable' })
    }
    for (const raw of ['{', '{}', 'null', '{"calls":{}}']) {
      localStorage.setItem(key(sessionId), raw)
      expect(preview.provider.read(sessionId)).toEqual({ kind: 'unavailable' })
    }
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('blocked', 'SecurityError') })
    expect(preview.provider.read(other)).toEqual({ kind: 'unavailable' })
  } finally { preview.dispose() }
})

it('keeps a large valid Unicode request as content with single-line 48/512-code-point previews', () => {
  const original = createConversationMarketStore().create(sessionId)
  original.actions.addCall({ ...call, goal: '猫🐈\n'.repeat(1800) })
  const preview = createConversationMarketPreview()
  try {
    const saved = preview.provider.read(sessionId)
    expect(saved?.kind).toBe('content')
    if (saved?.kind !== 'content') throw new Error('missing valid request preview')
    expect(Array.from(saved.title)).toHaveLength(48)
    expect(saved.title.endsWith('…')).toBe(true)
    expect(saved.title).not.toContain('\n')
    expect(Array.from(saved.searchText!)).toHaveLength(512)
    expect(saved.searchText).not.toContain('\n')
  } finally { preview.dispose() }
})

it('contains a subscriber exception so other listeners and the committed request survive', () => {
  const original = createConversationMarketStore().create(sessionId)
  original.actions.addCall(call)
  const preview = createConversationMarketPreview()
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const healthy = vi.fn()
  preview.provider.subscribe(() => { throw new Error('private subscriber failure') })
  preview.provider.subscribe(healthy)
  try {
    expect(() => { preview.recorded(call) }).not.toThrow()
    expect(healthy).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(preview.provider.read(sessionId)?.kind).toBe('content')
    expect(error).toHaveBeenCalledExactlyOnceWith('market Session preview notification failed')
    error.mockClear(); healthy.mockClear()
    window.dispatchEvent(new StorageEvent('storage', { key: key(sessionId) }))
    expect(healthy).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(error).toHaveBeenCalledExactlyOnceWith('market Session preview notification failed')
  } finally { preview.dispose() }
})

it('uses one storage listener for multiple subscriptions and removes it after the last unsubscribe', () => {
  const preview = createConversationMarketPreview()
  const first = vi.fn(), second = vi.fn()
  const stopFirst = preview.provider.subscribe(first)
  const stopSecond = preview.provider.subscribe(second)
  try {
    window.dispatchEvent(new StorageEvent('storage', { key: key(sessionId) }))
    expect(first).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(second).toHaveBeenCalledExactlyOnceWith(sessionId)
    stopFirst(); stopFirst()
    window.dispatchEvent(new StorageEvent('storage', { key: key(other) }))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    stopSecond()
    window.dispatchEvent(new StorageEvent('storage', { key: key(other) }))
    expect(second).toHaveBeenCalledTimes(2)
  } finally { preview.dispose() }
})

it('bounds raw UTF-8 bytes and row inspection without claiming an unexamined history is empty', () => {
  const preview = createConversationMarketPreview()
  try {
    localStorage.setItem(key(sessionId), '猫'.repeat(400000))
    expect(preview.provider.read(sessionId)).toEqual({ kind: 'unavailable' })
    localStorage.setItem(key(sessionId), JSON.stringify({ calls: [call, ...Array.from({ length: 128 }, () => ({}))] }))
    expect(preview.provider.read(sessionId)).toEqual({ kind: 'unavailable' })
    localStorage.setItem(key(sessionId), JSON.stringify({ calls: [...Array.from({ length: 128 }, () => ({})), call] }))
    expect(preview.provider.read(sessionId)?.kind).toBe('content')
  } finally { preview.dispose() }
})

it('publishes committed content even when persistence fails and removes notifications and late writers on disposal', () => {
  const original = createConversationMarketStore().create(sessionId)
  const preview = createConversationMarketPreview()
  const notify = vi.fn()
  const stop = preview.provider.subscribe(notify)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError') })
  try {
    original.actions.addCall(call)
    preview.recorded(call)
    expect(localStorage.getItem(key(sessionId))).toBeNull()
    expect(preview.provider.read(sessionId)?.kind).toBe('content')
    expect(notify).toHaveBeenCalledExactlyOnceWith(sessionId)
    stop(); stop()
    preview.changed(sessionId)
    expect(notify).toHaveBeenCalledTimes(1)
    preview.provider.subscribe(notify)
    preview.dispose(); preview.dispose()
    preview.recorded({ ...call, goal: '晚到' }); preview.changed(sessionId)
    window.dispatchEvent(new StorageEvent('storage', { key: key(sessionId) }))
    expect(preview.provider.read(sessionId)).toBeNull()
    expect(notify).toHaveBeenCalledTimes(1)
  } finally { preview.dispose() }
})

it('invalidates only the changed exact Session and removes its cross-window listener when unsubscribed', () => {
  const preview = createConversationMarketPreview()
  const notify = vi.fn()
  preview.provider.read(sessionId)
  const stop = preview.provider.subscribe(notify)
  try {
    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated.preference' }))
    expect(notify).not.toHaveBeenCalled()
    window.dispatchEvent(new StorageEvent('storage', { key: key(other) }))
    expect(notify).toHaveBeenCalledExactlyOnceWith(other)
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    expect(notify).toHaveBeenLastCalledWith(sessionId)
    stop()
    window.dispatchEvent(new StorageEvent('storage', { key: key(sessionId) }))
    expect(notify).toHaveBeenCalledTimes(2)
  } finally { preview.dispose() }
})
