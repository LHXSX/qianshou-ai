import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, Session } from 'electron'
import { installProductPermissions } from '../src/product-permissions.ts'

function fixture() {
  const browserSession = {
    setPermissionCheckHandler: vi.fn<Session['setPermissionCheckHandler']>(),
    setPermissionRequestHandler: vi.fn<Session['setPermissionRequestHandler']>(),
  }
  const contents = { getURL: vi.fn(() => 'dsh-app://app/'), isDestroyed: vi.fn(() => false) }
  const window = { webContents: contents, isDestroyed: vi.fn(() => false) }
  let current: BrowserWindow | undefined = window as unknown as BrowserWindow
  installProductPermissions(browserSession as unknown as Session, () => current)
  return {
    contents: contents as unknown as Electron.WebContents,
    window, check: browserSession.setPermissionCheckHandler.mock.calls[0]![0]!,
    request: browserSession.setPermissionRequestHandler.mock.calls[0]![0]!,
    detach: () => { current = undefined },
  }
}
const document = { isMainFrame: true, requestingUrl: 'dsh-app://app/' }

describe('Qianshou product capture permission ownership', () => {
  it('allows only microphone media and preserves owned document copy and fullscreen controls', () => {
    const f = fixture()
    expect(f.check(f.contents, 'media', 'dsh-app://app', { ...document, mediaType: 'audio' })).toBe(true)
    const callback = vi.fn()
    f.request(f.contents, 'media', callback, { ...document, mediaTypes: ['audio'] })
    expect(callback).toHaveBeenLastCalledWith(true)
    for (const permission of ['clipboard-read', 'clipboard-sanitized-write', 'fullscreen'] as const) {
      expect(f.check(f.contents, permission, 'dsh-app://app', document)).toBe(true)
      f.request(f.contents, permission, callback, document)
      expect(callback).toHaveBeenLastCalledWith(true)
    }
    for (const mediaType of ['video', 'unknown', undefined] as const) {
      expect(f.check(f.contents, 'media', 'dsh-app://app', { ...document, ...(mediaType === undefined ? {} : { mediaType }) })).toBe(false)
    }
    for (const mediaTypes of [['video'], ['audio', 'video'], [], undefined] as const) {
      f.request(f.contents, 'media', callback, { ...document, mediaTypes: mediaTypes && [...mediaTypes] })
      expect(callback).toHaveBeenLastCalledWith(false)
    }
    for (const permission of ['display-capture', 'notifications', 'geolocation', 'unknown'] as const) {
      f.request(f.contents, permission, callback, document)
      expect(callback).toHaveBeenLastCalledWith(false)
    }
  })

  it('rejects invalid origins, embedded documents and changed window ownership', () => {
    const f = fixture()
    const callback = vi.fn()
    const check = (details = document) => f.check(f.contents, 'media', 'dsh-app://app', { ...details, mediaType: 'audio' })
    for (const requestingUrl of ['https://app/', 'dsh-app://shell/', 'dsh-app://app.evil/', 'dsh-app://user@app/', 'dsh-app://app:88/', 'invalid', undefined]) {
      expect(check({ ...document, requestingUrl } as typeof document)).toBe(false)
      f.request(f.contents, 'media', callback, { ...document, requestingUrl: requestingUrl!, mediaTypes: ['audio'] })
      expect(callback).toHaveBeenLastCalledWith(false)
    }
    expect(check({ ...document, isMainFrame: false })).toBe(false)
    expect(f.check(null, 'media', 'dsh-app://app', { ...document, mediaType: 'audio' })).toBe(false)
    expect(f.check(f.contents, 'media', 'https://example.com', { ...document, mediaType: 'audio' })).toBe(false)
    expect(f.check(f.contents, 'media', 'dsh-app://app', { ...document, mediaType: 'audio', securityOrigin: 'https://example.com' })).toBe(false)
    f.request(f.contents, 'media', callback, { ...document, mediaTypes: ['audio'], securityOrigin: 'https://example.com' })
    expect(callback).toHaveBeenLastCalledWith(false)
    f.window.webContents.getURL.mockReturnValue('https://example.com')
    expect(check()).toBe(false)
    f.window.webContents.getURL.mockReturnValue('dsh-app://app/')
    f.window.webContents.isDestroyed.mockReturnValue(true)
    expect(check()).toBe(false)
    f.window.webContents.isDestroyed.mockReturnValue(false)
    f.window.isDestroyed.mockReturnValue(true)
    expect(check()).toBe(false)
    f.window.isDestroyed.mockReturnValue(false)
    f.detach()
    expect(check()).toBe(false)
  })
})
