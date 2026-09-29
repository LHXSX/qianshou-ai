// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyImage, imageFileName, saveImage } from '../src/image-file.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('imageFileName', () => {
  it('keeps an image extension and adds png to a bare title', () => {
    expect(imageFileName('history.png')).toBe('history.png')
    expect(imageFileName('photo.JPEG')).toBe('photo.JPEG')
    expect(imageFileName('qianshou')).toBe('qianshou.png')
    expect(imageFileName('  ')).toBe('qianshou.png')
    expect(imageFileName('a/b\\c')).toBe('a-b-c.png')
  })
})

describe('saveImage', () => {
  it('clicks a download anchor and removes it', () => {
    const downloads: string[] = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(`${this.download} ${this.getAttribute('href')}`)
    })
    saveImage('blob:pic', 'history.png')
    expect(downloads).toEqual(['history.png blob:pic'])
    expect(document.querySelector('a')).toBeNull()
  })
})

describe('copyImage', () => {
  it('writes a png blob and rejects a failed fetch', async () => {
    const png = new Blob([Uint8Array.from([9])], { type: 'image/png' })
    const write = vi.fn<(items: Array<{ data: Record<string, Blob> }>) => Promise<void>>(async () => {})
    vi.stubGlobal('ClipboardItem', class {
      constructor(readonly data: Record<string, Blob>) {}
    })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } })
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, blob: async () => png })))
    await copyImage('blob:pic')
    expect(write).toHaveBeenCalledTimes(1)
    const item = write.mock.calls[0]?.[0]?.[0]
    expect(item?.data['image/png']).toBe(png)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, blob: async () => png })))
    await expect(copyImage('blob:missing')).rejects.toThrow(/image fetch failed/)
  })
})
