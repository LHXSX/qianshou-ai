import { describe, expect, it } from 'vitest'
import { planImageIntent } from '@deepseek-ai/dsh-client-compute-trigger'
import { createImageConversations } from '../src/image-conversation.ts'
import { parseImageAlbum } from '../src/image-album.ts'

describe('image conversation ownership', () => {
  it('keeps unfinished image context in its original account and Session', () => {
    const conversations = createImageConversations()
    const first = conversations.get('account-1', 'session-1')
    first.lastPlan = planImageIntent('生成一张小猫图')
    first.userTurnsSinceImage = 1
    expect(conversations.get('account-1', 'session-2').lastPlan).toBeNull()
    expect(conversations.get('account-2', 'session-1').lastPlan).toBeNull()
    expect(conversations.get('account-1', 'session-1')).toBe(first)
    expect(conversations.forAccount('account-1')).toHaveLength(2)
    conversations.clear()
    expect(conversations.get('account-1', 'session-1')).not.toBe(first)
    expect(conversations.get('account-1', 'session-1').lastPlan).toBeNull()
  })

  it('retains a validated Session binding in a persisted image without inventing one for legacy images', () => {
    const image = {
      id: 'image-1', sessionKey: 'session-1', prompt: '一只猫',
      dataUri: 'data:image/jpeg;base64,QQ==', mimeType: 'image/jpeg', at: 1, caption: '完成',
    }
    const record = { accountId: '42', lastPrompt: '', userTurnsSinceImage: 0, images: [image] }
    expect(parseImageAlbum(record)?.images[0]?.sessionKey).toBe('session-1')
    expect(parseImageAlbum({ ...record, images: [{ ...image, sessionKey: undefined }] })?.images[0]?.sessionKey).toBeUndefined()
    expect(parseImageAlbum({ ...record, images: [{ ...image, sessionKey: 123 }] })).toBeNull()
  })
})
