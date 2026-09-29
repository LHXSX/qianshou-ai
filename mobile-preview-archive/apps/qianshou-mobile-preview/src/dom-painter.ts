/** Materialize the shared mobile frame as accessible DOM elements, retaining native callbacks. */
import { materializeWindow } from './window/elements.ts'
import type { WindowFrame } from './window/window.ts'

/**
 * Create the browser projection without loading any native runtime.
 * @param frame - Shared mobile view and action tree.
 * @returns A detached DOM subtree; no network or Agent work occurs here.
 */
export function materializeMobileFrame(frame: WindowFrame): HTMLElement {
  return materializeWindow(frame.tree, (type, props, ...children) => {
    const element = document.createElement(type === 'input' ? 'textarea' : typeof props.bindtap === 'function' ? 'button' : 'div')
    element.dataset.testid = String(props.testId)
    if (element instanceof HTMLButtonElement) {
      element.type = 'button'
      const tap = props.bindtap as () => void
      element.addEventListener('click', tap)
    }
    if (element instanceof HTMLTextAreaElement) {
      element.value = String(props.value)
      element.placeholder = String(props.placeholder)
      element.rows = 2
      const input = props.bindinput as (event: { detail: { value: string } }) => void
      element.addEventListener('input', () => { input({ detail: { value: element.value } }) })
    }
    for (const child of children) element.append(child)
    return element
  })
}
