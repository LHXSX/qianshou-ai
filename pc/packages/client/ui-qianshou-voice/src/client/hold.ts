/**
 * Bind press/release gestures without owning capture or submission.
 * @param control - Owned microphone button.
 * @param actions - Current capture lifecycle actions.
 * @returns Cancels the gesture and removes every listener.
 */
export function bindHoldToTalk(control: HTMLButtonElement, actions: {
  start(): void
  finish(): void
  cancel(): void
  cancelling(value: boolean): void
  active(): boolean
}): () => void {
  const events = new AbortController()
  let pointer: number | null = null
  let originY = 0
  let cancelled = false
  let keyHeld = false
  /**
   * A touch press focuses the button on some WebKit versions even though the
   * gesture is prevented.  Leaving that focus in place makes the release look
   * like a selected control (and can leave a text selection highlight around
   * the voice surface).  Keyboard activation keeps focus for accessibility;
   * only the pointer path clears it after the gesture has been finalized.
   */
  const end = (discard: boolean, clearPointerFocus = false): void => {
    if (pointer === null && !keyHeld) return
    pointer = null; keyHeld = false
    actions.cancelling(false)
    if (discard) actions.cancel(); else actions.finish()
    if (clearPointerFocus && document.activeElement === control) control.blur()
  }
  control.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || pointer !== null || keyHeld || control.disabled) return
    event.preventDefault(); pointer = event.pointerId; originY = event.clientY; cancelled = false
    try { control.setPointerCapture(pointer) } catch (error) { void error /* Window listeners own release when capture is unavailable. */ }
    actions.start()
  }, { signal: events.signal })
  window.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointer) return
    const next = originY - event.clientY > 56
    if (next !== cancelled) { cancelled = next; actions.cancelling(next) }
  }, { signal: events.signal })
  window.addEventListener('pointerup', (event) => { if (event.pointerId === pointer) end(cancelled, true) }, { signal: events.signal })
  window.addEventListener('pointercancel', (event) => { if (event.pointerId === pointer) end(true, true) }, { signal: events.signal })
  control.addEventListener('lostpointercapture', () => { end(true, true) }, { signal: events.signal })
  control.addEventListener('contextmenu', (event) => { event.preventDefault() }, { signal: events.signal })
  control.addEventListener('click', (event) => {
    event.preventDefault()
    // Screen-reader activation has no physical hold; a second activation finishes it.
    if (event.detail === 0 && pointer === null && !control.disabled) {
      if (keyHeld && actions.active()) end(false)
      else { keyHeld = true; actions.start() }
    }
  }, { signal: events.signal })
  control.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); end(true); return }
    if (![' ', 'Enter'].includes(event.key)) return
    event.preventDefault()
    if (!event.repeat && !keyHeld && pointer === null && !control.disabled) { keyHeld = true; actions.start() }
  }, { signal: events.signal })
  control.addEventListener('keyup', (event) => {
    if (![' ', 'Enter'].includes(event.key)) return
    event.preventDefault(); if (keyHeld) end(false)
  }, { signal: events.signal })
  window.addEventListener('blur', () => { end(true, true) }, { signal: events.signal })
  return () => { end(true); events.abort() }
}
