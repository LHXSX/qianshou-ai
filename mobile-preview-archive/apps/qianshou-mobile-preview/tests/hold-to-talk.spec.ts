// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindHoldToTalk } from '../src/hold-to-talk.ts'
const cleanups: (() => void)[] = []
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); document.body.replaceChildren() })
function setup() {
  const control = document.createElement('button'); document.body.append(control)
  let active = false
  const actions = { start: vi.fn(() => { active = true }), finish: vi.fn(() => { active = false }), cancel: vi.fn(() => { active = false }), cancelling: vi.fn(), active: () => active }
  cleanups.push(bindHoldToTalk(control, actions))
  const pointer = (type: string, y = 100, id = 1) => {
    const event = new MouseEvent(type, { clientY: y, button: 0, bubbles: true, cancelable: true })
    Object.defineProperty(event, 'pointerId', { value: id }); control.dispatchEvent(event)
  }
  return { control, actions, pointer }
}
describe('hold to talk gestures', () => {
  it('starts on press and finalizes once on release, ignoring the synthetic click', () => {
    const { control, actions, pointer } = setup()
    pointer('pointerdown'); expect(actions.start).toHaveBeenCalledOnce()
    pointer('pointerup'); pointer('lostpointercapture')
    control.dispatchEvent(new MouseEvent('click', { detail: 1 }))
    expect(actions.finish).toHaveBeenCalledOnce(); expect(actions.cancel).not.toHaveBeenCalled()
  })
  it('allows sliding back before release and cancels an upward release', () => {
    const { actions, pointer } = setup()
    pointer('pointerdown'); pointer('pointermove', 30); pointer('pointermove', 95); pointer('pointerup', 95)
    expect(actions.finish).toHaveBeenCalledOnce()
    pointer('pointerdown'); pointer('pointermove', 20); pointer('pointerup', 20)
    expect(actions.cancel).toHaveBeenCalledOnce(); expect(actions.cancelling).toHaveBeenCalledWith(true)
  })
  it('ignores another finger and discards interrupted recording', () => {
    const { actions, pointer } = setup()
    pointer('pointerdown'); pointer('pointerup', 100, 2)
    expect(actions.finish).not.toHaveBeenCalled()
    pointer('pointercancel'); expect(actions.cancel).toHaveBeenCalledOnce()
  })
  it('clears touch focus when a held recording is released', () => {
    const { control, actions, pointer } = setup()
    control.focus()
    pointer('pointerdown'); pointer('pointerup')
    expect(actions.finish).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(control)
  })
  it('clears touch focus when the gesture is interrupted', () => {
    const { control, actions, pointer } = setup()
    control.focus()
    pointer('pointerdown'); pointer('pointercancel')
    expect(actions.cancel).toHaveBeenCalledOnce()
    expect(document.activeElement).not.toBe(control)
  })
  it('supports held keyboard activation and escape without double starting', () => {
    const { control, actions } = setup()
    control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', cancelable: true }))
    control.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true, cancelable: true }))
    control.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', cancelable: true }))
    expect(actions.start).toHaveBeenCalledOnce(); expect(actions.finish).toHaveBeenCalledOnce()
    control.click(); control.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(actions.cancel).toHaveBeenCalledOnce()
  })
})
