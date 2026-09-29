// @vitest-environment jsdom
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { CharacterStage } from '../src/client/chat/voice/CharacterStage.tsx'
import type { CharacterFrame } from '../src/client/chat/voice/character-position.ts'

const t = makeTranslate(zh, commonZh)
let frames: Map<number, FrameRequestCallback>
let reduced = false

beforeEach(() => {
  reduced = false; frames = new Map()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++id, callback); return id })
  vi.stubGlobal('cancelAnimationFrame', (key: number) => { frames.delete(key) })
  vi.stubGlobal('matchMedia', () => ({ matches: reduced, addEventListener() {}, removeEventListener() {} }))
  vi.stubGlobal('innerWidth', 880)
  vi.stubGlobal('innerHeight', 600)
  const original = Reflect.get(HTMLElement.prototype, 'getBoundingClientRect')
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (!this.hasAttribute('data-character-stage')) return original.call(this)
    return new DOMRect(Number.parseFloat(this.style.getPropertyValue('--character-x')) || 0,
      Number.parseFloat(this.style.getPropertyValue('--character-y')) || 0,
      Math.min(220, innerWidth - 24), Math.min(330, innerHeight - 24))
  })
})

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

function setup(state: 'idle' | 'listening' | 'speaking' | 'busy' = 'idle') {
  const close = vi.fn()
  const interrupt = vi.fn()
  const renderer = vi.fn((frame: CharacterFrame) => <div data-testid="character-art">{frame.action}</div>)
  const mounted = vi.fn(); const unmounted = vi.fn()
  function Controls() {
    useEffect(() => { mounted(); return unmounted }, [])
    return <button type="button">Existing voice settings</button>
  }
  const view = render(<><input aria-label="Existing input" autoFocus /><CharacterStage
    state={state} status="当前状态" onClose={close} onInterrupt={interrupt} renderCharacter={renderer} t={t}
  ><Controls /></CharacterStage></>)
  return { ...view, close, interrupt, renderer, mounted, unmounted }
}

function position() {
  const box = screen.getByRole('complementary', { name: '千手互动角色' }).getBoundingClientRect()
  return { x: box.left, y: box.top }
}

