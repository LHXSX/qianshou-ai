/** A failed auxiliary view cannot stop independent conversation controls from updating. */
export type MobileViewSection = 'navigation' | 'transcript' | 'account'

/**
 * Retain the last working section and report a local error until its next successful render.
 * @param update - Detached section construction followed by its DOM replacement.
 * @param report - Receives only a fixed section name and recovery state, never message data.
 */
export function renderMobileSection(section: MobileViewSection, update: () => void,
  report: (section: MobileViewSection, failed: boolean) => void): void {
  try {
    update()
  } catch {
    console.error(`MOBILE_VIEW_UPDATE_FAILED:${section}`)
    report(section, true)
    return
  }
  report(section, false)
}
