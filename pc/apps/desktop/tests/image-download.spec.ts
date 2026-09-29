import { describe, expect, it, vi } from 'vitest'
import type { Session } from 'electron'
import { imageSavePath, installImageDownloads } from '../src/image-download.ts'

describe('imageSavePath', () => {
  it('keeps a free image name and skips occupied names and non-images', () => {
    const exists = (path: string) => path.endsWith('/qianshou.jpeg') || path.endsWith('/qianshou 2.jpeg')
    expect(imageSavePath('/Downloads', 'qianshou.jpeg', exists)).toBe('/Downloads/qianshou 3.jpeg')
    expect(imageSavePath('/Downloads', 'qianshou.png', exists)).toBe('/Downloads/qianshou.png')
    expect(imageSavePath('/Downloads', '../qianshou.png', exists)).toBeUndefined()
    expect(imageSavePath('/Downloads', 'notes.txt', exists)).toBeUndefined()
  })
})

describe('installImageDownloads', () => {
  it('sets a downloads path for an image and leaves other files alone', () => {
    const on = vi.fn()
    installImageDownloads({ on } as unknown as Session, () => '/Downloads')
    const listener = on.mock.calls[0]?.[1] as (event: unknown, item: { getFilename: () => string; setSavePath: (path: string) => void }) => void
    const image = { getFilename: () => 'qianshou.jpeg', setSavePath: vi.fn() }
    listener({}, image)
    expect(image.setSavePath).toHaveBeenCalledWith('/Downloads/qianshou.jpeg')
    const other = { getFilename: () => 'update.zip', setSavePath: vi.fn() }
    listener({}, other)
    expect(other.setSavePath).not.toHaveBeenCalled()
  })
})
