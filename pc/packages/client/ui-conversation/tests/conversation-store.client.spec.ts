// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { createConversationStore, readConversationViewPreference } from '../src/client/stores.ts'

const KEY = 'dsh.conversation'
const createInput = () => new SessionInputShell({
  actx: {} as Context,
  defaultSink: async () => ({ kind: 'success' as const }),
  commandAttachments: {
    serialize: async () => [],
    release: () => {},
    unsupportedNotice: () => '',
  },
})

beforeEach(() => {
  localStorage.clear()
})

describe('createConversationStore', () => {
  it('owns draft, selected View, and one-shot View requests', () => {
    const store = createConversationStore().create()
    expect(store.store.getSnapshot()).toEqual({ draft: '', view: null, viewRequest: null })

    store.actions.setDraft('hello')
    store.actions.setView('chat')
    expect(store.store.getSnapshot()).toEqual({
      draft: 'hello',
      view: 'chat',
      viewRequest: null,
    })

    store.actions.openView('trajectory', 'call-1')
    expect(store.store.getSnapshot()).toMatchObject({
      view: 'trajectory',
      viewRequest: { view: 'trajectory', focus: 'call-1' },
    })
    store.actions.completeViewRequest()
    expect(store.store.getSnapshot().viewRequest).toBeNull()
  })

  it('persists per Session scope and clears the persisted value', () => {
    const first = createConversationStore().create('sess-1')
    first.actions.setDraft('draft for one')
    first.actions.setView('chat')
    expect(localStorage.getItem(`${KEY}.sess-1`)).not.toBeNull()
    expect(localStorage.getItem(`${KEY}.sess-2`)).toBeNull()

    const restored = createConversationStore().create('sess-1')
    expect(restored.store.getSnapshot()).toMatchObject({
      draft: 'draft for one',
      view: 'chat',
    })

    first.clearPersisted()
    expect(localStorage.getItem(`${KEY}.sess-1`)).toBeNull()
  })

  it('creates independent live instances', () => {
    const handle = createConversationStore()
    const first = handle.create()
    const second = handle.create()
    first.actions.setDraft('only first')
    expect(second.store.getSnapshot().draft).toBe('')
  })

  it('persists distinct guided drafts written before the mirror is bound', () => {
    const handle = createConversationStore()
    const videoId = 'video' as SessionId
    const csvId = 'csv' as SessionId
    const videoStore = handle.create(videoId)
    const videoInput = createInput()
    const videoTask = '用固定模板制作五秒 Mac 绘图视频插件'
    videoInput.setDraft(videoTask)
    expect(videoStore.store.getSnapshot().draft).toBe('')
    videoInput.bindMirror(videoStore.actions.setDraft)
    expect(videoStore.store.getSnapshot().draft).toBe(videoTask)
    videoInput.dispose()

    const csvStore = handle.create(csvId)
    const csvInput = createInput()
    const csvTask = '私有安装固定 CSV 结构体检插件'
    csvInput.setDraft(csvTask)
    csvInput.bindMirror(csvStore.actions.setDraft)
    csvInput.dispose()

    expect(handle.create(videoId).store.getSnapshot().draft).toBe(videoTask)
    expect(handle.create(csvId).store.getSnapshot().draft).toBe(csvTask)
  })

  it('does not persist an untouched blank input when its mirror is bound', () => {
    const store = createConversationStore().create('blank')
    const input = createInput()
    input.bindMirror(store.actions.setDraft)
    expect(localStorage.getItem(`${KEY}.blank`)).toBeNull()
    input.dispose()
  })

  it('reads only a usable persisted View preference', () => {
    const sessionId = 'sess-1' as SessionId
    const store = createConversationStore().create(sessionId)
    store.actions.setView('trajectory')
    expect(readConversationViewPreference(sessionId)).toBe('trajectory')

    localStorage.setItem(`${KEY}.${sessionId}`, '{invalid')
    expect(readConversationViewPreference(sessionId)).toBeNull()
  })
})
