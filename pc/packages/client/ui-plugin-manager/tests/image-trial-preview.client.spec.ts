// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { WorkspaceSessionPreviewRegistry } from '../../ui-workspace/src/client/session-preview-registry.ts'
import { visibleSessionIds } from '../../ui-workspace/src/client/tree.ts'
import { createConversationImageTrialPreview } from '../src/client/conversation-image-trial-preview.ts'
import { createImageTrialStore, recordImageTrialCall, type ImageTrialCall } from '../src/client/image-trial-store.ts'

afterEach(() => { localStorage.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const sessionId = 'image-only-session' as SessionId
const other = 'other-session' as SessionId
const call: ImageTrialCall = { id: 'image-trial-11111111-1111-4111-8111-111111111111', sessionId,
  createdAt: '2026-09-29T13:00:00.000Z', prompt: '葫芦娃，横屏', size: 'landscape', submission: 'settled',
  request: { id: '11111111-1111-4111-8111-111111111111', sessionId, prompt: '葫芦娃，横屏', size: 'landscape' } }
const key = (id: SessionId): string => `qianshou.image-trials.${id}`

it('keeps a cold media-only Session visible after leaving it without changing Host blank or any saved bytes', () => {
  createImageTrialStore().create(sessionId).actions.add(call)
  const original = localStorage.getItem(key(sessionId))
  const list: SessionListState = { ids: [sessionId, other], phase: 'ready', subagentsByParent: {}, jobsBySession: {},
    byId: { [sessionId]: { id: sessionId, displayTitle: 'New Session', blank: true, running: false, updatedAt: 0, retainedBy: {} },
      [other]: { id: other, displayTitle: 'a text conversation', blank: false, running: false, updatedAt: 0, retainedBy: {} } } }
  const registry = new WorkspaceSessionPreviewRegistry(createSnapshotStore(list))
  const preview = createConversationImageTrialPreview()
  const write = vi.spyOn(Storage.prototype, 'setItem')
  const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
  try {
    expect(visibleSessionIds(list, [])).toEqual([other])
    registry.register(preview.provider)
    expect(visibleSessionIds(list, [], registry.snapshots.getSnapshot())).toEqual([sessionId, other])
    expect(registry.read(sessionId)).toMatchObject({ kind: 'content', title: '@出图 葫芦娃，横屏' })
    expect(list.byId[sessionId]?.blank).toBe(true)
    expect(preview.provider.read(other)).toBeNull()
    expect(write).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
    expect(localStorage.getItem(key(sessionId))).toBe(original)
  } finally { registry.dispose(); preview.dispose() }
})

it('publishes the first durable image request and leaves no occupied preview after a failed write', () => {
  const store = createImageTrialStore().create(sessionId)
  const preview = createConversationImageTrialPreview()
  const changed = vi.fn()
  const stop = preview.provider.subscribe(changed)
  try {
    expect(preview.provider.read(sessionId)).toBeNull()
    const pending = { ...call, submission: 'pending' as const }
    expect(recordImageTrialCall(store.actions, pending)).toBe(true)
    preview.changed(sessionId)
    expect(changed).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(preview.provider.read(sessionId)).toMatchObject({ kind: 'content' })
    store.actions.remove(pending)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage full') })
    expect(recordImageTrialCall(store.actions, pending)).toBe(false)
    expect(preview.provider.read(sessionId)).toBeNull()
  } finally { stop(); preview.dispose() }
})

it('treats foreign, malformed or oversized saved data as unavailable instead of reusable empty history', () => {
  const preview = createConversationImageTrialPreview()
  try {
    for (const raw of ['{', JSON.stringify({ calls: [{ ...call, sessionId: other }] }),
      '猫'.repeat(400000), JSON.stringify({ calls: [call, ...Array.from({ length: 128 }, () => ({}))] })]) {
      localStorage.setItem(key(sessionId), raw)
      expect(preview.provider.read(sessionId)).toEqual({ kind: 'unavailable' })
    }
    localStorage.setItem(key(sessionId), '{"calls":[]}')
    expect(preview.provider.read(sessionId)).toBeNull()
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    expect(preview.provider.read(sessionId)).toEqual({ kind: 'unavailable' })
  } finally { preview.dispose() }
})

it('bounds the title and search text and preserves explicit user input', () => {
  const prompt = '猫🐈\n'.repeat(700)
  createImageTrialStore().create(sessionId).actions.add({ ...call, prompt, request: { ...call.request!, prompt } })
  const preview = createConversationImageTrialPreview()
  try {
    const value = preview.provider.read(sessionId)
    expect(value?.kind).toBe('content')
    if (value?.kind !== 'content') throw new Error('expected saved media content')
    expect(Array.from(value.title)).toHaveLength(48)
    expect(Array.from(value.searchText!)).toHaveLength(512)
    expect(value.title).not.toContain('\n')
    expect(JSON.parse(localStorage.getItem(key(sessionId))!) as { calls: ImageTrialCall[] })
      .toMatchObject({ calls: [{ prompt }] })
  } finally { preview.dispose() }
})

it('invalidates only exact image history and removes cross-window and late notifications on disposal', () => {
  const preview = createConversationImageTrialPreview()
  const changed = vi.fn()
  preview.provider.read(sessionId)
  const stop = preview.provider.subscribe(changed)
  window.dispatchEvent(new StorageEvent('storage', { key: key(sessionId) }))
  expect(changed).toHaveBeenCalledExactlyOnceWith(sessionId)
  window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
  expect(changed).toHaveBeenCalledTimes(1)
  preview.dispose(); stop(); preview.changed(sessionId)
  window.dispatchEvent(new StorageEvent('storage', { key: null }))
  expect(changed).toHaveBeenCalledTimes(1)
  expect(preview.provider.read(sessionId)).toBeNull()
})
