import { describe, expect, it } from 'vitest'
import { admitInlineTaskParams, parseTaskFormMetadata } from '../src/task-form.ts'

const schema = {
  type: 'object', required: ['keyword'], additionalProperties: false,
  properties: {
    keyword: { type: 'string', minLength: 1, maxLength: 80, title: '关键词' },
    top_n: { type: 'integer', minimum: 1, maximum: 1000, default: 100 },
    exact: { type: 'boolean' },
  },
}
const contract = {
  form_schema_version: 'qianshou.task-input-form.v1', form_ready: true,
  params_schema: schema,
  input_schema: { oneOf: [{ type: 'object', properties: { input_kind: { const: 'inline' }, params: schema },
    required: ['input_kind', 'inline_input'], additionalProperties: false }] },
}

describe('reviewed inline task form', () => {
  it('copies bounded metadata and validates required, type, range and extra fields', () => {
    const metadata = parseTaskFormMetadata(contract)
    expect(metadata.formReady).toBe(true)
    expect(metadata.paramsSchema?.properties.top_n).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000 })
    expect(admitInlineTaskParams({ top_n: 25, keyword: '术语', exact: false }, ['keyword'], metadata))
      .toEqual({ exact: false, keyword: '术语', top_n: 25 })
    for (const params of [{}, { keyword: '' }, { keyword: '术语', top_n: 0 },
      { keyword: '术语', top_n: 1.5 }, { keyword: '术语', extra: 'x' }]) {
      expect(() => admitInlineTaskParams(params, ['keyword'], metadata)).toThrow('COMPUTE_INPUT_PARAMS_INVALID')
    }
  })

  it('fails closed for missing or malformed schemas without disabling legacy no-param rows', () => {
    const malformed = parseTaskFormMetadata({ ...contract, params_schema: {
      type: 'object', required: ['keyword'], additionalProperties: false,
      properties: { keyword: { type: 'array' } },
    } })
    expect(malformed.formReady).toBe(false)
    expect(() => admitInlineTaskParams({ keyword: '术语' }, ['keyword'], malformed)).toThrow('COMPUTE_INPUT_KIND_UNSUPPORTED')
    const oldRow = parseTaskFormMetadata({})
    expect(admitInlineTaskParams(undefined, [], oldRow)).toEqual({})
    expect(() => admitInlineTaskParams({ keyword: '术语' }, [], oldRow)).toThrow('COMPUTE_INPUT_PARAMS_INVALID')
  })
})
