// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { installMobileViewportMetrics, shouldFollowViewportAfterResize } from '../src/mobile-viewport.ts'

describe('mobile visual viewport metrics', () => {
  it('tracks keyboard-shrunk height and offset without a second bottom subtraction', () => {
    const root = document.createElement('main')
    const listeners = new Map<string, () => void>()
    const viewport = {
      height: 510.4, offsetTop: 3.2,
      addEventListener: vi.fn((name: string, cb: () => void) => { listeners.set(name, cb) }),
      removeEventListener: vi.fn(),
    } as unknown as VisualViewport
    const onResize = vi.fn()
    const dispose = installMobileViewportMetrics(root, viewport, onResize)
    expect(root.style.getPropertyValue('--qs-viewport-height')).toBe('510px')
    expect(root.style.getPropertyValue('--qs-viewport-offset-top')).toBe('3px')
    Object.assign(viewport, { height: 780.8, offsetTop: 0 })
    listeners.get('resize')?.()
    expect(onResize).toHaveBeenCalledTimes(1)
    expect(root.style.getPropertyValue('--qs-viewport-height')).toBe('781px')
    expect(root.style.getPropertyValue('--qs-viewport-offset-top')).toBe('0px')
    dispose()
    expect(vi.mocked(viewport.removeEventListener)).toHaveBeenCalled()
  })

  it('falls back to the layout viewport and resets offset when the keyboard closes or rotates', () => {
    const root = document.createElement('main')
    const listeners = new Map<string, () => void>()
    const viewport = {
      height: 400, offsetTop: 18,
      addEventListener: vi.fn((name: string, cb: () => void) => { listeners.set(name, cb) }),
      removeEventListener: vi.fn(),
    } as unknown as VisualViewport
    const dispose = installMobileViewportMetrics(root, viewport)
    Object.assign(viewport, { height: 844, offsetTop: 0 }); listeners.get('resize')?.()
    expect(root.style.getPropertyValue('--qs-viewport-height')).toBe('844px')
    expect(root.style.getPropertyValue('--qs-viewport-offset-top')).toBe('0px')
    dispose()
    const fallback = document.createElement('main')
    const fallbackDispose = installMobileViewportMetrics(fallback, null)
    expect(fallback.style.getPropertyValue('--qs-viewport-height')).toBe(`${String(window.innerHeight)}px`)
    expect(fallback.style.getPropertyValue('--qs-viewport-offset-top')).toBe('0px')
    fallbackDispose()
  })

  it('follows a keyboard resize only when the transcript was already near its end', () => {
    expect(shouldFollowViewportAfterResize({ scrollHeight: 1600, scrollTop: 756, clientHeight: 844 })).toBe(true)
    expect(shouldFollowViewportAfterResize({ scrollHeight: 1600, scrollTop: 600, clientHeight: 844 })).toBe(false)
    expect(shouldFollowViewportAfterResize({ scrollHeight: 1600, scrollTop: 756, clientHeight: 844 }, true)).toBe(false)
    expect(shouldFollowViewportAfterResize({ scrollHeight: 1600, scrollTop: 756, clientHeight: 844 }, false, 120)).toBe(true)
  })
})
