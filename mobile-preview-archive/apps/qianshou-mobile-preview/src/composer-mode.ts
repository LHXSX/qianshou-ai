export type ComposerMode = 'text' | 'voice'

export function createComposerModeController(options: {
  input: () => HTMLTextAreaElement | null
  textToggle: HTMLButtonElement
  voiceSurface: HTMLElement
  keyboardToggle: HTMLButtonElement
  panel: HTMLElement
  onMode?: (mode: ComposerMode) => void
}): { mode: () => ComposerMode; setMode: (mode: ComposerMode) => void; reset: () => void } {
  let current: ComposerMode = 'text'
  let draft = ''
  const update = (): void => {
    const voice = current === 'voice'
    options.textToggle.hidden = voice
    options.input()?.toggleAttribute('hidden', voice)
    options.panel.hidden = !voice
    options.keyboardToggle.hidden = !voice
    options.voiceSurface.hidden = !voice
    options.textToggle.setAttribute('aria-pressed', String(voice))
    options.keyboardToggle.setAttribute('aria-pressed', String(!voice))
    options.onMode?.(current)
  }
  const setMode = (next: ComposerMode): void => {
    if (next === current) return
    const input = options.input()
    if (next === 'voice') { draft = input?.value ?? ''; input?.blur() }
    else if (input) { input.value = draft }
    current = next; update()
    if (next === 'text') options.input()?.focus()
  }
  options.textToggle.addEventListener('click', () => { setMode('voice') })
  options.keyboardToggle.addEventListener('click', () => { setMode('text') })
  update()
  return { mode: () => current, setMode, reset: () => { draft = ''; current = 'text'; update() } }
}
