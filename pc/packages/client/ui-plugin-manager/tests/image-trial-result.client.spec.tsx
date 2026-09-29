// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { ImageTrialResult } from '../src/client/ImageTrialResult.tsx'
import { zh } from '../src/client/image-trial-locales.ts'

const png = new Blob(['verified-original-png'], { type: 'image/png' })
const src = 'blob:verified-image-trial'
const filename = 'qianshou-image-result.png'
const props = { png, src, filename, width: 2048, height: 1152, onImageError: vi.fn(), t: (key: keyof typeof zh) => zh[key] }
beforeEach(() => { vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('preview must not fetch'))) })
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

function clipboard(write = vi.fn().mockResolvedValue(undefined)) {
  const items: Record<string, Blob>[] = []
  vi.stubGlobal('ClipboardItem', class { constructor(readonly value: Record<string, Blob>) { items.push(value) } })
  vi.stubGlobal('navigator', { clipboard: { write } })
  return { write, items }
}

it('opens the verified original, supports 100% dimensions and closes with focus restored', () => {
  render(<ImageTrialResult {...props} />)
  const opener = screen.getByRole('button', { name: zh.openImage })
  opener.focus(); fireEvent.click(opener)
  const dialog = screen.getByRole('dialog', { name: zh.imagePreview })
  const original = within(dialog).getByRole('img')
  expect(original.getAttribute('src')).toBe(src)
  expect(original.getAttribute('width')).toBe('2048')
  expect(original.getAttribute('height')).toBe('1152')
  fireEvent.click(within(dialog).getByRole('button', { name: zh.originalSize }))
  expect(within(dialog).getByRole('button', { name: zh.fitImage }).getAttribute('aria-pressed')).toBe('true')
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
  fireEvent.click(opener)
  const reopened = screen.getByRole('dialog')
  fireEvent.click(reopened.previousElementSibling!)
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(document.activeElement).toBe(opener)
  expect(fetch).not.toHaveBeenCalled()
})

it('copies original PNG bytes from the thumbnail context menu without fetching or copying a link', async () => {
  const { write, items } = clipboard()
  render(<ImageTrialResult {...props} />)
  expect(write).not.toHaveBeenCalled()
  fireEvent.contextMenu(screen.getByRole('img'), { clientX: 32, clientY: 48 })
  fireEvent.click(screen.getByRole('menuitem', { name: zh.copyImage }))
  await screen.findByText(zh.copied)
  expect(write).toHaveBeenCalledOnce()
  expect(items).toEqual([{ 'image/png': png }])
  expect(fetch).not.toHaveBeenCalled()
  expect(screen.queryByRole('menu')).toBeNull()
})

it('downloads the original blob from the context menu and retains the direct download', () => {
  const downloads: { url: string; filename: string }[] = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ url: this.href, filename: this.download })
  })
  render(<ImageTrialResult {...props} />)
  const link = screen.getByRole('link', { name: zh.download })
  expect(link.getAttribute('href')).toBe(src)
  expect(link.getAttribute('download')).toBe(filename)
  expect(downloads).toEqual([])
  fireEvent.contextMenu(screen.getByRole('img'), { clientX: 20, clientY: 60 })
  fireEvent.click(screen.getByRole('menuitem', { name: zh.downloadOriginal }))
  expect(downloads).toEqual([{ url: src, filename }])
  expect(fetch).not.toHaveBeenCalled()
})

it('provides copy and download in the enlarged view and Escape dismisses its menu before the image', async () => {
  const { items } = clipboard()
  render(<ImageTrialResult {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.openImage }))
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('link', { name: zh.download }).getAttribute('href')).toBe(src)
  fireEvent.contextMenu(within(dialog).getByRole('img'), { clientX: 80, clientY: 90 })
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(screen.getByRole('dialog')).toBe(dialog)
  fireEvent.click(within(dialog).getByRole('button', { name: zh.copyImage }))
  await within(dialog).findByText(zh.copied)
  expect(items).toEqual([{ 'image/png': png }])
  fireEvent.click(within(dialog).getByRole('button', { name: zh.closePreview }))
  expect(document.activeElement).toBe(screen.getByRole('button', { name: zh.openImage }))
})

