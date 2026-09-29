// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MarkdownText } from '../src/markdown/MarkdownText.tsx'
import type { MarkdownLabels } from '../src/markdown/MarkdownText.tsx'

const labels: MarkdownLabels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes',
  image: { title: 'Image preview', preview: 'Enlarge image', close: 'Close preview',
    copy: 'Copy image', copied: 'Image copied', copyFailed: 'Copy failed', download: 'Download image',
    downloaded: 'Download started', downloadFailed: 'Download failed', zoomIn: 'Zoom in',
    zoomOut: 'Zoom out', zoomLevel: 'Zoom level', fit: 'Fit to window' },
}
const source = 'dsh-app://app/api/qianshou/result-media?task_id=owned&asset_id=verified'
const fixture = () => render(<MarkdownText text="![puppy](/owned-result)" labels={labels}
  pathImages={{ resolve: destination => destination === '/owned-result' ? source : undefined }} />)

afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Markdown authorized image actions', () => {
  it('opens a zoomable preview and returns focus after Escape', () => {
    fixture()
    const opener = screen.getByRole('button', { name: 'Enlarge image: puppy' })
    fireEvent.click(opener)
    expect(screen.getByRole('dialog', { name: 'Image preview' })).toBeTruthy()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close preview' }))
    fireEvent.click(screen.getByRole('button', { name: 'Zoom in' }))
    expect(screen.getByLabelText('Zoom level').textContent).toBe('150%')
    fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }))
    expect(screen.getByLabelText('Zoom level').textContent).toBe('100%')
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).toBe(opener)
  })

  it('keeps keyboard focus in the preview controls', () => {
    fixture(); fireEvent.click(screen.getByRole('button', { name: 'Enlarge image: puppy' }))
    const last = screen.getByRole('button', { name: 'Close preview' })
    last.focus(); fireEvent.keyDown(last, { key: 'Tab' })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Zoom in' }))
    fireEvent.keyDown(document.activeElement!, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)
  })

  it('copies bytes from the authorized source and reports success only after clipboard completion', async () => {
    const png = new Blob(['actual-image-bytes'], { type: 'image/png' })
    const fetchImage = vi.fn().mockResolvedValue({ ok: true, blob: async () => png })
    vi.stubGlobal('fetch', fetchImage)
    const received: Array<Record<string, Promise<Blob>>> = []
    vi.stubGlobal('ClipboardItem', class { constructor(readonly items: Record<string, Promise<Blob>>) { received.push(items) } })
    let finish!: () => void
    const write = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    vi.stubGlobal('navigator', { clipboard: { write } })
    fixture(); fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    expect(write).toHaveBeenCalledTimes(1)
    expect(screen.queryByText('Image copied')).toBeNull()
    expect(fetchImage).toHaveBeenCalledWith(source)
    expect(await received[0]!['image/png']).toBe(png)
    finish()
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Image copied') })
  })

  it('downloads original bytes under a local filename and leaves the signed source intact', async () => {
    vi.useFakeTimers()
    const png = new Blob(['image-original'], { type: 'image/png' })
    const fetchImage = vi.fn().mockResolvedValue({ ok: true, blob: async () => png })
    vi.stubGlobal('fetch', fetchImage)
    const create = vi.fn(() => 'blob:owned-download')
    const revoke = vi.fn()
    vi.stubGlobal('URL', class extends URL {
      static override createObjectURL = create
      static override revokeObjectURL = revoke
    })
    const clicked: Array<{ href: string; name: string }> = []
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, name: this.download })
    })
    fixture()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Download image' })) })
    expect(screen.getByRole('status').textContent).toBe('Download started')
    expect(fetchImage).toHaveBeenCalledWith(source)
    expect(create).toHaveBeenCalledWith(png)
    expect(clicked).toEqual([{ href: 'blob:owned-download', name: 'puppy.png' }])
    vi.runOnlyPendingTimers()
    expect(revoke).toHaveBeenCalledWith('blob:owned-download')
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['read', 'type'])('keeps a failed download visible without a success receipt: %s', async (kind) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: kind !== 'read',
      blob: async () => new Blob(['error'], { type: 'text/html' }) }))
    fixture(); fireEvent.click(screen.getByRole('button', { name: 'Download image' }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Download failed') })
    expect(screen.queryByText('Download started')).toBeNull()
  })

  it('reports unavailable image clipboard honestly', async () => {
    vi.stubGlobal('navigator', { clipboard: {} })
    fixture(); fireEvent.click(screen.getByRole('button', { name: 'Copy image' }))
    await waitFor(() => { expect(screen.getByRole('status').textContent).toBe('Copy failed') })
  })

  it('retains the alt fallback after load failure and rejects unowned routes', () => {
    const view = fixture(); fireEvent.error(screen.getByRole('img'))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('puppy')).toBeTruthy()
    view.unmount()
    render(<MarkdownText text="![forged](/owned-result)" labels={labels}
      pathImages={{ resolve: () => 'dsh-app://other/api/file?path=x' }} />)
    expect(screen.queryByRole('img')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
