/** Launch splash. Authentication is the next screen; the shell is never offered as a guest mode. */
import { copy as t } from '../copy.ts'

export interface WelcomeScreenOptions {
  readonly onLogin: () => void
  /** Kept for host compatibility; guest browsing is intentionally not exposed. */
  readonly onContinue?: () => void
  /** Brand hold before the two complete calligraphy lines appear. */
  readonly durationMs?: number
  /** Reading interval for the motto, after the brand hold. */
  readonly mottoDurationMs?: number
}

const defaultDurationMs = 3000
const defaultMottoDurationMs = 1800

/** Each phrase is one whole animated line, using the bundled eight-character brush-font subset. */
function createMotto(): HTMLParagraphElement {
  const motto = document.createElement('p')
  motto.className = 'splash-motto'
  motto.setAttribute('aria-label', t.splashTagline)
  const live = document.createElement('span')
  live.className = 'splash-motto-live'
  live.setAttribute('aria-hidden', 'true')
  live.textContent = t.splashTagline
  motto.append(live)
  for (const text of t.splashMotto.split('\n')) {
    const line = document.createElement('span')
    line.className = 'splash-motto-line'
    line.setAttribute('aria-hidden', 'true')
    line.textContent = text
    motto.append(line)
  }
  return motto
}

/** Mount the short brand splash shown before the Shanghai account entry. */
export function createWelcomeScreen(options: WelcomeScreenOptions): {
  readonly element: HTMLDialogElement
  readonly open: () => void
  readonly close: () => void
} {
  const element = document.createElement('dialog')
  element.className = 'welcome-screen splash-screen'
  element.setAttribute('aria-label', t.splashLabel)
  const durationMs = Math.max(0, options.durationMs ?? defaultDurationMs)
  const mottoDurationMs = Math.max(0, options.mottoDurationMs ?? defaultMottoDurationMs)
  element.style.setProperty('--splash-duration', `${durationMs + mottoDurationMs}ms`)
  element.dataset.stage = 'brand'
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] => {
    const value = document.createElement(tag)
    value.className = className
    value.textContent = text
    return value
  }
  const body = node('main', 'splash-content')
  const brand = node('div', 'splash-brand')
  const mark = node('div', 'splash-mark')
  for (const tone of ['violet', 'gold', 'pink']) {
    const bar = node('i', `brand-bar brand-bar-${tone}`)
    mark.append(bar)
  }
  mark.setAttribute('aria-hidden', 'true')
  const progress = node('div', 'splash-progress')
  progress.setAttribute('aria-hidden', 'true')
  brand.append(mark, node('div', 'splash-wordmark', t.brand))
  body.append(brand, createMotto(), progress)
  element.append(body)
  let timer: number | null = null
  let opened = false
  const close = (): void => {
    if (timer !== null) { window.clearTimeout(timer); timer = null }
    if (element.open) element.close()
    opened = false
  }
  const open = (): void => {
    if (opened) return
    opened = true
    element.dataset.stage = 'brand'
    if (!element.open) element.showModal()
    // Loading during the brand hold avoids waiting for a font request at the start of the motto.
    void document.fonts?.load('48px "Qianshou Motto"', t.splashTagline).catch(() => {
      // A failed local font load keeps the fallback text readable and does not block login.
    })
    timer = window.setTimeout(() => {
      if (!opened) return
      element.dataset.stage = 'motto'
      timer = window.setTimeout(() => {
        timer = null
        if (!opened) return
        opened = false
        element.close()
        options.onLogin()
      }, mottoDurationMs)
    }, durationMs)
  }
  element.addEventListener('cancel', (event) => { event.preventDefault() })
  return { element, open, close }
}
