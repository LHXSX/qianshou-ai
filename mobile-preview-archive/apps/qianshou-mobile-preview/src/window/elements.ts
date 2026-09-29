/** Turn a window tree into renderer elements. This file imports no renderer. */
import type { WindowNode } from './window.ts'

/** `createElement` supplied by a mount renderer or a test double. */
export interface WindowCreateElement<Result = unknown> {
  (type: 'view' | 'text' | 'input', props: Readonly<Record<string, unknown>>, ...children: readonly (Result | string)[]): Result
}

/**
 * Walk one window node and emit `view` / `text` through `createElement`.
 * @param node - Projection node from {@link projectWindow}.
 * @param createElement - Renderer factory, or a test recorder.
 * @returns The element `createElement` returned.
 */
export function materializeWindow<Result>(node: WindowNode, createElement: WindowCreateElement<Result>): Result {
  const props = Object.freeze({ testId: node.testId,
    ...(node.tap === undefined ? {} : { bindtap: node.tap }),
    ...(node.type !== 'input' ? {} : { value: node.value ?? '', placeholder: node.placeholder ?? '',
      bindinput: (event: { readonly detail: { readonly value: string } }) => { node.input?.(event.detail.value) },
    }),
  })
  switch (node.type) {
    case 'input': return createElement('input', props)
    case 'text': return createElement('text', props, node.text ?? '')
    case 'view': return createElement('view', props, ...(node.children ?? []).map(child => materializeWindow(child, createElement)))
    default: throw new Error(`WINDOW_NODE_UNSUPPORTED:${String((node as { type: unknown }).type)}`)
  }
}