function select(label: string) {
  fireEvent.click(screen.getByRole('button', { name: '角色动作与位置' }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

function frame(now: number) {
  act(() => {
    const pending = [...frames.values()]; frames.clear()
    for (const callback of pending) callback(now)
  })
}

describe('interactive character chrome', () => {
  it('starts compact without moving focus or mounting and unmounting voice controls', () => {
    const h = setup('speaking')
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Existing input' }))
    expect(screen.queryByRole('button', { name: 'Existing voice settings' })).toBeNull()
    expect(h.mounted).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '立即打断' }))
    expect(h.interrupt).toHaveBeenCalledOnce()
    expect(h.close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '更多语音控制' }))
    const settings = screen.getByRole('button', { name: 'Existing voice settings' })
    settings.focus(); fireEvent.keyDown(settings, { key: 'Escape' })
    expect(screen.queryByRole('button', { name: 'Existing voice settings' })).toBeNull()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '更多语音控制' }))
    expect(h.unmounted).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '结束语音' }))
    expect(h.close).toHaveBeenCalledOnce()
  })

  it('moves with the keyboard, docks to either edge, and fits after resize', () => {
    const h = setup()
    expect(position()).toEqual({ x: 648, y: 258 })
    fireEvent.keyDown(screen.getByRole('button', { name: '移动角色' }), { key: 'ArrowLeft', shiftKey: true })
    expect(position().x).toBe(608)
    select('移到左边')
    expect(position().x).toBe(12)
    expect(h.renderer.mock.lastCall?.[0]).toMatchObject({ action: 'lean', facing: 'left', moving: false })
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '角色动作与位置' }))
    select('移到右边')
    expect(position().x).toBe(648)
    act(() => { vi.stubGlobal('innerWidth', 300); vi.stubGlobal('innerHeight', 400); window.dispatchEvent(new Event('resize')) })
    expect(position()).toEqual({ x: 68, y: 58 })
    act(() => { vi.stubGlobal('innerWidth', 880); vi.stubGlobal('innerHeight', 600); window.dispatchEvent(new Event('resize')) })
    expect(position().x).toBe(648)
    select('坐在下边缘')
    act(() => { vi.stubGlobal('innerHeight', 800); window.dispatchEvent(new Event('resize')) })
    expect(position().y).toBe(458)
  })

  it('moves only after an explicit action and Escape stops that movement without closing voice', () => {
    const h = setup()
    frame(0); frame(100)
    expect(position()).toEqual({ x: 648, y: 258 })
    select('沿窗口走动'); frame(100); frame(132)
    expect(position().x).toBeLessThan(648)
    expect(h.renderer.mock.lastCall?.[0]).toMatchObject({ action: 'walk', moving: true })
    fireEvent.keyDown(screen.getByRole('button', { name: '移动角色' }), { key: 'Escape' })
    const stopped = position()
    frame(164)
    expect(position()).toEqual(stopped)
    expect(h.renderer.mock.lastCall?.[0]).toMatchObject({ action: 'idle', moving: false })
    expect(h.close).not.toHaveBeenCalled()
    select('沿边缘攀爬'); frame(200); frame(232)
    expect(position().y).toBeLessThan(stopped.y)
    expect(position().x).toBe(648)
  })

  it('honors reduced motion while retaining the requested pose', () => {
    reduced = true
    const h = setup()
    select('沿窗口走动'); frame(0); frame(100)
    expect(position()).toEqual({ x: 648, y: 258 })
    expect(h.renderer.mock.lastCall?.[0]).toMatchObject({ action: 'walk', moving: false })
  })

  it('settles a wave back to idle and can sit on the window bottom', () => {
    vi.useFakeTimers()
    const h = setup()
    select('招招手')
    expect(h.renderer.mock.lastCall?.[0].action).toBe('wave')
    act(() => { vi.advanceTimersByTime(2600) })
    expect(h.renderer.mock.lastCall?.[0].action).toBe('idle')
    fireEvent.keyDown(screen.getByRole('button', { name: '移动角色' }), { key: 'ArrowUp' })
    select('坐在下边缘')
    expect(position().y).toBe(258)
    expect(h.renderer.mock.lastCall?.[0].action).toBe('sit')
  })

  it('drags from the rendered position and keeps capture until release', () => {
    vi.stubGlobal('PointerEvent', MouseEvent)
    const h = setup()
    const handle = screen.getByRole('button', { name: '移动角色' })
    const release = vi.fn()
    handle.setPointerCapture = vi.fn(); handle.hasPointerCapture = () => true; handle.releasePointerCapture = release
    fireEvent.pointerDown(handle, { button: 0, clientX: 670, clientY: 540 })
    fireEvent.pointerMove(handle, { clientX: 610, clientY: 500 })
    expect(position()).toEqual({ x: 588, y: 218 })
    fireEvent.pointerUp(handle)
    expect(release).toHaveBeenCalledOnce()
    expect(h.close).not.toHaveBeenCalled()
  })
  it('avoids an expanded team panel and restores voice-control height when it closes', async () => {
    const panel = document.createElement('aside')
    panel.dataset.teamDock = 'expanded'
    panel.getBoundingClientRect = () => innerWidth === 360
      ? new DOMRect(56, 64, 296, 385) : new DOMRect(568, 76, 296, 420)
    document.body.append(panel)
    try {
      setup('speaking')
      expect(position().x).toBe(12)
      fireEvent.click(screen.getByRole('button', { name: '更多语音控制' }))
      expect(screen.getByRole('button', { name: 'Existing voice settings' })).toBeDefined()
      act(() => { vi.stubGlobal('innerWidth', 360); vi.stubGlobal('innerHeight', 640); window.dispatchEvent(new Event('resize')) })
      const stage = screen.getByRole('complementary', { name: '千手互动角色' })
      expect(stage.style.getPropertyValue('--character-details-max-height')).toBe('125px')
      expect(position().y).toBe(298)
      await act(async () => { panel.remove(); await Promise.resolve() })
      expect(stage.style.getPropertyValue('--character-details-max-height')).toBe('240px')
      expect(screen.getByRole('button', { name: '结束语音' })).toBeDefined()
    } finally { panel.remove() }
  })

})
