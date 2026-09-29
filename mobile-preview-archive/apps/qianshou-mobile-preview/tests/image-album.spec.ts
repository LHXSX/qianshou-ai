import { describe, expect, it } from 'vitest'
import { parseImageAlbum } from '../src/image-album.ts'

describe('image album', () => {
  it('keeps a well-formed picture and drops credential-shaped garbage', () => {
    const record = parseImageAlbum({
      accountId: '42',
      lastPrompt: '一只猫',
      userTurnsSinceImage: 0,
      images: [{
        id: 'img-1', prompt: '一只猫', dataUri: 'data:image/jpeg;base64,QQ==',
        mimeType: 'image/jpeg', at: 1, caption: '图片已生成。',
      }],
    })
    expect(record?.images).toHaveLength(1)
    expect(parseImageAlbum({ accountId: '42', lastPrompt: 'x', userTurnsSinceImage: 0, images: [{
      id: 'x', prompt: 'x', dataUri: 'https://evil.example/a.jpg', mimeType: 'image/jpeg', at: 1, caption: 'x',
    }] })).toBeNull()
    expect(parseImageAlbum({ access_token: 'secret' })).toBeNull()
  })
})
