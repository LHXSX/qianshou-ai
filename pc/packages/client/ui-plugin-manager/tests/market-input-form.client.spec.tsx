// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { useState } from 'react'
import { MarketInputFields } from '../src/client/MarketInputFields.tsx'
import { marketInputLabelsZh } from '../src/client/market-task-copy.ts'
import { marketInputDraft, parseMarketInputRule, serializeMarketInput } from '../src/client/market-input-form.ts'

afterEach(cleanup)

const schema = { type: 'object', title: '文字处理', additionalProperties: false, required: ['text'], properties: {
  text: { type: 'string', title: '需要处理的文字', minLength: 1, maxLength: 5 },
  count: { type: 'integer', title: '份数', minimum: 1, maximum: 10 },
  style: { type: 'string', title: '风格', enum: ['简洁', '详细'] },
  options: { type: 'object', title: '其他设置', additionalProperties: false, required: ['note'], properties: {
    note: { type: 'string', title: '备注', minLength: 1 },
  } },
} }

it('lets the user fill Chinese controls and constructs the reviewed input without JSON instructions', () => {
  const rule = parseMarketInputRule(schema)
  let output: string | null = null
  function Form() {
    const [value, setValue] = useState(marketInputDraft(rule))
    return <><MarketInputFields rule={rule} value={value} onChange={setValue} labels={marketInputLabelsZh} disabled={false} />
      <button onClick={() => { output = serializeMarketInput(rule, value) }}>报价</button></>
  }
  render(<Form />)
  fireEvent.change(screen.getByLabelText('需要处理的文字'), { target: { value: '千手🙂测试' } })
  fireEvent.change(screen.getByLabelText('份数 (选填)'), { target: { value: '2' } })
  fireEvent.change(screen.getByLabelText('风格 (选填)'), { target: { value: '简洁' } })
  fireEvent.click(screen.getByText('报价'))
  expect(output).toBe('{"text":"千手🙂测试","count":2,"style":"简洁"}')
  expect(screen.queryByText(/JSON/)).toBeNull()
})

it('omits an empty optional nested group but validates it once the user supplies a value', () => {
  const rule = parseMarketInputRule(schema)
  const draft = marketInputDraft(rule, { text: '甲' }) as Record<string, ReturnType<typeof marketInputDraft>>
  expect(serializeMarketInput(rule, draft)).toBe('{"text":"甲"}')
  draft.options = { note: '事项' }
  expect(JSON.parse(serializeMarketInput(rule, draft)!)).toEqual({ text: '甲', options: { note: '事项' } })
})

it('preserves task whitespace and counts Unicode characters as the server does', () => {
  const rule = parseMarketInputRule(schema)
  expect(serializeMarketInput(rule, marketInputDraft(rule, { text: ' 🙂 ' }))).toBe('{"text":" 🙂 "}')
  expect(serializeMarketInput(rule, marketInputDraft(rule, { text: '千手🙂测试多' }))).toBeNull()
})

it.each([{ count: '0' }, { count: '1.5' }, { style: '陌生' }, { text: '' }])('does not quote values rejected by the reviewed declaration: %j', change => {
  const rule = parseMarketInputRule(schema)
  expect(serializeMarketInput(rule, marketInputDraft(rule, { text: '甲', ...change }))).toBeNull()
})

it('ignores model-supplied undeclared fields and includes locked constants', () => {
  const rule = parseMarketInputRule({ type: 'object', additionalProperties: false, required: ['text'], properties: {
    text: { type: 'string' }, format: { const: 'png' }, flag: { const: false },
  } })
  expect(JSON.parse(serializeMarketInput(rule, marketInputDraft(rule, { text: '甲', untrusted: 'value', format: 'jpg' }))!))
    .toEqual({ text: '甲', format: 'png', flag: false })
})

it('rejects undeclared capabilities and unbounded field declarations before rendering controls', () => {
  expect(() => parseMarketInputRule({ ...schema, additionalProperties: true })).toThrow('MARKET_INPUT_FORM_INVALID')
  expect(() => parseMarketInputRule({ ...schema, properties: { url: { type: 'string', format: 'uri' } }, required: [] }))
    .toThrow('MARKET_INPUT_FORM_INVALID')
})
