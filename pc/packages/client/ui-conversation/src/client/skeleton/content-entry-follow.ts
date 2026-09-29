const FOLLOW_THRESHOLD = 24

/**
 * Follow visible Session entries only while their scrollport's reader remains pinned.
 * @param scrollport - The Conversation occurrence's resident scroll container.
 * @param entries - Its Session-entry area, including the empty hidden state.
 * @param composer - Its resident composer seat.
 * @param isCurrent - Whether this occurrence still owns the captured Session binding.
 * @returns a disposer that silences queued callbacks before detaching resources.
 */
export function followContentEntries(
  scrollport: HTMLElement,
  entries: HTMLElement,
  composer: HTMLElement,
  isCurrent: () => boolean,
): () => void {
  let active = true
  let observedTop = scrollport.scrollTop
  let pinned = scrollport.scrollHeight - observedTop - scrollport.clientHeight <= FOLLOW_THRESHOLD + 1

  const readPosition = (): boolean => {
    const floor = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight)
    const expected = Math.min(observedTop, floor)
    const top = scrollport.scrollTop
    const moved = Math.abs(top - expected) > 0.5
    if (moved) pinned = top >= expected && floor - top <= FOLLOW_THRESHOLD + 1
    observedTop = top
    return moved
  }
  const onScroll = (): void => {
    if (active && isCurrent()) readPosition()
  }
  const observer = new ResizeObserver(() => {
    if (!active || !isCurrent()) return
    // A reader gesture or a Chat history jump can precede its scroll delivery.
    // Height growth alone must retain the ownership measured before that growth.
    if (readPosition() || !pinned || entries.hidden
      || scrollport.querySelector('[data-conversation-composer-overlay]') !== null) return
    const floor = Math.max(0, scrollport.scrollHeight - scrollport.clientHeight)
    if (Math.abs(scrollport.scrollTop - floor) > 0.5) scrollport.scrollTop = scrollport.scrollHeight
    observedTop = scrollport.scrollTop
  })
  scrollport.addEventListener('scroll', onScroll, { passive: true })
  observer.observe(entries)
  observer.observe(composer)
  observer.observe(scrollport)
  return () => {
    active = false
    scrollport.removeEventListener('scroll', onScroll)
    observer.disconnect()
  }
}