it.each(['denied', 'unavailable'] as const)('shows an image clipboard error when %s', async (reason) => {
  if (reason === 'denied') clipboard(vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')))
  else vi.stubGlobal('navigator', {})
  render(<ImageTrialResult {...props} />)
  fireEvent.click(screen.getByRole('button', { name: zh.copyImage }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.copyFailed)
  expect(screen.getByRole('img').getAttribute('src')).toBe(src)
})

it('keeps the old image while one explicit regeneration is pending and disables unavailable upgrades', async () => {
  let finish!: (value: boolean) => void
  const onRegenerate = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  render(<ImageTrialResult {...props} onRegenerate={onRegenerate} />)
  expect(onRegenerate).not.toHaveBeenCalled()
  const trigger = screen.getByRole('button', { name: zh.regenerate })
  fireEvent.click(trigger); fireEvent.click(trigger)
  await waitFor(() => { expect(onRegenerate).toHaveBeenCalledOnce() })
  expect((screen.getByRole('button', { name: zh.regenerating }) as HTMLButtonElement).disabled).toBe(true)
  expect(screen.getByRole('img').getAttribute('src')).toBe(src)
  for (const label of [zh.clearer, zh.highDefinition]) {
    const button = screen.getByRole('button', { name: label }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent).toBe(zh.upgradesUnavailable)
  }
  await act(async () => { finish(true) })
  expect(screen.getByText(zh.regenerateSubmitted)).toBeTruthy()
  expect(screen.getByRole('img').getAttribute('src')).toBe(src)
})

it.each(['refused', 'error'] as const)('retains the old result and reports regeneration %s without retrying', async (failure) => {
  const onRegenerate = failure === 'refused' ? vi.fn().mockResolvedValue(false) : vi.fn().mockRejectedValue(new Error('offline'))
  render(<ImageTrialResult {...props} onRegenerate={onRegenerate} />)
  fireEvent.click(screen.getByRole('button', { name: zh.regenerate }))
  expect((await screen.findByRole('alert')).textContent).toBe(zh.regenerateFailed)
  expect(onRegenerate).toHaveBeenCalledOnce()
  expect(screen.getByRole('img').getAttribute('src')).toBe(src)
})

it.each([['clearer', 12], ['highDefinition', 20]] as const)('confirms %s as a new image and submits only once after the explicit action', async (key, steps) => {
  let finish!: (value: boolean) => void
  const upgrade = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve }))
  render(<ImageTrialResult {...props} onClearer={key === 'clearer' ? upgrade : vi.fn()}
    onHighDefinition={key === 'highDefinition' ? upgrade : vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: zh[key] }))
  const firstDialog = screen.getByRole('dialog', { name: zh[key] })
  expect(firstDialog.textContent).toContain(zh.upgradeConfirm.replace('{steps}', String(steps)))
  expect(upgrade).not.toHaveBeenCalled()
  fireEvent.click(within(firstDialog).getByRole('button', { name: zh.cancelUpgrade }))
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(upgrade).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: zh[key] }))
  const start = within(screen.getByRole('dialog', { name: zh[key] })).getByRole('button', { name: zh.startUpgrade })
  fireEvent.click(start); fireEvent.click(start)
  await waitFor(() => { expect(upgrade).toHaveBeenCalledOnce() })
  expect(screen.getByRole('img').getAttribute('src')).toBe(src)
  expect((screen.getByRole('button', { name: zh.clearer }) as HTMLButtonElement).disabled).toBe(true)
  expect((screen.getByRole('button', { name: zh.highDefinition }) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { finish(false) })
  expect((await screen.findByRole('alert')).textContent).toBe(zh.regenerateFailed)
  expect(upgrade).toHaveBeenCalledOnce()
  expect(screen.getByRole('img').getAttribute('src')).toBe(src)
})
