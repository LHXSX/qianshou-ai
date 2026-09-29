/** Keep the mobile shell inside the visual viewport while the iOS keyboard is open. */
export function installMobileViewportMetrics(root: HTMLElement, viewport: VisualViewport | null = window.visualViewport,
  onResize?: () => void): () => void {
  let initialized = false
  const update = (): void => {
    const height = viewport?.height ?? window.innerHeight
    const offsetTop = viewport?.offsetTop ?? 0
    root.style.setProperty('--qs-viewport-height', `${Math.max(1, Math.round(height))}px`)
    root.style.setProperty('--qs-viewport-offset-top', `${Math.max(0, Math.round(offsetTop))}px`)
    if (initialized) onResize?.()
    initialized = true
  }
  update()
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
  return () => {
    viewport?.removeEventListener('resize', update)
    viewport?.removeEventListener('scroll', update)
    window.removeEventListener('resize', update)
  }
}

/**
 * A viewport resize may be caused by the keyboard rather than a new message.
 * Only follow the transcript when the user was already reading the latest
 * content; otherwise the resize must preserve their reading position.
 */
export function shouldFollowViewportAfterResize(
  content: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  userScrolledAway = false,
  threshold = 96,
): boolean {
  if (userScrolledAway || !Number.isFinite(threshold) || threshold < 0) return false
  return content.scrollHeight - content.scrollTop - content.clientHeight <= threshold
}
