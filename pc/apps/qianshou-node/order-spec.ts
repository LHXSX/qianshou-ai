/**
 * The one name for inline task text, copied through three layers.
 *
 * The platform reads `spec.inline_input` (`storage/repo.py`). The shard frame
 * carries `inline_input`. This node reads that same name into `inlineInput`.
 * `spec.text` is not on that path: the platform drops it, the shard arrives
 * without inline text, and the node refuses the assignment.
 */

/** Order-spec and shard-frame field. */
export const INLINE_INPUT_FIELD = 'inline_input' as const

/** Node offer field populated only from {@link INLINE_INPUT_FIELD}. */
export const NODE_INLINE_FIELD = 'inlineInput' as const

/** A projected inline order, or a refusal that names the missing field. */
export type InlineOrderProjection =
  | { readonly field: typeof INLINE_INPUT_FIELD; readonly nodeField: typeof NODE_INLINE_FIELD; readonly inlineInput: string }
  | { readonly field: typeof INLINE_INPUT_FIELD; readonly nodeField: typeof NODE_INLINE_FIELD; readonly rejected: 'missing-inline-input' }

/**
 * Project an order spec onto the shard field the node will read.
 *
 * A `text` property is ignored on purpose. Accepting it would hide the
 * field-name accident this function exists to keep red.
 * @param spec - Untrusted order spec.
 * @returns The inline text, or a refusal when `inline_input` is absent.
 */
export function projectInlineOrder(spec: Record<string, unknown>): InlineOrderProjection {
  const value = spec[INLINE_INPUT_FIELD]
  if (typeof value !== 'string' || value.length === 0) {
    return { field: INLINE_INPUT_FIELD, nodeField: NODE_INLINE_FIELD, rejected: 'missing-inline-input' }
  }
  return { field: INLINE_INPUT_FIELD, nodeField: NODE_INLINE_FIELD, inlineInput: value }
}
