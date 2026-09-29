// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import { followContentEntries } from '../src/client/skeleton/content-entry-follow.ts'

type Observed = { callback: ResizeObserverCallback; targets: Element[]; disconnected: boolean }
const observed: Observed[] = []

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    record: Observed
    constructor(callback: ResizeObserverCallback) {
      this.record = { callback, targets: [], disconnected: false }
      observed.push(this.record)
    }
    observe(target: Element): void { this.record.targets.push(target) }
    disconnect(): void { this.record.disconnected = true }
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  observed.length = 0
})

function port(top = 200, height = 300) {
  const scroller = document.createElement('div')
  const entries = document.createElement('div')
  const composer = document.createElement('div')
  scroller.append(entries, composer)
  let viewport = 100
  let position = top
  let writes = 0
  // jsdom has no layout or native scroll clamping.
  Object.defineProperties(scroller, {
    clientHeight: { get: () => viewport },
    scrollHeight: { get: () => height },
    scrollTop: {
      get: () => position,
      set: (value: number) => { writes++; position = Math.max(0, Math.min(value, height - viewport)) },
    },
  })
  return {
    scroller, entries, composer,
    height(value: number): void { height = value; position = Math.min(position, Math.max(0, height - viewport)) },
    viewport(value: number): void { viewport = value },
    top(value: number, deliver = true): void {
      scroller.scrollTop = value
      if (deliver) fireEvent.scroll(scroller)
    },
    writes: () => writes,
    notify(record = observed.at(-1)!): void { record.callback([], {} as ResizeObserver) },
  }
}

describe('Conversation entry following', () => {
  it('follows entry and composer growth from the previous near-floor position', () => {
    const p = port(182)
    p.scroller.prepend(document.createElement('article'))
    const dispose = followContentEntries(p.scroller, p.entries, p.composer, () => true)
    p.height(500)
    p.notify()
    expect(p.scroller.scrollTop).toBe(400)
    p.height(560)
    p.notify()
    expect(p.scroller.scrollTop).toBe(460)
    p.viewport(80)
    p.notify()
    expect(p.scroller.scrollTop).toBe(480)
    dispose()
  })

  it('follows the first visible market entry without a Chat view', () => {
    const p = port(0, 100)
    p.entries.hidden = true
    const dispose = followContentEntries(p.scroller, p.entries, p.composer, () => true)
    p.entries.hidden = false
    p.height(400)
    p.notify()
    expect(p.scroller.scrollTop).toBe(300)
    dispose()
  })

  it('keeps an upward reader in place and follows again after returning to the floor', () => {
    const p = port()
    const dispose = followContentEntries(p.scroller, p.entries, p.composer, () => true)
    p.top(90)
    p.height(500)
    p.notify()
    expect(p.scroller.scrollTop).toBe(90)
    p.top(400)
    p.height(600)
    p.notify()
    expect(p.scroller.scrollTop).toBe(500)
    dispose()
  })

  it('preserves a small upward gesture whose scroll delivery is still queued', () => {
    const p = port()
    const dispose = followContentEntries(p.scroller, p.entries, p.composer, () => true)
    p.top(190, false)
    p.height(500)
    p.notify()
    expect(p.scroller.scrollTop).toBe(190)
    fireEvent.scroll(p.scroller)
    p.height(600)
    p.notify()
    expect(p.scroller.scrollTop).toBe(190)
    dispose()
  })

  it('respects a Chat history jump and does not repeat another owner’s floor write', () => {
    const p = port()
    const dispose = followContentEntries(p.scroller, p.entries, p.composer, () => true)
    p.top(80, false)
    p.height(500)
    p.notify()
    expect(p.scroller.scrollTop).toBe(80)
    p.top(400, false)
    const writes = p.writes()
    p.notify()
    p.notify()
    fireEvent.scroll(p.scroller)
    expect(p.writes()).toBe(writes)
    p.height(600)
    p.notify()
    expect(p.scroller.scrollTop).toBe(500)
    dispose()
  })

  it('retains following through a browser shrink clamp', () => {
    const p = port()
    const dispose = followContentEntries(p.scroller, p.entries, p.composer, () => true)
    p.height(180)
    p.notify()
    expect(p.scroller.scrollTop).toBe(80)
    p.height(400)
    p.notify()
    expect(p.scroller.scrollTop).toBe(300)
    dispose()
  })

  it('leaves hidden entries and a view-owned composer overlay alone', () => {
    const p = port()
    p.entries.hidden = true
    const dispose = followContentEntries(p.scroller, p.entries, p.composer, () => true)
    p.height(500)
    p.notify()
    expect(p.scroller.scrollTop).toBe(200)
    p.entries.hidden = false
    const overlay = document.createElement('div')
    overlay.dataset.conversationComposerOverlay = ''
    p.composer.append(overlay)
    p.notify()
    expect(p.scroller.scrollTop).toBe(200)
    overlay.remove()
    p.notify()
    expect(p.scroller.scrollTop).toBe(400)
    dispose()
  })

  it('rejects stale Session callbacks on the same DOM and detaches on unmount', () => {
    const p = port()
    let session = 'one'
    const removeListener = vi.spyOn(p.scroller, 'removeEventListener')
    const disposeOld = followContentEntries(p.scroller, p.entries, p.composer, () => session === 'one')
    const old = observed.at(-1)!
    session = 'two'
    p.height(500)
    p.notify(old)
    expect(p.scroller.scrollTop).toBe(200)
    disposeOld()
    expect(old.disconnected).toBe(true)
    expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function))
    p.height(100)
    const disposeNew = followContentEntries(p.scroller, p.entries, p.composer, () => session === 'two')
    const current = observed.at(-1)!
    p.height(400)
    p.notify(old)
    expect(p.scroller.scrollTop).toBe(0)
    p.notify(current)
    expect(p.scroller.scrollTop).toBe(300)
    disposeNew()
    expect(current.disconnected).toBe(true)
    p.height(600)
    p.notify(current)
    expect(p.scroller.scrollTop).toBe(300)
  })
})
