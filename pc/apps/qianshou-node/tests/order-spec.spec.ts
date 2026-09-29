import { describe, expect, it } from 'vitest'
import { INLINE_INPUT_FIELD, NODE_INLINE_FIELD, projectInlineOrder } from '../order-spec.ts'

describe('inline order field', () => {
  it('projects spec.inline_input onto the shard field and the node field', () => {
    expect(projectInlineOrder({
      task_type: 'word_count', input_kind: 'inline', inline_input: 'hello world hello',
    })).toEqual({
      field: INLINE_INPUT_FIELD, nodeField: NODE_INLINE_FIELD, inlineInput: 'hello world hello',
    })
    expect(INLINE_INPUT_FIELD).toBe('inline_input')
    expect(NODE_INLINE_FIELD).toBe('inlineInput')
  })

  it('rejects an order that puts the text in spec.text', () => {
    expect(projectInlineOrder({
      task_type: 'word_count', input_kind: 'inline', text: 'hello world hello',
    })).toEqual({
      field: 'inline_input', nodeField: 'inlineInput', rejected: 'missing-inline-input',
    })
  })
})
